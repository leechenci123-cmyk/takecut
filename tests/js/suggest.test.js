import { test } from "node:test";
import assert from "node:assert/strict";
import { splitLines, lineIndex } from "../../web/js/core/lines.js";
import { scriptOf } from "../../web/js/core/text.js";
import { findRetakes, findRestarts, isRetakeOf, keepTakeRanges, lcsLength, recommendTake } from "../../web/js/core/suggest/retakes.js";
import { findStutters } from "../../web/js/core/suggest/stutters.js";
import { findFillers, findUnrecognized, fillerStrength } from "../../web/js/core/suggest/fillers.js";
import { findLongPauses } from "../../web/js/core/suggest/pauses.js";
import { staticSuggestions, statusOf, rangesFor } from "../../web/js/core/suggest/index.js";
import { applyCut, emptyEdits } from "../../web/js/core/edits.js";
import { tokensOf } from "../../web/js/core/text.js";
import { sampleWords, bundledSample, nearAll, near, spaced, words as w } from "./helpers.js";

const zh = sampleWords();
const zhLines = splitLines(zh);
const DURATION = 21.8;

test("the Chinese sample splits into the six v3 lines", () => {
  assert.equal(scriptOf(zh), "cjk");
  assert.deepEqual(zhLines.map(l => l.text), [
    "有时候,一段口播要录好几遍。", "今天我想聊聊。", "今天我想聊聊,怎么剪掉重复的录音。",
    "我,我,我先放一段原声。", "这句话非常,非常重要。", "听一听,每一遍更自然。",
  ]);
});

test("v3 retake: two takes of 今天我想聊聊, recommending the complete second one", () => {
  const [r, ...rest] = findRetakes(zhLines, "cjk");
  assert.equal(rest.length, 0);
  assert.deepEqual(r.takes.map(t => t.line), [1, 2]);
  assert.equal(r.recommended, 1);
  // v3 keepTake: from 35 ms before the rejected line to 80 ms before the next line.
  nearAll(keepTakeRanges(r, 1), [[3.82 - 0.035, 6.3 - 0.08]]);
  nearAll(keepTakeRanges(r, 0), [[6.3 - 0.035, 10.96 - 0.08]]);
});

test("v3 stutters: 我，我，我 and 非常，非常, keeping the last word", () => {
  const s = findStutters(zh);
  assert.deepEqual(s.map(x => x.words), [[27, 28, 29], [39, 40]]);
  nearAll(s.map(x => x.ranges[0]), [[10.96, 12.28], [15.52, 16.44]]);
});

test("the sample has no restarts or fillers, and three suggestions overall", () => {
  assert.equal(findRestarts(zh, zhLines, "cjk").length, 0);
  assert.equal(findFillers(zh, zhLines, lineIndex(zhLines, zh.length), "cjk", DURATION).length, 0);
  const all = staticSuggestions({ words: zh, lines: zhLines, lineOf: lineIndex(zhLines, zh.length), script: "cjk", duration: DURATION });
  assert.deepEqual(all.map(s => s.type), ["retake", "stutter", "stutter"]);
});

test("retake similarity: same opening, reworded take, but not parallel list items", () => {
  const t = s => tokensOf(s, "cjk");
  assert.ok(isRetakeOf(t("今天我们聊聊"), t("今天我想来聊聊"), "cjk"));
  assert.ok(isRetakeOf(t("我们有三个方法"), t("我们有四个方法"), "cjk"));
  assert.ok(!isRetakeOf(t("第一步打开软件"), t("第二步打开软件"), "cjk"));
  assert.ok(!isRetakeOf(t("我们先看第一个"), t("我们再看第二个"), "cjk"));
  assert.equal(lcsLength([..."abcde"], [..."axcye"]), 3);
  assert.equal(recommendTake([10, 4]), 0);
  assert.equal(recommendTake([6, 15, 14]), 2);
});

