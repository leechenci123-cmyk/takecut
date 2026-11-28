// Microphone recorder UI + keyboard shortcut handler:
//   R              Start recording
//   P or Space     Pause / resume recording
//   S or Enter     End recording and import it
//   Esc            Cancel / discard recording

import { h, clock } from "./dom.js";
import { icon } from "./icons.js";
import { t, errorText } from "../i18n.js";
import { VoiceRecorder } from "../audio/recorder.js";
import { modal, toast } from "./overlay.js";

function keycap(label) {
  return h("kbd", { class: "rec-kbd" }, label);
}

/**
 * Create a self-contained recorder control widget with live timer, input meter, and shortcuts.
 * Calls `onComplete(file)` when the user ends a recording.
 */
export function createRecorderWidget({ onComplete, onCancel, inModal = false, autoStart = false, disabled = false }) {
  const rec = new VoiceRecorder();
  const el = h("div", { class: "recorder-card" });
  const meter = h("canvas", { class: "rec-meter" });
  const timer = h("span", { class: "rec-timer" }, "00:00.0");
  let raf = 0, levels = new Array(36).fill(0), finishing = false;

  async function start() {
    if (disabled || finishing || rec.state !== "idle") return;
    try {
      levels.fill(0);
      await rec.start();
    } catch (err) {
      toast(errorText(err), { error: true, duration: 6000 });
    }
  }

  function pauseResume() {
    if (finishing || rec.state === "idle") return;
    rec.togglePause();
  }

  async function finish() {
    if (finishing || rec.state === "idle") return;
    finishing = true;
    render();
    const file = await rec.stop();
    finishing = false;
    if (file) onComplete?.(file);
    else render();
  }

  function discard() {
    if (finishing) return;
    if (rec.state !== "idle") {
      rec.cancel();
      toast(t("rec.cancelled"));
    }
    onCancel?.();
  }

  function drawMeter() {
    raf = 0;
    if (!el.isConnected || rec.state === "idle") return;
    timer.textContent = clock(rec.elapsed(), 1);
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(meter.clientWidth * dpr), hgt = Math.round(meter.clientHeight * dpr);
    if (w && hgt) {
      if (meter.width !== w || meter.height !== hgt) { meter.width = w; meter.height = hgt; }
      if (rec.state === "recording") {
        levels.shift();
        levels.push(rec.level());
      }
      const g = meter.getContext("2d");
      g.clearRect(0, 0, w, hgt);
      const count = levels.length;
      const step = w / count;
      const barW = Math.max(2 * dpr, step * 0.58);
      g.fillStyle = rec.state === "recording" ? "#f07c72" : "#f3c14f";
      for (let i = 0; i < count; i++) {
        const bh = Math.max(3 * dpr, levels[i] * hgt * 0.9);
        g.fillRect(i * step + (step - barW) / 2, (hgt - bh) / 2, barW, bh);
      }
    }
    raf = requestAnimationFrame(drawMeter);
  }

  function render() {
    cancelAnimationFrame(raf);
    raf = 0;
    const st = rec.state;
    el.dataset.state = st;

    if (st === "idle") {
      const startBtn = h("button", {
        type: "button", class: "btn rec-start-btn", disabled: disabled || !VoiceRecorder.supported(),
        onclick: start,
      }, icon("mic"), h("span", null, t("rec.start")), keycap("R"));
      el.replaceChildren(
        h("div", { class: "rec-idle" },
          startBtn,
          h("span", { class: "rec-hint" },
            VoiceRecorder.supported() ? t("rec.shortcutsHint") : t("err.mic-unsupported"))),
      );
      return;
    }

    const paused = st === "paused";
    const pauseBtn = h("button", {
      type: "button", class: "btn small", disabled: finishing, onclick: pauseResume,
      title: t(paused ? "rec.resume" : "rec.pause"),
    }, icon(paused ? "play" : "pause"), h("span", null, t(paused ? "rec.resume" : "rec.pause")), keycap("P"));

    const endBtn = h("button", {
      type: "button", class: "btn small primary", disabled: finishing, onclick: finish,
      title: t("rec.end"),
    }, icon("stop"), h("span", null, t("rec.end")), keycap("S"));

    const cancelBtn = h("button", {
      type: "button", class: "btn small ghost", disabled: finishing, onclick: discard,
      title: t("common.cancel"),
    }, icon("x"), h("span", null, t("common.cancel")), keycap("Esc"));

    el.replaceChildren(
      h("div", { class: "rec-live-top" },
        h("span", { class: "rec-dot" + (paused ? " paused" : "") }),
        h("strong", null, t(paused ? "rec.paused" : "rec.recording")),
        timer,
        meter),
      h("div", { class: "rec-actions" }, pauseBtn, endBtn, cancelBtn),
      h("div", { class: "rec-hint" }, t("rec.activeHint")),
    );
    drawMeter();
  }

  function onKey(e) {
    if (e.defaultPrevented || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target.closest?.("input, textarea, select, [contenteditable='true']")) return;
    const openDialog = document.querySelector("dialog[open]");
    if (inModal ? !openDialog?.contains(el) : Boolean(openDialog)) return;

    const lower = e.key.toLowerCase();
    if (rec.state === "idle") {
      if (lower === "r" && !e.repeat) {
        e.preventDefault();
        start();
      }
      return;
    }
    if ((lower === "p" || e.key === " ") && !e.repeat) {
      e.preventDefault();
      pauseResume();
    } else if ((lower === "s" || e.key === "Enter") && !e.repeat) {
      e.preventDefault();
      finish();
    } else if (e.key === "Escape") {
      e.preventDefault();
      discard();
    }
  }

  rec.onState = render;
  window.addEventListener("keydown", onKey);
  render();
  if (autoStart) start();

  return {
    el,
    start,
    pauseResume,
    finish,
    discard,
    relocalize: render,
    isActive: () => rec.state !== "idle",
    destroy() {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKey);
      rec.cancel();
    },
  };
}

/** Open the recorder in a modal dialog (used from the Editor via Shift+R or menu). */
export function openRecorderModal({ onComplete, autoStart = true } = {}) {
  let widget = null;
  return modal(close => {
    widget = createRecorderWidget({
      inModal: true,
      autoStart,
      onComplete: file => {
        close(file);
        onComplete?.(file);
      },
      onCancel: () => close(null),
    });
    return {
      title: t("rec.modalTitle"),
      body: [widget.el],
      foot: h("button", { type: "button", class: "btn", onclick: () => { widget.discard(); close(null); } }, t("export.close")),
    };
  }).finally(() => widget?.destroy());
}
