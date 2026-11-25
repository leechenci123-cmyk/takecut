// "Clean up" sidebar: every suggestion by category, with listen / apply / ignore on each item and
// a one-click action per category.

import { h, button, secs, short } from "./dom.js";
import { icon } from "./icons.js";
import { t } from "../i18n.js";
import { wordText, joinWords } from "../core/text.js";
import { CATEGORIES } from "../core/suggest/index.js";

const META = {
  retakes: { icon: "repeat", color: "retake" },
  stutters: { icon: "stutter", color: "stutter" },
  fillers: { icon: "message", color: "filler" },
  pauses: { icon: "timer", color: "pause" },
};
const THRESHOLDS = [0.5, 0.6, 0.8, 1, 1.5, 2];
const TARGETS = [0.2, 0.3, 0.4, 0.5, 0.6, 0.8];

export function createCleanup(S, root) {
  let showResolved = false;
  const offs = [S.on("edits", render), S.on("focus", markFocus)];

  const stop = fn => e => { e.stopPropagation(); fn(); };
  const text = (from, to) => {
    const ids = [];
    for (let i = Math.max(0, from); i <= Math.min(S.words.length - 1, to); i++) ids.push(i);
    return joinWords(ids.map(i => wordText(S.words, S.edits.fixes, i)));
  };

  function render() {
    const all = S.suggestions();
    const open = all.filter(x => x.status === "open");
    const byCat = Object.fromEntries(CATEGORIES.map(c => [c, all.filter(x => x.s.category === c)]));
    root.replaceChildren(summary(open, byCat), ...CATEGORIES.map(c => category(c, byCat[c])));
  }

  function summary(open, byCat) {
    const meter = h("div", { class: "meter" }, CATEGORIES.map(c => {
      const n = byCat[c].filter(x => x.status === "open").length;
      return n ? h("i", { style: { flex: String(n), background: `var(--${META[c].color})` } }) : null;
    }));
    return h("div", { class: "clean-summary" },
      h("div", { class: "row" },
        h("span", { class: "cat-icon", style: { background: "var(--accent-soft)", color: "var(--accent-text)" } }, icon(open.length ? "sparkle" : "check")),
        h("strong", null, open.length ? t("clean.remaining", { n: open.length }) : t("clean.allDone"))),
      open.length ? meter : null,
      h("div", { class: "muted", style: { fontSize: "13px" } }, t("clean.summaryCut", { cut: secs(S.cutSeconds()), dur: short(S.plan.editedDuration) })),
      h("div", { class: "faint", style: { fontSize: "12px" } }, t("clean.heuristic")));
  }

  function category(c, entries) {
    const open = entries.filter(x => x.status === "open"), resolved = entries.filter(x => x.status !== "open");
    const section = h("section", { class: "cat" + (S.prefs.collapsed.includes(c) ? " collapsed" : ""), dataset: { cat: c } });
    const head = h("div", { class: "cat-head", onclick: () => {
      const collapsed = section.classList.toggle("collapsed");
      S.setPref("collapsed", collapsed ? [...S.prefs.collapsed, c] : S.prefs.collapsed.filter(x => x !== c));
    } },
    h("span", { class: "cat-icon" }, icon(META[c].icon)),
    h("h3", null, t(`clean.${c}`), h("span", { class: "count" }, String(open.length))),
    categoryAction(c, open),
    icon("chevronDown", "chev"));
    const body = h("div", { class: "cat-body" },
      c === "pauses" && pauseTools(),
      open.length ? open.map(item) : h("div", { class: "cat-empty" }, t("clean.none")),
      resolved.length > 0 && h("div", { class: "resolved-toggle" }, t("clean.resolved", { n: resolved.length }),
        button(showResolved ? t("clean.hide") : t("clean.show"), { class: "small ghost", onclick: () => { showResolved = !showResolved; render(); } })),
      showResolved && resolved.map(item));
    section.append(head, body);
    return section;
  }

  function categoryAction(c, open) {
    if (!open.length) return null;
    if (c === "fillers") {
      const strong = open.filter(x => x.s.strength === "strong").length;
      return strong ? button(t("clean.cutStrong", { n: strong }), { class: "small", onclick: stop(() => S.applyCategory(c)) }) : null;
    }
    const label = { retakes: "clean.applyRecommended", stutters: "clean.cutAll", pauses: "clean.shortenAll" }[c];
    return button(t(label), { class: "small", onclick: stop(() => S.applyCategory(c)) });
  }

  function select(values, current, onchange) {
    return h("select", { class: "input small", onchange: e => onchange(Number(e.target.value)) },
      values.map(v => h("option", { value: String(v), selected: Math.abs(v - current) < 1e-9 }, t("clean.seconds", { n: v }))));
  }

  function pauseTools() {
    return h("div", { class: "cat-tools", onclick: e => e.stopPropagation() },
      h("span", null, t("clean.threshold")), select(THRESHOLDS, S.prefs.threshold, v => S.setPref("threshold", v)),
      h("span", null, t("clean.target")), select(TARGETS, S.prefs.target, v => S.setPref("target", v)));
  }

  function item({ s, status }) {
    const resolved = status !== "open";
    const el = h("div", {
      class: "item" + (resolved ? " resolved" : "") + (S.focus === s.key ? " focused" : ""),
      dataset: { key: s.key }, onclick: () => S.focusSuggestion(s),
    });
    el.append(...content(s, resolved));
    if (resolved) {
      el.append(h("div", { class: "item-actions" },
        h("span", { class: "badge" }, t(status === "ignored" ? "clean.ignored" : "clean.done")),
        status === "ignored" && button(t("clean.unignore"), { class: "small ghost", onclick: stop(() => S.unignore(s)) })));
    }
    return el;
  }

  const listen = (a, b, tag) => button(t("clean.listen"), { icon: "play", class: "small", onclick: stop(() => S.preview(a, b, tag)) });
  const actions = (...nodes) => h("div", { class: "item-actions" }, nodes);

  function content(s, resolved) {
    const time = h("span", { class: "mono" }, short(s.start));
    switch (s.type) {
      case "retake":
        return [
          h("div", { class: "item-meta" }, h("span", { class: "badge retake" }, `${t("clean.retakes")} · ${s.takes.length}`), time),
          ...s.takes.map((take, k) => h("div", { class: "take-row" + (k === s.recommended ? " rec" : "") },
            h("span", { class: "take-n" }, t("clean.take", { n: k + 1 })),
            h("div", null,
              h("div", { class: "item-text" }, take.text, k === s.recommended && [" ", h("span", { class: "badge accent" }, t("clean.recommended"))]),
              !resolved && actions(
                listen(take.start - 0.06, take.end + 0.12, "take"),
                button(t("clean.keep"), { icon: "check", class: "small" + (k === s.recommended ? " primary" : ""), onclick: stop(() => S.apply(s, k)) }))))),
          !resolved && actions(button(t("clean.keepAll"), { class: "small ghost", onclick: stop(() => S.ignore(s)) })),
        ];
      case "restart": {
        const last = s.words.at(-1), line = S.lines[s.line];
        return [
          h("div", { class: "item-meta" }, h("span", { class: "badge retake" }, t("clean.restart")), time),
          h("div", { class: "item-text" }, h("mark", null, text(s.words[0], last)), " ", h("span", { class: "keep" }, text(last + 1, line.ids.at(-1)))),
          !resolved && actions(listen(s.start - 0.3, s.end + 0.5), button(t("clean.restartCut"), { icon: "scissors", class: "small", onclick: stop(() => S.apply(s)) }),
            button(t("clean.ignore"), { class: "small ghost", onclick: stop(() => S.ignore(s)) })),
        ];
      }
      case "stutter": {
        const last = s.words.at(-1);
        return [
          h("div", { class: "item-meta" }, h("span", { class: "badge stutter" }, t("clean.stutters")), time),
          h("div", { class: "item-text" }, text(last - 6, s.words[0] - 1), " ", h("mark", null, text(s.words[0], last - 1)), " ", h("span", { class: "keep" }, text(last, last)), " ", text(last + 1, last + 5)),
          !resolved && actions(listen(s.start - 0.4, s.end + 0.6), button(t("clean.stutterCut"), { icon: "scissors", class: "small", onclick: stop(() => S.apply(s)) }),
            button(t("clean.keepAll"), { class: "small ghost", onclick: stop(() => S.ignore(s)) })),
        ];
      }
      case "filler": {
        const first = s.words[0], last = s.words.at(-1);
        return [
          h("div", { class: "item-meta" }, h("span", { class: "badge filler" }, t(s.strength === "strong" ? "clean.strong" : "clean.weak")), time),
          h("div", { class: "item-text" }, text(first - 5, first - 1), " ", h("mark", null, text(first, last)), " ", text(last + 1, last + 5)),
          !resolved && actions(listen(s.start - 0.6, s.end + 0.6), button(t("clean.cut"), { icon: "scissors", class: "small", onclick: stop(() => S.apply(s)) }),
            button(t("clean.ignore"), { class: "small ghost", onclick: stop(() => S.ignore(s)) })),
        ];
      }
      case "sound":
        return [
          h("div", { class: "item-meta" }, h("span", { class: "badge filler" }, t("clean.weak")), t("clean.sound"), time),
          h("div", { class: "item-text faint" }, `${secs(s.end - s.start, 2)} s`),
          !resolved && actions(listen(s.start - 0.5, s.end + 0.5), button(t("clean.cut"), { icon: "scissors", class: "small", onclick: stop(() => S.apply(s)) }),
            button(t("clean.ignore"), { class: "small ghost", onclick: stop(() => S.ignore(s)) })),
        ];
      case "pause":
      case "edge":
        return [
          h("div", { class: "item-meta" }, h("span", { class: "badge pause" }, t("clean.pauses")), time),
          h("div", { class: "item-text" },
            s.type === "pause" ? t("clean.gap", { len: secs(s.length) }) : t(s.which === "start" ? "clean.edgeStart" : "clean.edgeEnd", { len: secs(s.length) }),
            " ", h("span", { class: "keep" }, t("clean.to", { t: secs(s.type === "pause" ? S.prefs.target : s.ranges[0][0] - s.start + (s.which === "start" ? s.end - s.ranges[0][1] : 0), 2) }))),
          !resolved && actions(listen(s.start - 0.8, s.end + 0.8), button(t("clean.shorten"), { icon: "scissors", class: "small", onclick: stop(() => S.apply(s)) }),
            button(t("clean.ignore"), { class: "small ghost", onclick: stop(() => S.ignore(s)) })),
        ];
      default:
        return [];
    }
  }

  function markFocus() {
    for (const el of root.querySelectorAll(".item")) {
      const on = el.dataset.key === S.focus;
      el.classList.toggle("focused", on);
      if (on) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }

  render();
  return { render, destroy() { offs.forEach(off => off()); } };
}