test("English retakes compare words", () => {
  const en = spaced([" Today", " I", " want", " to", " show", " you.", " Today", " I", " want", " to", " show", " you", " how", " it", " works."]);
  const lines = splitLines(en);
  assert.equal(scriptOf(en), "latin");
  assert.equal(lines.length, 2);
  const [r] = findRetakes(lines, "latin");
  assert.equal(r.takes.length, 2);
  assert.equal(r.recommended, 1);
});

test("a restart inside one line cuts only the abandoned start", () => {
  const ws = w(["今天@0-0.4", "我想@0.4-0.8", "今天@1.2-1.6", "我想@1.6-2", "聊@2-2.3", "聊。@2.3-2.6"]);
  const lines = splitLines(ws);
  const [r] = findRestarts(ws, lines, "cjk");
  assert.deepEqual(r.words, [0, 1]);
  nearAll(r.ranges, [[0, 1.14]]);
  const en = w([" I@0-0.2", " think@0.2-0.5", " I@0.9-1.1", " think@1.1-1.4", " we@1.4-1.6", " should.@1.6-2"]);
  assert.deepEqual(findRestarts(en, splitLines(en), "latin")[0].words, [0, 1]);
});

test("English stutters include cut-off partial words", () => {
  const en = w([" The@0-0.2", " th-@0.5-0.6", " the@0.7-0.8", " the@0.85-0.95", " plan.@1-1.4"]);
  assert.deepEqual(findStutters(en).map(x => x.words), [[1, 2], [2, 3]]);
});

test("filler strength: strong always, weak only when set off by pauses or punctuation", () => {
  assert.equal(fillerStrength("嗯嗯", "cjk"), "strong");
  assert.equal(fillerStrength("那个", "cjk"), "weak");
  assert.equal(fillerStrength("ummm", "latin"), "strong");
  assert.equal(fillerStrength("a", "latin"), null);
  const en = w([" It@0-0.2", " was,@0.2-0.5", " like,@0.6-0.8", " really@1.1-1.4", " good.@1.4-1.8",
    " I@3-3.1", " like@3.1-3.4", " it.@3.4-3.6", " Um,@5-5.3", " okay.@5.8-6.2"]);
  const lines = splitLines(en);
  const f = findFillers(en, lines, lineIndex(lines, en.length), "latin", 7);
  assert.deepEqual(f.map(x => [x.words, x.strength]), [[[2], "weak"], [[8], "strong"], [[9], "weak"]]);
  // The cut keeps a 0.12 s breath before the next word.
  nearAll(f[0].ranges, [[0.57, 0.98]]);
});

test("Chinese fillers, including the pause after them", () => {
  const ws = w(["嗯，@0-0.3", "这个@0.8-1.1", "问题@1.1-1.5", "那个，@2.2-2.5", "我们@2.9-3.2", "再说。@3.2-3.6"]);
  const lines = splitLines(ws);
  const f = findFillers(ws, lines, lineIndex(lines, ws.length), "cjk", 4);
  assert.deepEqual(f.map(x => [x.words, x.strength]), [[[0], "strong"], [[3], "weak"]]);
  nearAll(f[0].ranges, [[0, 0.68]]);
});

test("unrecognized voiced sounds between words become possible fillers", () => {
  const ws = w(["我们@0-0.4", "开始。@1.5-1.9"]);
  const found = findUnrecognized(ws, [{ start: 0.7, end: 1.0, voiced: true }, { start: 1.2, end: 1.3, voiced: false }, { start: 1.4, end: 1.6, voiced: true }]);
  assert.equal(found.length, 1);
  nearAll(found[0].ranges, [[0.68, 1.02]]);
});

test("long pauses on the sample: five gaps and the trailing silence", () => {
  const edits = emptyEdits();
  const found = findLongPauses(zh, edits, { duration: DURATION });
  assert.deepEqual(found.map(x => x.type), ["pause", "pause", "pause", "pause", "pause", "edge"]);
  nearAll(found[0].ranges, [[2.96, 3.62]]);
  near(found.at(-1).ranges[0][0], 20.96);
  // Shortening keeps exactly the target length of the original gap.
  const after = applyCut(edits, found[0].ranges, { duration: DURATION, sampleRate: 44100 }).edits;
  const again = findLongPauses(zh, after, { duration: DURATION });
  assert.equal(again.length, 5);
});

