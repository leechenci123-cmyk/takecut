// Editor keyboard shortcuts (DaVinci Resolve-style marks and ripple delete) and the help dialog.

import { h, button } from "./dom.js";
import { t } from "../i18n.js";
import { modal } from "./overlay.js";

export function bindShortcuts(S, { onExport, onHelp, waveform }) {
  const focusedRetake = () => {
    const found = S.focus && S.suggestions().find(x => x.s.key === S.focus && x.status === "open");
    return found?.s.type === "retake" ? found.s : null;
  };
  const run = (e, fn) => { e.preventDefault(); fn(); };

  function onKey(e) {
    if (e.defaultPrevented || e.isComposing || document.querySelector("dialog[open]")) return;
    if (e.target.closest?.("input, textarea, select, [contenteditable='true']")) return;
    const mod = e.ctrlKey || e.metaKey, key = e.key, lower = key.toLowerCase();
    if (mod && !e.shiftKey && lower === "z") return run(e, S.undo);
    if (mod && (lower === "y" || (e.shiftKey && lower === "z"))) return run(e, S.redo);
    if (mod && lower === "b") return run(e, S.split);
    if (mod && lower === "e") return run(e, onExport);
    if (mod || e.altKey) return;
    if (key === "?") return run(e, onHelp);
    switch (key) {
      case " ": return run(e, () => !e.repeat && S.toggle());
      case "ArrowLeft": return run(e, () => (e.shiftKey ? S.jumpWord(-1) : S.nudge(-0.05)));
      case "ArrowRight": return run(e, () => (e.shiftKey ? S.jumpWord(1) : S.nudge(0.05)));
      case "Home": return run(e, () => S.seekEdited(0));
      case "End": return run(e, () => S.seekEdited(S.plan.editedDuration));
      case "Backspace":
      case "Delete": return S.selection ? run(e, S.cutSelection) : undefined;
      case "/": return run(e, S.playAroundJoin);
      case "Escape": return run(e, () => { S.clearSelection(); S.focusSuggestion(null); S.selectPause(null); });
      case "=": case "+": return run(e, () => waveform.zoom(1.6));
      case "-": case "_": return run(e, () => waveform.zoom(1 / 1.6));
      case "Enter": {
        const s = focusedRetake();
        if (s && !e.target.closest?.("button")) run(e, () => S.apply(s, s.recommended));
        return;
      }
      default:
    }
    if (lower === "i") return run(e, S.markIn);
    if (lower === "o") return run(e, S.markOut);
    if (/^[1-9]$/.test(key)) {
      const s = focusedRetake(), take = s?.takes[Number(key) - 1];
      if (take) run(e, () => S.preview(take.start - 0.06, take.end + 0.12, "take"));
    }
  }

  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}

const ROWS = [
  ["keys.play", ["Space"]],
  ["keys.nudge", ["←", "→"]],
  ["keys.word", ["Shift", "← / →"]],
  ["keys.home", ["Home", "End"]],
  ["keys.inout", ["I", "O"]],
  ["keys.cut", ["Del", "⌫"]],
  ["keys.split", ["Ctrl", "B"]],
  ["keys.undo", ["Ctrl", "Z"]],
  ["keys.redo", ["Ctrl", "Shift", "Z"]],
  ["keys.lastCut", ["/"]],
  ["keys.takes", ["1–9", "Enter"]],
  ["keys.zoom", ["+", "−", "Ctrl + wheel"]],
  ["keys.fix", ["Double-click"]],
  ["keys.clear", ["Esc"]],
  ["keys.export", ["Ctrl", "E"]],
  ["keys.help", ["?"]],
];

export function openShortcuts() {
  return modal(close => ({
    title: t("keys.title"),
    body: [
      h("div", { class: "keys" }, ROWS.flatMap(([label, keys]) => [h("span", null, t(label)), h("span", { class: "k" }, keys.map(k => h("kbd", null, k)))])),
      h("p", { class: "faint", style: { fontSize: "12.5px" } }, t("keys.note")),
    ],
    foot: button(t("common.ok"), { class: "primary", onclick: () => close() }),
  }));
}
