// "Pauses" sidebar tab: insert silence at the playhead, replace a selected pause, adjust or loop
// inserted pauses.

import { h, button, secs, clock } from "./dom.js";
import { icon } from "./icons.js";
import { t } from "../i18n.js";

const PRESETS = [0.2, 0.4, 0.8];

export function createPausesPanel(S, root) {
  const offs = [S.on("edits", render), S.on("pause", render), S.on("selection", render), S.on("play", render)];
  render();

  function length() {
    return S.prefs.pauseLength ?? 0.4;
  }

  function setLength(v) {
    S.setPref("pauseLength", Math.round(v * 100) / 100);
    render();
  }

  function render() {
    const len = length();
    const presets = h("div", { class: "seg" }, PRESETS.map(v =>
      h("button", { type: "button", "aria-pressed": String(Math.abs(len - v) < 1e-6), onclick: () => setLength(v) }, `${v} ${t("pause.seconds")}`)));
    const custom = h("input", {
      class: "input small", type: "number", min: "0.05", max: "60", step: "0.05", value: secs(len, 2), style: { width: "78px" },
      "aria-label": t("pause.length"),
      onchange: e => { const v = Number(e.target.value); if (v > 0 && v <= 60) setLength(v); },
    });
    const insert = h("div", { class: "panel-card" },
      h("h3", null, t("pause.insert")),
      h("p", { class: "muted", style: { fontSize: "13px" } }, t("pause.hint")),
      h("div", { class: "row wrap" }, presets, custom),
      h("div", { class: "row wrap" },
        button(t("pause.insert"), { icon: "plus", class: "small primary", onclick: () => S.insertPause(len) }),
        button(t("pause.replace"), { icon: "wind", class: "small", disabled: !S.selection, onclick: () => S.replaceSelectionWithPause(len) })),
      h("p", { class: "faint", style: { fontSize: "12px" } }, t("pause.replaceHint")));
    const list = S.edits.pauses;
    const inserted = h("div", { class: "panel-card" },
      h("h3", { class: "row" }, t("pause.list"), h("span", { class: "count" }, String(list.length))),
      list.length ? h("div", { class: "pause-list" }, list.map(row)) : h("p", { class: "faint" }, t("pause.none")));
    root.replaceChildren(insert, inserted);
  }

  function row(p) {
    const selected = S.selectedPause === p.at;
    const head = h("div", {
      class: "pause-row" + (selected ? " selected" : ""),
      onclick: () => { S.selectPause(selected ? null : p.at); if (!selected) S.seekSource(p.at); },
    }, icon("wind"), h("span", { class: "mono" }, clock(S.toEdited(p.at), 2)), h("span", { class: "grow" }),
    h("span", { class: "badge pause" }, `${secs(p.duration, 2)} ${t("pause.seconds")}`));
    if (!selected) return head;
    const slider = h("input", { type: "range", min: "0.05", max: String(Math.max(3, Math.ceil(p.duration))), step: "0.01", value: String(p.duration), "aria-label": t("pause.length") });
    const num = h("input", { class: "input small", type: "number", min: "0.05", max: "60", step: "0.01", value: secs(p.duration, 2), "aria-label": t("pause.length") });
    slider.addEventListener("input", () => { num.value = Number(slider.value).toFixed(2); });
    slider.addEventListener("change", () => S.setPause(p.at, Number(slider.value)));
    num.addEventListener("change", () => { const v = Number(num.value); if (v > 0 && v <= 60) S.setPause(p.at, v); });
    const looping = S.playing?.tag === "pause";
    return h("div", null, head,
      h("div", { class: "panel-card", style: { marginTop: "6px", padding: "10px 12px" } },
        h("div", { class: "slider-row" }, slider, num),
        h("div", { class: "row wrap" },
          button(looping ? t("pause.stop") : t("pause.loop"), { icon: looping ? "pause" : "repeat", class: "small", onclick: () => S.loopPause(p.at) }),
          button(t("pause.delete"), { icon: "trash", class: "small danger", onclick: () => S.setPause(p.at, 0) }))));
  }

  return { render, destroy() { offs.forEach(off => off()); } };
}
