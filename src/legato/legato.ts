import workletUrl from "./pitch-worklet.ts?worker&url";
import { readPalette, type Palette } from "../strum/draw";
import {
  ISSUE_LABEL,
  LIMITS,
  NoteTracker,
  noteName,
  summarize,
  type IssueKind,
  type Note,
  type PitchFrame,
  type Strictness,
} from "./notes";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

interface Settings {
  deviceId: string;
  gateDb: number;
  strict: Strictness;
  a4: number;
}
const SETTINGS_KEY = "legato-settings";
function loadSettings(): Settings {
  const def: Settings = { deviceId: "", gateDb: -50, strict: "normal", a4: 440 };
  try {
    return { ...def, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") };
  } catch {
    return def;
  }
}
function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* storage unavailable */
  }
}

const settings = loadSettings();
const tracker = new NoteTracker({ a4: settings.a4, gateDb: settings.gateDb, minClarity: 0.8 }, LIMITS[settings.strict]);
const frames: PitchFrame[] = [];
const TRACE_SPAN = 6;

let ctx: AudioContext | null = null;
let stream: MediaStream | null = null;
let source: MediaStreamAudioSourceNode | null = null;
let node: AudioWorkletNode | null = null;
let visible = false;
let running = false;
let listDirty = true;
let selected: Note | null = null;
let viewMidi = 52;
let pal: Palette = readPalette();
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => (pal = readPalette()));

let recorder: MediaRecorder | null = null;
let take: { start: number; url: string } | null = null;
let stopAt: number | null = null;

const audio = $<HTMLAudioElement>("lg-audio");

export function setLegatoVisible(v: boolean) {
  visible = v;
  if (v) {
    pal = readPalette();
    listDirty = true;
    requestAnimationFrame(loop);
  }
}

function onFrame(fr: PitchFrame) {
  frames.push(fr);
  while (frames.length && frames[0].t < fr.t - TRACE_SPAN - 1) frames.shift();
  const ended = tracker.push(fr);
  if (ended) {
    selected = ended;
    listDirty = true;
  }
}

async function openInput() {
  const status = $("lg-status");
  status.textContent = "Жду разрешения на микрофон…";
  stream?.getTracks().forEach((t) => t.stop());
  source?.disconnect();
  node?.disconnect();
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: settings.deviceId ? { ideal: settings.deviceId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    if (!ctx) {
      ctx = new AudioContext({ latencyHint: "interactive" });
      await ctx.audioWorklet.addModule(workletUrl);
    }
    await ctx.resume();
    source = ctx.createMediaStreamSource(stream);
    node = new AudioWorkletNode(ctx, "yin-pitch", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: "explicit",
      channelInterpretation: "speakers",
    });
    node.port.onmessage = (e: MessageEvent<PitchFrame>) => onFrame(e.data);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    source.connect(node).connect(mute).connect(ctx.destination);
    running = true;

    const track = stream.getAudioTracks()[0];
    status.textContent = `Вход: ${track.label || "микрофон"}, ${ctx.sampleRate / 1000} кГц`;
    $<HTMLButtonElement>("lg-start").textContent = "Вход включён";
    $<HTMLButtonElement>("lg-start").disabled = true;
    $<HTMLButtonElement>("lg-rec").disabled = false;
    await fillDevices(track.getSettings().deviceId ?? "");
  } catch (e) {
    console.error(e);
    const err = e as DOMException;
    status.textContent =
      err.name === "NotAllowedError"
        ? "Доступ к микрофону запрещён. Разрешите его в настройках сайта и нажмите снова."
        : err.name === "NotFoundError"
          ? "Аудиовход не найден. Подключите звуковую карту или микрофон."
          : `Не удалось включить вход: ${err.message}`;
  }
}

async function fillDevices(currentId: string) {
  const sel = $<HTMLSelectElement>("lg-device");
  const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput");
  sel.replaceChildren(
    ...devs.map((d, i) => {
      const o = document.createElement("option");
      o.value = d.deviceId;
      o.textContent = d.label || `Вход ${i + 1}`;
      o.selected = d.deviceId === currentId;
      return o;
    }),
  );
  sel.disabled = false;
}

