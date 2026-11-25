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
/** Closer bursts are one stroke: the pick touching the string, then leaving it. */
const DOUBLE_MIN_S = 0.025;
/** A much quieter hit (by PRE_HIT_DB) up to PRE_HIT_S before a note is a false start: the pick struck, stopped, struck again. */
const PRE_HIT_S = 0.5;
const PRE_HIT_DB = 12;
/**
 * A pick hit starts with a burst of high frequencies, this much (dB) above the 100 ms before it. A hand
 * stopping the string, handling noise, hum and distortion swelling on a held note do not have one
 * (real recordings: pick hits 19–54 dB, the rest under 16).
 */
const HIT_HF_DB = 16;
/** Sounds this much quieter than the notes around them (last 10 s) are noise, unless they lead into a note. */
const QUIET_DB = 15;
/**
 * A re-pick over a sounding (distorted) string: the spectral flux beats its recent average by this much
 * (real recordings: re-picks 0.07–0.22, distortion swelling on a held note 0.04–0.068)…
 */
const REPICK_FLUX = 0.07;
/** …and the level holds within this many dB for the next 150 ms (a hand stopping the string: 15–30 dB). */
const REPICK_FALL_DB = 8;
/** Over a ringing string, a new note's harmonics hold at least this share of what the pick added. */
const NEW_STRING_SHARE = 0.71;
/** A knock or quiet hit up to this long before a note is the pick landing on the strings: the attack starts there. */
const PRE_TOUCH_S = 0.6;
/** How far before the note the pick's first touch is looked for in the sound itself. */
const TOUCH_WINDOW_S = 0.16;
/** A knock or slap: gone (−20 dB) faster than this, and quieter than the notes. A palm-muted note takes 0.15 s+. */
const KNOCK_T20_S = 0.09;
/** Hops after the onset before it is judged a hit or not (150 ms: the touch sound, then the note). */
const JUDGE_AFTER = 30;
/** Pitch: measured on the settled note, after the pick's sharp first moments, over PITCH_N samples. */
const PITCH_DELAY_S = 0.04;
const PITCH_N = 4096;
/** The exact pitch waits a little longer: a string struck again while ringing takes ~50 ms to settle. */
const REFINE_DELAY_S = 0.06;
/** A long note's pitch is measured again from this far after the peak. */
const LATE_PITCH_S = 0.25;
/** Refinement range around the first estimate, cents: a hard pick on a low string reads up to ~60 sharp at first. */
const REFINE_C = 100;
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
  private refined = new WeakSet<PmNote>();
  private refinedLate = new WeakSet<PmNote>();
  /** Notes already checked for being a pick hit at all. */
  private judged = new WeakSet<PmNote>();
  /** Quiet pick hits dropped as notes, kept briefly: one right before a note makes it a double attack. */
  private ghosts: { start: number; peakDb: number }[] = [];
  /** Pick contacts that were not notes (quiet hits, knocks of the pick landing on the strings), for attacks. */
  private contacts: number[] = [];
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
    this.ghosts = [];
    this.contacts = [];
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
      // Measuring may merge false starts into the note, removing the notes before it.
      if (i >= this.notes.length) continue;
      const n = this.notes[i];
      // A short sound may die out before it is judged; it still is, once.
      if (n.done && this.judged.has(n)) break;
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
      if (!prev || prev.done || k - prev.start / this.hop > REFRACTORY || e[k] < this.env[prev.start / this.hop] + 3) return;
      let on = k;
      while (on > k - ONSET_LOOKBACK && e[on - 1] > lo + 3) on--;
      const moved = this.newNote(on);
      moved.lead = prev.start;
      if (prev.doubleGap !== null && prev.doubleChecked) {
        moved.doubleGap = prev.doubleGap + (moved.start - prev.start) / this.sr;
        moved.doubleChecked = true;
      }
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
    // Judged once the attack is complete (the pick's touch sound alone would pass for a quiet hit).
    if (!this.judged.has(n) && (end - s >= JUDGE_AFTER || endFrame !== undefined || next !== undefined || n.done)) {
      this.judged.add(n);
      const verdict = this.judgeHit(n, s, end);
      if (verdict !== "note") {
        if (verdict === "ghost") this.ghosts.push({ start: n.start, peakDb: n.peakDb });
        if (verdict !== "noise") this.contacts.push(n.start);
        this.notes.splice(idx, 1);
        // The note before rang on through this sound: measure it again up to the next real note.
        const prev = this.notes[idx - 1];
        if (prev) prev.done = false;
        // Not a hit: it must not hold off the next one.
        if (this.lastOnset * this.hop >= n.start) this.lastOnset = -1e9;
        this.version++;
        return;
      }
    }
    // False starts: much quieter hits just before this note (the pick struck, stopped, then struck
    // again) are part of this stroke, not notes of their own.
    for (let p = this.notes[idx - 1]; idx > 0 && p && p.done; p = this.notes[idx - 1]) {
      const gap = n.start - p.start;
      if (gap > PRE_HIT_S * this.sr || p.peakDb > n.peakDb - PRE_HIT_DB) break;
      this.notes.splice(--idx, 1);
      n.doubleGap ??= gap / this.sr;
      n.doubleChecked = true;
      this.version++;
    }
    // The same for quiet hits already dropped as notes of their own.
    for (let g = this.ghosts.length - 1; g >= 0; g--) {
      const gh = this.ghosts[g];
      const gap = n.start - gh.start;
      if (gap <= 0) continue;
      if (gap > PRE_HIT_S * this.sr) break;
      if (gh.peakDb > n.peakDb - PRE_HIT_DB) continue;
      n.doubleGap ??= gap / this.sr;
      n.doubleChecked = true;
      this.version++;
      break;
    }
    while (this.ghosts.length && n.start - this.ghosts[0].start > PRE_HIT_S * this.sr) this.ghosts.shift();
    const floor = Math.max(GATE_DB - 5, n.peakDb - 50);

    let t20 = -1;
    // Before the next note the pick may already be stopping the string: leave those 30 ms out of the fit.
    let fitFrom = -1, fitTo = endFrame !== undefined || next ? Math.max(pk + 1, end - 7) : end - 1;
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
    } else if (endFrame !== undefined || next) {
      // Ended (by the next note) with less than 3 dB lost, or too briefly to fit: what was measured
      // while it rang on (perhaps the pick already stopping it for the next note) no longer holds.
      // (The 3 dB point only in the left-out last 30 ms counts as holding level too.)
      n.rate = fitFrom < 0 || fitFrom > fitTo ? 0 : null;
      if (n.rate === null && t20 < 0) n.t20 = null;
    }
    if (t20 >= 0) {
      n.t20 = ((t20 - pk) * H) / this.sr;
      n.t20Measured = true;
    } else if (n.rate && n.rate > 0.5) {
      n.t20 = 20 / n.rate;
      n.t20Measured = false;
    } else if (n.rate === 0) {
      // Hardly decayed at all before the next note: at most 3 dB over its length, so 20 dB take ≥ 20/3 of it.
      n.t20 = (((end - pk) * H) / this.sr) * (20 / 3);
      n.t20Measured = false;
    }
    // Pitch from just after the level peak: the pick noise before it has no pitch.
    // On the settled note when it lasts long enough (the pick stopping a ringing string, and the sharp
    // first moments, are over by then), else right after the peak.
    const closed = endFrame !== undefined || next !== undefined;
    if (!this.pitched.has(n)) {
      const lateOk = end - pk >= (PITCH_DELAY_S + 2048 / this.sr) / HOP_S;
      if (lateOk || (closed && end - pk >= 0.06 / HOP_S)) {
        this.pitched.add(n);
        this.spectrum(n, store, pk * H + (lateOk ? Math.round(this.sr * (PITCH_DELAY_S - 0.01)) : 0));
      }
    }
    // Then the exact pitch, once the settled part of the note is in (or the note has ended).
    if (n.f0 !== null && !this.refined.has(n)) {
      const from = pk * H + Math.round(this.sr * REFINE_DELAY_S);
      const avail = Math.min(end * H, store.length) - from;
      if (avail >= PITCH_N || (closed && avail >= PITCH_N / 2)) {
        this.refined.add(n);
        this.refinePitch(n, store, from, avail >= PITCH_N ? PITCH_N : PITCH_N / 2);
      }
    }
    // A long ringing note: once more on its steady part (a hard pick raises the pitch for ~0.1–0.2 s).
    if (n.f0 !== null && this.refined.has(n) && !this.refinedLate.has(n)) {
      const at = pk + Math.round(LATE_PITCH_S / HOP_S);
      if (end - at >= (2 * PITCH_N) / H && e[at] >= n.peakDb - 15) {
        // Wait for 4× the window if the note keeps ringing: the fundamental's peak sharpens with length
        // (distortion and the other strings make it wobble over shorter spans).
        const long = end - at >= (4 * PITCH_N) / H;
        if (long || closed || e[end - 1] < n.peakDb - 15) {
          this.refinedLate.add(n);
          this.refinePitch(n, store, at * H, long ? 4 * PITCH_N : 2 * PITCH_N);
        }
      } else if (end - at < (2 * PITCH_N) / H && (closed || e[Math.min(at, end - 1)] < n.peakDb - 15)) this.refinedLate.add(n);
    }
    if (!n.doubleChecked && (n.bright !== null || n.pitchClarity !== null)) this.doubleAttack(n, store, end * H);
    if (n.attack === null && end - s > PEAK_SEARCH) {
      n.attack = this.attackTime(n, store, (pk + 1) * H);
      // The pick may have landed on the strings well before (a knock, or a quiet hit), rested, then struck:
      // the attack runs from that first contact, if it came after the previous note's own attack.
      if (n.attack !== null && n.touchAt !== null && n.soundAt !== null) {
        const prev = this.notes[idx - 1];
        const after = Math.max(n.start - PRE_TOUCH_S * this.sr, prev ? (prev.soundAt ?? prev.start) + 0.1 * this.sr : 0);
        const first = this.contacts.find((c) => c >= after && c < n.touchAt!);
        if (first !== undefined) {
          n.touchAt = first;
          n.attack = (n.soundAt - first) / this.sr;
        }
      }
      while (this.contacts.length && n.start - this.contacts[0] > PRE_TOUCH_S * this.sr) this.contacts.shift();
    }
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
    // A second hit after the main one. Bursts closer than DOUBLE_MIN_S are the pick touching and then
    // leaving the string (one stroke, heard on real recordings at 5–20 ms), and within the first period
    // the excitation's ripples would pass for a hit.
    for (let b = p1 + Math.max(Math.round(DOUBLE_MIN_S * 1000), per - 1); b < nb; b++)
      if (isHit(b, 0)) {
        n.doubleGap = ((b - p1) * blk) / sr;
        return;
      }
  }

  private attackTime(n: PmNote, store: SampleStore, peakEnd: number) {
    const B = Math.max(8, Math.round(this.sr * 0.0005)); // 0.5 ms peak-hold blocks
    // The pick may rest on the string well before the note (touch, a pause, then the stroke): look back
    // TOUCH_WINDOW_S, but not into the previous note's own attack.
    const prev = this.notes[this.notes.indexOf(n) - 1];
    const from = Math.max(
      2,
      n.start - Math.round(this.sr * (TOUCH_WINDOW_S + 0.05)),
      prev ? (prev.soundAt ?? prev.start) + Math.round(this.sr * 0.06) : 0,
    );
    const to = Math.min(store.length, peakEnd);
    const nb = Math.floor((to - from) / B);
    if (nb < 8) return null;
    // Peak amplitude, energy and peak high-frequency content (second difference) per block.
    const a = new Float32Array(nb), h = new Float32Array(nb), sq = new Float32Array(nb);
    for (let b = 0; b < nb; b++) {
      let m = 0, mh = 0, ss = 0;
      for (let i = from + b * B, e = i + B; i < e; i++) {
        const v = store.at(i);
        m = Math.max(m, Math.abs(v));
        ss += v * v;
        mh = Math.max(mh, Math.abs(v - 2 * store.at(i - 1) + store.at(i - 2)));
      }
      a[b] = m;
      h[b] = mh;
      sq[b] = ss;
    }
    // RMS over 2, 5 and 10 ms: the faint touch stands clear of the noise, whose single peaks are much
    // higher; the 10 ms one also irons out the ripple of a low string's dying tail.
    const movingRms = (w: number) => {
      const out = new Float32Array(nb);
      for (let b = 0, acc = 0; b < nb; b++) {
        acc += sq[b] - (b >= w ? sq[b - w] : 0);
        out[b] = Math.sqrt(Math.max(0, acc) / (Math.min(b + 1, w) * B));
      }
      return out;
    };
    const rms = movingRms(4);
    const R10 = Math.round(0.01 / (B / this.sr));
    const rms10 = movingRms(R10);
    const rms5 = movingRms(Math.round(R10 / 2));
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
    // Ringing only if it never got quiet over the last TOUCH_WINDOW_S: just before the note there may be
    // the pick's own touch and the start of the stroke, which are no ringing.
    let calm = Infinity;
    const lookBack = Math.round(TOUCH_WINDOW_S / (B / this.sr));
    for (let b = Math.max(0, near - lookBack); b + span <= near; b++) {
      let m = 0;
      for (let j = b; j < b + span; j++) m = Math.max(m, a[j]);
      calm = Math.min(calm, m);
    }
    const ringing = (isFinite(calm) ? calm : bg) > peak * 0.12;
    let sound = -1;
    if (!ringing || peak >= bg * 1.12) {
      // The note sounds once the level gets a third of the way from silence to the attack peak (the pick's
      // own touch sound stays below that), or
      // halfway from the ringing (whose crests wander) to the peak.
      const thr = ringing ? (bg + peak) / 2 : peak / 3;
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
    // The pick touching the string is a small sound of its own before the note, often with a quieter
    // stretch in between (the pick pressing the string). Take the earliest burst within TOUCH_WINDOW_S before
    // the note that rises clearly above the background — after a quiet moment, so the previous note's
    // tail does not count.
    const win = Math.round(TOUCH_WINDOW_S / (B / this.sr));
    const lo = Math.max(0, sound - win);
    // A burst starts after a quiet moment, or as a clear rise over the previous note's dying tail: twice
    // its peaks 15–25 ms earlier (a whole low-E period), which a decaying tail never is.
    const r0 = Math.round(0.015 / (B / this.sr)), r1 = Math.round(0.025 / (B / this.sr));
    const earliest = (x: Float32Array, thr: number) => {
      let quiet = false;
      for (let b = lo; b < sound - 1; b++) {
        if (x[b] <= thr) {
          quiet = true;
          continue;
        }
        if (x[b + 1] <= thr) continue;
        if (quiet) return b;
        if (b - r1 >= lo) {
          let m = 0;
          for (let j = b - r1; j <= b - r0; j++) m = Math.max(m, x[j]);
          if (x[b] > 2 * m) return b;
        }
      }
      return -1;
    };
    let touch = sound;
    if (!ringing) {
      // Above the noise's own blips: the touch is within ~35 dB of the note, noise clicks 45+ below. (The
      // background, silence or the previous note's tail, is the rise rule's business.)
      let peakRms = 0;
      for (let b = near; b < nb; b++) peakRms = Math.max(peakRms, rms[b]);
      const thr = Math.max(peakRms * 0.0178, 1e-5);
      // The earliest clear rise: 6 dB over the quietest level 10–30 ms before it. A dying tail crossing
      // the threshold, ripple and all, never rises like that.
      let t = -1;
      for (let b = Math.max(lo, 3 * R10); b < sound - 1 && t < 0; b++) {
        if (rms5[b] <= thr) continue;
        let base = Infinity;
        for (let j = b - 3 * R10; j <= b - R10; j++) base = Math.min(base, rms10[j]);
        if (rms5[b] >= 2 * base) {
          // Back to where it left the quiet level (the 5 ms window trails the sound).
          t = b;
          while (t > b - R10 / 2 && rms[t - 1] > 2 * base) t--;
        }
      }
      if (t >= 0) touch = t;
      else while (touch > 0 && rms[touch - 1] > thr) touch--;
    } else {
      // A ringing string hides the pick in the level, but not in the high frequencies: the pick
      // touching or stopping the string is a burst well above the ringing's own edges.
      const lo2 = Math.max(0, sound - 2 * win);
      if (sound <= lo2 + span) return null;
      const thr = quietest(h.subarray(lo2, sound), sound - lo2) * 2.5;
      const t = earliest(h, thr);
      if (t < 0) return null;
      touch = t;
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
      let total = 0;
      for (let b = 1; b < d.length; b++) total += d[b];
      const fc = shs(d, binHz);
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
      // The same string picked again while it still rings (repeated notes, often through distortion that
      // keeps it sounding): the whole mix has the previous note's pitch (distortion can leave the
      // fundamental 20 dB under the 2nd harmonic: an octave up counts as well), and what the pick added
      // does not clearly point elsewhere — distortion reshapes the partials at every pick.
      const prevF0 = this.notes[this.notes.indexOf(n) - 1]?.f0 ?? null;
      const near = (f: number, ref: number) => [1, 2].some((k) => Math.abs(1200 * Math.log2(f / (k * ref))) < 100);
      // A new string over a ringing one adds its own clean harmonic series (share 0.71–0.93 in tests);
      // distortion re-picked scatters what changed (0.31–0.70).
      if (prevF0 !== null && near(shs(post, binHz), prevF0) && (!fc || share < NEW_STRING_SHARE || near(fc, prevF0))) {
        n.pitchClarity = best;
        const l0 = sr / prevF0;
        for (let l = Math.max(minLag + 1, Math.floor(l0 * 0.97)); l <= Math.min(maxLag, Math.ceil(l0 * 1.03)); l++)
          if (r[l] >= r[l - 1] && r[l] >= r[l + 1] && (lag < 0 || r[l] > r[lag])) lag = l;
        if (lag < 0) {
          n.f0 = prevF0;
          this.bright(n, post);
          return;
        }
        // Otherwise: the hit added little of its own (the same string struck again about as hard), or
        // left the mix no louder than before — the mix is this string, the plain autocorrelation is right.
      } else if (!fc || share < 0.5 || ePost <= ePre || total < 0.3 * post.reduce((q, v) => q + v, 0)) {
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

  /**
   * Is this onset a pick hit? "noise": no pick burst (a hand stopping the string, handling noise,
   * distortion swelling on a held note). "ghost": a pick hit, but far quieter than the notes around it.
   */
  private judgeHit(n: PmNote, s: number, end: number): "note" | "ghost" | "knock" | "noise" {
    const hf = this.hopHf;
    let now = 0;
    for (let j = Math.max(0, s - 1); j <= Math.min(end - 1, s + 3); j++) now = Math.max(now, hf[j]);
    // The median of the 100 ms before: the previous hit's own burst (fast picking) does not raise it.
    const prior: number[] = [];
    for (let j = Math.max(0, s - 24); j < s - 3; j++) prior.push(hf[j]);
    const cnt = prior.length;
    let repicked = false;
    if (cnt >= 4) {
      prior.sort((p, q) => p - q);
      const before = prior[cnt >> 1];
      if (!(now > before * 10 ** (HIT_HF_DB / 10))) {
        if (!this.repick(n, s, end)) return "noise";
        repicked = true;
      }
    } else return "noise"; // the very start of the take: a sound cut in, not a hit heard whole
    let loud = -Infinity;
    const from = n.start - 10 * this.sr;
    for (const m of this.notes) if (m !== n && m.start >= from && m.start < n.start + 10 * this.sr) loud = Math.max(loud, m.peakDb);
    if (n.peakDb < loud - QUIET_DB) return "ghost";
    // Without the pick's burst only the loudness vouches for it: a re-pick is about as loud as the notes.
    if (repicked && n.peakDb < loud - 6) return "noise";
    // A rattle or a knock with no clear pitch, clearly quieter than the notes: not a note either. (A
    // dead palm-muted thud as loud as the others is a note, a bad one.)
    if (n.pitchClarity !== null && n.pitchClarity < 0.8 && n.peakDb < loud - 6) return "knock";
    // A knock on the guitar or a hand slapping the strings: dies at once.
    if (n.t20 !== null && n.t20Measured && n.t20 < KNOCK_T20_S && n.peakDb < loud - 6) return "knock";
    return "note";
  }

  /**
   * A string picked again while it (or a distorted tone) is still sounding: distortion keeps the high
   * frequencies up all the time, so the pick's burst hardly shows, but the spectrum still jumps. Unlike
   * distortion swelling on a held note (smaller jumps), and unlike a hand stopping the string (the level
   * then falls), the sound goes on as loud.
   */
  private repick(n: PmNote, s: number, end: number) {
    const e = this.env, f = this.flux;
    let pre = -Infinity;
    for (let j = Math.max(0, s - 6); j < s; j++) pre = Math.max(pre, e[j]);
    if (pre < n.peakDb - 10) return false; // started from quiet: a real hit would have had its burst
    let at = s, mx = 0;
    for (let j = Math.max(0, s - 4); j <= Math.min(end - 2, s + 6); j++) if (f[j] > mx) (mx = f[j]), (at = j);
    if (at < 43) return false;
    let mean = 0;
    for (let j = at - 40; j < at - 3; j++) mean += f[j];
    mean /= 37;
    if (mx - mean < REPICK_FLUX) return false;
    let low = Infinity;
    for (let j = s; j < Math.min(end, s + JUDGE_AFTER); j++) low = Math.min(low, e[j]);
    return low >= n.peakDb - REPICK_FALL_DB;
  }

  /**
   * Exact pitch near the coarse f0: the peak of the fundamental (Hann-windowed DFT, 1-cent steps). The
   * autocorrelation follows all harmonics, and a string's upper harmonics run sharp (stiffness), which
   * reads 10–20 cents high; a tuner, and the ear, go by the fundamental.
   */
  private refinePitch(n: PmNote, store: SampleStore, from: number, N: number) {
    const x = store.slice(from, from + N);
    // Other strings still ringing put partials next to this fundamental and skew its peak: keep the
    // autocorrelation then. Measured before the pick's touch sound (up to ~120 ms before the note).
    const meanSq = (a: Float32Array) => a.reduce((q, v) => q + v * v, 0) / Math.max(1, a.length);
    const b0 = n.start - Math.round(this.sr * 0.25), b1 = n.start - Math.round(this.sr * 0.15);
    if (b0 >= 0 && meanSq(store.slice(b0, b1)) > 0.03 * meanSq(x)) return;
    const w = new Float64Array(N);
    for (let i = 0; i < N; i++) w[i] = x[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
    const mag = (f: number) => {
      const c = 2 * Math.cos((2 * Math.PI * f) / this.sr);
      let s1 = 0, s2 = 0;
      for (let i = 0; i < N; i++) {
        const s0 = w[i] + c * s1 - s2;
        s2 = s1;
        s1 = s0;
      }
      return s1 * s1 + s2 * s2 - c * s1 * s2;
    };
    const scan = (k: number) => {
      let bf = 0, bm = -1;
      for (let c = -REFINE_C; c <= REFINE_C; c++) {
        const f = k * n.f0! * 2 ** (c / 1200);
        const m = mag(f);
        if (m > bm) (bm = m), (bf = f);
      }
      return { f: bf / k, m: bm, edge: Math.abs(1200 * Math.log2(bf / (k * n.f0!))) >= REFINE_C - 1 };
    };
    // The fundamental, unless it is buried (well below the 2nd harmonic): then the 2nd harmonic.
    let r = scan(1);
    const h2 = scan(2);
    if (r.m < h2.m * 0.01) r = h2;
    if (r.edge || r.m <= 0) return;
    n.f0 = r.f;
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

/**
 * Subharmonic summation over all harmonics up to 5 kHz (compressed, so one loud partial does not
 * decide): the true pitch collects every harmonic, a multiple of it only some. 3-cent steps, 70 Hz–1.1 kHz.
 */
function shs(d: Float64Array, binHz: number) {
  const at = (f: number) => {
    const p = f / binHz, i = Math.floor(p);
    return i + 1 < d.length ? d[i] + (d[i + 1] - d[i]) * (p - i) : 0;
  };
  let fc = 0, sc = 0;
  for (let c = 0; c <= 1600; c++) {
    const f = 70 * 2 ** (c / 400);
    let v = 0;
    for (let k = 1, w = 1; k * f < 5000; k++, w *= 0.92) v += Math.sqrt(at(f * k)) * w;
    if (v > sc) (sc = v), (fc = f);
  }
  return fc;
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

/** Open strings in standard tuning, as MIDI numbers: E2 A2 D3 G3 B3 E4. */
export const OPEN_STRINGS = [40, 45, 50, 55, 59, 64];
const STRING_NAMES = ["E2 (6-я)", "A2 (5-я)", "D3 (4-я)", "G3 (3-я)", "B3 (2-я)", "E4 (1-я)"];

/**
 * Default 20 dB decay limits, ms, from the 6th string to the 1st. The bass strings ring longer, muted too
 * (real recordings: an unmuted E2 takes ~800 ms and more, muted top strings 150–300).
 */
export const PM_LIMITS_MS = [500, 500, 300, 250, 250, 200];
/** The string a note is judged as: the highest one whose open note is not above it. */
const stringOf = (f: number) => {
  const m = Math.round(69 + 12 * Math.log2(f / 440));
  return Math.max(0, OPEN_STRINGS.findLastIndex((o) => o <= m));
};
/** The 20 dB decay limit for this note's string (`limits` in s, 6th string first); the longest without a pitch. */
export const pmLimitFor = (n: PmNote, limits: number[]) => (n.f0 === null ? Math.max(...limits) : limits[stringOf(n.f0)]);
/** Palm mute when the note loses 20 dB faster than its string's limit. */
export const isPalmMuted = (n: PmNote, limits: number[]) => (n.t20 === null ? null : n.t20 <= pmLimitFor(n, limits));

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
export function checkPitches(notes: PmNote[], limits: number[], a4 = 440): Map<PmNote, PitchCheck> {
  const nearest = (f: number) => {
    const m = midiOf(f, a4);
    let bi = 0;
    for (let i = 1; i < OPEN_STRINGS.length; i++) if (Math.abs(m - OPEN_STRINGS[i]) < Math.abs(m - OPEN_STRINGS[bi])) bi = i;
    return bi;
  };
  const refs: number[][] = OPEN_STRINGS.map(() => []);
  for (const n of notes) {
    if (n.f0 === null || isPalmMuted(n, limits) !== false) continue;
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
