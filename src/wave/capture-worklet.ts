// AudioWorklet: forwards the raw mono input to the main thread in blocks of BLOCK samples.
export {};

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, ctor: unknown): void;

const BLOCK = 1024;

class Capture extends AudioWorkletProcessor {
  private buf = new Float32Array(BLOCK);
  private n = 0;

  process(inputs: Float32Array[][]) {
    const ch = inputs[0]?.[0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === BLOCK) {
          this.port.postMessage(this.buf, [this.buf.buffer]);
          this.buf = new Float32Array(BLOCK);
          this.n = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor("wave-capture", Capture);
