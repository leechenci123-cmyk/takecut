import { readFileSync, existsSync } from "node:fs";
import assert from "node:assert/strict";

/** The v3 Chinese demo transcript (51 words, about 21.8 s), kept as a fixture to pin v3 behavior. */
export function sampleWords() {
  const url = new URL("../fixtures/zh-v3-words.json", import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")).map(w => ({ start: w.start, end: w.end, text: w.text }));
}

/** A bundled sample's words and analysis. */
export function bundledSample(lang) {
  const read = name => JSON.parse(readFileSync(new URL(`../../samples/${lang}/${name}`, import.meta.url), "utf8"));
  return { words: read("words.json"), analysis: read("analysis.json") };
}

export const fileExists = path => existsSync(new URL(`../../${path}`, import.meta.url));

export const near = (actual, expected, eps = 1e-6, msg) =>
  assert.ok(Math.abs(actual - expected) <= eps, msg ?? `expected ${expected}, got ${actual}`);

export const nearAll = (actual, expected, eps = 1e-6) => {
  assert.equal(actual.length, expected.length, `length ${actual.length} != ${expected.length}`);
  actual.forEach((x, i) => (Array.isArray(x) ? nearAll(x, expected[i], eps) : near(x, expected[i], eps, `[${i}] expected ${expected[i]}, got ${x}`)));
};

/** Build words from "text@start-end" specs, or evenly spaced from a list of texts. */
export function words(specs) {
  return specs.map(s => {
    const m = /^(.*)@([\d.]+)-([\d.]+)$/.exec(s);
    return { text: m[1], start: Number(m[2]), end: Number(m[3]) };
  });
}

/** Evenly spaced words: each `dur` long, `gap` apart, starting at `t0`. */
export function spaced(texts, { t0 = 0, dur = 0.2, gap = 0.05 } = {}) {
  let t = t0;
  return texts.map(text => {
    const w = { text, start: t, end: t + dur };
    t += dur + gap;
    return w;
  });
}
