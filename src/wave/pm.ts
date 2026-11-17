// Palm-mute analysis of the recorded signal: finds note attacks and measures how fast each note dies away.
// A palm-muted note loses 20 dB in roughly 0.1–0.3 s; an open string rings for a second or more.
import type { SampleStore } from "./store";

/** Envelope hop, seconds. */
const HOP_S = 0.005;
/** RMS window, in hops (20 ms: long enough to smooth the low E period). */
const WIN = 4;
const GATE_DB = -55;
const ONSET_RISE_DB = 8;
const ONSET_LOOKBACK = 8;
const REFRACTORY = 16;
const PEAK_SEARCH = 8;

export interface PmNote {
  /** Sample index of the attack. */
  start: number;
  peakDb: number;
  /** Seconds from the peak until the level is 20 dB lower (measured, or extrapolated from the slope). */
  t20: number | null;
  t20Measured: boolean;
  /** Decay rate, dB per second. */
  rate: number | null;
  /** Share of spectral energy above the 3rd harmonic, 0..1. */
  bright: number | null;
  f0: number | null;
  /**
   * Seconds from the pick touching the string (first rise above the background) to the note
   * actually sounding (level reaching half of the attack peak).
   */
  attack: number | null;
  /** The note has stopped changing: it decayed or the next one started. */
  done: boolean;
}

export class PmAnalyzer {
  readonly hop: number;
  private hopEnergy = new Float64Array(1 << 14);
  env = new Float32Array(1 << 14);
  frames = 0;
  notes: PmNote[] = [];
  private lastOnset = -1e9;
  /** Bumped whenever a note is added or changes. */
  version = 0;

  constructor(readonly sr: number) {
    this.hop = Math.round(sr * HOP_S);
  }

  reset() {
    this.frames = 0;
    this.notes = [];
    this.lastOnset = -1e9;
    this.version++;
  }

  private grow() {
    const e = new Float64Array(this.hopEnergy.length * 2);
    e.set(this.hopEnergy);
    this.hopEnergy = e;
    const v = new Float32Array(this.env.length * 2);
    v.set(this.env);
    this.env = v;
  }

  update(store: SampleStore) {
    const H = this.hop;
    const avail = Math.floor(store.length / H);
    if (avail < this.frames) this.reset();
    if (avail === this.frames) return;
    const first = this.frames;
    while (this.frames < avail) {
      const k = this.frames;
      if (k >= this.env.length) this.grow();
      let ss = 0;
      for (let i = k * H, e = i + H; i < e; i++) {
        const v = store.at(i);
        ss += v * v;
      }
      this.hopEnergy[k] = ss;
      let sum = 0, n = 0;
      for (let j = Math.max(0, k - WIN + 1); j <= k; j++) (sum += this.hopEnergy[j]), n++;
      this.env[k] = 10 * Math.log10(sum / (n * H) + 1e-12);
      this.frames++;
      this.detectOnset(k, store);
    }
    // Re-measure notes that are still ringing.
    for (let i = this.notes.length - 1; i >= 0; i--) {
      const n = this.notes[i];
      if (n.done) break;
      this.measure(n, i, store);
    }
    if (first !== this.frames) this.version++;
  }

  private detectOnset(k: number, store: SampleStore) {
    if (k < ONSET_LOOKBACK || k - this.lastOnset < REFRACTORY) return;
    const e = this.env;
    if (e[k] < GATE_DB) return;
    let lo = Infinity;
    for (let j = k - ONSET_LOOKBACK; j <= k - 2; j++) lo = Math.min(lo, e[j]);
    if (e[k] - lo < ONSET_RISE_DB) return;
    // A real attack also beats the level from before the dip; a brief dropout does not.
    let before = -Infinity;
    for (let j = Math.max(0, k - 24); j < k - ONSET_LOOKBACK; j++) before = Math.max(before, e[j]);
    if (e[k] < before + 3) return;
    // Back up to where the rise began.
    let on = k;
    while (on > k - ONSET_LOOKBACK && e[on - 1] > lo + 3) on--;
    this.lastOnset = k;
    const prev = this.notes.at(-1);
    if (prev && !prev.done) {
      this.measure(prev, this.notes.length - 1, store, on);
      prev.done = true;
    }
    this.notes.push({ start: on * this.hop, peakDb: e[k], t20: null, t20Measured: false, rate: null, bright: null, f0: null, attack: null, done: false });
    if (this.notes.length > 2000) this.notes.shift();
  }

