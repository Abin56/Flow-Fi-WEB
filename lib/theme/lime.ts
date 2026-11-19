/**
 * FlowFi Lime — the one colour system. Light and Dark are two renderings of the same design tokens:
 *
 *   • Surfaces  – a warm "paper" canvas with white cards (light) / warm graphite with lifted cards (dark).
 *   • Lime      – refined, never neon: a bright lime FILL (always paired with dark ink), a deep olive for lime-as-TEXT,
 *                 and a deeper "leaf" lime for chart ink so data marks stay visible on light cards.
 *   • Financial – Money In is an emerald-teal (hue ~165), Money Out a coral red (hue ~20). Both sit well away from
 *                 lime (hue ~125) and stay apart under red-green colour-blindness (validated with the dataviz palette
 *                 validator: lime↔Money-In ΔE ≥ 14 on light surfaces / ≥ 11 on dark, Money-In↔Money-Out CVD ΔE ≥ 8.6),
 *                 so lime as the brand colour never
 *                 blurs them. Transaction amounts also carry a +/− sign, so colour is never the only signal.
 *
 * `buildTokens(accent, surface, mode)` is the single source of truth for every token that depends on those two
 * choices. The default (signature + warm) is written verbatim into app/globals.css — `lime.test.ts` fails if the two
 * ever drift — so the stock stylesheet renders the default with no JavaScript, and a user's accent/surface choice
 * is applied on top as inline custom properties (see apply.ts). Users can only pick from curated, contrast-verified
 * options, so no combination can produce unreadable or mismatched colours.
 */

import { type Oklch, contrast, css, ensureContrast, readableOn } from "./color";

export type ThemeMode = "light" | "dark";
export type TokenMap = Record<string, string>;

export interface AccentOption {
  id: string;
  name: string;
  tagline: string;
  /** OKLCH hue of the lime family (kept inside 105–130 so it never approaches the Money-In emerald at ~160–170). */
  hue: number;
  /** Fill colour (buttons, selected pills) per mode: lightness + chroma. */
  light: { l: number; c: number };
  dark: { l: number; c: number };
}

export interface SurfaceOption {
  id: string;
  name: string;
  tagline: string;
  /** Neutral tint hue per mode and the chroma unit every surface/border/text step is scaled from. */
  light: { h: number; t: number };
  dark: { h: number; t: number };
}

export const ACCENTS: AccentOption[] = [
  { id: "signature", name: "Signature Lime", tagline: "The FlowFi classic", hue: 125, light: { l: 0.89, c: 0.175 }, dark: { l: 0.865, c: 0.16 } },
  { id: "citron", name: "Citron", tagline: "Warmer, sunlit", hue: 108, light: { l: 0.9, c: 0.16 }, dark: { l: 0.88, c: 0.15 } },
  { id: "pistachio", name: "Pistachio", tagline: "Soft and understated", hue: 126, light: { l: 0.9, c: 0.11 }, dark: { l: 0.86, c: 0.115 } },
  { id: "moss", name: "Moss", tagline: "Deep and grounded", hue: 116, light: { l: 0.8, c: 0.14 }, dark: { l: 0.81, c: 0.135 } },
];

export const SURFACES: SurfaceOption[] = [
  { id: "warm", name: "Warm paper", tagline: "Soft cream and graphite", light: { h: 100, t: 0.007 }, dark: { h: 105, t: 0.008 } },
  { id: "neutral", name: "Neutral", tagline: "Clean grey, no tint", light: { h: 110, t: 0.002 }, dark: { h: 110, t: 0.003 } },
  { id: "sage", name: "Sage mist", tagline: "A breath of green", light: { h: 140, t: 0.015 }, dark: { h: 145, t: 0.016 } },
];

export const DEFAULT_ACCENT_ID = "signature";
export const DEFAULT_SURFACE_ID = "warm";

export const findAccent = (id: string): AccentOption | undefined => ACCENTS.find((a) => a.id === id);
export const findSurface = (id: string): SurfaceOption | undefined => SURFACES.find((s) => s.id === id);

