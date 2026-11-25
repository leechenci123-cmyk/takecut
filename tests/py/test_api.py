"""End-to-end API tests against a real server on a free port with a temporary data folder."""
import json
import shutil
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import quote

from takecut import media
from takecut.app import make_server
from tests.py.helpers import write_wav


@unittest.skipUnless(media.available(), "FFmpeg is not installed")
class ApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = Path(tempfile.mkdtemp(prefix="takecut-api-"))
        cls.server = make_server(cls.data, 0)
        cls.port = cls.server.server_port
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        shutil.rmtree(cls.data, ignore_errors=True)

    def request(self, method, path, body=None, headers=None, host=None, raw=None):
        url = f"http://127.0.0.1:{self.port}{path}"
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        h = {"X-Takecut": "1", **({"Content-Type": "application/json"} if body is not None else {}), **(headers or {})}
        req = urllib.request.Request(url, data=data, method=method, headers=h)
        if host:
            req.add_header("Host", host)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return resp.status, resp.read(), resp.headers
        except urllib.error.HTTPError as err:
            return err.code, err.read(), err.headers

    def json(self, *args, **kwargs):
        status, body, _ = self.request(*args, **kwargs)
        return status, (json.loads(body) if body else None)

    def wait_job(self, job_id, timeout=60):
        end = time.time() + timeout
        while time.time() < end:
            _, job = self.json("GET", f"/api/jobs/{job_id}")
            if job["state"] in ("done", "error"):
                return job
            time.sleep(0.2)
        self.fail("job timed out")

    def test_security_checks(self):
        status, _, _ = self.request("GET", "/api/system", host="evil.example:80")
        self.assertEqual(status, 403)
        status, _, _ = self.request("POST", "/api/samples/zh", headers={"X-Takecut": ""})
        self.assertEqual(status, 403)
        status, _, _ = self.request("GET", "/../takecut/app.py")
        self.assertEqual(status, 404)
        status, _, headers = self.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn("script-src 'self'", headers["Content-Security-Policy"])

    def test_system(self):
        status, info = self.json("GET", "/api/system")
        self.assertEqual(status, 200)
        self.assertTrue(info["ffmpeg"])
        self.assertIn("small", [m["name"] for m in info["models"]])
        self.assertEqual(info["samples"], ["en", "zh"])

    def test_sample_project_lifecycle(self):
        status, meta = self.json("POST", "/api/samples/zh")
        self.assertEqual(status, 200)
        pid = meta["id"]
        self.assertEqual(meta["status"], "ready")
        self.assertEqual(meta["sampleRate"], 44100)
        # opening again reuses it
        self.assertEqual(self.json("POST", "/api/samples/zh")[1]["id"], pid)

        status, data = self.json("GET", f"/api/projects/{pid}")
        self.assertEqual(len(data["words"]), 51)
        self.assertIn("p", data["words"][0])
        self.assertIn("env", data["analysis"])

        status, body, headers = self.request("GET", f"/api/projects/{pid}/audio", headers={"Range": "bytes=0-43"})
        self.assertEqual(status, 206)
        self.assertEqual(body[:4], b"RIFF")
        self.assertTrue(headers["Content-Range"].startswith("bytes 0-43/"))

        edits = {"version": 4, "cuts": [[3.785, 6.22]], "pauses": [{"at": 9.78, "duration": 0.4}], "splits": [],
                 "fixes": {"34": "原始"}, "ignored": []}
        status, _ = self.json("PUT", f"/api/projects/{pid}/edits", {"edits": edits, "stats": {"editedDuration": 19.8, "cutSeconds": 2.4}})
        self.assertEqual(status, 200)
        self.assertEqual(self.json("GET", f"/api/projects/{pid}")[1]["edits"]["fixes"], {"34": "原始"})
        self.assertEqual(self.json("PATCH", f"/api/projects/{pid}", {"name": "  演示  "})[1]["name"], "演示")

        frames = meta["frames"]
        self.assertEqual(frames, 480577 * 2)  # the 22.05 kHz sample is resampled to 44.1 kHz
        status, job = self.json("POST", f"/api/projects/{pid}/export", {
            "format": "wav", "loudness": None, "denoise": False, "sampleRate": 44100,
            "segments": [{"type": "audio", "start": 0, "end": 44100}, {"type": "silence", "frames": 4410},
                         {"type": "audio", "start": 88200, "end": frames}]})
        self.assertEqual(status, 202)
        done = self.wait_job(job["job"])
        self.assertEqual(done["state"], "done", done)
        name = done["result"]["file"]
        status, body, headers = self.request("GET", f"/api/projects/{pid}/exports/{quote(name)}")
        self.assertEqual(status, 200)
        self.assertIn("attachment", headers["Content-Disposition"])
        self.assertEqual(done["result"]["frames"], 44100 + 4410 + frames - 88200)

        self.assertEqual(self.json("POST", f"/api/projects/{pid}/export", {"format": "wav", "sampleRate": 22050, "segments": []})[0], 400)
        self.assertEqual(self.request("DELETE", f"/api/projects/{pid}")[0], 204)
        self.assertEqual(self.json("GET", f"/api/projects/{pid}")[0], 404)

    def test_upload_rejects_non_audio(self):
        status, body = self.json("POST", "/api/projects", raw=b"not audio at all" * 100,
                                 headers={"X-Filename": "notes.txt", "Content-Type": "application/octet-stream"})
        self.assertEqual(status, 422)
        self.assertIn(body["error"], ("no-audio", "unreadable"))

    def test_upload_creates_a_queued_project(self):
        wav = write_wav(self.data / "upload.wav", [(0.5, 440, 0.3)], 22050)
        status, body = self.json("POST", "/api/projects", raw=wav.read_bytes(),
                                 headers={"X-Filename": quote("我的 录音.wav"), "X-Language": "zh", "X-Model": "small",
                                          "Content-Type": "application/octet-stream"})
        self.assertEqual(status, 202)
        status, data = self.json("GET", f"/api/projects/{body['id']}")
        self.assertEqual(data["project"]["name"], "我的 录音")
        self.assertIn(data["project"]["status"], ("queued", "transcribing", "ready", "error"))
        # The transcription job finishes (or fails cleanly without a model); either way it ends.
        job = self.wait_job(body["job"], timeout=180)
        self.assertIn(job["state"], ("done", "error"))
        if job["state"] == "done":
            meta = self.json("GET", f"/api/projects/{body['id']}")[1]["project"]
            self.assertEqual(meta["status"], "ready")
            self.assertEqual(meta["sampleRate"], 44100)

    def test_bad_requests(self):
        self.assertEqual(self.json("GET", "/api/projects/" + "0" * 32)[0], 404)
        self.assertEqual(self.json("GET", "/api/jobs/" + "0" * 32)[0], 404)
        self.assertEqual(self.json("POST", "/api/samples/xx")[0], 404)
        self.assertEqual(self.request("PUT", "/api/projects/" + "0" * 32 + "/edits", raw=b"{nope")[0], 400)


if __name__ == "__main__":
    unittest.main()
