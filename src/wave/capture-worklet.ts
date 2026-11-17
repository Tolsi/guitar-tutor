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

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<{ mode: ChannelMode }>) => (this.mode = e.data.mode);
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
    const ch = inp[this.sel];
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
      this.port.postMessage({ sel: this.sel, channels: inp.length, db });
    }
    return true;
  }
}

registerProcessor("wave-capture", Capture);
