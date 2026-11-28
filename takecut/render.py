"""Render the edited timeline with FFmpeg: trim the kept pieces from the full-quality source,
insert silences, fade every join, then optionally denoise, normalize loudness and encode."""
import json
import re
import subprocess
from pathlib import Path

from . import media
from .media import MediaError, SAFE

FADE = 0.003  # seconds, at every join
FORMATS = {
    "wav": ["-c:a", "pcm_s16le"],
    "mp3": ["-c:a", "libmp3lame", "-b:a", "192k"],
    "m4a": ["-c:a", "aac", "-b:a", "192k"],
}
LOUDNESS = (-16, -14)
SLACK_FRAMES = 4410  # 0.1 s at 44.1 kHz


def validate_segments(segments, total_frames):
    """Frame-exact pieces from the client (timeline.renderList). Raises ValueError when malformed."""
    if not isinstance(segments, list) or not segments or len(segments) > 20000:
        raise ValueError("segments")
    out = []
    for seg in segments:
        if not isinstance(seg, dict):
            raise ValueError("segments")
        if seg.get("type") == "audio":
            a, b = seg.get("start"), seg.get("end")
            if not (isinstance(a, int) and isinstance(b, int) and 0 <= a < b):
                raise ValueError("segments")
            if b > total_frames:  # the browser's decode may differ by a few samples: clamp those
                if b - total_frames > SLACK_FRAMES or a >= total_frames:
                    raise ValueError("segments")
                b = total_frames
            out.append(("audio", a, b))
        elif seg.get("type") == "silence":
            n = seg.get("frames")
            if not (isinstance(n, int) and 0 < n <= 60 * 192000):
                raise ValueError("segments")
            out.append(("silence", n, None))
        else:
            raise ValueError("segments")
    return out


def build_graph(segments, sample_rate, channels):
    """filter_complex text and the frame count it produces. Output label: [edit]."""
    fade = max(1, round(FADE * sample_rate))
    layout = "stereo" if channels >= 2 else "mono"
    parts, labels, frames = [], [], 0
    for k, (kind, a, b) in enumerate(segments):
        if kind == "audio":
            length = b - a
            chain = f"[0:a]atrim=start_sample={a}:end_sample={b},asetpts=PTS-STARTPTS"
            if length > 2 * fade:
                chain += f",afade=t=in:ss=0:ns={fade},afade=t=out:ss={length - fade}:ns={fade}"
        else:
            length = a
            chain = f"anullsrc=r={sample_rate}:cl={layout},atrim=end_sample={length},asetpts=PTS-STARTPTS"
        parts.append(f"{chain}[s{k}]")
        labels.append(f"[s{k}]")
        frames += length
    parts.append(f"{''.join(labels)}concat=n={len(labels)}:v=0:a=1[edit]")
    return ";\n".join(parts), frames


def safe_name(name):
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "", name).strip().strip(".") or "takecut"
    return cleaned[:80]


def _ffmpeg_progress(args, total_seconds, progress, stage, weight):
    """Run FFmpeg with -progress on stdout, reporting `stage` from 0 to `weight` of the job."""
    # stderr goes to a temporary file so a chatty FFmpeg can never fill a pipe and stall.
    import tempfile

    with tempfile.TemporaryFile() as err, subprocess.Popen(
            args + ["-progress", "pipe:1", "-nostats"], stdout=subprocess.PIPE, stderr=err,
            text=True, encoding="utf-8", errors="replace") as proc:
        for line in proc.stdout:
            if line.startswith("out_time_us=") and total_seconds > 0:
                try:
                    done = int(line.split("=", 1)[1]) / 1e6
                except ValueError:
                    continue
                progress(stage, min(1.0, done / total_seconds) * weight[1] + weight[0])
        if proc.wait() != 0:
            err.seek(0)
            raise MediaError("ffmpeg-failed", err.read().decode("utf-8", "replace")[-1200:])


def measure_loudness(path, target):
    out = subprocess.run([media.ffmpeg(), "-nostdin", "-hide_banner", *SAFE, "-i", str(path),
                          "-af", f"loudnorm=I={target}:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"],
                         capture_output=True, text=True, encoding="utf-8", errors="replace")
    m = re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", out.stderr, re.S)
    if out.returncode != 0 or not m:
        raise MediaError("ffmpeg-failed", out.stderr[-1200:])
    return json.loads(m.group(0))


def render(project_dir, name, segments, fmt="wav", loudness=None, denoise=False,
           progress=lambda *a: None, preprocessed=False):
    project_dir = Path(project_dir)
    source = project_dir / "source.wav"
    total_frames, sample_rate, channels = media.wav_info(source)
    segs = validate_segments(segments, total_frames)
    if fmt not in FORMATS:
        raise ValueError("format")
    if loudness is not None and loudness not in LOUDNESS:
        raise ValueError("loudness")

    graph, frames = build_graph(segs, sample_rate, channels)
    if denoise:
        if preprocessed:
            chain = media.voice_clean_filter(light=True)
        else:
            chain = media.voice_clean_filter(media.estimate_noise_floor(source), light=False)
        graph = graph.replace("[edit]", "[raw]") + f";\n[raw]{chain}[edit]"
    seconds = frames / sample_rate
    exports = project_dir / "exports"
    exports.mkdir(exist_ok=True)
    graph_file = exports / ".graph.txt"
    graph_file.write_text(graph, encoding="utf-8")
    edit_wav = exports / ".edit.wav"
    out = exports / f"{safe_name(name)}-takecut.{fmt}"

    try:
        progress("rendering", 0.0)
        weight = (0.0, 0.6 if loudness else 0.9)
        _ffmpeg_progress([media.ffmpeg(), "-nostdin", "-v", "error", "-y", *SAFE, "-i", str(source),
                          *media.filter_script_args(graph_file), "-map", "[edit]",
                          "-c:a", "pcm_s16le", str(edit_wav)], seconds, progress, "rendering", weight)
        af = []
        if loudness:
            progress("measuring", 0.6)
            m = measure_loudness(edit_wav, loudness)
            af = ["-af", (f"loudnorm=I={loudness}:TP=-1.5:LRA=11:measured_I={m['input_i']}:"
                          f"measured_TP={m['input_tp']}:measured_LRA={m['input_lra']}:"
                          f"measured_thresh={m['input_thresh']}:offset={m['target_offset']}:linear=true")]
        progress("encoding", 0.7 if loudness else 0.9)
        _ffmpeg_progress([media.ffmpeg(), "-nostdin", "-v", "error", "-y", *SAFE, "-i", str(edit_wav), *af,
                          "-ar", str(sample_rate), *FORMATS[fmt], str(out)], seconds, progress, "encoding",
                         (0.7, 0.3) if loudness else (0.9, 0.1))
    finally:
        for tmp in (graph_file, edit_wav):
            tmp.unlink(missing_ok=True)
    return {"file": out.name, "size": out.stat().st_size, "duration": round(seconds, 3), "frames": frames}


CAPTION_FORMATS = {"srt", "vtt", "lrc", "txt"}


def save_captions(project_dir, name, fmt, content):
    """Save an exported caption file alongside exported audio under project_dir/exports/."""
    if fmt not in CAPTION_FORMATS:
        raise ValueError("caption-format")
    if not isinstance(content, str):
        raise ValueError("caption-content")
    exports = Path(project_dir) / "exports"
    exports.mkdir(exist_ok=True)
    out = exports / f"{safe_name(name)}-takecut.{fmt}"
    out.write_text(content, encoding="utf-8")
    return {"file": out.name, "size": out.stat().st_size}
