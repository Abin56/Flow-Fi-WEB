/**
 * Theme engine core: turns five seed colours (primary, secondary, accent, background, sidebar) into the
 * full set of FlowFi CSS design tokens for light or dark mode. Every token the app reads (see
 * app/globals.css) that carries brand colour or neutral tint is derived here, with text, borders,
 * focus rings and "primary as text" colours automatically nudged to keep WCAG-level contrast.
 */

import { type Oklch, contrast, css, ensureContrast, hexToOklch, oklchToHex, readableOn } from "./color";

export interface ThemeSeed {
  primary: string;
  secondary: string;
  accent: string;
  background: string;
  sidebar: string;
}

export type ThemeMode = "light" | "dark";
export type TokenMap = Record<string, string>;

export interface ContrastCheck {
  label: string;
  ratio: number;
  /** Minimum we aim for (4.5 body text, 3 for large text / UI parts). */
  target: number;
  pass: boolean;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

interface Derived {
  tokens: TokenMap;
  checks: ContrastCheck[];
}

export function deriveTheme(seed: ThemeSeed, mode: ThemeMode): Derived {
  const dark = mode === "dark";
  const p0 = hexToOklch(seed.primary);
  const sec0 = hexToOklch(seed.secondary);
  const acc0 = hexToOklch(seed.accent);
  const bg0 = hexToOklch(seed.background);
  const sb0 = hexToOklch(seed.sidebar);

  const tint = clamp(bg0.c, 0, 0.03); // neutral tint carried by every surface
  const H = bg0.h;
  const N = (l: number, c = tint, h = H): Oklch => ({ l, c, h });

  // ---- surfaces & neutrals ----
  const background = dark ? N(0.145, tint * 0.6) : N(clamp(bg0.l, 0.93, 0.985));
  const card = dark ? N(0.195, tint * 0.6) : N(0.995, tint * 0.25);
  const popover = dark ? N(0.225, tint * 0.6) : card;
  const elevated = dark ? N(0.225, tint * 0.6) : N(0.98, tint * 0.5);
  const secondary = dark ? N(0.24, tint * 0.6) : N(clamp(background.l - 0.012, 0.9, 0.98), tint * 1.2);
  const muted = dark ? N(0.26, tint * 0.6) : secondary;
  const foreground = dark ? N(0.965, 0.004) : N(0.225, clamp(tint, 0.004, 0.015));
  const mutedFg = ensureContrast(dark ? N(0.685, 0.006) : N(0.44, 0.008), card, 4.5, dark ? "lighter" : "darker");
  const tertiaryFg = ensureContrast(dark ? N(0.62, 0.006) : N(0.52, 0.008), card, 4.5, dark ? "lighter" : "darker");
  const border = dark ? N(0.32, tint * 0.8) : N(0.8, tint);
  const borderSubtle = dark ? border : N(0.87, tint * 0.8);
  const borderStrong = dark ? N(0.47, tint * 0.8) : N(0.66, tint);
  const input = dark ? N(0.215, tint * 0.6) : N(0.78, tint);

  // ---- primary ----
  // Light mode allows deep primaries (black, navy, maroon); dark mode lifts them so they still read on dark surfaces.
  let primary: Oklch = { ...p0, l: dark ? clamp(p0.l, 0.7, 0.93) : clamp(p0.l, 0.18, 0.93) };
  // A near-white, low-chroma primary would vanish against light cards — flip it to a deep tone of the same hue.
  if (!dark && primary.c < 0.06 && contrast(primary, card) < 1.3) primary = { ...primary, l: 0.25 };
  const primaryHover: Oklch = { l: clamp(primary.l - 0.045, 0, 1), c: primary.c + 0.01, h: primary.h };
  const primaryFg = readableOn(primary);
  const accentText = ensureContrast(primary, card, 4.5, dark ? "lighter" : "darker");
  const focusRing = accentText;

  // ---- secondary → "information" blue family (royal/sky/ice), used for transfers, charts, info ----
  const royal = ensureContrast({ ...sec0, l: dark ? clamp(sec0.l, 0.72, 0.9) : clamp(sec0.l, 0.4, 0.62) }, card, 3, dark ? "lighter" : "darker");
  const sky: Oklch = { ...royal, l: clamp(royal.l + 0.1, 0, 0.92) };
  const ice: Oklch = { ...royal, l: clamp(royal.l + 0.17, 0, 0.94), c: royal.c * 0.7 };

  // ---- accent → soft selected/hover wash ----
  const accentWash = css({ ...acc0, l: dark ? clamp(acc0.l, 0.7, 0.92) : clamp(acc0.l, 0.5, 0.9) }, dark ? 0.16 : 0.2);

  const accentEnd: Oklch = { ...acc0, l: dark ? clamp(acc0.l, 0.7, 0.92) : clamp(acc0.l, 0.5, 0.93) };

  // ---- sidebar ----
  const sbTint = clamp(sb0.c, 0, 0.035);
  const sidebar = dark ? { l: 0.165, c: sbTint * 0.6, h: sb0.h } : { l: clamp(sb0.l, 0.9, 0.985), c: sbTint, h: sb0.h };

  // ---- hero (always a dark anchor, tinted by the brand hue) ----
  const heroHue = primary.c > 0.02 ? primary.h : H;
  const heroA = css({ l: dark ? 0.1 : 0.19, c: 0.03, h: heroHue });
  const heroB = css({ l: dark ? 0.06 : 0.135, c: 0.02, h: heroHue });
  const heroRef: Oklch = { l: dark ? 0.08 : 0.16, c: 0.025, h: heroHue };
  // Hero headers/bars use `text-primary` / `bg-primary` on that dark anchor; a deep primary (black, navy) gets a
  // lifted twin there, applied by the `.bg-surface-hero` scope in globals.css.
  const primaryOnHero = ensureContrast(primary, heroRef, 4.5, "lighter");
  const primaryOnHeroFg = readableOn(primaryOnHero);

  const sh = (a: number) => (dark ? `oklch(0 0 0 / ${a})` : `oklch(0.135 0.02 ${Math.round(H)} / ${a})`);

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
    "--accent-foreground": css(foreground),
    "--border": css(border),
    "--border-subtle": css(borderSubtle),
    "--border-strong": css(borderStrong),
    "--input": css(input),
    "--ring": css(primary, dark ? 0.6 : 0.75),
    "--focus-ring": css(focusRing),
    "--primary-on-hero": css(primaryOnHero),
    "--primary-on-hero-foreground": css(primaryOnHeroFg),

    "--royal": css(royal),
    "--sky": css(sky),
    "--ice": css(ice),
    "--chart-1": css(primary),
    "--chart-2": css(royal),

    "--surface": css(card),
    "--surface-elevated": css(elevated),
    "--surface-hero": heroB,
    "--text-primary": css(foreground),
    "--text-secondary": css(mutedFg),

    "--sidebar": css(sidebar),
    "--sidebar-foreground": css(foreground),
    "--sidebar-primary": css(primary),
    "--sidebar-primary-foreground": css(primaryFg),
    "--sidebar-accent": accentWash,
    "--sidebar-accent-foreground": css(foreground),
    "--sidebar-border": css(border),
    "--sidebar-ring": css(primary, dark ? 0.6 : 0.75),

    "--shadow-tint-dark": sh(dark ? 0.4 : 0.08),
    "--gradient-hero": `linear-gradient(160deg, ${heroA} 0%, ${heroB} 100%)`,
    "--gradient-insight": `linear-gradient(135deg, ${heroA} 0%, ${heroB} 100%)`,
    "--gradient-accent": `linear-gradient(135deg, ${css(primary)}, ${css(accentEnd)})`,
    "--glow-primary": `0 8px 24px -8px ${css(primary, dark ? 0.25 : 0.35)}`,
    "--shadow-card": `0 1px 2px ${sh(dark ? 0.3 : 0.04)}`,
    "--shadow-floating": `0 8px 24px -8px ${sh(dark ? 0.45 : 0.12)}`,
    "--shadow-dialog": `0 16px 40px -12px ${sh(dark ? 0.55 : 0.18)}`,
    "--shadow-command": `0 20px 48px -14px ${sh(dark ? 0.6 : 0.22)}`,
    "--shadow-notification": `0 10px 28px -10px ${sh(dark ? 0.5 : 0.16)}`,
    "--glass-bg": css(popover, 0.98),
  };

