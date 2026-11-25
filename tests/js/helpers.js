import { readFileSync, existsSync } from "node:fs";
import assert from "node:assert/strict";

/** The bundled Chinese sample transcript (51 words, about 21 s). */
export function sampleWords() {
  for (const path of ["samples/zh/words.json", "demo/words.json"]) {
    const url = new URL(`../../${path}`, import.meta.url);
    if (existsSync(url)) return JSON.parse(readFileSync(url, "utf8")).map(w => ({ start: w.start, end: w.end, text: w.text }));
  }
  throw new Error("sample transcript not found");
}

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
