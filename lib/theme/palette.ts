/**
 * Generic two/three-colour theme generator — everything that is NOT FlowFi Lime.
 *
 * A theme is a small spec:   base  +  primary  +  (optional) secondary.
 *
 *   • base       picks a NEUTRAL surface family (pure white, soft grey, ivory, navy, black). It owns the page, cards,
 *                borders and text. Its tint is tiny and fixed, so backgrounds never pick up the primary's hue —
 *                "choosing three colours" never means mixing them into the background.
 *   • primary    is the interactive colour: buttons, active navigation, links, focus, selected states, chart ink.
 *                It is clamped per mode so it is always visible (≥ 4.5:1 on cards) and always has readable ink on it.
 *   • secondary  (optional) is used with restraint: the information/transfer colour family and the tint of the dark
 *                hero panels. It never touches a surface.
 *
 * Money In / Money Out / Pending / Overdue are NOT produced here — they stay the stylesheet's own financial colours in
 * every theme, so a theme can never change what a figure means. Gradients are flat: hero panels use one solid tone.
 */

import { type Oklch, contrast, css, ensureContrast, hexToOklch, isHex, oklchToHex, readableOn } from "./color";
import { type ContrastCheck, FINANCIAL, type ThemeMode, type TokenMap } from "./lime";

export interface BaseFamily {
  id: string;
  name: string;
  tagline: string;
  light: { h: number; t: number; bg: number; card: number };
  dark: { h: number; t: number; bg: number; card: number };
}

export const BASES: BaseFamily[] = [
  {
    id: "white",
    name: "Pure white",
    tagline: "Crisp, truly white",
    light: { h: 260, t: 0, bg: 1, card: 1 },
    dark: { h: 260, t: 0.004, bg: 0.19, card: 0.235 },
  },
  {
    id: "soft",
    name: "Soft grey",
    tagline: "Calm cool canvas",
    light: { h: 255, t: 0.006, bg: 0.962, card: 0.998 },
    dark: { h: 255, t: 0.01, bg: 0.205, card: 0.25 },
  },
  {
    id: "ivory",
    name: "Ivory",
    tagline: "Warm, paper-like",
    light: { h: 92, t: 0.012, bg: 0.972, card: 0.993 },
    dark: { h: 85, t: 0.008, bg: 0.2, card: 0.245 },
  },
  {
    id: "navy",
    name: "Navy",
    tagline: "Cool white by day, deep navy at night",
    light: { h: 258, t: 0.008, bg: 0.975, card: 1 },
    dark: { h: 262, t: 0.038, bg: 0.185, card: 0.232 },
  },
  {
    id: "black",
    name: "Black",
    tagline: "Minimal, near-black",
    light: { h: 260, t: 0, bg: 1, card: 1 },
    dark: { h: 260, t: 0, bg: 0.135, card: 0.185 },
  },
];

export const DEFAULT_BASE_ID = "white";
export const findBase = (id: string): BaseFamily | undefined => BASES.find((b) => b.id === id);

export interface PaletteSpec {
  base: string;
  primary: string;
  /** Preset-only: the primary used in dark mode when "lift the light-mode colour" would not give the intended look. */
  primaryDark?: string;
  secondary?: string | null;
}

