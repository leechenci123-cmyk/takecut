// The editable state of a project and the pure actions that change it.
// Every action returns a new object; the UI records the previous one for undo.

import { joinCuts, cutSeconds, dropPausesInCuts, pauseAnchor, subtractRange, keepRanges } from "./timeline.js";

export const MIN_KEEP_SECONDS = 0.02;
export const MAX_PAUSE_SECONDS = 60;

export const emptyEdits = () => ({ version: 4, cuts: [], pauses: [], splits: [], fixes: {}, ignored: [] });

const finite = x => typeof x === "number" && Number.isFinite(x);

/** Validate edits loaded from disk or an older version. Unknown fields are dropped. */
export function normalizeEdits(raw, duration) {
  const e = emptyEdits();
  if (!raw || typeof raw !== "object") return e;
  e.cuts = joinCuts((Array.isArray(raw.cuts) ? raw.cuts : []).filter(r => Array.isArray(r) && finite(r[0]) && finite(r[1])), duration);
  e.pauses = (Array.isArray(raw.pauses) ? raw.pauses : [])
    .filter(p => p && finite(p.at) && p.at >= 0 && p.at <= duration && finite(p.duration) && p.duration >= 0.01 && p.duration <= MAX_PAUSE_SECONDS)
    .map(p => ({ at: p.at, duration: p.duration }))
    .sort((a, b) => a.at - b.at);
  e.splits = (Array.isArray(raw.splits) ? raw.splits : []).filter(t => finite(t) && t > 0 && t < duration).sort((a, b) => a - b);
  if (raw.fixes && typeof raw.fixes === "object") {
    for (const [k, v] of Object.entries(raw.fixes)) if (/^\d+$/.test(k) && typeof v === "string") e.fixes[k] = v;
  }
  e.ignored = (Array.isArray(raw.ignored) ? raw.ignored : []).filter(k => typeof k === "string");
  return e;
}

/**
 * Cut `ranges`. With `replacement` ({end, duration}) a pause of that length is inserted where
 * the cut closes; its anchor is computed after merging, so it never falls inside a cut.
 * Returns {edits} or {error: "nothing-left"}.
 */
export function applyCut(edits, ranges, { duration, sampleRate }, replacement) {
  const cuts = joinCuts(edits.cuts.concat(ranges), duration);
  if (duration - cutSeconds(cuts) < MIN_KEEP_SECONDS) return { error: "nothing-left" };
  let pauses = dropPausesInCuts(edits.pauses, cuts, sampleRate);
  if (replacement && replacement.duration > 0) {
    pauses = withPause(pauses, { at: pauseAnchor(cuts, replacement.end, sampleRate), duration: replacement.duration });
  }
  return { edits: { ...edits, cuts, pauses } };
}

/** Bring back the audio in [a, b]. */
export function restoreRange(edits, range) {
  return { ...edits, cuts: subtractRange(edits.cuts, range) };
}

const withPause = (pauses, pause) => [...pauses.filter(p => p.at !== pause.at), pause].sort((a, b) => a.at - b.at);

/** Insert or resize the pause at source time `at` (already anchored). duration <= 0 removes it. */
export function setPause(edits, at, duration) {
  if (!(duration > 0)) return { ...edits, pauses: edits.pauses.filter(p => p.at !== at) };
  return { ...edits, pauses: withPause(edits.pauses, { at, duration: Math.min(MAX_PAUSE_SECONDS, duration) }) };
}

/** True when t is inside a kept range, away from its edges and existing splits. */
export function canSplit(edits, t, duration, edge = 0.001) {
  return keepRanges(edits.cuts, duration).some(([a, b]) => t > a + edge && t < b - edge) &&
    !edits.splits.some(s => Math.abs(s - t) < edge);
}

export function addSplit(edits, t) {
  return { ...edits, splits: [...edits.splits, t].sort((a, b) => a - b) };
}

/** Correct the text of word i (subtitles only). Passing the original text clears the fix. */
export function fixWord(edits, i, text, original) {
  const fixes = { ...edits.fixes };
  if (text === original || text == null) delete fixes[i];
  else fixes[i] = text;
  return { ...edits, fixes };
}

export function ignoreSuggestion(edits, key) {
  return edits.ignored.includes(key) ? edits : { ...edits, ignored: [...edits.ignored, key] };
}

export function unignoreSuggestion(edits, key) {
  return { ...edits, ignored: edits.ignored.filter(k => k !== key) };
}
