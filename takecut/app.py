"""HTTP server for the local UI and the JSON API described in docs/api.md. Loopback only."""
import json
import os
import re
import shutil
import subprocess
import sys
import traceback
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit

from . import __version__, media, render, transcribe
from .config import MAX_JSON, MAX_SECONDS, MAX_UPLOAD, ROOT, WEB
from .jobs import JobError, JobQueue
from .media import MediaError
from .projects import NotFound, Store

MIME = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
    ".json": "application/json; charset=utf-8", ".ico": "image/x-icon", ".woff2": "font/woff2",
}
CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
       "media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
LANGUAGES = ("auto", "zh", "en")
PID = r"([0-9a-f]{32})"
ROUTES = [
    ("GET", r"/api/system", "system"),
    ("GET", r"/api/projects", "list"),
    ("POST", r"/api/projects", "upload"),
    ("POST", r"/api/samples/([a-z]{2})", "sample"),
    ("GET", rf"/api/projects/{PID}", "project"),
    ("PATCH", rf"/api/projects/{PID}", "rename"),
    ("DELETE", rf"/api/projects/{PID}", "delete"),
    ("PUT", rf"/api/projects/{PID}/edits", "edits"),
    ("GET", rf"/api/projects/{PID}/audio", "audio"),
    ("POST", rf"/api/projects/{PID}/transcribe", "retranscribe"),
    ("POST", rf"/api/projects/{PID}/export", "export"),
    ("GET", rf"/api/projects/{PID}/exports/([^/]+)", "download"),
    ("GET", r"/api/jobs/([0-9a-f]{32})", "job"),
    ("POST", r"/api/text/convert", "convert"),
]


class BadRequest(Exception):
    def __init__(self, code, status=400):
        super().__init__(code)
        self.code = code
        self.status = status


class Context:
    def __init__(self, data_dir):
        self.store = Store(data_dir)
        self.jobs = JobQueue()
        self.cuda_failed = os.environ.get("TAKECUT_DEVICE") == "cpu"

    def devices(self):
        return ["cuda", "cpu"] if not self.cuda_failed and transcribe.cuda_usable() else ["cpu"]


def run_transcriber(source, folder, language, model, device, progress):
    """Run takecut.transcribe in a child process, forwarding its progress lines."""
    cmd = [sys.executable, "-m", "takecut.transcribe", "--audio", str(source), "--out", str(folder),
           "--language", language, "--model", model, "--device", device]
    done, error, tail = None, None, []
    with subprocess.Popen(cmd, cwd=str(ROOT), env={**os.environ, "PYTHONIOENCODING": "utf-8"},
                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                          encoding="utf-8", errors="replace") as proc:
        for line in proc.stdout:
            try:
                msg = json.loads(line)
            except ValueError:
                tail = (tail + [line.rstrip()])[-20:]
                continue
            if not isinstance(msg, dict):
                continue
            if "stage" in msg:
                progress(msg["stage"], msg.get("progress"))
            if msg.get("done"):
                done = msg
            if msg.get("error"):
                error = msg
        code = proc.wait()
    if code == 0 and done:
        return done
    raise JobError("transcribe-failed", f"[{device}] " + ((error or {}).get("detail") or "\n".join(tail)))


