"use client";

import { create } from "zustand";
import { THEME_STORAGE_KEY } from "@/lib/theme/apply";
import { isHex } from "@/lib/theme/color";
import { findAccent, findSurface } from "@/lib/theme/lime";
import { findBase } from "@/lib/theme/palette";
import { CUSTOM_ID, type CustomSpec, DEFAULT_THEME, type StoredTheme, findTheme, sanitizeStoredTheme } from "@/lib/theme/themes";

function persist(theme: StoredTheme) {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(theme));
  } catch {
    /* ignore — the choice still applies this session */
  }
}

/** Reads the saved choice. A value left by an older picker is mapped to the current model and rewritten. */
function load(): StoredTheme {
  if (typeof window === "undefined") return DEFAULT_THEME;
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    const { theme, migrated } = sanitizeStoredTheme(raw ? JSON.parse(raw) : null);
    if (migrated) persist(theme);
    return theme;
  } catch {
    return DEFAULT_THEME;
  }
}

interface ThemeState {
  theme: StoredTheme;
  hydrated: boolean;
  hydrate: () => void;
  /** Picks FlowFi Lime or a preset from the gallery. */
  selectTheme: (id: string) => void;
  /** FlowFi Lime's own options. */
  setAccent: (id: string) => void;
  setSurface: (id: string) => void;
  /** Edits the custom theme and makes it the active one. */
  setCustom: (patch: Partial<CustomSpec>) => void;
  /** Copies a preset's colours into the custom theme (so a preset can be tweaked) and activates it. */
  customizeFrom: (id: string) => void;
  reset: () => void;
}

export const useThemeStore = create<ThemeState>((set, get) => {
  const commit = (theme: StoredTheme) => {
    persist(theme);
    set({ theme });
  };
  return {
    theme: DEFAULT_THEME,
    hydrated: false,
    hydrate: () => {
      if (get().hydrated) return;
      set({ theme: load(), hydrated: true });
    },
    selectTheme: (id) => {
      if (id === "lime" || id === CUSTOM_ID || findTheme(id)) commit({ ...get().theme, id });
    },
    setAccent: (id) => {
      if (findAccent(id)) commit({ ...get().theme, id: "lime", accent: id });
    },
    setSurface: (id) => {
      if (findSurface(id)) commit({ ...get().theme, id: "lime", surface: id });
    },
    setCustom: (patch) => {
      const cur = get().theme.custom;
      const next: CustomSpec = {
        base: patch.base !== undefined && findBase(patch.base) ? patch.base : cur.base,
        primary: patch.primary !== undefined && isHex(patch.primary) ? patch.primary.toLowerCase() : cur.primary,
        secondary: patch.secondary === undefined ? cur.secondary : patch.secondary === null ? null : isHex(patch.secondary) ? patch.secondary.toLowerCase() : cur.secondary,
      };
      commit({ ...get().theme, id: CUSTOM_ID, custom: next });
    },
    customizeFrom: (id) => {
      const spec = findTheme(id)?.spec;
      if (!spec) return;
      commit({ ...get().theme, id: CUSTOM_ID, custom: { base: spec.base, primary: spec.primary, secondary: spec.secondary ?? null } });
    },
    reset: () => commit(DEFAULT_THEME),
  };
});
