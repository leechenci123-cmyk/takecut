// Text helpers shared by the transcript, suggestions and subtitles. No DOM access.

const NON_WORD = /[^\p{L}\p{N}]/gu;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** Letters and digits only, lower-cased: "我，" -> "我", " The" -> "the". */
export const normalize = s => String(s ?? "").replace(NON_WORD, "").toLowerCase();

export const hasCJK = s => CJK.test(String(s ?? ""));

/** "cjk" when most recognized words are Chinese/Japanese/Korean, otherwise "latin". */
export function scriptOf(words) {
  let cjk = 0, total = 0;
  for (const w of words) {
    const t = normalize(w.text);
    if (!t) continue;
    total++;
    if (hasCJK(t)) cjk++;
  }
  return total && cjk / total >= 0.5 ? "cjk" : "latin";
}

const CLOSERS = "[\"”’」』）)]?";
const SENTENCE_END = new RegExp(`[。！？.!?…]${CLOSERS}$`);
const CLAUSE_END = new RegExp(`[，,、；;：:]${CLOSERS}$`);

export const endsSentence = s => SENTENCE_END.test(String(s ?? "").trim());
export const endsClause = s => CLAUSE_END.test(String(s ?? "").trim());

/** Comparable units of a line: characters for CJK text, words for Latin text. */
export function tokensOf(text, script) {
  if (script === "cjk") return Array.from(normalize(text));
  return String(text ?? "").split(/\s+/).map(normalize).filter(Boolean);
}

/** The text shown for word i, after any manual correction. */
export const wordText = (words, fixes, i) => (fixes && Object.hasOwn(fixes, i) ? fixes[i] : words[i].text);

/** Join word texts into display text; Whisper puts leading spaces on Latin words. */
export const joinWords = texts => texts.join("").replace(/\s+/g, " ").trim();