def transcribe_work(ctx, pid, language, model, fresh):
    store = ctx.store

    def work(progress):
        try:
            folder = store.folder(pid)
            store.update(pid, status="transcribing", error=None)
            source = folder / "source.wav"
            inputs = sorted(folder.glob("input.*"))
            if inputs:
                progress("decoding", 0.0)
                info = media.probe(inputs[0])
                media.decode(inputs[0], source, folder / "preview.wav", info["channels"], MAX_SECONDS)
                inputs[0].unlink(missing_ok=True)
                frames, rate, channels = media.wav_info(source)
                store.update(pid, duration=round(frames / rate, 3), frames=frames, sampleRate=rate, channels=channels)
            done = None
            for device in ctx.devices():
                try:
                    done = run_transcriber(source, folder, language, model, device, progress)
                    break
                except JobError:
                    if device != "cuda":
                        raise
                    ctx.cuda_failed = True  # driver or library problem: use the CPU from now on
            if not fresh:
                store.reset_word_edits(pid)
            store.update(pid, status="ready", job=None, error=None, model=model,
                         detectedLanguage=done.get("language"), device=done.get("device"))
            return {"words": done.get("words"), "language": done.get("language"), "device": done.get("device")}
        except Exception as exc:
            store.update(pid, status="error", job=None, error=getattr(exc, "code", None) or "failed")
            raise

    return work


def disposition(name):
    fallback = name.encode("ascii", "replace").decode("ascii").replace("?", "_").replace('"', "_")
    return f"attachment; filename=\"{fallback}\"; filename*=UTF-8''{quote(name)}"


