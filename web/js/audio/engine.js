// Web Audio playback. The edited timeline is played by scheduling one AudioBufferSourceNode per
// kept piece of the original buffer: nothing is copied, so edits apply instantly and memory stays
// at one decoded copy. Every piece gets a 3 ms fade in and out, like the exported file.

import { segments } from "../core/timeline.js";

const FADE = 0.003;
const LEAD = 0.04; // seconds of scheduling headroom

export class Engine {
  constructor() {
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC({ sampleRate: 44100, latencyHint: "interactive" });
    this.buffer = null;
    this.nodes = [];
    this.run = null; // {kind: "edited" | "source", from, to, t0, loop, plan, tag}
    this.timer = 0;
    this.onended = null;
  }

  async load(url) {
    const res = await fetch(url);
    if (!res.ok) throw Object.assign(new Error("audio"), { code: "audio" });
    const data = await res.arrayBuffer();
    try {
      this.buffer = await this.ctx.decodeAudioData(data);
    } catch {
      throw Object.assign(new Error("audio"), { code: "audio" });
    }
    return this.buffer;
  }

  get playing() {
    return !!this.run;
  }

  stop() {
    clearTimeout(this.timer);
    for (const node of this.nodes) {
      try { node.stop(); } catch { /* already stopped */ }
      node.disconnect();
    }
    this.nodes = [];
    this.run = null;
  }

  piece(start, offset, duration) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    const gain = this.ctx.createGain();
    src.connect(gain).connect(this.ctx.destination);
    const f = Math.min(FADE, duration / 2), end = start + duration;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(1, start + f);
    gain.gain.setValueAtTime(1, end - f);
    gain.gain.linearRampToValueAtTime(0, end);
    src.start(start, offset, duration);
    this.nodes.push(src);
  }

  schedule(run) {
    for (const node of this.nodes) node.disconnect();
    this.nodes = [];
    run.t0 = this.ctx.currentTime + LEAD;
    if (run.kind === "source") this.piece(run.t0, run.from, run.to - run.from);
    else for (const seg of segments(run.plan, run.from, run.to)) if (!seg.silence) this.piece(run.t0 + seg.at, seg.source, seg.duration);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.finish(run), Math.max(0, (run.t0 + run.to - run.from - this.ctx.currentTime) * 1000));
  }

  finish(run) {
    if (this.run !== run) return;
    if (run.loop) return this.schedule(run);
    this.stop();
    this.onended?.(run);
  }

  async start(run) {
    this.stop();
    if (!this.buffer || !(run.to - run.from > 0.005)) return false;
    await this.ctx.resume();
    this.run = run;
    this.schedule(run);
    return true;
  }

  /** Play edited seconds [from, to). */
  playEdited(plan, from, to, { loop = false, tag = "" } = {}) {
    const end = Math.min(to, plan.editedDuration);
    return this.start({ kind: "edited", plan, from: Math.max(0, from), to: end, loop, tag });
  }

  /** Play source seconds [a, b) of the original recording, ignoring edits. */
  playSource(a, b, { tag = "" } = {}) {
    return this.start({ kind: "source", from: Math.max(0, a), to: Math.min(this.buffer?.duration ?? 0, b), loop: false, tag });
  }

  /** Current position on the running timeline (edited or source seconds), or null. */
  position() {
    const run = this.run;
    if (!run) return null;
    const elapsed = Math.max(0, this.ctx.currentTime - run.t0), length = run.to - run.from;
    return run.from + (run.loop ? elapsed % length : Math.min(elapsed, length));
  }

  close() {
    this.stop();
    this.ctx.close?.();
  }
}
