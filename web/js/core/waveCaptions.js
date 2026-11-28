// Synced caption geometry for the waveform dock: maps recognized words and transcript lines onto
// either the edited or source timeline axis, supports word search, and lays out non-overlapping labels.
// Pure functions, no DOM: covered by tests/js/waveCaptions.test.js.

import { cutFlags, toEdited } from "./timeline.js";
import { wordText, joinWords, normalize } from "./text.js";

/**
 * Project words and lines onto the active waveform axis ("edited" or "source").
 * In "edited" mode, cut words are omitted and kept words/lines use edited-timeline seconds.
 * In "source" mode, every word/line uses source seconds and carries a `cut` flag.
 */
export function buildWaveCaptions(words, lines, edits, plan, mode = "edited") {
  const cut = cutFlags(edits.cuts, words);
  const fixes = edits.fixes ?? {};
  const lineOf = new Array(words.length).fill(-1);
  for (const line of lines) for (const i of line.ids) lineOf[i] = line.index;

  const capWords = [];
  for (let i = 0; i < words.length; i++) {
    const isCut = cut[i];
    if (mode === "edited" && isCut) continue;
    const raw = wordText(words, fixes, i);
    const text = raw.trim();
    if (!text) continue;
    const w = words[i];
    const start = mode === "edited" ? toEdited(plan, w.start, true) : w.start;
    const end = mode === "edited" ? Math.max(start, toEdited(plan, w.end)) : w.end;
    capWords.push({
      index: i,
      text,
      start,
      end,
      sourceStart: w.start,
      sourceEnd: w.end,
      cut: isCut,
      line: lineOf[i],
    });
  }

  const capLines = [];
  for (const line of lines) {
    const ids = mode === "edited" ? line.ids.filter(i => !cut[i]) : line.ids;
    if (!ids.length) continue;
    const text = joinWords(ids.map(i => wordText(words, fixes, i)));
    if (!text) continue;
    const first = words[ids[0]], last = words[ids.at(-1)];
    const start = mode === "edited" ? toEdited(plan, first.start, true) : first.start;
    const end = mode === "edited" ? Math.max(start, toEdited(plan, last.end)) : last.end;
    capLines.push({
      index: line.index,
      text,
      start,
      end,
      sourceStart: first.start,
      sourceEnd: last.end,
      cut: line.ids.every(i => cut[i]),
      ids,
    });
  }

  return { words: capWords, lines: capLines };
}

/** Find the caption word covering axis time `t` (with a small edge tolerance). */
export function wordAtAxisTime(capWords, t, tolerance = 0.02) {
  if (!capWords.length) return null;
  let lo = 0, hi = capWords.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (capWords[mid].end < t - tolerance) lo = mid + 1;
    else hi = mid;
  }
  if (lo < capWords.length) {
    const w = capWords[lo];
    if (t >= w.start - tolerance && t <= w.end + tolerance) return w;
  }
  return null;
}

/** Find the caption line covering axis time `t` (or just before it within `grace` seconds). */
export function lineAtAxisTime(capLines, t, grace = 0.2) {
  if (!capLines.length) return null;
  let candidate = null;
  for (const line of capLines) {
    if (t >= line.start - 0.02 && t <= line.end + 0.02) return line;
    if (line.start <= t && t - line.end <= grace) candidate = line;
    if (line.start > t + 0.02) break;
  }
  return candidate;
}

/**
 * Find caption words matching `query` (supports single-word or multi-word substring search
 * across normalized text, case-insensitive, CJK and Latin).
 */
export function findMatchingWords(capWords, query) {
  const raw = String(query ?? "").trim().toLowerCase();
  const norm = normalize(raw);
  if (!raw && !norm) return [];
  return capWords.filter(w => {
    const lower = w.text.toLowerCase();
    if (lower.includes(raw)) return true;
    const wn = normalize(w.text);
    return Boolean(norm && wn && wn.includes(norm));
  });
}

/**
 * Select which visible caption words get text labels drawn so labels never overlap.
 * Priority word indices (active playhead word, hovered word, selected or matched words)
 * are placed first so the word the user cares about is never hidden when zoomed out.
 */
export function layoutWordLabels(visibleWords, measure, minGap = 4, priorityIds = new Set()) {
  const placed = [];
  const fits = (left, right) => placed.every(p => right + minGap <= p.left || left >= p.right + minGap);

  const ordered = [
    ...visibleWords.filter(w => priorityIds.has(w.index)),
    ...visibleWords.filter(w => !priorityIds.has(w.index)),
  ];

  for (const w of ordered) {
    const box = measure(w);
    if (!box || box.right <= box.left) continue;
    if (fits(box.left, box.right)) placed.push({ word: w, ...box });
  }
  return placed.sort((a, b) => a.left - b.left);
}
