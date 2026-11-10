export type Vec = { x: number; y: number };
export type Vec3 = { x: number; y: number; z: number };

/** One video frame of the strumming arm, in video pixels (hand world points in metres). */
export interface RawFrame {
  t: number;
  shoulder: Vec;
  elbow: Vec;
  wrist: Vec;
  otherShoulder: Vec | null;
  ear: Vec | null;
  hand: Vec[] | null;
  handWorld: Vec3[] | null;
}

export interface Sample {
  t: number;
  wrist: Vec;
  /** Middle knuckle when the hand is tracked (close to the pick), else the wrist. */
  strike: Vec;
  elbow: Vec;
  shoulder: Vec;
  foreLen: number;
  upper: number;
  forearm: number;
  elbowJoint: number;
  flex: number | null;
  handLen: number | null;
  palmTilt: number | null;
  curl: number | null;
  shoulderLift: number | null;
}

export interface Turn {
  t: number;
  y: number;
  kind: "top" | "bottom";
}

export interface Shares {
  shoulder: number;
  elbow: number;
  wrist: number;
}

export interface Metrics {
  active: boolean;
  spm: number | null;
  amplitude: number | null;
  shares: Shares | null;
  wristLoose: number | null;
  whip: number | null;
  fingers: number | null;
  shoulder: number | null;
  smooth: number | null;
  raw: Record<string, number | null>;
}

export type Level = "lost" | "idle" | "good" | "warn" | "bad";

export interface Tip {
  sev: "warn" | "bad";
  text: string;
}

export interface Verdict {
  level: Level;
  title: string;
  text: string;
  tips: Tip[];
  relax: number | null;
}

const BUFFER_MS = 4000;
const WINDOW_MS = 2000;
// Middle, ring, pinky: index and thumb often hold the pick, so their curl says little about tension.
const FINGERS: [number, number, number][] = [
  [9, 10, 11],
  [13, 14, 15],
  [17, 18, 19],
];