function toggleRecord() {
  const btn = $<HTMLButtonElement>("lg-rec");
  if (recorder) {
    recorder.stop();
    recorder = null;
    btn.textContent = "Записать дубль";
    btn.classList.remove("rec-on");
    return;
  }
  if (!stream || !ctx) return;
  const r = new MediaRecorder(stream);
  const chunks: Blob[] = [];
  const start = ctx.currentTime;
  r.ondataavailable = (e) => chunks.push(e.data);
  r.onstop = () => {
    if (take) URL.revokeObjectURL(take.url);
    take = { start, url: URL.createObjectURL(new Blob(chunks, { type: r.mimeType })) };
    audio.src = take.url;
    audio.hidden = false;
    listDirty = true;
  };
  tracker.clear();
  selected = null;
  listDirty = true;
  r.start();
  recorder = r;
  btn.textContent = "Остановить";
  btn.classList.add("rec-on");
}

function playNote(n: Note) {
  if (!take || n.start < take.start) return;
  audio.currentTime = Math.max(0, n.start - take.start - 0.15);
  stopAt = n.end - take.start + 0.2;
  void audio.play();
}

function resizeCanvas(c: HTMLCanvasElement) {
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, h = c.clientHeight;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
  }
  const g = c.getContext("2d")!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  return { g, w, h };
}

const noteColor = (n: Note) => (n.eval ? (n.eval.clean ? pal.good : pal.bad) : pal.muted);

function drawTrace(now: number) {
  const { g, w, h } = resizeCanvas($<HTMLCanvasElement>("lg-trace"));
  const target = tracker.current?.midi ?? tracker.notes.at(-1)?.midi ?? viewMidi;
  viewMidi += (target - viewMidi) * 0.08;
  const span = 14;
  const lo = viewMidi - span / 2;
  const left = 38;
  const X = (t: number) => left + (1 - (now - t) / TRACE_SPAN) * (w - left);
  const Y = (m: number) => h - ((m - lo) / span) * h;

  g.font = "11px 'IBM Plex Mono', monospace";
  g.textBaseline = "middle";
  for (let m = Math.ceil(lo); m <= lo + span; m++) {
    const natural = ![1, 3, 6, 8, 10].includes(((m % 12) + 12) % 12);
    g.strokeStyle = pal.line;
    g.globalAlpha = natural ? 1 : 0.45;
    g.beginPath();
    g.moveTo(left, Y(m));
    g.lineTo(w, Y(m));
    g.stroke();
    g.globalAlpha = 1;
    if (natural) {
      g.fillStyle = pal.muted;
      g.fillText(noteName(m), 2, Y(m));
    }
  }

  g.fillStyle = pal.muted;
  for (const f of frames) {
    if (f.f0 === null || f.db < tracker.opts.gateDb || f.clarity < 0.8) continue;
    const m = tracker.midiOf(f.f0);
    g.globalAlpha = 0.35;
    g.fillRect(X(f.t) - 1, Y(m) - 1, 2, 2);
  }
  g.globalAlpha = 1;

  const visibleNotes = tracker.notes.filter((n) => n.end > now - TRACE_SPAN);
  if (tracker.current) visibleNotes.push(tracker.current);
  g.lineWidth = 2.5;
  g.lineJoin = "round";
  for (const n of visibleNotes) {
    g.strokeStyle = n === tracker.current ? pal.accent : noteColor(n);
    g.beginPath();
    n.points.forEach((p, i) => {
      const x = X(p.t), y = Y(n.midi + p.cents / 100);
      if (i) g.lineTo(x, y);
      else g.moveTo(x, y);
    });
    g.stroke();
    if (n === selected) {
      g.strokeStyle = pal.ink;
      g.lineWidth = 1;
      g.strokeRect(X(n.start) - 3, Y(n.midi) - 8, X(n.end) - X(n.start) + 6, 16);
      g.lineWidth = 2.5;
    }
  }
}

