// AudioWorklet: picks one channel of the input (the louder one, or a fixed one), outputs it as mono
// for monitoring, and forwards it to the main thread in blocks of BLOCK samples.
// Audio interfaces often put the guitar on input 2 only; averaging would lose 6 dB, taking
// channel 1 only would lose the guitar altogether.
export {};

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, ctor: unknown): void;

const BLOCK = 1024;

export type ChannelMode = "auto" | 0 | 1;

class Capture extends AudioWorkletProcessor {
  private buf = new Float32Array(BLOCK);
  private n = 0;
  private mode: ChannelMode = "auto";
  private power = [0, 0];
  private sel = 0;
  private sinceReport = 0;
  private gain = 1;
  private out = new Float32Array(128);
  // Noise gate: closes in pauses so input gain (and distortion after it) do not blow up the hiss.
  private gateOn = true;
  private gateMarginDb = 10;
  /** Smoothed (≈20 ms) mean square of the raw input, and the noise floor tracked from it, dB. */
  private ms = 0;
  private floorDb = NaN;
  /** Detector (≈5 ms mean square of the gained signal), gate gain, hold counter. */
  private det = 0;
  private g = 1;
  private open = true;
  private hold = 0;

  constructor() {
    super();
    this.port.onmessage = (
      e: MessageEvent<{ mode?: ChannelMode; gain?: number; gate?: boolean; gateMarginDb?: number }>,
    ) => {
      const d = e.data;
      if (d.mode !== undefined) this.mode = d.mode;
      if (d.gain !== undefined) this.gain = d.gain;
      if (d.gate !== undefined) this.gateOn = d.gate;
      if (d.gateMarginDb !== undefined) this.gateMarginDb = d.gateMarginDb;
    };
  }

  /** Follows the quietest stretches of the raw input: drops fast, rises 3 dB/s (so it recovers if the noise grows). */
  private trackFloor(raw: Float32Array) {
    let ss = 0;
    for (const v of raw) ss += v * v;
    this.ms += 0.13 * (ss / raw.length - this.ms);
    if (this.ms < 1e-12) return; // digital silence (muted interface) says nothing about the noise
    const db = 10 * Math.log10(this.ms);
    if (!(this.floorDb === this.floorDb) || db < this.floorDb) this.floorDb = db;
    else this.floorDb += Math.min(db - this.floorDb, (3 * raw.length) / sampleRate);
  }

  private gate(ch: Float32Array) {
    if (!this.gateOn || !(this.floorDb === this.floorDb)) {
      this.g = 1;
      this.open = true;
      return;
    }
    // Thresholds on the gained signal, as mean square; 4 dB hysteresis.
    const openDb = this.floorDb + 20 * Math.log10(this.gain) + this.gateMarginDb;
    const thOpen = 10 ** (openDb / 10);
    const thClose = 10 ** ((openDb - 4) / 10);
    const aDet = 1 - Math.exp(-1 / (sampleRate * 0.005));
    const aAtt = 1 - Math.exp(-1 / (sampleRate * 0.001));
    const aRel = 1 - Math.exp(-1 / (sampleRate * 0.08));
    const holdN = Math.round(sampleRate * 0.05);
    for (let i = 0; i < ch.length; i++) {
      const x = ch[i];
      this.det += aDet * (x * x - this.det);
      if (this.det > thOpen) {
        this.open = true;
        this.hold = holdN;
      } else if (this.det < thClose) {
        if (this.hold > 0) this.hold--;
        else this.open = false;
      }
      this.g += this.open ? aAtt * (1 - this.g) : aRel * (0 - this.g);
      ch[i] = x * this.g;
    }
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]) {
    const inp = inputs[0];
    const out = outputs[0]?.[0];
    if (!inp || !inp.length) {
      out?.fill(0);
      return true;
    }
    // Slow per-channel power (≈0.3 s) for the automatic choice.
    const a = 1 - Math.exp(-inp[0].length / (sampleRate * 0.3));
    for (let c = 0; c < Math.min(2, inp.length); c++) {
      let ss = 0;
      for (const v of inp[c]) ss += v * v;
      this.power[c] += a * (ss / inp[c].length - this.power[c]);
    }
    if (this.mode === "auto") {
      // Switch only on a clear (6 dB) difference so noise does not flip the choice.
      const other = 1 - this.sel;
      if (inp.length > 1 && this.power[other] > 4 * this.power[this.sel] + 1e-12) this.sel = other;
      if (inp.length === 1) this.sel = 0;
    } else this.sel = Math.min(this.mode, inp.length - 1);
    const raw = inp[this.sel];
    if (this.out.length !== raw.length) this.out = new Float32Array(raw.length);
    const ch = this.out;
    // Input gain for quiet interfaces: applied to the recording and the monitor alike.
    for (let i = 0; i < raw.length; i++) ch[i] = raw[i] * this.gain;
    this.trackFloor(raw);
    this.gate(ch);
    if (out) out.set(ch);
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === BLOCK) {
        this.port.postMessage(this.buf, [this.buf.buffer]);
        this.buf = new Float32Array(BLOCK);
        this.n = 0;
      }
    }
    if (++this.sinceReport >= 40) {
      this.sinceReport = 0;
      const db = this.power.slice(0, inp.length).map((p) => (p > 0 ? 10 * Math.log10(p) : -120));
      const floorDb = this.floorDb === this.floorDb ? this.floorDb : null;
      this.port.postMessage({ sel: this.sel, channels: inp.length, db, floorDb, gateOpen: this.open });
    }
    return true;
  }
}

registerProcessor("wave-capture", Capture);
