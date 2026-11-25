// Spectrogram of a take: log frequency, drawn from cached tiles. Only what is on screen is computed, no finer
// than the screen can show, a little per frame.
import type { SampleStore } from "./store";

const N = 2048;
/** Column steps, samples: each zoom level has its own tiles. */
const HOPS = [480, 1920, 7680, 30720];
const ROWS = 192;
export const SPEC_LO = 60;
export const SPEC_HI = 8000;
/** Level (dB of a full-scale sine) drawn darkest and brightest. */
const DB_LO = -95;
const DB_HI = -20;
/** Columns in a tile. */
const TILE = 512;
const MAX_TILES = 64;

/** Height of a frequency, 0 at the bottom … 1 at the top. */
export const specPos = (hz: number) => Math.log(hz / SPEC_LO) / Math.log(SPEC_HI / SPEC_LO);

// Dark → violet → red → amber → near white.
const STOPS: [number, number, number, number][] = [
  [0, 8, 10, 14],
  [0.25, 46, 22, 92],
  [0.5, 160, 36, 88],
  [0.75, 232, 112, 44],
  [1, 255, 244, 190],
];
const LUT = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  const v = i / 255;
  let k = 0;
  while (k < STOPS.length - 2 && v > STOPS[k + 1][0]) k++;
  const [a, b] = [STOPS[k], STOPS[k + 1]];
  const t = (v - a[0]) / (b[0] - a[0]);
  const c = (j: 1 | 2 | 3) => Math.round(a[j] + (b[j] - a[j]) * t);
  LUT[i] = (255 << 24) | (c(3) << 16) | (c(2) << 8) | c(1);
}

const WIN = new Float64Array(N).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
const COS = new Float64Array(N / 2).map((_, i) => Math.cos((2 * Math.PI * i) / N));
const SIN = new Float64Array(N / 2).map((_, i) => -Math.sin((2 * Math.PI * i) / N));
const REV = new Uint16Array(N);
for (let i = 1, bits = Math.log2(N); i < N; i++) REV[i] = (REV[i >> 1] >> 1) | ((i & 1) << (bits - 1));
const re = new Float64Array(N), im = new Float64Array(N);

