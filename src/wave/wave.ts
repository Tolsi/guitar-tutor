import workletUrl from "./capture-worklet.ts?worker&url";
import { SampleStore } from "./store";
import { AMPS, MONITOR_DEFAULTS, Monitor, type DistType, type MonitorSettings } from "./monitor";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const MAX_SECONDS = 300;
const SETTINGS_KEY = "wave-settings";

interface Settings {
  deviceId: string;
  outId: string;
  mon: MonitorSettings;
}
function loadSettings(): Settings {
  const def = (): Settings => ({ deviceId: "", outId: "", mon: { ...MONITOR_DEFAULTS } });
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}");
    const d = def();
    return { ...d, ...saved, mon: { ...d.mon, ...(saved.mon ?? {}) } };
  } catch {
    return def();
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
// A custom .nam file is not kept between visits.
if (settings.mon.amp === "file") settings.mon.amp = MONITOR_DEFAULTS.amp;

let ctx: AudioContext | null = null;
let stream: MediaStream | null = null;
let source: MediaStreamAudioSourceNode | null = null;
let node: AudioWorkletNode | null = null;
let store: SampleStore | null = null;
let sr = 48000;

let visible = false;
let recording = false;
/** Keep the right edge of the view on the newest sample. */
let follow = true;
let viewStart = 0;
let viewSpan = 3;
let gain = 1;
let levelDb = -Infinity;
let hoverX: number | null = null;
let play: { src: AudioBufferSourceNode; from: number; at: number } | null = null;
/** Where Space starts playback (set by a click on the wave). */
let marker: number | null = null;
/** Where playback was paused; Space resumes from here until a new marker is set. */
let pausedAt: number | null = null;

const wave = $<HTMLCanvasElement>("wv-canvas");
const over = $<HTMLCanvasElement>("wv-over");

interface Colors {
  stage: string;
  wave: string;
  clip: string;
  grid: string;
  axis: string;
  text: string;
  play: string;
}
function readColors(): Colors {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string) => cs.getPropertyValue(n).trim();
  return {
    stage: v("--stage"),
    wave: v("--scope-wave"),
    clip: v("--scope-clip"),
    grid: v("--scope-grid"),
    axis: v("--scope-axis"),
    text: v("--scope-text"),
    play: v("--scope-play"),
  };
}
let col = readColors();
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => (col = readColors()));

export function setWaveVisible(v: boolean) {
  visible = v;
  if (v) {
    col = readColors();
    requestAnimationFrame(loop);
  }
}

const total = () => (store ? store.length / sr : 0);

function clampView() {
  const t = total();
  // While live (or empty) allow a window wider than the recording so it can fill up.
  const maxSpan = Math.max(t, recording || t === 0 ? 10 : 0.01);
  viewSpan = Math.min(Math.max(viewSpan, 16 / sr), maxSpan);
  if (follow) viewStart = Math.max(0, t - viewSpan);
  else viewStart = Math.min(Math.max(viewStart, 0), Math.max(0, t - viewSpan));
}

function onBlock(d: Float32Array) {
  let pk = 0;
  for (let i = 0; i < d.length; i++) pk = Math.max(pk, Math.abs(d[i]));
  const db = pk > 0 ? 20 * Math.log10(pk) : -Infinity;
  levelDb = db > levelDb ? db : levelDb - 0.6;
  if (!recording || !store) return;
  store.push(d);
  if (store.full) {
    setRecording(false);
    $("wv-status").textContent = `Достигнут предел записи ${MAX_SECONDS / 60} мин. Нажмите «Очистить», чтобы начать заново.`;
  }
}

