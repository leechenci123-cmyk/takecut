"""Speech recognition with faster-whisper (OpenAI Whisper), the only ML model in Takecut.

Runs as a child process (`python -m takecut.transcribe ...`) so that a GPU driver problem can
only take down the child: the server then retries on the CPU. Progress is printed to stdout as
one JSON object per line.
"""
import argparse
import json
import re
import sys
from pathlib import Path

MODEL_CHOICES = ["small", "medium", "large-v3-turbo"]

# Whisper tends to drop disfluencies and may answer Mandarin in Traditional characters.
# A prompt written the way we want the transcript to look nudges it towards both.
PROMPTS = {
    "zh": "嗯，呃，那个，就是说……我们今天来聊一聊这个话题。",
    "en": "Um, uh, so, like, you know... I mean, let's talk about it.",
}


def repo_for(name):
    from faster_whisper.utils import _MODELS

    return _MODELS.get(name, name)


def is_cached(name):
    try:
        from huggingface_hub import try_to_load_from_cache

        return isinstance(try_to_load_from_cache(repo_for(name), "model.bin"), str)
    except Exception:
        return False


def add_nvidia_dll_dirs():
    """Windows: make pip-installed CUDA libraries (nvidia-cublas-cu12, nvidia-cudnn-cu12) loadable."""
    if sys.platform != "win32":
        return
    import importlib.util
    import os

    for package in ("nvidia.cublas", "nvidia.cudnn", "nvidia.cuda_runtime"):
        try:
            spec = importlib.util.find_spec(package)
        except (ImportError, ValueError):
            continue
        for location in (spec.submodule_search_locations or []) if spec else []:
            bin_dir = Path(location) / "bin"
            if bin_dir.is_dir():
                os.add_dll_directory(str(bin_dir))
                os.environ["PATH"] = str(bin_dir) + os.pathsep + os.environ.get("PATH", "")


_cuda = None


def cuda_usable():
    """A CUDA GPU is present *and* the cuBLAS / cuDNN libraries CTranslate2 needs can be loaded."""
    global _cuda
    if _cuda is None:
        try:
            import ctranslate2

            _cuda = ctranslate2.get_cuda_device_count() > 0
        except Exception:
            _cuda = False
        if _cuda and sys.platform == "win32":
            import ctypes

            add_nvidia_dll_dirs()
            for name in ("cublas64_12.dll", "cudnn64_9.dll"):
                try:
                    ctypes.WinDLL(name)
                except OSError:
                    _cuda = False
                    break
    return _cuda


def default_model():
    """Large-v3-turbo when it can run on the GPU, otherwise small (fast enough on a CPU)."""
    if cuda_usable() and is_cached("large-v3-turbo"):
        return "large-v3-turbo"
    return "small"


PUNCT_ONLY = re.compile(r"^[\W_]+$", re.UNICODE)


def merge_punctuation(words):
    """Whisper sometimes emits punctuation as its own word ("我", "﹑", "我"); attach it to the word before."""
    out = []
    for w in words:
        if PUNCT_ONLY.match(w["text"].strip()) and out:
            out[-1]["text"] += w["text"].strip()
        elif not PUNCT_ONLY.match(w["text"].strip()):
            out.append(w)
    return out


def to_simplified(words):
    """Convert word texts to Simplified Chinese when OpenCC is installed."""
    try:
        import opencc
    except ImportError:
        return words
    for config in ("t2s", "t2s.json"):
        try:
            converter = opencc.OpenCC(config)
            break
        except Exception:
            converter = None
    if converter is None:
        return words
    for w in words:
        w["text"] = converter.convert(w["text"])
    return words


def emit(**fields):
    print(json.dumps(fields), flush=True)


def run(audio, language, model_name, device, out_dir):
    from faster_whisper import WhisperModel

    from . import media
    from .analyze import analyze

    emit(stage="decoding", progress=0.0)
    pcm = media.pcm16k(audio)
    duration = len(pcm) / 16000

    emit(stage="downloading-model" if not is_cached(model_name) else "loading-model", progress=0.0)
    if device == "cuda":
        add_nvidia_dll_dirs()
    compute = "float16" if device == "cuda" else "int8"
    model = WhisperModel(model_name, device=device, compute_type=compute, local_files_only=is_cached(model_name))

    lang = None if language == "auto" else language
    if lang is None:
        try:
            lang, _, _ = model.detect_language(pcm)
        except Exception:
            lang = None
    emit(stage="transcribing", progress=0.0, language=lang)

    segments, info = model.transcribe(
        pcm, language=lang, word_timestamps=True, beam_size=5 if device == "cuda" else 3,
        vad_filter=True, condition_on_previous_text=False, initial_prompt=PROMPTS.get(lang or ""))
    words = []
    for segment in segments:
        for w in segment.words or []:
            start, end = max(0.0, w.start), min(duration, w.end)
            if end > start and w.word.strip():
                words.append({"start": round(start, 3), "end": round(end, 3), "text": w.word,
                              "p": round(float(w.probability), 3)})
        emit(stage="transcribing", progress=min(0.99, segment.end / max(duration, 0.01)))
    words = merge_punctuation(words)
    detected = info.language or lang
    if detected == "zh":
        words = to_simplified(words)

    emit(stage="analyzing", progress=0.0)
    analysis = analyze(pcm, words)
    out = Path(out_dir)
    (out / "words.json").write_text(json.dumps(words, ensure_ascii=False), encoding="utf-8")
    (out / "analysis.json").write_text(json.dumps(analysis), encoding="utf-8")
    emit(done=True, language=detected, device=device, model=model_name, duration=round(duration, 3), words=len(words))


def main(argv=None):
    parser = argparse.ArgumentParser(prog="python -m takecut.transcribe")
    parser.add_argument("--audio", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--language", default="auto", choices=["auto", "zh", "en"])
    parser.add_argument("--model", default="small")
    parser.add_argument("--device", default="cpu", choices=["cpu", "cuda"])
    args = parser.parse_args(argv)
    try:
        run(args.audio, args.language, args.model, args.device, args.out)
    except Exception as exc:  # reported to the parent, which may retry on CPU
        emit(error=type(exc).__name__, detail=str(exc)[-800:])
        sys.exit(1)


if __name__ == "__main__":
    main()
