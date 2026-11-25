// Group recognized words into transcript lines (sentences or clauses).

import { endsSentence, endsClause, scriptOf, joinWords } from "./text.js";

/**
 * A new line starts after sentence punctuation, after a gap over 0.9 s, after a clause once the
 * line is long, or when the line gets too long. Limits are in characters and depend on the script.
 */
export function splitLines(words, script = scriptOf(words)) {
  const soft = script === "cjk" ? 30 : 60, hard = script === "cjk" ? 65 : 130;
  const lines = [];
  let line = null, length = 0;
  words.forEach((w, i) => {
    const prev = words[i - 1];
    if (!line || endsSentence(prev.text) || w.start - prev.end > 0.9 ||
        (length > soft && endsClause(prev.text)) || length >= hard) {
      line = { index: lines.length, start: w.start, end: w.end, ids: [] };
      lines.push(line);
      length = 0;
    }
    length += w.text.length;
    line.end = w.end;
    line.ids.push(i);
  });
  for (const l of lines) l.text = joinWords(l.ids.map(i => words[i].text));
  return lines;
}

/** lineOf[wordIndex] -> line index */
export function lineIndex(lines, count) {
  const lineOf = new Array(count).fill(-1);
  for (const l of lines) for (const i of l.ids) lineOf[i] = l.index;
  return lineOf;
}
