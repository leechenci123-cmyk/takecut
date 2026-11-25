// Smart cut points: move a cut edge to the quietest moment nearby (from the server's loudness
// envelope), so joins land in silence instead of on a consonant. Never moves into a kept word.

/**
 * The quietest time in [lo, hi] near t. Each envelope value covers `hop` seconds; a small bias
 * (20 dB per second of distance) prefers staying close to t when levels are similar.
 */
export function quietestPoint(analysis, t, lo, hi) {
  const env = analysis?.env, hop = analysis?.hop;
  if (!env?.length || !hop || !(hi > lo)) return t;
  const a = Math.max(0, Math.floor(lo / hop)), b = Math.min(env.length - 1, Math.floor(hi / hop));
  if (b < a) return t;
  let best = -1, bestScore = Infinity;
  for (let k = a; k <= b; k++) {
    const center = (k + 0.5) * hop;
    const score = env[k] + Math.abs(center - t) * 20;
    if (score < bestScore) { bestScore = score; best = k; }
  }
  return best < 0 ? t : Math.min(hi, Math.max(lo, (best + 0.5) * hop));
}

/**
 * Cut range for words first..last: each edge may move up to `reach` seconds outward into the gap
 * (never past the neighboring word) or 20 ms inward, to the quietest point.
 */
export function snapWordRange(words, analysis, first, last, reach = 0.06) {
  const prevEnd = first > 0 ? words[first - 1].end : 0;
  const nextStart = last + 1 < words.length ? words[last + 1].start : Infinity;
  const a0 = words[first].start, b0 = words[last].end;
  const a = quietestPoint(analysis, a0, Math.max(prevEnd, a0 - reach), Math.min(b0, a0 + 0.02));
  const b = quietestPoint(analysis, b0, Math.max(a, b0 - 0.02), Math.min(nextStart, b0 + reach));
  return [a, b];
}
