/**
 * Small OKLCH colour toolkit for the theme engine: hex <-> OKLCH, WCAG contrast, and helpers to
 * nudge lightness until a contrast target is met. Pure functions, no DOM.
 */

export interface Oklch {
  l: number;
  c: number;
  h: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function isHex(v: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(v);
}

function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}
function linearToSrgb(v: number): number {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
}

export function hexToOklch(hex: string): Oklch {
  const n = parseInt(hex.slice(1), 16);
  const r = srgbToLinear(((n >> 16) & 255) / 255);
  const g = srgbToLinear(((n >> 8) & 255) / 255);
  const b = srgbToLinear((n & 255) / 255);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const c = Math.hypot(A, B);
  const h = c < 1e-4 ? 0 : ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360;
  return { l: L, c, h };
}

/** Linear sRGB (clamped to gamut) for an OKLCH colour. */
function oklchToLinear({ l, c, h }: Oklch): [number, number, number] {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    clamp(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_, 0, 1),
    clamp(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_, 0, 1),
    clamp(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_, 0, 1),
  ];
}

export function oklchToHex(color: Oklch): string {
  const [r, g, b] = oklchToLinear(color).map((v) => Math.round(clamp(linearToSrgb(v), 0, 1) * 255));
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

export function luminance(color: Oklch): number {
  const [r, g, b] = oklchToLinear(color);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: Oklch, b: Oklch): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export function css(color: Oklch, alpha?: number): string {
  const base = `${color.l.toFixed(3)} ${color.c.toFixed(3)} ${Math.round(color.h)}`;
  return alpha === undefined ? `oklch(${base})` : `oklch(${base} / ${alpha})`;
}

/**
 * Moves `color` lighter or darker (per `direction`) until it reaches `min` contrast against `bg`.
 * Returns the adjusted colour (unchanged if it already passes).
 */
export function ensureContrast(color: Oklch, bg: Oklch, min: number, direction: "darker" | "lighter"): Oklch {
  let out = { ...color };
  for (let i = 0; i < 60 && contrast(out, bg) < min; i++) {
    out = { ...out, l: clamp(out.l + (direction === "darker" ? -0.015 : 0.015), 0, 1) };
    if (out.l <= 0 || out.l >= 1) break;
  }
  return out;
}

/** Near-black or near-white — whichever reads better on `bg`. */
export function readableOn(bg: Oklch, hue = bg.h): Oklch {
  const dark: Oklch = { l: 0.16, c: 0.012, h: hue };
  const light: Oklch = { l: 0.985, c: 0.004, h: hue };
  return contrast(dark, bg) >= contrast(light, bg) ? dark : light;
}

export function rotateHue(color: Oklch, deg: number): Oklch {
  return { ...color, h: (color.h + deg + 360) % 360 };
}
