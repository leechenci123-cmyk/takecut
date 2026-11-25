// Transcript: click a word to hear it, drag or shift-click to select, double-click to fix text.
// Cut words are struck through, open suggestions are tinted, retakes are grouped.

import { h, button, short, secs } from "./dom.js";
import { icon } from "./icons.js";
import { t } from "../i18n.js";
import { wordText } from "../core/text.js";

const BANNER_KEY = "takecut.banner.dismissed";

export function createTranscript(S, scroll) {
  let wordEls = [], active = -1, anchor = null, toolbar = null, fixer = null;
  const offs = [
    S.on("edits", render),
    S.on("selection", updateSelection),
    S.on("playhead", updateActive),
    S.on("focus", focus),
    S.on("prefs", key => key === "showCut" && scroll.classList.toggle("hide-cut", !S.prefs.showCut)),
  ];
  scroll.addEventListener("mouseup", onMouseUp);
  scroll.addEventListener("click", onClick);
  scroll.addEventListener("dblclick", onDblClick);
  render();

  function render() {
    closeFixer();
    wordEls = new Array(S.words.length);
    active = -1;
    const frag = document.createDocumentFragment();
    const banner = sampleBanner();
    if (banner) frag.append(banner);
    if (!S.words.length) {
      frag.append(h("div", { class: "status-card" }, icon("info"), t("editor.noWords")));
      scroll.replaceChildren(frag);
      return;
    }
    const marks = new Map(), groups = new Map();
    for (const { s, status } of S.suggestions()) {
      if (s.type === "retake") {
        for (const take of s.takes) groups.set(take.line, { s, status });
        continue;
      }
      if (status !== "open" || !s.words) continue;
      const cls = { filler: "s-filler", stutter: "s-stutter", restart: "s-restart" }[s.type];
      for (const i of s.type === "stutter" ? s.words.slice(0, -1) : s.words) marks.set(i, cls);
    }
    const pausesBefore = new Map(), trailing = [];
    for (const p of S.edits.pauses) {
      const k = S.words.findIndex((w, i) => w.start >= p.at - 0.01 && !S.isCut(i));
      if (k < 0) trailing.push(p);
      else pausesBefore.set(k, [...(pausesBefore.get(k) ?? []), p]);
    }
    let groupKey = null, groupEl = null;
    for (const line of S.lines) {
      const g = groups.get(line.index) ?? null;
      if (g && g.s.key !== groupKey) {
        groupKey = g.s.key;
        groupEl = h("div", { class: "take-group" + (g.status === "open" ? "" : " done"), dataset: { key: g.s.key } },
          h("div", { class: "take-head" },
            h("span", { class: "badge retake" }, icon("repeat"), `${t("clean.retakes")} · ${g.s.takes.length}`),
            g.status === "open" ? h("span", null, t("clean.keysHint")) : h("span", { class: "badge" }, t(g.status === "ignored" ? "clean.ignored" : "clean.done"))));
        frag.append(groupEl);
      } else if (!g) {
        groupKey = null;
        groupEl = null;
      }
      (groupEl ?? frag).append(lineRow(line, g, marks, pausesBefore));
    }
    if (trailing.length) frag.lastChild.querySelector?.(".words")?.append(...trailing.map(pausePill));
    scroll.replaceChildren(frag);
    scroll.classList.toggle("hide-cut", !S.prefs.showCut);
    updateSelection();
    updateActive();
  }

  function sampleBanner() {
    if (!S.project.sample) return null;
    try { if (localStorage.getItem(BANNER_KEY)) return null; } catch { /* storage blocked */ }
    const el = h("div", { class: "banner" }, icon("sparkle"), h("span", null, t("editor.sampleBanner")),
      button(t("editor.dismiss"), { class: "small", onclick: () => { try { localStorage.setItem(BANNER_KEY, "1"); } catch { /* blocked */ } el.remove(); } }));
    return el;
  }

  function pausePill(p) {
    return h("button", {
      type: "button", class: "pause-pill" + (S.selectedPause === p.at ? " selected" : ""), title: t("tab.pauses"),
      onclick: e => { e.stopPropagation(); S.selectPause(p.at); S.seekSource(p.at); },
    }, icon("wind"), `${secs(p.duration, 2)}s`);
  }

  function lineRow(line, group, marks, pausesBefore) {
    const words = h("div", { class: "words" });
    for (const i of line.ids) {
      for (const p of pausesBefore.get(i) ?? []) words.append(pausePill(p));
      const raw = wordText(S.words, S.edits.fixes, i);
      if (raw === "") continue; // blanked by a phrase fix
      const lead = /^\s+/.exec(raw)?.[0] ?? "";
      if (lead && words.childNodes.length) words.append(" ");
      const w = S.words[i], cut = S.isCut(i);
      let cls = "w";
      if (cut) cls += " cut";
      if (w.p != null && w.p < 0.5) cls += " low";
      if (Object.hasOwn(S.edits.fixes, i)) cls += " fixed";
      if (!cut && marks.has(i)) cls += " " + marks.get(i);
      const span = h("span", { class: cls, dataset: { i: String(i) } }, raw.slice(lead.length));
      if (w.p != null && w.p < 0.5) span.title = t("fix.low", { p: Math.round(w.p * 100) });
      wordEls[i] = span;
      words.append(span);
    }
    let tag = h("button", { type: "button", class: "ts", title: t("sel.play"), onclick: e => { e.stopPropagation(); S.playLine(line); } }, short(line.start));
    if (group) {
      const k = group.s.takes.findIndex(x => x.line === line.index), take = group.s.takes[k];
      tag = h("div", { class: "take-tag" }, tag,
        h("span", { class: "badge" + (k === group.s.recommended ? " accent" : "") }, t("clean.take", { n: k + 1 })),
        group.status === "open" && h("div", { class: "take-actions" },
          button(null, { icon: "play", class: "small ghost icon-only", title: t("clean.listen"), onclick: e => { e.stopPropagation(); S.preview(take.start - 0.06, take.end + 0.12, "take"); } }),
          button(null, { icon: "check", class: "small ghost icon-only", title: t("clean.keep"), onclick: e => { e.stopPropagation(); S.apply(group.s, k); } })));
    }
    const allCut = line.ids.every(i => S.isCut(i));
    return h("div", { class: "line" + (allCut ? " all-cut" : ""), dataset: { line: String(line.index) } }, tag, words);
  }

  // ---- interaction --------------------------------------------------------------------------
  const wordAt = node => (node?.nodeType === 3 ? node.parentElement : node)?.closest?.(".w");

  function onClick(e) {
    const span = wordAt(e.target);
    if (!span || !scroll.contains(span)) return;
    if (!window.getSelection()?.isCollapsed) return; // a drag selection is handled on mouseup
    const i = Number(span.dataset.i);
    if (e.shiftKey && anchor != null) return S.selectWords(anchor, i);
    anchor = i;
    S.selectWords(i, i);
    S.playWord(i);
  }

  function onMouseUp() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    let a = wordAt(sel.anchorNode), b = wordAt(sel.focusNode);
    if (!a || !b || !scroll.contains(a) || !scroll.contains(b)) {
      const range = sel.getRangeAt(0);
      const spans = [...scroll.querySelectorAll(".w")].filter(s => range.intersectsNode(s));
      if (!spans.length) return;
      [a, b] = [spans[0], spans.at(-1)];
    }
    anchor = Number(a.dataset.i);
    S.selectWords(anchor, Number(b.dataset.i));
    sel.removeAllRanges();
  }

  function onDblClick(e) {
    const span = wordAt(e.target);
    if (!span || !scroll.contains(span)) return;
    S.stop();
    const i = Number(span.dataset.i);
    S.selectWords(i, i);
    openFixer(i, i);
  }

  function place(el, target) {
    scroll.append(el);
    const s = scroll.getBoundingClientRect(), r = target.getBoundingClientRect();
    el.style.top = `${r.bottom - s.top + scroll.scrollTop + 6}px`;
    el.style.left = `${Math.max(8, Math.min(r.left - s.left + scroll.scrollLeft, scroll.clientWidth - el.offsetWidth - 8))}px`;
  }

  function updateSelection() {
    for (const el of scroll.querySelectorAll(".w.sel")) el.classList.remove("sel");
    toolbar?.remove();
    toolbar = null;
    const sel = S.selection;
    if (!sel) return closeFixer();
    let last = null;
    S.words.forEach((w, i) => {
      if (wordEls[i] && w.end > sel.lo + 1e-5 && w.start < sel.hi - 1e-5) {
        wordEls[i].classList.add("sel");
        last = wordEls[i];
      }
    });
    if (last && sel.words && !fixer) showToolbar(last);
  }

  function showToolbar(target) {
    const sel = S.selection, restoring = S.selectionCutRatio() > 0.5;
    const [i, j] = sel.words;
    toolbar = h("div", { class: "seltool", onmousedown: e => e.preventDefault() },
      h("span", { class: "info" }, t("sel.duration", { d: secs(sel.hi - sel.lo, 2) })),
      button(t("sel.play"), { icon: "play", class: "small", onclick: () => S.playSelection() }),
      restoring
        ? button(t("sel.restore"), { icon: "restore", class: "small", onclick: () => S.restoreSelection() })
        : button(t("sel.cut"), { icon: "scissors", class: "small cutting", onclick: () => S.cutSelection() }),
      j - i < 12 && button(t("sel.fix"), { icon: "pencil", class: "small", onclick: () => openFixer(i, j) }),
      !restoring && button(t("sel.pause"), { icon: "wind", class: "small", onclick: () => S.replaceSelectionWithPause(S.prefs.pauseLength ?? 0.4) }),
      button(null, { icon: "x", class: "small icon-only", title: t("keys.clear"), onclick: () => S.clearSelection() }));
    place(toolbar, target);
  }

  function closeFixer() {
    fixer?.remove();
    fixer = null;
  }

  function openFixer(i, j) {
    closeFixer();
    toolbar?.remove();
    toolbar = null;
    const w = S.words[i];
    const current = [];
    for (let k = i; k <= j; k++) current.push(wordText(S.words, S.edits.fixes, k));
    const input = h("input", { class: "input", value: current.join("").trim() });
    const same = i === j ? S.sameWords(i) : [i];
    const fixed = Object.hasOwn(S.edits.fixes, i);
    const save = () => { const value = input.value; closeFixer(); S.fixRange(i, j, value); };
    fixer = h("div", { class: "fixpop", onmousedown: e => e.stopPropagation(), onclick: e => e.stopPropagation() },
      h("div", { class: "row" }, h("strong", null, t("fix.title")), h("span", { class: "grow" }),
        i === j && w.p != null && h("span", { class: "badge" + (w.p < 0.5 ? " filler" : "") }, t("fix.low", { p: Math.round(w.p * 100) }))),
      input,
      fixed && h("div", { class: "hint" }, t("fix.original", { orig: w.text.trim() })),
      h("div", { class: "hint" }, t("fix.hint")),
      h("div", { class: "row wrap" },
        button(t("fix.save"), { class: "small primary", onclick: save }),
        same.length > 1 && button(t("fix.all", { n: same.length }), { class: "small", onclick: () => { const value = input.value; closeFixer(); S.fixAll(i, value); } }),
        fixed && button(t("fix.reset"), { class: "small ghost", onclick: () => { closeFixer(); S.resetFix(i); } }),
        h("span", { class: "grow" }),
        button(t("fix.cancel"), { class: "small ghost", onclick: closeFixer })));
    input.addEventListener("keydown", e => {
      e.stopPropagation();
      if (e.key === "Enter") save();
      if (e.key === "Escape") closeFixer();
    });
    place(fixer, wordEls[i] ?? scroll.firstChild);
    input.focus();
    input.select();
  }

  // ---- playback follow and focus -----------------------------------------------------------
  function updateActive() {
    const at = S.cursorSource, words = S.words;
    let lo = 0, hi = words.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (words[mid].end <= at) lo = mid + 1;
      else hi = mid;
    }
    const i = lo < words.length && words[lo].start <= at + 1e-4 ? lo : -1;
    if (i === active) return;
    wordEls[active]?.classList.remove("active");
    active = i;
    const el = wordEls[i];
    if (!el) return;
    el.classList.add("active");
    if (S.playing && S.prefs.follow) {
      const top = el.offsetTop, view = scroll.scrollTop;
      if (top < view + 40 || top > view + scroll.clientHeight - 90) scroll.scrollTo({ top: top - scroll.clientHeight / 3, behavior: "smooth" });
    }
  }

  function focus(s) {
    for (const el of scroll.querySelectorAll(".flash")) el.classList.remove("flash");
    if (!s) return;
    let ids = s.words ?? [];
    if (s.type === "retake") ids = S.lines[s.takes[0].line].ids;
    if (s.type === "pause") ids = [s.after, s.before];
    if (!ids.length) {
      const k = S.words.findIndex(w => w.end > s.start);
      if (k >= 0) ids = [k];
    }
    const first = wordEls[ids[0]];
    if (!first) return;
    first.scrollIntoView({ block: "center", behavior: "smooth" });
    for (const k of ids) {
      const el = wordEls[k];
      if (!el) continue;
      el.classList.remove("flash");
      void el.offsetWidth; // restart the animation
      el.classList.add("flash");
    }
  }

  return {
    render,
    destroy() {
      offs.forEach(off => off());
      scroll.removeEventListener("mouseup", onMouseUp);
      scroll.removeEventListener("click", onClick);
      scroll.removeEventListener("dblclick", onDblClick);
    },
  };
}