  const checks: ContrastCheck[] = [
    { label: "Text on page", ratio: contrast(foreground, background), target: 4.5 },
    { label: "Text on cards", ratio: contrast(foreground, card), target: 4.5 },
    { label: "Secondary text", ratio: contrast(mutedFg, card), target: 4.5 },
    { label: "Button label on primary", ratio: contrast(primaryFg, primary), target: 4.5 },
    { label: "Primary as text on cards", ratio: contrast(accentText, card), target: 4.5 },
    { label: "Text on sidebar", ratio: contrast(foreground, sidebar), target: 4.5 },
    { label: "Primary on hero panels", ratio: contrast(primaryOnHero, heroRef), target: 4.5 },
    { label: "Info colour on cards", ratio: contrast(royal, card), target: 3 },
  ].map((c) => ({ ...c, ratio: Math.round(c.ratio * 100) / 100, pass: c.ratio >= c.target }));

  return { tokens, checks };
}

/**
 * Smart coordination: from one primary colour, recommend a harmonious secondary, accent, background and
 * sidebar so the set stays calm and professional (analogous secondary, lighter complementary-leaning accent,
 * barely-tinted neutrals).
 */
export function suggestFromPrimary(primaryHex: string): ThemeSeed {
  const p = hexToOklch(primaryHex);
  const chroma = Math.min(p.c, 0.16);
  const hex = (l: number, c: number, h: number) => oklchToHex({ l, c, h });
  return {
    primary: primaryHex,
    secondary: hex(0.55, Math.max(chroma * 0.85, 0.06), (p.h + 35) % 360),
    accent: hex(0.78, Math.max(chroma * 0.8, 0.07), (p.h + 180 + 25) % 360),
    background: hex(0.965, Math.min(0.012, chroma * 0.15), p.h),
    sidebar: hex(0.945, Math.min(0.018, chroma * 0.22), p.h),
  };
}

