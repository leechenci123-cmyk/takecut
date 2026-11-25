// Edit-decision math. Cuts and inserted pauses live on the source timeline (seconds of the
// original recording); the plan turns them into the edited timeline that playback and export use.
// Pure functions, no DOM: covered by tests/js/timeline.test.js.

export const EPS = 0.00001;
export const frameOf = (t, sampleRate) => Math.round(t * sampleRate);

/** Sort, clamp to [0, duration] and merge touching or overlapping ranges. */
export function joinCuts(ranges, duration) {
  const merged = [];
  for (let [a, b] of ranges.map(r => [r[0], r[1]]).sort((x, y) => x[0] - y[0])) {
    a = Math.max(0, a);
    b = Math.min(duration, b);
    if (!(b > a)) continue;
    const last = merged.at(-1);
    if (last && a <= last[1] + EPS) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  return merged;
}

/** The parts of [0, duration] that are not cut. Expects merged cuts. */
export function keepRanges(cuts, duration) {
  const keep = [];
  let start = 0;
  for (const [a, b] of cuts) {
    if (a > start) keep.push([start, a]);
    start = b;
  }
  if (start < duration) keep.push([start, duration]);
  return keep;
}

/** Remove [a, b] from the cut list (restores that audio). */
export function subtractRange(cuts, [a, b]) {
  const out = [];
  for (const [x, y] of cuts) {
    if (y <= a || x >= b) out.push([x, y]);
    else {
      if (x < a) out.push([x, a]);
      if (y > b) out.push([b, y]);
    }
  }
  return out;
}

export const cutSeconds = cuts => cuts.reduce((sum, [a, b]) => sum + b - a, 0);
export const removedBefore = (cuts, t) => cuts.reduce((v, [a, b]) => v + Math.max(0, Math.min(t, b) - a), 0);
/** A word counts as cut when at least half of it is removed. */
export const isWordCut = (cuts, w) => removedBefore(cuts, w.end) - removedBefore(cuts, w.start) >= (w.end - w.start) / 2;
export const overlapsCut = (cuts, a, b) => cuts.some(([x, y]) => x < b && y > a);

/**
 * Where a pause lands for source time t: the end of the cut containing t, otherwise t itself.
 * Call it with the cuts *after* merging, so a pause never lands inside a cut.
 */
export function pauseAnchor(cuts, t, sampleRate) {
  const cut = cuts.find(([a, b]) => a <= t && t < b);
  return frameOf(cut ? cut[1] : t, sampleRate) / sampleRate;
}

/** Drop pauses strictly inside a cut. Compared in sample frames, matching buildPlan. */
export function dropPausesInCuts(pauses, cuts, sampleRate) {
  const f = t => frameOf(t, sampleRate);
  return pauses.filter(p => !cuts.some(([a, b]) => f(a) < f(p.at) && f(p.at) < f(b)));
}

/**
 * Build the edited timeline. Items are audio clips {a, b} (source frames) and silent pauses
 * {pause, a === b === anchor frame}, in playback order, each with an `offset` (edited frames).
 */
export function buildPlan({ duration, sampleRate, cuts = [], pauses = [] }) {
  const f = t => frameOf(t, sampleRate);
  const ranges = keepRanges(cuts, duration).map(([a, b]) => [f(a), f(b)]);
  const gaps = [...pauses]
    .sort((x, y) => x.at - y.at)
    .map(pause => ({ pause, a: f(pause.at), b: f(pause.at), length: f(pause.duration) }));
  const clips = [];
  let g = 0;
  for (const [start, end] of ranges) {
    let a = start;
    while (g < gaps.length && gaps[g].a <= start) g++;
    while (g < gaps.length && gaps[g].a < end) {
      const b = gaps[g++].a;
      if (b > a) clips.push({ a, b, length: b - a });
      a = b;
    }
    if (end > a) clips.push({ a, b: end, length: end - a });
  }
  const items = [...clips, ...gaps].sort((x, y) => x.a - y.a || x.b - y.b);
  let frames = 0;
  for (const item of items) {
    item.offset = frames;
    frames += item.length;
  }
  return { duration, sampleRate, items, frames, editedDuration: frames / sampleRate };
}

/**
 * Source seconds -> edited seconds. A time inside a cut maps to where playback resumes.
 * At a pause anchor, `afterPause` picks the end of the pause instead of its start.
 */
export function toEdited(plan, t, afterPause = false) {
  const sr = plan.sampleRate, frame = frameOf(t, sr);
  for (const item of plan.items) {
    if (frame < item.a || (item.pause && frame === item.a && !afterPause)) return item.offset / sr;
    if (frame < item.b) return (item.offset + frame - item.a) / sr;
  }
  return plan.frames / sr;
}

/** Edited seconds -> source seconds. Inside a pause it returns the pause anchor. */
export function toSource(plan, t) {
  const sr = plan.sampleRate, frame = frameOf(t, sr);
  for (const item of plan.items) {
    if (frame < item.offset + item.length) {
      return (item.a + (item.pause ? 0 : Math.max(0, t * sr - item.offset))) / sr;
    }
  }
  return plan.duration;
}

/** The inserted pause playing at edited time t, if any. */
export function pauseAt(plan, t) {
  const frame = frameOf(t, plan.sampleRate);
  return plan.items.find(item => item.pause && frame >= item.offset && frame < item.offset + item.length)?.pause ?? null;
}

/**
 * Pieces that make up edited time [from, to), in order: audio pieces carry their source start,
 * silence pieces only a duration. `at` is seconds after `from`. Used for playback scheduling.
 */
export function segments(plan, from, to) {
  const sr = plan.sampleRate, out = [];
  for (const item of plan.items) {
    const s = item.offset / sr, e = (item.offset + item.length) / sr;
    const a = Math.max(s, from), b = Math.min(e, to);
    if (b <= a) continue;
    out.push(item.pause
      ? { at: a - from, duration: b - a, silence: true }
      : { at: a - from, source: item.a / sr + (a - s), duration: b - a });
  }
  return out;
}

/** The whole edited timeline as frame-exact pieces for the server renderer. */
export function renderList(plan) {
  return plan.items.map(item => item.pause
    ? { type: "silence", frames: item.length }
    : { type: "audio", start: item.a, end: item.b });
}