/** In place; input already in bit-reversed order. */
function fft() {
  for (let len = 2; len <= N; len <<= 1) {
    const half = len >> 1, step = N / len;
    for (let i = 0; i < N; i += len)
      for (let k = 0, t = 0; k < half; k++, t += step) {
        const a = i + k, b = a + half;
        const tr = re[b] * COS[t] - im[b] * SIN[t], ti = re[b] * SIN[t] + im[b] * COS[t];
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
  }
}

interface Tile {
  canvas: HTMLCanvasElement;
  g: CanvasRenderingContext2D;
  /** Columns computed, from the left. */
  cols: number;
}

export class Spectrogram {
  private tiles = new Map<string, Tile>();
  /** Bins a row covers: [from, to). */
  private from = new Uint16Array(ROWS);
  private to = new Uint16Array(ROWS);

  constructor(sr: number) {
    const bin = (r: number) => (SPEC_LO * (SPEC_HI / SPEC_LO) ** (r / ROWS) * N) / sr;
    for (let r = 0; r < ROWS; r++) {
      this.from[r] = Math.max(1, Math.round(bin(r)));
      this.to[r] = Math.min(N / 2, Math.max(this.from[r] + 1, Math.round(bin(r + 1))));
    }
  }

  private tile(hop: number, i: number, make: boolean): Tile | null {
    const key = `${hop}:${i}`;
    let t = this.tiles.get(key);
    if (!t) {
      if (!make) return null;
      const canvas = document.createElement("canvas");
      canvas.width = TILE;
      canvas.height = ROWS;
      t = { canvas, g: canvas.getContext("2d")!, cols: 0 };
    }
    // Most recently used last.
    this.tiles.delete(key);
    this.tiles.set(key, t);
    if (this.tiles.size > MAX_TILES) this.tiles.delete(this.tiles.keys().next().value!);
    return t;
  }

  /** Computes the tile's missing columns that `store` has the sound for, until the deadline. */
  private fill(t: Tile, hop: number, i: number, store: SampleStore, ended: boolean, deadline: number) {
    const first = i * TILE;
    const have = ended ? Math.ceil(store.length / hop) : Math.floor((store.length - N / 2) / hop) + 1;
    const until = Math.min(TILE, have - first);
    const start = t.cols;
    if (start >= until) return;
    const px: Uint32Array[] = [];
    while (t.cols < until && performance.now() < deadline) {
      // Two columns at once, as the real and the imaginary part; wide columns take the loudest of several.
      const two = t.cols + 1 < until;
      const a = new Uint32Array(ROWS), b = new Uint32Array(ROWS);
      const c = (first + t.cols) * hop;
      const parts = hop <= N ? 1 : 2;
      const va = new Float64Array(ROWS), vb = new Float64Array(ROWS);
      for (let k = 0; k < parts; k++) this.spectra(store, c + (k * hop) / parts, c + hop + (k * hop) / parts, va, vb);
      for (let r = 0; r < ROWS; r++) {
        a[r] = color(va[r]);
        b[r] = color(vb[r]);
      }
      px.push(a);
      t.cols++;
      if (two) {
        px.push(b);
        t.cols++;
      }
    }
    if (!px.length) return;
    const img = t.g.createImageData(px.length, ROWS);
    const out = new Uint32Array(img.data.buffer);
    px.forEach((col, x) => {
      for (let r = 0; r < ROWS; r++) out[(ROWS - 1 - r) * px.length + x] = col[r];
    });
    t.g.putImageData(img, start, 0);
  }

  /** Peak power per row around samples `ca` and `cb`, kept where louder than what is there. */
  private spectra(store: SampleStore, ca: number, cb: number, va: Float64Array, vb: Float64Array) {
    const xa = read(store, ca - N / 2), xb = read(store, cb - N / 2);
    for (let i = 0; i < N; i++) {
      const j = REV[i];
      re[j] = xa[i] * WIN[i];
      im[j] = xb[i] * WIN[i];
    }
    fft();
    for (let r = 0; r < ROWS; r++)
      for (let b = this.from[r]; b < this.to[r]; b++) {
        const m = N - b;
        const ar = re[b] + re[m], ai = im[b] - im[m], br = im[b] + im[m], bi = re[m] - re[b];
        va[r] = Math.max(va[r], (ar * ar + ai * ai) / 4);
        vb[r] = Math.max(vb[r], (br * br + bi * bi) / 4);
      }
  }

  /**
   * Draws take samples [s0, s1) so that sample s0 is at x0, computing what is missing until the deadline.
   * `ended`: the take will not grow.
   */
  draw(g: CanvasRenderingContext2D, store: SampleStore, ended: boolean, x0: number, y: number, h: number, s0: number, s1: number, spp: number, deadline: number) {
    // About a column per pixel; never finer than that.
    let level = 0;
    while (level + 1 < HOPS.length && HOPS[level + 1] <= spp * 2) level++;
    // Other levels under it stand in for what is not ready yet.
    for (let l = HOPS.length - 1; l >= 0; l--) if (l !== level) this.drawLevel(g, l, null, ended, x0, y, h, s0, s1, spp, deadline);
    this.drawLevel(g, level, store, ended, x0, y, h, s0, s1, spp, deadline);
  }

  private drawLevel(g: CanvasRenderingContext2D, level: number, store: SampleStore | null, ended: boolean, x0: number, y: number, h: number, s0: number, s1: number, spp: number, deadline: number) {
    const hop = HOPS[level], per = TILE * hop;
    // A column stands for the sound around its middle.
    const lead = hop > N ? 0 : hop / 2;
    // Too many tiles of a fine level under a wide view are not worth drawing.
    if (!store && (s1 - s0) / per > 12) return;
    for (let i = Math.max(0, Math.floor((s0 + lead) / per)); i * per - lead < s1; i++) {
      const t = this.tile(hop, i, store !== null && i * per < store.length);
      if (!t) continue;
      if (store) this.fill(t, hop, i, store, ended, deadline);
      if (!t.cols) continue;
      // Whole pixels, so tiles meet without a seam.
      const a = Math.round(x0 + (i * per - lead - s0) / spp), b = Math.round(x0 + (i * per + t.cols * hop - lead - s0) / spp);
      if (b > a) g.drawImage(t.canvas, 0, 0, t.cols, ROWS, a, y, b - a, h);
    }
  }
}

const NONE = new Float32Array(N);
/** N samples from `from`, zeros outside the store. */
function read(store: SampleStore, from: number): Float32Array {
  if (from >= 0 && from + N <= store.length) return store.slice(from, from + N);
  if (from + N <= 0 || from >= store.length) return NONE;
  const out = new Float32Array(N);
  for (let i = Math.max(0, -from); i < N && from + i < store.length; i++) out[i] = store.at(from + i);
  return out;
}

function color(power: number) {
  // A full-scale sine peaks at N / 4 through the Hann window.
  const db = 10 * Math.log10((power * 16) / (N * N) + 1e-13);
  return LUT[Math.max(0, Math.min(255, Math.round(((db - DB_LO) / (DB_HI - DB_LO)) * 255)))];
}
