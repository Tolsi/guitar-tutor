// YIN pitch detection over a stream of samples, one frame every ~10.7 ms.

// Guitar fundamentals stay under ~1.4 kHz, so about 24 kHz keeps the accuracy and quarters the YIN cost.
const RATE = 24000;
const THRESHOLD = 0.15;
/** Window and step in samples at RATE; pitch range in Hz (the window must hold two periods of fMin). */
const DEFAULTS = { buf: 1024, hop: 256, fMin: 70, fMax: 1400 };

export interface YinFrame {
  f0: number | null;
  clarity: number;
  db: number;
}

export class YinStream {
  /** From the middle of a frame's window to the sample that completed it, s. */
  readonly latency: number;
  private readonly decim: number;
  private readonly sr: number;
  private readonly tauMin: number;
  private readonly tauMax: number;
  private readonly win: number;
  private readonly buf: number;
  private readonly hop: number;
  private readonly ring: Float32Array;
  private readonly frame: Float32Array;
  private readonly d: Float32Array;
  private pos = 0;
  private filled = 0;
  private sinceHop = 0;
  private acc = 0;
  private accN = 0;

  constructor(sampleRate: number, opts: Partial<typeof DEFAULTS> = {}) {
    const { buf: BUF, hop, fMin, fMax } = { ...DEFAULTS, ...opts };
    this.buf = BUF;
    this.hop = hop;
    this.ring = new Float32Array(BUF);
    this.frame = new Float32Array(BUF);
    this.decim = Math.max(1, Math.round(sampleRate / RATE));
    this.sr = sampleRate / this.decim;
    this.latency = BUF / 2 / this.sr;
    this.tauMin = Math.floor(this.sr / fMax);
    this.tauMax = Math.min(Math.ceil(this.sr / fMin), BUF / 2);
    this.win = BUF - this.tauMax;
    this.d = new Float32Array(this.tauMax + 2);
  }

  /** `emit` gets each frame with the index after the sample in `x` that completed it. */
  push(x: Float32Array, emit: (end: number, f: YinFrame) => void) {
    const BUF = this.buf, HOP = this.hop;
    for (let i = 0; i < x.length; i++) {
      this.acc += x[i];
      if (++this.accN < this.decim) continue;
      this.ring[this.pos] = this.acc / this.decim;
      this.pos = (this.pos + 1) % BUF;
      this.acc = 0;
      this.accN = 0;
      if (this.filled < BUF) this.filled++;
      if (++this.sinceHop >= HOP && this.filled === BUF) {
        this.sinceHop = 0;
        emit(i + 1, this.detect());
      }
    }
  }

  private detect(): YinFrame {
    const x = this.frame, BUF = this.buf;
    let mean = 0;
    for (let k = 0; k < BUF; k++) {
      x[k] = this.ring[(this.pos + k) % BUF];
      mean += x[k];
    }
    mean /= BUF;
    let energy = 0;
    for (let k = 0; k < BUF; k++) {
      x[k] -= mean;
      energy += x[k] * x[k];
    }
    const db = 10 * Math.log10(energy / BUF + 1e-12);

    const { d, win, tauMax, tauMin } = this;
    d[0] = 1;
    let running = 0;
    for (let tau = 1; tau <= tauMax; tau++) {
      let s = 0;
      for (let j = 0; j < win; j++) {
        const v = x[j] - x[j + tau];
        s += v * v;
      }
      running += s;
      d[tau] = running > 0 ? (s * tau) / running : 1;
    }

    let tau = -1;
    for (let k = tauMin; k < tauMax; k++) {
      if (d[k] < THRESHOLD) {
        while (k + 1 < tauMax && d[k + 1] < d[k]) k++;
        tau = k;
        break;
      }
    }
    if (tau < 0) {
      let best = tauMin;
      for (let k = tauMin; k < tauMax; k++) if (d[k] < d[best]) best = k;
      if (d[best] > 0.35) return { f0: null, clarity: 1 - d[best], db };
      tau = best;
    }

    let refined = tau;
    if (tau > 1 && tau < tauMax) {
      const a = d[tau - 1], b = d[tau], c = d[tau + 1];
      const den = a - 2 * b + c;
      if (den > 0) refined = tau + (a - c) / (2 * den);
    }
    return { f0: this.sr / refined, clarity: 1 - d[tau], db };
  }
}