test("pauses use the detected silence and measure gaps after earlier cuts", () => {
  const ws = w(["一@0-0.5", "二@2-2.5"]);
  const silences = [[0.6, 1.7]];
  // 1.5 s gap, 1.1 s of it silent: remove 1.05 s from the middle of the silence.
  const [p] = findLongPauses(ws, emptyEdits(), { duration: 3, silences, target: 0.4 });
  nearAll(p.ranges, [[0.625, 1.675]]);
  // A cut inside the gap (e.g. a removed retake) leaves 1.4 s audible: still too long.
  const cut = { ...emptyEdits(), cuts: [[0.9, 1.0]] };
  const [q] = findLongPauses(ws, cut, { duration: 3, silences }).filter(x => x.type === "pause");
  near(q.length, 1.4);
  assert.ok(q.ranges[0][0] >= 1.0 && q.ranges[0][1] <= 1.7, String(q.ranges));
  // Once shortened, it is not suggested again.
  const done = { ...cut, cuts: [[0.9, 1.0], q.ranges[0]] };
  assert.equal(findLongPauses(ws, done, { duration: 3, silences }).filter(x => x.type === "pause").length, 0);
  // An inserted pause inside the gap means the user already shaped it.
  assert.equal(findLongPauses(ws, { ...emptyEdits(), pauses: [{ at: 1.2, duration: 0.3 }] }, { duration: 3, silences }).filter(x => x.type === "pause").length, 0);
});

test("removing a retake leaves the join's long silence as a pause suggestion", () => {
  const lines = splitLines(zh);
  const [retake] = findRetakes(lines, "cjk");
  const edits = applyCut(emptyEdits(), keepTakeRanges(retake, 1), { duration: DURATION, sampleRate: 44100 }).edits;
  const join = findLongPauses(zh, edits, { duration: DURATION }).find(p => p.key === "pause:2.76");
  assert.ok(join, "the gap before the kept take is still suggested");
  near(join.length, (3.785 - 2.76) + (6.3 - 6.22), 1e-6);
});

test("bundled samples: every suggestion type the demo relies on is found", () => {
  for (const [lang, expected] of [["zh", ["retake", "stutter", "stutter"]], ["en", ["retake", "filler", "stutter", "stutter"]]]) {
    const { words, analysis } = bundledSample(lang);
    const lines = splitLines(words), script = scriptOf(words);
    const found = staticSuggestions({ words, lines, lineOf: lineIndex(lines, words.length), script, duration: analysis.duration, analysis });
    assert.deepEqual(found.map(s => s.type), expected, lang);
    const pauses = findLongPauses(words, emptyEdits(), { duration: analysis.duration, silences: analysis.silences });
    assert.ok(pauses.filter(p => p.type === "pause").length >= 5, `${lang} pauses`);
  }
});

test("status follows the edits: applying or ignoring closes a suggestion", () => {
  const lineOf = lineIndex(zhLines, zh.length);
  const all = staticSuggestions({ words: zh, lines: zhLines, lineOf, script: "cjk", duration: DURATION });
  const [retake, stutter] = all;
  let edits = emptyEdits();
  assert.equal(statusOf(retake, edits, zhLines, zh), "open");
  edits = applyCut(edits, rangesFor(retake), { duration: DURATION, sampleRate: 44100 }).edits;
  assert.equal(statusOf(retake, edits, zhLines, zh), "done");
  assert.equal(statusOf(stutter, edits, zhLines, zh), "open");
  edits = { ...edits, ignored: [stutter.key] };
  assert.equal(statusOf(stutter, edits, zhLines, zh), "ignored");
});