async function openInput() {
  const status = $("wv-status");
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
      // NAM models are trained at 48 kHz.
      try {
        ctx = new AudioContext({ latencyHint: "interactive", sampleRate: 48000 });
      } catch {
        ctx = new AudioContext({ latencyHint: "interactive" });
      }
      await ctx.audioWorklet.addModule(workletUrl);
      sr = ctx.sampleRate;
      store = new SampleStore(MAX_SECONDS * sr);
    }
    await ctx.resume();
    source = ctx.createMediaStreamSource(stream);
    node = new AudioWorkletNode(ctx, "wave-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: "explicit",
      channelInterpretation: "speakers",
    });
    node.port.onmessage = (e: MessageEvent<Float32Array>) => onBlock(e.data);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    source.connect(node).connect(mute).connect(ctx.destination);
    if (monitor) source.connect(monitor.input);

    const track = stream.getAudioTracks()[0];
    status.textContent = `Вход: ${track.label || "микрофон"}, ${sr / 1000} кГц`;
    const start = $<HTMLButtonElement>("wv-start");
    start.textContent = "Вход включён";
    start.disabled = true;
    $<HTMLButtonElement>("wv-rec").disabled = false;
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
  const sel = $<HTMLSelectElement>("wv-device");
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
  await fillOutputs();
}

type SinkContext = AudioContext & { setSinkId?: (id: string) => Promise<void> };

async function fillOutputs() {
  const sel = $<HTMLSelectElement>("mo-out");
  if (!(ctx as SinkContext | null)?.setSinkId) {
    sel.title = "Этот браузер не умеет выбирать выход: используется системный.";
    return;
  }
  const outs = (await navigator.mediaDevices.enumerateDevices()).filter(
    (d) => d.kind === "audiooutput" && d.deviceId !== "default",
  );
  const def = document.createElement("option");
  def.value = "";
  def.textContent = "Системный по умолчанию";
  sel.replaceChildren(
    def,
    ...outs.map((d, i) => {
      const o = document.createElement("option");
      o.value = d.deviceId;
      o.textContent = d.label || `Выход ${i + 1}`;
      return o;
    }),
  );
  if (!outs.some((d) => d.deviceId === settings.outId)) settings.outId = "";
  sel.value = settings.outId;
  sel.disabled = false;
  await applySink();
}

async function applySink() {
  const c = ctx as SinkContext | null;
  if (!c?.setSinkId) return;
  try {
    await c.setSinkId(settings.outId);
  } catch (e) {
    console.error(e);
    moStatus(`Не удалось переключить выход: ${(e as Error).message}`);
  }
}

const ICON = {
  play: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v11l9-5.5z"/></svg>',
  pause: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 2.5h3v11h-3zM9.5 2.5h3v11h-3z"/></svg>',
};

function setRecording(on: boolean) {
  if (on && (!store || !ctx || store.full)) return;
  if (on) stopPlay();
  recording = on;
  $("wv-rec").classList.toggle("on", on);
  $("wv-rec").setAttribute("aria-pressed", String(on));
  if (on) follow = true;
  clampView();
}

function stopAll() {
  if (recording) setRecording(false);
  if (play) stopPlay();
  // Stop returns the playhead to the marker.
  pausedAt = null;
}

function toStart() {
  const wasPlaying = !!play;
  stopAll();
  marker = 0;
  follow = false;
  viewStart = 0;
  clampView();
  if (wasPlaying) togglePlay();
}

function toEnd() {
  stopAll();
  marker = total();
  follow = true;
  clampView();
}

/** Space: stops a recording, otherwise play / pause. */
function spaceAction() {
  if (recording) setRecording(false);
  else togglePlay();
}

const playPos = () => (play && ctx ? play.from + (ctx.currentTime - play.at) : null);

function stopPlay(pause = false) {
  if (!play) return;
  pausedAt = pause ? playPos() : null;
  play.src.onended = null;
  play.src.stop();
  play = null;
  $("wv-play").innerHTML = ICON.play;
  $("wv-play").classList.remove("on");
}

function setMarker(t: number) {
  marker = Math.min(Math.max(t, 0), total());
  pausedAt = null;
  if (play) {
    stopPlay();
    togglePlay();
  }
}

