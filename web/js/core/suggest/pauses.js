// Long pauses between kept words. "Shorten to X s" removes the middle of the real silence and keeps
// X seconds of the original room tone, so the join still breathes. Recomputed after every edit.

import { cutFlags, overlapsCut, keepRanges } from "../timeline.js";

export const DEFAULT_THRESHOLD = 0.8;
export const DEFAULT_TARGET = 0.4;

/**
 * silenceIn(a, b): the longest detected silence inside [a, b], or [a, b] without analysis.
 * Queries must come in increasing order of a (one sweep over the sorted silences).
 */
function silenceFinder(silences) {
  let from = 0;
  return (a, b) => {
    if (!silences) return [a, b];
    while (from < silences.length && silences[from][1] <= a) from++;
    let best = null;
    for (let j = from; j < silences.length && silences[j][0] < b; j++) {
      const s = Math.max(a, silences[j][0]), e = Math.min(b, silences[j][1]);
      if (e > s && (!best || e - s > best[1] - best[0])) best = [s, e];
    }
    return best;
  };
}

export function findLongPauses(words, { cuts, pauses }, { duration, threshold = DEFAULT_THRESHOLD, target = DEFAULT_TARGET, silences = null } = {}) {
  const out = [];
  const flags = cutFlags(cuts, words);
  const kept = [];
  for (let i = 0; i < words.length; i++) if (!flags[i]) kept.push(i);
  if (!kept.length) return out;
  const silenceIn = silenceFinder(silences);
  const free = (a, b) => !overlapsCut(cuts, a, b) && !pauses.some(p => p.at >= a && p.at <= b);

  const first = words[kept[0]], last = words[kept.at(-1)];
  if (first.start > Math.max(0.6, target) && free(0, first.start)) {
    out.push(edge("start", [0, first.start - Math.min(0.25, target)], 0, first.start));
  }
  const keep = keepRanges(cuts, duration);
  let kk = 0;
  for (let k = 0; k < kept.length - 1; k++) {
    const p = words[kept[k]], n = words[kept[k + 1]];
    if (n.start <= p.end || pauses.some(pz => pz.at >= p.end && pz.at <= n.start)) continue;
    // The gap as heard after editing: its uncut pieces (a retake cut may sit inside it).
    while (kk < keep.length && keep[kk][1] <= p.end) kk++;
    const pieces = [];
    for (let j = kk; j < keep.length && keep[j][0] < n.start; j++) {
      const a = Math.max(keep[j][0], p.end), b = Math.min(keep[j][1], n.start);
      if (b > a) pieces.push([a, b]);
    }
    const gap = pieces.reduce((sum, [a, b]) => sum + b - a, 0);
    if (gap <= threshold) continue;
    let quiet = null;
    for (const [a, b] of pieces) {
      const q = silenceIn(a, b);
      if (q && (!quiet || q[1] - q[0] > quiet[1] - quiet[0])) quiet = q;
    }
    if (!quiet) continue;
    // Remove from the middle of the longest quiet stretch, keeping a little of it on both sides.
    const remove = Math.min(gap - target, quiet[1] - quiet[0] - 0.05);
    if (remove < 0.1) continue;
    const mid = (quiet[0] + quiet[1]) / 2;
    out.push({
      type: "pause", category: "pauses",
      key: `pause:${p.end.toFixed(2)}`,
      start: p.end, end: n.start, length: gap, after: kept[k], before: kept[k + 1],
      ranges: [[mid - remove / 2, mid + remove / 2]],
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
