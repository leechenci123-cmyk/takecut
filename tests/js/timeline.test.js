import { test } from "node:test";
import assert from "node:assert/strict";
import {
  joinCuts, keepRanges, subtractRange, isWordCut, pauseAnchor, dropPausesInCuts,
  buildPlan, toEdited, toSource, pauseAt, segments, renderList, cutSeconds,
} from "../../web/js/core/timeline.js";
import { applyCut, setPause } from "../../web/js/core/edits.js";
import { near, nearAll } from "./helpers.js";

const SR = 44100;
const ctx = { duration: 10, sampleRate: SR };
const plan = edits => buildPlan({ ...ctx, cuts: edits.cuts ?? [], pauses: edits.pauses ?? [] });

test("joinCuts sorts, clamps, merges and drops empty ranges", () => {
  nearAll(joinCuts([[5, 6], [-1, 1], [0.5, 2], [6.000001, 7], [3, 3], [9, 12]], 10), [[0, 2], [5, 7], [9, 10]]);
  assert.deepEqual(joinCuts([[NaN, 2]], 10), []);
});

test("keepRanges and subtractRange are complements of the cut list", () => {
  nearAll(keepRanges([[1, 2], [5, 6]], 10), [[0, 1], [2, 5], [6, 10]]);
  nearAll(keepRanges([[0, 2], [8, 10]], 10), [[2, 8]]);
  nearAll(subtractRange([[1, 4], [6, 8]], [2, 7]), [[1, 2], [7, 8]]);
});

test("a word counts as cut when at least half of it is removed", () => {
  assert.equal(isWordCut([[1, 1.5]], { start: 1, end: 2 }), true);
  assert.equal(isWordCut([[1, 1.49]], { start: 1, end: 2 }), false);
});

test("without edits the plan is the identity", () => {
  const p = plan({});
  near(p.editedDuration, 10);
  for (const t of [0, 1.234, 9.99]) {
    near(toEdited(p, t), t, 1 / SR);
    near(toSource(p, t), t, 1 / SR);
  }
});

test("cuts close up and pauses add silence on the edited timeline", () => {
  const p = plan({ cuts: [[1, 1.5]], pauses: [{ at: 1.5, duration: 0.4 }] });
  near(p.editedDuration, 10 - 0.5 + 0.4, 1 / SR);
  near(toEdited(p, 1.2), 1.0, 1 / SR); // inside the cut -> where playback resumes
  near(toEdited(p, 1.5), 1.0, 1 / SR); // at the anchor: start of the pause
  near(toEdited(p, 1.5, true), 1.4, 1 / SR); // ...or after it
  near(toEdited(p, 2), 1.9, 1 / SR);
  near(toSource(p, 1.2), 1.5, 1 / SR); // inside the pause -> anchor
  near(toSource(p, 1.5), 1.6, 1 / SR);
  assert.deepEqual(pauseAt(p, 1.2), { at: 1.5, duration: 0.4 });
  assert.equal(pauseAt(p, 1.45), null);
});

// v3 bug (a): the clock froze at a pause because it showed source time. Edited time must keep
// moving through the pause while the source position stays at the anchor.
test("edited time advances through a pause while source time holds", () => {
  const p = plan({ pauses: [{ at: 2, duration: 1 }] });
  const sources = [1.9, 2.2, 2.5, 2.9, 3.1].map(t => toSource(p, t));
  nearAll(sources, [1.9, 2, 2, 2, 2.1], 1 / SR);
  const segs = segments(p, 1.5, 3.5);
  assert.deepEqual(segs.map(s => !!s.silence), [false, true, false]);
  near(segs.reduce((sum, s) => sum + s.duration, 0), 2, 1e-9);
  near(segs[2].source, 2, 1 / SR);
});