export interface ContrastCheck {
  label: string;
  ratio: number;
  /** Minimum we aim for (4.5 body text, 3 for large text / graphical marks). */
  target: number;
  pass: boolean;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Money-In / Money-Out / information colours (see globals.css). Mirrored here only for the readability checks. */
export const FINANCIAL = {
  light: { success: { l: 0.512, c: 0.113, h: 162 }, expense: { l: 0.562, c: 0.198, h: 23 } },
  dark: { success: { l: 0.79, c: 0.13, h: 170 }, expense: { l: 0.685, c: 0.175, h: 19 } },
} as const;

export interface LimeTheme {
  tokens: TokenMap;
  checks: ContrastCheck[];
}

export function buildTokens(accent: AccentOption, surface: SurfaceOption, mode: ThemeMode): LimeTheme {
  const dark = mode === "dark";
  const { h: H, t } = dark ? surface.dark : surface.light;
  const N = (l: number, k = 1, h = H): Oklch => ({ l, c: t * k, h });
  const hue = accent.hue;

  // ---- surfaces ----
  const background = dark ? N(0.21, 0.9) : N(0.967);
  const card = dark ? N(0.255) : N(0.994, 0.4);
  const popover = dark ? N(0.285) : N(0.998, 0.25);
  const elevated = dark ? N(0.285) : N(0.982, 0.7);
  const secondary = dark ? N(0.305) : N(0.945, 1.25);
  const muted = dark ? N(0.32) : secondary;
  const input = dark ? N(0.27) : N(0.795, 1.3);
  const border = dark ? N(0.365, 1.2) : N(0.835, 1.2);
  const borderSubtle = dark ? border : N(0.893, 1.1);
  const borderStrong = dark ? N(0.54, 1.2) : N(0.66, 1.4);
  const sidebar = dark ? N(0.18, 0.8) : N(0.978, 0.8);

  // ---- text ----
  const foreground: Oklch = dark ? { l: 0.95, c: 0.008, h: H } : { l: 0.235, c: Math.max(t * 1.4, 0.006), h: H };
  const mutedFg = ensureContrast(dark ? { l: 0.73, c: 0.008, h: H } : { l: 0.45, c: 0.011, h: H }, card, 4.5, dark ? "lighter" : "darker");
  const tertiaryFg = ensureContrast(dark ? { l: 0.66, c: 0.008, h: H } : { l: 0.53, c: 0.011, h: H }, card, 4.5, dark ? "lighter" : "darker");

  // ---- lime ----
  const fillSpec = dark ? accent.dark : accent.light;
  const primary: Oklch = { l: fillSpec.l, c: fillSpec.c, h: hue };
  const primaryHover: Oklch = dark ? { l: clamp(primary.l + 0.035, 0, 0.95), c: primary.c + 0.005, h: hue } : { l: primary.l - 0.045, c: primary.c + 0.015, h: hue };
  const primaryFg: Oklch = { l: 0.17, c: 0.02, h: hue };
  // Lime as TEXT / icon: deep olive on light surfaces, the fill itself on dark ones.
  const accentText = dark ? primary : ensureContrast({ l: 0.44, c: Math.min(0.115, primary.c * 0.66), h: hue + 2 }, card, 6.5, "darker");
  // Lime as chart INK: a deeper, still-lime "leaf" so bars/lines clear 3:1 on light cards; dark mode uses the fill.
  const chartInk = dark ? primary : ensureContrast({ l: 0.66, c: Math.min(0.17, primary.c * 0.95), h: hue + 2 }, card, 3.1, "darker");
  const focusRing = dark ? primary : ensureContrast({ l: 0.42, c: 0.12, h: hue + 8 }, card, 4.5, "darker");
  const accentWash = css(dark ? { l: primary.l, c: primary.c, h: hue } : { l: 0.94, c: 0.055 * (primary.c / 0.175), h: hue }, dark ? 0.11 : 0.55);
  const ringColor = css({ l: dark ? primary.l : primary.l - 0.06, c: primary.c, h: hue }, dark ? 0.55 : 0.7);

  // ---- hero panels (always a dark anchor, faintly tinted by the lime hue) ----
  const heroA: Oklch = { l: dark ? 0.225 : 0.235, c: dark ? 0.03 : 0.02, h: hue };
  const heroB: Oklch = { l: dark ? 0.16 : 0.165, c: dark ? 0.02 : 0.014, h: hue };

  const shadowHue = H;
  const sh = (a: number) => (dark ? `oklch(0 0 0 / ${a})` : `oklch(0.2 0.02 ${shadowHue} / ${a})`);

  const tokens: TokenMap = {
    "--background": css(background),
    "--foreground": css(foreground),
    "--card": css(card),
    "--card-foreground": css(foreground),
    "--popover": css(popover),
    "--popover-foreground": css(foreground),
    "--primary": css(primary),
    "--primary-hover": css(primaryHover),
    "--primary-foreground": css(primaryFg),
    "--primary-accent-text": css(accentText),
    "--secondary": css(secondary),
    "--secondary-foreground": css(foreground),
    "--muted": css(muted),
    "--muted-foreground": css(mutedFg),
    "--tertiary-foreground": css(tertiaryFg),
    "--accent": accentWash,
    "--accent-foreground": css(dark ? primary : foreground),
    "--border": css(border),
    "--border-subtle": css(borderSubtle),
    "--border-strong": css(borderStrong),
    "--input": css(input),
    "--ring": ringColor,
    "--focus-ring": css(focusRing),
    "--primary-on-hero": css(primary),
    "--primary-on-hero-foreground": css(primaryFg),

    "--chart-1": css(chartInk),

    "--surface": css(card),
    "--surface-elevated": css(elevated),
    "--surface-hero": css(heroB),
    "--text-primary": css(foreground),
    "--text-secondary": css(mutedFg),

    "--sidebar": css(sidebar),
    "--sidebar-foreground": css(foreground),
    "--sidebar-primary": css(primary),
    "--sidebar-primary-foreground": css(primaryFg),
    "--sidebar-accent": accentWash,
    "--sidebar-accent-foreground": css(dark ? primary : foreground),
    "--sidebar-border": css(border),
    "--sidebar-ring": ringColor,

    "--shadow-tint-dark": dark ? "oklch(0 0 0 / 0.4)" : `oklch(0.2 0.02 ${shadowHue} / 0.075)`,
    "--gradient-hero": `linear-gradient(160deg, ${css(heroA)} 0%, ${css(heroB)} 100%)`,
    "--gradient-insight": `linear-gradient(135deg, ${css(heroA)} 0%, ${css(heroB)} 100%)`,
    "--gradient-accent": `linear-gradient(135deg, ${css(primary)}, ${css(primaryHover)})`,
    "--glow-primary": `0 8px 24px -8px ${css(primary, dark ? 0.22 : 0.4)}`,
    "--shadow-card": `0 1px 2px ${sh(dark ? 0.3 : 0.045)}`,
    "--shadow-floating": `0 8px 24px -8px ${sh(dark ? 0.45 : 0.13)}`,
    "--shadow-dialog": `0 16px 40px -12px ${sh(dark ? 0.55 : 0.2)}`,
    "--shadow-command": `0 20px 48px -14px ${sh(dark ? 0.6 : 0.24)}`,
    "--shadow-notification": `0 10px 28px -10px ${sh(dark ? 0.5 : 0.17)}`,
    "--glass-bg": css(popover, 0.98),
  };

  const fin = FINANCIAL[mode];
  const checks: ContrastCheck[] = [
    { label: "Text on page", ratio: contrast(foreground, background), target: 4.5 },
    { label: "Text on cards", ratio: contrast(foreground, card), target: 4.5 },
    { label: "Secondary text", ratio: contrast(mutedFg, card), target: 4.5 },
    { label: "Tertiary text", ratio: contrast(tertiaryFg, card), target: 4.5 },
    { label: "Button label on lime", ratio: contrast(primaryFg, primary), target: 4.5 },
    { label: "Lime used as text", ratio: contrast(accentText, card), target: 4.5 },
    { label: "Lime chart marks", ratio: contrast(chartInk, card), target: 3 },
    { label: "Text on sidebar", ratio: contrast(foreground, sidebar), target: 4.5 },
    { label: "Lime on dark hero panels", ratio: contrast(primary, heroB), target: 4.5 },
    { label: "Text on hero panels", ratio: contrast(readableOn(heroB), heroB), target: 4.5 },
    { label: "Money In text", ratio: contrast(fin.success, card), target: 4.5 },
    { label: "Money Out text", ratio: contrast(fin.expense, card), target: 4.5 },
    { label: "Keyboard focus ring", ratio: contrast(focusRing, card), target: 3 },
    { label: "Control borders", ratio: contrast(borderStrong, card), target: 3 },
  ].map((c) => ({ ...c, ratio: Math.round(c.ratio * 100) / 100, pass: c.ratio >= c.target }));

  return { tokens, checks };
}

/** Every custom property the engine may set inline — used to clear them all when returning to the stock stylesheet. */
export const MANAGED_TOKEN_NAMES: string[] = Object.keys(buildTokens(ACCENTS[0], SURFACES[0], "light").tokens);

export function isDefaultSelection(accentId: string, surfaceId: string): boolean {
  return accentId === DEFAULT_ACCENT_ID && surfaceId === DEFAULT_SURFACE_ID;
}

export function resolveSelection(accentId: string, surfaceId: string): { accent: AccentOption; surface: SurfaceOption } {
  return { accent: findAccent(accentId) ?? ACCENTS[0], surface: findSurface(surfaceId) ?? SURFACES[0] };
}
