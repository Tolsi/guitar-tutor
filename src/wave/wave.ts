import workletUrl from "./capture-worklet.ts?worker&url";
import { SampleStore } from "./store";
import type { ChannelMode } from "./capture-worklet";
import { LOW_LIMIT_K, checkPitches, isPalmMuted, noteOf, type PitchCheck, type PmNote } from "./pm";
import { AMPS, MONITOR_DEFAULTS, Monitor, type DistType, type MonitorSettings } from "./monitor";
import { ISSUE_LABEL, LIMITS, noteName, summarize, type IssueKind, type Note, type Strictness } from "../legato/notes";
import { Timeline, clipEnd, encodeWav, type Clip, type Take } from "./timeline";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const SETTINGS_KEY = "wave-settings";

type GridDiv = "off" | "1" | "4" | "8" | "16";

interface Settings {
  deviceId: string;
  outId: string;
  channel: ChannelMode;
  /** Headphone monitoring through the amp; also used for playback. */
  monOn: boolean;
  exercise: "free" | "pm" | "pmopen" | "legato";
  /** What the timeline shows: the waveform, the pitch of the notes, or both (never neither). */
  showWave: boolean;
  showPitch: boolean;
  lgStrict: Strictness;
  pmLimMs: number;
  attLimMs: number;
  bpm: number;
  grid: GridDiv;
  /** Digital gain on the input, dB (set by hand, or the last value auto-level arrived at). */
  inGainDb: number;
  /** Auto-level: raise or lower the input gain so played notes peak near targetDb. */
  autoInGain: boolean;
  targetDb: number;
  /** Noise gate after the input gain, opening this many dB above the measured noise floor. */
  gateOn: boolean;
  gateMarginDb: number;
  /** Fit the wave height to the visible peak. */
  autoGain: boolean;
  mon: MonitorSettings;
  /** Settings format revision, for moving old defaults. */
  rev: number;
}
function loadSettings(): Settings {
  const def = (): Settings => ({
    deviceId: "",
    outId: "",
    channel: "auto",
    monOn: true,
    exercise: "free",
    showWave: true,
    showPitch: false,
    lgStrict: "normal",
    pmLimMs: 350,
    attLimMs: 70,
    bpm: 120,
    grid: "4",
    inGainDb: 0,
    autoInGain: true,
    targetDb: -12,
    gateOn: true,
    gateMarginDb: 10,
    autoGain: true,
    mon: { ...MONITOR_DEFAULTS },
    rev: 2,
  });
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}");
    const d = def();
    // Rev 2: real recordings put a clean pick attack at 30–55 ms, so the old 40 ms default flagged most notes.
    if ((saved.rev ?? 1) < 2 && saved.attLimMs === 40) delete saved.attLimMs;
    // The two views used to exclude each other.
    if (saved.view === "pitch" && saved.showPitch === undefined) Object.assign(saved, { showWave: false, showPitch: true });
    delete saved.view;
    return { ...d, ...saved, rev: 2, mon: { ...d.mon, ...(saved.mon ?? {}) } };
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
/** Records the processed signal; fed by the effect chain, or straight by the input until it is up. */
let tap: AudioWorkletNode | null = null;
let tapFrom: AudioNode | null = null;
let tl: Timeline | null = null;
if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__wave = () => ({ tl });
let sr = 48000;

let visible = false;
let recording = false;
/** The take being recorded and its clip. */
let rec: { take: Take; clip: Clip } | null = null;
/** Keep the right edge of the view on the recording head. */
let follow = true;
let viewStart = 0;
let viewSpan = 3;
let gain = 1;
let levelDb = -Infinity;
let hover: { x: number; y: number } | null = null;
let play: { src: AudioBufferSourceNode; from: number; at: number } | null = null;
/** Where Space starts playback (set by a click on the wave). */
let marker: number | null = null;
/** Where playback was paused; Space resumes from here until a new marker is set. */
let pausedAt: number | null = null;
/** Time range selected for playback and export, seconds. */
let selection: { a: number; b: number } | null = null;
let selClip: Clip | null = null;
/** Block peaks (time, dBFS) of the last 3 s, for the weak-signal warning. */
const recentPeaks: [number, number][] = [];
let inputSince = 0;

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
  warn: string;
  good: string;
  box: string;
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
    warn: v("--scope-warn"),
    good: v("--scope-good"),
    box: v("--scope-box"),
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

const total = () => (tl ? tl.length / sr : 0);
/** Where new audio is arriving (the end of the recording clip), or the end of the timeline. */
const head = () => (rec ? clipEnd(rec.clip) / sr : total());

function clampView() {
  const t = total();
  // While live (or empty) allow a window wider than the recording so it can fill up.
  const maxSpan = Math.max(t, recording || t === 0 ? 10 : 0.01);
  viewSpan = Math.min(Math.max(viewSpan, 16 / sr), maxSpan);
  if (follow) viewStart = Math.max(0, head() - viewSpan);
  else viewStart = Math.min(Math.max(viewStart, 0), Math.max(0, t - viewSpan));
}

/** Blocks of the raw input (after channel choice and input gain): only the level meter and warning. */
function onInputBlock(d: Float32Array) {
  let pk = 0;
  for (let i = 0; i < d.length; i++) pk = Math.max(pk, Math.abs(d[i]));
  const db = pk > 0 ? 20 * Math.log10(pk) : -Infinity;
  levelDb = db > levelDb ? db : levelDb - 0.6;
  const now = performance.now();
  recentPeaks.push([now, db]);
  while (recentPeaks.length && recentPeaks[0][0] < now - 3000) recentPeaks.shift();
  autoLevel(pk, d.length / sr, now);
}

/** Raw (pre-gain) block peaks of the last 6 s. */
const rawPeaks: [number, number][] = [];
let lastGainSave = 0;

/**
 * Slow auto-level of the input. Gain moves only between takes (6 dB/s up, 10 dB/s down) so it never
 * reshapes a note's decay; during recording it only backs off to stop clipping.
 */
function autoLevel(pk: number, dt: number, now: number) {
  const raw = pk / 10 ** (settings.inGainDb / 20);
  rawPeaks.push([now, raw]);
  while (rawPeaks.length && rawPeaks[0][0] < now - 6000) rawPeaks.shift();
  if (!settings.autoInGain) return;
  if (pk > 0.89) {
    // Clipping: drop at once so the peak lands near −6 dB.
    setInGain(settings.inGainDb - 20 * Math.log10(pk / 0.5));
    return;
  }
  if (recording || rawPeaks.length < 50) return;
  const sorted = rawPeaks.map((p) => p[1]).sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.2)];
  let loud = 0;
  for (const [t, v] of rawPeaks) if (t >= now - 4000) loud = Math.max(loud, v);
  // Only adjust while something is being played (12 dB above the background).
  if (loud < 1e-6 || loud < floor * 4) return;
  let want = settings.targetDb - 20 * Math.log10(loud);
  // Never lift the hiss above NOISE_CEIL_DB: past that, more gain is mostly more noise.
  if (noiseDb !== null) want = Math.min(want, NOISE_CEIL_DB - noiseDb);
  want = Math.min(50, Math.max(0, want));
  const diff = want - settings.inGainDb;
  // Only ever turns down: the gain set by hand is the ceiling, auto-level never raises it (nor the hiss).
  if (diff > -1.5) return;
  setInGain(settings.inGainDb + Math.max(-10 * dt, diff));
}

/** Highest level the input noise may reach after auto-gain, dB RMS. */
const NOISE_CEIL_DB = -60;

function showNoise() {
  const el = document.getElementById("st-noise");
  if (!el) return;
  el.textContent =
    noiseDb === null
      ? "Шум входа ещё не измерен — включите вход."
      : `Шум входа: ${Math.round(noiseDb)} дБ, после усиления ${Math.round(noiseDb + settings.inGainDb)} дБ. ` +
        `Автоусиление не поднимает шум выше ${NOISE_CEIL_DB} дБ.`;
}

function setInGain(db: number) {
  settings.inGainDb = Math.min(50, Math.max(0, db));
  node?.port.postMessage({ gain: 10 ** (settings.inGainDb / 20) });
  const now = performance.now();
  if (now - lastGainSave > 2000) {
    lastGainSave = now;
    saveSettings();
  }
}

/**
 * Recorded blocks: the processed signal (after all effects) is what is shown, played and saved; the clean
 * guitar beside it is what the exercise analysis listens to (distortion flattens attacks and pitch).
 */
function onTapBlock(wet: Float32Array, dry: Float32Array) {
  if (!recording || !rec) return;
  rec.take.store.push(wet);
  rec.take.dry?.push(dry);
  rec.clip.to = rec.take.store.length;
}

function routeTap(from: AudioNode) {
  if (!tap) return;
  if (tapFrom) {
    try {
      tapFrom.disconnect(tap, 0, 0); // only the processed input: the clean one may come from the same node
    } catch {
      /* was not connected */
    }
  }
  from.connect(tap, 0, 0);
  tapFrom = from;
}

/** The audio context and timeline, created on first use (input or a file import). */
async function ensureCtx() {
  if (ctx) return ctx;
  // NAM models are trained at 48 kHz.
  let c: AudioContext;
  try {
    c = new AudioContext({ latencyHint: "interactive", sampleRate: 48000 });
  } catch {
    c = new AudioContext({ latencyHint: "interactive" });
  }
  await c.audioWorklet.addModule(workletUrl);
  ctx = c;
  sr = c.sampleRate;
  tl = new Timeline(sr);
  tap = new AudioWorkletNode(c, "wave-tap", {
    numberOfInputs: 2,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 1,
    channelCountMode: "explicit",
    channelInterpretation: "discrete",
  });
  tap.port.onmessage = (e: MessageEvent<{ wet: Float32Array; dry: Float32Array }>) => onTapBlock(e.data.wet, e.data.dry);
  const mute = c.createGain();
  mute.gain.value = 0;
  tap.connect(mute).connect(c.destination);
  return c;
}

