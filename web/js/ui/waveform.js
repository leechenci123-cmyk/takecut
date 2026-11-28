// Waveform with synced captions directly above the soundwave and two views:
// "edited" (what you export: cuts closed up, pauses as violet blocks) and "source" (the full
// recording with cuts shaded red). Click to seek, drag to select, hover or click captions to
// inspect/jump to any word's exact waveform slice, Ctrl+wheel to zoom, wheel to scroll.

import { peakIn, barHeight } from "../audio/peaks.js";
import { keepRanges, overlapsCut } from "../core/timeline.js";
import { buildWaveCaptions, wordAtAxisTime, lineAtAxisTime, findMatchingWords, layoutWordLabels } from "../core/waveCaptions.js";
import { h, clock } from "./dom.js";
import { icon } from "./icons.js";
import { t } from "../i18n.js";

// The dock is dark in both themes, so the waveform uses one fixed palette.
const C = {
  wave: "#a8d68a", waveCut: "rgba(168, 214, 138, 0.22)", cut: "#f07c72", cutFill: "rgba(240, 124, 114, 0.14)",
  pause: "#b49cf5", pauseFill: "rgba(180, 156, 245, 0.22)", sel: "rgba(243, 193, 79, 0.22)", selEdge: "#f3c14f",
  focus: "rgba(115, 178, 239, 0.28)", focusEdge: "#73b2ef", playhead: "#f4f8ee", split: "#73b2ef",
  grid: "rgba(255, 255, 255, 0.05)", label: "#13221c", overview: "rgba(168, 214, 138, 0.55)", window: "rgba(255, 255, 255, 0.12)",
  capLineBg: "rgba(255, 255, 255, 0.06)", capLineActive: "rgba(199, 246, 122, 0.16)", capLineBorder: "rgba(255, 255, 255, 0.10)",
  capLineText: "rgba(232, 241, 236, 0.85)", capLineCut: "rgba(159, 179, 169, 0.45)",
  capWordBg: "rgba(31, 51, 43, 0.92)", capWordBorder: "rgba(168, 214, 138, 0.24)", capWordText: "#e6f1eb",
  capWordCut: "rgba(159, 179, 169, 0.45)",
  capActiveBg: "#c7f67a", capActiveText: "#13221c",
  capHoverBg: "#73b2ef", capHoverText: "#0f1e2a", capHoverWave: "rgba(115, 178, 239, 0.18)",
  capMatchBg: "#f3c14f", capMatchText: "#1e1a0c", capMatchWave: "rgba(243, 193, 79, 0.18)",
  capTick: "rgba(168, 214, 138, 0.35)",
};

