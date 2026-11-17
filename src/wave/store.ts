/** Growable mono sample buffer with a min/max summary per PEAK samples for fast zoomed-out drawing. */
const CHUNK_BITS = 16;
const CHUNK = 1 << CHUNK_BITS;
const MASK = CHUNK - 1;
export const PEAK_BITS = 8;
export const PEAK = 1 << PEAK_BITS;

export class SampleStore {
  length = 0;
  private chunks: Float32Array[] = [];
  pmin = new Float32Array(4096);
  pmax = new Float32Array(4096);

  readonly maxLength: number;

  constructor(maxLength: number) {
    this.maxLength = maxLength;
  }

  get full() {
    return this.length >= this.maxLength;
  }

  clear() {
    this.length = 0;
    this.chunks = [];
    this.pmin = new Float32Array(4096);
    this.pmax = new Float32Array(4096);
  }

  /** Number of peak blocks, including a partly filled last one. */
  get blocks() {
    return (this.length + PEAK - 1) >> PEAK_BITS;
  }

  push(data: Float32Array) {
    for (let i = 0; i < data.length && this.length < this.maxLength; i++) {
      const idx = this.length++;
      const c = idx >> CHUNK_BITS;
      if (c === this.chunks.length) this.chunks.push(new Float32Array(CHUNK));
      const v = data[i];
      this.chunks[c][idx & MASK] = v;
      const b = idx >> PEAK_BITS;
      if (b >= this.pmin.length) {
        const mn = new Float32Array(this.pmin.length * 2), mx = new Float32Array(this.pmax.length * 2);
        mn.set(this.pmin);
        mx.set(this.pmax);
        this.pmin = mn;
        this.pmax = mx;
      }
      if ((idx & (PEAK - 1)) === 0) {
        this.pmin[b] = v;
        this.pmax[b] = v;
      } else {
        if (v < this.pmin[b]) this.pmin[b] = v;
        if (v > this.pmax[b]) this.pmax[b] = v;
      }
    }
  }

  at(i: number) {
    return this.chunks[i >> CHUNK_BITS][i & MASK];
  }

  /** Copies samples [from, to) into a new array. */
  slice(from: number, to: number) {
    from = Math.max(0, Math.floor(from));
    to = Math.min(this.length, Math.ceil(to));
    const out = new Float32Array(Math.max(0, to - from));
    for (let i = from; i < to; i++) out[i - from] = this.at(i);
    return out;
  }

  /** Min and max of samples [from, to), using the peak summary where whole blocks fit. */
  range(from: number, to: number): [number, number] {
    from = Math.max(0, from);
    to = Math.min(this.length, to);
    let mn = Infinity, mx = -Infinity;
    let i = from;
    while (i < to && (i & (PEAK - 1)) !== 0) {
      const v = this.at(i++);
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    while (i + PEAK <= to) {
      const b = i >> PEAK_BITS;
      if (this.pmin[b] < mn) mn = this.pmin[b];
      if (this.pmax[b] > mx) mx = this.pmax[b];
      i += PEAK;
    }
    while (i < to) {
      const v = this.at(i++);
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    return [mn, mx];
  }
}
