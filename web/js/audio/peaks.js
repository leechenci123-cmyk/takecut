// Waveform peaks at two resolutions, for fast drawing at any zoom level.

const STEP0 = 256, FACTOR = 16;

export function buildPeaks(buffer) {
  const data = buffer.getChannelData(0);
  const n0 = Math.ceil(data.length / STEP0);
  const p0 = new Float32Array(n0);
  for (let k = 0, i = 0; k < n0; k++) {
    const end = Math.min(data.length, (k + 1) * STEP0);
    let m = 0;
    for (; i < end; i++) {
      const v = data[i] < 0 ? -data[i] : data[i];
      if (v > m) m = v;
    }
    p0[k] = m;
  }
  const n1 = Math.ceil(n0 / FACTOR);
  const p1 = new Float32Array(n1);
  let peak = 0;
  for (let k = 0; k < n1; k++) {
    let m = 0;
    for (let i = k * FACTOR, end = Math.min(n0, i + FACTOR); i < end; i++) if (p0[i] > m) m = p0[i];
    p1[k] = m;
    if (m > peak) peak = m;
  }
  return { rate: buffer.sampleRate, levels: [{ step: STEP0, data: p0 }, { step: STEP0 * FACTOR, data: p1 }], peak: Math.max(peak, 0.02) };
}

/** Highest absolute sample in source seconds [a, b). */
export function peakIn(peaks, a, b) {
  const fa = a * peaks.rate, fb = b * peaks.rate;
  const level = (fb - fa) / peaks.levels[1].step >= 3 ? peaks.levels[1] : peaks.levels[0];
  const data = level.data;
  let i = Math.max(0, Math.floor(fa / level.step));
  const j = Math.min(data.length, Math.max(i + 1, Math.ceil(fb / level.step)));
  let m = 0;
  for (; i < j; i++) if (data[i] > m) m = data[i];
  return m;
}

/** Bar height in 0..1, with a square-root curve so quiet speech is still visible. */
export const barHeight = (peaks, amp) => Math.min(1, Math.sqrt(amp / peaks.peak));
