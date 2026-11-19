/**
 * Applies the user's theme to <html> as inline custom properties. Inline style on the root outranks both `:root` and
 * `.dark` rules in globals.css, so the override wins in either mode without touching the stylesheet. The default
 * (FlowFi Lime, Signature + Warm paper) applies nothing at all, because the stylesheet already is that theme — the
 * common case needs no JavaScript and cannot flash.
 *
 * Every other theme is "flat": `data-theme-flat` on <html> switches off the decorative primary-tinted gradient washes
 * (see globals.css), so a white theme stays white.
 *
 * Non-default themes are also cached in localStorage so `THEME_BOOT_SCRIPT` (inlined in <head>) can paint them before
 * React hydrates.
 */

import type { ThemeMode, TokenMap } from "./lime";
import { MANAGED_TOKEN_NAMES, type StoredTheme, isDefaultTheme, resolveTheme } from "./themes";

export { DEFAULT_THEME, type StoredTheme, sanitizeStoredTheme } from "./themes";

export const THEME_STORAGE_KEY = "flowfi:appearance-theme";
/** Bumped whenever the cached shape changes. Older keys belonged to previous engines and are removed on sight. */
export const THEME_CSS_CACHE_KEY = "flowfi:appearance-theme-css:v3";
const OLD_CACHE_KEYS = ["flowfi:appearance-theme-css", "flowfi:appearance-theme-css:v2"];
const FLAT_ATTR = "data-theme-flat";

export function applyTokens(tokens: TokenMap | null, root: HTMLElement = document.documentElement): void {
  // Clear by name rather than by what this module set last: the boot script may have painted tokens before any
  // JavaScript here ran, and those must be removable too.
  for (const name of MANAGED_TOKEN_NAMES) root.style.removeProperty(name);
  if (!tokens) return;
  for (const [name, value] of Object.entries(tokens)) root.style.setProperty(name, value);
}

function setFlat(flat: boolean, root: HTMLElement = document.documentElement): void {
  if (flat) root.setAttribute(FLAT_ATTR, "");
  else root.removeAttribute(FLAT_ATTR);
}

function dropCache(): void {
  try {
    window.localStorage.removeItem(THEME_CSS_CACHE_KEY);
    for (const k of OLD_CACHE_KEYS) window.localStorage.removeItem(k);
  } catch {
    /* storage unavailable — the theme still applies for this session */
  }
}

/** Applies the theme for `mode` and refreshes the pre-paint cache (both modes, so a later flip needs no work). */
export function applyTheme(theme: StoredTheme, mode: ThemeMode): void {
  if (isDefaultTheme(theme)) {
    applyTokens(null);
    setFlat(false);
    dropCache();
    return;
  }
  const light = resolveTheme(theme, "light");
  const dark = resolveTheme(theme, "dark");
  const active = mode === "dark" ? dark : light;
  applyTokens(active.tokens);
  setFlat(active.flat);
  try {
    window.localStorage.setItem(THEME_CSS_CACHE_KEY, JSON.stringify({ light: light.tokens, dark: dark.tokens, flat: active.flat }));
    for (const k of OLD_CACHE_KEYS) window.localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
}

/** Runs before first paint (after next-themes' own class script). Must stay dependency-free. */
export const THEME_BOOT_SCRIPT = `(function(){try{var c=localStorage.getItem(${JSON.stringify(
  THEME_CSS_CACHE_KEY,
)});if(!c)return;var m=JSON.parse(c);var d=document.documentElement;var t=d.classList.contains('dark')?m.dark:m.light;if(!t)return;for(var k in t){d.style.setProperty(k,t[k]);}if(m.flat)d.setAttribute(${JSON.stringify(
  FLAT_ATTR,
)},'');}catch(e){}})();`;
