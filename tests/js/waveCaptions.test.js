import { test } from "node:test";
import assert from "node:assert/strict";
import { splitLines } from "../../web/js/core/lines.js";
import { buildPlan } from "../../web/js/core/timeline.js";
import { applyCut, emptyEdits, fixWord, setPause } from "../../web/js/core/edits.js";
import { buildWaveCaptions, wordAtAxisTime, lineAtAxisTime, findMatchingWords, layoutWordLabels } from "../../web/js/core/waveCaptions.js";
import { sampleWords, near } from "./helpers.js";

const SR = 44100, DURATION = 21.8;
const zh = sampleWords();
const lines = splitLines(zh);
const ctx = { duration: DURATION, sampleRate: SR };
const plan = e => buildPlan({ ...ctx, cuts: e.cuts, pauses: e.pauses });

test("buildWaveCaptions syncs word and line positions on edited and source timelines", () => {
  let e = applyCut(emptyEdits(), [[3.785, 6.22]], ctx).edits;
  e = fixWord(e, 34, "原始", "原");
  const p = plan(e);

  const edited = buildWaveCaptions(zh, lines, e, p, "edited");
  const source = buildWaveCaptions(zh, lines, e, p, "source");

  assert.ok(edited.words.length < source.words.length);
  assert.ok(edited.words.every(w => !w.cut));
  assert.ok(source.words.some(w => w.cut));
  assert.ok(edited.words.some(w => w.text === "原始"));

  // Words after the cut shift earlier by the cut duration (~2.435 s)
  const afterCut = edited.words.find(w => w.sourceStart > 6.5);
  near(afterCut.start, afterCut.sourceStart - (6.22 - 3.785), 2 / SR);
});

test("wordAtAxisTime, lineAtAxisTime, and findMatchingWords locate desired words", () => {
  const e = setPause(emptyEdits(), 8.18, 0.5);
  const caps = buildWaveCaptions(zh, lines, e, plan(e), "edited");

  const found = findMatchingWords(caps.words, "口播");
  assert.ok(found.length >= 1);
  const w = found[0];
  assert.equal(wordAtAxisTime(caps.words, (w.start + w.end) / 2)?.index, w.index);
  assert.equal(lineAtAxisTime(caps.lines, (w.start + w.end) / 2)?.index, w.line);
});

test("layoutWordLabels always preserves priority words without overlapping", () => {
  const words = [
    { index: 0, text: "alpha", start: 0, end: 0.2 },
    { index: 1, text: "beta", start: 0.1, end: 0.3 },
    { index: 2, text: "gamma", start: 0.8, end: 1.0 },
  ];
  const measure = w => ({ left: w.start * 100, right: w.start * 100 + 30 });
  const placed = layoutWordLabels(words, measure, 4, new Set([1]));
  assert.deepEqual(placed.map(p => p.word.index), [1, 2]);
});