function drawDetail() {
  const { g, w, h } = resizeCanvas($<HTMLCanvasElement>("lg-detail"));
  const n = selected;
  const range = 50;
  const Y = (c: number) => h / 2 - (c / range) * (h / 2 - 8);
  g.font = "11px 'IBM Plex Mono', monospace";
  g.textBaseline = "middle";
  for (const c of [-50, -25, 0, 25, 50]) {
    g.strokeStyle = pal.line;
    g.beginPath();
    g.moveTo(34, Y(c));
    g.lineTo(w, Y(c));
    g.stroke();
    g.fillStyle = pal.muted;
    g.fillText(`${c > 0 ? "+" : ""}${c}`, 0, Y(c));
  }
  if (!n || !n.eval) return;
  const ev = n.eval;
  const L = tracker.limits;
  const X = (t: number) => 34 + ((t - n.start) / Math.max(0.05, n.end - n.start)) * (w - 40);

  g.fillStyle = pal.good;
  g.globalAlpha = 0.12;
  g.fillRect(X(ev.from), Y(ev.center + L.spread / 2), w - X(ev.from), Y(ev.center - L.spread / 2) - Y(ev.center + L.spread / 2));
  g.globalAlpha = 0.08;
  g.fillStyle = pal.muted;
  g.fillRect(34, 0, X(ev.from) - 34, h);
  g.globalAlpha = 1;

  g.strokeStyle = noteColor(n);
  g.lineWidth = 2;
  g.beginPath();
  n.points.forEach((p, i) => {
    const y = Y(Math.max(-range, Math.min(range, p.cents)));
    if (i) g.lineTo(X(p.t), y);
    else g.moveTo(X(p.t), y);
  });
  g.stroke();
}

function renderDetailText() {
  const n = selected;
  const box = $("lg-detail-text");
  if (!n || !n.eval) {
    box.innerHTML = "";
    $("lg-detail-title").textContent = "Сыграйте ноту";
    return;
  }
  const ev = n.eval;
  $("lg-detail-title").textContent =
    `${noteName(n.midi)} · ${Math.round((n.end - n.start) * 1000)} мс · ${n.attack === "pick" ? "медиатор" : "легато"}`;
  const nums = document.createElement("p");
  nums.className = "mono lg-nums";
  const s = (v: number) => `${v > 0 ? "+" : ""}${Math.round(v)}`;
  nums.textContent = `центр ${s(ev.center)} ц · вилянье ±${Math.round(ev.spread / 2)} ц · начало ${s(ev.overshoot)} ц · уплыв ${s(ev.drift)} ц`;
  const list = document.createElement("ul");
  list.className = "lg-issues";
  if (ev.clean) {
    const li = document.createElement("li");
    li.className = "ok";
    li.textContent = "Чистая нота: высота ровная от удара до конца.";
    list.append(li);
  }
  for (const i of ev.issues) {
    const li = document.createElement("li");
    li.textContent = i.text;
    list.append(li);
  }
  box.replaceChildren(nums, list);
  $<HTMLButtonElement>("lg-play").hidden = !take || n.start < take.start;
}

function renderList() {
  const list = $("lg-list");
  const notes = tracker.notes.slice(-60).reverse();
  list.replaceChildren(
    ...notes.map((n) => {
      const b = document.createElement("button");
      b.className = `lg-note ${n.eval?.clean ? "clean" : "dirty"}${n === selected ? " sel" : ""}`;
      const name = document.createElement("b");
      name.textContent = noteName(n.midi);
      const meta = document.createElement("span");
      meta.textContent = n.eval?.clean ? "чисто" : (n.eval?.issues.map((i) => ISSUE_LABEL[i.kind]).join(", ") ?? "");
      const kind = document.createElement("small");
      kind.textContent = n.attack === "pick" ? "медиатор" : "легато";
      b.append(name, kind, meta);
      b.addEventListener("click", () => {
        selected = n;
        listDirty = true;
        playNote(n);
      });
      return b;
    }),
  );
  $("lg-empty").hidden = notes.length > 0;

  const sum = summarize(tracker.notes);
  $("lg-count").textContent = String(sum.count);
  $("lg-clean").textContent = sum.count ? `${Math.round((sum.clean / sum.count) * 100)}%` : "—";
  $("lg-clean").style.color = sum.count ? (sum.clean / sum.count >= 0.8 ? pal.good : sum.clean / sum.count >= 0.5 ? pal.warn : pal.bad) : "";
  const top = (Object.entries(sum.issues) as [IssueKind, number][]).sort((a, b) => b[1] - a[1]);
  $("lg-top").textContent = top.length ? `${ISSUE_LABEL[top[0][0]]} ×${top[0][1]}` : "—";

  const tips = $("lg-tips");
  const items: string[] = [];
  if (sum.legatoGapDb !== null && sum.legatoGapDb < -8)
    items.push(
      `Ноты легато тише нот с медиатором на ${Math.round(-sum.legatoGapDb)} дБ. Бейте пальцем быстрее и точнее в лад, а не сильнее давите.`,
    );
  if ((sum.issues.wobble ?? 0) >= Math.max(2, sum.count * 0.3))
    items.push("Вилянье встречается часто. Играйте медленнее и следите, чтобы палец после удара просто держал лад, без раскачки.");
  if ((sum.issues.overshoot ?? 0) >= Math.max(2, sum.count * 0.3))
    items.push("Частый пережим при ударе. Ставьте палец ближе к ладовой пластине: тогда нужно меньше силы.");
  tips.replaceChildren(
    ...items.map((t) => {
      const li = document.createElement("li");
      li.textContent = t;
      return li;
    }),
  );

  renderDetailText();
}

