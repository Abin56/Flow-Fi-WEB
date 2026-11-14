"use client";

import { create } from "zustand";
import { THEME_STORAGE_KEY, type StoredTheme } from "@/lib/theme/apply";
import { isHex } from "@/lib/theme/color";
import { type ThemeSeed, seedFromDuo } from "@/lib/theme/derive";
import { DEFAULT_PRESET_ID, THEME_PRESETS, findDuoPreset, findPreset } from "@/lib/theme/presets";

const DEFAULT_THEME: StoredTheme = { presetId: DEFAULT_PRESET_ID, seed: THEME_PRESETS[0].seed };

function sanitize(raw: unknown): StoredTheme {
  if (!raw || typeof raw !== "object") return DEFAULT_THEME;
  const r = raw as Partial<StoredTheme>;
  const s = r.seed as Partial<ThemeSeed> | undefined;
  const keys: (keyof ThemeSeed)[] = ["primary", "secondary", "accent", "background", "sidebar"];
  if (!s || !keys.every((k) => typeof s[k] === "string" && isHex(s[k] as string))) return DEFAULT_THEME;
  const known = (id: string) => id === "custom" || id === "duo" || !!findPreset(id) || !!findDuoPreset(id);
  const presetId = typeof r.presetId === "string" && known(r.presetId) ? r.presetId : "custom";
  const duo = Array.isArray(r.duo) && r.duo.length === 2 && r.duo.every((c) => typeof c === "string" && isHex(c)) ? (r.duo as [string, string]) : undefined;
  return { presetId, seed: s as ThemeSeed, ...(duo ? { duo } : {}) };
}

function load(): StoredTheme {
  if (typeof window === "undefined") return DEFAULT_THEME;
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    return raw ? sanitize(JSON.parse(raw)) : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

function persist(theme: StoredTheme) {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(theme));
  } catch {
    /* ignore — theme still applies this session */
  }
}

interface ThemeState {
  theme: StoredTheme;
  hydrated: boolean;
  hydrate: () => void;
  selectPreset: (id: string) => void;
  /** Edits one colour; the theme becomes "custom". */
  setColor: (key: keyof ThemeSeed, hex: string) => void;
  /** Replaces the whole seed (smart-coordination result); the theme becomes "custom". */
  setSeed: (seed: ThemeSeed) => void;
  /** Two-colour theme: derives the full seed from Colour 1 + Colour 2. `presetId` defaults to "duo" (custom pair). */
  setDuo: (a: string, b: string, presetId?: string) => void;
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
    selectPreset: (id) => {
      const preset = findPreset(id);
      if (preset) commit({ presetId: preset.id, seed: preset.seed });
    },
    setColor: (key, hex) => {
      if (!isHex(hex)) return;
      commit({ presetId: "custom", seed: { ...get().theme.seed, [key]: hex } });
    },
    setSeed: (seed) => commit({ presetId: "custom", seed }),
    setDuo: (a, b, presetId = "duo") => {
      if (!isHex(a) || !isHex(b)) return;
      commit({ presetId, seed: seedFromDuo(a, b), duo: [a, b] });
    },
    reset: () => commit(DEFAULT_THEME),
  };
});
