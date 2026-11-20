"""Takecut's loopback-only transcription server."""
import argparse
import json
import math
import shutil
import subprocess
import tempfile
import threading
import uuid
import wave
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent
WORK = None
JOBS = {}
BUSY = threading.Lock()
MODEL = None
MAX_BYTES = 128 * 1024 * 1024
MAX_SECONDS = 900


def transcribe(job):
    global MODEL
    folder = WORK / job
    try:
        import numpy as np
        from faster_whisper import WhisperModel

        source = folder / "input"
        probe = subprocess.run(
            ["ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe",
             "-show_entries", "format=duration", "-of", "csv=p=0", str(source)],
            capture_output=True, check=True, timeout=30)
        seconds = float(probe.stdout.strip())
        if not math.isfinite(seconds) or not 0 < seconds <= MAX_SECONDS:
            raise ValueError("请使用 15 分钟以内的录音。")
        base = ["ffmpeg", "-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe",
                "-i", str(source), "-map", "0:a:0", "-vn", "-t", str(MAX_SECONDS)]
        subprocess.run(base + ["-ac", "2", "-ar", "44100", "-c:a", "pcm_s16le",
                                str(folder / "source.wav")], capture_output=True, check=True)
        pcm = subprocess.check_output(base + ["-ac", "1", "-ar", "16000", "-f", "f32le", "-"])
        JOBS[job] = {"state": "working", "info": "正在加载本地 Whisper 模型…"}
        if MODEL is None:
            MODEL = WhisperModel("small", device="cpu", compute_type="int8", local_files_only=True)
        segments, _ = MODEL.transcribe(np.frombuffer(pcm, dtype=np.float32), language="zh",
                                       word_timestamps=True, beam_size=3)
        words = []
        for segment in segments:
            for word in segment.words or []:
                start, end = max(0, word.start), min(seconds, word.end)
                if end > start and word.word.strip():
                    words.append({"start": round(start, 3), "end": round(end, 3), "text": word.word})
            JOBS[job] = {"state": "working", "info": f"正在转录 · {min(99, round(100 * segment.end / seconds))}%"}
        (folder / "words.json").write_text(json.dumps(words, ensure_ascii=False), encoding="utf-8")
        JOBS[job] = {"state": "ready"}
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        JOBS[job] = {"state": "error", "info": "无法读取音轨。请尝试 WAV、MP3 或 M4A 文件。"}
    except Exception as exc:
        JOBS[job] = {"state": "error", "info": f"转录失败 · {exc}"}
    finally:
        (folder / "input").unlink(missing_ok=True)
        BUSY.release()


class Handler(BaseHTTPRequestHandler):
    def valid_host(self):
        return self.headers.get("Host") in (f"127.0.0.1:{self.server.server_port}",
                                             f"localhost:{self.server.server_port}")

    def send_data(self, data, mime, status=200):
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)

    def json(self, value, status=200):
        self.send_data(json.dumps(value).encode(), "application/json", status)

    def do_GET(self):
        if not self.valid_host():
            return self.send_error(403)
        path = urlsplit(self.path).path.strip("/")
        assets = {"": ("index.html", "text/html; charset=utf-8"),
                  "app.js": ("app.js", "text/javascript; charset=utf-8"),
                  "style.css": ("style.css", "text/css; charset=utf-8")}
        if path in assets:
            name, mime = assets[path]
            return self.send_data((ROOT / "web" / name).read_bytes(), mime)
        parts = path.split("/")
        if len(parts) == 2 and parts[0] == "status" and parts[1] in JOBS:
            return self.json(JOBS[parts[1]])
        if len(parts) == 3 and parts[0] == "media" and parts[2] in ("source.wav", "words.json"):
            job = parts[1]
            if job == "demo" or JOBS.get(job, {}).get("state") == "ready":
                folder = ROOT / "demo" if job == "demo" else WORK / job
                mime = "audio/wav" if parts[2].endswith("wav") else "application/json"
                file = folder / parts[2]
                self.send_response(200)
                self.send_header("Content-Type", mime)
                self.send_header("Content-Length", str(file.stat().st_size))
                self.end_headers()
                with file.open("rb") as handle:
                    shutil.copyfileobj(handle, self.wfile)
                return
        self.send_error(404)

    def do_POST(self):
        if not self.valid_host() or self.headers.get("X-Takecut") != "1":
            return self.send_error(403)
        if self.path != "/import":
            return self.send_error(404)
        try:
            size = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            size = 0
        if not 0 < size <= MAX_BYTES:
            return self.json({"info": "请选择 128 MiB 以内的非空录音。"}, 413)
        if not BUSY.acquire(blocking=False):
            return self.json({"info": "另一段录音正在转录，请稍后再试。"}, 409)
        job = uuid.uuid4().hex
        folder = WORK / job
        try:
            folder.mkdir()
            with (folder / "input").open("wb") as dest:
                while size:
                    chunk = self.rfile.read(min(size, 1024 * 1024))
                    if not chunk:
                        raise OSError("Incomplete upload")
                    dest.write(chunk)
                    size -= len(chunk)
            JOBS[job] = {"state": "working", "info": "正在读取音频…"}
            threading.Thread(target=transcribe, args=(job,), daemon=True).start()
        except Exception:
            BUSY.release()
            raise
        self.json({"id": job}, HTTPStatus.ACCEPTED)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8769)
    parser.add_argument("--open", action="store_true")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="takecut-") as temporary:
        WORK = Path(temporary)
        with ThreadingHTTPServer(("127.0.0.1", args.port), Handler) as server:
            url = f"http://127.0.0.1:{server.server_port}/"
            print(f"Takecut | {url}", flush=True)
            if args.open:
                webbrowser.open(url)
            try:
                server.serve_forever()
            except KeyboardInterrupt:
                pass
