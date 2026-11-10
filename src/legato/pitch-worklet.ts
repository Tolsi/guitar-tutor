// AudioWorklet: YIN pitch detection on the guitar input, one frame every ~10.7 ms.
export {};

declare const sampleRate: number;
declare const currentTime: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, ctor: unknown): void;

// Guitar fundamentals stay under ~1.4 kHz, so halving the rate keeps accuracy and quarters the YIN cost.
const DECIM = 2;
const BUF = 1024;
const HOP = 256;
const THRESHOLD = 0.15;
const F_MIN = 70;
const F_MAX = 1400;

class YinPitch extends AudioWorkletProcessor {
  private readonly sr = sampleRate / DECIM;
  private readonly tauMin = Math.floor(this.sr / F_MAX);
  private readonly tauMax = Math.min(Math.ceil(this.sr / F_MIN), BUF / 2);
  private readonly win = BUF - this.tauMax;
  private readonly ring = new Float32Array(BUF);
  private readonly frame = new Float32Array(BUF);
  private readonly d = new Float32Array(this.tauMax + 2);
  private pos = 0;
  private filled = 0;
  private sinceHop = 0;
  private acc = 0;
  private accN = 0;

  process(inputs: Float32Array[][]) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.acc += ch[i];
      if (++this.accN < DECIM) continue;
      this.ring[this.pos] = this.acc / DECIM;
      this.pos = (this.pos + 1) % BUF;
      this.acc = 0;
      this.accN = 0;
      if (this.filled < BUF) this.filled++;
      if (++this.sinceHop >= HOP && this.filled === BUF) {
        this.sinceHop = 0;
        const t = currentTime + (i + 1) / sampleRate - BUF / 2 / this.sr;
        this.port.postMessage({ t, ...this.detect() });
      }
    }
    return true;
  }

  private detect(): { f0: number | null; clarity: number; db: number } {
    const x = this.frame;
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

registerProcessor("yin-pitch", YinPitch);
