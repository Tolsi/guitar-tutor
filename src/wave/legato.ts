// Pitch tracking of a take for the note-pitch view and the legato exercise: the legato tab's tracker and
// judgement, run over recorded samples instead of a live input.
import { LIMITS, NoteTracker, type Limits, type Note } from "../legato/notes";
import { YinStream } from "../legato/yin";
import type { SampleStore } from "./store";

const MIN_CLARITY = 0.8;
const BLOCK = 4096;

export class LegatoAnalyzer {
  /** Grows with every change worth redrawing the panel for. */
  version = 0;
  /** Every voiced frame, including those that made no note: time (s) in the take and fractional MIDI pitch. */
  readonly frameT: number[] = [];
  readonly frameM: number[] = [];
  readonly tracker = new NoteTracker({ a4: 440, gateDb: -50, autoGate: true, minClarity: MIN_CLARITY, maxNotes: Infinity }, LIMITS.normal);
  private yin: YinStream;
  private pos = 0;
  private flushed = false;

  constructor(private readonly sr: number) {
    this.yin = new YinStream(sr);
  }

  /** Finished notes; `current` is the one sounding now, not judged yet. */
  get notes(): Note[] {
    return this.tracker.notes;
  }

  get current(): Note | null {
    return this.tracker.current;
  }

  setLimits(l: Limits) {
    if (this.tracker.limits === l) return;
    this.tracker.limits = l;
    this.tracker.reevaluate();
    this.version++;
  }

  /** Analyses what is new in `store` until `deadline` (performance.now()). `ended`: nothing more will come. */
  update(store: SampleStore, ended: boolean, deadline: number) {
    while (this.pos < store.length) {
      if (performance.now() > deadline) return;
      const x = store.slice(this.pos, this.pos + BLOCK);
      const base = this.pos;
      this.pos += x.length;
      this.yin.push(x, (i, f) => {
        const t = (base + i) / this.sr - this.yin.latency;
        if (this.tracker.push({ t, ...f })) this.version++;
        if (f.f0 !== null && f.clarity >= MIN_CLARITY && f.db >= this.tracker.gateDb) {
          this.frameT.push(t);
          this.frameM.push(this.tracker.midiOf(f.f0));
        }
      });
    }
    if (ended && !this.flushed) {
      this.flushed = true;
      if (this.tracker.flush()) this.version++;
    }
  }
}
