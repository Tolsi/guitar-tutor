// Guitar tuner dialog: hears the clean input and shows how far the string is from the chosen tuning.
import { median, noteName } from "../legato/notes";
import { YinStream, type YinFrame } from "../legato/yin";
import { TUNINGS } from "./tunings";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const KEY = "tuner-settings";
/** In tune within this many cents… */
const OK_CENTS = 3;
/** …for this many readings in a row. */
const OK_FRAMES = 10;
const MIN_CLARITY = 0.85;
const MIN_DB = -70;
/** Readings the shown value is the median of. */
const SMOOTH = 7;
/** A reading stays on screen, faded, this long after the string goes silent. */
const FADE_MS = 400;
/** The needle's range, cents either way. */
const RANGE = 50;

const settings = { tuning: "e", a4: 440 };
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

const dlg = $<HTMLDialogElement>("tuner");
const tuning = () => TUNINGS.find((t) => t.id === settings.tuning) ?? TUNINGS[0];

let yin: YinStream | null = null;
let yinRate = 0;
/** String chosen by hand, or null to follow the sound. */
let locked: number | null = null;
/** String being heard. */
let heard: number | null = null;
let recent: number[] = [];
let okRun = 0;
let lastAt = 0;
let level = -120;
let tuned = new Set<number>();

/** The clean guitar, block by block; cheap while the dialog is closed. */
export function feedTuner(x: Float32Array, sr: number) {
  if (!dlg.open) return;
  if (!yin || yinRate !== sr) {
    // A long window: the lowest strings need several periods, and the reading must be steady to a cent.
    yin = new YinStream(sr, { buf: 4096, hop: 1024, fMin: 36, fMax: 700 });
    yinRate = sr;
  }
  yin.push(x, (_, f) => onFrame(f));
}

function onFrame(f: YinFrame) {
  level = f.db;
  if (f.f0 === null || f.clarity < MIN_CLARITY || f.db < MIN_DB) {
    okRun = 0;
    return;
  }
  const m = 69 + 12 * Math.log2(f.f0 / settings.a4);
  const strings = tuning().strings;
  let s = locked;
  if (s === null) {
    s = 0;
    for (let i = 1; i < strings.length; i++) if (Math.abs(m - strings[i]) < Math.abs(m - strings[s])) s = i;
  }
  const cents = (m - strings[s]) * 100;
  // Another string, or a jump: start over instead of sweeping across.
  if (s !== heard || (recent.length && Math.abs(cents - median(recent)) > 60)) {
    recent = [];
    okRun = 0;
  }
  heard = s;
  recent.push(cents);
  if (recent.length > SMOOTH) recent.shift();
  lastAt = performance.now();
  if (Math.abs(median(recent)) <= OK_CENTS) {
    if (++okRun >= OK_FRAMES) tuned.add(s);
  } else {
    okRun = 0;
    // It has been moved off again.
    if (recent.length === SMOOTH) tuned.delete(s);
  }
}

function forget() {
  heard = null;
  recent = [];
  okRun = 0;
  lastAt = 0;
}

function renderStrings() {
  const strings = tuning().strings;
  $("tn-strings").replaceChildren(
    ...strings.map((m, i) => {
      const b = document.createElement("button");
      b.type = "button";
      const no = document.createElement("small");
      no.textContent = `${strings.length - i}-я`;
      const name = document.createElement("b");
      name.textContent = noteName(m);
      const hz = document.createElement("small");
      hz.textContent = `${(settings.a4 * 2 ** ((m - 69) / 12)).toFixed(1).replace(".", ",")} Гц`;
      b.append(no, name, hz);
      b.addEventListener("click", () => {
        locked = locked === i ? null : i;
        forget();
      });
      return b;
    }),
  );
}

function render() {
  if (!dlg.open) return;
  requestAnimationFrame(render);
  const fresh = heard !== null && performance.now() - lastAt < FADE_MS;
  const strings = tuning().strings;
  const target = locked ?? heard;
  const c = recent.length ? median(recent) : 0;
  const ok = Math.abs(c) <= OK_CENTS;
  const needle = $("tn-needle");
  $("tn-note").textContent = target === null ? "—" : noteName(strings[target]);
  needle.style.opacity = fresh ? "1" : "0.3";
  needle.style.left = `${50 + (Math.max(-RANGE, Math.min(RANGE, c)) / RANGE) * 50}%`;
  needle.dataset.state = !fresh ? "" : ok ? "ok" : "off";
  $("tn-cents").textContent = recent.length ? `${c > 0 ? "+" : c < 0 ? "−" : ""}${Math.abs(c).toFixed(1).replace(".", ",")} ц` : "";
  $("tn-cents").style.opacity = fresh ? "1" : "0.5";
  const far = Math.abs(c) > RANGE ? ` (${(Math.abs(c) / 100).toFixed(1).replace(".", ",")} полутона)` : "";
  $("tn-hint").textContent = !fresh
    ? locked === null ? "Сыграйте одну открытую струну" : `Сыграйте ${strings.length - locked}-ю струну`
    : ok ? "Строит" : c < 0 ? `Ниже — подтяните${far}` : `Выше — ослабьте${far}`;
  $("tn-hint").dataset.state = !fresh ? "" : ok ? "ok" : "off";
  $("tn-level").style.width = `${Math.max(0, Math.min(100, ((level + 80) / 70) * 100))}%`;
  [...$("tn-strings").children].forEach((b, i) => {
    b.className = `${tuned.has(i) ? "ok" : ""} ${fresh && heard === i ? "on" : ""}`.trim();
    b.setAttribute("aria-pressed", String(locked === i));
  });
  // The input is switched on from here too; what it says goes to the panel behind the dialog.
  const status = $("wv-status").textContent!;
  if ($("tn-status").textContent !== status) $("tn-status").textContent = status;
  $("tn-input").hidden = inputOn();
  $<HTMLButtonElement>("tn-input").disabled = $<HTMLButtonElement>("wv-start").disabled;
  if (!inputOn()) level = -120;
}

let inputOn = () => false;

export function initTuner(o: { inputOn: () => boolean; openInput: () => void }) {
  inputOn = o.inputOn;
  const sel = $<HTMLSelectElement>("tn-tuning");
  for (const g of new Set(TUNINGS.map((t) => t.group))) {
    const group = document.createElement("optgroup");
    group.label = g;
    for (const t of TUNINGS.filter((t) => t.group === g))
      group.append(new Option(`${t.name}: ${t.strings.map((m) => noteName(m).replace(/\d+$/, "")).join(" ")}`, t.id));
    sel.append(group);
  }
  sel.value = tuning().id;
  const changed = () => {
    save();
    tuned = new Set();
    forget();
    renderStrings();
  };
  sel.addEventListener("change", () => {
    settings.tuning = sel.value;
    locked = null;
    changed();
  });
  const a4 = $<HTMLInputElement>("tn-a4");
  a4.value = String(settings.a4);
  a4.addEventListener("change", () => {
    const v = Number(a4.value);
    if (v >= 415 && v <= 466) settings.a4 = v;
    a4.value = String(settings.a4);
    changed();
  });
  $("tn-input").addEventListener("click", o.openInput);
  $("tn-open").addEventListener("click", () => {
    yin = null;
    locked = null;
    tuned = new Set();
    forget();
    renderStrings();
    dlg.showModal();
    render();
  });
  dlg.addEventListener("click", (e) => {
    if (e.target === dlg) dlg.close();
  });
}
