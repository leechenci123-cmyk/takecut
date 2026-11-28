import tempfile
import unittest
from pathlib import Path

from takecut import media, render
from tests.py.helpers import write_wav

RATE = 44100


@unittest.skipUnless(media.available(), "FFmpeg is not installed")
class RenderTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="takecut-test-"))
        write_wav(self.dir / "source.wav", [(1.0, 440, 0.3), (0.5, None, 0), (1.0, 330, 0.3)], RATE, channels=2)

    def tearDown(self):
        import shutil

        shutil.rmtree(self.dir, ignore_errors=True)

    def test_validate_segments(self):
        total = 2.5 * RATE
        ok = render.validate_segments([{"type": "audio", "start": 0, "end": 100}, {"type": "silence", "frames": 50}], total)
        self.assertEqual(ok, [("audio", 0, 100), ("silence", 50, None)])
        clamped = render.validate_segments([{"type": "audio", "start": 0, "end": int(total) + 6}], total)
        self.assertEqual(clamped, [("audio", 0, total)])
        for bad in ([], [{"type": "audio", "start": 5, "end": 5}], [{"type": "audio", "start": 0, "end": 10 ** 9}],
                    [{"type": "silence", "frames": 0}], [{"type": "noise"}], "x"):
            with self.assertRaises(ValueError):
                render.validate_segments(bad, total)

    def test_graph(self):
        graph, frames = render.build_graph([("audio", 0, 1000), ("silence", 500, None), ("audio", 2000, 2100)], RATE, 2)
        self.assertEqual(frames, 1600)
        self.assertIn("atrim=start_sample=0:end_sample=1000", graph)
        self.assertIn("anullsrc=r=44100:cl=stereo,atrim=end_sample=500", graph)
        self.assertIn("concat=n=3:v=0:a=1[edit]", graph)
        self.assertEqual(graph.count("afade"), 2)  # 100-frame piece is too short to fade

    def test_safe_name(self):
        self.assertEqual(render.safe_name('a<b>:"c"/d?.'), "abcd")
        self.assertEqual(render.safe_name("..."), "takecut")
        self.assertEqual(render.safe_name("中文 名字"), "中文 名字")

    def test_render_wav_is_frame_exact(self):
        segments = [{"type": "audio", "start": 0, "end": 22050}, {"type": "silence", "frames": 17640},
                    {"type": "audio", "start": 66150, "end": 110250}]
        result = render.render(self.dir, "Test", segments, "wav")
        out = self.dir / "exports" / result["file"]
        frames, rate, channels = media.wav_info(out)
        self.assertEqual((frames, rate, channels), (22050 + 17640 + 44100, RATE, 2))
        self.assertEqual(result["file"], "Test-takecut.wav")
        self.assertFalse((self.dir / "exports" / ".edit.wav").exists())

    def test_render_mp3_with_loudness_and_denoise(self):
        segments = [{"type": "audio", "start": 0, "end": 44100}, {"type": "audio", "start": 66150, "end": 110250}]
        stages = []
        result = render.render(self.dir, "Loud", segments, "mp3", loudness=-16, denoise=True,
                               progress=lambda stage, p=None: stages.append(stage))
        out = self.dir / "exports" / result["file"]
        self.assertAlmostEqual(media.duration_of(out), 2.0, delta=0.06)  # MP3 adds a little padding
        self.assertIn("measuring", stages)
        self.assertIn("encoding", stages)

    def test_render_rejects_bad_options(self):
        with self.assertRaises(ValueError):
            render.render(self.dir, "x", [{"type": "audio", "start": 0, "end": 10}], "ogg")
        with self.assertRaises(ValueError):
            render.render(self.dir, "x", [{"type": "audio", "start": 0, "end": 10}], "wav", loudness=-20)

    def test_clean_voice_reduces_noise_and_keeps_exact_frames(self):
        import wave
        import numpy as np

        sr = RATE
        t = np.arange(sr * 3, dtype=np.float32) / sr
        rng = np.random.default_rng(7)
        noise = 0.04 * rng.standard_normal(len(t)) + 0.05 * np.sin(2 * np.pi * 50 * t)
        voice = np.zeros_like(t)
        mask = (t >= 1.0) & (t < 2.0)
        voice[mask] = 0.25 * np.sin(2 * np.pi * 240 * t[mask]) + 0.14 * np.sin(2 * np.pi * 720 * t[mask])
        sig = np.clip(voice + noise, -0.99, 0.99)
        raw = self.dir / "noisy.wav"
        clean = self.dir / "clean.wav"
        preview = self.dir / "preview.wav"
        with wave.open(str(raw), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(sr)
            w.writeframes((sig * 32767).astype("<i2").tobytes())

        info = media.clean_voice(raw, clean, preview, channels=1)
        self.assertEqual(media.wav_info(clean), (sr * 3, sr, 1))
        self.assertEqual(media.wav_info(preview), (sr * 3, sr, 1))
        self.assertLessEqual(info["noiseFloorDb"], -20.0)
        with wave.open(str(clean), "rb") as w:
            out = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32) / 32768.0
        rms_db = lambda x: float(20 * np.log10(np.sqrt(np.mean(x * x)) + 1e-9))
        raw_snr = rms_db(sig[sr:2 * sr]) - rms_db(sig[:sr])
        clean_snr = rms_db(out[sr:2 * sr]) - rms_db(out[:sr])
        self.assertGreater(clean_snr, raw_snr + 4.0)

    def test_save_captions(self):
        saved = render.save_captions(self.dir, "Demo", "srt", "1\r\n00:00:00,000 --> 00:00:01,000\r\nHello\r\n")
        self.assertEqual(saved["file"], "Demo-takecut.srt")
        self.assertTrue((self.dir / "exports" / "Demo-takecut.srt").is_file())
        saved_lrc = render.save_captions(self.dir, "Demo", "lrc", "[00:00.00]Hello\n")
        self.assertEqual(saved_lrc["file"], "Demo-takecut.lrc")
        with self.assertRaises(ValueError):
            render.save_captions(self.dir, "Demo", "exe", "bad")


if __name__ == "__main__":
    unittest.main()
