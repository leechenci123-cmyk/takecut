// Browser microphone recorder with pause/resume, live input level metering, and File export.
// Works on http://127.0.0.1 and localhost (secure contexts) using MediaRecorder + Web Audio API.

const MIME_CANDIDATES = [
  { mime: "audio/webm;codecs=opus", ext: "webm" },
  { mime: "audio/webm", ext: "webm" },
  { mime: "audio/ogg;codecs=opus", ext: "ogg" },
  { mime: "audio/mp4", ext: "m4a" },
];

function pickMime() {
  if (typeof MediaRecorder === "undefined") return { mime: "", ext: "webm" };
  for (const c of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported?.(c.mime)) return c;
  }
  return { mime: "", ext: "webm" };
}

function timestampName(ext) {
  const d = new Date();
  const p = n => String(n).padStart(2, "0");
  return `recording-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${ext}`;
}

export class VoiceRecorder {
  constructor() {
    this.state = "idle"; // "idle" | "recording" | "paused"
    this.stream = null;
    this.media = null;
    this.chunks = [];
    this.mime = "";
    this.ext = "webm";
    this.audioCtx = null;
    this.analyser = null;
    this.freqBuf = null;
    this.startedAt = 0;
    this.accumulated = 0;
    this.onState = null;
  }

  static supported() {
    return Boolean(navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined");
  }

  elapsed() {
    if (this.state === "recording") return this.accumulated + (performance.now() - this.startedAt) / 1000;
    return this.accumulated;
  }

  /** Current RMS microphone level in [0, 1] for the live meter. */
  level() {
    if (!this.analyser || this.state !== "recording") return 0;
    this.analyser.getByteTimeDomainData(this.freqBuf);
    let sum = 0;
    for (let i = 0; i < this.freqBuf.length; i++) {
      const v = (this.freqBuf[i] - 128) / 128;
      sum += v * v;
    }
    return Math.min(1, Math.sqrt(sum / this.freqBuf.length) * 3.2);
  }

  _setState(next) {
    this.state = next;
    this.onState?.(next);
  }

  async start() {
    if (this.state !== "idle") return;
    if (!VoiceRecorder.supported()) throw { code: "mic-unsupported" };
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      const code = err?.name === "NotFoundError" ? "mic-missing" : "mic-denied";
      throw { code };
    }
    this.stream = stream;
    this.chunks = [];
    this.accumulated = 0;
    const picked = pickMime();
    this.mime = picked.mime;
    this.ext = picked.ext;
    this.media = this.mime ? new MediaRecorder(stream, { mimeType: this.mime }) : new MediaRecorder(stream);
    this.media.ondataavailable = e => { if (e.data && e.data.size > 0) this.chunks.push(e.data); };

    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = new Ctx();
      const src = this.audioCtx.createMediaStreamSource(stream);
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 512;
      this.freqBuf = new Uint8Array(this.analyser.fftSize);
      src.connect(this.analyser);
    } catch { /* live meter is optional */ }

    this.media.start(250);
    this.startedAt = performance.now();
    this._setState("recording");
  }

  pause() {
    if (this.state !== "recording" || !this.media) return;
    this.accumulated += (performance.now() - this.startedAt) / 1000;
    if (this.media.state === "recording") this.media.pause();
    this._setState("paused");
  }

  resume() {
    if (this.state !== "paused" || !this.media) return;
    if (this.media.state === "paused") this.media.resume();
    this.startedAt = performance.now();
    this._setState("recording");
  }

  togglePause() {
    if (this.state === "recording") this.pause();
    else if (this.state === "paused") this.resume();
  }

  stop() {
    if (this.state === "idle" || !this.media) return Promise.resolve(null);
    const media = this.media;
    const mime = this.mime || media.mimeType || "audio/webm";
    const ext = this.ext;
    if (this.state === "recording") this.accumulated += (performance.now() - this.startedAt) / 1000;

    return new Promise(resolve => {
      media.onstop = () => {
        const blob = new Blob(this.chunks, { type: mime });
        this._cleanup();
        this._setState("idle");
        if (!blob.size) return resolve(null);
        resolve(new File([blob], timestampName(ext), { type: mime }));
      };
      try {
        if (media.state !== "inactive") media.stop();
        else media.onstop();
      } catch {
        this._cleanup();
        this._setState("idle");
        resolve(null);
      }
    });
  }

  cancel() {
    if (this.state === "idle") return;
    if (this.media) {
      this.media.onstop = null;
      this.media.ondataavailable = null;
      try { if (this.media.state !== "inactive") this.media.stop(); } catch { /* ignore */ }
    }
    this._cleanup();
    this._setState("idle");
  }

  _cleanup() {
    this.chunks = [];
    this.accumulated = 0;
    this.stream?.getTracks().forEach(tr => tr.stop());
    this.stream = null;
    this.media = null;
    this.analyser = null;
    this.freqBuf = null;
    this.audioCtx?.close().catch(() => {});
    this.audioCtx = null;
  }
}
