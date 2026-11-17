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
/** A second pick hit beats everything in the period before it by this energy ratio. */
const DOUBLE_K = 2.5;
/** Spectral-flux onsets: FFT size, compared frame lag (hops), bins up to this frequency. */
const FLUX_N = 1024;
const FLUX_LAG = 2;
const FLUX_TOP_HZ = 6000;
/** Flux must beat FLUX_K × the recent average plus FLUX_MIN (per bin) to count as a pick hit… */
const FLUX_K = 2;
const FLUX_MIN = 0.01;
/** …or rise above it while high frequencies jump HF_K-fold (a pick hit buried in a distorted chord). */
const HF_K = 3;

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
  /** Peak of the normalized autocorrelation: near 1 for a clear pitch, low when the note is just a thud. */
  pitchClarity: number | null;
  /**
   * Seconds from the pick touching the string (first rise above the background) to the note
   * actually sounding (level reaching half of the attack peak).
   */
  attack: number | null;
  /** Sample indices (in the take) of the pick touching the string and of the note sounding. */
  touchAt: number | null;
  soundAt: number | null;
  /** Seconds between two pick hits when the string was struck twice; null for a clean single attack. */
  doubleGap: number | null;
  /** Sample index of an earlier trigger this note was moved from (the pick stopping the string first). */
  lead: number | null;
  /** The double-attack check has run. */
  doubleChecked: boolean;
  /** The note has stopped changing: it decayed or the next one started. */
  done: boolean;
}

