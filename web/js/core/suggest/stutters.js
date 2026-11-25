// Stutters: the same short word repeated ("我，我，我", "the the"), and cut-off partial words
// before the full word ("th- the"). Heuristics over recognized words and their timing.

import { normalize, endsClause } from "../text.js";

export function findStutters(words) {
  const out = [];
  for (let i = 0; i < words.length - 1; i++) {
    const t = normalize(words[i].text);
    if (!t) continue;
    const partial = /[-‐–—]$/.test(words[i].text.trim());
    if (partial && t.length <= 4) {
      const next = normalize(words[i + 1].text);
      if (next.length > t.length && next.startsWith(t) && words[i + 1].start - words[i].end < 0.85) {
        out.push(stutter(words, i, i + 1));
        continue;
      }
    }
    if (t.length > 4) continue;
    let j = i + 1;
    while (j < words.length && words[j].start - words[j - 1].end < 0.85 && normalize(words[j].text) === t) j++;
    const separated = endsClause(words[i].text) || (j > i + 1 && words[i + 1].start - words[i].end > 0.18);
    if (j > i + 1 && (t.length > 1 || j - i >= 3 || separated)) {
      out.push(stutter(words, i, j - 1));
      i = j - 1;
    }
  }
  return out;
}

/** Words first..last are the same word; the suggestion keeps only the last one. */
function stutter(words, first, last) {
  const ids = [];
  for (let i = first; i <= last; i++) ids.push(i);
  return {
    type: "stutter", category: "stutters",
    key: `stutter:${words[first].start.toFixed(2)}`,
    start: words[first].start, end: words[last].end,
    words: ids,
    ranges: [[words[first].start, words[last].start]],
  };
}
