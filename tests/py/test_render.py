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


if __name__ == "__main__":
    unittest.main()