test("segments start mid-item and renderList covers the whole edited timeline in frames", () => {
  const p = plan({ cuts: [[2, 3]], pauses: [{ at: 5, duration: 0.5 }] });
  const segs = segments(p, 1.5, 6);
  near(segs[0].source, 1.5);
  near(segs[1].source, 3);
  assert.equal(segs[2].silence, true);
  const list = renderList(p);
  const frames = list.reduce((n, x) => n + (x.type === "silence" ? x.frames : x.end - x.start), 0);
  assert.equal(frames, p.frames);
  assert.deepEqual(list.map(x => x.type), ["audio", "audio", "silence", "audio"]);
});

test("pauseAnchor moves a time inside a cut to the cut's end, on a sample frame", () => {
  near(pauseAnchor([[1, 2]], 1.3, SR), 2);
  near(pauseAnchor([[1, 2]], 2.5, SR), 2.5);
  near(pauseAnchor([], 0.123456789, SR) * SR, Math.round(0.123456789 * SR));
});

// v3 bug (c): "replace pause" computed the anchor before merging the new cut with existing
// cuts, so the pause could land inside the merged cut.
test("replacing a pause anchors it after merging with an existing cut", () => {
  const existing = { cuts: [[1.200005, 2]], pauses: [] }; // starts just after the selection, within merge tolerance
  const { edits } = applyCut({ ...existing, splits: [], fixes: {}, ignored: [] }, [[0.5, 1.2]], ctx, { end: 1.2, duration: 0.4 });
  nearAll(edits.cuts, [[0.5, 2]]);
  assert.equal(edits.pauses.length, 1);
  near(edits.pauses[0].at, 2, 1 / SR);
  const p = plan(edits);
  near(toEdited(p, 2, true) - toEdited(p, 2), 0.4, 1 / SR);
});

test("a selection overlapping an existing cut anchors at the merged end", () => {
  const start = applyCut({ cuts: [], pauses: [], splits: [], fixes: {}, ignored: [] }, [[1, 1.5]], ctx).edits;
  const { edits } = applyCut(start, [[0.5, 1.2]], ctx, { end: 1.2, duration: 0.4 });
  nearAll(edits.cuts, [[0.5, 1.5]]);
  near(edits.pauses[0].at, 1.5, 1 / SR);
});

// The anchor is rounded to a frame and can sit a fraction of a sample inside the cut; a later
// unrelated cut must not drop it.
test("pauses at a cut's frame-rounded end survive later cuts", () => {
  const end = 1.0000049; // rounds down to a frame just below the cut end
  const at = pauseAnchor([[0.5, end]], 0.7, SR);
  assert.ok(at < end);
  assert.equal(dropPausesInCuts([{ at, duration: 0.3 }], [[0.5, end]], SR).length, 1);
  const { edits } = applyCut({ cuts: [[0.5, end]], pauses: [{ at, duration: 0.3 }], splits: [], fixes: {}, ignored: [] }, [[3, 4]], ctx);
  assert.equal(edits.pauses.length, 1);
});

test("cutting everything is refused; pauses inside new cuts are dropped", () => {
  const base = { cuts: [], pauses: [{ at: 3, duration: 0.2 }], splits: [], fixes: {}, ignored: [] };
  assert.equal(applyCut(base, [[0, 10]], ctx).error, "nothing-left");
  const { edits } = applyCut(base, [[2, 4]], ctx);
  assert.equal(edits.pauses.length, 0);
  near(cutSeconds(edits.cuts), 2);
  assert.equal(setPause(edits, 2, 0).pauses.length, 0);
});

test("cutFlags matches isWordCut for every word", async () => {
  const { cutFlags } = await import("../../web/js/core/timeline.js");
  let seed = 7;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let round = 0; round < 20; round++) {
    const words = [];
    let t = 0;
    for (let i = 0; i < 200; i++) { const d = 0.05 + rand() * 0.3; words.push({ start: t, end: t + d }); t += d + rand() * 0.4; }
    const cuts = joinCuts(Array.from({ length: 40 }, () => { const a = rand() * t; return [a, a + rand() * 1.5]; }), t);
    assert.deepEqual(cutFlags(cuts, words), words.map(w => isWordCut(cuts, w)));
  }
});