export const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
export const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
export const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
export const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y);
const angleOf = (v: Vec) => Math.atan2(v.y, v.x);
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
const std = (a: number[]) => {
  const m = mean(a);
  return Math.sqrt(mean(a.map((v) => (v - m) ** 2)));
};
export const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const diff = (a: number[]) => a.slice(1).map((v, i) => v - a[i]);
function corr(a: number[], b: number[]) {
  const n = Math.min(a.length, b.length);
  if (n < 4) return 0;
  const ma = mean(a.slice(0, n));
  const mb = mean(b.slice(0, n));
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

const sub3 = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot3 = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross3 = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
function angle3(a: Vec3, b: Vec3, c: Vec3) {
  const u = sub3(a, b), v = sub3(c, b);
  const d = Math.sqrt(dot3(u, u) * dot3(v, v));
  return d > 0 ? (Math.acos(clamp(dot3(u, v) / d, -1, 1)) * 180) / Math.PI : 180;
}

export class Tracker {
  readonly samples: Sample[] = [];
  readonly turns: Turn[] = [];
  private dir: 1 | -1 = 1;
  private extreme: { t: number; y: number } | null = null;

  reset() {
    this.samples.length = 0;
    this.turns.length = 0;
    this.extreme = null;
  }

  push(f: RawFrame): Sample {
    let prev = this.samples.at(-1);
    if (prev && f.t - prev.t > 400) {
      this.reset();
      prev = undefined;
    }

    const upperRaw = angleOf(sub(f.elbow, f.shoulder));
    const foreRaw = angleOf(sub(f.wrist, f.elbow));
    const upper = prev ? prev.upper + wrap(upperRaw - prev.upper) : upperRaw;
    const forearm = prev ? prev.forearm + wrap(foreRaw - prev.forearm) : foreRaw;

    let flex: number | null = null;
    let handLen: number | null = null;
    if (f.hand) {
      handLen = dist(f.hand[0], f.hand[9]);
      flex = wrap(angleOf(sub(f.hand[9], f.hand[0])) - foreRaw);
    }

    let palmTilt: number | null = null;
    let curl: number | null = null;
    if (f.handWorld) {
      const w = f.handWorld;
      const n = cross3(sub3(w[5], w[0]), sub3(w[17], w[0]));
      palmTilt = Math.atan2(Math.hypot(n.x, n.y), Math.abs(n.z));
      curl = mean(FINGERS.map(([a, b, c]) => angle3(w[a], w[b], w[c])));
    }

    const shoulderLift =
      f.ear && f.otherShoulder
        ? (f.shoulder.y - f.ear.y) / Math.max(1, dist(f.shoulder, f.otherShoulder))
        : null;

    const s: Sample = {
      t: f.t,
      wrist: f.wrist,
      strike: f.hand ? f.hand[9] : f.wrist,
      elbow: f.elbow,
      shoulder: f.shoulder,
      foreLen: dist(f.wrist, f.elbow),
      upper,
      forearm,
      elbowJoint: forearm - upper,
      flex,
      handLen,
      palmTilt,
      curl,
      shoulderLift,
    };
    this.samples.push(s);
    while (this.samples.length && this.samples[0].t < f.t - BUFFER_MS) this.samples.shift();
    this.updateTurns(s);
    while (this.turns.length && this.turns[0].t < f.t - BUFFER_MS) this.turns.shift();
    return s;
  }

  /** Hysteresis peak detector on wrist height: each turn is the end of a down- or up-stroke. */
  private updateTurns(s: Sample) {
    const y = s.strike.y;
    const thr = 0.12 * s.foreLen;
    if (!this.extreme) {
      this.extreme = { t: s.t, y };
      return;
    }
    if (this.dir === 1) {
      if (y > this.extreme.y) this.extreme = { t: s.t, y };
      else if (this.extreme.y - y > thr) {
        this.turns.push({ ...this.extreme, kind: "bottom" });
        this.dir = -1;
        this.extreme = { t: s.t, y };
      }
    } else {
      if (y < this.extreme.y) this.extreme = { t: s.t, y };
      else if (y - this.extreme.y > thr) {
        this.turns.push({ ...this.extreme, kind: "top" });
        this.dir = 1;
        this.extreme = { t: s.t, y };
      }
    }
  }
}

const EMPTY: Metrics = {
  active: false,
  spm: null,
  amplitude: null,
  shares: null,
  wristLoose: null,
  whip: null,
  fingers: null,
  shoulder: null,
  smooth: null,
  raw: {},
};

export function analyze(tr: Tracker, now: number, liftBaseline: number | null): Metrics {
  const win = tr.samples.filter((s) => s.t >= now - WINDOW_MS);
  if (win.length < 12) return EMPTY;

  const turns = tr.turns.filter((t) => t.t >= now - 2500);
  const last = turns.at(-1);
  const active = turns.length >= 2 && !!last && now - last.t < 1200;
  const foreLen = median(win.map((s) => s.foreLen));

  let spm: number | null = null;
  let amplitude: number | null = null;
  let strokeMs: number | null = null;
  if (turns.length >= 2) {
    strokeMs = mean(diff(turns.map((t) => t.t)));
    spm = 60000 / strokeMs;
    amplitude = mean(diff(turns.map((t) => t.y)).map(Math.abs)) / foreLen;
  }

  // How far the wrist travels because of each joint, all in pixels so they are comparable.
  const shoulderC = Math.hypot(std(win.map((s) => s.elbow.x)), std(win.map((s) => s.elbow.y)));
  const elbowC = std(win.map((s) => s.elbowJoint)) * foreLen;

  const withHand = win.filter((s) => s.flex !== null && s.handLen !== null);
  const handOk = withHand.length >= win.length * 0.6;
  const handLen = handOk ? median(withHand.map((s) => s.handLen!)) : 0;
  const wristC = handOk ? std(withHand.map((s) => s.flex!)) * handLen : 0;
  const tilts = withHand.filter((s) => s.palmTilt !== null).map((s) => s.palmTilt!);
  const rotC = handOk && tilts.length >= withHand.length * 0.8 ? std(tilts) * handLen * 0.8 : 0;

  const total = shoulderC + elbowC + rotC + wristC;
  const shares: Shares | null =
    active && total > 0
      ? { shoulder: shoulderC / total, elbow: (elbowC + rotC) / total, wrist: wristC / total }
      : null;

  // A locked wrist barely flexes while the arm moves.
  const wristRatio = wristC / Math.max(1e-6, shoulderC + elbowC + rotC);
  const wristLoose = handOk && active ? smoothstep(0.08, 0.28, wristRatio) : null;

  // A loose hand trails the forearm like a whip: flex velocity opposes forearm velocity, slightly delayed.
  let whipRaw: number | null = null;
  if (handOk && active) {
    const dF = diff(withHand.map((s) => s.forearm));
    const dW = diff(withHand.map((s) => s.flex!));
    let minC = 1;
    for (let k = 0; k <= 3; k++) minC = Math.min(minC, corr(dF.slice(0, dF.length - k), dW.slice(k)));
    whipRaw = clamp(-minC);
  }
  const whip = whipRaw === null ? null : smoothstep(0.05, 0.45, whipRaw);

  const curls = win.filter((s) => s.curl !== null).map((s) => s.curl!);
  let fingers: number | null = null;
  let curlMean: number | null = null;
  let curlStd: number | null = null;
  if (curls.length >= win.length * 0.6) {
    curlMean = mean(curls);
    curlStd = std(curls);
    const posture =
      curlMean < 95 ? smoothstep(50, 95, curlMean) : curlMean < 160 ? 1 : 1 - 0.6 * smoothstep(160, 176, curlMean);
    fingers = active ? 0.5 * posture + 0.5 * smoothstep(0.8, 3.5, curlStd) : posture;
  }

  const lifts = win.filter((s) => s.shoulderLift !== null).map((s) => s.shoulderLift!);
  let shoulder: number | null = null;
  let liftDrop: number | null = null;
  if (liftBaseline !== null && lifts.length >= win.length * 0.5) {
    liftDrop = (liftBaseline - median(lifts)) / liftBaseline;
    shoulder = 1 - smoothstep(0.06, 0.18, liftDrop);
  }

  // Jerkiness: wrist height minus its 3-frame average, relative to stroke size. Skipped for very fast strums.
  let smooth: number | null = null;
  let jitter: number | null = null;
  if (active && strokeMs !== null && strokeMs > 150) {
    const ys = win.map((s) => s.strike.y);
    const res = ys.slice(1, -1).map((y, i) => y - (ys[i] + y + ys[i + 2]) / 3);
    jitter = std(res) / Math.max(1e-6, std(ys));
    smooth = 1 - smoothstep(0.06, 0.2, jitter);
  }

  return {
    active,
    spm,
    amplitude,
    shares,
    wristLoose,
    whip,
    fingers,
    shoulder,
    smooth,
    raw: {
      "плечо, px": shoulderC,
      "локоть, px": elbowC,
      "вращение, px": rotC,
      "кисть, px": wristC,
      "кисть/рука": wristRatio,
      "хлыст (−корр.)": whipRaw,
      "сгиб пальцев, °": curlMean,
      "движение пальцев, °": curlStd,
      "подъём плеча": liftDrop,
      "рывки": jitter,
      "удар, мс": strokeMs,
    },
  };
}

export function relaxScore(m: Metrics): number | null {
  const parts: [number | null, number][] = [
    [m.wristLoose === null ? null : 0.6 * m.wristLoose + 0.4 * (m.whip ?? m.wristLoose), 0.4],
    [m.fingers, 0.25],
    [m.shoulder, 0.2],
    [m.smooth, 0.15],
  ];
  let sum = 0, w = 0;
  for (const [v, k] of parts) {
    if (v === null) continue;
    sum += v * k;
    w += k;
  }
  return w > 0 ? sum / w : null;
}

export function judge(m: Metrics, tracking: { arm: boolean; hand: boolean }): Verdict {
  if (!tracking.arm) {
    return {
      level: "lost",
      title: "Рука не в кадре",
      text: "Нужны плечо, локоть и кисть играющей руки. Отодвиньтесь или поверните камеру.",
      tips: [],
      relax: null,
    };
  }

  const relax = relaxScore(m);
  const tips: Tip[] = [];
  if (!tracking.hand)
    tips.push({ sev: "warn", text: "Кисть не распознана, поэтому пальцы и запястье не оцениваются. Добавьте света или поверните кисть к камере." });
  if (m.shoulder !== null && m.shoulder < 0.5)
    tips.push({ sev: "bad", text: "Плечо поднято. Опустите его и выдохните." });
  if (m.fingers !== null && m.fingers < 0.4)
    tips.push({ sev: "bad", text: "Пальцы зажаты. Держите медиатор или пальцы мягко, без кулака." });

  if (!m.active || !m.shares) {
    return {
      level: "idle",
      title: "Ждём бой",
      text: "Играйте вниз-вверх. Оценка движения начнётся после пары ударов.",
      tips,
      relax,
    };
  }

  const s = m.shares;
  if (s.shoulder > 0.45)
    tips.push({ sev: "bad", text: "Движение идёт от плеча, качается вся рука. Оставьте плечо на месте и двигайте предплечье от локтя." });
  else if (s.shoulder > 0.32)
    tips.push({ sev: "warn", text: "Плечо помогает слишком сильно. Локоть должен быть точкой опоры." });
  if (s.wrist > 0.55)
    tips.push({ sev: "bad", text: "Работает одна кисть. Подключите предплечье: основное движение идёт от локтя." });
  if (m.wristLoose !== null && m.wristLoose < 0.35)
    tips.push({ sev: "bad", text: "Запястье зажато: кисть движется заодно с предплечьем. Отпустите кисть." });
  else if (m.whip !== null && m.whip < 0.3 && (m.wristLoose ?? 1) < 0.7)
    tips.push({ sev: "warn", text: "Кисть не запаздывает за предплечьем. У расслабленной руки она догоняет движение, как хлыст." });
  if (m.smooth !== null && m.smooth < 0.4)
    tips.push({ sev: "warn", text: "Движение рывками. Ведите руку ровно, без остановок вверху и внизу." });

  tips.sort((a, b) => (a.sev === b.sev ? 0 : a.sev === "bad" ? -1 : 1));
  const level: Level = tips.some((t) => t.sev === "bad") ? "bad" : tips.some((t) => t.sev === "warn") ? "warn" : "good";
  const head = {
    good: ["Правильный бой", "Движение от локтя, кисть свободна."],
    warn: ["Почти правильно", tips[0]?.text ?? ""],
    bad: ["Неверное движение", tips[0]?.text ?? ""],
  }[level];
  return { level, title: head[0], text: head[1], tips: level === "good" ? [] : tips.slice(1), relax };
}