export class PmAnalyzer {
  readonly hop: number;
  private hopEnergy = new Float64Array(1 << 14);
  /** High-frequency (second-difference) energy per hop: locates the pick transient. */
  private hopHf = new Float64Array(1 << 14);
  /** Spectral flux per hop, and the log spectra of the last FLUX_LAG + 1 hops (ring). */
  flux = new Float32Array(1 << 14);
  private logSpec: Float32Array[] = [];
  private fftRe = new Float64Array(FLUX_N);
  private fftIm = new Float64Array(FLUX_N);
  private win = new Float64Array(FLUX_N).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FLUX_N - 1)));
  env = new Float32Array(1 << 14);
  frames = 0;
  notes: PmNote[] = [];
  private lastOnset = -1e9;
  /** Notes whose pitch has been measured (once: the window is complete by then). */
  private pitched = new WeakSet<PmNote>();
  /** Bumped whenever a note is added or changes. */
  version = 0;

  constructor(readonly sr: number) {
    this.hop = Math.round(sr * HOP_S);
  }

  reset() {
    this.frames = 0;
    this.notes = [];
    this.lastOnset = -1e9;
    this.logSpec = [];
    this.version++;
  }

  private grow() {
    const e = new Float64Array(this.hopEnergy.length * 2);
    e.set(this.hopEnergy);
    this.hopEnergy = e;
    const h = new Float64Array(this.hopHf.length * 2);
    h.set(this.hopHf);
    this.hopHf = h;
    const f = new Float32Array(this.flux.length * 2);
    f.set(this.flux);
    this.flux = f;
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
      let ss = 0, hf = 0;
      for (let i = k * H, e = i + H; i < e; i++) {
        const v = store.at(i);
        ss += v * v;
        if (i >= 2) {
          const d = v - 2 * store.at(i - 1) + store.at(i - 2);
          hf += d * d;
        }
      }
      this.hopEnergy[k] = ss;
      this.hopHf[k] = hf;
      this.flux[k] = this.spectralFlux(k, store);
      let sum = 0, n = 0;
      for (let j = Math.max(0, k - WIN + 1); j <= k; j++) (sum += this.hopEnergy[j]), n++;
      this.env[k] = 10 * Math.log10(sum / (n * H) + 1e-12);
      this.frames++;
      this.detectOnset(k, store);
      this.detectFluxOnset(k - 1, store);
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
    if (k < ONSET_LOOKBACK) return;
    const e = this.env;
    if (e[k] < GATE_DB) return;
    let lo = Infinity;
    for (let j = k - ONSET_LOOKBACK; j <= k - 2; j++) lo = Math.min(lo, e[j]);
    if (e[k] - lo < ONSET_RISE_DB) return;
    if (k - this.lastOnset < REFRACTORY) {
      // The pick stopping a ringing string can trip the flux detector before the hit itself: a much
      // louder attack right after moves the note to it (the pick time stays part of its attack).
      const prev = this.notes.at(-1);
      if (!prev || prev.done || e[k] < this.env[prev.start / this.hop] + 3) return;
      let on = k;
      while (on > k - ONSET_LOOKBACK && e[on - 1] > lo + 3) on--;
      const moved = this.newNote(on);
      moved.lead = prev.start;
      this.notes[this.notes.length - 1] = moved;
      this.lastOnset = k;
      this.version++;
      return;
    }
    // A real attack also beats the level from before the dip; a brief dropout does not.
    let before = -Infinity;
    for (let j = Math.max(0, k - 24); j < k - ONSET_LOOKBACK; j++) before = Math.max(before, e[j]);
    if (e[k] < before + 3) return;
    // Back up to where the rise began.
    let on = k;
    while (on > k - ONSET_LOOKBACK && e[on - 1] > lo + 3) on--;
    this.lastOnset = k;
    const prev = this.notes.at(-1);
    // Pick noise before a slow attack can trip the detector on its own: a much quieter "note" just
    // before this one is the start of this attack, not a note.
    if (prev && k - prev.start / this.hop < 0.15 / HOP_S && prev.peakDb < e[k] - 10) {
      this.notes.pop();
      this.version++;
      const before = this.notes.at(-1);
      if (before && !before.done) this.measure(before, this.notes.length - 1, store, on);
      this.notes.push(this.newNote(on));
      return;
    }
    if (prev && !prev.done) {
      this.measure(prev, this.notes.length - 1, store, on);
      prev.done = true;
    }
    this.notes.push(this.newNote(on));
    if (this.notes.length > 2000) this.notes.shift();
  }

  /**
   * Sum of positive changes of the log spectrum against FLUX_LAG hops earlier, per bin. A pick hit
   * changes the spectrum even when the level hardly moves: a ringing string struck again, a second
   * string joining, or a distorted (compressed) tone.
   */
  private spectralFlux(k: number, store: SampleStore) {
    const N = FLUX_N, end = (k + 1) * this.hop;
    const re = this.fftRe, im = this.fftIm;
    for (let i = 0; i < N; i++) {
      const j = end - N + i;
      re[i] = j >= 0 ? store.at(j) * this.win[i] : 0;
      im[i] = 0;
    }
    fft(re, im);
    const top = Math.min(N / 2, Math.round((FLUX_TOP_HZ * N) / this.sr));
    const spec = this.logSpec.length > FLUX_LAG ? this.logSpec.shift()! : new Float32Array(top);
    // Amplitude scale (Hann sum = N/2) and log compression: ≈0 for the noise, ≈1–3 for notes.
    const scale = 4 / N;
    for (let b = 1; b < top; b++) spec[b] = Math.log10(1 + 1000 * scale * Math.hypot(re[b], im[b]));
    this.logSpec.push(spec);
    if (this.logSpec.length <= FLUX_LAG) return 0;
    const old = this.logSpec[0];
    let f = 0;
    for (let b = 1; b < top; b++) {
      const d = spec[b] - old[b];
      if (d > 0) f += d;
    }
    return f / top;
  }

  /** Flux peak at hop k (needs k + 1): a new pick hit even if the level barely rose. */
  private detectFluxOnset(k: number, store: SampleStore) {
    if (k < 40 || k - this.lastOnset < REFRACTORY) return;
    const f = this.flux;
    if (!(f[k] >= f[k - 1] && f[k] > f[k + 1])) return;
    let avg = 0;
    for (let j = k - 40; j < k - 3; j++) avg += f[j];
    avg /= 37;
    // A pick hit also shows as a burst of high frequencies over the last 20 ms (longer than a low-E period).
    let hfBefore = 0;
    for (let j = k - 8; j < k - 4; j++) hfBefore = Math.max(hfBefore, this.hopHf[j]);
    let hfNow = 0;
    for (let j = k - 4; j <= k; j++) hfNow = Math.max(hfNow, this.hopHf[j]);
    const hfJump = hfNow > HF_K * hfBefore;
    if (f[k] < FLUX_K * avg + FLUX_MIN && !(hfJump && f[k] > avg * 1.2)) return;
    const e = this.env;
    if (e[k] < GATE_DB) return;
    // The flux window trails the hit; the hit itself is the sharpest jump of high frequencies just before.
    let on = k, best = -Infinity;
    for (let j = Math.max(1, k - 5); j <= k; j++) {
      const jump = Math.log10((this.hopHf[j] + 1e-15) / (this.hopHf[j - 1] + 1e-15));
      if (jump > best) (best = jump), (on = j);
    }
    if (on - this.lastOnset < REFRACTORY) return;
    this.lastOnset = k;
    const prev = this.notes.at(-1);
    if (prev && !prev.done) {
      this.measure(prev, this.notes.length - 1, store, on);
      prev.done = true;
    }
    this.notes.push(this.newNote(on));
    if (this.notes.length > 2000) this.notes.shift();
  }

  private newNote(frame: number): PmNote {
    return {
      start: frame * this.hop,
      peakDb: this.env[frame],
      t20: null,
      t20Measured: false,
      rate: null,
      bright: null,
      f0: null,
      pitchClarity: null,
      attack: null,
      touchAt: null,
      soundAt: null,
      doubleGap: null,
      lead: null,
      doubleChecked: false,
      done: false,
    };
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
    // Pitch from just after the level peak: the pick noise before it has no pitch.
    if (!this.pitched.has(n) && end - pk >= 0.06 / HOP_S) {
      this.pitched.add(n);
      this.spectrum(n, store, pk * H);
    }
    if (!n.doubleChecked && (n.bright !== null || n.pitchClarity !== null)) this.doubleAttack(n, store, end * H);
    if (n.attack === null && end - s > PEAK_SEARCH) n.attack = this.attackTime(n, store, (pk + 1) * H);
  }

  /**
   * A pick hit is a burst of high frequencies. Two bursts in a row within ~80 ms mean the pick struck the
   * string twice. A burst only counts if it clearly beats the note's own periodic edges.
   */
  private doubleAttack(n: PmNote, store: SampleStore, endSample: number) {
    const sr = this.sr;
    // From the earlier trigger too, if the note was moved: a first hit there is a double attack.
    const from = Math.max(2, Math.min(n.lead ?? n.start, n.start) - Math.round(sr * 0.005));
    const to = Math.min(store.length, endSample, n.start + Math.round(sr * 0.1));
    if (to - from < sr * 0.03) return;
    n.doubleChecked = true;
    const blk = Math.round(sr * 0.001);
    const period = n.f0 ? sr / n.f0 : sr * 0.012;
    const nb = Math.floor((to - from) / blk);
    const be = new Float64Array(nb);
    for (let b = 0; b < nb; b++) {
      let ss = 0;
      for (let i = from + b * blk, e = i + blk; i < e; i++) {
        const h = store.at(i) - 2 * store.at(i - 1) + store.at(i - 2);
        ss += h * h;
      }
      be[b] = ss;
    }
    // Main hit: the strongest burst in the first 35 ms (quiet pick scrape before it does not count).
    const mainEnd = Math.min(nb, Math.round((n.start - from) / blk) + 35);
    // The burst lasts a few ms and wobbles; its start (first block within 3 dB of the loudest) is the hit.
    let pmax = 0;
    for (let b = 0; b < mainEnd; b++) if (be[b] > be[pmax]) pmax = b;
    let p1 = pmax;
    for (let b = 0; b < pmax; b++)
      if (be[b] >= be[pmax] / 2) {
        p1 = b;
        break;
      }
    // Another hit stands 6 dB above everything in the period before it — the note's own
    // once-per-period edges never do — and is within 12 dB of the main hit.
    const per = Math.ceil(period / blk) + 1;
    const isHit = (b: number, lo: number) => {
      if (be[b] < be[p1] / 16) return false;
      let prevMax = 0;
      for (let j = Math.max(lo, b - per); j <= b - 1; j++) prevMax = Math.max(prevMax, be[j]);
      return be[b] > DOUBLE_K * prevMax;
    };
    // A weaker hit before the main one…
    for (let b = 1; b <= p1 - 5; b++)
      if (isHit(b, 0)) {
        n.doubleGap = ((p1 - b) * blk) / sr;
        return;
      }
    // …or after it, from one period on: within the first period the window would miss the main hit's
    // own repeat, and the excitation's ripples would pass for a hit.
    for (let b = p1 + Math.max(5, per - 1); b < nb; b++)
      if (isHit(b, 0)) {
        n.doubleGap = ((b - p1) * blk) / sr;
        return;
      }
  }

  private attackTime(n: PmNote, store: SampleStore, peakEnd: number) {
    const B = Math.max(8, Math.round(this.sr * 0.0005)); // 0.5 ms peak-hold blocks
    const from = Math.max(2, n.start - Math.round(this.sr * 0.15));
    const to = Math.min(store.length, peakEnd);
    const nb = Math.floor((to - from) / B);
    if (nb < 8) return null;
    // Peak amplitude and peak high-frequency content (second difference) per block.
    const a = new Float32Array(nb), h = new Float32Array(nb);
    for (let b = 0; b < nb; b++) {
      let m = 0, mh = 0;
      for (let i = from + b * B, e = i + B; i < e; i++) {
        const v = store.at(i);
        m = Math.max(m, Math.abs(v));
        mh = Math.max(mh, Math.abs(v - 2 * store.at(i - 1) + store.at(i - 2)));
      }
      a[b] = m;
      h[b] = mh;
    }
    // Start near the detected attack so the previous note's tail is not taken for this one.
    const near = Math.max(0, Math.floor((n.start - from - this.sr * 0.015) / B));
    const span = Math.max(4, Math.round(0.01 / (B / this.sr)));
    /** Quietest 10 ms stretch (by its loudest block) before block `end`. */
    const quietest = (x: Float32Array, end: number) => {
      let q = Infinity;
      for (let b = 0; b + span <= end; b++) {
        let m = 0;
        for (let j = b; j < b + span; j++) m = Math.max(m, x[j]);
        q = Math.min(q, m);
      }
      return isFinite(q) ? q : x[0];
    };
    let peak = 0;
    for (let b = near; b < nb; b++) peak = Math.max(peak, a[b]);
    // Background just before the hit: silence, or the previous note still ringing. 13 ms covers a whole
    // low-E period, so the ringing's crests are all in it.
    const per = Math.round(0.013 / (B / this.sr));
    let bg = 0;
    for (let b = Math.max(0, near - per); b < near; b++) bg = Math.max(bg, a[b]);
    const ringing = bg > peak * 0.12;
    let sound = -1;
    if (!ringing || peak >= bg * 1.12) {
      // The note sounds once the level gets a fifth of the way from silence to the attack peak, or
      // halfway from the ringing (whose crests wander) to the peak.
      const thr = ringing ? (bg + peak) / 2 : peak / 5;
      for (let b = near; b < nb; b++)
        if (a[b] >= thr) {
          sound = b;
          break;
        }
    } else {
      // Distortion holds the level flat: the new note shows as the sharpest high-frequency burst instead.
      let best = 0;
      for (let b = near; b < nb; b++) if (h[b] > best) (best = h[b]), (sound = b);
    }
    if (sound < 4) return null;
    let touch = sound;
    if (!ringing) {
      // Silence before: walk back while the signal stays clearly above it — that is the pick on the string.
      const thr = Math.max(quietest(a, sound) * 2, 1e-4);
      while (touch > 0 && a[touch - 1] > thr) touch--;
    } else {
      // A ringing string hides the pick in the level, but not in the high frequencies: the pick
      // scraping or stopping the string is a noise burst well above the ringing's own edges.
      const lo = Math.max(0, near - 6 * span);
      if (sound <= lo + span) return null;
      const thr = quietest(h.subarray(lo, sound), sound - lo) * 2;
      // Noise is ragged: step over dips shorter than 2 ms.
      const gap = 4;
      const hot = (b: number) => {
        for (let j = Math.max(lo, b - gap); j < b; j++) if (h[j] > thr) return true;
        return false;
      };
      while (touch > lo && hot(touch)) touch--;
      if (touch === lo) return null;
    }
    n.touchAt = from + touch * B;
    n.soundAt = from + sound * B;
    return ((sound - touch) * B) / this.sr;
  }

  private spectrum(n: PmNote, store: SampleStore, peakAt: number) {
    const N = 2048;
    const sr = this.sr;
    const from = peakAt + Math.round(sr * 0.01);
    if (from + N > store.length) return;
    const x = store.slice(from, from + N);
    // Normalized autocorrelation, 70–1000 Hz.
    const minLag = Math.floor(sr / 1000), maxLag = Math.min(Math.ceil(sr / 70), N / 2);
    let e0 = 0;
    for (let i = 0; i < N / 2; i++) e0 += x[i] * x[i];
    const r = new Float64Array(maxLag + 2);
    let best = 0;
    for (let lag = minLag; lag <= maxLag + 1; lag++) {
      let c = 0, el = 0;
      for (let i = 0; i < N / 2; i++) (c += x[i] * x[i + lag]), (el += x[i + lag] * x[i + lag]);
      r[lag] = c / Math.sqrt(e0 * el + 1e-12);
      if (lag <= maxLag) best = Math.max(best, r[lag]);
    }
    const post = this.magnitudes(x);
    // What was already sounding just before the hit (other strings, or this one still ringing).
    const preFrom = n.start - N - Math.round(sr * 0.003);
    const pre = preFrom >= 0 ? this.magnitudes(store.slice(preFrom, preFrom + N)) : null;
    let ePost = 0, ePre = 0;
    for (let b = 1; b < post.length; b++) (ePost += post[b] ** 2), (ePre += pre ? pre[b] ** 2 : 0);
    const ringing = ePre > ePost * 0.05;

    let lag = -1;
    const plain = () => {
      n.pitchClarity = best;
      if (best < 0.6) return;
      // The first strong peak, not the best one: later peaks are period multiples (an octave down).
      for (let l = minLag + 1; l <= maxLag; l++)
        if (r[l] >= 0.9 * best && r[l] >= r[l - 1] && r[l] >= r[l + 1]) {
          lag = l;
          break;
        }
    };
    if (!ringing) plain();
    else {
      // Over a ringing background the autocorrelation hears the whole mix. Take what the hit added to
      // the spectrum, find the pitch whose harmonics hold most of it, then refine on the autocorrelation.
      const d = post.map((v, b) => Math.max(0, v - (pre ? pre[b] * 1.1 : 0)));
      const binHz = sr / N;
      const at = (f: number) => {
        const p = f / binHz, i = Math.floor(p);
        return i + 1 < d.length ? d[i] + (d[i + 1] - d[i]) * (p - i) : 0;
      };
      let fc = 0, sc = 0, total = 0;
      for (let b = 1; b < d.length; b++) total += d[b];
      // Subharmonic summation over all harmonics up to 5 kHz (compressed, so one loud partial does
      // not decide): the true pitch collects every harmonic, a multiple of it only some.
      for (let c = 0; c <= 1600; c++) {
        const f = 70 * 2 ** (c / 400); // 3-cent steps, 70 Hz – 1.1 kHz
        let v = 0;
        for (let k = 1, w = 1; k * f < 5000; k++, w *= 0.92) v += Math.sqrt(at(f * k)) * w;
        if (v > sc) (sc = v), (fc = f);
      }
      // Most of what changed must sit on this note's harmonics, or there is no clear new pitch.
      const on = new Uint8Array(d.length);
      for (let k = 1; k * fc < 5000; k++) {
        const c = Math.round((fc * k) / binHz);
        for (let b = Math.max(0, c - 2); b <= Math.min(d.length - 1, c + 2); b++) on[b] = 1;
      }
      // Count only clear spectral peaks of what was added; the low broadband rest is noise and leakage.
      let dMax = 0;
      for (let b = 1; b < d.length; b++) dMax = Math.max(dMax, d[b]);
      let onH = 0, peaks = 0;
      for (let b = 1; b < d.length; b++)
        if (d[b] > dMax * 0.1) {
          peaks += d[b];
          if (on[b]) onH += d[b];
        }
      const share = peaks > 0 ? onH / peaks : 0;
      // The hit added little of its own (the same string struck again about as hard): the mix is
      // dominated by this string anyway, so the plain autocorrelation is right.
      if (!fc || share < 0.5 || total < 0.3 * post.reduce((q, v) => q + v, 0)) {
        plain();
        if (lag < 0) return;
      } else if (best >= 0.6 && (plain(), lag > 0) && Math.abs(12 * Math.log2((fc * lag) / sr)) < 1.5) {
        // The added partials point at the pitch the whole mix already has (the same string struck
        // again): the autocorrelation measures it more precisely than 23 Hz spectrum bins.
      } else {
        lag = -1;
        n.pitchClarity = share;
      const l0 = sr / fc;
      let bl = -1;
      // ±6 % (a semitone): the coarse pitch comes from spectrum bins 23 Hz apart and can sit on a skirt.
      for (let l = Math.max(minLag + 1, Math.floor(l0 * 0.94)); l <= Math.min(maxLag, Math.ceil(l0 * 1.06)); l++)
        if (r[l] >= r[l - 1] && r[l] >= r[l + 1] && (bl < 0 || r[l] > r[bl])) bl = l;
        if (bl < 0 || r[bl] < 0.2) {
          n.f0 = fc;
          this.bright(n, post);
          return;
        }
        lag = bl;
      }
    }
    if (lag < 0) return;
    const a = r[lag - 1], b = r[lag], c = r[lag + 1];
    const den = a - 2 * b + c;
    const shift = den !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0;
    n.f0 = sr / (lag + shift);
    this.bright(n, post);
  }

  /** Hann-windowed magnitude spectrum up to 8 kHz. */
  private magnitudes(x: Float32Array) {
    const N = x.length;
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = x[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
    fft(re, im);
    const top = Math.min(N / 2, Math.ceil((8000 * N) / this.sr));
    const m = new Float64Array(top);
    for (let b = 0; b < top; b++) m[b] = Math.hypot(re[b], im[b]);
    return m;
  }

  /** Share of spectral energy above 3.5 × f0. */
  private bright(n: PmNote, mag: Float64Array) {
    const binHz = this.sr / 2048;
    const cut = (3.5 * n.f0!) / binHz, lowCut = (0.5 * n.f0!) / binHz;
    let total = 0, high = 0;
    for (let b = Math.ceil(lowCut); b < mag.length; b++) {
      const p = mag[b] * mag[b];
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

/** Open strings in standard tuning, as MIDI numbers: E2 A2 D3 G3 B3 E4. */
export const OPEN_STRINGS = [40, 45, 50, 55, 59, 64];
const STRING_NAMES = ["E2 (6-я)", "A2 (5-я)", "D3 (4-я)", "G3 (3-я)", "B3 (2-я)", "E4 (1-я)"];

export interface PitchCheck {
  /** Index into OPEN_STRINGS. */
  string: number;
  name: string;
  /** Deviation from the open string, cents. */
  cents: number;
  /** The reference came from open notes actually played on that string (rather than standard tuning). */
  measuredRef: boolean;
}

const midiOf = (f: number, a4: number) => 69 + 12 * Math.log2(f / a4);

const NOTE_NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
/** Nearest equal-tempered note and the deviation from it in cents. */
export function noteOf(f: number, a4 = 440) {
  const m = midiOf(f, a4);
  const r = Math.round(m);
  return { name: `${NOTE_NAMES[((r % 12) + 12) % 12]}${Math.floor(r / 12) - 1}`, cents: (m - r) * 100 };
}

/**
 * Compares each note's pitch with the open string it belongs to. The reference is the median pitch of
 * the open (not muted) notes played on that string, so a guitar tuned a little off is not penalised.
 */
export function checkPitches(notes: PmNote[], limitS: number, a4 = 440): Map<PmNote, PitchCheck> {
  const nearest = (f: number) => {
    const m = midiOf(f, a4);
    let bi = 0;
    for (let i = 1; i < OPEN_STRINGS.length; i++) if (Math.abs(m - OPEN_STRINGS[i]) < Math.abs(m - OPEN_STRINGS[bi])) bi = i;
    return bi;
  };
  const refs: number[][] = OPEN_STRINGS.map(() => []);
  for (const n of notes) {
    if (n.f0 === null || isPalmMuted(n, limitS) !== false) continue;
    const i = nearest(n.f0);
    if (Math.abs(midiOf(n.f0, a4) - OPEN_STRINGS[i]) < 0.6) refs[i].push(n.f0);
  }
  const ref = refs.map((r, i) => {
    if (!r.length) return { f: a4 * 2 ** ((OPEN_STRINGS[i] - 69) / 12), measured: false };
    const s = [...r].sort((x, y) => x - y);
    return { f: s[s.length >> 1], measured: true };
  });
  const out = new Map<PmNote, PitchCheck>();
  for (const n of notes) {
    if (n.f0 === null) continue;
    const i = nearest(n.f0);
    out.set(n, { string: i, name: STRING_NAMES[i], cents: 1200 * Math.log2(n.f0 / ref[i].f), measuredRef: ref[i].measured });
  }
  return out;
}