async function openInput() {
  const status = $("wv-status");
  const start = $<HTMLButtonElement>("wv-start");
  status.textContent = "Жду разрешения на микрофон…";
  start.disabled = true;
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
        // Interfaces often carry the guitar on input 2; ask for both channels and pick one.
        channelCount: { ideal: 2 },
      },
    });
    const c = await ensureCtx();
    await c.resume();
    source = c.createMediaStreamSource(stream);
    node = new AudioWorkletNode(c, "wave-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 2,
      channelCountMode: "explicit",
      channelInterpretation: "discrete",
    });
    node.port.onmessage = (e: MessageEvent<Float32Array | ChannelReport>) =>
      e.data instanceof Float32Array ? onInputBlock(e.data) : onChannels(e.data);
    node.port.postMessage({
      mode: settings.channel,
      gain: 10 ** (settings.inGainDb / 20),
      gate: settings.gateOn,
      gateMarginDb: settings.gateMarginDb,
    });
    const mute = c.createGain();
    mute.gain.value = 0;
    source.connect(node).connect(mute).connect(c.destination);
    // The clean guitar goes to the recorder's second input, for the analysis.
    if (tap) node.connect(tap, 0, 1);
    // The effect chain always runs (the headphone switch only mutes it); recording taps its output.
    if (monitor) {
      node.connect(monitor.input);
      routeTap(monitor.wet);
    } else {
      routeTap(node);
      void startMonitor();
    }

    inputSince = performance.now();
    const track = stream.getAudioTracks()[0];
    status.textContent = `Вход: ${track.label || "микрофон"}, ${sr / 1000} кГц`;
    start.textContent = "Выключить вход";
    start.disabled = false;
    $<HTMLButtonElement>("wv-rec").disabled = !monitor;
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
    start.disabled = false;
  }
}

/**
 * Turns the input off and puts the input panel back as it was before it was switched on: recording and
 * playback stop (what was recorded stays on the timeline), the device is released and can be chosen anew.
 */
function closeInput() {
  stopAll();
  stream?.getTracks().forEach((t) => t.stop());
  source?.disconnect();
  if (node) {
    node.port.onmessage = null; // reports already on their way must not light the panel up again
    node.disconnect();
  }
  if (tapFrom === node) tapFrom = null;
  stream = null;
  source = null;
  node = null;
  levelDb = -Infinity;
  recentPeaks.length = 0;
  rawPeaks.length = 0;
  noiseDb = null;
  showNoise();
  const start = $<HTMLButtonElement>("wv-start");
  start.textContent = "Включить аудиовход";
  start.disabled = false;
  $<HTMLButtonElement>("wv-rec").disabled = true;
  const dev = $<HTMLSelectElement>("wv-device");
  dev.replaceChildren(new Option("—"));
  dev.disabled = true;
  const chan = $<HTMLSelectElement>("wv-chan");
  ["Авто", "Канал 1", "Канал 2"].forEach((t, i) => (chan.options[i].textContent = t));
  chan.value = String(settings.channel);
  chan.disabled = true;
  $("wv-status").textContent = "Вход выключен.";
}

