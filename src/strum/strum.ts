import {
  FilesetResolver,
  HandLandmarker,
  PoseLandmarker,
  type HandLandmarkerResult,
  type NormalizedLandmark,
  type PoseLandmarkerResult,
} from "@mediapipe/tasks-vision";
import {
  Tracker,
  analyze,
  dist,
  judge,
  median,
  type Metrics,
  type RawFrame,
  type Vec,
  type Vec3,
  type Verdict,
} from "./analysis";
import { drawOverlay, drawTrace, readPalette, type Palette } from "./draw";

const WASM = `${import.meta.env.BASE_URL}wasm`;
const HAND_MODEL = `${import.meta.env.BASE_URL}models/hand_landmarker.task`;
const POSE_MODEL = `${import.meta.env.BASE_URL}models/pose_landmarker_full.task`;
const GPU_TIMEOUT_MS = 15000;

// Pose indices for the person's own arm (MediaPipe labels from the player's point of view).
const ARM = {
  right: { s: 12, e: 14, w: 16, ear: 8, o: 11 },
  left: { s: 11, e: 13, w: 15, ear: 7, o: 12 },
} as const;
type Arm = keyof typeof ARM;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const video = $<HTMLVideoElement>("video");
const overlay = $<HTMLCanvasElement>("overlay");
const octx = overlay.getContext("2d")!;
const trace = $<HTMLCanvasElement>("trace");

let hands: HandLandmarker | null = null;
let pose: PoseLandmarker | null = null;
let arm: Arm = "right";
let visible = true;
const tracker = new Tracker();

export function setStrumVisible(v: boolean) {
  visible = v;
  if (!v) resetAll();
}

let liftBaseline: number | null = null;
let calib: { until: number; lifts: number[] } | null = null;

let lastVideoTime = -1;
let lastT = 0;
let lastUi = 0;
let fpsT = 0;
let fpsN = 0;
let activeMs = 0;
let goodMs = 0;
let pal: Palette = readPalette();
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => (pal = readPalette()));

// Landmark smoothing: the same factor for pose and hand so neither lags the other.
const SMOOTH = 0.6;
const smoothed = new Map<string, Vec3>();
function sm(key: string, p: Vec3): Vec3 {
  const q = smoothed.get(key);
  const n = q
    ? { x: q.x + SMOOTH * (p.x - q.x), y: q.y + SMOOTH * (p.y - q.y), z: q.z + SMOOTH * (p.z - q.z) }
    : p;
  smoothed.set(key, n);
  return n;
}
const sm2 = (key: string, p: Vec): Vec => {
  const r = sm(key, { x: p.x, y: p.y, z: 0 });
  return { x: r.x, y: r.y };
};
function clearSmooth(prefix: string) {
  for (const k of smoothed.keys()) if (k.startsWith(prefix)) smoothed.delete(k);
}

const ema = new Map<string, number>();
function ease(key: string, v: number | null, a = 0.2): number | null {
  if (v === null) {
    ema.delete(key);
    return null;
  }
  const p = ema.get(key);
  const n = p === undefined ? v : p + a * (v - p);
  ema.set(key, n);
  return n;
}

function resetAll() {
  tracker.reset();
  smoothed.clear();
  ema.clear();
}

function buildFrame(pr: PoseLandmarkerResult, hr: HandLandmarkerResult, t: number): RawFrame | null {
  const lm = pr.landmarks[0];
  if (!lm) return null;
  const W = video.videoWidth, H = video.videoHeight;
  const k = ARM[arm];
  const seen = (i: number) => (lm[i].visibility ?? 1) > 0.5;
  if (!seen(k.s) || !seen(k.e) || !seen(k.w)) return null;
  const px = (p: NormalizedLandmark): Vec => ({ x: p.x * W, y: p.y * H });

  const shoulder = px(lm[k.s]);
  const elbow = px(lm[k.e]);
  let wrist = px(lm[k.w]);
  const foreLen = dist(wrist, elbow);

  let best = -1, bestD = Infinity;
  hr.landmarks.forEach((h, i) => {
    const d = dist(px(h[0]), wrist);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });

  let hand: Vec[] | null = null;
  let handWorld: Vec3[] | null = null;
  if (best >= 0 && bestD < foreLen * 0.6 + 0.03 * W) {
    hand = hr.landmarks[best].map((p, i) => sm2(`h${i}`, px(p)));
    handWorld = hr.worldLandmarks[best].map((p, i) => sm(`w${i}`, { x: p.x, y: p.y, z: p.z }));
    wrist = hand[0];
  } else {
    clearSmooth("h");
    clearSmooth("w");
    wrist = sm2("pw", wrist);
  }

  return {
    t,
    shoulder: sm2("ps", shoulder),
    elbow: sm2("pe", elbow),
    wrist,
    otherShoulder: seen(k.o) ? sm2("po", px(lm[k.o])) : null,
    ear: seen(k.ear) ? sm2("pear", px(lm[k.ear])) : null,
    hand,
    handWorld,
  };
}