function togglePlay() {
  if (play) return stopPlay(true);
  if (!ctx || !store || !store.length) return;
  if (recording) setRecording(false);
  let from = pausedAt ?? marker ?? viewStart;
  if (from >= total() - 0.01) from = marker ?? 0;
  pausedAt = null;
  const data = store.slice(from * sr, store.length);
  if (!data.length) return;
  const buf = ctx.createBuffer(1, data.length, sr);
  buf.copyToChannel(data, 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  // With monitoring on, the take plays back through the amp too.
  src.connect(monitor?.enabled ? monitor.input : ctx.destination);
  src.onended = () => stopPlay();
  void ctx.resume();
  src.start();
  play = { src, from, at: ctx.currentTime };
  $("wv-play").innerHTML = ICON.pause;
  $("wv-play").classList.add("on");
}

function clearAll() {
  stopPlay();
  store?.clear();
  follow = true;
  viewSpan = 3;
  hoverX = null;
  marker = pausedAt = null;
  clampView();
}

// ---------- drawing ----------

function fit(c: HTMLCanvasElement) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(c.clientWidth * dpr), h = Math.round(c.clientHeight * dpr);
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  const g = c.getContext("2d")!;
  g.setTransform(1, 0, 0, 1, 0, 0);
  return { g, W: w, H: h, dpr };
}

function niceStep(x: number) {
  const p = 10 ** Math.floor(Math.log10(x));
  for (const m of [1, 2, 5, 10]) if (m * p >= x) return m * p;
  return 10 * p;
}

function fmtTime(t: number, step: number) {
  if (step < 0.001) {
    const d = Math.max(0, Math.ceil(-Math.log10(step * 1000) - 1e-9));
    return `${(t * 1000).toFixed(d)} мс`;
  }
  const d = Math.max(0, Math.ceil(-Math.log10(step) - 1e-9));
  const m = Math.floor(t / 60);
  const s = (t - m * 60).toFixed(d).padStart(d ? d + 3 : 2, "0");
  return `${m}:${s}`;
}

function fmtSpan(s: number) {
  if (s < 0.001) return `${(s * 1e6).toFixed(0)} мкс`;
  if (s < 1) return `${(s * 1000).toFixed(s < 0.01 ? 2 : s < 0.1 ? 1 : 0)} мс`;
  return `${s.toFixed(s < 10 ? 2 : 1)} с`;
}

const fmtDb = (v: number) => (v > 1e-6 ? `${(20 * Math.log10(v)).toFixed(1)} дБ` : "−∞ дБ");

