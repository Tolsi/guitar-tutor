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
}

/** Neighbours: this many notes on either side… */
const SIDE = 2;
/** …starting within this many seconds: over a longer pause the level is not comparable. */
const MAX_GAP_S = 3;

const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** `notes` in order of start. */
export function loudness(notes: { start: number; end: number; db: number }[]): LoudNote[] {
  return notes.map((n, i) => {
    const near: number[] = [];
    for (let j = Math.max(0, i - SIDE); j <= Math.min(notes.length - 1, i + SIDE); j++)
      if (j !== i && Math.abs(notes[j].start - n.start) <= MAX_GAP_S) near.push(notes[j].db);
    const around = near.length ? median(near) : null;
    return { ...n, around, diff: around === null ? null : n.db - around };
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