function renderTuner(now: number) {
  const last = frames.at(-1);
  $("lg-level").style.width = last ? `${Math.max(0, Math.min(100, ((last.db + 80) / 70) * 100))}%` : "0%";
  const cur = tracker.current;
  const fresh = cur && now - cur.end < 0.12;
  const nameEl = $("lg-note");
  const centsEl = $("lg-cents");
  const needle = $("lg-needle");
  const wob = $("lg-wobble");
  if (!fresh || !cur) {
    nameEl.textContent = "—";
    centsEl.textContent = "";
    needle.style.left = "50%";
    needle.style.opacity = "0.3";
    wob.textContent = "";
    return;
  }
  const recent = cur.points.slice(-6).map((p) => p.cents).sort((a, b) => a - b);
  const c = recent[recent.length >> 1];
  nameEl.textContent = noteName(cur.midi);
  centsEl.textContent = `${c > 0 ? "+" : ""}${Math.round(c)} ц`;
  needle.style.left = `${50 + Math.max(-50, Math.min(50, c))}%`;
  needle.style.opacity = "1";
  const L = tracker.limits;
  needle.style.backgroundColor = Math.abs(c) <= L.center ? pal.good : pal.warn;

  const tail = cur.points.filter((p) => p.t > cur.start + 0.06).slice(-15).map((p) => p.cents);
  if (tail.length >= 6) {
    const m = tail.reduce((s, v) => s + v, 0) / tail.length;
    const sd = Math.sqrt(tail.reduce((s, v) => s + (v - m) ** 2, 0) / tail.length);
    wob.textContent = `вилянье ±${Math.round(sd * 2)} ц`;
    wob.style.color = sd <= L.wobble ? pal.good : pal.bad;
  } else wob.textContent = "";
}

function loop() {
  if (!visible) return;
  const now = ctx && running ? ctx.currentTime : 0;
  if (stopAt !== null && audio.currentTime >= stopAt) {
    audio.pause();
    stopAt = null;
  }
  drawTrace(now);
  renderTuner(now);
  if (listDirty) {
    listDirty = false;
    renderList();
  }
  drawDetail();
  requestAnimationFrame(loop);
}

function applySettings() {
  tracker.opts.gateDb = settings.gateDb;
  tracker.opts.a4 = settings.a4;
  tracker.limits = LIMITS[settings.strict];
  tracker.reevaluate();
  $("lg-gate-v").textContent = `${settings.gateDb} дБ`;
  listDirty = true;
  saveSettings();
}

$<HTMLInputElement>("lg-gate").value = String(settings.gateDb);
$<HTMLSelectElement>("lg-strict").value = settings.strict;
$<HTMLInputElement>("lg-a4").value = String(settings.a4);
$("lg-gate-v").textContent = `${settings.gateDb} дБ`;

$("lg-start").addEventListener("click", openInput);
$("lg-rec").addEventListener("click", toggleRecord);
$("lg-clear").addEventListener("click", () => {
  tracker.clear();
  selected = null;
  listDirty = true;
});
$("lg-play").addEventListener("click", () => selected && playNote(selected));
$<HTMLSelectElement>("lg-device").addEventListener("change", (e) => {
  settings.deviceId = (e.target as HTMLSelectElement).value;
  saveSettings();
  if (recorder) toggleRecord();
  void openInput();
});
$<HTMLInputElement>("lg-gate").addEventListener("input", (e) => {
  settings.gateDb = Number((e.target as HTMLInputElement).value);
  applySettings();
});
$<HTMLSelectElement>("lg-strict").addEventListener("change", (e) => {
  settings.strict = (e.target as HTMLSelectElement).value as Strictness;
  applySettings();
});
$<HTMLInputElement>("lg-a4").addEventListener("change", (e) => {
  const v = Number((e.target as HTMLInputElement).value);
  if (v >= 415 && v <= 466) settings.a4 = v;
  (e.target as HTMLInputElement).value = String(settings.a4);
  applySettings();
});
