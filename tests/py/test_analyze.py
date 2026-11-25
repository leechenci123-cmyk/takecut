import unittest

import numpy as np

from takecut.analyze import analyze, envelope_db, runs

SR = 16000


def tone(seconds, freq=220.0, amp=0.3):
    t = np.arange(int(seconds * SR)) / SR
    return (amp * np.sin(2 * np.pi * freq * t)).astype(np.float32)


def quiet(seconds, amp=0.0005):
    rng = np.random.default_rng(1)
    return (amp * rng.standard_normal(int(seconds * SR))).astype(np.float32)


class AnalyzeTest(unittest.TestCase):
    def test_runs(self):
        self.assertEqual(runs(np.array([0, 1, 1, 0, 1], dtype=bool)), [(1, 3), (4, 5)])
        self.assertEqual(runs(np.array([], dtype=bool)), [])

    def test_envelope_levels(self):
        db = envelope_db(np.concatenate([tone(0.5), quiet(0.5)]))
        self.assertEqual(len(db), 100)
        self.assertGreater(db[20], -15)   # 0.3 amplitude sine ~ -13.5 dBFS
        self.assertLess(db[80], -55)

    def test_silences_and_unrecognized_sounds(self):
        # word 0.0-0.5 | silence | unlabeled loud blip 1.2-1.5 | silence | word 2.0-2.5
        pcm = np.concatenate([tone(0.5), quiet(0.7), tone(0.3, 330), quiet(0.5), tone(0.5), quiet(0.3)])
        words = [{"start": 0.0, "end": 0.5, "text": "a"}, {"start": 2.0, "end": 2.5, "text": "b"}]
        a = analyze(pcm, words, SR)
        self.assertEqual(len(a["env"]), int(len(pcm) / SR / 0.01))
        silences = a["silences"]
        self.assertTrue(any(abs(s - 0.5) < 0.05 and abs(e - 1.2) < 0.05 for s, e in silences), silences)
        self.assertTrue(any(abs(s - 1.5) < 0.05 and abs(e - 2.0) < 0.05 for s, e in silences), silences)
        self.assertEqual(len(a["sounds"]), 1)
        sound = a["sounds"][0]
        self.assertAlmostEqual(sound["start"], 1.2, delta=0.05)
        self.assertAlmostEqual(sound["end"], 1.5, delta=0.05)
        self.assertTrue(sound["voiced"])

    def test_quiet_sounds_are_not_voiced(self):
        pcm = np.concatenate([tone(0.5), quiet(0.6), tone(0.3, 300, 0.01), quiet(0.6), tone(0.5)])
        words = [{"start": 0.0, "end": 0.5, "text": "a"}, {"start": 2.0, "end": 2.5, "text": "b"}]
        sounds = analyze(pcm, words, SR)["sounds"]
        self.assertTrue(all(not s["voiced"] for s in sounds), sounds)

    def test_empty_audio(self):
        a = analyze(np.zeros(0, dtype=np.float32), [], SR)
        self.assertEqual(a["silences"], [])
        self.assertEqual(a["env"], [])


if __name__ == "__main__":
    unittest.main()
