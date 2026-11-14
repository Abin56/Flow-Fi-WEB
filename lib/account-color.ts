/**
 * One source of truth for the account / credit-card colour stored in `Account.colorValue`.
 *
 * The mobile app (Flutter) stores a full 32-bit ARGB int there (`Color.toARGB32()`, e.g. 0xFF1565C0) and
 * renders `Color(colorValue)` directly. The web used to store a *list index* instead (0..11 for accounts,
 * 1..16 for cards), so a colour picked on one platform showed up wrong — or invisible — on the other.
 *
 * Contract now, on both platforms:
 *  - `colorValue` is an opaque ARGB int (alpha 0xFF). The web writes the same format mobile does.
 *  - Legacy web values (small ints, i.e. below 0x01000000 — a real ARGB int always has a non-zero alpha)
 *    are still READ and mapped to the colour they used to mean, so no existing account changes look.
 *    They are upgraded to ARGB the next time the account's colour is saved.
 */

/** Smallest value an ARGB int can take with a non-zero alpha byte. Anything below is a legacy list index. */
const MIN_ARGB = 0x01000000;

export function isArgbColorValue(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && (value >>> 0) >= MIN_ARGB;
}

/** `#rrggbb` → opaque ARGB int, the exact shape Dart's `Color.toARGB32()` produces (unsigned). */
export function hexToArgb(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`Invalid hex colour: ${hex}`);
  return (0xff000000 | parseInt(m[1]!, 16)) >>> 0;
}

/** ARGB int → `#rrggbb` (alpha is ignored — account colours are always opaque). */
export function argbToHex(value: number): string {
  return `#${((value >>> 0) & 0xffffff).toString(16).padStart(6, "0")}`;
}

function channels(value: number): [number, number, number] {
  const v = value >>> 0;
  return [(v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
}

/** Mirrors mobile's `Color.lerp(color, Colors.black, amount)` so a custom colour gets the same card-face shade. */
function darken(value: number, amount: number): string {
  const [r, g, b] = channels(value).map((c) => Math.round(c * (1 - amount))) as [number, number, number];
  return `rgb(${r}, ${g}, ${b})`;
}

/** Two-stop card/chip gradient for an arbitrary ARGB colour — same recipe as the mobile card swatches. */
export function gradientFromArgb(value: number): string {
  return `linear-gradient(135deg, ${argbToHex(value)} 0%, ${darken(value, 0.4)} 100%)`;
}

/** WCAG-style relative luminance (0..1). */
function luminance(value: number): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const [r, g, b] = channels(value);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Text class that stays readable on top of the colour's gradient (white on dark/saturated, dark on pale). */
export function onColorClass(value: number): "text-white" | "text-slate-900" {
  return luminance(value) > 0.55 ? "text-slate-900" : "text-white";
}

/** Legacy web account picker order — index in this list WAS the stored `colorValue`. */
export const LEGACY_ACCOUNT_HEX = [
  "#4338ca", // slate
  "#f97316", // orange
  "#3b82f6", // blue
  "#3d9a6b", // green
  "#06b6d4", // cyan
  "#7e57d9", // violet
  "#b91c1c", // maroon
  "#10b981", // emerald
  "#b45309", // bronze
  "#3f3f46", // charcoal
  "#1e3a8a", // navy
  "#86198f", // plum
] as const;

/** Legacy web card picker order — (index + 1) WAS the stored `colorValue`; 0 meant "never picked". */
export const LEGACY_CARD_HEX = [
  "#2563eb", // primary
  "#2d4a9e", // purple
  "#0f766e", // teal
  "#146b4d", // success
  "#b8862b", // gold
  "#ea580c", // orange
  "#c2185b", // expense
  "#2b2b2b", // warning
  "#e11d48", // rose
  "#0ea5e9", // sky
  "#10b981", // emerald
  "#7c3aed", // violet
  "#64748b", // slate
  "#8b5a2b", // bronze
  "#c026d3", // magenta
  "#1e2a78", // navy
] as const;

/**
 * Normalises a stored `colorValue` to an ARGB int.
 *  - already ARGB → returned as is (this is what mobile wrote);
 *  - legacy web index → the colour it used to select;
 *  - a never-picked card (0) → null, so callers can keep their positional default.
 * `kind` only matters for legacy values, because accounts and cards used different index schemes.
 */
export function resolveColorValue(colorValue: number | null | undefined, kind: "account" | "card"): number | null {
  if (colorValue == null || !Number.isFinite(colorValue)) return null;
  if (isArgbColorValue(colorValue)) return colorValue >>> 0;
  const index = Math.trunc(colorValue);
  if (kind === "card") {
    const hex = index > 0 ? LEGACY_CARD_HEX[index - 1] : undefined;
    return hex ? hexToArgb(hex) : null;
  }
  const hex = LEGACY_ACCOUNT_HEX[((index % LEGACY_ACCOUNT_HEX.length) + LEGACY_ACCOUNT_HEX.length) % LEGACY_ACCOUNT_HEX.length];
  return hex ? hexToArgb(hex) : null;
}
