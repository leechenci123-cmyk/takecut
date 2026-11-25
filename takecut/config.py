"""Paths and limits."""
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
SAMPLES = ROOT / "samples"

SAMPLE_RATE = 44100            # every project is decoded to this rate
MAX_UPLOAD = 512 * 1024 * 1024 # bytes
MAX_SECONDS = 3600             # longest recording we transcribe
MAX_JSON = 16 * 1024 * 1024    # request bodies other than uploads


def default_data_dir() -> Path:
    """Where projects live: TAKECUT_DATA, else the platform's per-user app data folder."""
    env = os.environ.get("TAKECUT_DATA")
    if env:
        return Path(env)
    if sys.platform == "win32":
        base = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        base = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share")
    return base / "Takecut"
