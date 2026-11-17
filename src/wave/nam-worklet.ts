// AudioWorklet: runs a Neural Amp Modeler (.nam) model on the mono guitar signal.
// Without a loaded model the signal passes through unchanged.
import { createNamModule, NamWasmModule } from "@opendaw/nam-wasm";

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}
declare function registerProcessor(name: string, ctor: unknown): void;

type InMsg = { type: "load"; json: string } | { type: "unload" };

class NamProcessor extends AudioWorkletProcessor {
  private nam: NamWasmModule | null = null;
  private id = -1;
  private active = false;
  private pending: InMsg | null = null;

  constructor(options: { processorOptions: { wasm: ArrayBuffer } }) {
    super();
    this.port.onmessage = (e: MessageEvent<InMsg>) => this.handle(e.data);
    // The worklet scope has no fetch, so the main thread hands over the wasm binary.
    createNamModule({ wasmBinary: options.processorOptions.wasm, locateFile: (p: string) => p })
      .then((m) => {
        this.nam = NamWasmModule.fromModule(m);
        this.nam.setSampleRate(sampleRate);
        this.id = this.nam.createInstance();
        this.port.postMessage({ type: "ready" });
        if (this.pending) this.handle(this.pending);
      })
      .catch((err: unknown) => this.port.postMessage({ type: "error", message: String(err) }));
  }

  private handle(msg: InMsg) {
    if (!this.nam) {
      this.pending = msg;
      return;
    }
    this.pending = null;
    if (msg.type === "unload") {
      this.active = false;
      this.nam.unloadModel(this.id);
      return;
    }
    this.active = false;
    let ok = false;
    try {
      ok = this.nam.loadModel(this.id, msg.json);
    } catch {
      ok = false;
    }
    const loudness = ok ? this.measure() : null;
    this.active = ok;
    this.port.postMessage({ type: "loaded", ok, loudness });
  }

  /** Output RMS in dBFS for a fixed strummed test chord, so captures can be level-matched. */
  private measure() {
    const nam = this.nam!;
    const inp = new Float32Array(128), out = new Float32Array(128);
    const n = Math.round(sampleRate * 0.5), skip = Math.round(sampleRate * 0.05);
    const saw = (x: number) => 2 * (x - Math.floor(x)) - 1;
    let ss = 0, cnt = 0;
    for (let i = 0; i < n; i += 128) {
      for (let j = 0; j < 128; j++) {
        const t = (i + j) / sampleRate;
        inp[j] = 0.15 * Math.exp(-t * 4) * (saw(110 * t) + 0.7 * saw(164.8 * t) + 0.5 * saw(220 * t));
      }
      nam.process(this.id, inp, out);
      if (i >= skip) for (let j = 0; j < 128; j++) (ss += out[j] * out[j]), cnt++;
    }
    nam.reset(this.id);
    return cnt && ss > 0 ? 10 * Math.log10(ss / cnt) : null;
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]) {
    const out = outputs[0]?.[0];
    if (!out) return true;
    const inp = inputs[0]?.[0];
    if (!inp) out.fill(0);
    else if (this.active && this.nam) this.nam.process(this.id, inp, out);
    else out.set(inp);
    return true;
  }
}

registerProcessor("nam-amp", NamProcessor);
