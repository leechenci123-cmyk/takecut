"""Project storage: one folder per project under <data dir>/projects/<id>/.

    project.json   metadata (name, status, duration, language, model, stats...)
    source.wav     full-quality audio for export (44.1 kHz, mono or stereo)
    preview.wav    mono copy for the browser
    words.json     recognized words with times and probabilities
    analysis.json  loudness envelope, silences, unrecognized sounds
    edits.json     cuts, pauses, splits, text fixes, ignored suggestions
    exports/       rendered files
"""
import json
import os
import re
import shutil
import threading
import time
import uuid
from pathlib import Path

from . import media
from .config import SAMPLES, SAMPLE_RATE

ID = re.compile(r"^[0-9a-f]{32}$")
EMPTY_EDITS = {"version": 4, "cuts": [], "pauses": [], "splits": [], "fixes": {}, "ignored": []}


class NotFound(Exception):
    pass


def write_json(path, value):
    """Write atomically: a crash never leaves half a file behind."""
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)


def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError):
        return default


class Store:
    def __init__(self, data_dir):
        self.root = Path(data_dir)
        self.dir = self.root / "projects"
        self.tmp = self.root / "tmp"
        self.dir.mkdir(parents=True, exist_ok=True)
        shutil.rmtree(self.tmp, ignore_errors=True)
        self.tmp.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        for meta in self.list():  # a restart interrupted these
            if meta.get("status") in ("queued", "transcribing"):
                self.update(meta["id"], status="error", error="interrupted", job=None)

    def folder(self, pid):
        if not isinstance(pid, str) or not ID.match(pid):
            raise NotFound(pid)
        path = self.dir / pid
        if not (path / "project.json").is_file():
            raise NotFound(pid)
        return path

    def list(self):
        out = []
        for d in self.dir.iterdir():
            if d.is_dir() and ID.match(d.name):
                meta = read_json(d / "project.json")
                if meta:
                    out.append(meta)
        return sorted(out, key=lambda m: m.get("updated", 0), reverse=True)

    def get(self, pid):
        return read_json(self.folder(pid) / "project.json")

    def update(self, pid, **fields):
        with self.lock:
            path = self.folder(pid) / "project.json"
            meta = read_json(path, {})
            meta.update(fields)
            meta["updated"] = time.time()
            write_json(path, meta)
            return meta

    def create(self, name, language="auto", model=None, sample=None, preprocessed=False):
        pid = uuid.uuid4().hex
        folder = self.dir / pid
        folder.mkdir()
        now = time.time()
        meta = {"id": pid, "name": name, "created": now, "updated": now, "status": "queued", "error": None,
                "duration": 0, "sampleRate": SAMPLE_RATE, "channels": 1, "language": language,
                "detectedLanguage": None, "model": model, "device": None, "sample": sample, "job": None,
                "preprocessed": bool(preprocessed), "audioMode": "clean" if preprocessed else "raw",
                "stats": None}
        write_json(folder / "edits.json", EMPTY_EDITS)
        write_json(folder / "project.json", meta)
        return meta

    def delete(self, pid):
        shutil.rmtree(self.folder(pid))

    def load(self, pid):
        folder = self.folder(pid)
        return {
            "project": read_json(folder / "project.json"),
            "words": read_json(folder / "words.json", []),
            "analysis": read_json(folder / "analysis.json"),
            "edits": read_json(folder / "edits.json", EMPTY_EDITS),
        }

    def save_edits(self, pid, edits, stats=None):
        folder = self.folder(pid)
        with self.lock:
            write_json(folder / "edits.json", edits)
        return self.update(pid, **({"stats": stats} if isinstance(stats, dict) else {}))

    def reset_word_edits(self, pid):
        """After re-transcribing, word indices change: drop fixes and ignored suggestions."""
        folder = self.folder(pid)
        with self.lock:
            edits = read_json(folder / "edits.json", EMPTY_EDITS)
            edits["fixes"], edits["ignored"] = {}, []
            write_json(folder / "edits.json", edits)

    def sample_languages(self):
        return sorted(d.name for d in SAMPLES.iterdir() if (d / "meta.json").is_file()) if SAMPLES.is_dir() else []

    def open_sample(self, lang):
        """Reuse this language's sample project if it exists, otherwise copy it in."""
        if lang not in self.sample_languages():
            raise NotFound(lang)
        for meta in self.list():
            if meta.get("sample") == lang and meta.get("status") == "ready":
                return meta
        src = SAMPLES / lang
        info = read_json(src / "meta.json", {})
        meta = self.create(info.get("name", f"Sample ({lang})"), language=lang, model=info.get("model"), sample=lang)
        folder = self.dir / meta["id"]
        for name in ("words.json", "analysis.json"):
            if (src / name).exists():
                shutil.copyfile(src / name, folder / name)
        _, _, src_channels = media.wav_info(src / "source.wav")
        media.decode(src / "source.wav", folder / "source.wav", folder / "preview.wav", src_channels, 3600)
        frames, rate, channels = media.wav_info(folder / "source.wav")
        return self.update(meta["id"], status="ready", duration=round(frames / rate, 3), frames=frames, sampleRate=rate,
                           channels=channels, detectedLanguage=lang, device=info.get("device"))
