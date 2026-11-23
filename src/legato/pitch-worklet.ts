// AudioWorklet: YIN pitch detection on the guitar input.
import { YinStream } from "./yin";

declare const sampleRate: number;
declare const currentTime: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, ctor: unknown): void;

class YinPitch extends AudioWorkletProcessor {
  private readonly yin = new YinStream(sampleRate);
  private power = [0, 0];
  private sel = 0;

  process(inputs: Float32Array[][]) {
    const inp = inputs[0];
    if (!inp?.length) return true;
    // Interfaces often carry the guitar on one channel only, and mixing to mono would lose 6 dB: take the
    // louder channel, switching on a clear (6 dB) difference only.
    const a = 1 - Math.exp(-inp[0].length / (sampleRate * 0.3));
    for (let c = 0; c < Math.min(2, inp.length); c++) {
      let ss = 0;
      for (const v of inp[c]) ss += v * v;
      this.power[c] += a * (ss / inp[c].length - this.power[c]);
    }
    const other = 1 - this.sel;
    if (inp.length === 1) this.sel = 0;
    else if (this.power[other] > 4 * this.power[this.sel] + 1e-12) this.sel = other;
    const ch = inp[this.sel];
    this.yin.push(ch, (end, f) => this.port.postMessage({ t: currentTime + end / sampleRate - this.yin.latency, ...f }));
    return true;
  }
}

registerProcessor("yin-pitch", YinPitch);
