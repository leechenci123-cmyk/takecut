// Subtitles that follow the edit: cut words disappear, times move to the edited timeline, cues
// split at inserted pauses, and manual text fixes are used. SRT, WebVTT and plain text.

import { isWordCut, toEdited } from "./timeline.js";
import { wordText, joinWords, endsClause, endsSentence } from "./text.js";

const pad = (n, w = 2) => String(n).padStart(w, "0");

function clock(sec, sep) {
  const ms = Math.max(0, Math.round(sec * 1000));
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}${sep}${pad(ms % 1000, 3)}`;
}
export const srtTime = sec => clock(sec, ",");
export const vttTime = sec => clock(sec, ".");

/**
 * Chinese subtitle style: commas and full stops become spaces and the cue has no end period.
 * Keeps ？！ and quotes. Whisper often writes ASCII commas in Chinese text, so those count too
 * when they follow a Han character. Latin text only loses its final period.
 */
export function stripPunctuation(text) {
  return text
    .replace(/[，、；：。．…]+/g, " ")
    .replace(/(?<=\p{Script=Han})[,;:.]+/gu, " ")
    .replace(/\.+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Split word list `ids` so each cue's text is at most maxChars, preferring clause boundaries. */
function splitLong(ids, words, fixes, maxChars) {
  const text = list => joinWords(list.map(i => wordText(words, fixes, i)));
  if (!maxChars || text(ids).length <= maxChars || ids.length < 2) return [ids];
  let best = -1, bestScore = Infinity;
  for (let k = 1; k < ids.length; k++) {
    const left = text(ids.slice(0, k)).length;
    if (left > maxChars) break;
    const right = text(ids.slice(k)).length;
    const clause = endsClause(wordText(words, fixes, ids[k - 1])) || endsSentence(wordText(words, fixes, ids[k - 1]));
    const score = Math.abs(left - right) - (clause ? maxChars : 0);
    if (score < bestScore) { bestScore = score; best = k; }
  }
  if (best < 1) best = 1;
  return [...splitLong(ids.slice(0, best), words, fixes, maxChars), ...splitLong(ids.slice(best), words, fixes, maxChars)];
}

/**
 * Cues for the edited audio. Each transcript line becomes one cue, split where an inserted pause
 * sits between two words and, with maxChars, where the line is too long.
 */
export function buildCues(words, lines, edits, plan, { maxChars = 0, strip = false } = {}) {
  const cues = [];
  const add = ids => {
    for (const part of splitLong(ids, words, edits.fixes, maxChars)) {
      if (!part.length) continue;
      const start = toEdited(plan, words[part[0]].start, true);
      const end = toEdited(plan, words[part.at(-1)].end);
      if (srtTime(start) === srtTime(end)) continue;
      let text = joinWords(part.map(i => wordText(words, edits.fixes, i)));
      if (strip) text = stripPunctuation(text);
      if (text) cues.push({ start, end, text, words: part });
    }
  };
  for (const line of lines) {
    let ids = [];
    for (const i of line.ids) {
      const w = words[i], prev = ids.length ? words[ids.at(-1)] : null;
      if (isWordCut(edits.cuts, w)) continue;
      if (prev && edits.pauses.some(p => p.at > prev.start && p.at <= w.start)) {
        add(ids);
        ids = [];
      }
      ids.push(i);
    }
    add(ids);
  }
  return cues;
}

export const toSRT = cues => cues.map((c, k) => `${k + 1}\r\n${srtTime(c.start)} --> ${srtTime(c.end)}\r\n${c.text}`).join("\r\n\r\n") + "\r\n";
export const toVTT = cues => "WEBVTT\n\n" + cues.map(c => `${vttTime(c.start)} --> ${vttTime(c.end)}\n${c.text}`).join("\n\n") + "\n";

/** The kept transcript as plain text, one line per transcript line. */
export function toTXT(words, lines, edits) {
  return lines
    .map(line => joinWords(line.ids.filter(i => !isWordCut(edits.cuts, words[i])).map(i => wordText(words, edits.fixes, i))))
    .filter(Boolean)
    .join("\n") + "\n";
}