function clipText(g, text, maxW) {
  if (maxW <= 4) return "";
  if (g.measureText(text).width <= maxW) return text;
  const ell = "…";
  const ellW = g.measureText(ell).width;
  if (ellW >= maxW) return "";
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (g.measureText(text.slice(0, mid)).width + ellW <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? text.slice(0, lo) + ell : "";
}

function roundRect(g, x, y, w, hgt, r) {
  const rad = Math.min(r, w / 2, hgt / 2);
  g.beginPath();
  g.moveTo(x + rad, y);
  g.arcTo(x + w, y, x + w, y + hgt, rad);
  g.arcTo(x + w, y + hgt, x, y + hgt, rad);
  g.arcTo(x, y + hgt, x, y, rad);
  g.arcTo(x, y, x + w, y, rad);
  g.closePath();
}

export function createWaveform(S, { canvas, captions = null, liveBar = null, overview, ruler, peaks }) {
  const view = S.view;
  let curPeaks = peaks;
  let base = null, baseKey = "", ovBase = null, ovKey = "", raf = 0, drag = null;
  let capCache = null, capKey = "";
  let hoverWord = null, lastLiveKey = "";
  let searchQuery = "", searchMatches = [], searchIdx = -1;

  const dpr = () => window.devicePixelRatio || 1;
  const mode = () => S.prefs.mode;
  const showCaptions = () => S.prefs.showCaptions !== false;
  const total = () => Math.max(0.01, mode() === "edited" ? S.plan.editedDuration : S.duration);
  const span = () => total() / view.zoom;
  const toAxis = (src, after = false) => (mode() === "edited" ? S.toEdited(src, after) : src);
  const fromAxis = t => (mode() === "edited" ? S.toSource(t) : t);
  const playheadAxis = () => (mode() === "edited" ? S.playhead : S.cursorSource);

  function getCaptions() {
    const key = `${S.version}|${mode()}`;
    if (capCache && key === capKey) return capCache;
    capKey = key;
    capCache = buildWaveCaptions(S.words, S.lines, S.edits, S.plan, mode());
    updateSearchMatches(false);
    return capCache;
  }

  function clampView() {
    view.zoom = Math.max(1, Math.min(400, view.zoom));
    view.start = Math.max(0, Math.min(total() - span(), view.start));
  }

  function focusAxisRange(a, b, minZoom = 1) {
    const dur = total();
    const mid = (a + b) / 2;
    if (minZoom > view.zoom) {
      view.zoom = Math.max(1, Math.min(400, Math.min(minZoom, dur / Math.max(0.8, (b - a) * 6))));
    }
    clampView();
    if (view.zoom > 1) {
      const sp = span();
      if (a < view.start + sp * 0.08 || b > view.start + sp * 0.92) {
        view.start = mid - sp / 2;
        clampView();
      }
    }
  }

  function fit(el) {
    const w = Math.round(el.clientWidth * dpr()), hgt = Math.round(el.clientHeight * dpr());
    if (el.width !== w || el.height !== hgt) { el.width = w; el.height = hgt; }
    return [w, hgt];
  }

  // ---- live synced caption readout + word finder bar ----------------------------------------
  let liveTextEl = null, liveHoverEl = null, findInput = null, findCount = null, findPrev = null, findNext = null;
  if (liveBar) {
    liveTextEl = h("div", { class: "wave-live-text" });
    liveHoverEl = h("span", { class: "wave-live-hover" });
    findCount = h("span", { class: "wave-find-count" });
    findPrev = h("button", {
      type: "button", class: "btn ghost small icon-only", title: t("wave.findPrev"), disabled: true,
      onclick: () => jumpMatch(-1),
    }, icon("chevronLeft"));
    findNext = h("button", {
      type: "button", class: "btn ghost small icon-only", title: t("wave.findNext"), disabled: true,
      onclick: () => jumpMatch(1),
    }, icon("arrowRight"));
    findInput = h("input", {
      class: "wave-find-input", type: "search", placeholder: t("wave.findPlaceholder"),
      "aria-label": t("wave.findPlaceholder"),
      oninput: e => {
        searchQuery = e.target.value;
        updateSearchMatches(true);
        invalidate();
      },
      onkeydown: e => {
        e.stopPropagation();
        if (e.key === "Enter") { e.preventDefault(); jumpMatch(e.shiftKey ? -1 : 1); }
        if (e.key === "Escape") {
          searchQuery = "";
          findInput.value = "";
          updateSearchMatches(false);
          findInput.blur();
          invalidate();
        }
      },
    });
    const finder = h("div", { class: "wave-find" }, icon("search"), findInput, findCount, findPrev, findNext);
    liveBar.replaceChildren(liveTextEl, liveHoverEl, finder);
  }

  function updateSearchMatches(jumpFirst) {
    const caps = capCache ?? buildWaveCaptions(S.words, S.lines, S.edits, S.plan, mode());
    searchMatches = searchQuery.trim() ? findMatchingWords(caps.words, searchQuery) : [];
    if (!searchMatches.length) {
      searchIdx = -1;
    } else if (jumpFirst || searchIdx < 0 || searchIdx >= searchMatches.length) {
      searchIdx = 0;
    }
    if (findCount) {
      findCount.textContent = searchQuery.trim()
        ? (searchMatches.length ? `${searchIdx + 1}/${searchMatches.length}` : t("wave.noMatches"))
        : "";
    }
    if (findPrev) findPrev.disabled = searchMatches.length <= 1;
    if (findNext) findNext.disabled = searchMatches.length <= 1;
    if (jumpFirst && searchMatches.length) jumpToWord(searchMatches[0], { zoom: true, play: false });
  }

  function jumpMatch(delta) {
    if (!searchMatches.length) return;
    searchIdx = (searchIdx + delta + searchMatches.length) % searchMatches.length;
    if (findCount) findCount.textContent = `${searchIdx + 1}/${searchMatches.length}`;
    jumpToWord(searchMatches[searchIdx], { zoom: true, play: true });
  }

  function jumpToWord(w, { zoom = false, play = true } = {}) {
    if (!w) return;
    S.selectWords(w.index, w.index);
    if (zoom) {
      const targetZoom = Math.max(view.zoom, Math.min(24, total() / Math.max(3, (w.end - w.start) * 10)));
      focusAxisRange(w.start, w.end, targetZoom);
    } else {
      focusAxisRange(w.start, w.end, view.zoom);
    }
    if (play) S.playWord(w.index);
    else if (mode() === "edited") S.seekEdited(w.start);
    else S.seekSource(w.sourceStart);
    invalidate();
  }

  function renderLiveBar(caps, activeWord, activeLine) {
    if (!liveBar || !liveTextEl) return;
    const matchSet = new Set(searchMatches.map(m => m.index));
    const key = [
      S.version, mode(), activeLine?.index ?? -1, activeWord?.index ?? -1,
      hoverWord?.index ?? -1, searchQuery, searchIdx,
      S.selection ? `${S.selection.lo.toFixed(3)}:${S.selection.hi.toFixed(3)}` : "",
    ].join("|");
    if (key === lastLiveKey) return;
    lastLiveKey = key;

    if (hoverWord) {
      liveHoverEl.textContent = t("wave.hoverWord", {
        word: hoverWord.text, a: clock(hoverWord.start, 2), b: clock(hoverWord.end, 2),
      });
      liveHoverEl.hidden = false;
    } else {
      liveHoverEl.textContent = "";
      liveHoverEl.hidden = true;
    }

    const line = hoverWord
      ? (caps.lines.find(l => l.index === hoverWord.line) ?? activeLine)
      : activeLine;

    if (!line) {
      liveTextEl.replaceChildren(h("span", { class: "wave-live-empty" }, t("wave.noCaption")));
      return;
    }

    const lineWords = caps.words.filter(w => w.line === line.index);
    const sel = S.selection;
    liveTextEl.replaceChildren(
      h("span", { class: "wave-live-ts" }, clock(line.start, 1)),
      ...lineWords.map(w => {
        const isActive = activeWord && activeWord.index === w.index;
        const isHover = hoverWord && hoverWord.index === w.index;
        const isMatch = matchSet.has(w.index);
        const isSel = sel && w.sourceEnd > sel.lo + 1e-5 && w.sourceStart < sel.hi - 1e-5;
        let cls = "wave-live-word";
        if (w.cut) cls += " cut";
        if (isActive) cls += " active";
        if (isHover) cls += " hover";
        if (isMatch || isSel) cls += " match";
        return h("button", {
          type: "button", class: cls, title: `${clock(w.start, 2)} – ${clock(w.end, 2)}`,
          onmouseenter: () => { hoverWord = w; invalidate(); },
          onmouseleave: () => { if (hoverWord?.index === w.index) { hoverWord = null; invalidate(); } },
          onclick: () => jumpToWord(w, { zoom: false, play: true }),
        }, w.text);
      }),
    );
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
          if (sb > sa) amp = Math.max(amp, peakIn(curPeaks, sa, sb));
        }
        if (!amp && silence) { g.fillStyle = C.pause; g.fillRect(px, mid - ratio, bar, 2 * ratio); continue; }
        const hgt = Math.max(1.5 * ratio, barHeight(curPeaks, amp) * H * 0.86);
        g.fillStyle = C.wave;
        g.fillRect(px, mid - hgt / 2, bar, hgt);
      }
    } else {
      for (let px = 0; px < W; px += bar + gap) {
        const a = s0 + (px / W) * sp, b = s0 + ((px + bar) / W) * sp;
        const hgt = Math.max(1.5 * ratio, barHeight(curPeaks, peakIn(curPeaks, a, b)) * H * 0.86);
        const cut = dim && overlapsCut(S.edits.cuts, (a + b) / 2, (a + b) / 2 + 1e-6);
        g.fillStyle = cut ? C.waveCut : C.wave;
        g.fillRect(px, mid - hgt / 2, bar, hgt);
      }
    }
  }

  function renderBase(W, H) {
    const key = [S.version, mode(), view.zoom.toFixed(4), view.start.toFixed(5), W, H, S.selection?.lo, S.selection?.hi,
      S.marks.in, S.marks.out, S.focus, S.selectedPause, searchQuery, curPeaks === peaks ? "0" : "1"].join("|");
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

    if (searchMatches.length) {
      for (const w of searchMatches) {
        if (w.end < s0 || w.start > s0 + sp) continue;
        const x0 = x(w.start), x1 = x(w.end);
        g.fillStyle = C.capMatchWave;
        g.fillRect(x0, 0, Math.max(3 * ratio, x1 - x0), H);
        g.fillStyle = C.capMatchBg;
        g.fillRect(x0, 0, Math.max(3 * ratio, x1 - x0), 2.5 * ratio);
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

  function drawCaptions(caps, activeWord, activeLine) {
    if (!captions) return;
    const visible = showCaptions();
    captions.hidden = !visible;
    if (liveBar) liveBar.hidden = !visible;
    if (!visible) return;
    const [CW, CH] = fit(captions);
    if (!CW || !CH) return;

    const g = captions.getContext("2d"), ratio = dpr(), s0 = view.start, sp = span(), s1 = s0 + sp;
    const x = t => ((t - s0) / sp) * CW;
    g.clearRect(0, 0, CW, CH);

    const lineY = 2 * ratio, lineH = 20 * ratio;
    const wordY = 25 * ratio, wordH = CH - wordY - 3 * ratio;

    // 1. Top lane: synced line / phrase cues
    g.font = `500 ${11 * ratio}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    g.textBaseline = "middle";
    for (const line of caps.lines) {
      if (line.end < s0 || line.start > s1) continue;
      const x0 = Math.max(0, x(line.start));
      const x1 = Math.min(CW, x(line.end));
      const w = x1 - x0;
      if (w < 4 * ratio) continue;
      const isAct = activeLine && activeLine.index === line.index;
      roundRect(g, x0, lineY, Math.max(4 * ratio, w - 2 * ratio), lineH, 4 * ratio);
      g.fillStyle = isAct ? C.capLineActive : C.capLineBg;
      g.fill();
      g.strokeStyle = isAct ? "rgba(199, 246, 122, 0.45)" : C.capLineBorder;
      g.lineWidth = ratio;
      g.stroke();
      if (isAct) {
        g.fillStyle = C.capActiveBg;
        g.fillRect(x0, lineY + 2 * ratio, 2.5 * ratio, lineH - 4 * ratio);
      }
      if (w > 20 * ratio) {
        const label = clipText(g, line.text, w - 12 * ratio);
        if (label) {
          g.fillStyle = line.cut ? C.capLineCut : C.capLineText;
          g.fillText(label, x0 + 6 * ratio, lineY + lineH / 2 + 0.5 * ratio);
        }
      }
    }

    // 2. Bottom lane: word-level synced pills directly above the soundwave peaks
    const visibleWords = caps.words.filter(w => w.end >= s0 && w.start <= s1);
    const matchSet = new Set(searchMatches.map(m => m.index));
    const sel = S.selection;
    const selSet = new Set();
    if (sel) {
      for (const w of visibleWords) {
        if (w.sourceEnd > sel.lo + 1e-5 && w.sourceStart < sel.hi - 1e-5) selSet.add(w.index);
      }
    }
    const priority = new Set([...matchSet, ...selSet]);
    if (activeWord) priority.add(activeWord.index);
    if (hoverWord) priority.add(hoverWord.index);

    g.font = `600 ${11.5 * ratio}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    const padX = 5 * ratio;
    const placed = layoutWordLabels(visibleWords, w => {
      const rx0 = x(w.start), rx1 = x(w.end);
      const rawW = Math.max(2 * ratio, rx1 - rx0);
      const tw = g.measureText(w.text).width;
      const boxW = Math.min(Math.max(rawW, tw + padX * 2), Math.max(rawW, 110 * ratio));
      const mid = (rx0 + rx1) / 2;
      const left = Math.max(1 * ratio, Math.min(CW - boxW - 1 * ratio, mid - boxW / 2));
      return { left, right: left + boxW, rx0, rx1 };
    }, 3 * ratio, priority);

    // Subtle word-boundary ticks along the bottom edge touching the waveform
    g.fillStyle = C.capTick;
    for (const w of visibleWords) {
      const px = x(w.start);
      if (px >= 0 && px <= CW) g.fillRect(px, CH - 3 * ratio, ratio, 3 * ratio);
    }

    for (const item of placed) {
      const w = item.word;
      const isAct = activeWord && activeWord.index === w.index;
      const isHover = hoverWord && hoverWord.index === w.index;
      const isMatch = matchSet.has(w.index) || selSet.has(w.index);
      const boxW = item.right - item.left;

      // Highlight exact audio span bar on the bottom edge of the caption track
      const spanX0 = Math.max(0, item.rx0), spanX1 = Math.min(CW, item.rx1);
      if (isAct || isHover || isMatch) {
        g.fillStyle = isAct ? C.capActiveBg : isHover ? C.capHoverBg : C.capMatchBg;
        g.fillRect(spanX0, CH - 2.5 * ratio, Math.max(3 * ratio, spanX1 - spanX0), 2.5 * ratio);
      }

      roundRect(g, item.left, wordY, boxW, wordH, 5 * ratio);
      if (isAct) {
        g.fillStyle = C.capActiveBg;
        g.fill();
        g.fillStyle = C.capActiveText;
      } else if (isHover) {
        g.fillStyle = C.capHoverBg;
        g.fill();
        g.fillStyle = C.capHoverText;
      } else if (isMatch) {
        g.fillStyle = C.capMatchBg;
        g.fill();
        g.fillStyle = C.capMatchText;
      } else {
        g.fillStyle = C.capWordBg;
        g.fill();
        g.strokeStyle = C.capWordBorder;
        g.lineWidth = ratio;
        g.stroke();
        g.fillStyle = w.cut ? C.capWordCut : C.capWordText;
      }

      const txt = clipText(g, w.text, boxW - padX * 1.6);
      if (txt) {
        const tw = g.measureText(txt).width;
        const tx = item.left + Math.max(padX * 0.8, (boxW - tw) / 2);
        const ty = wordY + wordH / 2 + 0.5 * ratio;
        g.fillText(txt, tx, ty);
        if (w.cut && !isAct && !isHover) {
          g.fillRect(tx, ty, tw, ratio);
        }
      }
    }

    // Playhead continuation line through the caption track
    const px = x(playheadAxis());
    if (px >= -2 && px <= CW + 2) {
      g.fillStyle = C.playhead;
      g.fillRect(px - ratio * 0.75, 0, ratio * 1.5, CH);
    }
  }

  function renderOverview(W, H) {
    const key = [S.version, mode(), W, H, curPeaks === peaks ? "0" : "1"].join("|");
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
        const src = S.toSource(a), amp = peakIn(curPeaks, src, src + sp / W);
        const hgt = Math.max(ratio, barHeight(curPeaks, amp) * H * 0.9);
        g.fillRect(px, mid - hgt / 2, bar, hgt);
      }
    } else {
      for (let px = 0; px < W; px += bar + 1) {
        const a = (px / W) * sp, hgt = Math.max(ratio, barHeight(curPeaks, peakIn(curPeaks, a, a + sp / W)) * H * 0.9);
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
    const caps = getCaptions();
    const axisNow = playheadAxis();
    const activeWord = wordAtAxisTime(caps.words, axisNow, 0.015);
    const activeLine = lineAtAxisTime(caps.lines, axisNow);

    renderLiveBar(caps, activeWord, activeLine);
    drawCaptions(caps, activeWord, activeLine);

    const [W, H] = fit(canvas);
    if (!W || !H) return;
    renderBase(W, H);
    const g = canvas.getContext("2d"), ratio = dpr(), s0 = view.start, sp = span();
    const x = t => ((t - s0) / sp) * W;
    g.clearRect(0, 0, W, H);
    g.drawImage(base, 0, 0);

    // Subtle vertical alignment column for the active or hovered word on the soundwave
    const guide = hoverWord ?? (S.playing ? activeWord : null);
    if (guide && showCaptions() && guide.end >= s0 && guide.start <= s0 + sp) {
      const gx0 = x(guide.start), gx1 = x(guide.end);
      g.fillStyle = hoverWord ? C.capHoverWave : "rgba(199, 246, 122, 0.12)";
      g.fillRect(gx0, 0, Math.max(2 * ratio, gx1 - gx0), H);
      g.fillStyle = hoverWord ? C.capHoverBg : "rgba(199, 246, 122, 0.45)";
      g.fillRect(gx0, 0, ratio, H);
      g.fillRect(gx1 - ratio, 0, ratio, H);
    }

    const px = x(axisNow);
    g.fillStyle = C.playhead;
    g.fillRect(px - ratio, 0, 2 * ratio, H);
    g.beginPath();
    g.moveTo(px - 6 * ratio, 0); g.lineTo(px + 6 * ratio, 0); g.lineTo(px, 8 * ratio);
    g.fill();

    const [OW, OH] = fit(overview);
    if (OW && OH) {
      renderOverview(OW, OH);
      const o = overview.getContext("2d"), full = total();
      o.clearRect(0, 0, OW, OH);
      o.drawImage(ovBase, 0, 0);
      if (view.zoom > 1) {
        o.fillStyle = C.window;
        o.fillRect((view.start / full) * OW, 0, Math.max(3 * ratio, (span() / full) * OW), OH);
      }
      o.fillStyle = C.playhead;
      o.fillRect((axisNow / full) * OW - ratio / 2, 0, ratio * 1.5, OH);
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
  const timeAtEl = (el, e) => {
    const r = el.getBoundingClientRect();
    return view.start + Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * span();
  };
  const timeAt = e => timeAtEl(canvas, e);

  function pauseHit(t) {
    if (mode() === "edited") {
      const sr = S.sampleRate;
      const it = S.plan.items.find(it => it.pause && t >= it.offset / sr && t < (it.offset + it.length) / sr);
      return it?.pause ?? null;
    }
    const tolerance = (7 / canvas.getBoundingClientRect().width) * span();
    return S.edits.pauses.find(p => Math.abs(p.at - t) <= tolerance) ?? null;
  }

  function handleWheel(el, e) {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const at = timeAtEl(el, e), r = el.getBoundingClientRect(), frac = (e.clientX - r.left) / r.width;
      view.zoom *= e.deltaY < 0 ? 1.25 : 0.8;
      clampView();
      view.start = at - frac * span();
    } else if (view.zoom > 1) {
      view.start += ((e.deltaX || e.deltaY) / el.clientWidth) * span();
    }
    invalidate();
  }

  canvas.addEventListener("pointerdown", e => {
    if (e.button !== 0) return;
    drag = { x: e.clientX, t: timeAt(e), moved: false };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", e => {
    const t = timeAt(e);
    if (showCaptions()) {
      const next = wordAtAxisTime(getCaptions().words, t, 0.03);
      if (next?.index !== hoverWord?.index) { hoverWord = next; invalidate(); }
    }
    if (!drag || Math.abs(e.clientX - drag.x) <= 3) return;
    drag.moved = true;
    S.select(fromAxis(Math.min(t, drag.t)), fromAxis(Math.max(t, drag.t)));
  });
  canvas.addEventListener("pointerleave", () => {
    if (hoverWord) { hoverWord = null; invalidate(); }
  });
  canvas.addEventListener("pointerup", e => {
    if (!drag) return;
    const moved = drag.moved, t = timeAt(e);
    drag = null;
    if (moved) return;
    const pause = pauseHit(t);
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
  canvas.addEventListener("wheel", e => handleWheel(canvas, e), { passive: false });

  if (captions) {
    captions.addEventListener("pointermove", e => {
      const t = timeAtEl(captions, e);
      const w = wordAtAxisTime(getCaptions().words, t, Math.max(0.03, span() * 0.008));
      captions.style.cursor = w ? "pointer" : "default";
      if (w?.index !== hoverWord?.index) { hoverWord = w; invalidate(); }
    });
    captions.addEventListener("pointerleave", () => {
      if (hoverWord) { hoverWord = null; invalidate(); }
    });
    captions.addEventListener("click", e => {
      const t = timeAtEl(captions, e);
      const caps = getCaptions();
      const w = wordAtAxisTime(caps.words, t, Math.max(0.03, span() * 0.008));
      if (w) return jumpToWord(w, { zoom: false, play: true });
      const line = lineAtAxisTime(caps.lines, t, 0.05);
      if (line) {
        S.select(line.sourceStart, line.sourceEnd, [line.ids[0], line.ids.at(-1)]);
        S.playRange(line.sourceStart, line.sourceEnd, "line");
      } else if (mode() === "edited") {
        S.seekEdited(t);
      } else {
        S.seekSource(t);
      }
    });
    captions.addEventListener("dblclick", e => {
      const t = timeAtEl(captions, e);
      const w = wordAtAxisTime(getCaptions().words, t, Math.max(0.03, span() * 0.008));
      if (w) jumpToWord(w, { zoom: true, play: true });
    });
    captions.addEventListener("wheel", e => handleWheel(captions, e), { passive: false });
  }

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
  if (captions) resize.observe(captions);
  const offs = [
    S.on("edits", invalidate),
    S.on("selection", () => {
      if (S.selection && view.zoom > 1) focusAxisRange(toAxis(S.selection.lo), toAxis(S.selection.hi), view.zoom);
      invalidate();
    }),
    S.on("focus", invalidate),
    S.on("pause", invalidate),
    S.on("view", invalidate),
    S.on("prefs", invalidate),
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
    setPeaks(nextPeaks) {
      curPeaks = nextPeaks;
      baseKey = "";
      ovKey = "";
      invalidate();
    },
    invalidate,
    destroy() { resize.disconnect(); offs.forEach(off => off()); cancelAnimationFrame(raf); },
  };
}
