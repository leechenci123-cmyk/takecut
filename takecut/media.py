"""FFmpeg / FFprobe helpers. Every call only allows local files and pipes as inputs."""
import json
import re
import shutil
import subprocess
import wave
from pathlib import Path

from .config import SAMPLE_RATE

SAFE = ["-protocol_whitelist", "file,pipe"]


class MediaError(Exception):
    """FFmpeg failed or the file has no usable audio. `code` is shown to the user translated."""

    def __init__(self, code, detail=""):
        super().__init__(detail or code)
        self.code = code
        self.detail = detail


def ffmpeg():
    return shutil.which("ffmpeg")


def ffprobe():
    return shutil.which("ffprobe")


def available():
    return bool(ffmpeg() and ffprobe())


_major = None


def ffmpeg_major():
    """Major version of the installed FFmpeg; 99 when it can't be parsed (git builds)."""
    global _major
    if _major is None:
        try:
            out = subprocess.run([ffmpeg(), "-version"], capture_output=True, text=True, timeout=15).stdout
            m = re.search(r"version\s+n?(\d+)\.", out)
            _major = int(m.group(1)) if m else 99
        except Exception:
            _major = 99
    return _major


def filter_script_args(path):
    """Read a long filter graph from a file: `-/filter_complex` on FFmpeg 7+, the old option before."""
    return ["-/filter_complex", str(path)] if ffmpeg_major() >= 7 else ["-filter_complex_script", str(path)]


def run(args, timeout=None):
    proc = subprocess.run(args, capture_output=True, timeout=timeout)
    if proc.returncode != 0:
        raise MediaError("ffmpeg-failed", proc.stderr.decode("utf-8", "replace")[-1200:])
    return proc


def probe(path):
    """Duration, channels and sample rate of the first audio stream. Raises MediaError('no-audio')."""
    try:
        out = run([ffprobe(), "-v", "error", *SAFE,
                   "-show_entries", "format=duration:stream=codec_type,channels,sample_rate",
                   "-of", "json", str(path)], timeout=60).stdout
    except (MediaError, subprocess.TimeoutExpired) as exc:
        raise MediaError("unreadable", getattr(exc, "detail", "")) from exc
    info = json.loads(out or b"{}")
    streams = info.get("streams", [])
    audio = [s for s in streams if s.get("codec_type") == "audio"]
    if not audio:
        raise MediaError("no-audio")
    try:
        duration = float(info.get("format", {}).get("duration") or 0)
    except ValueError:
        duration = 0.0
    return {
        "duration": duration,
        "channels": int(audio[0].get("channels") or 1),
        "sampleRate": int(audio[0].get("sample_rate") or 0),
        "video": any(s.get("codec_type") == "video" for s in streams),
    }


def decode(src, source_wav, preview_wav, channels, max_seconds):
    """Full-quality source (mono or stereo) for export, and a mono preview for the browser."""
    ch = "2" if channels >= 2 else "1"
    common = ["-map", "0:a:0", "-vn", "-ar", str(SAMPLE_RATE), "-c:a", "pcm_s16le"]
    run([ffmpeg(), "-nostdin", "-v", "error", "-y", *SAFE, "-t", str(max_seconds), "-i", str(src),
         *common, "-ac", ch, str(source_wav),
         *common, "-ac", "1", str(preview_wav)])


def make_preview(source_wav, preview_wav):
    run([ffmpeg(), "-nostdin", "-v", "error", "-y", *SAFE, "-i", str(source_wav),
         "-ac", "1", "-ar", str(SAMPLE_RATE), "-c:a", "pcm_s16le", str(preview_wav)])


def wav_info(path):
    """(frames, sample_rate, channels) of a PCM WAV file."""
    with wave.open(str(path), "rb") as w:
        return w.getnframes(), w.getframerate(), w.getnchannels()


def pcm16k(path):
    """Mono float32 samples at 16 kHz, for Whisper and the signal analysis."""
    import numpy as np

    out = run([ffmpeg(), "-nostdin", "-v", "error", *SAFE, "-i", str(path),
               "-ac", "1", "-ar", "16000", "-f", "f32le", "-"]).stdout
    return np.frombuffer(out, dtype=np.float32)


def duration_of(path):
    """Container duration in seconds via ffprobe (used to check rendered files)."""
    out = run([ffprobe(), "-v", "error", *SAFE, "-show_entries", "format=duration",
               "-of", "default=nw=1:nk=1", str(path)], timeout=60).stdout
    return float(out.strip() or 0)