  /** endFrame: the next note's attack, if known. */
  private measure(n: PmNote, idx: number, store: SampleStore, endFrame?: number) {
    const e = this.env;
    const H = this.hop;
    const s = n.start / H;
    const next = this.notes[idx + 1];
    const end = endFrame ?? (next ? next.start / H : this.frames);
    // Peak within the attack.
    let pk = s;
    for (let j = s; j < Math.min(end, s + PEAK_SEARCH); j++) if (e[j] > e[pk]) pk = j;
    if (pk >= end - 1) return;
    n.peakDb = e[pk];
    const floor = Math.max(GATE_DB - 5, n.peakDb - 50);

    let t20 = -1;
    let fitFrom = -1, fitTo = end - 1;
    for (let j = pk + 1; j < end; j++) {
      if (fitFrom < 0 && e[j] <= n.peakDb - 3) fitFrom = j;
      if (t20 < 0 && e[j] <= n.peakDb - 20) t20 = j;
      if (e[j] <= n.peakDb - 30 || e[j] <= floor) {
        fitTo = j;
        if (!n.done && endFrame === undefined) n.done = true;
        break;
      }
    }
    if (fitFrom >= 0 && fitTo - fitFrom >= 5) {
      let mt = 0, my = 0;
      const cnt = fitTo - fitFrom + 1;
      for (let j = fitFrom; j <= fitTo; j++) (mt += j), (my += e[j]);
      mt /= cnt;
      my /= cnt;
      let num = 0, den = 0;
      for (let j = fitFrom; j <= fitTo; j++) (num += (j - mt) * (e[j] - my)), (den += (j - mt) ** 2);
      const slope = den > 0 ? num / den : 0; // dB per frame
      n.rate = Math.max(0, (-slope * this.sr) / H);
    }
    if (t20 >= 0) {
      n.t20 = ((t20 - pk) * H) / this.sr;
      n.t20Measured = true;
    } else if (n.rate && n.rate > 0.5) {
      n.t20 = 20 / n.rate;
      n.t20Measured = false;
    }
    if (n.bright === null && end - s >= 0.06 / HOP_S) this.spectrum(n, store);
    if (n.attack === null && end - s > PEAK_SEARCH) n.attack = this.attackTime(n, store, (pk + 1) * H);
  }

  private attackTime(n: PmNote, store: SampleStore, peakEnd: number) {
    const B = Math.max(8, Math.round(this.sr * 0.0005)); // 0.5 ms peak-hold blocks
    const from = Math.max(0, n.start - Math.round(this.sr * 0.08));
    const to = Math.min(store.length, peakEnd);
    const nb = Math.floor((to - from) / B);
    if (nb < 8) return null;
    const a = new Float32Array(nb);
    for (let b = 0; b < nb; b++) {
      let m = 0;
      for (let i = from + b * B, e = i + B; i < e; i++) m = Math.max(m, Math.abs(store.at(i)));
      a[b] = m;
    }
    let peak = 0;
    for (let b = 0; b < nb; b++) peak = Math.max(peak, a[b]);
    // The note sounds once the level reaches a fifth of the attack peak (low enough that the
    // first waveform crest, not the waveform phase, decides it).
    let sound = -1;
    // Start near the detected attack so the previous note's tail is not taken for this one.
    const near = Math.max(0, Math.floor((n.start - from - this.sr * 0.015) / B));
    for (let b = near; b < nb; b++)
      if (a[b] >= peak / 5) {
        sound = b;
        break;
      }
    if (sound < 4) return null;
    // Background: the quietest 10 ms stretch before that, then walk back from the note
    // while the signal stays clearly above it — that is the pick on the string.
    const span = Math.max(4, Math.round(0.01 / (B / this.sr)));
    let floor = Infinity;
    for (let b = 0; b + span <= sound; b++) {
      let m = 0;
      for (let j = b; j < b + span; j++) m = Math.max(m, a[j]);
      floor = Math.min(floor, m);
    }
    if (!isFinite(floor)) floor = a[0];
    // The previous note is still ringing loudly: the pick noise is buried under it.
    if (floor > peak * 0.12) return null;
    const thr = Math.max(floor * 2, 1e-4);
    let touch = sound;
    while (touch > 0 && a[touch - 1] > thr) touch--;
    return ((sound - touch) * B) / this.sr;
  }

  private spectrum(n: PmNote, store: SampleStore) {
    const N = 2048;
    const from = n.start + Math.round(this.sr * 0.01);
    if (from + N > store.length) return;
    const x = store.slice(from, from + N);
    // f0 by normalized autocorrelation, 70–1000 Hz.
    const minLag = Math.floor(this.sr / 1000), maxLag = Math.min(Math.ceil(this.sr / 70), N / 2);
    let e0 = 0;
    for (let i = 0; i < N / 2; i++) e0 += x[i] * x[i];
    let best = 0, bestLag = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let c = 0, el = 0;
      for (let i = 0; i < N / 2; i++) (c += x[i] * x[i + lag]), (el += x[i + lag] * x[i + lag]);
      const r = c / Math.sqrt(e0 * el + 1e-12);
      if (r > best) (best = r), (bestLag = lag);
    }
    if (best < 0.5 || !bestLag) return;
    n.f0 = this.sr / bestLag;
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = x[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
    fft(re, im);
    const binHz = this.sr / N;
    const cut = (3.5 * n.f0) / binHz, lowCut = (0.5 * n.f0) / binHz, top = 8000 / binHz;
    let total = 0, high = 0;
    for (let b = Math.ceil(lowCut); b < Math.min(N / 2, top); b++) {
      const p = re[b] * re[b] + im[b] * im[b];
      total += p;
      if (b >= cut) high += p;
    }
    n.bright = total > 0 ? high / total : null;
  }
}

function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

/** Palm mute when the note loses 20 dB faster than limitS. */
export const isPalmMuted = (n: PmNote, limitS: number) => (n.t20 === null ? null : n.t20 <= limitS);
