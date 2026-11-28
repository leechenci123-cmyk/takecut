// The open project: its transcript, edits, suggestions, playback and every action the editor UI
// can take. UI modules subscribe with S.on(event, fn):
//   "edits"      edits, plan or suggestions changed      "selection"  selection changed
//   "playhead"   playhead moved (every frame while playing)  "play"   playback started or stopped
//   "history"    undo / redo availability                 "save"       autosave state
//   "focus"      a suggestion was focused                 "pause"      selected pause changed
//   "prefs" / "view"

import { buildPlan, toEdited, toSource, cutSeconds, cutFlags, pauseAnchor, pauseAt, renderList, removedBefore } from "../core/timeline.js";
import { applyCut, restoreRange, setPause, fixWord, ignoreSuggestion, unignoreSuggestion, normalizeEdits, addSplit, canSplit } from "../core/edits.js";
import { createHistory } from "../core/history.js";
import { splitLines, lineIndex } from "../core/lines.js";
import { scriptOf, normalize } from "../core/text.js";
import { staticSuggestions, pauseSuggestions, statusOf, rangesFor } from "../core/suggest/index.js";
import { DEFAULT_THRESHOLD, DEFAULT_TARGET } from "../core/suggest/pauses.js";
import { snapWordRange, quietestPoint } from "../core/snap.js";
import { api } from "../api.js";
import { t } from "../i18n.js";
import { toast } from "./overlay.js";
import { secs, debounce } from "./dom.js";

const PREFS_KEY = "takecut.editor";

