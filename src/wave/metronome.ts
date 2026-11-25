// Metronome: clicks on the audio clock, straight to the output, so it never gets into a recording by itself.

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const KEY = "metronome-settings";
const TICK_MS = 25;
/** Clicks are queued this far ahead; a background tab's timers run about once a second. */
const AHEAD_S = 0.12;
const AHEAD_HIDDEN_S = 1.6;

export const BPM_MIN = 30;
export const BPM_MAX = 300;

const settings = { beats: 4, sub: 1, vol: 70 };
try {
  Object.assign(settings, JSON.parse(localStorage.getItem(KEY) ?? "{}"));
} catch {
  /* storage unavailable */
}
const save = () => {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* storage unavailable */
  }
};

interface Host {
  audio: () => Promise<AudioContext>;
  bpm: () => number;
  setBpm: (v: number) => void;
}
let host: Host;

let ctx: AudioContext | null = null;
let out: GainNode | null = null;
let timer = 0;
let starting = false;
let nextAt = 0;
let beat = 0;
let sub = 0;
/** Clicks in the current beat; a change waits for the next beat. */
let subs = 1;
/** Queued beats, to light up when they sound. */
let queue: { at: number; beat: number }[] = [];
let lit = -1;
let taps: number[] = [];

const gainOf = (vol: number) => (vol / 100) ** 2;

function click(at: number, kind: "accent" | "beat" | "sub") {
  const o = ctx!.createOscillator(), g = ctx!.createGain();
  o.frequency.value = kind === "accent" ? 1760 : kind === "beat" ? 1175 : 880;
  const peak = kind === "accent" ? 0.9 : kind === "beat" ? 0.6 : 0.25;
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(peak, at + 0.001);
  g.gain.exponentialRampToValueAtTime(0.001, at + 0.05);
  o.connect(g).connect(out!);
  o.start(at);
  o.stop(at + 0.06);
}

function schedule() {
  if (!ctx) return;
  const now = ctx.currentTime;
  const ahead = now + (document.hidden ? AHEAD_HIDDEN_S : AHEAD_S);
  // Timers held up for long (a sleeping laptop): skip what was missed instead of firing it all at once.
  if (nextAt < now - 0.2) nextAt = now + 0.05;
  while (nextAt < ahead) {
    if (sub === 0) {
      subs = settings.sub;
      queue.push({ at: nextAt, beat });
    }
    click(nextAt, sub ? "sub" : beat === 0 && settings.beats > 1 ? "accent" : "beat");
    nextAt += 60 / host.bpm() / subs;
    if (++sub >= subs) {
      sub = 0;
      if (++beat >= settings.beats) beat = 0;
    }
  }
}

async function start() {
  if (timer || starting) return;
  starting = true;
  try {
    ctx = await host.audio();
    await ctx.resume();
  } catch (e) {
    console.error(e);
    return;
  } finally {
    starting = false;
  }
  // A gain of its own for each run: cutting it off on stop drops the queued clicks.
  out = ctx.createGain();
  out.gain.value = gainOf(settings.vol);
  out.connect(ctx.destination);
  beat = sub = 0;
  queue = [];
  nextAt = ctx.currentTime + 0.06;
  timer = window.setInterval(schedule, TICK_MS);
  schedule();
  renderState();
  requestAnimationFrame(light);
}

export function stopMetronome() {
  if (!timer) return;
  clearInterval(timer);
  timer = 0;
  out?.disconnect();
  out = null;
  queue = [];
  renderState();
}

export const toggleMetronome = () => (timer ? stopMetronome() : void start());

function light() {
  const dots = $("mt-dots").children;
  if (!timer || !ctx) {
    lit = -1;
    for (const d of dots) d.classList.remove("on");
    return;
  }
  // When it is heard, not when it is handed to the output.
  const now = ctx.currentTime - (ctx.outputLatency || 0);
  while (queue.length && queue[0].at <= now) lit = queue.shift()!.beat;
  for (let i = 0; i < dots.length; i++) dots[i].classList.toggle("on", i === lit);
  requestAnimationFrame(light);
}

function renderState() {
  const on = timer !== 0;
  $("mt-play").textContent = on ? "Стоп" : "Старт";
  $("mt-btn").classList.toggle("on", on);
  $("mt-btn").setAttribute("aria-pressed", String(on));
}

/** Shows the tempo, also when it was changed elsewhere. */
export function showMetronomeBpm() {
  const v = String(host.bpm());
  $<HTMLInputElement>("mt-bpm").value = v;
  $<HTMLInputElement>("mt-bpm-r").value = v;
}

function renderDots() {
  $("mt-dots").replaceChildren(...Array.from({ length: settings.beats }, () => document.createElement("i")));
}

function tap() {
  const now = performance.now();
  if (taps.length && now - taps[taps.length - 1] > 2500) taps = [];
  taps.push(now);
  taps = taps.slice(-6);
  if (taps.length < 2) return;
  host.setBpm(Math.min(BPM_MAX, Math.max(BPM_MIN, Math.round((60000 * (taps.length - 1)) / (now - taps[0])))));
}

export function initMetronome(h: Host) {
  host = h;
  const dlg = $<HTMLDialogElement>("metronome");
  // Not modal: it stays beside the timeline while playing and recording.
  $("mt-open").addEventListener("click", () => {
    if (!dlg.open) dlg.show();
  });
  $("mt-close").addEventListener("click", () => dlg.close());
  $("mt-play").addEventListener("click", toggleMetronome);
  $("mt-btn").addEventListener("click", toggleMetronome);
  $("mt-tap").addEventListener("click", tap);
  const bpm = $<HTMLInputElement>("mt-bpm"), range = $<HTMLInputElement>("mt-bpm-r");
  const set = (v: number) => {
    if (v >= BPM_MIN && v <= BPM_MAX) host.setBpm(Math.round(v));
    else showMetronomeBpm();
  };
  bpm.addEventListener("change", () => set(Number(bpm.value)));
  range.addEventListener("input", () => set(Number(range.value)));
  $("mt-minus").addEventListener("click", () => set(host.bpm() - 1));
  $("mt-plus").addEventListener("click", () => set(host.bpm() + 1));
  const beats = $<HTMLSelectElement>("mt-beats"), subSel = $<HTMLSelectElement>("mt-sub"), vol = $<HTMLInputElement>("mt-vol");
  beats.value = String(settings.beats);
  subSel.value = String(settings.sub);
  vol.value = String(settings.vol);
  beats.addEventListener("change", () => {
    settings.beats = Number(beats.value);
    if (beat >= settings.beats) beat = 0;
    renderDots();
    save();
  });
  subSel.addEventListener("change", () => {
    settings.sub = Number(subSel.value);
    save();
  });
  vol.addEventListener("input", () => {
    settings.vol = Number(vol.value);
    if (out && ctx) out.gain.setTargetAtTime(gainOf(settings.vol), ctx.currentTime, 0.01);
    save();
  });
  renderDots();
  renderState();
  showMetronomeBpm();
}
