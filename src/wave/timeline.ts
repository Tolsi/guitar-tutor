// Takes (recorded or imported audio) and clips (pieces of takes placed on lanes of a timeline).
// A clip refers to a range of its take's samples; moving or splitting a clip never copies audio.
import { SampleStore } from "./store";
import { LegatoAnalyzer } from "./legato";
import { PmAnalyzer } from "./pm";
import { Spectrogram } from "./spectro";

export interface Take {
  id: number;
  name: string;
  store: SampleStore;
  /** The clean guitar recorded alongside (before the effects), for analysis; absent for imported files. */
  dry?: SampleStore;
  pm: PmAnalyzer;
  lg: LegatoAnalyzer;
  spec: Spectrogram;
}

export interface Clip {
  id: number;
  take: Take;
  /** Range of take samples, [from, to). */
  from: number;
  to: number;
  /** Timeline position of the first sample, in samples. */
  pos: number;
  lane: number;
}

export const clipLen = (c: Clip) => c.to - c.from;
export const clipEnd = (c: Clip) => c.pos + c.to - c.from;

export class Timeline {
  clips: Clip[] = [];
  takes: Take[] = [];
  private nextClip = 1;
  private nextTake = 1;
  private undoStack: Clip[][] = [];

  constructor(readonly sr: number) {}

  get length() {
    let end = 0;
    for (const c of this.clips) end = Math.max(end, clipEnd(c));
    return end;
  }

  get lanes() {
    let n = 0;
    for (const c of this.clips) n = Math.max(n, c.lane + 1);
    return Math.max(1, n);
  }

  newTake(name: string, store: SampleStore, dry?: SampleStore): Take {
    const t: Take = { id: this.nextTake++, name, store, dry, pm: new PmAnalyzer(this.sr), lg: new LegatoAnalyzer(this.sr), spec: new Spectrogram(this.sr) };
    this.takes.push(t);
    return t;
  }

  get takeCount() {
    return this.nextTake - 1;
  }

  addClip(take: Take, from: number, to: number, pos: number, lane: number): Clip {
    const c: Clip = { id: this.nextClip++, take, from, to, pos, lane };
    this.clips.push(c);
    return c;
  }

  /** First lane, from `lane` down, where [pos, pos + len) overlaps no clip. */
  freeLane(pos: number, len: number, lane = 0, except?: Clip) {
    for (let l = lane; ; l++) {
      const busy = this.clips.some((c) => c !== except && c.lane === l && c.pos < pos + len && clipEnd(c) > pos);
      if (!busy) return l;
    }
  }

  /** Topmost clip on `lane` covering timeline sample `s`. */
  clipAt(s: number, lane: number) {
    for (let i = this.clips.length - 1; i >= 0; i--) {
      const c = this.clips[i];
      if (c.lane === lane && s >= c.pos && s < clipEnd(c)) return c;
    }
    return null;
  }

  checkpoint() {
    this.undoStack.push(this.clips.map((c) => ({ ...c })));
    if (this.undoStack.length > 100) this.undoStack.shift();
  }

  undo() {
    const prev = this.undoStack.pop();
    if (!prev) return false;
    this.clips = prev;
    return true;
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }

  /** Splits clips at timeline sample `s`: only `only` if given, otherwise every clip crossing it. */
  split(s: number, only?: Clip | null) {
    const targets = this.clips.filter((c) => (!only || c === only) && s > c.pos + 16 && s < clipEnd(c) - 16);
    if (!targets.length) return [];
    this.checkpoint();
    const made: Clip[] = [];
    for (const c of targets) {
      const cut = c.from + (s - c.pos);
      const right = this.addClip(c.take, cut, c.to, s, c.lane);
      c.to = cut;
      made.push(right);
    }
    return made;
  }

  remove(clip: Clip) {
    this.checkpoint();
    this.clips = this.clips.filter((c) => c !== clip);
  }

  clear() {
    this.clips = [];
    this.takes = [];
    this.undoStack = [];
  }

  /** Sum of all clips at timeline sample `s`. */
  sampleAt(s: number) {
    let v = 0;
    for (const c of this.clips) if (s >= c.pos && s < clipEnd(c)) v += c.take.store.at(c.from + s - c.pos);
    return v;
  }

  /** Mixes timeline samples [from, to) into a new buffer. */
  render(from: number, to: number) {
    from = Math.max(0, Math.floor(from));
    to = Math.max(from, Math.ceil(to));
    const out = new Float32Array(to - from);
    for (const c of this.clips) {
      const a = Math.max(from, c.pos), b = Math.min(to, clipEnd(c));
      const st = c.take.store;
      for (let s = a; s < b; s++) out[s - from] += st.at(c.from + s - c.pos);
    }
    return out;
  }

  /** Min / max over timeline samples [from, to) of each clip (a fast approximation of the mix). */
  range(from: number, to: number, lane?: number): [number, number] {
    let mn = Infinity, mx = -Infinity;
    for (const c of this.clips) {
      if (lane !== undefined && c.lane !== lane) continue;
      const a = Math.max(from, c.pos), b = Math.min(to, clipEnd(c));
      if (b <= a) continue;
      const [lo, hi] = c.take.store.range(c.from + a - c.pos, c.from + b - c.pos);
      if (lo < mn) mn = lo;
      if (hi > mx) mx = hi;
    }
    return [mn, mx];
  }
}

/** 24-bit PCM mono WAV. */
export function encodeWav(data: Float32Array, sr: number) {
  const bytes = 3;
  const buf = new ArrayBuffer(44 + data.length * bytes);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + data.length * bytes, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * bytes, true);
  v.setUint16(32, bytes, true);
  v.setUint16(34, 24, true);
  str(36, "data");
  v.setUint32(40, data.length * bytes, true);
  let o = 44;
  for (let i = 0; i < data.length; i++, o += 3) {
    const x = Math.max(-1, Math.min(1, data[i]));
    const n = Math.round(x < 0 ? x * 0x800000 : x * 0x7fffff);
    v.setUint8(o, n & 0xff);
    v.setUint8(o + 1, (n >> 8) & 0xff);
    v.setUint8(o + 2, (n >> 16) & 0xff);
  }
  return new Blob([buf], { type: "audio/wav" });
}