function loadPrefs() {
  const base = { threshold: DEFAULT_THRESHOLD, target: DEFAULT_TARGET, showCut: true, showCaptions: true, follow: true, mode: "edited", tab: "cleanup", collapsed: [] };
  try { return { ...base, ...JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") }; } catch { return base; }
}

export function createSession(data, engine) {
  const { project, words, analysis } = data;
  const listeners = {};
  const S = {
    id: project.id, project, words, analysis, engine,
    duration: engine.buffer.duration, sampleRate: engine.buffer.sampleRate,
    script: scriptOf(words), history: createHistory(),
    selection: null, playhead: 0, cursorSource: 0, focus: null, selectedPause: null, lastJoin: null,
    prefs: loadPrefs(), saveState: "saved", playing: null, version: 0,
    view: { zoom: 1, start: 0 },
    on(event, fn) { (listeners[event] ??= new Set()).add(fn); return () => listeners[event].delete(fn); },
    emit(event, payload) { for (const fn of [...(listeners[event] ?? [])]) fn(payload); },
  };
  S.lines = splitLines(words, S.script);
  S.lineOf = lineIndex(S.lines, words.length);
  S.edits = normalizeEdits(data.edits, S.duration);
  S.statics = staticSuggestions({ words, lines: S.lines, lineOf: S.lineOf, script: S.script, duration: S.duration, analysis });
  const ctx = () => ({ duration: S.duration, sampleRate: S.sampleRate });

  function rebuild() {
    S.plan = buildPlan({ duration: S.duration, sampleRate: S.sampleRate, cuts: S.edits.cuts, pauses: S.edits.pauses });
    S.cutWords = cutFlags(S.edits.cuts, words);
    S.pauseSugs = pauseSuggestions(words, S.edits, {
      duration: S.duration, threshold: S.prefs.threshold, target: S.prefs.target, silences: analysis?.silences ?? null,
    });
    S.version++;
  }
  rebuild();

  let cached = null;
  /** Every suggestion with its status ("open", "done", "ignored"), in time order. */
  S.suggestions = () => {
    if (cached?.version === S.version) return cached.list;
    const list = [...S.statics, ...S.pauseSugs]
      .map(s => ({ s, status: s.category === "pauses" ? (S.edits.ignored.includes(s.key) ? "ignored" : "open") : statusOf(s, S.edits, S.lines, words) }))
      .sort((a, b) => a.s.start - b.s.start);
    cached = { version: S.version, list };
    return list;
  };
  S.isCut = i => S.cutWords[i];
  S.cutSeconds = () => cutSeconds(S.edits.cuts);

  // ---- edits ------------------------------------------------------------------------------
  function setEdits(next, { record = true } = {}) {
    const source = toSource(S.plan, S.playhead);
    S.stop();
    if (record) S.history.record(S.edits);
    S.edits = next;
    rebuild();
    S.playhead = Math.min(S.plan.editedDuration, toEdited(S.plan, source));
    S.cursorSource = toSource(S.plan, S.playhead);
    S.emit("edits");
    S.emit("history");
    S.emit("playhead");
    scheduleSave();
  }

  const undoAction = () => ({ action: t("toast.undo"), onAction: S.undo });

  /** Cut ranges (source seconds). `message(sec)` customizes the toast. */
  S.cut = (ranges, { message, replacement } = {}) => {
    if (!ranges.length) return false;
    const res = applyCut(S.edits, ranges, ctx(), replacement);
    if (res.error) {
      toast(t("err." + res.error), { error: true });
      return false;
    }
    const before = cutSeconds(S.edits.cuts);
    S.lastJoin = Math.min(...ranges.map(r => r[0]));
    setEdits(res.edits);
    const sec = secs(Math.max(0, cutSeconds(S.edits.cuts) - before));
    toast(message ? message(sec) : t("toast.cut", { sec }), undoAction());
    return true;
  };

  S.undo = () => {
    const prev = S.history.undo(S.edits);
    if (!prev) return toast(t("toast.nothingToUndo"));
    setEdits(prev, { record: false });
    toast(t("toast.undone"));
  };
  S.redo = () => {
    const next = S.history.redo(S.edits);
    if (!next) return toast(t("toast.nothingToRedo"));
    setEdits(next, { record: false });
    toast(t("toast.redone"));
  };

  // ---- selection --------------------------------------------------------------------------
  S.select = (lo, hi, range = null) => {
    S.selection = hi - lo > 0.001 ? { lo, hi, words: range } : null;
    S.emit("selection");
  };
  S.selectWords = (a, b) => {
    const [i, j] = a <= b ? [a, b] : [b, a];
    S.select(words[i].start, words[j].end, [i, j]);
  };
  S.clearSelection = () => {
    const hadMarks = S.marks.in != null || S.marks.out != null;
    S.marks = { in: null, out: null };
    if (!S.selection && !hadMarks) return;
    S.selection = null;
    S.emit("selection");
  };
  /** Fraction of the selection already cut. */
  S.selectionCutRatio = () => {
    const sel = S.selection;
    if (!sel) return 0;
    return (removedBefore(S.edits.cuts, sel.hi) - removedBefore(S.edits.cuts, sel.lo)) / (sel.hi - sel.lo);
  };
  const selectionRange = () => {
    const sel = S.selection;
    return sel.words ? snapWordRange(words, analysis, sel.words[0], sel.words[1]) : [sel.lo, sel.hi];
  };
  S.cutSelection = () => {
    if (S.selection && S.cut([selectionRange()])) S.clearSelection();
  };
  S.restoreSelection = () => {
    const sel = S.selection;
    if (!sel) return;
    const range = sel.words ? [Math.min(sel.lo, selectionRange()[0]), Math.max(sel.hi, selectionRange()[1])] : [sel.lo, sel.hi];
    setEdits(restoreRange(S.edits, range));
    toast(t("toast.restored"), undoAction());
  };
  S.replaceSelectionWithPause = duration => {
    if (!S.selection) return toast(t("pause.needSelection"));
    const range = selectionRange();
    if (S.cut([range], { replacement: { end: range[1], duration }, message: () => t("toast.pauseSet", { d: secs(duration, 2) }) })) {
      S.clearSelection();
      S.selectPause(S.edits.pauses.find(p => Math.abs(p.at - pauseAnchor(S.edits.cuts, range[1], S.sampleRate)) < 1e-6)?.at ?? null);
    }
  };
  /** I / O marks at the playhead (source time); a selection appears once both are set in order. */
  S.marks = { in: null, out: null };
  const applyMarks = () => {
    const { in: a, out: b } = S.marks;
    if (a != null && b != null && b - a > 0.001) S.select(a, b);
    else { S.selection = null; S.emit("selection"); }
  };
  S.markIn = () => {
    S.marks.in = S.cursorSource;
    if (S.marks.out != null && S.marks.out <= S.marks.in) S.marks.out = null;
    applyMarks();
  };
  S.markOut = () => {
    S.marks.out = S.cursorSource;
    if (S.marks.in != null && S.marks.in >= S.marks.out) S.marks.in = null;
    applyMarks();
  };

  // ---- pauses, splits, fixes ----------------------------------------------------------------
  S.setPause = (at, duration) => {
    setEdits(setPause(S.edits, at, duration));
    S.lastJoin = at;
    toast(duration > 0 ? t("toast.pauseSet", { d: secs(duration, 2) }) : t("toast.pauseRemoved"), undoAction());
    if (!(duration > 0) && S.selectedPause === at) S.selectPause(null);
  };
  S.insertPause = duration => {
    const existing = pauseAt(S.plan, S.playhead);
    // Land in the quietest spot near the playhead so a pause never splits a word.
    const src = toSource(S.plan, S.playhead);
    const at = existing ? existing.at : pauseAnchor(S.edits.cuts, quietestPoint(analysis, src, Math.max(0, src - 0.12), Math.min(S.duration, src + 0.12)), S.sampleRate);
    S.setPause(at, duration);
    S.selectPause(at);
  };
  S.selectPause = at => {
    S.selectedPause = at;
    S.emit("pause");
  };
  S.split = () => {
    const at = toSource(S.plan, S.playhead);
    if (!canSplit(S.edits, at, S.duration)) return toast(t("toast.cantSplit"));
    setEdits(addSplit(S.edits, at));
    toast(t("toast.split"), undoAction());
  };
  S.fixWord = (i, text) => {
    const leading = /^\s*/.exec(words[i].text)[0];
    const value = text.trim() ? (S.script === "latin" ? leading : "") + text.trim() : words[i].text;
    setEdits(fixWord(S.edits, i, value, words[i].text));
    toast(t("toast.fixed"), undoAction());
  };
  /** Words whose original text matches word i (for "replace all"). */
  S.sameWords = i => {
    const key = normalize(words[i].text);
    return key ? words.map((w, k) => (normalize(w.text) === key ? k : -1)).filter(k => k >= 0) : [i];
  };
  S.fixAll = (i, text) => {
    let next = S.edits;
    const ids = S.sameWords(i);
    for (const k of ids) {
      const leading = /^\s*/.exec(words[k].text)[0];
      next = fixWord(next, k, (S.script === "latin" ? leading : "") + text.trim(), words[k].text);
    }
    setEdits(next);
    toast(t("toast.fixedAll", { n: ids.length }), undoAction());
  };
  /** Replace the subtitle text of words i..j with one phrase (e.g. "Take Cut" -> "Takecut"). */
  S.fixRange = (i, j, text) => {
    if (i === j) return S.fixWord(i, text);
    if (!text.trim()) return;
    const leading = S.script === "latin" ? /^\s*/.exec(words[i].text)[0] : "";
    let next = fixWord(S.edits, i, leading + text.trim(), words[i].text);
    for (let k = i + 1; k <= j; k++) next = fixWord(next, k, "", words[k].text);
    setEdits(next);
    toast(t("toast.fixed"), undoAction());
  };
  /** Restore word i's original text, and any words blanked by a phrase fix right after it. */
  S.resetFix = i => {
    let next = fixWord(S.edits, i, words[i].text, words[i].text);
    for (let k = i + 1; k < words.length && next.fixes[k] === ""; k++) next = fixWord(next, k, words[k].text, words[k].text);
    setEdits(next);
    toast(t("toast.restored"), undoAction());
  };

  // ---- suggestions ---------------------------------------------------------------------------
  S.apply = (s, pick) => {
    const ranges = rangesFor(s, pick);
    const n = (pick ?? s.recommended ?? 0) + 1;
    S.cut(ranges, { message: s.type === "retake" ? sec => t("clean.appliedRetake", { n, sec }) : undefined });
  };
  S.ignore = s => {
    setEdits(ignoreSuggestion(S.edits, s.key));
    toast(t("toast.ignored"), undoAction());
  };
  S.unignore = s => setEdits(unignoreSuggestion(S.edits, s.key));
  S.applyCategory = category => {
    let list = S.suggestions().filter(x => x.status === "open" && x.s.category === category).map(x => x.s);
    if (category === "fillers") list = list.filter(s => s.strength === "strong");
    if (!list.length) return;
    S.cut(list.flatMap(s => rangesFor(s)), { message: sec => t("clean.appliedCount", { n: list.length, sec }) });
  };
  /** Everything the panel would recommend, as one undoable step. "Maybe" fillers are left for review. */
  S.recommended = () => S.suggestions()
    .filter(x => x.status === "open" && !(x.s.category === "fillers" && x.s.strength !== "strong"))
    .map(x => x.s);
  S.applyAll = () => {
    const list = S.recommended();
    if (!list.length) return;
    S.cut(list.flatMap(s => rangesFor(s)), { message: sec => t("clean.appliedCount", { n: list.length, sec }) });
  };
  S.focusSuggestion = s => {
    S.focus = s?.key ?? null;
    S.emit("focus", s);
    if (s) S.seekSource(s.start);
  };

  // ---- playback -------------------------------------------------------------------------------
  let raf = 0;
  function follow() {
    const run = engine.run, pos = engine.position();
    if (!run || pos == null) return;
    if (run.kind === "edited") {
      S.playhead = pos;
      S.cursorSource = toSource(S.plan, pos);
    } else {
      S.cursorSource = pos;
      S.playhead = toEdited(S.plan, pos);
    }
  }
  function tick() {
    cancelAnimationFrame(raf);
    const step = () => {
      if (!engine.playing) return;
      follow();
      S.emit("playhead");
      raf = requestAnimationFrame(step);
    };
    step();
  }
  engine.onended = run => {
    cancelAnimationFrame(raf);
    if (run.kind === "edited") {
      S.playhead = run.to;
      S.cursorSource = toSource(S.plan, run.to);
    } else {
      S.cursorSource = run.to;
    }
    S.playing = null;
    S.emit("play");
    S.emit("playhead");
  };
  async function start(promise, kind, tag) {
    if (!(await promise)) return;
    S.playing = { kind, tag };
    S.emit("play");
    tick();
  }
  S.stop = () => {
    if (!engine.playing) return;
    follow();
    engine.stop();
    cancelAnimationFrame(raf);
    S.playing = null;
    S.emit("play");
    S.emit("playhead");
  };
  S.playEdited = (from, to, tag = "transport", loop = false) => start(engine.playEdited(S.plan, from, to, { tag, loop }), "edited", tag);
  S.playSource = (a, b, tag = "source") => start(engine.playSource(a, b, { tag }), "source", tag);
  S.toggle = () => {
    if (engine.playing) return S.stop();
    const from = S.playhead >= S.plan.editedDuration - 0.02 ? 0 : S.playhead;
    S.playEdited(from, S.plan.editedDuration);
  };
  /** Play source [a, b]: through the edit when it is mostly kept, as recorded when it is mostly cut. */
  S.playRange = (a, b, tag) => {
    const cutRatio = (removedBefore(S.edits.cuts, b) - removedBefore(S.edits.cuts, a)) / Math.max(1e-6, b - a);
    if (cutRatio > 0.5) return S.playSource(a, b, tag);
    return S.playEdited(toEdited(S.plan, a, true), toEdited(S.plan, b), tag);
  };
  S.playWord = i => S.playRange(words[i].start, Math.min(S.duration, words[i].end + 0.4), "word");
  S.playLine = line => S.playRange(line.start, line.end, "line");
  S.playSelection = () => S.selection && S.playRange(S.selection.lo, S.selection.hi, "selection");
  S.playAroundJoin = () => {
    const at = S.lastJoin ?? S.edits.cuts.at(-1)?.[0];
    if (at == null) return;
    S.playEdited(Math.max(0, toEdited(S.plan, at) - 1.5), toEdited(S.plan, at, true) + 2, "join");
  };
  S.loopPause = at => {
    if (S.playing?.tag === "pause") return S.stop();
    S.playEdited(Math.max(0, toEdited(S.plan, at) - 1), Math.min(S.plan.editedDuration, toEdited(S.plan, at, true) + 1), "pause", true);
  };
  S.preview = (a, b, tag = "preview") => S.playSource(Math.max(0, a), Math.min(S.duration, b), tag);

  S.seekEdited = t => {
    const wasPlaying = engine.playing && S.playing?.tag === "transport";
    S.stop();
    S.playhead = Math.max(0, Math.min(S.plan.editedDuration, t));
    S.cursorSource = toSource(S.plan, S.playhead);
    S.emit("playhead");
    if (wasPlaying) S.playEdited(S.playhead, S.plan.editedDuration);
  };
  S.seekSource = t => S.seekEdited(toEdited(S.plan, t));
  S.nudge = delta => S.seekEdited(S.playhead + delta);
  S.jumpWord = dir => {
    const at = S.cursorSource;
    const order = dir > 0 ? words.keys() : [...words.keys()].reverse();
    for (const i of order) {
      if (S.isCut(i)) continue;
      if (dir > 0 ? words[i].start > at + 0.01 : words[i].start < at - 0.01) return S.seekSource(words[i].start);
    }
  };

  // ---- preferences, saving ------------------------------------------------------------------
  S.setPref = (key, value) => {
    S.prefs[key] = value;
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(S.prefs)); } catch { /* storage blocked */ }
    if (key === "threshold" || key === "target") {
      rebuild();
      S.emit("edits");
    } else S.emit("prefs", key);
  };
  S.setView = partial => {
    Object.assign(S.view, partial);
    S.emit("view");
  };

  const stats = () => ({ editedDuration: +S.plan.editedDuration.toFixed(3), cutSeconds: +cutSeconds(S.edits.cuts).toFixed(3) });
  const save = debounce(async () => {
    try {
      await api.saveEdits(S.id, S.edits, stats());
      S.saveState = "saved";
    } catch {
      S.saveState = "failed";
      setTimeout(() => S.saveState === "failed" && save(), 3000);
    }
    S.emit("save");
  }, 600);
  function scheduleSave() {
    S.saveState = "saving";
    S.emit("save");
    save();
  }
  S.flush = () => {
    if (S.saveState === "saved") return;
    save.cancel();
    api.saveEditsKeepalive(S.id, S.edits, stats());
  };
  S.renderList = () => renderList(S.plan);
  S.toEdited = (t, after) => toEdited(S.plan, t, after);
  S.toSource = t => toSource(S.plan, t);

  return S;
}
