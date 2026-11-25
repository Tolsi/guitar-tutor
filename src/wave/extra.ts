// Sounds that do not belong to a note: another string ringing along, a squeak, a knock. A note is compared
// with the same note played elsewhere in the take: the same stroke decays the same way in every band.
import { BANDS, type PmAnalyzer, type PmNote } from "./pm";

export interface Extra {
  /** Seconds after the attack where it begins to stand out. */
  at: number;
  /** How far it stands out at most, dB. */
  db: number;
  /** How long it stands out, s. */
  length: number;
}

/** Looked for from this long after the attack (its own burst is over) to this long. */
const FROM_S = 0.12;
const TO_S = 0.8;
/** The pick comes down for the next note this long before it. */
const NEXT_S = 0.12;
const STEP_HOPS = 2;
/** Same notes compared with: the nearest ones, at least MIN_PEERS of them. */
const PEERS = 8;
const MIN_PEERS = 3;
/** Louder than the peers' median by this much… */
const EXCESS_DB = 12;
/** …and than the loudest of them by this much: a note among uneven ones is not singled out. */
const OVER_MAX_DB = 4;
/** Quieter than this under the note nobody hears it. */
const AUDIBLE_DB = 50;
/** Shorter than this it is a fluctuation. */
const MIN_LENGTH_S = 0.04;

const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const midi = (n: PmNote) => Math.round(69 + 12 * Math.log2(n.f0! / 440));

interface Span {
  note: PmNote;
  start: number;
  end: number;
}

/** Remembered while the note, its end and its peers stay the same. */
const cache = new WeakMap<PmNote, { key: string; extra: Extra | null }>();

/** `same`: notes to compare with each other (muted ones; an open note rings on in every band). */
export function findExtra(pm: PmAnalyzer, same: (n: PmNote) => boolean): Map<PmNote, Extra> {
  const hopS = pm.hop / pm.sr;
  const groups = new Map<number, Span[]>();
  pm.notes.forEach((note, i) => {
    const next = pm.notes[i + 1];
    if (note.f0 === null || !same(note) || !(next || note.done)) return;
    const start = Math.round(note.start / pm.hop);
    const stop = next ? Math.round(Math.min(next.start - NEXT_S * pm.sr, next.touchAt ?? Infinity) / pm.hop) : pm.frames;
    const g = groups.get(midi(note)) ?? [];
    groups.set(midi(note), g);
    g.push({ note, start, end: Math.min(stop, start + Math.round(TO_S / hopS)) });
  });
  const out = new Map<PmNote, Extra>();
  for (const g of groups.values())
    g.forEach((s, i) => {
      const peers: Span[] = [];
      for (let d = 1; d < g.length && peers.length < PEERS; d++) {
        if (i - d >= 0) peers.push(g[i - d]);
        if (i + d < g.length) peers.push(g[i + d]);
      }
      if (peers.length < MIN_PEERS) return;
      const key = [s, ...peers].map((p) => `${p.start}-${p.end}`).join();
      let c = cache.get(s.note);
      if (c?.key !== key) cache.set(s.note, (c = { key, extra: compare(pm, s, peers) }));
      if (c.extra) out.set(s.note, c.extra);
    });
  return out;
}

function compare(pm: PmAnalyzer, s: Span, peers: Span[]): Extra | null {
  const hopS = pm.hop / pm.sr;
  let best = null as Extra | null;
  for (let b = 0; b < BANDS; b++) {
    let run = 0;
    let cur = null as Extra | null;
    for (let d = Math.round(FROM_S / hopS); s.start + d < s.end; d += STEP_HOPS) {
      const db = pm.bands[(s.start + d) * BANDS + b] - s.note.peakDb;
      const ref = peers.filter((p) => p.start + d < p.end).map((p) => pm.bands[(p.start + d) * BANDS + b] - p.note.peakDb);
      if (ref.length < MIN_PEERS) break;
      const excess = db - median(ref);
      if (db < -AUDIBLE_DB || excess < EXCESS_DB || db < Math.max(...ref) + OVER_MAX_DB) {
        run = 0;
        cur = null;
        continue;
      }
      run += STEP_HOPS * hopS;
      const found: Extra = cur !== null && cur.db >= excess ? { at: cur.at, db: cur.db, length: run } : { at: cur ? cur.at : d * hopS, db: excess, length: run };
      cur = found;
      if (run >= MIN_LENGTH_S && (!best || found.db > best.db)) best = found;
    }
  }
  return best;
}
