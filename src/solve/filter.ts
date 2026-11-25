// Offline signal cleanup. Because we process a whole clip at once we can run
// filters forwards *and* backwards and average them, which cancels the lag a
// realtime filter would introduce (fast moves stay on the beat).

import type { Quat } from "../math/math3d";
import { qDot, qNorm } from "../math/math3d";

/** Linearly fill NaN gaps; leading/trailing gaps take the nearest valid value. */
export function fillGaps(xs: Float64Array): boolean {
  const n = xs.length;
  let first = -1;
  for (let i = 0; i < n; i++) if (!Number.isNaN(xs[i])) { first = i; break; }
  if (first < 0) return false;
  for (let i = 0; i < first; i++) xs[i] = xs[first];
  let prev = first;
  for (let i = first + 1; i < n; i++) {
    if (Number.isNaN(xs[i])) continue;
    if (i - prev > 1) {
      for (let k = prev + 1; k < i; k++) xs[k] = xs[prev] + ((xs[i] - xs[prev]) * (k - prev)) / (i - prev);
    }
    prev = i;
  }
  for (let i = prev + 1; i < n; i++) xs[i] = xs[prev];
  return true;
}

function oneEuroPass(xs: Float64Array, rate: number, minCutoff: number, beta: number, reverse: boolean): Float64Array {
  const n = xs.length;
  const out = new Float64Array(n);
  const alpha = (cutoff: number) => {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau * rate);
  };
  const aD = alpha(1.0);
  let xPrev = 0, dxPrev = 0;
  for (let k = 0; k < n; k++) {
    const i = reverse ? n - 1 - k : k;
    const x = xs[i];
    if (k === 0) {
      xPrev = x;
      dxPrev = 0;
      out[i] = x;
      continue;
    }
    const dx = (x - xPrev) * rate;
    const dxHat = dxPrev + aD * (dx - dxPrev);
    const cutoff = minCutoff + beta * Math.abs(dxHat);
    const a = alpha(cutoff);
    const xHat = xPrev + a * (x - xPrev);
    out[i] = xHat;
    xPrev = xHat;
    dxPrev = dxHat;
  }
  return out;
}

/** Zero-phase One Euro filter (forward + backward average). */
export function oneEuroZeroPhase(xs: Float64Array, rate: number, minCutoff: number, beta: number): Float64Array {
  if (minCutoff >= rate) return xs.slice();
  const f = oneEuroPass(xs, rate, minCutoff, beta, false);
  const b = oneEuroPass(xs, rate, minCutoff, beta, true);
  const out = new Float64Array(xs.length);
  for (let i = 0; i < xs.length; i++) out[i] = (f[i] + b[i]) / 2;
  return out;
}

/** Gaussian smoothing of a scalar series (sigma in samples). */
export function gaussianSmooth(xs: Float64Array, sigma: number): Float64Array {
  if (sigma <= 0.01) return xs.slice();
  const r = Math.ceil(sigma * 3);
  const w: number[] = [];
  for (let k = -r; k <= r; k++) w.push(Math.exp(-(k * k) / (2 * sigma * sigma)));
  const n = xs.length;
  const out = new Float64Array(n);
  // Odd reflection at the ends preserves linear trends (no drift toward the interior).
  const at = (j: number): number => {
    if (n === 1) return xs[0];
    if (j < 0) return 2 * xs[0] - xs[Math.min(n - 1, -j)];
    if (j >= n) return 2 * xs[n - 1] - xs[Math.max(0, 2 * n - 2 - j)];
    return xs[j];
  };
  for (let i = 0; i < n; i++) {
    let s = 0, ws = 0;
    for (let k = -r; k <= r; k++) {
      s += at(i + k) * w[k + r];
      ws += w[k + r];
    }
    out[i] = s / ws;
  }
  return out;
}

/** Gaussian smoothing of a quaternion track (hemisphere-aligned weighted average). */
export function smoothQuats(qs: Quat[], sigma: number): Quat[] {
  if (sigma <= 0.01 || qs.length < 3) return qs.map((q) => [...q] as Quat);
  // Make the track continuous on the hypersphere first.
  const aligned: Quat[] = [qs[0]];
  for (let i = 1; i < qs.length; i++) {
    const q = qs[i];
    aligned.push(qDot(aligned[i - 1], q) < 0 ? [-q[0], -q[1], -q[2], -q[3]] : q);
  }
  const r = Math.ceil(sigma * 3);
  const w: number[] = [];
  for (let k = -r; k <= r; k++) w.push(Math.exp(-(k * k) / (2 * sigma * sigma)));
  return aligned.map((_, i) => {
    const acc: Quat = [0, 0, 0, 0];
    for (let k = -r; k <= r; k++) {
      const j = i + k;
      if (j < 0 || j >= aligned.length) continue;
      const wk = w[k + r];
      for (let c = 0; c < 4; c++) acc[c] += aligned[j][c] * wk;
    }
    return qNorm(acc);
  });
}

/** Map a 0..100 "smoothing" slider to a One Euro min cutoff in Hz (log scale). */
export const smoothingToCutoff = (s: number) => 12 * Math.pow(0.02, s / 100);