class Handler(BaseHTTPRequestHandler):
    server_version = "Takecut/" + __version__

    def log_message(self, fmt, *args):  # quiet console; errors are logged in dispatch
        pass

    @property
    def ctx(self):
        return self.server.ctx

    # ---- plumbing -------------------------------------------------------------------------
    def valid_host(self):
        port = self.server.server_port
        return self.headers.get("Host") in (f"127.0.0.1:{port}", f"localhost:{port}")

    def send(self, status, body=b"", mime="application/json; charset=utf-8", headers=None):
        headers = {"Cache-Control": "no-store", **(headers or {})}
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        for key, value in headers.items():
            self.send_header(key, value)
        self.end_headers()
        if body and self.command != "HEAD":
            self.wfile.write(body)

    def json(self, value, status=200):
        self.send(status, json.dumps(value, ensure_ascii=False).encode("utf-8"))

    def fail(self, status, code, message=""):
        self.json({"error": code, "message": message or code}, status)

    def body(self):
        try:
            size = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            size = 0
        if not 0 < size <= MAX_JSON:
            raise BadRequest("bad-json")
        try:
            value = json.loads(self.rfile.read(size))
        except ValueError:
            raise BadRequest("bad-json")
        if not isinstance(value, dict):
            raise BadRequest("bad-json")
        return value

    def dispatch(self, method):
        if not self.valid_host():
            return self.fail(403, "forbidden")
        path = urlsplit(self.path).path
        if method not in ("GET", "HEAD") and self.headers.get("X-Takecut") != "1":
            return self.fail(403, "forbidden")
        if not path.startswith("/api/"):
            return self.static(path) if method in ("GET", "HEAD") else self.fail(405, "method")
        for route_method, pattern, name in ROUTES:
            match = re.fullmatch(pattern, path)
            if match and route_method == (method if method != "HEAD" else "GET"):
                try:
                    return getattr(self, "api_" + name)(*match.groups())
                except NotFound:
                    return self.fail(404, "not-found")
                except BadRequest as exc:
                    return self.fail(exc.status, exc.code)
                except MediaError as exc:
                    return self.fail(422, exc.code, exc.detail)
                except (BrokenPipeError, ConnectionResetError):
                    return None
                except Exception as exc:
                    traceback.print_exc()
                    return self.fail(500, "server-error", str(exc))
        return self.fail(404, "not-found")

    def do_GET(self):
        self.dispatch("GET")

    def do_HEAD(self):
        self.dispatch("HEAD")

    def do_POST(self):
        self.dispatch("POST")

    def do_PUT(self):
        self.dispatch("PUT")

    def do_PATCH(self):
        self.dispatch("PATCH")

    def do_DELETE(self):
        self.dispatch("DELETE")

    def static(self, path):
        rel = unquote(path).lstrip("/") or "index.html"
        root = WEB.resolve()
        target = (root / rel).resolve()
        if not target.is_relative_to(root) or not target.is_file():
            return self.fail(404, "not-found")
        headers = {"Cache-Control": "no-cache"}
        if target.suffix == ".html":
            headers["Content-Security-Policy"] = CSP
        self.send(200, target.read_bytes(), MIME.get(target.suffix.lower(), "application/octet-stream"), headers)

    def send_file(self, path, mime, download=None):
        size = path.stat().st_size
        start, end, status = 0, size - 1, 200
        m = re.fullmatch(r"bytes=(\d*)-(\d*)", self.headers.get("Range") or "")
        if m and (m.group(1) or m.group(2)):
            if m.group(1):
                start = int(m.group(1))
                end = min(int(m.group(2)), size - 1) if m.group(2) else size - 1
            else:
                start = max(0, size - int(m.group(2)))
            if start > end:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            status = 206
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        if download:
            self.send_header("Content-Disposition", disposition(download))
        self.end_headers()
        if self.command == "HEAD":
            return
        with path.open("rb") as handle:
            handle.seek(start)
            remaining = end - start + 1
            while remaining > 0:
                chunk = handle.read(min(1 << 20, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    def busy(self, pid):
        if self.ctx.jobs.active_for(pid):
            raise BadRequest("busy", 409)

    # ---- API --------------------------------------------------------------------------------
    def api_system(self):
        try:
            import opencc  # noqa: F401
            has_opencc = True
        except ImportError:
            has_opencc = False
        self.json({
            "version": __version__,
            "ffmpeg": media.available(),
            "opencc": has_opencc,
            "cuda": transcribe.cuda_usable() and not self.ctx.cuda_failed,
            "models": [{"name": n, "cached": transcribe.is_cached(n)} for n in transcribe.MODEL_CHOICES],
            "defaultModel": transcribe.default_model(),
            "samples": self.ctx.store.sample_languages(),
            "dataDir": str(self.ctx.store.root),
        })

    def api_list(self):
        self.json({"projects": self.ctx.store.list()})

    def api_project(self, pid):
        data = self.ctx.store.load(pid)
        job_id = data["project"].get("job")
        data["job"] = self.ctx.jobs.get(job_id) if job_id else None
        self.json(data)

    def api_upload(self):
        store = self.ctx.store
        try:
            size = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            size = 0
        if not 0 < size <= MAX_UPLOAD:
            raise BadRequest("too-large", 413)
        filename = Path(unquote(self.headers.get("X-Filename") or "recording")).name
        stem = Path(filename).stem.strip()[:120] or "recording"
        ext = re.sub(r"[^a-z0-9]", "", Path(filename).suffix.lower())[:8] or "bin"
        language = self.headers.get("X-Language") or "auto"
        if language not in LANGUAGES:
            raise BadRequest("bad-language")
        model = self.headers.get("X-Model") or transcribe.default_model()
        if model not in transcribe.MODEL_CHOICES:
            raise BadRequest("bad-model")
        tmp = store.tmp / uuid.uuid4().hex
        try:
            with tmp.open("wb") as out:
                remaining = size
                while remaining:
                    chunk = self.rfile.read(min(remaining, 1 << 20))
                    if not chunk:
                        raise BadRequest("incomplete-upload")
                    out.write(chunk)
                    remaining -= len(chunk)
            info = media.probe(tmp)
            if info["duration"] > MAX_SECONDS + 1:
                raise BadRequest("too-long", 413)
            meta = store.create(stem, language=language, model=model)
            shutil.move(str(tmp), store.folder(meta["id"]) / f"input.{ext}")
        finally:
            tmp.unlink(missing_ok=True)
        job = self.ctx.jobs.submit("transcribe", meta["id"], transcribe_work(self.ctx, meta["id"], language, model, True))
        store.update(meta["id"], job=job["id"], duration=round(info["duration"], 3), channels=min(2, info["channels"]))
        self.json({"id": meta["id"], "job": job["id"]}, 202)

    def api_sample(self, lang):
        self.json(self.ctx.store.open_sample(lang))

    def api_rename(self, pid):
        name = self.body().get("name")
        if not isinstance(name, str) or not name.strip() or len(name.strip()) > 120:
            raise BadRequest("bad-name")
        self.json(self.ctx.store.update(pid, name=name.strip()))

    def api_delete(self, pid):
        self.busy(pid)
        self.ctx.store.delete(pid)
        self.send(204, b"")

    def api_edits(self, pid):
        body = self.body()
        edits = body.get("edits")
        if not isinstance(edits, dict) or not all(isinstance(edits.get(k), list) for k in ("cuts", "pauses")):
            raise BadRequest("bad-edits")
        stats = body.get("stats") if isinstance(body.get("stats"), dict) else None
        meta = self.ctx.store.save_edits(pid, edits, stats)
        self.json({"updated": meta["updated"]})

    def api_audio(self, pid):
        path = self.ctx.store.folder(pid) / "preview.wav"
        if not path.is_file():
            raise NotFound(pid)
        self.send_file(path, "audio/wav")

    def api_retranscribe(self, pid):
        body = self.body()
        language = body.get("language", "auto")
        model = body.get("model") or transcribe.default_model()
        if language not in LANGUAGES or model not in transcribe.MODEL_CHOICES:
            raise BadRequest("bad-options")
        self.busy(pid)
        store = self.ctx.store
        if not (store.folder(pid) / "source.wav").is_file() and not list(store.folder(pid).glob("input.*")):
            raise BadRequest("no-source")
        job = self.ctx.jobs.submit("transcribe", pid, transcribe_work(self.ctx, pid, language, model, False))
        store.update(pid, status="queued", job=job["id"], language=language, error=None)
        self.json({"job": job["id"]}, 202)

    def api_export(self, pid):
        body = self.body()
        store = self.ctx.store
        meta = store.get(pid)
        folder = store.folder(pid)
        fmt = body.get("format", "wav")
        loudness = body.get("loudness")
        denoise = bool(body.get("denoise"))
        if fmt not in render.FORMATS or (loudness is not None and loudness not in render.LOUDNESS):
            raise BadRequest("bad-options")
        frames, rate, _ = media.wav_info(folder / "source.wav")
        if body.get("sampleRate") != rate:
            raise BadRequest("sample-rate")
        try:
            render.validate_segments(body.get("segments"), frames)
        except ValueError:
            raise BadRequest("bad-segments")
        segments = body["segments"]
        job = self.ctx.jobs.submit("export", pid, lambda progress: render.render(
            folder, meta["name"], segments, fmt, loudness, denoise, progress))
        self.json({"job": job["id"]}, 202)

    def api_download(self, pid, name):
        name = unquote(name)
        if Path(name).name != name or name.startswith("."):
            raise NotFound(name)
        path = self.ctx.store.folder(pid) / "exports" / name
        if not path.is_file():
            raise NotFound(name)
        mime = {".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4"}.get(path.suffix, "application/octet-stream")
        self.send_file(path, mime, download=name)

    def api_job(self, job_id):
        job = self.ctx.jobs.get(job_id)
        if not job:
            raise NotFound(job_id)
        self.json(job)

    def api_convert(self, *_):
        body = self.body()
        texts, to = body.get("texts"), body.get("to")
        if not isinstance(texts, list) or not all(isinstance(t, str) for t in texts) or to not in ("s", "t"):
            raise BadRequest("bad-options")
        try:
            import opencc
        except ImportError:
            raise BadRequest("opencc-missing", 501)
        config = "t2s" if to == "s" else "s2t"
        try:
            converter = opencc.OpenCC(config)
        except Exception:
            converter = opencc.OpenCC(config + ".json")
        self.json({"texts": [converter.convert(t) for t in texts]})


def make_server(data_dir, port=8769):
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True
    server.ctx = Context(data_dir)
    return server
