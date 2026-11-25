// Spectrogram of a take: log frequency, computed a little per frame and drawn from cached tiles.
import { fft } from "./pm";
import type { SampleStore } from "./store";

const N = 2048;
const HOP = 480;
const ROWS = 192;
export const SPEC_LO = 60;
export const SPEC_HI = 8000;
/** Level (dB of a full-scale sine) drawn darkest and brightest. */
const DB_LO = -95;
const DB_HI = -20;
/** Columns in a tile. */
const TILE = 512;
/** For wide views: columns of COARSE fine ones, the loudest of each. */
const COARSE = 8;
const MAX_TILES = 96;

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
const re = new Float64Array(N), im = new Float64Array(N);

class Level {
  data = new Uint8Array(ROWS * 1024);
  cols = 0;
  /** By tile number; `cols` says how many columns were there when it was painted. */
  private tiles = new Map<number, { canvas: HTMLCanvasElement; cols: number }>();

  /** Offset of column `c`, made room for. */
  room(c: number) {
    if ((c + 1) * ROWS > this.data.length) {
      const d = new Uint8Array(this.data.length * 2);
      d.set(this.data);
      this.data = d;
    }
    return c * ROWS;
  }

  clear() {
    this.cols = 0;
    this.tiles.clear();
  }

  tile(i: number): HTMLCanvasElement | null {
    const cols = Math.min(TILE, this.cols - i * TILE);
    if (cols <= 0) return null;
    let t = this.tiles.get(i);
    if (!t) {
      const canvas = document.createElement("canvas");
      canvas.width = TILE;
      canvas.height = ROWS;
      t = { canvas, cols: 0 };
    }
    // Most recently used last.
    this.tiles.delete(i);
    this.tiles.set(i, t);
    if (this.tiles.size > MAX_TILES) this.tiles.delete(this.tiles.keys().next().value!);
    if (t.cols !== cols) {
      const g = t.canvas.getContext("2d")!;
      const img = g.createImageData(cols, ROWS);
      const px = new Uint32Array(img.data.buffer);
      for (let c = 0; c < cols; c++)
        for (let r = 0; r < ROWS; r++) px[(ROWS - 1 - r) * cols + c] = LUT[this.data[(i * TILE + c) * ROWS + r]];
      g.putImageData(img, 0, 0);
      t.cols = cols;
    }
    return t.canvas;
  }
}

export class Spectrogram {
  private fine = new Level();
  private coarse = new Level();
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

  /** Computes what is new in `store` until `deadline` (performance.now()). */
  update(store: SampleStore, deadline: number) {
    if (this.fine.cols * HOP > store.length + HOP) {
      this.fine.clear();
      this.coarse.clear();
    }
    while (this.fine.cols * HOP + N / 2 <= store.length) {
      if (performance.now() > deadline) return;
      this.column(store);
    }
  }

  private column(store: SampleStore) {
    const c = this.fine.cols;
    const s = c * HOP - N / 2;
    for (let i = 0; i < N; i++) {
      re[i] = s + i >= 0 ? store.at(s + i) * WIN[i] : 0;
      im[i] = 0;
    }
    fft(re, im);
    const o = this.fine.room(c);
    for (let r = 0; r < ROWS; r++) {
      let p = 0;
      for (let b = this.from[r]; b < this.to[r]; b++) p = Math.max(p, re[b] * re[b] + im[b] * im[b]);
      // A full-scale sine peaks at N / 4 through the Hann window.
      const db = 10 * Math.log10((p * 16) / (N * N) + 1e-13);
      this.fine.data[o + r] = Math.max(0, Math.min(255, ((db - DB_LO) / (DB_HI - DB_LO)) * 255));
    }
    this.fine.cols++;
    const cc = Math.floor(c / COARSE);
    const q = this.coarse.room(cc);
    if (c % COARSE === 0) this.coarse.data.fill(0, q, q + ROWS);
    for (let r = 0; r < ROWS; r++) this.coarse.data[q + r] = Math.max(this.coarse.data[q + r], this.fine.data[o + r]);
    if (c % COARSE === COARSE - 1) this.coarse.cols = cc + 1;
  }

  /** Draws take samples [s0, s1) so that sample s is at x = (s - s0) / spp + x0. */
  draw(g: CanvasRenderingContext2D, x0: number, y: number, h: number, s0: number, s1: number, spp: number) {
    const coarse = spp > HOP * COARSE * 0.5;
    const level = coarse ? this.coarse : this.fine;
    const hop = coarse ? HOP * COARSE : HOP;
    const per = TILE * hop;
    // A column stands for the sound around its middle.
    const lead = HOP / 2;
    for (let i = Math.max(0, Math.floor((s0 + lead) / per)); i * per - lead < s1; i++) {
      const t = level.tile(i);
      if (!t) break;
      // Whole pixels, so tiles meet without a seam.
      const a = Math.round(x0 + (i * per - lead - s0) / spp), b = Math.round(x0 + ((i + 1) * per - lead - s0) / spp);
      g.drawImage(t, a, y, b - a, h);
    }
  }
}
