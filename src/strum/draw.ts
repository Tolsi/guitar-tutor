import { HandLandmarker } from "@mediapipe/tasks-vision";
import type { RawFrame, Sample, Turn, Vec } from "./analysis";

export interface Palette {
  ink: string;
  muted: string;
  line: string;
  accent: string;
  good: string;
  warn: string;
  bad: string;
}

export function readPalette(): Palette {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string) => cs.getPropertyValue(n).trim();
  return {
    ink: v("--ink"),
    muted: v("--muted"),
    line: v("--line"),
    accent: v("--accent"),
    good: v("--good"),
    warn: v("--warn"),
    bad: v("--bad"),
  };
}

export interface OverlayColors {
  upper: string;
  fore: string;
  hand: string;
}

const STAGE_INK = "rgba(255,255,255,0.85)";

function line(ctx: CanvasRenderingContext2D, a: Vec, b: Vec, color: string, w: number) {
  ctx.strokeStyle = color;
  ctx.lineWidth = w;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
}

function dot(ctx: CanvasRenderingContext2D, p: Vec, r: number, fill: string, ring?: string) {
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  if (ring) {
    ctx.strokeStyle = ring;
    ctx.lineWidth = r * 0.45;
    ctx.stroke();
  }
}

export function drawOverlay(
  ctx: CanvasRenderingContext2D,
  frame: RawFrame | null,
  trail: Vec[],
  colors: OverlayColors,
  pal: Palette,
) {
  const { width: W, height: H } = ctx.canvas;
  ctx.clearRect(0, 0, W, H);
  if (!frame) return;
  const k = W / 640;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (trail.length > 1) {
    for (let i = 1; i < trail.length; i++) {
      ctx.globalAlpha = (i / trail.length) * 0.8;
      line(ctx, trail[i - 1], trail[i], pal.accent, 3 * k);
    }
    ctx.globalAlpha = 1;
  }

  if (frame.otherShoulder) line(ctx, frame.otherShoulder, frame.shoulder, "rgba(255,255,255,0.35)", 3 * k);
  line(ctx, frame.shoulder, frame.elbow, colors.upper, 7 * k);
  line(ctx, frame.elbow, frame.wrist, colors.fore, 7 * k);

  if (frame.hand) {
    const h = frame.hand;
    for (const c of HandLandmarker.HAND_CONNECTIONS) line(ctx, h[c.start], h[c.end], colors.hand, 2.5 * k);
    for (let i = 0; i < h.length; i++) dot(ctx, h[i], (i % 4 === 0 ? 3.5 : 2.5) * k, STAGE_INK);
  }

  dot(ctx, frame.shoulder, 7 * k, STAGE_INK, colors.upper);
  dot(ctx, frame.elbow, 9 * k, pal.accent, STAGE_INK);
  dot(ctx, frame.wrist, 6 * k, STAGE_INK, colors.fore);
}

export function drawTrace(canvas: HTMLCanvasElement, samples: Sample[], turns: Turn[], now: number, pal: Palette) {
  const dpr = window.devicePixelRatio || 1;
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
  }
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, ch);

  const span = 4000;
  const pad = 6;
  ctx.strokeStyle = pal.line;
  ctx.lineWidth = 1;
  for (let s = 1; s < 4; s++) {
    const x = (s / 4) * cw;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, ch);
    ctx.stroke();
  }
  if (samples.length < 2) return;

  const ys = samples.map((s) => s.strike.y);
  const fore = samples.at(-1)!.foreLen;
  const mid = (Math.min(...ys) + Math.max(...ys)) / 2;
  const range = Math.max(Math.max(...ys) - Math.min(...ys), fore * 0.6);
  const X = (t: number) => cw - ((now - t) / span) * cw;
  const Y = (y: number) => ch / 2 + ((y - mid) / range) * (ch - pad * 2);

  ctx.strokeStyle = pal.accent;
  ctx.lineWidth = 2;
  ctx.beginPath();
  samples.forEach((s, i) => (i ? ctx.lineTo(X(s.t), Y(s.strike.y)) : ctx.moveTo(X(s.t), Y(s.strike.y))));
  ctx.stroke();

  for (const t of turns) {
    ctx.beginPath();
    ctx.arc(X(t.t), Y(t.y), 3.5, 0, Math.PI * 2);
    ctx.fillStyle = t.kind === "bottom" ? pal.ink : pal.muted;
    ctx.fill();
  }
}