function drawWave() {
  const { g, W, H, dpr } = fit(wave);
  g.fillStyle = col.stage;
  g.fillRect(0, 0, W, H);
  const top = 22 * dpr;
  const mid = top + (H - top) / 2;
  const amp = ((H - top) / 2 - 4 * dpr) * gain;
  const yOf = (v: number) => Math.min(H, Math.max(top, mid - v * amp));

  // amplitude grid
  g.fillStyle = col.grid;
  for (const a of [-1, -0.5, 0.5, 1]) {
    const y = mid - a * amp;
    if (y > top && y < H) g.fillRect(0, Math.round(y), W, dpr);
  }
  g.fillStyle = col.axis;
  g.fillRect(0, Math.round(mid), W, dpr);

  // time grid
  const step = niceStep((viewSpan * 110 * dpr) / W);
  g.font = `${11 * dpr}px "IBM Plex Mono", ui-monospace, monospace`;
  g.textBaseline = "middle";
  for (let t = Math.ceil(viewStart / step) * step; t <= viewStart + viewSpan; t += step) {
    const x = Math.round(((t - viewStart) / viewSpan) * W);
    g.fillStyle = col.grid;
    g.fillRect(x, top, dpr, H - top);
    g.fillStyle = col.text;
    g.fillText(fmtTime(t, step), x + 4 * dpr, top / 2);
  }

  const n = store?.length ?? 0;
  if (store && n) {
    const spp = (viewSpan * sr) / W;
    const s0 = viewStart * sr;
    if (spp >= 2) {
      for (let px = 0; px < W; px++) {
        const a = Math.floor(s0 + px * spp);
        if (a >= n) break;
        // +1 overlaps the next column so steep edges stay connected.
        const b = Math.max(a + 1, Math.floor(s0 + (px + 1) * spp)) + 1;
        if (b <= 0) continue;
        const [mn, mx] = store.range(a, b);
        if (mn > mx) continue;
        g.fillStyle = mx >= 0.995 || mn <= -0.995 ? col.clip : col.wave;
        const y1 = yOf(mx), y2 = yOf(mn);
        g.fillRect(px, y1, 1, Math.max(dpr, y2 - y1));
      }
    } else {
      const i0 = Math.max(0, Math.floor(s0) - 1);
      const i1 = Math.min(n - 1, Math.ceil(s0 + W * spp) + 1);
      g.strokeStyle = col.wave;
      g.lineWidth = 1.5 * dpr;
      g.beginPath();
      for (let i = i0; i <= i1; i++) {
        const x = (i - s0) / spp, y = yOf(store.at(i));
        if (i === i0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.stroke();
      if (1 / spp > 7 * dpr) {
        g.fillStyle = col.wave;
        for (let i = i0; i <= i1; i++) {
          g.beginPath();
          g.arc((i - s0) / spp, yOf(store.at(i)), 2.5 * dpr, 0, Math.PI * 2);
          g.fill();
        }
      }
    }
  } else {
    g.fillStyle = col.text;
    g.textAlign = "center";
    g.fillText(ctx ? "Нажмите ● или клавишу R, чтобы записать." : "Включите аудиовход, чтобы увидеть волну.", W / 2, mid - 20 * dpr);
    g.textAlign = "start";
  }

  const xOf = (t: number) => ((t - viewStart) / viewSpan) * W;
  if (marker !== null) {
    const x = Math.round(xOf(marker));
    if (x >= 0 && x <= W) {
      g.fillStyle = col.axis;
      g.fillRect(x, top, dpr, H - top);
    }
  }
  const pos = playPos() ?? pausedAt;
  if (pos !== null) {
    const x = xOf(pos);
    if (x >= 0 && x <= W) {
      g.fillStyle = col.play;
      g.globalAlpha = play ? 1 : 0.55;
      g.fillRect(Math.round(x), top, 2 * dpr, H - top);
      g.globalAlpha = 1;
    }
  }
}

function drawOverview() {
  const { g, W, H, dpr } = fit(over);
  g.fillStyle = col.stage;
  g.fillRect(0, 0, W, H);
  const n = store?.length ?? 0;
  if (!store || !n) return;
  const mid = H / 2, amp = H / 2 - 3 * dpr;
  const spp = n / W;
  g.fillStyle = col.wave;
  for (let px = 0; px < W; px++) {
    const a = Math.floor(px * spp);
    const b = Math.max(a + 1, Math.floor((px + 1) * spp));
    if (a >= n) break;
    const [mn, mx] = store.range(a, b);
    if (mn > mx) continue;
    g.fillRect(px, mid - mx * amp, 1, Math.max(dpr, (mx - mn) * amp));
  }
  const t = total();
  const x0 = (viewStart / t) * W;
  const w = Math.max(2 * dpr, (viewSpan / t) * W);
  g.fillStyle = col.grid;
  g.fillRect(0, 0, x0, H);
  g.fillRect(x0 + w, 0, W - x0 - w, H);
  g.strokeStyle = col.play;
  g.lineWidth = 1.5 * dpr;
  g.strokeRect(x0 + dpr, dpr, w - 2 * dpr, H - 2 * dpr);
}

function renderStats() {
  const n = store?.length ?? 0;
  $("wv-dur").textContent = `${(n / sr).toFixed(1)} с`;
  $("wv-rate").textContent = ctx ? `${(sr / 1000).toFixed(1)}` : "—";
  $("wv-span").textContent = fmtSpan(viewSpan);
  const spp = (viewSpan * sr) / Math.max(1, wave.clientWidth);
  $("wv-spp").textContent = spp >= 1 ? `${spp.toFixed(spp < 10 ? 1 : 0)} сэмпл./пиксель` : `${(1 / spp).toFixed(1)} пикс./сэмпл`;
  if (store && n) {
    const [mn, mx] = store.range(Math.floor(viewStart * sr), Math.ceil((viewStart + viewSpan) * sr));
    $("wv-peak").textContent = mn <= mx ? fmtDb(Math.max(-mn, mx)) : "—";
  } else $("wv-peak").textContent = "—";
  $("wv-gain").textContent = `×${gain < 10 ? gain.toFixed(1) : gain.toFixed(0)}`;
  const lv = Math.max(0, Math.min(1, (levelDb + 60) / 60));
  const lvl = $("wv-level");
  lvl.style.width = `${lv * 100}%`;
  lvl.classList.toggle("hot", levelDb > -1);

  const cur = $("wv-cursor");
  if (hoverX !== null && store && n) {
    const t = viewStart + (hoverX / wave.clientWidth) * viewSpan;
    const i = Math.round(t * sr);
    if (i >= 0 && i < n) {
      const v = store.at(i);
      const m = Math.floor(t / 60);
      cur.textContent = `${m}:${(t - m * 60).toFixed(4).padStart(7, "0")} · сэмпл ${i} · ${v >= 0 ? "+" : ""}${v.toFixed(4)} (${fmtDb(Math.abs(v))})`;
      return;
    }
  }
  const at = playPos() ?? pausedAt ?? marker;
  if (at !== null) {
    const m = Math.floor(at / 60);
    const what = play ? "Играет" : pausedAt !== null ? "Пауза на" : "Маркер";
    cur.textContent = `${what} ${m}:${(at - m * 60).toFixed(3).padStart(6, "0")}`;
  } else cur.textContent = recording ? "Идёт запись · пробел — стоп" : "Клик по волне ставит маркер";
}

function renderTime() {
  const t = recording ? total() : (playPos() ?? pausedAt ?? marker ?? 0);
  const m = Math.floor(t / 60);
  $("wv-time").textContent = `${m}:${(t - m * 60).toFixed(3).padStart(6, "0")}`;
  $("wv-time").classList.toggle("rec", recording);
}

function loop() {
  if (!visible) return;
  renderTime();
  const pos = playPos();
  if (pos !== null && !drag && (pos > viewStart + viewSpan || pos < viewStart)) {
    follow = false;
    viewStart = pos - viewSpan * 0.05;
  }
  clampView();
  drawWave();
  drawOverview();
  renderStats();
  const live = $("wv-live");
  live.hidden = follow || !store?.length;
  live.textContent = recording ? "К реальному времени →" : "К концу записи →";
  requestAnimationFrame(loop);
}

// ---------- interaction ----------

wave.addEventListener(
  "wheel",
  (e) => {
    const rect = wave.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? rect.height : 1;
    const dx = e.deltaX * k, dy = e.deltaY * k;
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      const anchor = viewStart + x * viewSpan;
      const factor = Math.exp(Math.max(-1, Math.min(1, (dy || dx) * 0.003)));
      if (follow && factor < 1 && x < 0.85) follow = false;
      viewSpan *= factor;
      clampView();
      if (!follow) {
        viewStart = anchor - x * viewSpan;
        clampView();
      }
    } else if (e.altKey) {
      e.preventDefault();
      gain = Math.min(64, Math.max(1, gain * Math.exp(-(dy || dx) * 0.003)));
    } else if (e.shiftKey || Math.abs(dx) > Math.abs(dy)) {
      e.preventDefault();
      const d = Math.abs(dx) > Math.abs(dy) ? dx : dy;
      panBy((d / rect.width) * viewSpan);
    }
  },
  { passive: false },
);

function panBy(dt: number) {
  follow = false;
  viewStart += dt;
  clampView();
  if (recording && viewStart + viewSpan >= total() - 1e-4 && dt > 0) follow = true;
}

let drag: { x: number; start: number; moved: boolean } | null = null;
wave.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  wave.setPointerCapture(e.pointerId);
  drag = { x: e.clientX, start: viewStart, moved: false };
  wave.classList.add("dragging");
});
wave.addEventListener("pointermove", (e) => {
  const rect = wave.getBoundingClientRect();
  hoverX = e.clientX - rect.left;
  if (!drag) return;
  if (Math.abs(e.clientX - drag.x) > 3) drag.moved = true;
  if (!drag.moved) return;
  const dt = ((drag.x - e.clientX) / rect.width) * viewSpan;
  follow = false;
  viewStart = drag.start + dt;
  clampView();
});
const endDrag = (e: PointerEvent) => {
  if (drag && !drag.moved && e.type === "pointerup" && store?.length) {
    const rect = wave.getBoundingClientRect();
    setMarker(viewStart + ((e.clientX - rect.left) / rect.width) * viewSpan);
  }
  drag = null;
  wave.classList.remove("dragging");
};
wave.addEventListener("pointerup", endDrag);
wave.addEventListener("pointercancel", endDrag);
wave.addEventListener("pointerleave", () => (hoverX = null));
wave.addEventListener("dblclick", () => showAll());

