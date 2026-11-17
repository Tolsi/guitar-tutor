// Live monitoring chain: input → distortion pedal → NAM amp → cabinet → volume → limiter → speakers.
import namWorkletUrl from "./nam-worklet.ts?worker&url";
import namWasmUrl from "@opendaw/nam-wasm/nam.wasm?url";

const MODEL_BASE = "https://raw.githubusercontent.com/pelennor2170/NAM_models/main/";

export interface AmpPreset {
  id: string;
  name: string;
  file: string;
  /** The capture already includes a speaker cabinet. */
  hasCab: boolean;
}

export const AMPS: AmpPreset[] = [
  { id: "twin", name: "Fender Twin Reverb — чистый", file: "Tim R Fender TwinVerb Norm Bright.nam", hasCab: false },
  { id: "ac15", name: "Vox AC15 Top Boost", file: "Phillipe P VOXAC15-TopBoost.nam", hasCab: false },
  { id: "bugera-clean", name: "Bugera 333 — чистый, с кабинетом", file: "Phillipe P Bug333-Clean-Cab-ESR0,007.nam", hasCab: true },
  { id: "magnatone", name: "Magnatone Super 59 — яркий", file: "Tim R Magnatone Super 59 Mkii Ch1 Br.nam", hasCab: false },
  { id: "jvm-clean", name: "Marshall JVM — чистый, с кабинетом", file: "Phillipe P JVM-CL-GR-NoDrive-Cab-ESR0,007.nam", hasCab: true },
  { id: "jcm2000", name: "Marshall JCM2000 — кранч", file: "Tim R JCM2000 Crunch.nam", hasCab: false },
  { id: "5150", name: "Peavey 5150 — хай-гейн", file: "Helga B 5150 BlockLetter - NoBoost.nam", hasCab: false },
];

export type DistType = "od" | "dist" | "fuzz";

export interface MonitorSettings {
  amp: string;
  cab: boolean;
  inDb: number;
  volDb: number;
  dist: boolean;
  distType: DistType;
  drive: number;
  tone: number;
  levelDb: number;
}

export const MONITOR_DEFAULTS: MonitorSettings = {
  amp: "twin",
  cab: true,
  inDb: 0,
  volDb: -6,
  dist: false,
  distType: "od",
  drive: 0.5,
  tone: 0.5,
  levelDb: -12,
};

/** Output RMS the level-matching aims for, measured on the worklet's test chord. */
const TARGET_DB = -24;

const dbToGain = (db: number) => 10 ** (db / 20);

function shaperCurve(type: DistType, drive: number) {
  const n = 4096;
  const curve = new Float32Array(n);
  const a = type === "od" ? 1 + drive * 40 : type === "dist" ? 2 + drive * 200 : 5 + drive * 600;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    let y: number;
    if (type === "od") {
      // Soft, slightly asymmetric: a tube-ish overdrive.
      y = Math.tanh(a * x + 0.2) - Math.tanh(0.2);
    } else if (type === "dist") {
      // Harder knee, symmetric: an op-amp + diode distortion.
      const v = a * x;
      y = v / (1 + Math.abs(v) ** 2.5) ** (1 / 2.5);
    } else {
      // Fuzz: very hard and lopsided, the negative half clips early.
      const v = a * x;
      y = v > 0 ? 1 - Math.exp(-v) : -0.6 * (1 - Math.exp(v * 1.6));
    }
    curve[i] = y;
    peak = Math.max(peak, Math.abs(y));
  }
  for (let i = 0; i < n; i++) curve[i] /= peak || 1;
  return curve;
}

type Status = (text: string, busy?: boolean) => void;

/** A two-way switch between a dry path and an effect path, crossfaded to avoid clicks. */
class Bypass {
  readonly input: GainNode;
  readonly output: GainNode;
  private readonly dry: GainNode;
  private readonly wet: GainNode;
  constructor(
    private readonly ctx: AudioContext,
    fxIn: AudioNode,
    fxOut: AudioNode,
  ) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    this.input.connect(this.dry).connect(this.output);
    this.input.connect(fxIn);
    fxOut.connect(this.wet).connect(this.output);
  }
  set(on: boolean) {
    const t = this.ctx.currentTime;
    this.wet.gain.setTargetAtTime(on ? 1 : 0, t, 0.015);
    this.dry.gain.setTargetAtTime(on ? 0 : 1, t, 0.015);
  }
}

