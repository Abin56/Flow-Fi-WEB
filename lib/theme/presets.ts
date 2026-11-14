import type { ThemeSeed } from "./derive";

export interface ThemePreset {
  id: string;
  name: string;
  tagline: string;
  seed: ThemeSeed;
}

/** The shipped FlowFi look. Selecting it removes every override, so the stylesheet's own tokens apply untouched. */
export const DEFAULT_PRESET_ID = "flowfi";

export const THEME_PRESETS: ThemePreset[] = [
  {
    id: DEFAULT_PRESET_ID,
    name: "FlowFi Lime",
    tagline: "The signature look",
    seed: { primary: "#B9F65A", secondary: "#2F6FEB", accent: "#D6F59B", background: "#F5F6F3", sidebar: "#F9FAF8" },
  },
  {
    id: "ocean",
    name: "Ocean Blue",
    tagline: "Calm, trustworthy",
    seed: { primary: "#2563EB", secondary: "#0891B2", accent: "#7DB2F8", background: "#F4F7FB", sidebar: "#EAF0F9" },
  },
  {
    id: "emerald",
    name: "Emerald Ledger",
    tagline: "Growth and clarity",
    seed: { primary: "#059669", secondary: "#0E7490", accent: "#6EE7B7", background: "#F3F8F5", sidebar: "#E6F1EB" },
  },
  {
    id: "violet",
    name: "Royal Violet",
    tagline: "Refined, modern",
    seed: { primary: "#6D5BD0", secondary: "#2F6FEB", accent: "#B7A8F5", background: "#F6F5FB", sidebar: "#ECEAF7" },
  },
  {
    id: "teal",
    name: "Teal Harbor",
    tagline: "Fresh and focused",
    seed: { primary: "#0F766E", secondary: "#0369A1", accent: "#5EEAD4", background: "#F2F7F7", sidebar: "#E3EFEF" },
  },
  {
    id: "copper",
    name: "Sunset Copper",
    tagline: "Warm, grounded",
    seed: { primary: "#C2410C", secondary: "#A16207", accent: "#F8B86B", background: "#FAF6F2", sidebar: "#F3EAE0" },
  },
  {
    id: "rose",
    name: "Rose Quartz",
    tagline: "Soft, elegant",
    seed: { primary: "#BE185D", secondary: "#7C3AED", accent: "#F5A3C7", background: "#FBF5F7", sidebar: "#F5E8ED" },
  },
  {
    id: "gold",
    name: "Slate & Gold",
    tagline: "Understated luxury",
    seed: { primary: "#B7791F", secondary: "#475569", accent: "#EAC96A", background: "#F7F6F2", sidebar: "#ECEAE0" },
  },
  {
    id: "graphite",
    name: "Graphite",
    tagline: "Monochrome minimal",
    seed: { primary: "#3F3F46", secondary: "#52607A", accent: "#A1A1AA", background: "#F5F5F5", sidebar: "#EBEBEB" },
  },
];

export function findPreset(id: string): ThemePreset | undefined {
  return THEME_PRESETS.find((p) => p.id === id);
}

export interface DuoPreset {
  id: string;
  name: string;
  /** Colour 1 — the brand/primary colour. */
  a: string;
  /** Colour 2 — a neutral base (white, cream, black) or a second hue. */
  b: string;
}

/** Two-colour themes: everything else is derived by `seedFromDuo`. */
export const DUO_PRESETS: DuoPreset[] = [
  { id: "duo-black-white", name: "Black & White", a: "#111111", b: "#ffffff" },
  { id: "duo-blue-white", name: "Blue & White", a: "#1d4ed8", b: "#ffffff" },
  { id: "duo-navy-gold", name: "Navy & Gold", a: "#1e3a8a", b: "#c9a227" },
  { id: "duo-emerald-white", name: "Emerald & White", a: "#047857", b: "#ffffff" },
  { id: "duo-violet-white", name: "Violet & White", a: "#6d28d9", b: "#ffffff" },
  { id: "duo-maroon-cream", name: "Maroon & Cream", a: "#7f1d1d", b: "#faf3e3" },
  { id: "duo-teal-sand", name: "Teal & Sand", a: "#0f766e", b: "#f5efe3" },
  { id: "duo-slate-sky", name: "Slate & Sky", a: "#334155", b: "#38bdf8" },
  { id: "duo-white-black", name: "White & Black", a: "#ffffff", b: "#0a0a0a" },
  { id: "duo-lime-charcoal", name: "Lime & Charcoal", a: "#b9f65a", b: "#1a1c1a" },
];

export function findDuoPreset(id: string): DuoPreset | undefined {
  return DUO_PRESETS.find((p) => p.id === id);
}