function showAll() {
  viewSpan = Math.max(total(), 0.01);
  viewStart = 0;
  follow = recording;
  clampView();
}

function seekOverview(e: PointerEvent) {
  const rect = over.getBoundingClientRect();
  const t = ((e.clientX - rect.left) / rect.width) * total();
  follow = false;
  viewStart = t - viewSpan / 2;
  clampView();
  if (recording && viewStart + viewSpan >= total() - 1e-4) follow = true;
}
over.addEventListener("pointerdown", (e) => {
  over.setPointerCapture(e.pointerId);
  seekOverview(e);
});
over.addEventListener("pointermove", (e) => {
  if (over.hasPointerCapture(e.pointerId)) seekOverview(e);
});

$("wv-start").addEventListener("click", () => void openInput());
$("wv-rec").addEventListener("click", () => setRecording(!recording));
$("wv-stop").addEventListener("click", stopAll);
$("wv-home").addEventListener("click", toStart);
$("wv-end").addEventListener("click", toEnd);
$("wv-clear").addEventListener("click", clearAll);
$("wv-play").addEventListener("click", togglePlay);

const KEYS: Record<string, () => void> = {
  Space: spaceAction,
  Home: toStart,
  End: toEnd,
  KeyR: () => setRecording(!recording),
};
window.addEventListener("keydown", (e) => {
  const act = KEYS[e.code];
  if (!visible || !act || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target as HTMLElement;
  if (t.closest("input, select, textarea, [contenteditable]")) return;
  e.preventDefault();
  // Space on a focused button would also click it.
  if (t instanceof HTMLButtonElement) t.blur();
  act();
});
$("wv-all").addEventListener("click", showAll);
$("wv-live").addEventListener("click", () => {
  follow = true;
  clampView();
});
$("wv-device").addEventListener("change", (e) => {
  settings.deviceId = (e.target as HTMLSelectElement).value;
  saveSettings();
  if (ctx) void openInput();
});

// ---------- monitoring (amp + distortion) ----------

let monitor: Monitor | null = null;
let monitorInit: Promise<Monitor | null> | null = null;
const moStatus = (text: string, busy = false) => {
  const el = $("mo-status");
  el.textContent = text;
  el.classList.toggle("busy", busy);
};

function ensureMonitor(): Promise<Monitor | null> {
  monitorInit ??= (async () => {
    if (!source) await openInput();
    if (!ctx || !source) return null;
    try {
      monitor = await Monitor.create(ctx, settings.mon, moStatus);
      source.connect(monitor.input);
      return monitor;
    } catch (e) {
      console.error(e);
      moStatus(`Не удалось запустить усилитель: ${(e as Error).message}`);
      return null;
    }
  })();
  return monitorInit.then((m) => {
    if (!m) monitorInit = null;
    return m;
  });
}

const moAmp = $<HTMLSelectElement>("mo-amp");
moAmp.replaceChildren(
  ...[...AMPS.map((a) => [a.id, a.name]), ["none", "Без усилителя"], ["file", "Свой файл .nam…"]].map(([v, t]) => {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = t;
    return o;
  }),
);
let customFile: File | null = null;

const SLIDERS: { id: string; key: "inDb" | "volDb" | "drive" | "tone" | "levelDb"; fmt: (v: number) => string }[] = [
  { id: "mo-in", key: "inDb", fmt: (v) => `${v > 0 ? "+" : ""}${v} дБ` },
  { id: "mo-vol", key: "volDb", fmt: (v) => `${v} дБ` },
  { id: "mo-drive", key: "drive", fmt: (v) => `${Math.round(v * 100)}%` },
  { id: "mo-tone", key: "tone", fmt: (v) => `${Math.round(v * 100)}%` },
  { id: "mo-level", key: "levelDb", fmt: (v) => `${v > 0 ? "+" : ""}${v} дБ` },
];

function renderMonitorControls() {
  const m = settings.mon;
  moAmp.value = m.amp === "file" && !customFile ? MONITOR_DEFAULTS.amp : m.amp;
  $<HTMLInputElement>("mo-cab").checked = m.cab;
  $<HTMLInputElement>("mo-dist").checked = m.dist;
  $<HTMLSelectElement>("mo-type").value = m.distType;
  for (const sl of SLIDERS) {
    $<HTMLInputElement>(sl.id).value = String(m[sl.key]);
    $(`${sl.id}-v`).textContent = sl.fmt(m[sl.key]);
  }
  for (const id of ["mo-type", "mo-drive", "mo-tone", "mo-level"]) $<HTMLInputElement>(id).disabled = !m.dist;
}

function monitorChanged() {
  saveSettings();
  renderMonitorControls();
  monitor?.apply();
}

$<HTMLInputElement>("mo-on").addEventListener("change", async (e) => {
  const box = e.target as HTMLInputElement;
  if (!box.checked) {
    monitor?.setEnabled(false);
    $("mo-lat").textContent = "";
    return;
  }
  box.disabled = true;
  const m = await ensureMonitor();
  box.disabled = false;
  if (!m) {
    box.checked = false;
    return;
  }
  m.setEnabled(box.checked);
  $("mo-lat").textContent = `задержка ≈ ${m.latencyMs()} мс`;
});

moAmp.addEventListener("change", async () => {
  const v = moAmp.value;
  if (v === "file") {
    $<HTMLInputElement>("mo-file").click();
    return;
  }
  settings.mon.amp = v;
  const preset = AMPS.find((a) => a.id === v);
  if (preset) settings.mon.cab = !preset.hasCab;
  monitorChanged();
  await monitor?.loadAmp(v);
});

const moFile = $<HTMLInputElement>("mo-file");
moFile.addEventListener("change", async () => {
  const f = moFile.files?.[0];
  moFile.value = "";
  if (!f) return renderMonitorControls();
  customFile = f;
  settings.mon.amp = "file";
  settings.mon.cab = true;
  monitorChanged();
  const m = monitor ?? (await ensureMonitor());
  await m?.loadAmp("file", f);
});
moFile.addEventListener("cancel", () => renderMonitorControls());

$<HTMLSelectElement>("mo-out").addEventListener("change", (e) => {
  settings.outId = (e.target as HTMLSelectElement).value;
  saveSettings();
  void applySink();
});
$<HTMLInputElement>("mo-cab").addEventListener("change", (e) => {
  settings.mon.cab = (e.target as HTMLInputElement).checked;
  monitorChanged();
});
$<HTMLInputElement>("mo-dist").addEventListener("change", (e) => {
  settings.mon.dist = (e.target as HTMLInputElement).checked;
  monitorChanged();
});
$<HTMLSelectElement>("mo-type").addEventListener("change", (e) => {
  settings.mon.distType = (e.target as HTMLSelectElement).value as DistType;
  monitorChanged();
});
for (const sl of SLIDERS)
  $<HTMLInputElement>(sl.id).addEventListener("input", (e) => {
    settings.mon[sl.key] = Number((e.target as HTMLInputElement).value);
    monitorChanged();
  });

// Browsers restore checkbox state on reload; monitoring always starts off.
$<HTMLInputElement>("mo-on").checked = false;
renderMonitorControls();