export interface PaletteTheme {
  tokens: TokenMap;
  checks: ContrastCheck[];
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Every custom property this generator may set, beyond the set both generators share. */
export const PALETTE_ONLY_TOKENS = ["--royal", "--sky", "--ice", "--navy", "--chart-2"];

export function buildPaletteTokens(spec: PaletteSpec, mode: ThemeMode): PaletteTheme {
  const dark = mode === "dark";
  const base = findBase(spec.base) ?? BASES[0];
  const B = dark ? base.dark : base.light;
  const N = (l: number, k = 1): Oklch => ({ l, c: B.t * k, h: B.h });

  // ---- neutral surfaces: only the base decides these ----
  const lightSecondaryL = Math.min(B.bg, 0.985) - 0.02;
  const background = dark ? N(B.bg, 0.9) : N(B.bg);
  const card = dark ? N(B.card) : N(B.card, 0.35);
  const popover = dark ? N(B.card + 0.03) : card;
  const elevated = dark ? popover : N(0.985, 0.6);
  const secondary = dark ? N(B.card + 0.045) : N(lightSecondaryL, 1.2);
  const muted = dark ? N(B.card + 0.065) : secondary;
  const border = dark ? N(B.card + 0.11, 1.2) : N(Math.min(B.bg, 0.985) - 0.12, 1.2);
  const borderSubtle = dark ? border : N(border.l + 0.045, 1.1);
  const borderStrong = dark ? N(0.53, 1.2) : N(0.66, 1.3);
  const input = dark ? N(B.card + 0.015) : N(0.8, 1.3);
  const sidebar = dark ? N(B.bg - 0.03, 0.8) : N(B.bg >= 0.995 ? 0.985 : B.bg + 0.012, 0.8);

  const ink = { c: 0.006 + B.t * 0.6, h: B.h };
  const foreground: Oklch = dark ? { l: 0.95, ...ink } : { l: 0.215, ...ink };
  const mutedFg = ensureContrast(dark ? { l: 0.73, c: 0.01, h: B.h } : { l: 0.45, c: 0.012, h: B.h }, card, 4.5, dark ? "lighter" : "darker");
  const tertiaryFg = ensureContrast(dark ? { l: 0.66, c: 0.01, h: B.h } : { l: 0.53, c: 0.012, h: B.h }, card, 4.5, dark ? "lighter" : "darker");

  // ---- primary: always visible, always with readable ink ----
  const p0 = hexToOklch(spec.primary);
  let primary: Oklch;
  if (dark) {
    // A neutral primary (black, graphite) flips to near-white in dark mode; a coloured one is lifted to a legible tint.
    const lifted: Oklch = spec.primaryDark ? hexToOklch(spec.primaryDark) : p0.c < 0.03 ? { l: 0.94, c: p0.c, h: p0.h } : { l: clamp(p0.l, 0.72, 0.93), c: p0.c * 0.92, h: p0.h };
    primary = ensureContrast(lifted, card, 4.5, "lighter");
  } else {
    primary = ensureContrast({ l: clamp(p0.l, 0.2, 0.62), c: Math.min(p0.c, 0.2), h: p0.h }, card, 4.5, "darker");
  }
  // The label on a solid primary button must itself reach 4.5:1: nudge mid-tones (orange, magenta…) until it does.
  for (let i = 0; i < 40 && contrast(readableOn(primary), primary) < 4.5; i++) {
    primary = { ...primary, l: clamp(primary.l + (dark ? 0.01 : -0.01), 0.05, 0.98) };
  }
  const primaryHover: Oklch = dark ? { ...primary, l: clamp(primary.l + 0.035, 0, 0.97) } : { ...primary, l: clamp(primary.l - 0.05, 0, 1) };
  const primaryFg = readableOn(primary);
  const washAlpha = dark ? 0.14 : 0.08;

  // ---- secondary: information family + hero tint, never a surface ----
  const s0 = spec.secondary && isHex(spec.secondary) ? hexToOklch(spec.secondary) : null;
  const info: Oklch | null = s0
    ? ensureContrast({ l: dark ? clamp(s0.l, 0.72, 0.88) : clamp(s0.l, 0.38, 0.6), c: clamp(s0.c, 0.06, 0.2), h: s0.h }, card, 4.5, dark ? "lighter" : "darker")
    : null;

  // ---- hero panels: one flat, dark tone (no gradient) ----
  const heroSource = s0 && s0.c > 0.03 ? { c: clamp(s0.c * 0.3, 0.03, 0.07), h: s0.h } : p0.c > 0.04 ? { c: 0.025, h: p0.h } : { c: B.t * 0.8, h: B.h };
  const hero: Oklch = { l: dark ? Math.max(card.l - 0.085, 0.09) : 0.2, c: heroSource.c, h: heroSource.h };
  const primaryOnHero = ensureContrast(primary, hero, 4.5, "lighter");
  const primaryOnHeroFg = readableOn(primaryOnHero);

  const sh = (a: number) => (dark ? `oklch(0 0 0 / ${a})` : `oklch(0.2 0.01 ${Math.round(B.h)} / ${a})`);
  const flat = (c: Oklch) => `linear-gradient(160deg, ${css(c)} 0%, ${css(c)} 100%)`;

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
    "--primary-accent-text": css(primary),
    "--secondary": css(secondary),
    "--secondary-foreground": css(foreground),
    "--muted": css(muted),
    "--muted-foreground": css(mutedFg),
    "--tertiary-foreground": css(tertiaryFg),
    "--accent": css(primary, washAlpha),
    "--accent-foreground": css(foreground),
    "--border": css(border),
    "--border-subtle": css(borderSubtle),
    "--border-strong": css(borderStrong),
    "--input": css(input),
    "--ring": css(primary, 0.55),
    "--focus-ring": css(primary),
    "--primary-on-hero": css(primaryOnHero),
    "--primary-on-hero-foreground": css(primaryOnHeroFg),

    "--chart-1": css(primary),

    "--surface": css(card),
    "--surface-elevated": css(elevated),
    "--surface-hero": css(hero),
    "--text-primary": css(foreground),
    "--text-secondary": css(mutedFg),

    "--sidebar": css(sidebar),
    "--sidebar-foreground": css(foreground),
    "--sidebar-primary": css(primary),
    "--sidebar-primary-foreground": css(primaryFg),
    "--sidebar-accent": css(primary, washAlpha),
    "--sidebar-accent-foreground": css(foreground),
    "--sidebar-border": css(border),
    "--sidebar-ring": css(primary, 0.55),

    "--shadow-tint-dark": dark ? "oklch(0 0 0 / 0.4)" : `oklch(0.2 0.01 ${Math.round(B.h)} / 0.07)`,
    "--gradient-hero": flat(hero),
    "--gradient-insight": flat(hero),
    "--gradient-accent": `linear-gradient(135deg, ${css(primary)}, ${css(primary)})`,
    "--glow-primary": `0 6px 18px -8px ${sh(dark ? 0.5 : 0.18)}`,
    "--shadow-card": `0 1px 2px ${sh(dark ? 0.3 : 0.05)}`,
    "--shadow-floating": `0 8px 24px -8px ${sh(dark ? 0.45 : 0.12)}`,
    "--shadow-dialog": `0 16px 40px -12px ${sh(dark ? 0.55 : 0.18)}`,
    "--shadow-command": `0 20px 48px -14px ${sh(dark ? 0.6 : 0.22)}`,
    "--shadow-notification": `0 10px 28px -10px ${sh(dark ? 0.5 : 0.16)}`,
    "--glass-bg": css(popover, 0.98),
  };

