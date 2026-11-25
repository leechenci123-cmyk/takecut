// Retakes: the speaker says (nearly) the same line again. Also restarts inside one line,
// e.g. "今天我想今天我想聊聊" where the first attempt was abandoned mid-sentence.
// Heuristics, not AI: they compare the recognized text and timing.

import { tokensOf, endsClause, joinWords } from "../text.js";

export const MAX_TAKES = 9;
const MAX_GAP = 6; // seconds between takes

export function commonPrefix(a, b) {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/** Longest common subsequence length, O(len(a) * len(b)) with two rows. */
export function lcsLength(a, b) {
  if (!a.length || !b.length) return 0;
  let prev = new Array(b.length + 1).fill(0), cur = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/**
 * Same opening (the v3 rule: at least 3 units and 45% of the shorter line), or a reworded take
 * that still starts alike and shares 80% of its units in order.
 */
export function isRetakeOf(seed, next, script) {
  const min = Math.min(seed.length, next.length);
  const n = commonPrefix(seed, next);
  if (n >= (script === "cjk" ? 3 : 2) && n >= min * 0.45) return true;
  return n >= (script === "cjk" ? 2 : 1) && min >= (script === "cjk" ? 5 : 3) && lcsLength(seed, next) >= min * 0.8;
}

/** Cut range for rejecting `line`: from just before it to just before the next line (v3 keepTake). */
export function rejectRange(lines, line) {
  const next = lines[line.index + 1];
  const end = next ? Math.max(line.end, next.start - 0.08) : line.end;
  return [Math.max(0, line.start - 0.035), end];
}

/** Recommend the last take, unless it is clearly shorter than the longest (then the longest). */
export function recommendTake(lengths) {
  const max = Math.max(...lengths);
  const last = lengths.length - 1;
  return lengths[last] >= max * 0.7 ? last : lengths.indexOf(max);
}

export function findRetakes(lines, script) {
  const out = [];
  const tokens = lines.map(l => tokensOf(l.text, script));
  for (let i = 0; i < lines.length - 1; i++) {
    const group = [lines[i]];
    let j = i + 1;
    for (; j < lines.length && group.length < MAX_TAKES; j++) {
      if (lines[j].start - group.at(-1).end > MAX_GAP) break;
      if (!isRetakeOf(tokens[i], tokens[j], script)) break;
      group.push(lines[j]);
    }
    if (group.length > 1) {
      out.push({
        type: "retake", category: "retakes",
        key: `retake:${group[0].start.toFixed(2)}`,
        start: group[0].start, end: group.at(-1).end,
        takes: group.map(line => ({ line: line.index, start: line.start, end: line.end, text: line.text, range: rejectRange(lines, line) })),
        recommended: recommendTake(group.map(line => tokens[line.index].length)),
      });
      i = j - 1;
    }
  }
  return out;
}

/** Ranges to cut when keeping take `pick` of a retake suggestion. */
export const keepTakeRanges = (s, pick) => s.takes.filter((_, k) => k !== pick).map(t => t.range);

export function findRestarts(words, lines, script) {
  const out = [];
  const minUnit = script === "cjk" ? 3 : 2;
  for (const line of lines) {
    const toks = [];
    for (const i of line.ids) for (const t of tokensOf(words[i].text, script)) toks.push({ t, w: i });
    if (toks.length < minUnit * 2) continue;
    const T = toks.map(x => x.t);
    const starts = toks.map((x, k) => (k === 0 || toks[k - 1].w !== x.w ? k : -1)).filter(k => k >= 0);
    const anchors = starts.filter(k => k === 0 || endsClause(words[toks[k - 1].w].text));
    let found = null;
    search: for (const q of anchors) {
      for (const p of starts) {
        if (p <= q) continue;
        const unit = p - q;
        if (unit < minUnit) continue;
        if (unit > 24) break;
        const L = commonPrefix(T.slice(q, p), T.slice(p));
        if (L >= minUnit && L >= unit * 0.75) { found = { q, p, L }; break search; }
      }
    }
    if (!found) continue;
    const first = toks[found.q].w, restart = toks[found.p].w, lastAbandoned = toks[found.p - 1].w;
    const prevEnd = first > 0 ? words[first - 1].end : 0;
    const a = Math.max(prevEnd, words[first].start - 0.035);
    const b = Math.min(words[restart].start, Math.max(words[lastAbandoned].end, words[restart].start - 0.06));
    if (!(b > a)) continue;
    const ids = [];
    for (let i = first; i <= lastAbandoned; i++) ids.push(i);
    out.push({
      type: "restart", category: "retakes",
      key: `restart:${words[first].start.toFixed(2)}`,
      start: words[first].start, end: words[toks[found.p + found.L - 1].w].end,
      line: line.index, words: ids, text: joinWords(ids.map(i => words[i].text)),
      ranges: [[a, b]],
    });
  }
  return out;
}
