// Filler words. "Strong" fillers (嗯、呃 / um, uh) are almost never meaningful. "Weak" ones
// (那个、就是 / like, you know) are only flagged when set off by a pause or punctuation on both
// sides. Sounds the recognizer skipped (energy without words, from the server's analysis) are
// listed as "possible" fillers.

import { normalize, endsClause, endsSentence } from "../text.js";

const STRONG = {
  cjk: /^[嗯呃额唔]+$/u,
  latin: /^(u+m+|u+h+|u+h+m+|e+r+m*|a+h+|h+m+|m{2,})$/,
};
const WEAK = {
  cjk: new Set(["那个", "就是", "就是说", "然后", "这个", "其实", "啊", "哦", "噢"]),
  latin: new Set(["like", "youknow", "imean", "so", "basically", "actually", "literally", "right", "okay", "ok", "well"]),
};

export function fillerStrength(text, script) {
  if (STRONG[script].test(text)) return "strong";
  if (WEAK[script].has(text)) return "weak";
  return null;
}

/** Cut range for words first..last: the word itself plus the pause after it, keeping a short breath. */
export function fillerRange(words, first, last, duration) {
  const prev = words[first - 1], next = words[last + 1];
  const a = Math.max(prev ? prev.end : 0, words[first].start - 0.03);
  const b = next
    ? Math.max(words[last].end, next.start - Math.min(0.12, Math.max(0, next.start - words[last].end)))
    : Math.min(duration ?? Infinity, words[last].end + 0.05);
  return [a, b];
}

export function findFillers(words, lines, lineOf, script, duration) {
  const out = [];
  const lineStart = new Set(lines.map(l => l.ids[0]));
  const lineEnd = new Set(lines.map(l => l.ids.at(-1)));
  for (let i = 0; i < words.length; i++) {
    for (let n = 3; n >= 1; n--) {
      const last = i + n - 1;
      if (last >= words.length || lineOf[last] !== lineOf[i]) continue;
      let text = "";
      for (let k = i; k <= last; k++) text += normalize(words[k].text);
      if (!text) continue;
      const strength = fillerStrength(text, script);
      if (!strength) continue;
      if (strength === "weak") {
        const prev = words[i - 1], next = words[last + 1];
        const before = lineStart.has(i) || endsClause(prev.text) || endsSentence(prev.text) || words[i].start - prev.end >= 0.25;
        const after = lineEnd.has(last) || endsClause(words[last].text) || endsSentence(words[last].text) ||
          (next && next.start - words[last].end >= 0.2);
        if (!before || !after) continue;
      }
      const ids = [];
      for (let k = i; k <= last; k++) ids.push(k);
      out.push({
        type: "filler", category: "fillers", strength,
        key: `filler:${words[i].start.toFixed(2)}`,
        start: words[i].start, end: words[last].end,
        words: ids, line: lineOf[i],
        ranges: [fillerRange(words, i, last, duration)],
      });
      i = last;
      break;
    }
  }
  return out;
}

/** Voiced sounds without recognized words (from analysis.sounds), clipped to the gap they sit in. */
export function findUnrecognized(words, sounds = []) {
  const out = [];
  for (const s of sounds) {
    if (!s.voiced) continue;
    let k = 0;
    while (k < words.length && words[k].end <= s.start) k++;
    const prev = words[k - 1], next = words[k];
    if (next && next.start < s.end) continue; // overlaps a word: not unrecognized after all
    const a = Math.max(prev ? prev.end : 0, s.start - 0.02);
    const b = Math.min(next ? next.start : s.end + 0.02, s.end + 0.02);
    if (b - a < 0.08) continue;
    out.push({
      type: "sound", category: "fillers", strength: "possible",
      key: `sound:${s.start.toFixed(2)}`,
      start: s.start, end: s.end,
      ranges: [[a, b]],
    });
  }
  return out;
}