/** True when a colour reads as a neutral base (white, cream, grey, charcoal, black) rather than a brand hue. */
export function isNeutralBase(hex: string): boolean {
  const c = hexToOklch(hex);
  return c.c < 0.045 || c.l > 0.95 || c.l < 0.22;
}

/** Whether a two-colour pair resolves to a dark base (e.g. "White & Black") — the UI then switches to dark mode. */
export function duoPrefersDark(colorA: string, colorB: string): boolean {
  const [, base] = orderDuo(colorA, colorB);
  return base !== null && hexToOklch(base).l < 0.5;
}

/**
 * Puts the brand colour first and finds the base. Colour 2 is the base when it is neutral (white, cream, black);
 * a near-white Colour 1 paired with a real hue swaps places, so "White & Blue" == "Blue & White".
 */
function orderDuo(a: string, b: string): [string, string | null] {
  const A = hexToOklch(a);
  const bNeutral = isNeutralBase(b);
  if (A.l > 0.9 && A.c < 0.05 && !bNeutral) return [b, a];
  if (bNeutral) return [a, b];
  return [a, null]; // two real hues: b becomes the secondary, base stays a calm neutral
}

/**
 * Two-colour themes: Colour 1 is the brand/primary colour. Colour 2 becomes the base (page, cards, sidebar) when
 * it is a neutral like white, cream or black — otherwise it becomes the secondary on a calm neutral base.
 * Everything else (accent, borders, text, hero) is derived.
 */
export function seedFromDuo(colorA: string, colorB: string): ThemeSeed {
  const [primaryHex, base] = orderDuo(colorA, colorB);
  const secondHue = base === null ? (primaryHex === colorA ? colorB : colorA) : null;
  const p = hexToOklch(primaryHex);
  const suggested = suggestFromPrimary(primaryHex);
  const mono = p.c < 0.045; // black / grey / white primary
  const hex = (l: number, c: number, h: number) => oklchToHex({ l, c, h });

  // On a neutral base the secondary stays in the primary's own family (muted), so the theme reads as two colours.
  const secondary = secondHue ?? (mono ? "#5b6477" : hex(0.52, Math.min(p.c * 0.45, 0.08) + 0.02, p.h));
  const accentFrom = secondHue ? hexToOklch(secondHue) : p;
  const accent = mono && !secondHue ? "#b4b8c0" : hex(0.8, Math.max(Math.min(accentFrom.c, 0.14), 0.05), accentFrom.h);

  if (base) {
    const b = hexToOklch(base);
    const tintC = Math.min(b.c, 0.03);
    // Surfaces read only the base's hue/tint in dark mode; light mode uses its lightness (capped to a soft canvas).
    const bgL = b.l < 0.5 ? 0.965 : Math.min(Math.max(b.l, 0.94), 0.985);
    return {
      primary: primaryHex,
      secondary,
      accent,
      background: hex(bgL, tintC, b.h),
      sidebar: hex(Math.max(bgL - 0.025, 0.92), Math.min(tintC * 1.3, 0.035), b.h),
    };
  }
  return { primary: primaryHex, secondary, accent, background: suggested.background, sidebar: suggested.sidebar };
}
