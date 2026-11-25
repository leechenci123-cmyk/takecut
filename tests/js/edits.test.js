import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyEdits, normalizeEdits, applyCut, restoreRange, setPause, canSplit, addSplit, ignoreSuggestion, unignoreSuggestion } from "../../web/js/core/edits.js";
import { createHistory } from "../../web/js/core/history.js";
import { nearAll } from "./helpers.js";

const ctx = { duration: 10, sampleRate: 44100 };

test("normalizeEdits keeps valid data and drops the rest", () => {
  const e = normalizeEdits({
    cuts: [[2, 3], [1, 2.5], ["x", 4]], pauses: [{ at: 5, duration: 0.4 }, { at: 99, duration: 1 }, { at: 1, duration: 0 }],
    splits: [4, -1, 20], fixes: { 3: "对", x: "no", 4: 5 }, ignored: ["a", 2], extra: true,
  }, 10);
  nearAll(e.cuts, [[1, 3]]);
  assert.deepEqual(e.pauses, [{ at: 5, duration: 0.4 }]);
  assert.deepEqual(e.splits, [4]);
  assert.deepEqual(e.fixes, { 3: "对" });
  assert.deepEqual(e.ignored, ["a"]);
  assert.equal(e.extra, undefined);
  assert.deepEqual(normalizeEdits(null, 10), emptyEdits());
});

test("restoreRange brings audio back", () => {
  const e = applyCut(emptyEdits(), [[1, 5]], ctx).edits;
  nearAll(restoreRange(e, [2, 3]).cuts, [[1, 2], [3, 5]]);
});

test("setPause inserts, resizes and removes by anchor", () => {
  let e = setPause(emptyEdits(), 2, 0.4);
  e = setPause(e, 2, 0.8);
  e = setPause(e, 1, 0.2);
  assert.deepEqual(e.pauses, [{ at: 1, duration: 0.2 }, { at: 2, duration: 0.8 }]);
  assert.deepEqual(setPause(e, 2, 0).pauses, [{ at: 1, duration: 0.2 }]);
});

test("splits only inside kept audio", () => {
  const e = applyCut(emptyEdits(), [[2, 3]], ctx).edits;
  assert.equal(canSplit(e, 2.5, 10), false);
  assert.equal(canSplit(e, 4, 10), true);
  assert.equal(canSplit(addSplit(e, 4), 4, 10), false);
});

test("ignore is idempotent and reversible", () => {
  const e = ignoreSuggestion(ignoreSuggestion(emptyEdits(), "k"), "k");
  assert.deepEqual(e.ignored, ["k"]);
  assert.deepEqual(unignoreSuggestion(e, "k").ignored, []);
});

test("history undoes and redoes, and a new edit clears redo", () => {
  const h = createHistory(2);
  h.record("a");
  h.record("b");
  h.record("c");
  assert.equal(h.undo("d"), "c");
  assert.equal(h.undo("c"), "b");
  assert.equal(h.undo("b"), null); // limit 2 dropped "a"
  assert.equal(h.redo("b"), "c");
  assert.equal(h.canRedo, true);
  h.record("x");
  assert.equal(h.canRedo, false);
});