interface ChannelReport {
  sel: number;
  channels: number;
  db: number[];
  /** Noise floor of the raw input (mean square, dB), null until measured. */
  floorDb: number | null;
  gateOpen: boolean;
}
/** Raw input noise floor, dB RMS. */
let noiseDb: number | null = null;
function onChannels(r: ChannelReport) {
  noiseDb = r.floorDb;
  showNoise();
  const sel = $<HTMLSelectElement>("wv-chan");
  sel.disabled = r.channels < 2;
  const auto = sel.options[0];
  auto.textContent = r.channels < 2 ? "Один канал" : `Авто (сейчас ${r.sel + 1})`;
  // Show per-channel levels so a silent input is obvious.
  for (let c = 0; c < 2; c++) {
    const o = sel.options[c + 1];
    const db = r.db[c];
    o.textContent = `Канал ${c + 1}${db !== undefined ? ` · ${db < -90 ? "тишина" : `${Math.round(db)} дБ`}` : ""}`;
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
  if (on === recording) return;
  if (on) {
    if (!ctx || !tl || !node) return;
    stopPlay();
    // A new take starts at the marker (or the end); over existing audio it goes on a free lane, one with
    // nothing after the marker, since the take may grow without limit.
    const pos = marker !== null ? Math.min(Math.round(marker * sr), tl.length) : tl.length;
    const lane = tl.freeLane(pos, Infinity);
    const take = tl.newTake(`Дубль ${tl.takeCount + 1}`, new SampleStore(), new SampleStore());
    tl.checkpoint();
    rec = { take, clip: tl.addClip(take, 0, 0, pos, lane) };
    selClip = rec.clip;
    selection = null;
    follow = true;
  } else if (rec && tl) {
    // An empty take leaves no clip behind.
    if (rec.clip.to === 0) tl.clips = tl.clips.filter((c) => c !== rec!.clip);
    marker = clipEnd(rec.clip) / sr;
    rec = null;
  }
  recording = on;
  $("wv-rec").classList.toggle("on", on);
  $("wv-rec").setAttribute("aria-pressed", String(on));
  clampView();
  renderEditState();
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
  if (!ctx || !tl || !tl.length) return;
  if (recording) setRecording(false);
  let from = pausedAt ?? marker ?? selection?.a ?? viewStart;
  if (from >= total() - 0.01) from = marker ?? 0;
  // Inside a selection, play to its end.
  const end = selection && from >= selection.a && from < selection.b ? selection.b : total();
  pausedAt = null;
  const data = tl.render(from * sr, end * sr);
  if (!data.length) return;
  const buf = ctx.createBuffer(1, data.length, sr);
  buf.copyToChannel(data, 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  // Takes are recorded after the effects: play them straight to the output.
  src.connect(monitor ? monitor.playIn : ctx.destination);
  src.onended = () => stopPlay();
  void ctx.resume();
  src.start();
  play = { src, from, at: ctx.currentTime };
  $("wv-play").innerHTML = ICON.pause;
  $("wv-play").classList.add("on");
}

function clearAll() {
  if (recording) setRecording(false);
  stopPlay();
  tl?.clear();
  selClip = null;
  selection = null;
  follow = true;
  viewSpan = 3;
  hover = null;
  marker = pausedAt = null;
  pmKey = "";
  clampView();
  renderEditState();
}

// ---------- editing ----------

/** Grid step in seconds, or null when snapping is off. */
function gridStep() {
  if (settings.grid === "off") return null;
  const beat = 60 / settings.bpm;
  return settings.grid === "1" ? beat * 4 : (beat * 4) / Number(settings.grid);
}

function splitAtMarker() {
  if (!tl || marker === null || recording) return;
  const s = Math.round(marker * sr);
  const own = selClip && s > selClip.pos && s < clipEnd(selClip) ? selClip : null;
  const made = tl.split(s, own);
  if (made.length) {
    selClip = made[0];
    status(`Разрезано: ${made.length === 1 ? "1 кусочек" : `${made.length} кусочка`} по маркеру.`);
  } else status("Под маркером нет кусочка, который можно разрезать.");
  renderEditState();
}

function deleteClip() {
  if (!tl || !selClip || recording) return;
  tl.remove(selClip);
  selClip = null;
  renderEditState();
}

function undo() {
  if (!tl || recording) return;
  if (tl.undo()) {
    selClip = null;
    status("Отменено.");
  }
  renderEditState();
}

const status = (t: string) => ($("wv-edit-status").textContent = t);

function renderEditState() {
  const has = !!tl && tl.clips.length > 0;
  $<HTMLButtonElement>("ed-split").disabled = !has || recording;
  $<HTMLButtonElement>("ed-del").disabled = !selClip || recording;
  $<HTMLButtonElement>("ed-undo").disabled = !tl?.canUndo || recording;
  $<HTMLButtonElement>("ed-save-all").disabled = !has || recording;
  $<HTMLButtonElement>("ed-save-sel").disabled = !has || !selection || recording;
  $("ed-sel").textContent = selection
    ? `Выделено ${fmtClock(selection.a)}–${fmtClock(selection.b)} (${fmtSpan(selection.b - selection.a)})`
    : "";
}

function fileStamp() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}`;
}

function saveWav(part: boolean) {
  if (!tl || !tl.length) return;
  const a = part && selection ? selection.a : 0;
  const b = part && selection ? selection.b : total();
  const blob = encodeWav(tl.render(a * sr, b * sr), sr);
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `guitar_${fileStamp()}${part ? "_fragment" : ""}.wav`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  status(`Сохранено: ${link.download} (${fmtSpan(b - a)}, WAV 24 бит, ${sr / 1000} кГц).`);
}

/** Adds an audio file at `at` (or the marker, or the end). Returns its clip, or null if it could not be read. */
async function importFile(f: File, at?: { t: number; lane: number }): Promise<Clip | null> {
  try {
    const c = await ensureCtx();
    status(`Читаю «${f.name}»…`);
    const audio = await c.decodeAudioData(await f.arrayBuffer());
    const len = audio.length;
    const mono = new Float32Array(len);
    for (let ch = 0; ch < audio.numberOfChannels; ch++) {
      const d = audio.getChannelData(ch);
      for (let i = 0; i < len; i++) mono[i] += d[i] / audio.numberOfChannels;
    }
    const store = new SampleStore();
    store.push(mono);
    const t = tl!;
    const take = t.newTake(f.name.replace(/\.[^.]+$/, ""), store);
    const want = at ? at.t : marker;
    const pos = want !== null ? Math.min(Math.max(0, Math.round(want * sr)), t.length) : t.length;
    t.checkpoint();
    const clip = t.addClip(take, 0, len, pos, t.freeLane(pos, len, Math.min(at?.lane ?? 0, t.lanes - 1)));
    selClip = clip;
    follow = false;
    status(`Добавлен «${take.name}» (${fmtSpan(len / sr)}).`);
    renderEditState();
    return clip;
  } catch (e) {
    console.error(e);
    status(`Не удалось открыть «${f.name}»: это не аудиофайл или формат не поддерживается.`);
    return null;
  }
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

const fmtClock = (t: number) => {
  const m = Math.floor(t / 60);
  return `${m}:${(t - m * 60).toFixed(3).padStart(6, "0")}`;
};

function fmtSpan(s: number) {
  if (s < 0.001) return `${(s * 1e6).toFixed(0)} мкс`;
  if (s < 1) return `${(s * 1000).toFixed(s < 0.01 ? 2 : s < 0.1 ? 1 : 0)} мс`;
  return `${s.toFixed(s < 10 ? 2 : 1)} с`;
}

const fmtDb = (v: number) => (v > 1e-6 ? `${(20 * Math.log10(v)).toFixed(1)} дБ` : "−∞ дБ");

const RULER = 22;
const MAX_GAIN = 300;
/** Auto height never scales up sounds below this peak (−24 dBFS): they are not what is being played. */
const AUTO_FLOOR = 10 ** (-24 / 20);
let peakCache = { key: "", at: 0, peak: 0 };
/** Loudest sample on the whole timeline, refreshed at most 5 times a second. */
function loudestPeak() {
  if (!tl) return 0;
  const key = `${tl.clips.length}:${tl.length}`;
  const now = performance.now();
  if (key !== peakCache.key && now - peakCache.at > 200) {
    const [mn, mx] = tl.range(0, tl.length);
    peakCache = { key, at: now, peak: Math.max(-mn, mx, 0) };
  }
  return peakCache.peak;
}
/** Lanes shown: the used ones, plus an empty one while a clip is being dragged. */
// No spare lane while dragging: it would shrink every lane (and the wave) the moment a clip is grabbed.
// A new lane appears only when a clip is dropped into the bottom strip of the last lane (see pointermove).
const laneCount = () => (tl ? tl.lanes : 1);

function drawWave() {
  const { g, W, H, dpr } = fit(wave);
  g.fillStyle = col.stage;
  g.fillRect(0, 0, W, H);
  const top = RULER * dpr;
  const lanes = laneCount();
  const laneH = (H - top) / lanes;
  const xOf = (t: number) => ((t - viewStart) / viewSpan) * W;

  // musical grid
  const gs = gridStep();
  if (gs && (gs / viewSpan) * W >= 6 * dpr) {
    const beat = 60 / settings.bpm;
    for (let k = Math.ceil(viewStart / gs); k * gs <= viewStart + viewSpan; k++) {
      const t = k * gs;
      const bar = Math.abs(t / (beat * 4) - Math.round(t / (beat * 4))) < 1e-6;
      g.fillStyle = bar ? col.axis : col.grid;
      g.fillRect(Math.round(xOf(t)), top, dpr, H - top);
    }
  }
  // time ruler
  const step = niceStep((viewSpan * 110 * dpr) / W);
  g.font = `${11 * dpr}px "IBM Plex Mono", ui-monospace, monospace`;
  g.textBaseline = "middle";
  for (let t = Math.ceil(viewStart / step) * step; t <= viewStart + viewSpan; t += step) {
    const x = Math.round(xOf(t));
    g.fillStyle = col.grid;
    g.fillRect(x, 0, dpr, top);
    if (!gs) g.fillRect(x, top, dpr, H - top);
    g.fillStyle = col.text;
    g.fillText(fmtTime(t, step), x + 4 * dpr, top / 2);
  }
  // lane separators
  g.fillStyle = col.grid;
  for (let l = 1; l < lanes; l++) g.fillRect(0, Math.round(top + l * laneH), W, dpr);

  if (selection) {
    const x0 = xOf(selection.a), x1 = xOf(selection.b);
    g.fillStyle = col.play;
    g.globalAlpha = 0.14;
    g.fillRect(x0, top, x1 - x0, H - top);
    g.globalAlpha = 0.6;
    g.fillRect(Math.round(x0), top, dpr, H - top);
    g.fillRect(Math.round(x1), top, dpr, H - top);
    g.globalAlpha = 1;
  }

  if (settings.autoGain && tl && tl.length) {
    // One steady height for the whole session: the loudest sound recorded so far fills 85 %, and nothing
    // quieter than AUTO_FLOOR is ever blown up (silence and hiss at the start of a take stay small).
    const want = Math.min(MAX_GAIN, Math.max(1, 0.85 / Math.max(loudestPeak(), AUTO_FLOOR)));
    gain += (want - gain) * (want < gain ? 0.5 : 0.15);
  }
  if (tl && tl.clips.length) {
    const checks = new Map<Take, Map<PmNote, PitchCheck>>();
    if (pitchView()) fitPitch();
    for (const c of tl.clips) {
      const x0 = xOf(c.pos / sr), x1 = xOf(clipEnd(c) / sr);
      if (x1 < 0 || x0 > W) continue;
      drawClip(g, c, x0, x1, top + c.lane * laneH, laneH, W, dpr);
      if (pitchView()) drawPitch(g, W, top + c.lane * laneH, laneH, dpr, xOf, c);
      if (settings.showWave && pmEx()) {
        let ch = checks.get(c.take);
        if (!ch) checks.set(c.take, (ch = pitchChecks(c.take.pm.notes)));
        drawPmMarks(g, W, top + c.lane * laneH, waveH(laneH), dpr, xOf, c, ch);
      }
    }
  } else {
    g.fillStyle = col.text;
    g.textAlign = "center";
    g.fillText(
      ctx ? "Нажмите ● или клавишу R, чтобы записать, или перетащите сюда аудиофайл." : "Включите аудиовход или перетащите сюда аудиофайл.",
      W / 2,
      top + (H - top) / 2 - 20 * dpr,
    );
    g.textAlign = "start";
  }

  if (marker !== null) {
    const x = Math.round(xOf(marker));
    if (x >= 0 && x <= W) {
      g.fillStyle = col.axis;
      g.fillRect(x, 0, dpr, H);
    }
  }
  const pos = playPos() ?? pausedAt;
  if (pos !== null) {
    const x = xOf(pos);
    if (x >= 0 && x <= W) {
      g.fillStyle = col.play;
      g.globalAlpha = play ? 1 : 0.55;
      g.fillRect(Math.round(x), 0, 2 * dpr, H);
      g.globalAlpha = 1;
    }
  }
}

function drawClip(g: CanvasRenderingContext2D, c: Clip, x0: number, x1: number, y0: number, h: number, W: number, dpr: number) {
  const st = c.take.store;
  const pad = 2 * dpr;
  const head = h > 46 * dpr ? 14 * dpr : 0;
  g.fillStyle = col.box;
  g.fillRect(x0, y0 + pad, x1 - x0, h - 2 * pad);
  if (c === selClip) {
    g.strokeStyle = col.play;
    g.lineWidth = 1.5 * dpr;
    g.strokeRect(x0 + dpr, y0 + pad + dpr, x1 - x0 - 2 * dpr, h - 2 * pad - 2 * dpr);
  }
  if (head) {
    g.save();
    g.beginPath();
    g.rect(Math.max(0, x0), y0, Math.min(W, x1) - Math.max(0, x0), h);
    g.clip();
    g.fillStyle = c === selClip ? col.play : col.text;
    g.font = `${10 * dpr}px "IBM Plex Mono", ui-monospace, monospace`;
    g.textBaseline = "top";
    g.fillText(c.take.name, Math.max(x0, 0) + 5 * dpr, y0 + pad + 2 * dpr);
    g.textBaseline = "middle";
    g.restore();
  }
  if (!settings.showWave) return;
  h = waveH(h);
  const mid = y0 + head / 2 + h / 2;
  const amp = ((h - head) / 2 - 4 * dpr) * gain;
  const yTop = y0 + pad + head, yBot = y0 + h - pad;
  const yOf = (v: number) => Math.min(yBot, Math.max(yTop, mid - v * amp));
  g.fillStyle = col.grid;
  g.fillRect(Math.max(0, x0), Math.round(mid), Math.min(W, x1) - Math.max(0, x0), dpr);

  const spp = (viewSpan * sr) / W;
  const s0 = viewStart * sr;
  const off = c.from - c.pos; // timeline sample → take sample
  if (spp >= 2) {
    const pxA = Math.max(0, Math.floor(x0)), pxB = Math.min(W, Math.ceil(x1));
    for (let px = pxA; px < pxB; px++) {
      const a = Math.max(c.pos, Math.floor(s0 + px * spp));
      // +1 overlaps the next column so steep edges stay connected.
      const b = Math.min(clipEnd(c), Math.max(a + 1, Math.floor(s0 + (px + 1) * spp)) + 1);
      if (b <= a) continue;
      const [mn, mx] = st.range(a + off, b + off);
      if (mn > mx) continue;
      g.fillStyle = mx >= 0.995 || mn <= -0.995 ? col.clip : col.wave;
      const y1 = yOf(mx), y2 = yOf(mn);
      g.fillRect(px, y1, 1, Math.max(dpr, y2 - y1));
    }
  } else {
    const i0 = Math.max(c.pos, Math.floor(s0) - 1);
    const i1 = Math.min(clipEnd(c) - 1, Math.ceil(s0 + W * spp) + 1);
    if (i1 < i0) return;
    g.strokeStyle = col.wave;
    g.lineWidth = 1.5 * dpr;
    g.beginPath();
    for (let i = i0; i <= i1; i++) {
      const x = (i - s0) / spp, y = yOf(st.at(i + off));
      if (i === i0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
    if (1 / spp > 7 * dpr) {
      g.fillStyle = col.wave;
      for (let i = i0; i <= i1; i++) {
        g.beginPath();
        g.arc((i - s0) / spp, yOf(st.at(i + off)), 2.5 * dpr, 0, Math.PI * 2);
        g.fill();
      }
    }
  }
}

function drawOverview() {
  const { g, W, H, dpr } = fit(over);
  g.fillStyle = col.stage;
  g.fillRect(0, 0, W, H);
  const n = tl?.length ?? 0;
  if (!tl || !n) return;
  const mid = H / 2, amp = H / 2 - 3 * dpr;
  const spp = n / W;
  g.fillStyle = col.wave;
  for (let px = 0; px < W; px++) {
    const a = Math.floor(px * spp);
    const b = Math.max(a + 1, Math.floor((px + 1) * spp));
    const [mn, mx] = tl.range(a, b);
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
  const len = total();
  $("wv-dur").textContent = `${len.toFixed(1)} с`;
  $("wv-rate").textContent = ctx ? `${(sr / 1000).toFixed(1)}` : "—";
  $("wv-span").textContent = fmtSpan(viewSpan);
  const spp = (viewSpan * sr) / Math.max(1, wave.clientWidth);
  $("wv-spp").textContent = spp >= 1 ? `${spp.toFixed(spp < 10 ? 1 : 0)} сэмпл./пиксель` : `${(1 / spp).toFixed(1)} пикс./сэмпл`;
  if (tl && tl.length) {
    const [mn, mx] = tl.range(Math.floor(viewStart * sr), Math.ceil((viewStart + viewSpan) * sr));
    $("wv-peak").textContent = mn <= mx ? fmtDb(Math.max(-mn, mx)) : "—";
  } else $("wv-peak").textContent = "—";
  $("wv-gain").textContent = `×${gain < 10 ? gain.toFixed(1) : gain.toFixed(0)}${settings.autoGain ? " авто" : ""}`;
  renderWeak();
  showInGain();
  const lv = Math.max(0, Math.min(1, (levelDb + 60) / 60));
  const lvl = $("wv-level");
  lvl.style.width = `${lv * 100}%`;
  lvl.classList.toggle("hot", levelDb > -1);

  const cur = $("wv-cursor");
  if (hover && tl && tl.length) {
    const { t, lane } = locate(hover.x, hover.y);
    const i = Math.round(t * sr);
    if (i >= 0 && i < tl.length) {
      const c = tl.clipAt(i, lane);
      const v = tl.sampleAt(i);
      cur.textContent = `${fmtClock(t)} · сэмпл ${i} · ${v >= 0 ? "+" : ""}${v.toFixed(4)} (${fmtDb(Math.abs(v))})${c ? ` · ${c.take.name}` : ""}`;
      return;
    }
  }
  const at = playPos() ?? pausedAt ?? marker;
  if (at !== null) {
    const what = play ? "Играет" : pausedAt !== null ? "Пауза на" : "Маркер";
    cur.textContent = `${what} ${fmtClock(at)}`;
  } else cur.textContent = recording ? "Идёт запись · пробел — стоп" : "Клик — маркер, протяжка — выделение";
}

function renderTime() {
  const t = recording ? head() : (playPos() ?? pausedAt ?? marker ?? 0);
  $("wv-time").textContent = fmtClock(t);
  $("wv-time").classList.toggle("rec", recording);
}

function loop() {
  if (!visible) return;
  renderTime();
  if (pmEx() && tl) {
    for (const t of tl.takes) t.pm.update(t.dry ?? t.store);
    const ft = focusTake();
    const key = ft ? `${ft.id}:${ft.pm.version}` : "";
    if (key !== pmKey) renderPm();
  }
  if ((pitchView() || lgEx()) && tl) {
    // The take on screen first; a long import is worked through a little per frame.
    const deadline = performance.now() + 10;
    const ft = focusTake();
    for (const t of [...(ft ? [ft] : []), ...tl.takes.filter((t) => t !== ft)]) {
      t.lg.setLimits(LIMITS[settings.lgStrict]);
      t.lg.update(t.dry ?? t.store, t !== rec?.take, deadline);
    }
    if (lgEx()) {
      const key = wlKeyOf(ft);
      if (key !== wlKey) renderWl();
      drawWlDetail();
    }
  }
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
  live.hidden = follow || !tl?.length;
  live.textContent = recording ? "К реальному времени →" : "К концу записи →";
  requestAnimationFrame(loop);
}

// ---------- interaction ----------

/** Timeline time and lane under a point in canvas CSS pixels. */
function locate(x: number, y: number) {
  const t = viewStart + (x / wave.clientWidth) * viewSpan;
  const laneH = (wave.clientHeight - RULER) / laneCount();
  const lane = Math.max(0, Math.floor((y - RULER) / laneH));
  return { t, lane };
}

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
      settings.autoGain = false;
      saveSettings();
      renderViewMenu();
      gain = Math.min(MAX_GAIN, Math.max(1, gain * Math.exp(-(dy || dx) * 0.003)));
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
  if (recording && viewStart + viewSpan >= head() - 1e-4 && dt > 0) follow = true;
}

type Drag =
  | { mode: "pan"; x: number; start: number; moved: boolean }
  | { mode: "select"; x: number; anchor: number; moved: boolean }
  | { mode: "clip"; x: number; y: number; clip: Clip; grab: number; copy: boolean; moved: boolean };
let drag: Drag | null = null;

wave.addEventListener("pointerdown", (e) => {
  const rect = wave.getBoundingClientRect();
  const px = e.clientX - rect.left, py = e.clientY - rect.top;
  wave.setPointerCapture(e.pointerId);
  if (e.button === 1) {
    e.preventDefault();
    drag = { mode: "pan", x: e.clientX, start: viewStart, moved: false };
    wave.classList.add("dragging");
    return;
  }
  if (e.button !== 0) return;
  const { t, lane } = locate(px, py);
  const hit = !e.shiftKey && tl && !recording ? tl.clipAt(Math.round(t * sr), lane) : null;
  if (hit) {
    drag = { mode: "clip", x: e.clientX, y: e.clientY, clip: hit, grab: t * sr - hit.pos, copy: e.altKey, moved: false };
    selClip = hit;
    renderEditState();
  } else drag = { mode: "select", x: e.clientX, anchor: t, moved: false };
});

wave.addEventListener("pointermove", (e) => {
  const rect = wave.getBoundingClientRect();
  const px = e.clientX - rect.left, py = e.clientY - rect.top;
  hover = { x: px, y: py };
  if (!drag) return;
  if (!drag.moved && Math.abs(e.clientX - drag.x) + (drag.mode === "clip" ? Math.abs(e.clientY - drag.y) : 0) <= 3) return;
  const first = !drag.moved;
  drag.moved = true;
  const { t, lane } = locate(px, py);
  if (drag.mode === "pan") {
    follow = false;
    viewStart = drag.start + ((drag.x - e.clientX) / rect.width) * viewSpan;
    clampView();
  } else if (drag.mode === "select") {
    const a = Math.max(0, Math.min(drag.anchor, t)), b = Math.min(total(), Math.max(drag.anchor, t));
    selection = b > a ? { a, b } : null;
    renderEditState();
  } else if (tl) {
    if (first) {
      tl.checkpoint();
      if (drag.copy) {
        // Alt-drag leaves the original in place and moves a copy.
        const c = drag.clip;
        drag.clip = tl.addClip(c.take, c.from, c.to, c.pos, c.lane);
        selClip = drag.clip;
      }
      wave.classList.add("dragging");
    }
    let pos = t * sr - drag.grab;
    const gs = gridStep();
    if (gs && !e.shiftKey) pos = Math.round(pos / (gs * sr)) * gs * sr;
    drag.clip.pos = Math.max(0, Math.round(pos));
    // Bottom 15 % of the last lane (or below the wave) means "a new lane under the others".
    const c = drag.clip;
    let others = -1;
    for (const o of tl.clips) if (o !== c) others = Math.max(others, o.lane);
    const laneH = (wave.clientHeight - RULER) / laneCount();
    const last = laneCount() - 1;
    let want = lane;
    if (lane >= last && py > RULER + (last + 0.85) * laneH) want = last + 1;
    c.lane = Math.max(0, Math.min(want, others + 1));
    follow = false;
  }
});

const endDrag = (e: PointerEvent) => {
  const d = drag;
  drag = null;
  wave.classList.remove("dragging");
  if (!d || e.type !== "pointerup") return;
  const rect = wave.getBoundingClientRect();
  const { t } = locate(e.clientX - rect.left, e.clientY - rect.top);
  if (d.mode === "select") {
    if (!d.moved) {
      selection = null;
      selClip = null;
      if (tl?.length) setMarker(t);
    } else if (selection) {
      marker = selection.a;
      pausedAt = null;
    }
  } else if (d.mode === "clip") {
    if (!d.moved) {
      selection = null;
      setMarker(t);
    } else if (tl) compactLanes();
  }
  renderEditState();
};
wave.addEventListener("pointerup", endDrag);
wave.addEventListener("pointercancel", endDrag);
wave.addEventListener("pointerleave", () => (hover = null));
wave.addEventListener("dblclick", () => showAll());
wave.addEventListener("auxclick", (e) => e.preventDefault());

/** Removes empty lanes between used ones. */
function compactLanes() {
  if (!tl) return;
  const used = [...new Set(tl.clips.map((c) => c.lane))].sort((a, b) => a - b);
  const map = new Map(used.map((l, i) => [l, i]));
  for (const c of tl.clips) c.lane = map.get(c.lane)!;
}

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
  if (recording && viewStart + viewSpan >= head() - 1e-4) follow = true;
}
over.addEventListener("pointerdown", (e) => {
  over.setPointerCapture(e.pointerId);
  seekOverview(e);
});
over.addEventListener("pointermove", (e) => {
  if (over.hasPointerCapture(e.pointerId)) seekOverview(e);
});

$("wv-start").addEventListener("click", () => (source ? closeInput() : void openInput()));
$("wv-rec").addEventListener("click", () => setRecording(!recording));
$("wv-stop").addEventListener("click", stopAll);
$("wv-home").addEventListener("click", toStart);
$("wv-end").addEventListener("click", toEnd);
$("wv-clear").addEventListener("click", clearAll);
$("wv-play").addEventListener("click", togglePlay);
$("ed-split").addEventListener("click", splitAtMarker);
$("ed-del").addEventListener("click", deleteClip);
$("ed-undo").addEventListener("click", undo);
$("ed-save-all").addEventListener("click", () => saveWav(false));
$("ed-save-sel").addEventListener("click", () => saveWav(true));
const edFile = $<HTMLInputElement>("ed-file");
$("ed-add").addEventListener("click", () => edFile.click());
edFile.addEventListener("change", async () => {
  for (const f of [...(edFile.files ?? [])]) await importFile(f);
  edFile.value = "";
});

// Files dropped anywhere in the window: on the timeline they land where dropped, elsewhere as from the menu.
const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files");
const dropHint = $("drop-hint");
window.addEventListener("dragover", (e) => {
  if (!hasFiles(e)) return;
  // Without this the browser would leave the page for the file.
  e.preventDefault();
  const ok = !recording && !dlg.open;
  e.dataTransfer!.dropEffect = ok ? "copy" : "none";
  dropHint.hidden = !ok;
});
window.addEventListener("dragleave", (e) => {
  if (!e.relatedTarget) dropHint.hidden = true;
});
window.addEventListener("drop", async (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dropHint.hidden = true;
  if (recording || dlg.open) {
    if (recording) status("Идёт запись: остановите её, чтобы добавить файл.");
    return;
  }
  const files = [...e.dataTransfer!.files];
  const rect = wave.getBoundingClientRect();
  const onWave =
    visible && tl?.length && e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
  let at = onWave ? locate(e.clientX - rect.left, e.clientY - rect.top) : undefined;
  if (!visible) location.hash = "wave";
  // Several files go one after another.
  for (const f of files) {
    const clip = await importFile(f, at);
    if (clip) at = { t: clipEnd(clip) / sr, lane: clip.lane };
  }
});

const gridSel = $<HTMLSelectElement>("ed-grid");
const bpmIn = $<HTMLInputElement>("ed-bpm");
gridSel.value = settings.grid;
bpmIn.value = String(settings.bpm);
gridSel.addEventListener("change", () => {
  settings.grid = gridSel.value as GridDiv;
  saveSettings();
});
bpmIn.addEventListener("change", () => {
  const v = Number(bpmIn.value);
  if (v >= 30 && v <= 300) settings.bpm = v;
  bpmIn.value = String(settings.bpm);
  saveSettings();
});

const KEYS: Record<string, () => void> = {
  Space: spaceAction,
  Home: toStart,
  End: toEnd,
  KeyR: () => setRecording(!recording),
  KeyS: splitAtMarker,
  Delete: deleteClip,
  Backspace: deleteClip,
  Escape: () => {
    selection = null;
    selClip = null;
    renderEditState();
  },
};
window.addEventListener("keydown", (e) => {
  if (!visible) return;
  const t = e.target as HTMLElement;
  if (t.closest("input, select, textarea, [contenteditable]")) return;
  if ((e.metaKey || e.ctrlKey) && e.code === "KeyZ" && !e.shiftKey) {
    e.preventDefault();
    undo();
    return;
  }
  const act = KEYS[e.code];
  if (!act || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
  e.preventDefault();
  // Space on a focused button would also click it.
  if (t instanceof HTMLButtonElement) t.blur();
  act();
});
$("wv-all").addEventListener("click", showAll);
$("vw-all").addEventListener("click", showAll);
$("vw-live").addEventListener("click", () => {
  follow = true;
  clampView();
});
const zoomBy = (k: number) => {
  const mid = viewStart + viewSpan / 2;
  follow = false;
  viewSpan *= k;
  viewStart = mid - viewSpan / 2;
  clampView();
};
$("vw-zin").addEventListener("click", () => zoomBy(0.5));
$("vw-zout").addEventListener("click", () => zoomBy(2));
$("vw-gain").addEventListener("click", () => {
  gain = 1;
  settings.autoGain = false;
  saveSettings();
  renderViewMenu();
});
$("vw-auto").addEventListener("click", () => {
  settings.autoGain = !settings.autoGain;
  if (!settings.autoGain) gain = 1;
  saveSettings();
  renderViewMenu();
});
function toggleView(v: "wave" | "pitch") {
  const key = v === "wave" ? "showWave" : "showPitch";
  settings[key] = !settings[key];
  // Something must stay on screen: turning off the only view switches to the other one.
  if (!settings.showWave && !settings.showPitch) settings[v === "wave" ? "showPitch" : "showWave"] = true;
  saveSettings();
  renderViewMenu();
}
for (const el of document.querySelectorAll<HTMLElement>("[data-view]"))
  el.addEventListener("click", () => toggleView(el.dataset.view as "wave" | "pitch"));
function renderViewMenu() {
  for (const el of document.querySelectorAll<HTMLElement>("[data-view]"))
    el.setAttribute("aria-checked", String(el.dataset.view === "wave" ? settings.showWave : settings.showPitch));
  $("vw-auto").setAttribute("aria-checked", String(settings.autoGain));
}
renderViewMenu();

/** Warns when the input has stayed very quiet for 3 s: a gain knob at zero or the wrong input. */
function renderWeak() {
  const el = $("wv-weak");
  if (!node || performance.now() - inputSince < 3000 || !recentPeaks.length) {
    el.hidden = true;
    return;
  }
  const pk = Math.max(...recentPeaks.map((p) => p[1]));
  el.hidden = pk > -40;
  if (!el.hidden)
    el.textContent = `Сигнал очень слабый: пик ${pk < -100 ? "−∞" : Math.round(pk)} дБ. Поднимите Gain на звуковой карте (вход INST для гитары) или «Усиление входа» здесь; проверьте «Канал».`;
}

const inGain = $<HTMLInputElement>("wv-ingain");
let shownGain = "";
/** Keeps the input-gain slider in step with auto-level. */
function showInGain() {
  const text = `${settings.autoInGain ? "авто " : ""}+${Math.round(settings.inGainDb)} дБ`;
  if (text === shownGain) return;
  shownGain = text;
  $("wv-ingain-v").textContent = text;
  inGain.value = String(Math.round(settings.inGainDb));
  inGain.title = settings.autoInGain ? "Автоусиление только убавляет его, если игра громче целевого пика" : "";
}
showInGain();
inGain.addEventListener("input", () => {
  setInGain(Number(inGain.value));
  saveSettings();
  showInGain();
});
$("wv-ingain-reset").addEventListener("click", () => {
  setInGain(0);
  saveSettings();
  showInGain();
  if (dlg.open) fillSettings();
});

// ---------- settings dialog ----------

const dlg = $<HTMLDialogElement>("settings");
interface Field {
  id: string;
  get: () => string | boolean;
  set: (v: string | boolean) => void;
  fmt?: (v: string) => string;
}
const FIELDS: Field[] = [
  { id: "st-autoin", get: () => settings.autoInGain, set: (v) => (settings.autoInGain = v as boolean) },
  { id: "st-target", get: () => String(settings.targetDb), set: (v) => (settings.targetDb = Number(v)), fmt: (v) => `${v} дБ` },
  { id: "st-ingain", get: () => String(Math.round(settings.inGainDb)), set: (v) => setInGain(Number(v)), fmt: (v) => `+${v} дБ` },
  { id: "st-gate", get: () => settings.gateOn, set: (v) => (settings.gateOn = v as boolean) },
  { id: "st-gatemargin", get: () => String(settings.gateMarginDb), set: (v) => (settings.gateMarginDb = Number(v)), fmt: (v) => `+${v} дБ` },
  { id: "st-autoheight", get: () => settings.autoGain, set: (v) => ((settings.autoGain = v as boolean), v || (gain = 1)) },
  { id: "st-mon", get: () => settings.monOn, set: (v) => (settings.monOn = v as boolean) },
  { id: "st-bpm", get: () => String(settings.bpm), set: (v) => (settings.bpm = Math.min(300, Math.max(30, Number(v) || 120))) },
  { id: "st-grid", get: () => settings.grid, set: (v) => (settings.grid = v as GridDiv) },
  { id: "st-pmlim", get: () => String(settings.pmLimMs), set: (v) => (settings.pmLimMs = Number(v)), fmt: (v) => `${v} мс` },
  { id: "st-attlim", get: () => String(settings.attLimMs), set: (v) => (settings.attLimMs = Number(v)), fmt: (v) => `${v} мс` },
];

function fillSettings() {
  for (const f of FIELDS) {
    const el = $<HTMLInputElement>(f.id);
    const v = f.get();
    if (el.type === "checkbox") el.checked = v as boolean;
    else el.value = v as string;
    if (f.fmt) $(`${f.id}-v`).textContent = f.fmt(el.value);
  }
  $<HTMLInputElement>("st-target").disabled = !settings.autoInGain;
  $<HTMLInputElement>("st-gatemargin").disabled = !settings.gateOn;
  node?.port.postMessage({ gate: settings.gateOn, gateMarginDb: settings.gateMarginDb });
  showNoise();
}

for (const f of FIELDS) {
  const el = $<HTMLInputElement>(f.id);
  el.addEventListener(el.type === "range" ? "input" : "change", () => {
    f.set(el.type === "checkbox" ? el.checked : el.value);
    saveSettings();
    // Keep the other copies of these controls in step.
    fillSettings();
    showInGain();
    renderViewMenu();
    gridSel.value = settings.grid;
    bpmIn.value = String(settings.bpm);
    applyExercise();
  });
}
$("st-open").addEventListener("click", () => {
  fillSettings();
  dlg.showModal();
});
$("st-close").addEventListener("click", () => dlg.close());
$("ed-desel").addEventListener("click", KEYS.Escape);
$("wv-live").addEventListener("click", () => {
  follow = true;
  clampView();
});
const chanSel = $<HTMLSelectElement>("wv-chan");
chanSel.value = String(settings.channel);
chanSel.addEventListener("change", () => {
  settings.channel = chanSel.value === "auto" ? "auto" : (Number(chanSel.value) as 0 | 1);
  saveSettings();
  node?.port.postMessage({ mode: settings.channel });
});
$("wv-device").addEventListener("change", (e) => {
  settings.deviceId = (e.target as HTMLSelectElement).value;
  saveSettings();
  if (source) void openInput();
});
renderEditState();

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
      node?.connect(monitor.input);
      routeTap(monitor.wet);
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

/** Brings up the amp chain and turns it on, if the switch is still on by then. */
async function startMonitor() {
  const box = $<HTMLInputElement>("mo-on");
  box.disabled = true;
  const m = await ensureMonitor();
  box.disabled = false;
  // Recording waits for the effect chain; if it failed, it records the plain input.
  if (node) $<HTMLButtonElement>("wv-rec").disabled = false;
  if (!m) {
    box.checked = false;
    return;
  }
  m.setEnabled(box.checked);
  $("mo-lat").textContent = box.checked ? `задержка ≈ ${m.latencyMs()} мс` : "";
}

$<HTMLInputElement>("mo-on").addEventListener("change", (e) => {
  const box = e.target as HTMLInputElement;
  settings.monOn = box.checked;
  saveSettings();
  if (!box.checked) {
    monitor?.setEnabled(false);
    $("mo-lat").textContent = "";
    return;
  }
  void startMonitor();
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

// Browsers restore checkbox state on reload; the saved setting wins. Sound starts once the input is on.
$<HTMLInputElement>("mo-on").checked = settings.monOn;
renderMonitorControls();

// ---------- palm mute exercise ----------

let pmKey = "";
/** The take the exercise panel reports on: the one being recorded, the selected one, or the latest. */
const focusTake = (): Take | null => rec?.take ?? selClip?.take ?? tl?.takes.at(-1) ?? null;
const pmLimit = () => settings.pmLimMs / 1000;
const attLimit = () => settings.attLimMs / 1000;
/** A palm-muted note may sit this far from the open string and still count as the same note. */
const PITCH_TOL = 10;
/** Farther than this from the nearest note of A4 = 440 Hz tuning, the note is out of tune. */
const TUNE_TOL = 10;

const fmtSec = (t: number) => (t < 1 ? `${Math.round(t * 1000)} мс` : `${t.toFixed(2).replace(".", ",")} с`);
const fmtT20 = (n: PmNote) => (n.t20 === null ? "…" : `${n.t20Measured ? "" : "≈"}${fmtSec(n.t20)}`);
const fmtAtt = (a: number | null) => (a === null ? "—" : `${(a * 1000).toFixed(a < 0.01 ? 1 : 0).replace(".", ",")} мс`);
const fmtCents = (c: number) => {
  const r = Math.round(c);
  return `${r >= 0 ? "+" : "−"}${Math.abs(r)} ц`;
};
/** Nearest note and its deviation from equal temperament (A4 = 440 Hz), or "?" without a clear pitch. */
const fmtNote = (n: PmNote) => {
  if (n.f0 === null) return n.pitchClarity === null ? "…" : "?";
  const { name, cents } = noteOf(n.f0);
  return `${name} ${fmtCents(cents)}`;
};
const median = (a: number[]) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Both palm-mute exercises; "pmopen" also checks the muted note keeps the open string's pitch. */
const pmEx = () => settings.exercise === "pm" || settings.exercise === "pmopen";
const pitchEx = () => settings.exercise === "pmopen";
const pitchChecks = (notes: PmNote[]) => (pitchEx() ? checkPitches(notes, pmLimit()) : new Map<PmNote, PitchCheck>());

type PmState = "wait" | "pm" | "open" | "nopitch" | "offpitch";
interface PmVerdict {
  state: PmState;
  pitch: PitchCheck | null;
  /** Problems with the pick attack, independent of the mute. */
  slowAttack: boolean;
  double: boolean;
  /** Cents off the nearest note of standard tuning, when beyond TUNE_TOL. */
  detune: number | null;
}

function judgePm(n: PmNote, checks: Map<PmNote, PitchCheck>): PmVerdict {
  const muted = isPalmMuted(n, pmLimit());
  const pitch = checks.get(n) ?? null;
  const slowAttack = n.attack !== null && n.attack > attLimit();
  const double = n.doubleGap !== null;
  const cents = n.f0 === null ? null : noteOf(n.f0).cents;
  const detune = cents !== null && Math.abs(cents) > TUNE_TOL ? cents : null;
  const v = (state: PmState): PmVerdict => ({ state, pitch, slowAttack, double, detune });
  if (muted === null) return v("wait");
  if (!muted) return v("open");
  // The pitch is measured 15–60 ms after the attack; until then the note is still pending.
  if (!pitchEx()) return v("pm");
  if (n.bright === null && n.pitchClarity === null) return v("wait");
  if (!pitch) return v("nopitch");
  return v(Math.abs(pitch.cents) <= PITCH_TOL ? "pm" : "offpitch");
}

const attackIssues = (n: PmNote, v: PmVerdict) => {
  const out: string[] = [];
  if (v.double) out.push(`Двойная атака: медиатор ударил по струне дважды с разницей ${Math.round(n.doubleGap! * 1000)} мс. Бейте одним уверенным движением, не цепляйте струну.`);
  if (v.slowAttack) out.push(`Атака ${fmtAtt(n.attack)} — дольше ${settings.attLimMs} мс: медиатор задерживается на струне. Меньше погружайте медиатор и не дожимайте струну перед ударом.`);
  if (v.detune !== null)
    out.push(`Нота ${fmtNote(n)} — дальше ${TUNE_TOL} центов от строя: подстройте струну, а если открытая струна строит — не давите на неё ладонью.`);
  return out;
};
const cleanAttack = (v: PmVerdict) => !v.double && !v.slowAttack;
/** No problem of any kind besides the mute itself. */
const clean = (v: PmVerdict) => cleanAttack(v) && v.detune === null;

const STATE_TITLE: Record<PmState, string> = {
  wait: "Измеряю…",
  pm: "Palm mute, нота та же",
  open: "Открытая нота — нет приглушения",
  nopitch: "Palm mute без высоты",
  offpitch: "Palm mute, но нота другая",
};
const STATE_SHORT: Record<PmState, string> = { wait: "…", pm: "PM", open: "откр.", nopitch: "PM без высоты", offpitch: "PM, другая нота" };
const STATE_HINT: Partial<Record<PmState, string>> = {
  nopitch: "Слышен только стук: ладонь слишком далеко от подставки или давит слишком сильно. Сдвиньте её к подставке.",
  offpitch: "Высота сбилась: ладонь давит на струну и меняет её натяжение или касается не там. Ослабьте нажим, держите ребро ладони у самой подставки.",
  open: "Нота звенит: ладонь не касается струн. Положите ребро ладони на струны у подставки.",
};
const stateClass = (s: PmState) => (s === "pm" ? "pm" : s === "open" ? "open" : s === "wait" ? "" : "warn");

function drawPmMarks(
  g: CanvasRenderingContext2D,
  W: number,
  y0: number,
  h: number,
  dpr: number,
  xOf: (t: number) => number,
  clip: Clip,
  checks: Map<PmNote, PitchCheck>,
) {
  const top = y0 + (h > 46 * dpr ? 16 * dpr : 2 * dpr);
  const bottom = y0 + h - 2 * dpr;
  g.font = `600 ${11 * dpr}px "IBM Plex Mono", ui-monospace, monospace`;
  g.textBaseline = "top";
  g.save();
  g.beginPath();
  g.rect(Math.max(0, xOf(clip.pos / sr)), y0, Math.min(W, xOf(clipEnd(clip) / sr)) - Math.max(0, xOf(clip.pos / sr)), h);
  g.clip();
  for (const n of clip.take.pm.notes) {
    if (n.start < clip.from || n.start >= clip.to) continue;
    const t = (clip.pos + n.start - clip.from) / sr;
    if (t > viewStart + viewSpan) break;
    const x = xOf(t);
    const v = judgePm(n, checks);
    const c =
      v.state === "wait" ? col.text : v.state === "open" ? col.clip : v.state === "pm" && clean(v) ? col.play : col.warn;
    const x20 = n.t20 === null ? null : xOf(t + n.t20);
    if (x20 !== null && x20 < 0) continue;
    if (n.touchAt !== null && n.soundAt !== null && n.soundAt > n.touchAt) {
      // Attack: from the pick touching the string (dashed line) to the note sounding.
      const xa = xOf((clip.pos + n.touchAt - clip.from) / sr), xs = xOf((clip.pos + n.soundAt - clip.from) / sr);
      const ac = v.slowAttack ? col.warn : c;
      g.fillStyle = ac;
      g.globalAlpha = 0.16;
      g.fillRect(xa, top, Math.max(dpr, xs - xa), bottom - top);
      g.globalAlpha = 0.9;
      g.strokeStyle = ac;
      g.lineWidth = dpr;
      g.setLineDash([3 * dpr, 3 * dpr]);
      g.beginPath();
      g.moveTo(Math.round(xa) + 0.5 * dpr, top);
      g.lineTo(Math.round(xa) + 0.5 * dpr, bottom);
      g.stroke();
      g.setLineDash([]);
      g.fillRect(Math.round(xs), bottom - 12 * dpr, dpr, 12 * dpr);
      g.globalAlpha = 1;
      const al = `${Math.round(n.attack! * 1000)} мс`;
      const aw = g.measureText(al).width;
      if (xs - xa > aw + 8 * dpr) {
        g.fillStyle = ac;
        g.fillText(al, (xa + xs - aw) / 2, bottom - 14 * dpr);
      }
    }
    g.fillStyle = c;
    g.fillRect(Math.round(x), top, 2 * dpr, bottom - top);
    if (x20 !== null) {
      // Bracket from the attack to the −20 dB point.
      const y = top + 20 * dpr;
      g.globalAlpha = 0.35;
      g.fillRect(x, y, Math.max(dpr, x20 - x), 3 * dpr);
      g.globalAlpha = 1;
      g.fillRect(Math.round(x20), y - 4 * dpr, dpr, 11 * dpr);
    }
    let label = `${STATE_SHORT[v.state]} ${fmtNote(n)}${v.detune !== null && v.state !== "wait" ? "!" : ""} ${fmtT20(n)}`;
    if (v.pitch && v.state !== "wait") label += ` стр.${fmtCents(v.pitch.cents)}`;
    if (v.double) label += " ×2";
    if (n.attack !== null) label += ` ат.${Math.round(n.attack * 1000)}${v.slowAttack ? "!" : ""}`;
    const tw = g.measureText(label).width;
    if (x + 4 * dpr + tw > 0 && x < W) {
      g.fillStyle = col.stage;
      g.fillRect(x + 3 * dpr, top + 2 * dpr, tw + 6 * dpr, 15 * dpr);
      g.fillStyle = c;
      g.fillText(label, x + 6 * dpr, top + 4 * dpr);
    }
  }
  g.restore();
  g.textBaseline = "middle";
}

function renderPm() {
  const take = focusTake();
  pmKey = take ? `${take.id}:${take.pm.version}` : "";
  const notes = take?.pm.notes ?? [];
  const checks = pitchChecks(notes);
  const last = notes.at(-1);
  const box = $("pm-verdict");
  const v = last ? judgePm(last, checks) : null;
  const allGood = !!v && v.state === "pm" && clean(v);
  box.dataset.state = !v || v.state === "wait" ? "none" : allGood ? "pm" : v.state === "open" ? "open" : "warn";
  $("pm-badge").textContent = !v ? "—" : v.state === "wait" ? "…" : allGood ? "PM" : v.state === "open" ? "✕" : "!";
  let title = !v
    ? recording ? "Сыграйте ноту" : `Нажмите ● и сыграйте ${pitchEx() ? "открытую струну" : "ноту"}`
    : v.state === "pm" && !pitchEx() ? "Palm mute" : STATE_TITLE[v.state];
  if (v && v.state !== "wait") {
    const extra = [v.double ? "двойная атака" : "", v.slowAttack ? "долгая атака" : "", v.detune !== null ? "нота не строит" : ""].filter(Boolean);
    if (extra.length) title += ` · ${extra.join(", ")}`;
  }
  $("pm-v-title").textContent = title;
  const parts: string[] = [];
  if (last && v) {
    parts.push(`нота ${fmtNote(last)}`);
    if (v.pitch) parts.push(`от струны ${v.pitch.name} ${fmtCents(v.pitch.cents)}${v.pitch.measuredRef ? "" : " (от строя)"}`);
    parts.push(`затухание ${fmtT20(last)}`);
    if (last.rate !== null) parts.push(`${Math.round(last.rate)} дБ/с`);
    parts.push(`атака ${fmtAtt(last.attack)}`);
    if (last.bright !== null) parts.push(`глухость ${Math.round((1 - last.bright) * 100)}%`);
  }
  $("pm-v-sub").textContent = parts.join(" · ");
  $("pm-v-hint").textContent = v && last ? [STATE_HINT[v.state] ?? "", ...attackIssues(last, v)].filter(Boolean).join(" ") : "";

  const judged = notes.map((n) => [n, judgePm(n, checks)] as const);
  const rated = judged.filter(([, j]) => j.state !== "wait");
  const muted = rated.filter(([, j]) => j.state !== "open");
  const good = rated.filter(([, j]) => j.state === "pm");
  $("pm-count").textContent = String(notes.length);
  $("pm-share").textContent = rated.length ? `${Math.round((muted.length / rated.length) * 100)}%` : "—";
  $("pm-pitch").textContent = muted.length ? `${Math.round((good.length / muted.length) * 100)}%` : "—";
  const mp = median(muted.map(([n]) => n.t20!));
  const mo = median(rated.filter(([, j]) => j.state === "open").map(([n]) => n.t20!));
  $("pm-t-pm").textContent = mp === null ? "—" : fmtSec(mp);
  $("pm-t-open").textContent = mo === null ? "—" : fmtSec(mo);
  $("pm-att").textContent = fmtAtt(median(notes.flatMap((n) => (n.attack === null ? [] : [n.attack]))));
  const attRated = rated.filter(([n]) => n.attack !== null || n.doubleChecked);
  $("pm-att-ok").textContent = attRated.length
    ? `${Math.round((attRated.filter(([, j]) => cleanAttack(j)).length / attRated.length) * 100)}%`
    : "—";
  $("pm-doubles").textContent = String(rated.filter(([, j]) => j.double).length);

  const list = $("pm-list");
  list.replaceChildren(
    ...judged
      .slice(-60)
      .reverse()
      .map(([n, j]) => {
        const b = document.createElement("button");
        b.className = `pm-note ${j.state === "pm" && !clean(j) ? "warn" : stateClass(j.state)}`;
        // Where this note sits on the timeline: the first clip of the take that contains it.
        const clip = tl?.clips.find((c) => c.take === take && n.start >= c.from && n.start < c.to);
        const t = clip ? (clip.pos + n.start - clip.from) / sr : n.start / sr;
        const m = Math.floor(t / 60);
        const pitch =
          fmtNote(n) + (pitchEx() && j.pitch ? ` (от ${j.pitch.name.split(" ")[0]} ${fmtCents(j.pitch.cents)})` : "") + " · ";
        b.innerHTML =
          `<b>${j.state === "wait" ? "…" : STATE_SHORT[j.state] === "PM" ? "Palm mute" : STATE_SHORT[j.state] === "откр." ? "Открытая" : STATE_SHORT[j.state]}</b>` +
          `<span>${m}:${(t - m * 60).toFixed(2).padStart(5, "0")} · ${fmtT20(n)}</span>` +
          `<span>${pitch}атака ${fmtAtt(n.attack)}${j.slowAttack ? " !" : ""}</span>` +
          (j.double ? `<span class="pm-bad">двойная атака, ${Math.round(n.doubleGap! * 1000)} мс</span>` : "") +
          (j.detune !== null && j.state !== "wait" ? `<span class="pm-bad">не строит, ${fmtCents(j.detune)}</span>` : "");
        b.disabled = !clip;
        b.addEventListener("click", () => {
          follow = false;
          viewSpan = Math.max(Math.min(viewSpan, 2), (n.t20 ?? 0.5) * 3);
          viewStart = t - viewSpan * 0.2;
          clampView();
          setMarker(t);
        });
        return b;
      }),
  );
}

function applyExercise() {
  const isPm = pmEx();
  $("pm-pitch-tile").hidden = !pitchEx();
  $("pm-title").textContent = pitchEx() ? "Упражнение: palm mute открытых струн" : "Упражнение: palm mute";
  $("pm-sub").textContent = pitchEx()
    ? "открытые струны с ребром ладони у подставки: нота глухая, но той же высоты, что и без приглушения"
    : "ребро ладони на струнах у подставки, нота короткая и глухая";
  for (const el of document.querySelectorAll<HTMLElement>("[data-ex]"))
    el.setAttribute("aria-checked", String(el.dataset.ex === settings.exercise));
  $("pm-card").hidden = !isPm;
  $("wl-card").hidden = !lgEx();
  $<HTMLSelectElement>("wl-strict").value = settings.lgStrict;
  wlKey = "";
  $<HTMLInputElement>("pm-lim").value = String(settings.pmLimMs);
  $("pm-lim-v").textContent = `${fmtSec(pmLimit())} (5–6 струны — ${fmtSec(pmLimit() * LOW_LIMIT_K)})`;
  $<HTMLInputElement>("pm-att-lim").value = String(settings.attLimMs);
  $("pm-att-lim-v").textContent = `${settings.attLimMs} мс`;
  pmKey = "";
  if (isPm) renderPm();
}

// ---------- note pitch view and legato exercise ----------

const pitchView = () => settings.showPitch;
/** With both views on, the wave takes this share of a lane, above the pitch. */
const WAVE_SHARE = 0.42;
const waveH = (laneH: number) => (!settings.showWave ? 0 : pitchView() ? Math.round(laneH * WAVE_SHARE) : laneH);
const lgEx = () => settings.exercise === "legato";
let wlKey = "";
/** MIDI range of the pitch view; follows the notes on screen. */
let pLo = 45, pHi = 59;
const P_MIN_SPAN = 8;

/** First index in sorted `a` at or after `v`. */
function lowerBound(a: number[], v: number) {
  let lo = 0, hi = a.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (a[m] < v) lo = m + 1;
    else hi = m;
  }
  return lo;
}

const clipNotes = (c: Clip, all: Note[]) => all.filter((n) => n.end * sr > c.from && n.start * sr < c.to);

/** Fits the pitch range to the notes on screen, gliding so it does not jump. */
function fitPitch() {
  let lo = Infinity, hi = -Infinity;
  for (const c of tl!.clips) {
    const t0 = viewStart - (c.pos - c.from) / sr, t1 = t0 + viewSpan;
    const lg = c.take.lg;
    for (const n of clipNotes(c, lg.current ? [...lg.notes, lg.current] : lg.notes))
      if (n.end >= t0 && n.start <= t1) {
        lo = Math.min(lo, n.midi);
        hi = Math.max(hi, n.midi);
      }
  }
  if (hi < lo) return;
  const extra = Math.max(0, P_MIN_SPAN - (hi - lo + 2)) / 2;
  pLo += (lo - 1 - extra - pLo) * 0.2;
  pHi += (hi + 1 + extra - pHi) * 0.2;
}

/** As in the legato tab: green for a clean note, red for a faulty one, amber while it sounds. */
const lgColor = (n: Note) => (n.eval ? (n.eval.clean ? col.good : col.clip) : col.wave);

function drawPitch(g: CanvasRenderingContext2D, W: number, y0: number, h: number, dpr: number, xOf: (t: number) => number, c: Clip) {
  const top = y0 + Math.max(waveH(h), h > 46 * dpr ? 16 * dpr : 2 * dpr);
  const bottom = y0 + h - 2 * dpr;
  const shift = (c.pos - c.from) / sr;
  const x0 = Math.max(0, xOf(c.pos / sr)), x1 = Math.min(W, xOf(clipEnd(c) / sr));
  if (x1 <= x0) return;
  const Y = (m: number) => bottom - ((m - pLo) / (pHi - pLo)) * (bottom - top);
  const rowH = (bottom - top) / (pHi - pLo);
  g.save();
  g.beginPath();
  g.rect(x0, top, x1 - x0, bottom - top);
  g.clip();
  if (settings.showWave) {
    g.fillStyle = col.axis;
    g.fillRect(x0, top, x1 - x0, dpr);
  }
  g.font = `${10 * dpr}px "IBM Plex Mono", ui-monospace, monospace`;
  g.textBaseline = "middle";
  for (let m = Math.ceil(pLo); m <= pHi; m++) {
    const natural = ![1, 3, 6, 8, 10].includes(((m % 12) + 12) % 12);
    g.fillStyle = natural ? col.axis : col.grid;
    g.globalAlpha = 0.5;
    g.fillRect(x0, Math.round(Y(m)), x1 - x0, dpr);
    g.globalAlpha = 1;
    if (rowH >= 11 * dpr || m % 12 === 0) {
      g.fillStyle = col.text;
      g.fillText(noteName(m), x0 + 4 * dpr, Y(m));
    }
  }

  // Every voiced frame, faintly: what was heard but made no note.
  const lg = c.take.lg;
  const a = lowerBound(lg.frameT, Math.max(c.from / sr, viewStart - shift));
  const tEnd = Math.min(c.to / sr, viewStart + viewSpan - shift);
  g.fillStyle = col.text;
  g.globalAlpha = 0.35;
  for (let i = a; i < lg.frameT.length && lg.frameT[i] < tEnd; i++)
    g.fillRect(xOf(lg.frameT[i] + shift) - dpr, Y(lg.frameM[i]) - dpr, 2 * dpr, 2 * dpr);
  g.globalAlpha = 1;

  const L = LIMITS[settings.lgStrict];
  for (const n of clipNotes(c, lg.current ? [...lg.notes, lg.current] : lg.notes)) {
    const nx0 = xOf(n.start + shift), nx1 = xOf(n.end + shift);
    if (nx1 < 0 || nx0 > W) continue;
    const color = lgColor(n);
    const ev = n.eval;
    // The note's own row, tinted, so right and wrong are told apart at a glance.
    g.fillStyle = color;
    g.globalAlpha = 0.16;
    g.fillRect(nx0, Y(n.midi + 0.45), Math.max(dpr, nx1 - nx0), Y(n.midi - 0.45) - Y(n.midi + 0.45));
    g.globalAlpha = 1;
    if (ev) {
      // The judged part, as wide as the pitch may wander.
      const mid = n.midi + ev.center / 100, half = L.spread / 200;
      g.fillStyle = color;
      g.globalAlpha = 0.28;
      g.fillRect(xOf(ev.from + shift), Y(mid + half), xOf(ev.to + shift) - xOf(ev.from + shift), Y(mid - half) - Y(mid + half));
      g.globalAlpha = 1;
    }
    g.fillStyle = color;
    g.globalAlpha = 0.6;
    g.fillRect(Math.round(nx0), Y(n.midi + 0.4), dpr, Y(n.midi - 0.4) - Y(n.midi + 0.4));
    g.globalAlpha = 1;
    g.strokeStyle = color;
    g.lineWidth = 2 * dpr;
    g.beginPath();
    n.points.forEach((p, i) => {
      const x = xOf(p.t + shift), y = Y(n.midi + p.cents / 100);
      if (i) g.lineTo(x, y);
      else g.moveTo(x, y);
    });
    g.stroke();
    const name = noteName(n.midi);
    const full = ev ? `${name} ${fmtCents(ev.center)}${ev.clean ? "" : ` ${ev.issues.map((i) => ISSUE_LABEL[i.kind]).join(", ")}`}` : name;
    const label = [full, name].find((s) => g.measureText(s).width + 6 * dpr < Math.max(nx1 - nx0, 24 * dpr));
    if (label) {
      const peak = Math.max(...n.points.map((p) => p.cents));
      const ly = Math.max(top + 7 * dpr, Y(n.midi + Math.max(peak, 0) / 100) - 10 * dpr);
      g.fillStyle = col.stage;
      g.globalAlpha = 0.8;
      g.fillRect(nx0 + 2 * dpr, ly - 7 * dpr, g.measureText(label).width + 4 * dpr, 14 * dpr);
      g.globalAlpha = 1;
      g.fillStyle = color;
      g.fillText(label, nx0 + 4 * dpr, ly);
    }
  }
  g.restore();
}

/** The note shown in detail: the one under the marker, or the latest. */
function wlNote(take: Take | null): Note | null {
  if (!take || !tl) return null;
  if (marker !== null && !recording) {
    const s = marker * sr;
    for (const c of tl.clips)
      if (c.take === take && s >= c.pos && s < clipEnd(c)) {
        const t = (s - c.pos + c.from) / sr;
        const n = take.lg.notes.find((n) => t >= n.start && t <= n.end);
        if (n) return n;
      }
  }
  return take.lg.notes.at(-1) ?? null;
}

const wlKeyOf = (take: Take | null) =>
  take ? `${take.id}:${take.lg.version}:${wlNote(take)?.id ?? ""}:${settings.lgStrict}:${tl!.clips.map((c) => `${c.id}.${c.pos}.${c.from}.${c.to}`).join()}` : "-";

function renderWl() {
  const take = focusTake();
  wlKey = wlKeyOf(take);
  const notes = take?.lg.notes ?? [];
  const n = wlNote(take);
  const ev = n?.eval ?? null;
  $("wl-verdict").dataset.state = !ev ? "none" : ev.clean ? "pm" : "open";
  $("wl-badge").textContent = !n ? "—" : noteName(n.midi);
  $("wl-v-title").textContent = !n || !ev
    ? recording ? "Сыграйте ноту" : "Нажмите ● и сыграйте легато"
    : ev.clean ? "Чистая нота" : ev.issues.map((i) => ISSUE_LABEL[i.kind]).join(", ");
  const s = (v: number) => `${v > 0 ? "+" : ""}${Math.round(v)}`;
  $("wl-v-sub").textContent = n && ev
    ? `${n.attack === "pick" ? "медиатор" : "легато"} · ${Math.round((n.end - n.start) * 1000)} мс · центр ${s(ev.center)} ц · вилянье ±${Math.round(ev.spread / 2)} ц · начало ${s(ev.overshoot)} ц · уплыв ${s(ev.drift)} ц`
    : "";
  $("wl-v-hint").textContent = ev ? ev.issues.map((i) => i.text).join(" ") : "";

  const sum = summarize(notes);
  const pct = (a: Note[]) => (a.length ? `${Math.round((a.filter((n) => n.eval?.clean).length / a.length) * 100)}%` : "—");
  const leg = notes.filter((n) => n.attack === "legato");
  $("wl-count").textContent = String(sum.count);
  $("wl-clean").textContent = pct(notes);
  $("wl-leg").textContent = String(leg.length);
  $("wl-leg-clean").textContent = pct(leg);
  $("wl-gap").textContent = sum.legatoGapDb === null ? "—" : `${s(sum.legatoGapDb)} дБ`;
  const worst = (Object.entries(sum.issues) as [IssueKind, number][]).sort((a, b) => b[1] - a[1])[0];
  $("wl-top").textContent = worst ? `${ISSUE_LABEL[worst[0]]} ×${worst[1]}` : "—";

  $("wl-list").replaceChildren(
    ...notes
      .slice(-60)
      .reverse()
      .map((q) => {
        const b = document.createElement("button");
        b.className = `pm-note ${q.eval?.clean ? "pm" : "open"}`;
        const clip = tl?.clips.find((c) => c.take === take && q.start * sr < c.to && q.end * sr > c.from);
        const at = Math.max(q.start, clip ? clip.from / sr : 0);
        const t = clip ? (clip.pos - clip.from) / sr + at : q.start;
        const m = Math.floor(t / 60);
        const line = (tag: string, text: string) => {
          const el = document.createElement(tag);
          el.textContent = text;
          b.append(el);
          return el;
        };
        line("b", `${noteName(q.midi)} ${fmtCents(q.eval!.center)}`);
        line("span", `${m}:${(t - m * 60).toFixed(2).padStart(5, "0")} · ${q.attack === "pick" ? "медиатор" : "легато"}`);
        line("span", `вилянье ±${Math.round(q.eval!.spread / 2)} ц`);
        if (!q.eval!.clean) line("span", q.eval!.issues.map((i) => ISSUE_LABEL[i.kind]).join(", ")).className = "pm-bad";
        b.disabled = !clip;
        b.addEventListener("click", () => {
          follow = false;
          viewSpan = Math.max(Math.min(viewSpan, 2), (q.end - q.start) * 3);
          viewStart = t - viewSpan * 0.2;
          clampView();
          // Just inside the note, so it is the one shown in detail.
          setMarker(t + Math.min(0.01, (q.end - at) / 2));
        });
        return b;
      }),
  );
}

/** The note's pitch in cents, magnified. */
function drawWlDetail() {
  const { g, W, H, dpr } = fit($<HTMLCanvasElement>("wl-detail"));
  g.fillStyle = col.stage;
  g.fillRect(0, 0, W, H);
  const range = 50, left = 34 * dpr;
  const Y = (c: number) => H / 2 - (Math.max(-range, Math.min(range, c)) / range) * (H / 2 - 10 * dpr);
  g.font = `${11 * dpr}px "IBM Plex Mono", ui-monospace, monospace`;
  g.textBaseline = "middle";
  for (const c of [-50, -25, 0, 25, 50]) {
    g.fillStyle = col.grid;
    g.fillRect(left, Math.round(Y(c)), W - left, dpr);
    g.fillStyle = col.text;
    g.fillText(`${c > 0 ? "+" : ""}${c}`, 2 * dpr, Y(c));
  }
  const n = wlNote(focusTake());
  if (!n?.eval) return;
  const ev = n.eval, half = LIMITS[settings.lgStrict].spread / 2;
  const X = (t: number) => left + ((t - n.start) / Math.max(0.05, n.end - n.start)) * (W - left - 4 * dpr);
  g.fillStyle = col.good;
  g.globalAlpha = 0.14;
  g.fillRect(X(ev.from), Y(ev.center + half), X(ev.to) - X(ev.from), Y(ev.center - half) - Y(ev.center + half));
  // Attack and release: not judged.
  g.fillStyle = col.text;
  g.globalAlpha = 0.12;
  g.fillRect(left, 0, X(ev.from) - left, H);
  g.fillRect(X(ev.to), 0, W - X(ev.to), H);
  g.globalAlpha = 1;
  g.strokeStyle = lgColor(n);
  g.lineWidth = 2 * dpr;
  g.beginPath();
  n.points.forEach((p, i) => (i ? g.lineTo(X(p.t), Y(p.cents)) : g.moveTo(X(p.t), Y(p.cents))));
  g.stroke();
}

$<HTMLSelectElement>("wl-strict").addEventListener("change", (e) => {
  settings.lgStrict = (e.target as HTMLSelectElement).value as Strictness;
  saveSettings();
});

/** Palm mute is practised on a driven tone: the distortion pedal goes on at full drive. */
function pmTone() {
  settings.mon.dist = true;
  settings.mon.distType = "dist";
  settings.mon.drive = 1;
  monitorChanged();
}

function setExercise(ex: Settings["exercise"]) {
  settings.exercise = ex;
  // Each exercise marks its notes in a view of its own: make sure it is on.
  if (lgEx()) settings.showPitch = true;
  if (pmEx()) settings.showWave = true;
  if (pmEx()) pmTone();
  renderViewMenu();
  saveSettings();
  applyExercise();
}
for (const el of document.querySelectorAll<HTMLElement>("[data-ex]"))
  el.addEventListener("click", () => setExercise(el.dataset.ex as Settings["exercise"]));
$<HTMLInputElement>("pm-att-lim").addEventListener("input", (e) => {
  settings.attLimMs = Number((e.target as HTMLInputElement).value);
  saveSettings();
  applyExercise();
});
$<HTMLInputElement>("pm-lim").addEventListener("input", (e) => {
  settings.pmLimMs = Number((e.target as HTMLInputElement).value);
  saveSettings();
  applyExercise();
});
if (pmEx()) pmTone();
applyExercise();