export class Monitor {
  /** The live input goes in here. */
  readonly input: GainNode;
  /** Output of the whole effect chain (pedal, amp, cabinet). */
  readonly wet: GainNode;
  /** Recorded audio for playback: skips the effects and the headphone switch. */
  readonly playIn: GainNode;
  private readonly ampTrim: GainNode;
  private readonly volume: GainNode;
  private readonly gate: GainNode;
  private readonly pedal: Bypass;
  private readonly cab: Bypass;
  private readonly shaper: WaveShaperNode;
  private readonly tone: BiquadFilterNode;
  private readonly pedalLevel: GainNode;
  private readonly nam: AudioWorkletNode;
  /** Level-matches captures, which differ in output level by 20 dB and more. */
  private readonly norm: GainNode;
  private readonly cache = new Map<string, string>();
  private loadSeq = 0;
  private on = false;
  s: MonitorSettings;

  private constructor(
    readonly ctx: AudioContext,
    nam: AudioWorkletNode,
    s: MonitorSettings,
    private readonly status: Status,
  ) {
    this.s = s;
    this.nam = nam;
    this.input = ctx.createGain();

    // Pedal: tighten the lows, clip, then tame the fizz.
    const tight = new BiquadFilterNode(ctx, { type: "highpass", frequency: 160, Q: 0.7 });
    const hump = new BiquadFilterNode(ctx, { type: "peaking", frequency: 720, Q: 0.8, gain: 4 });
    this.shaper = new WaveShaperNode(ctx, { oversample: "4x" });
    this.tone = new BiquadFilterNode(ctx, { type: "lowpass", Q: 0.6 });
    this.pedalLevel = ctx.createGain();
    tight.connect(hump).connect(this.shaper).connect(this.tone).connect(this.pedalLevel);
    this.pedal = new Bypass(ctx, tight, this.pedalLevel);

    // Amp: input trim, then the NAM model.
    this.ampTrim = ctx.createGain();
    this.input.connect(this.ampTrim).connect(this.pedal.input);
    this.pedal.output.connect(nam);

    // Cabinet: a 1x12 / 2x12 voicing built from filters.
    const cabNodes = [
      new BiquadFilterNode(ctx, { type: "highpass", frequency: 85, Q: 0.8 }),
      new BiquadFilterNode(ctx, { type: "peaking", frequency: 120, Q: 1.1, gain: 3 }),
      new BiquadFilterNode(ctx, { type: "peaking", frequency: 450, Q: 1, gain: -2.5 }),
      new BiquadFilterNode(ctx, { type: "peaking", frequency: 2300, Q: 1.3, gain: 3.5 }),
      new BiquadFilterNode(ctx, { type: "lowpass", frequency: 4800, Q: 0.7 }),
      new BiquadFilterNode(ctx, { type: "lowpass", frequency: 6200, Q: 1 }),
    ];
    cabNodes.slice(1).reduce<AudioNode>((a, b) => a.connect(b), cabNodes[0]);
    this.cab = new Bypass(ctx, cabNodes[0], cabNodes[cabNodes.length - 1]);
    this.norm = ctx.createGain();
    nam.connect(this.norm).connect(this.cab.input);

    // The processed signal: what gets recorded, drawn and analysed.
    this.wet = ctx.createGain();
    this.cab.output.connect(this.wet);
    // Output: the headphone switch for the live signal, then volume and a safety limiter. Playback of
    // recorded (already processed) audio joins after the switch, so it is not processed twice.
    this.gate = ctx.createGain();
    this.gate.gain.value = 0;
    this.playIn = ctx.createGain();
    this.volume = ctx.createGain();
    const limiter = new DynamicsCompressorNode(ctx, { threshold: -6, knee: 0, ratio: 20, attack: 0.002, release: 0.1 });
    this.wet.connect(this.gate).connect(this.volume);
    this.playIn.connect(this.volume);
    this.volume.connect(limiter).connect(ctx.destination);

    this.apply();
  }