function smoothMetrics(m: Metrics): Metrics {
  return {
    ...m,
    spm: ease("spm", m.spm, 0.1),
    amplitude: ease("amp", m.amplitude, 0.1),
    shares: m.shares
      ? {
          shoulder: ease("ss", m.shares.shoulder)!,
          elbow: ease("se", m.shares.elbow)!,
          wrist: ease("sw", m.shares.wrist)!,
        }
      : (ease("ss", null), ease("se", null), ease("sw", null), null),
    wristLoose: ease("wl", m.wristLoose),
    whip: ease("wh", m.whip),
    fingers: ease("fi", m.fingers),
    shoulder: ease("sh", m.shoulder),
    smooth: ease("smo", m.smooth),
  };
}

function scoreColor(v: number | null) {
  if (v === null) return pal.muted;
  return v >= 0.65 ? pal.good : v >= 0.4 ? pal.warn : pal.bad;
}

const LEVEL_LABEL: Record<Verdict["level"], string> = {
  lost: "Нет данных",
  idle: "Ожидание",
  good: "Хорошо",
  warn: "Внимание",
  bad: "Ошибка",
};

function setChip(id: string, on: boolean) {
  const el = $(id);
  el.classList.toggle("on", on);
  el.classList.toggle("off", !on);
}

function setMeter(key: string, v: number | null) {
  const bar = $(`m-${key}`);
  bar.style.width = v === null ? "0%" : `${Math.round(v * 100)}%`;
  bar.style.backgroundColor = scoreColor(v);
  $(`v-${key}`).textContent = v === null ? "—" : String(Math.round(v * 100));
}

function render(v: Verdict, m: Metrics, frame: RawFrame | null) {
  $("verdict").dataset.level = v.level;
  $("v-pill").textContent = LEVEL_LABEL[v.level];
  $("v-title").textContent = v.title;
  $("v-text").textContent = v.text;

  const s = m.shares;
  for (const k of ["shoulder", "elbow", "wrist"] as const) {
    $(`s-${k}`).style.width = s ? `${s[k] * 100}%` : "0%";
    $(`sl-${k}`).textContent = s ? `${Math.round(s[k] * 100)}%` : "—";
  }

  $("relax-total").textContent = v.relax === null ? "—" : String(Math.round(v.relax * 100));
  $("relax-total").style.color = scoreColor(v.relax);
  setMeter("wrist", m.wristLoose);
  setMeter("whip", m.whip);
  setMeter("fingers", m.fingers);
  setMeter("shoulder", m.shoulder);
  setMeter("smooth", m.smooth);

  $("spm").textContent = m.active && m.spm ? String(Math.round(m.spm)) : "—";
  $("amp").textContent = m.active && m.amplitude ? m.amplitude.toFixed(2) : "—";
  $("good").textContent = activeMs > 2000 ? `${Math.round((goodMs / activeMs) * 100)}%` : "—";

  const tips = $("tips");
  tips.replaceChildren(
    ...v.tips.map((t) => {
      const li = document.createElement("li");
      li.className = t.sev;
      li.textContent = t.text;
      return li;
    }),
  );

  setChip("t-shoulder", !!frame);
  setChip("t-elbow", !!frame);
  setChip("t-wrist", !!frame);
  setChip("t-hand", !!frame?.hand);

  $("raw").textContent = Object.entries(m.raw)
    .map(([k, val]) => `${k.padEnd(20)} ${val === null ? "—" : val.toFixed(3)}`)
    .join("\n");
}

