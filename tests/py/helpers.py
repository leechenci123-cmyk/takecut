import math
import struct
import wave
from pathlib import Path


def write_wav(path, pieces, rate=44100, channels=1):
    """pieces: list of (seconds, frequency or None for silence, amplitude). 16-bit PCM."""
    frames = bytearray()
    for seconds, freq, amp in pieces:
        n = int(round(seconds * rate))
        for i in range(n):
            v = 0.0 if freq is None else amp * math.sin(2 * math.pi * freq * i / rate)
            s = struct.pack("<h", int(max(-1, min(1, v)) * 32767))
            frames += s * channels
    with wave.open(str(path), "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(bytes(frames))
    return Path(path)
