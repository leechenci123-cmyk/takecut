// Waveform with two views: "edited" (what you export: cuts closed up, pauses as violet blocks)
// and "source" (the full recording with cuts shaded red). Click to seek, drag to select,
// Ctrl+wheel to zoom, wheel to scroll, double-click to select between splits.

import { peakIn, barHeight } from "../audio/peaks.js";
import { keepRanges, overlapsCut } from "../core/timeline.js";
import { clock } from "./dom.js";

// The dock is dark in both themes, so the waveform uses one fixed palette.
const C = {
  wave: "#a8d68a", waveCut: "rgba(168, 214, 138, 0.22)", cut: "#f07c72", cutFill: "rgba(240, 124, 114, 0.14)",
  pause: "#b49cf5", pauseFill: "rgba(180, 156, 245, 0.22)", sel: "rgba(243, 193, 79, 0.22)", selEdge: "#f3c14f",
  focus: "rgba(115, 178, 239, 0.28)", focusEdge: "#73b2ef", playhead: "#f4f8ee", split: "#73b2ef",
  grid: "rgba(255, 255, 255, 0.05)", label: "#13221c", overview: "rgba(168, 214, 138, 0.55)", window: "rgba(255, 255, 255, 0.12)",
};

export function createWaveform(S, { canvas, overview, ruler, peaks }) {
  const view = S.view;
  let base = null, baseKey = "", ovBase = null, ovKey = "", raf = 0, drag = null;
  const dpr = () => window.devicePixelRatio || 1;
  const mode = () => S.prefs.mode;
  const total = () => (mode() === "edited" ? S.plan.editedDuration : S.duration);
  const span = () => total() / view.zoom;
  const toAxis = (src, after = false) => (mode() === "edited" ? S.toEdited(src, after) : src);
  const fromAxis = t => (mode() === "edited" ? S.toSource(t) : t);
  const playheadAxis = () => (mode() === "edited" ? S.playhead : S.cursorSource);

  function clampView() {
    view.zoom = Math.max(1, Math.min(400, view.zoom));
    view.start = Math.max(0, Math.min(total() - span(), view.start));
  }

  function fit(el) {
    const w = Math.round(el.clientWidth * dpr()), hgt = Math.round(el.clientHeight * dpr());
    if (el.width !== w || el.height !== hgt) { el.width = w; el.height = hgt; }
    return [w, hgt];
  }

  // ---- drawing ----------------------------------------------------------------------------
  function drawBars(g, W, H, s0, sp, dim = true) {
    const ratio = dpr(), bar = Math.max(2, Math.round(2.4 * ratio)), gap = Math.max(1, Math.round(ratio)), mid = H / 2;
    if (mode() === "edited") {
      const items = S.plan.items, sr = S.sampleRate;
      let k = 0;
      for (let px = 0; px < W; px += bar + gap) {
        const a = s0 + (px / W) * sp, b = s0 + ((px + bar) / W) * sp;
        while (k < items.length && (items[k].offset + items[k].length) / sr <= a) k++;
        let amp = 0, silence = false;
        for (let j = k; j < items.length && items[j].offset / sr < b; j++) {
          const it = items[j], s = it.offset / sr, e = (it.offset + it.length) / sr;
          if (it.pause) { silence = true; continue; }
          const sa = it.a / sr + (Math.max(a, s) - s), sb = it.a / sr + (Math.min(b, e) - s);
          if (sb > sa) amp = Math.max(amp, peakIn(peaks, sa, sb));
        }
        if (!amp && silence) { g.fillStyle = C.pause; g.fillRect(px, mid - ratio, bar, 2 * ratio); continue; }
        const hgt = Math.max(1.5 * ratio, barHeight(peaks, amp) * H * 0.86);
        g.fillStyle = C.wave;
        g.fillRect(px, mid - hgt / 2, bar, hgt);
      }
    } else {
      for (let px = 0; px < W; px += bar + gap) {
        const a = s0 + (px / W) * sp, b = s0 + ((px + bar) / W) * sp;
        const hgt = Math.max(1.5 * ratio, barHeight(peaks, peakIn(peaks, a, b)) * H * 0.86);
        const cut = dim && overlapsCut(S.edits.cuts, (a + b) / 2, (a + b) / 2 + 1e-6);
        g.fillStyle = cut ? C.waveCut : C.wave;
        g.fillRect(px, mid - hgt / 2, bar, hgt);
      }
    }
  }

  function renderBase(W, H) {
    const key = [S.version, mode(), view.zoom.toFixed(4), view.start.toFixed(5), W, H, S.selection?.lo, S.selection?.hi,
      S.marks.in, S.marks.out, S.focus, S.selectedPause].join("|");
    if (base && key === baseKey) return;
    baseKey = key;
    base ??= document.createElement("canvas");
    base.width = W;
    base.height = H;
    const g = base.getContext("2d"), ratio = dpr(), s0 = view.start, sp = span();
    const x = t => ((t - s0) / sp) * W;
    g.clearRect(0, 0, W, H);
    for (let k = 1; k < 8; k++) { g.fillStyle = C.grid; g.fillRect(Math.round((k / 8) * W), 0, 1, H); }
    drawBars(g, W, H, s0, sp);

    if (mode() === "edited") {
      const sr = S.sampleRate;
      let lastEnd = null;
      for (const it of S.plan.items) {
        const at = it.offset / sr;
        if (it.pause) {
          const x0 = x(at), x1 = x(at + it.length / sr);
          g.fillStyle = C.pauseFill;
          g.fillRect(x0, 0, Math.max(2 * ratio, x1 - x0), H);
          if (S.selectedPause === it.pause.at) { g.strokeStyle = C.pause; g.lineWidth = 2 * ratio; g.strokeRect(x0 + ratio, ratio, Math.max(2, x1 - x0 - 2 * ratio), H - 2 * ratio); }
          if (x1 - x0 > 36 * ratio) {
            g.fillStyle = C.pause;
            g.font = `600 ${10.5 * ratio}px ui-monospace, monospace`;
            g.fillText(`${(it.length / sr).toFixed(2)}s`, x0 + 4 * ratio, 13 * ratio);
          }
        }
        if (lastEnd != null && it.a !== lastEnd) {
          const px = x(at);
          if (px >= -4 && px <= W + 4) {
            g.fillStyle = C.cut;
            g.fillRect(px - ratio / 2, 0, ratio * 1.5, H);
            g.beginPath();
            g.moveTo(px - 5 * ratio, 0); g.lineTo(px + 5 * ratio, 0); g.lineTo(px, 7 * ratio);
            g.fill();
          }
        }
        lastEnd = it.pause ? it.a : it.b;
      }
    } else {
      for (const [a, b] of S.edits.cuts) {
        const x0 = x(a), x1 = x(b);
        if (x1 < 0 || x0 > W) continue;
        g.fillStyle = C.cutFill;
        g.fillRect(x0, 0, x1 - x0, H);
        g.fillStyle = C.cut;
        g.fillRect(x0, 0, ratio, H);
        g.fillRect(x1 - ratio, 0, ratio, H);
      }
      for (const t of S.edits.splits) { g.fillStyle = C.split; g.fillRect(x(t) - ratio / 2, 0, ratio * 1.5, H); g.fillRect(x(t) - 3 * ratio, 0, 6 * ratio, 4 * ratio); }
      for (const p of S.edits.pauses) {
        const px = x(p.at);
        g.fillStyle = C.pause;
        g.fillRect(px - ratio, 0, 2 * ratio, H);
        g.fillRect(px - 5 * ratio, 0, 10 * ratio, 8 * ratio);
        if (S.selectedPause === p.at) { g.strokeStyle = C.pause; g.lineWidth = 2 * ratio; g.strokeRect(px - 7 * ratio, ratio, 14 * ratio, H - 2 * ratio); }
      }
    }

    const focus = S.focus && S.suggestions().find(x => x.s.key === S.focus)?.s;
    if (focus) {
      const ranges = focus.ranges ?? focus.takes?.map(tk => [tk.start, tk.end]) ?? [[focus.start, focus.end]];
      for (const [a, b] of ranges) {
        const x0 = x(toAxis(a)), x1 = x(toAxis(b, true));
        g.fillStyle = C.focus;
        g.fillRect(x0, 0, Math.max(3 * ratio, x1 - x0), H);
        g.fillStyle = C.focusEdge;
        g.fillRect(x0, H - 3 * ratio, Math.max(3 * ratio, x1 - x0), 3 * ratio);
      }
    }

    const sel = S.selection;
    if (sel) {
      const x0 = x(toAxis(sel.lo)), x1 = x(toAxis(sel.hi));
      g.fillStyle = C.sel;
      g.fillRect(x0, 0, Math.max(2 * ratio, x1 - x0), H);
      g.fillStyle = C.selEdge;
      g.fillRect(x0, 0, ratio, H);
      g.fillRect(x1 - ratio, 0, ratio, H);
    }
    for (const [t, label] of [[S.marks.in, "I"], [S.marks.out, "O"]]) {
      if (t == null) continue;
      const px = x(toAxis(t));
      g.fillStyle = C.selEdge;
      g.fillRect(px, 0, ratio, H);
      g.fillRect(px, 0, 13 * ratio, 15 * ratio);
      g.fillStyle = C.label;
      g.font = `700 ${11 * ratio}px ui-monospace, monospace`;
      g.fillText(label, px + 3.5 * ratio, 11.5 * ratio);
    }
  }

  function renderOverview(W, H) {
    const key = [S.version, mode(), W, H].join("|");
    if (ovBase && key === ovKey) return;
    ovKey = key;
    ovBase ??= document.createElement("canvas");
    ovBase.width = W;
    ovBase.height = H;
    const g = ovBase.getContext("2d");
    g.clearRect(0, 0, W, H);
    const ratio = dpr(), bar = Math.max(1, Math.round(ratio)), mid = H / 2, sp = total();
    g.fillStyle = C.overview;
    if (mode() === "edited") {
      for (let px = 0; px < W; px += bar + 1) {
        const a = (px / W) * sp;
        const src = S.toSource(a), amp = peakIn(peaks, src, src + sp / W);
        const hgt = Math.max(ratio, barHeight(peaks, amp) * H * 0.9);
        g.fillRect(px, mid - hgt / 2, bar, hgt);
      }
    } else {
      for (let px = 0; px < W; px += bar + 1) {
        const a = (px / W) * sp, hgt = Math.max(ratio, barHeight(peaks, peakIn(peaks, a, a + sp / W)) * H * 0.9);
        g.fillRect(px, mid - hgt / 2, bar, hgt);
      }
      g.fillStyle = C.cut;
      for (const [a, b] of S.edits.cuts) g.fillRect((a / sp) * W, H - 2 * ratio, Math.max(ratio, ((b - a) / sp) * W), 2 * ratio);
    }
  }

  function draw() {
    raf = 0;
    if (!canvas.isConnected) return;
    clampView();
    const [W, H] = fit(canvas);
    if (!W || !H) return;
    renderBase(W, H);
    const g = canvas.getContext("2d"), ratio = dpr();
    g.clearRect(0, 0, W, H);
    g.drawImage(base, 0, 0);
    const px = ((playheadAxis() - view.start) / span()) * W;
    g.fillStyle = C.playhead;
    g.fillRect(px - ratio, 0, 2 * ratio, H);
    g.beginPath();
    g.moveTo(px - 6 * ratio, 0); g.lineTo(px + 6 * ratio, 0); g.lineTo(px, 8 * ratio);
    g.fill();

    const [OW, OH] = fit(overview);
    if (OW && OH) {
      renderOverview(OW, OH);
      const o = overview.getContext("2d"), sp = total();
      o.clearRect(0, 0, OW, OH);
      o.drawImage(ovBase, 0, 0);
      if (view.zoom > 1) {
        o.fillStyle = C.window;
        o.fillRect((view.start / sp) * OW, 0, Math.max(3 * ratio, (span() / sp) * OW), OH);
      }
      o.fillStyle = C.playhead;
      o.fillRect((playheadAxis() / sp) * OW - ratio / 2, 0, ratio * 1.5, OH);
    }
    const labels = ruler.children;
    for (let k = 0; k < labels.length; k++) labels[k].textContent = clock(view.start + (span() * k) / (labels.length - 1), 1);
  }

  const invalidate = () => { if (!raf) raf = requestAnimationFrame(draw); };

  function followPlayhead() {
    if (!S.playing || view.zoom <= 1) return;
    const t = playheadAxis();
    if (t < view.start || t > view.start + span() * 0.92) view.start = t - span() * 0.08;
  }

  // ---- interaction -------------------------------------------------------------------------
  const timeAt = e => {
    const r = canvas.getBoundingClientRect();
    return view.start + Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * span();
  };

  function pauseHit(t, e) {
    if (mode() === "edited") {
      const sr = S.sampleRate;
      const it = S.plan.items.find(it => it.pause && t >= it.offset / sr && t < (it.offset + it.length) / sr);
      return it?.pause ?? null;
    }
    const tolerance = (7 / canvas.getBoundingClientRect().width) * span();
    return S.edits.pauses.find(p => Math.abs(p.at - t) <= tolerance) ?? null;
  }

  canvas.addEventListener("pointerdown", e => {
    if (e.button !== 0) return;
    drag = { x: e.clientX, t: timeAt(e), moved: false };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", e => {
    if (!drag || Math.abs(e.clientX - drag.x) <= 3) return;
    drag.moved = true;
    const t = timeAt(e);
    S.select(fromAxis(Math.min(t, drag.t)), fromAxis(Math.max(t, drag.t)));
  });
  canvas.addEventListener("pointerup", e => {
    if (!drag) return;
    const moved = drag.moved, t = timeAt(e);
    drag = null;
    if (moved) return;
    const pause = pauseHit(t, e);
    if (pause) S.selectPause(pause.at);
    if (mode() === "edited") S.seekEdited(t);
    else S.seekSource(t);
  });
  canvas.addEventListener("pointercancel", () => { drag = null; });
  canvas.addEventListener("dblclick", e => {
    const src = fromAxis(timeAt(e));
    const range = keepRanges(S.edits.cuts, S.duration).find(([a, b]) => a <= src && src < b);
    if (!range) return;
    const bounds = [range[0], ...S.edits.splits.filter(s => s > range[0] && s < range[1]), range[1]];
    const k = bounds.findIndex(s => s > src);
    S.select(bounds[k - 1], bounds[k]);
  });
  canvas.addEventListener("wheel", e => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const at = timeAt(e), r = canvas.getBoundingClientRect(), frac = (e.clientX - r.left) / r.width;
      view.zoom *= e.deltaY < 0 ? 1.25 : 0.8;
      clampView();
      view.start = at - frac * span();
    } else if (view.zoom > 1) {
      view.start += ((e.deltaX || e.deltaY) / canvas.clientWidth) * span();
    }
    invalidate();
  }, { passive: false });

  let ovDrag = false;
  const ovSeek = e => {
    const r = overview.getBoundingClientRect();
    const t = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * total();
    if (view.zoom > 1) { view.start = t - span() / 2; invalidate(); }
    else if (mode() === "edited") S.seekEdited(t);
    else S.seekSource(t);
  };
  overview.addEventListener("pointerdown", e => { ovDrag = true; overview.setPointerCapture(e.pointerId); ovSeek(e); });
  overview.addEventListener("pointermove", e => ovDrag && ovSeek(e));
  overview.addEventListener("pointerup", () => { ovDrag = false; });

  const resize = new ResizeObserver(invalidate);
  resize.observe(canvas);
  const offs = [
    S.on("edits", invalidate), S.on("selection", invalidate), S.on("focus", invalidate), S.on("pause", invalidate),
    S.on("view", invalidate), S.on("prefs", invalidate),
    S.on("playhead", () => { followPlayhead(); invalidate(); }),
  ];
  invalidate();

  return {
    zoom(factor) {
      const center = playheadAxis();
      view.zoom *= factor;
      clampView();
      view.start = center - span() / 2;
      invalidate();
    },
    fit() { view.zoom = 1; view.start = 0; invalidate(); },
    invalidate,
    destroy() { resize.disconnect(); offs.forEach(off => off()); cancelAnimationFrame(raf); },
  };
}
