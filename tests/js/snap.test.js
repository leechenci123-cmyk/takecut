import { test } from "node:test";
import assert from "node:assert/strict";
import { quietestPoint, snapWordRange } from "../../web/js/core/snap.js";
import { near } from "./helpers.js";

// 1 s envelope at 10 ms: loud everywhere except a quiet dip at 0.30-0.32 s and 0.71 s.
const env = Array.from({ length: 100 }, (_, k) => (k >= 30 && k <= 31 ? -70 : k === 71 ? -65 : -20));
const analysis = { hop: 0.01, env };

test("quietestPoint finds the dip inside the window", () => {
  near(quietestPoint(analysis, 0.33, 0.27, 0.35), 0.315, 1e-9); // both dip frames equal: the closer one wins
  near(quietestPoint(analysis, 0.5, 0.45, 0.55), 0.495, 1e-9); // flat: stays close to t
  assert.equal(quietestPoint(null, 0.4, 0.3, 0.5), 0.4);
  assert.equal(quietestPoint(analysis, 0.4, 0.5, 0.3), 0.4);
});

test("snapWordRange moves edges into nearby silence but never into neighbors", () => {
  const words = [{ start: 0.1, end: 0.29, text: "a" }, { start: 0.33, end: 0.68, text: "b" }, { start: 0.74, end: 0.9, text: "c" }];
  const [a, b] = snapWordRange(words, analysis, 1, 1);
  near(a, 0.315, 1e-9);
  near(b, 0.715, 1e-9);
  assert.ok(a >= words[0].end && b <= words[2].start);
  // Without analysis the word edges are kept.
  assert.deepEqual(snapWordRange(words, null, 1, 1), [0.33, 0.68]);
});
