export interface PitchFrame {
  t: number;
  f0: number | null;
  clarity: number;
  db: number;
}

/** Pitch of one frame inside a note, in cents from the note's equal-tempered pitch. */
export interface NotePoint {
  t: number;
  cents: number;
  db: number;
}

export type Strictness = "soft" | "normal" | "strict";

export interface Limits {
  wobble: number;
  spread: number;
  overshoot: number;
  drift: number;
  center: number;
}

export const LIMITS: Record<Strictness, Limits> = {
  soft: { wobble: 9, spread: 32, overshoot: 14, drift: 18, center: 25 },
  normal: { wobble: 6, spread: 22, overshoot: 9, drift: 12, center: 15 },
  strict: { wobble: 4, spread: 14, overshoot: 6, drift: 8, center: 10 },
};

export type IssueKind = "wobble" | "overshoot" | "undershoot" | "driftUp" | "driftDown" | "sharp" | "flat";

export const ISSUE_LABEL: Record<IssueKind, string> = {
  wobble: "виляет",
  overshoot: "пережим в начале",
  undershoot: "подъезд снизу",
  driftUp: "уплывает вверх",
  driftDown: "уплывает вниз",
  sharp: "выше строя",
  flat: "ниже строя",
};

export interface Issue {
  kind: IssueKind;
  text: string;
}

export interface NoteEval {
  center: number;
  wobble: number;
  spread: number;
  overshoot: number;
  drift: number;
  /** Start of the analysed part; earlier frames are the attack transient. */
  from: number;
  issues: Issue[];
  clean: boolean;
}

export interface Note {
  id: number;
  start: number;
  end: number;
  midi: number;
  points: NotePoint[];
  attack: "pick" | "legato";
  peakDb: number;
  eval: NoteEval | null;
}

export interface TrackerOpts {
  a4: number;
  gateDb: number;
  minClarity: number;
}

const NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
export const noteName = (midi: number) => `${NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;

const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
export const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const quantile = (a: number[], q: number) => {
  const s = [...a].sort((x, y) => x - y);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (i - lo);
};

function linearFit(ts: number[], ys: number[]) {
  const mt = mean(ts), my = mean(ys);
  let num = 0, den = 0;
  for (let i = 0; i < ts.length; i++) {
    num += (ts[i] - mt) * (ys[i] - my);
    den += (ts[i] - mt) ** 2;
  }
  const slope = den > 0 ? num / den : 0;
  return { slope, at: (t: number) => my + slope * (t - mt) };
}

const ATTACK_SKIP = 0.02;
const ATTACK_WINDOW = 0.12;
const TAIL_SKIP = 0.025;
const MIN_NOTE = 0.08;
// A pitch more than this far from the current note, held for SWITCH_FRAMES, starts a new note.
const SWITCH_SEMITONES = 0.75;
const SWITCH_FRAMES = 3;
const SILENCE_FRAMES = 4;
const PICK_RISE_DB = 5;

export function evaluate(note: Note, L: Limits): NoteEval | null {
  if (note.end - note.start < MIN_NOTE) return null;
  const from = note.start + ATTACK_SKIP;
  const pts = note.points.filter((p) => p.t >= from && p.t <= note.end - TAIL_SKIP && p.db >= note.peakDb - 30);
  if (pts.length < 5) return null;

  const early = pts.filter((p) => p.t < note.start + ATTACK_WINDOW);
  const late = pts.filter((p) => p.t >= note.start + ATTACK_WINDOW);
  const body = late.length >= 4 ? late : pts;

  const fit = linearFit(body.map((p) => p.t), body.map((p) => p.cents));
  const resid = body.map((p) => p.cents - fit.at(p.t));
  const center = median(body.map((p) => p.cents));
  const wobble = Math.sqrt(mean(resid.map((r) => r * r)));
  const spread = quantile(resid, 0.95) - quantile(resid, 0.05);
  const span = body[body.length - 1].t - body[0].t;
  const drift = fit.slope * span;
  let overshoot = 0;
  if (early.length >= 2 && late.length >= 4) {
    const ec = early.map((p) => p.cents);
    const hi = quantile(ec, 0.8) - center;
    const lo = quantile(ec, 0.2) - center;
    overshoot = hi > -lo ? hi : lo;
  }

  const r = (v: number) => Math.round(Math.abs(v));
  const issues: Issue[] = [];
  const wobbly = wobble > L.wobble || spread > L.spread;
  if (wobbly)
    issues.push({ kind: "wobble", text: `Нота виляет на ±${r(spread / 2)} ц. Палец меняет давление: держите лад ровно, не раскачивайте струну.` });
  const up = drift > L.drift, down = drift < -L.drift;
  if (up)
    issues.push({ kind: "driftUp", text: `Нота уплывает вверх на ${r(drift)} ц: палец давит сильнее или тянет струну вбок.` });
  else if (down)
    issues.push({ kind: "driftDown", text: `Нота уплывает вниз на ${r(drift)} ц: палец ослабляет нажим раньше времени.` });
  // A wobble or a steady drift already explains an uneven start; don't count it twice.
  if (!wobbly && !down && overshoot > L.overshoot)
    issues.push({ kind: "overshoot", text: `Пережим при ударе: в начале нота на ${r(overshoot)} ц выше, потом опускается. Бейте пальцем точно и не додавливайте.` });
  else if (!wobbly && !up && overshoot < -L.overshoot)
    issues.push({ kind: "undershoot", text: `Нота подъезжает снизу на ${r(overshoot)} ц: палец доходит до лада не сразу. Ставьте его одним движением.` });
  if (center > L.center)
    issues.push({ kind: "sharp", text: `Нота выше строя на ${r(center)} ц: пережим лада или гитара не настроена.` });
  else if (center < -L.center)
    issues.push({ kind: "flat", text: `Нота ниже строя на ${r(center)} ц: проверьте настройку гитары.` });

  return { center, wobble, spread, overshoot, drift, from, issues, clean: issues.length === 0 };
}

export class NoteTracker {
  readonly notes: Note[] = [];
  current: Note | null = null;
  private pending: { t: number; midi: number; db: number }[] = [];
  private silent = 0;
  private nextId = 1;

  opts: TrackerOpts;
  limits: Limits;

  constructor(opts: TrackerOpts, limits: Limits) {
    this.opts = opts;
    this.limits = limits;
  }

  midiOf(f: number) {
    return 69 + 12 * Math.log2(f / this.opts.a4);
  }

  clear() {
    this.notes.length = 0;
    this.current = null;
    this.pending = [];
    this.silent = 0;
  }

  reevaluate() {
    for (const n of this.notes) n.eval = evaluate(n, this.limits);
  }

  /** Returns the note that just ended, if any. */
  push(fr: PitchFrame): Note | null {
    const voiced = fr.f0 !== null && fr.clarity >= this.opts.minClarity && fr.db >= this.opts.gateDb;
    if (!voiced) {
      this.pending = [];
      if (this.current && ++this.silent >= SILENCE_FRAMES) return this.finish();
      return null;
    }
    this.silent = 0;
    const m = this.midiOf(fr.f0!);
    const cur = this.current;

    if (cur && Math.abs(m - cur.midi) < SWITCH_SEMITONES) {
      this.pending = [];
      cur.points.push({ t: fr.t, cents: (m - cur.midi) * 100, db: fr.db });
      cur.end = fr.t;
      cur.peakDb = Math.max(cur.peakDb, fr.db);
      return null;
    }

    const last = this.pending.at(-1);
    if (last && Math.abs(m - last.midi) >= SWITCH_SEMITONES) this.pending = [];
    this.pending.push({ t: fr.t, midi: m, db: fr.db });
    if (this.pending.length < SWITCH_FRAMES) return null;

    const prevDb = cur?.points.at(-1)?.db ?? null;
    const ended = cur ? this.finish() : null;
    const midi = Math.round(median(this.pending.map((p) => p.midi)));
    const peak = Math.max(...this.pending.map((p) => p.db));
    this.current = {
      id: this.nextId++,
      start: this.pending[0].t,
      end: fr.t,
      midi,
      points: this.pending.map((p) => ({ t: p.t, cents: (p.midi - midi) * 100, db: p.db })),
      attack: prevDb === null || peak - prevDb > PICK_RISE_DB ? "pick" : "legato",
      peakDb: peak,
      eval: null,
    };
    this.pending = [];
    return ended;
  }

  private finish(): Note | null {
    const n = this.current;
    this.current = null;
    if (!n) return null;
    n.eval = evaluate(n, this.limits);
    if (!n.eval) return null;
    this.notes.push(n);
    if (this.notes.length > 300) this.notes.shift();
    return n;
  }
}

export interface Summary {
  count: number;
  clean: number;
  issues: Partial<Record<IssueKind, number>>;
  legatoGapDb: number | null;
}

export function summarize(notes: Note[]): Summary {
  const rated = notes.filter((n) => n.eval);
  const issues: Partial<Record<IssueKind, number>> = {};
  for (const n of rated) for (const i of n.eval!.issues) issues[i.kind] = (issues[i.kind] ?? 0) + 1;
  const legato = rated.filter((n) => n.attack === "legato").map((n) => n.peakDb);
  const pick = rated.filter((n) => n.attack === "pick").map((n) => n.peakDb);
  return {
    count: rated.length,
    clean: rated.filter((n) => n.eval!.clean).length,
    issues,
    legatoGapDb: legato.length >= 3 && pick.length >= 2 ? median(legato) - median(pick) : null,
  };
}