  static async create(ctx: AudioContext, s: MonitorSettings, status: Status) {
    status("Загружаю движок NAM…", true);
    const [wasm] = await Promise.all([
      fetch(namWasmUrl).then((r) => {
        if (!r.ok) throw new Error(`nam.wasm: HTTP ${r.status}`);
        return r.arrayBuffer();
      }),
      ctx.audioWorklet.addModule(namWorkletUrl),
    ]);
    const node = new AudioWorkletNode(ctx, "nam-amp", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: "explicit",
      processorOptions: { wasm },
    });
    await new Promise<void>((resolve, reject) => {
      node.port.onmessage = (e) => {
        if (e.data.type === "ready") resolve();
        else if (e.data.type === "error") reject(new Error(e.data.message));
      };
    });
    const m = new Monitor(ctx, node, s, status);
    // A custom file is loaded by the caller.
    if (s.amp !== "file") await m.loadAmp(s.amp);
    return m;
  }

  get enabled() {
    return this.on;
  }

  setEnabled(on: boolean) {
    this.on = on;
    this.gate.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.02);
  }

  /** Re-applies every setting except the amp model. */
  apply() {
    const s = this.s;
    const t = this.ctx.currentTime;
    this.ampTrim.gain.setTargetAtTime(dbToGain(s.inDb), t, 0.02);
    this.volume.gain.setTargetAtTime(dbToGain(s.volDb), t, 0.02);
    this.shaper.curve = shaperCurve(s.distType, s.drive);
    this.tone.frequency.setTargetAtTime(900 * 10 ** (s.tone * 1.1), t, 0.02);
    this.pedalLevel.gain.setTargetAtTime(dbToGain(s.levelDb), t, 0.02);
    this.pedal.set(s.dist);
    this.cab.set(s.cab);
  }

  latencyMs() {
    return Math.round(((this.ctx.baseLatency || 0) + (this.ctx.outputLatency || 0)) * 1000);
  }

  async loadAmp(id: string, file?: File) {
    const seq = ++this.loadSeq;
    if (id === "none") {
      this.nam.port.postMessage({ type: "unload" });
      this.norm.gain.setTargetAtTime(1, this.ctx.currentTime, 0.02);
      this.status("Без усилителя: звук идёт напрямую (через кабинет, если он включён).");
      return;
    }
    const preset = AMPS.find((a) => a.id === id);
    const label = file ? file.name : (preset?.name ?? id);
    this.status(`Загружаю модель «${label}»…`, true);
    let json: string;
    try {
      if (file) json = await file.text();
      else if (preset) {
        json = this.cache.get(id) ?? "";
        if (!json) {
          const r = await fetch(MODEL_BASE + encodeURIComponent(preset.file));
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          json = await r.text();
          this.cache.set(id, json);
        }
      } else throw new Error("неизвестная модель");
    } catch (e) {
      if (seq === this.loadSeq) this.status(`Не удалось скачать модель: ${(e as Error).message}`);
      return;
    }
    if (seq !== this.loadSeq) return;
    const res = await new Promise<{ ok: boolean; loudness: number | null }>((resolve) => {
      this.nam.port.onmessage = (e) => {
        if (e.data.type === "loaded") resolve(e.data);
      };
      this.nam.port.postMessage({ type: "load", json });
    });
    if (seq !== this.loadSeq) return;
    const trim = res.loudness === null ? 0 : Math.min(30, Math.max(-24, TARGET_DB - res.loudness));
    this.norm.gain.setTargetAtTime(dbToGain(trim), this.ctx.currentTime, 0.02);
    this.status(res.ok ? `Усилитель: ${label} · громкость выровнена на ${trim > 0 ? "+" : ""}${Math.round(trim)} дБ` : `Файл «${label}» не подходит: это не модель NAM или её архитектура не поддерживается.`);
  }
}
