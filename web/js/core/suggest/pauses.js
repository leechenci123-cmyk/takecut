// Long pauses between kept words. "Shorten to X s" removes the middle of the real silence and keeps
// X seconds of the original room tone, so the join still breathes. Recomputed after every edit.

import { isWordCut, overlapsCut } from "../timeline.js";

export const DEFAULT_THRESHOLD = 0.8;
export const DEFAULT_TARGET = 0.4;

/** The longest detected silence inside [a, b], or [a, b] when there is no analysis. */
function silenceIn(silences, a, b) {
  if (!silences) return [a, b];
  let best = null;
  for (const [x, y] of silences) {
    const s = Math.max(a, x), e = Math.min(b, y);
    if (e > s && (!best || e - s > best[1] - best[0])) best = [s, e];
  }
  return best;
}

export function findLongPauses(words, { cuts, pauses }, { duration, threshold = DEFAULT_THRESHOLD, target = DEFAULT_TARGET, silences = null } = {}) {
  const out = [];
  const kept = [];
  for (let i = 0; i < words.length; i++) if (!isWordCut(cuts, words[i])) kept.push(i);
  if (!kept.length) return out;
  const half = target / 2;
  const free = (a, b) => !overlapsCut(cuts, a, b) && !pauses.some(p => p.at >= a && p.at <= b);

  const first = words[kept[0]], last = words[kept.at(-1)];
  if (first.start > Math.max(0.6, target) && free(0, first.start)) {
    out.push(edge("start", [0, first.start - Math.min(0.25, target)], 0, first.start));
  }
  for (let k = 0; k < kept.length - 1; k++) {
    const p = words[kept[k]], n = words[kept[k + 1]];
    const gap = n.start - p.end;
    if (gap <= threshold || !free(p.end, n.start)) continue;
    const quiet = silenceIn(silences, p.end, n.start);
    if (!quiet || quiet[1] - quiet[0] <= target + 0.05) continue;
    out.push({
      type: "pause", category: "pauses",
      key: `pause:${p.end.toFixed(2)}`,
      start: p.end, end: n.start, length: gap, after: kept[k], before: kept[k + 1],
      ranges: [[quiet[0] + half, quiet[1] - half]],
    });
  }
  if (duration - last.end > Math.max(0.6, target) && free(last.end, duration)) {
    out.push(edge("end", [last.end + Math.min(0.4, target), duration], last.end, duration));
  }
  return out;
}

function edge(which, range, start, end) {
  return {
    type: "edge", category: "pauses", which,
    key: `edge:${which}`,
    start, end, length: end - start,
    ranges: [range],
  };
}