  if (info) {
    const sky: Oklch = { ...info, l: clamp(info.l + (dark ? 0.06 : 0.12), 0, 0.93) };
    const ice: Oklch = { ...info, l: clamp(info.l + (dark ? 0.1 : 0.2), 0, 0.95), c: info.c * 0.6 };
    tokens["--royal"] = css(info);
    tokens["--sky"] = css(sky);
    tokens["--ice"] = css(ice);
    tokens["--navy"] = css({ ...info, l: dark ? 0.5 : 0.36, c: info.c * 0.8 });
    tokens["--chart-2"] = css(info);
  }

  const fin = FINANCIAL[dark ? "dark" : "light"];
  const checks: ContrastCheck[] = [
    { label: "Text on page", ratio: contrast(foreground, background), target: 4.5 },
    { label: "Text on cards", ratio: contrast(foreground, card), target: 4.5 },
    { label: "Secondary text", ratio: contrast(mutedFg, card), target: 4.5 },
    { label: "Tertiary text", ratio: contrast(tertiaryFg, card), target: 4.5 },
    { label: "Button label on primary", ratio: contrast(primaryFg, primary), target: 4.5 },
    { label: "Primary as text and links", ratio: contrast(primary, card), target: 4.5 },
    { label: "Text on sidebar", ratio: contrast(foreground, sidebar), target: 4.5 },
    { label: "Primary on dark hero panels", ratio: contrast(primaryOnHero, hero), target: 4.5 },
    { label: "Text on hero panels", ratio: contrast(readableOn(hero), hero), target: 4.5 },
    ...(info ? [{ label: "Information colour on cards", ratio: contrast(info, card), target: 4.5 }] : []),
    { label: "Money In text", ratio: contrast(fin.success, card), target: 4.5 },
    { label: "Money Out text", ratio: contrast(fin.expense, card), target: 4.5 },
    { label: "Control borders", ratio: contrast(borderStrong, card), target: 3 },
  ].map((c) => ({ ...c, ratio: Math.round(c.ratio * 100) / 100, pass: c.ratio >= c.target }));

  return { tokens, checks };
}

// ---------------------------------------------------------------------------------------------------------------
// Colour naming + intelligent pairing suggestions
// ---------------------------------------------------------------------------------------------------------------

/** A friendly name for a colour, used in suggestion labels ("White + Blue"). */
export function colourName(hex: string): string {
  const { l, c, h } = hexToOklch(hex);
  if (c < 0.03) return l < 0.35 ? "Black" : l > 0.9 ? "White" : "Grey";
  const bins: [number, string][] = [
    [35, "Red"], [65, "Orange"], [100, "Amber"], [135, "Lime"], [175, "Green"], [215, "Teal"], [245, "Sky"], [280, "Blue"], [305, "Indigo"], [340, "Purple"], [360, "Pink"],
  ];
  return (bins.find(([max]) => h < max) ?? bins[0])[1];
}

export interface ComboSuggestion {
  id: string;
  label: string;
  base: string;
  secondary: string | null;
}

/** A muted slate in the primary's own family — the "quiet third colour" that adds hierarchy without noise. */
export function slateFor(primaryHex: string): string {
  const { h } = hexToOklch(primaryHex);
  return oklchToHex({ l: 0.5, c: 0.035, h });
}

/** Matching pairings for a primary colour: pure white, navy, graphite — and white with a quiet slate third colour. */
export function suggestCombos(primaryHex: string): ComboSuggestion[] {
  const name = colourName(primaryHex);
  return [
    { id: "white", label: `White + ${name}`, base: "white", secondary: null },
    { id: "navy", label: `Navy + ${name}`, base: "navy", secondary: null },
    { id: "graphite", label: `Graphite + ${name}`, base: "black", secondary: null },
    { id: "white-slate", label: `White + ${name} + Slate`, base: "white", secondary: slateFor(primaryHex) },
  ];
}

/**
 * Money In (emerald) and Money Out (coral) keep their own colours in every theme; a primary that sits in the same hue
 * range is allowed but flagged, because buttons and links in that hue read as "money" at a glance.
 */
export function financialClash(primaryHex: string): "in" | "out" | null {
  const { c, h } = hexToOklch(primaryHex);
  if (c < 0.06) return null;
  const near = (target: number) => Math.min(Math.abs(h - target), 360 - Math.abs(h - target)) < 22;
  if (near(165)) return "in";
  if (near(22)) return "out";
  return null;
}
