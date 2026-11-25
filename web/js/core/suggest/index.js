// Collects every suggestion type and decides which ones are still open for the current edits.

import { findRetakes, findRestarts, keepTakeRanges } from "./retakes.js";
import { findStutters } from "./stutters.js";
import { findFillers, findUnrecognized } from "./fillers.js";
import { findLongPauses } from "./pauses.js";
import { removedBefore, isWordCut } from "../timeline.js";

export const CATEGORIES = ["retakes", "stutters", "fillers", "pauses"];

/** Suggestions that depend only on the transcript (computed once per project). */
export function staticSuggestions({ words, lines, lineOf, script, duration, analysis }) {
  return [
    ...findRetakes(lines, script),
    ...findRestarts(words, lines, script),
    ...findStutters(words, script),
    ...findFillers(words, lines, lineOf, script, duration),
    ...findUnrecognized(words, analysis?.sounds),
  ].sort((a, b) => a.start - b.start);
}

/** Pause suggestions depend on the current cuts, so they are rebuilt after each edit. */
export function pauseSuggestions(words, edits, options) {
  return findLongPauses(words, edits, options);
}

const covered = (cuts, [a, b]) => b > a && (removedBefore(cuts, b) - removedBefore(cuts, a)) / (b - a) >= 0.5;

/** "open", "done" (already applied by any means) or "ignored". */
export function statusOf(s, edits, lines, words) {
  if (edits.ignored.includes(s.key)) return "ignored";
  if (s.type === "retake") {
    const cutTakes = s.takes.filter(t => {
      const ids = lines[t.line].ids;
      return ids.filter(i => isWordCut(edits.cuts, words[i])).length >= ids.length / 2;
    }).length;
    return cutTakes >= s.takes.length - 1 ? "done" : "open";
  }
  return s.ranges.every(r => covered(edits.cuts, r)) ? "done" : "open";
}

/** Ranges that applying `s` cuts. For a retake, `pick` is the take to keep. */
export function rangesFor(s, pick = s.recommended) {
  return s.type === "retake" ? keepTakeRanges(s, pick) : s.ranges;
}
