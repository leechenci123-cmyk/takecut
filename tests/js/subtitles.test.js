import { test } from "node:test";
import assert from "node:assert/strict";
import { splitLines } from "../../web/js/core/lines.js";
import { buildPlan } from "../../web/js/core/timeline.js";
import { applyCut, emptyEdits, fixWord, setPause } from "../../web/js/core/edits.js";
import { buildCues, toSRT, toVTT, toTXT, srtTime, stripPunctuation } from "../../web/js/core/subtitles.js";
import { sampleWords, near, spaced } from "./helpers.js";

const SR = 44100, DURATION = 21.8;
const zh = sampleWords();
const lines = splitLines(zh);
const ctx = { duration: DURATION, sampleRate: SR };
const plan = e => buildPlan({ ...ctx, cuts: e.cuts, pauses: e.pauses });

test("srt time format", () => {
  assert.equal(srtTime(0), "00:00:00,000");
  assert.equal(srtTime(3723.4567), "01:02:03,457");
});

test("without edits there is one cue per line at the original times", () => {
  const e = emptyEdits();
  const cues = buildCues(zh, lines, e, plan(e));
  assert.deepEqual(cues.map(c => c.text), lines.map(l => l.text));
  near(cues[1].start, 3.82, 1 / SR);
  near(cues[1].end, 5.26, 1 / SR);
});

test("cut words leave the subtitles and later cues move earlier", () => {
  const e = applyCut(emptyEdits(), [[10.96, 12.28]], ctx).edits;
  const cues = buildCues(zh, lines, e, plan(e));
  assert.equal(cues[3].text, "我先放一段原声。");
  near(cues[3].start, 10.96, 1 / SR);
  near(cues[4].start, 14.96 - 1.32, 1 / SR);
});

test("an inserted pause splits a cue and shifts the rest", () => {
  const e = setPause(emptyEdits(), 8.18, 0.5);
  const cues = buildCues(zh, lines, e, plan(e));
  assert.deepEqual(cues.slice(2, 4).map(c => c.text), ["今天我想聊聊,", "怎么剪掉重复的录音。"]);
  near(cues[3].start, 8.68, 1 / SR);
});

test("text fixes, punctuation stripping and length limits", () => {
  let e = fixWord(emptyEdits(), 34, "原始", "原");
  const cues = buildCues(zh, lines, e, plan(e), { strip: true, maxChars: 8 });
  assert.ok(cues.some(c => c.text.includes("原始声")));
  assert.ok(cues.every(c => c.text.length <= 8), cues.map(c => c.text).join(" | "));
  assert.ok(cues.every(c => !/[，,。]/.test(c.text)));
  assert.equal(stripPunctuation("你好，世界。真的吗？"), "你好 世界 真的吗？");
  assert.equal(stripPunctuation("这句话非常,非常重要。"), "这句话非常 非常重要");
  assert.equal(stripPunctuation("Hello, world. It costs 3.5 dollars."), "Hello, world. It costs 3.5 dollars");
  e = fixWord(e, 34, "原", "原");
  assert.deepEqual(e.fixes, {});
});

test("SRT, VTT and TXT output", () => {
  const e = applyCut(emptyEdits(), [[3.785, 6.22]], ctx).edits;
  const cues = buildCues(zh, lines, e, plan(e));
  const srt = toSRT(cues);
  assert.ok(srt.startsWith("1\r\n00:00:00,000 --> 00:00:02,760\r\n有时候,一段口播要录好几遍。\r\n\r\n2\r\n"));
  assert.ok(toVTT(cues).startsWith("WEBVTT\n\n00:00:00.000 --> 00:00:02.760\n"));
  const txt = toTXT(zh, lines, e);
  assert.ok(!txt.includes("今天我想聊聊。"));
  assert.equal(txt.split("\n").filter(Boolean).length, 5);
});

test("English words keep their spacing", () => {
  const en = spaced([" Hello", " there,", " friend."]);
  const l = splitLines(en);
  const e = emptyEdits();
  const cues = buildCues(en, l, e, buildPlan({ duration: 2, sampleRate: SR, cuts: [], pauses: [] }));
  assert.equal(cues[0].text, "Hello there, friend.");
});
