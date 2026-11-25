// How loud each played note is, and how that compares with the notes played around it.

export interface LoudNote {
  /** Seconds in the take. */
  start: number;
  end: number;
  /** Level at the note's loudest moment, dBFS. */
  db: number;
  /** Median level of the neighbours, or null when the note has none. */
  around: number | null;
  /** How much louder than that (dB). */
  diff: number | null;
  /** Enough neighbours on the same string to tell which note is the uneven one. */
  comparable: boolean;
}

export interface LoudInput {
  start: number;
  end: number;
  db: number;
  /** Only notes of the same string are compared; null: unknown, compared with nothing. Leave out to compare all. */
  string?: number | null;
}

/** Neighbours: this many nearest notes (of the string), before or after… */
const NEAR = 4;
/** …starting within this many seconds: over a longer pause the level is not comparable. */
const MAX_GAP_S = 5;

const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** With fewer neighbours one uneven note sways the median of the others, and there is no telling which of the notes is off. */
const MIN_NEAR = 3;

/** `notes` in order of start. */
export function loudness(notes: LoudInput[]): LoudNote[] {
  const groups = new Map<number | undefined, LoudInput[]>();
  for (const n of notes) {
    if (n.string === null) continue;
    const g = groups.get(n.string);
    if (g) g.push(n);
    else groups.set(n.string, [n]);
  }
  const near = new Map<LoudInput, number[]>();
  for (const g of groups.values())
    g.forEach((n, i) => {
      const a: number[] = [];
      // Outwards from the note, the nearer side first.
      for (let l = i - 1, r = i + 1; a.length < NEAR; ) {
        const dl = l >= 0 ? n.start - g[l].start : Infinity;
        const dr = r < g.length ? g[r].start - n.start : Infinity;
        if (Math.min(dl, dr) > MAX_GAP_S) break;
        a.push(g[dl <= dr ? l-- : r++].db);
      }
      near.set(n, a);
    });
  return notes.map((n) => {
    const a = near.get(n) ?? [];
    const around = a.length ? median(a) : null;
    return {
      start: n.start,
      end: n.end,
      db: n.db,
      around,
      diff: around === null ? null : n.db - around,
      comparable: n.string !== undefined && a.length >= MIN_NEAR,
    };
  });
}

export interface LoudSummary {
  median: number;
  /** From the quietest to the loudest note, dB. */
  range: number;
}

export const loudSummary = (notes: LoudNote[]): LoudSummary | null => {
  if (!notes.length) return null;
  const db = notes.map((n) => n.db);
  return { median: median(db), range: db.reduce((a, b) => Math.max(a, b)) - db.reduce((a, b) => Math.min(a, b)) };
};