function process(pr: PoseLandmarkerResult, hr: HandLandmarkerResult, t: number) {
  const frame = buildFrame(pr, hr, t);
  if (!frame) resetAll();
  else tracker.push(frame);

  if (calib) {
    const lift = tracker.samples.at(-1)?.shoulderLift;
    if (frame && lift != null) calib.lifts.push(lift);
    const left = Math.ceil((calib.until - t) / 1000);
    $("calib").textContent = left > 0 ? `Сидите спокойно… ${left}` : "Калибровка, 3 с";
    if (t >= calib.until) {
      if (calib.lifts.length >= 20) {
        liftBaseline = median(calib.lifts);
        $("calib-note").textContent = "Калибровка сохранена. Повторите, если сели иначе.";
      } else {
        $("calib-note").textContent = "Не удалось: в кадре должны быть оба плеча и ухо со стороны играющей руки.";
      }
      calib = null;
      ($("calib") as HTMLButtonElement).disabled = false;
    }
  }

  const metrics = smoothMetrics(analyze(tracker, t, liftBaseline));
  const verdict = judge(metrics, { arm: !!frame, hand: !!frame?.hand });

  const dt = Math.min(t - lastT, 100);
  lastT = t;
  if (metrics.active) {
    activeMs += dt;
    if (verdict.level === "good") goodMs += dt;
  }

  const sh = metrics.shares;
  const colors = {
    upper: sh ? (sh.shoulder > 0.45 ? pal.bad : sh.shoulder > 0.32 ? pal.warn : pal.good) : "rgba(255,255,255,0.7)",
    fore: pal.accent,
    hand: metrics.wristLoose !== null ? scoreColor(metrics.wristLoose) : "rgba(255,255,255,0.7)",
  };
  const trail = tracker.samples.filter((s) => s.t > t - 1200).map((s) => s.strike);
  drawOverlay(octx, frame, trail, colors, pal);

  if (t - lastUi > 100) {
    lastUi = t;
    render(verdict, metrics, frame);
    drawTrace(trace, tracker.samples, tracker.turns, t, pal);
  }
}

function loop() {
  if (visible && hands && pose && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    if (overlay.width !== video.videoWidth || overlay.height !== video.videoHeight) {
      overlay.width = video.videoWidth;
      overlay.height = video.videoHeight;
    }
    const t = performance.now();
    process(pose.detectForVideo(video, t), hands.detectForVideo(video, t), t);

    fpsN++;
    if (t - fpsT > 1000) {
      $("fps").textContent = `${Math.round((fpsN * 1000) / (t - fpsT))} к/с`;
      fpsT = t;
      fpsN = 0;
    }
  }
  requestAnimationFrame(loop);
}

async function createModels() {
  const fileset = await FilesetResolver.forVisionTasks(WASM);
  const make = (delegate: "GPU" | "CPU") =>
    Promise.all([
      HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: HAND_MODEL, delegate },
        runningMode: "VIDEO",
        numHands: 2,
        minHandDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5,
      }),
      PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: POSE_MODEL, delegate },
        runningMode: "VIDEO",
        numPoses: 1,
      }),
    ]);
  try {
    // Some browsers never settle GPU init instead of rejecting it.
    return await Promise.race([
      make("GPU"),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("GPU timeout")), GPU_TIMEOUT_MS)),
    ]);
  } catch (e) {
    console.warn("GPU delegate failed, falling back to CPU", e);
    return await make("CPU");
  }
}

async function start() {
  const btn = $<HTMLButtonElement>("start");
  const status = $("intro-status");
  btn.disabled = true;
  let cam = "жду разрешения…";
  let models = "загрузка…";
  const show = () => (status.textContent = `Камера: ${cam} Модели: ${models}`);
  show();
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new DOMException("no mediaDevices", "NotSupportedError");
    const [, loaded] = await Promise.all([
      navigator.mediaDevices
        .getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 }, facingMode: "user" },
          audio: false,
        })
        .then(async (s) => {
          video.srcObject = s;
          await video.play();
          $("intro").classList.add("over-video");
          cam = "готова.";
          show();
          return s;
        }),
      createModels().then((m) => {
        models = "готовы.";
        show();
        return m;
      }),
    ]);
    [hands, pose] = loaded;
    $("stage").style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
    $("intro").hidden = true;
    $<HTMLButtonElement>("calib").disabled = false;
    requestAnimationFrame(loop);
  } catch (e) {
    console.error(e);
    const err = e as DOMException;
    status.textContent =
      err.name === "NotAllowedError"
        ? "Доступ к камере запрещён. Разрешите камеру в настройках сайта и нажмите снова."
        : err.name === "NotFoundError"
          ? "Камера не найдена. Подключите камеру и нажмите снова."
          : err.name === "NotReadableError"
            ? "Камера занята другим приложением (Zoom, OBS, FaceTime). Закройте его и нажмите снова."
            : err.name === "NotSupportedError"
              ? "Браузер не даёт доступ к камере. Откройте страницу по адресу localhost в Chrome."
              : `Не удалось запустить: ${err.message}`;
    btn.disabled = false;
  }
}

$("start").addEventListener("click", start);
$<HTMLSelectElement>("arm").addEventListener("change", (e) => {
  arm = (e.target as HTMLSelectElement).value as Arm;
  liftBaseline = null;
  resetAll();
});
$<HTMLInputElement>("mirror").addEventListener("change", (e) => {
  $("stage").classList.toggle("mirrored", (e.target as HTMLInputElement).checked);
});
$("calib").addEventListener("click", () => {
  calib = { until: performance.now() + 3000, lifts: [] };
  $<HTMLButtonElement>("calib").disabled = true;
});
