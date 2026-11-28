// Transport row under the waveform: play, clock (edited time), view, zoom, marks and selection.

import { h, button, clock, secs } from "./dom.js";
import { icon } from "./icons.js";
import { t } from "../i18n.js";

export function createTransport(S, root, waveform) {
  const play = h("button", { type: "button", class: "play-btn", onclick: () => S.toggle() });
  const time = h("span", { class: "clock" });
  const modes = h("div", { class: "seg small" }, ["edited", "source"].map(m => h("button", {
    type: "button", dataset: { mode: m }, title: t(`transport.${m}`),
    onclick: () => { S.setPref("mode", m); waveform.fit(); },
  }, t(`transport.${m}`))));
  const capToggle = button(t("wave.captions"), {
    icon: "subtitles", class: "small cap-toggle", title: t("wave.toggleCaptions"),
    onclick: () => S.setPref("showCaptions", S.prefs.showCaptions === false),
  });
  const selection = h("span", { class: "sel-info" });
  const cut = button(t("sel.cut"), { icon: "scissors", class: "small", onclick: () => S.cutSelection() });
  const stats = h("span", { class: "stats" });

  root.replaceChildren(
    button(null, { icon: "rewind", class: "ghost icon-only small", title: t("transport.toStart"), onclick: () => S.seekEdited(0) }),
    play, time,
    h("span", { class: "divider" }),
    modes, capToggle,
    button(null, { icon: "zoomOut", class: "ghost icon-only small", title: t("transport.zoomOut"), onclick: () => waveform.zoom(1 / 1.6) }),
    button(null, { icon: "zoomIn", class: "ghost icon-only small", title: t("transport.zoomIn"), onclick: () => waveform.zoom(1.6) }),
    button(null, { icon: "fit", class: "ghost icon-only small", title: t("transport.fit"), onclick: () => waveform.fit() }),
    h("span", { class: "divider" }),
    button("I", { class: "small", title: t("transport.markIn"), onclick: () => S.markIn() }),
    button("O", { class: "small", title: t("transport.markOut"), onclick: () => S.markOut() }),
    button(null, { icon: "split", class: "small icon-only", title: t("transport.split"), onclick: () => S.split() }),
    button(null, { icon: "headphones", class: "small icon-only", title: t("transport.lastCut"), onclick: () => S.playAroundJoin() }),
    selection, cut, stats);

  function updateClock() {
    time.replaceChildren(clock(S.playhead), h("small", null, ` / ${clock(S.plan.editedDuration)}`));
  }
  function updatePlay() {
    play.replaceChildren(icon(S.playing ? "pause" : "play"));
    play.title = t(S.playing ? "transport.pause" : "transport.play");
    play.setAttribute("aria-label", play.title);
  }
  function updateSelection() {
    const sel = S.selection;
    selection.textContent = sel ? t("transport.selection", { a: clock(sel.lo, 2), b: clock(sel.hi, 2), d: secs(sel.hi - sel.lo, 2) }) : "";
    cut.hidden = !sel || S.selectionCutRatio() > 0.5;
  }
  function updateStats() {
    stats.textContent = t("transport.stats", { cut: secs(S.cutSeconds()), n: S.edits.pauses.length });
    for (const b of modes.children) b.setAttribute("aria-pressed", String(b.dataset.mode === S.prefs.mode));
    capToggle.setAttribute("aria-pressed", String(S.prefs.showCaptions !== false));
  }

  const offs = [
    S.on("playhead", updateClock), S.on("play", updatePlay), S.on("selection", updateSelection),
    S.on("edits", () => { updateClock(); updateStats(); updateSelection(); }), S.on("prefs", updateStats),
  ];
  updateClock();
  updatePlay();
  updateSelection();
  updateStats();
  return { destroy() { offs.forEach(off => off()); } };
}
