"""Signal analysis (plain DSP, no AI): a loudness envelope, real silences, and voiced sounds that
the recognizer did not turn into words (often fillers like 嗯 or um that Whisper drops)."""
from bisect import bisect_left

import numpy as np

HOP = 0.01  # seconds per envelope value


def envelope_db(pcm, sr=16000, hop=HOP):
    """RMS level in dBFS for every `hop` seconds, lightly smoothed."""
    n = int(round(sr * hop))
    frames = len(pcm) // n
    if frames == 0:
        return np.zeros(0, dtype=np.float32)
    x = np.asarray(pcm[: frames * n], dtype=np.float32).reshape(frames, n)
    db = 20 * np.log10(np.sqrt(np.mean(x * x, axis=1)) + 1e-9)
    if frames >= 3:
        db = np.convolve(db, np.ones(3) / 3, mode="same")
    return np.maximum(db, -100.0).astype(np.float32)


def runs(mask):
    """[(start, end)) index pairs of consecutive True values."""
    if not len(mask):
        return []
    d = np.diff(np.concatenate(([0], mask.astype(np.int8), [0])))
    return list(zip(np.flatnonzero(d == 1).tolist(), np.flatnonzero(d == -1).tolist()))


def _overlaps_word(starts, ends, a, b):
    """True when any word overlaps [a, b]. Words are sorted by start."""
    i = bisect_left(starts, b)
    j = i - 1
    while j >= 0 and ends[j] > a - 30:  # words are short; stop well before
        if ends[j] > a:
            return True
        j -= 1
    return False


def analyze(pcm, words, sr=16000):
    db = envelope_db(pcm, sr)
    n = len(db)
    duration = len(pcm) / sr
    if n == 0:
        return {"hop": HOP, "duration": round(duration, 3), "floorDb": -100.0, "speechDb": -100.0,
                "thresholdDb": -100.0, "silences": [], "sounds": [], "env": []}

    floor = float(np.percentile(db, 10))
    in_words = np.zeros(n, dtype=bool)
    for w in words:
        in_words[max(0, int(w["start"] / HOP)):min(n, int(np.ceil(w["end"] / HOP)))] = True
    speech = float(np.percentile(db[in_words], 60)) if in_words.any() else float(np.percentile(db, 90))
    spread = max(0.0, speech - floor)
    threshold = min(max(floor + 0.35 * spread, floor + 4), speech - 6)

    silent = db < threshold
    silences = [[round(a * HOP, 3), round(b * HOP, 3)] for a, b in runs(silent) if (b - a) * HOP >= 0.15]

    spans = sorted((w["start"], w["end"]) for w in words)
    starts, ends = [s for s, _ in spans], [e for _, e in spans]
    sounds = []
    for a, b in runs(~silent):
        s, e = a * HOP, b * HOP
        if e - s < 0.12 or _overlaps_word(starts, ends, s - 0.06, e + 0.06):
            continue
        level = float(np.mean(db[a:b]))
        sounds.append({"start": round(s, 3), "end": round(e, 3), "db": round(level, 1),
                       "voiced": bool(level >= speech - 14)})

    return {
        "hop": HOP,
        "duration": round(duration, 3),
        "floorDb": round(floor, 1),
        "speechDb": round(speech, 1),
        "thresholdDb": round(threshold, 1),
        "silences": silences,
        "sounds": sounds,
        "env": np.round(db).astype(int).tolist(),
    }
