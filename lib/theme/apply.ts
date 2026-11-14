/**
 * Applies a derived token map to <html> as inline custom properties. Inline style on the root outranks both
 * `:root` and `.dark` rules in globals.css, so the override wins in either mode without touching the stylesheet;
 * clearing it restores the stock FlowFi look exactly.
 *
 * The resulting maps are also cached in localStorage so `THEME_BOOT_SCRIPT` (inlined in <head>) can paint the
 * saved theme before React hydrates — no flash of the default colours.
 */

import { type ThemeMode, type ThemeSeed, type TokenMap, deriveTheme } from "./derive";
import { DEFAULT_PRESET_ID } from "./presets";

export const THEME_STORAGE_KEY = "flowfi:appearance-theme";
export const THEME_CSS_CACHE_KEY = "flowfi:appearance-theme-css";

export interface StoredTheme {
  /** A preset id (full or two-colour), "duo" for a custom two-colour pair, or "custom" for individual colours. */
  presetId: string;
  seed: ThemeSeed;
  /** The two colours behind a two-colour theme, so the pickers can show them again. */
  duo?: [string, string];
}

const managed = new Set<string>();

export function applyTokens(tokens: TokenMap | null, root: HTMLElement = document.documentElement): void {
  managed.forEach((name) => root.style.removeProperty(name));
  managed.clear();
  if (!tokens) return;
  for (const [name, value] of Object.entries(tokens)) {
    root.style.setProperty(name, value);
    managed.add(name);
  }
}

/** Derives + applies the theme for `mode` and refreshes the pre-paint cache for both modes. */
export function applyTheme(theme: StoredTheme, mode: ThemeMode): void {
  if (theme.presetId === DEFAULT_PRESET_ID) {
    applyTokens(null);
    try {
      window.localStorage.removeItem(THEME_CSS_CACHE_KEY);
    } catch {
      /* storage unavailable — theme still applies for this session */
    }
    return;
  }
  const light = deriveTheme(theme.seed, "light").tokens;
  const dark = deriveTheme(theme.seed, "dark").tokens;
  applyTokens(mode === "dark" ? dark : light);
  try {
    window.localStorage.setItem(THEME_CSS_CACHE_KEY, JSON.stringify({ light, dark }));
  } catch {
    /* ignore */
  }
}

/** Runs before first paint (after next-themes' own class script). Must stay dependency-free. */
export const THEME_BOOT_SCRIPT = `(function(){try{var c=localStorage.getItem(${JSON.stringify(
  THEME_CSS_CACHE_KEY,
)});if(!c)return;var m=JSON.parse(c);var t=document.documentElement.classList.contains('dark')?m.dark:m.light;if(!t)return;var s=document.documentElement.style;for(var k in t){s.setProperty(k,t[k]);}}catch(e){}})();`;
