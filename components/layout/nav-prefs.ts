"use client";

import { useSyncExternalStore } from "react";
import { DEFAULT_PINS, NAV_BY_HREF } from "@/components/layout/nav-items";

/**
 * Per-device navigation preferences: the pages pinned to "Quick access" and the pages visited most recently.
 * Presentation only — nothing here touches financial data. Stored in localStorage; every read/write is guarded so a
 * blocked/full/private-mode storage just means "defaults, nothing remembered".
 */
export interface NavPrefs {
  pins: string[];
  /** Most recent first; index 0 is the page you are on now. */
  recents: string[];
}

export const MAX_PINS = 4;
export const MAX_RECENTS = 6;
const STORAGE_KEY = "flowfi.nav.v1";

const DEFAULTS: NavPrefs = { pins: DEFAULT_PINS, recents: [] };

/** Keep only known, unique routes (a renamed/removed page must not leave a dead tile behind). */
export function sanitizeHrefs(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) if (typeof v === "string" && NAV_BY_HREF.has(v) && !out.includes(v)) out.push(v);
  return out.slice(0, max);
}

/** Pin/unpin. Pinning is refused (same array returned) when the row of tiles is already full. */
export function togglePinned(pins: string[], href: string): string[] {
  if (pins.includes(href)) return pins.filter((h) => h !== href);
  if (pins.length >= MAX_PINS) return pins;
  return [...pins, href];
}

/** Move a visited page to the front, without duplicates, capped. Returns the same array when nothing changes. */
export function pushRecent(recents: string[], href: string): string[] {
  if (recents[0] === href) return recents;
  return [href, ...recents.filter((h) => h !== href)].slice(0, MAX_RECENTS);
}

/** The page to flip back to: the most recent one that is not the current page. */
export function previousPage(recents: string[], currentHref: string | undefined): string | undefined {
  return recents.find((h) => h !== currentHref);
}

let state: NavPrefs = DEFAULTS;
let loaded = false;
const listeners = new Set<() => void>();

function load(): void {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Partial<NavPrefs>;
    const pins = Array.isArray(parsed.pins) ? sanitizeHrefs(parsed.pins, MAX_PINS) : DEFAULT_PINS;
    state = { pins, recents: sanitizeHrefs(parsed.recents, MAX_RECENTS) };
  } catch {
    /* unreadable storage → defaults */
  }
}

function commit(next: NavPrefs): void {
  if (next.pins === state.pins && next.recents === state.recents) return;
  state = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* storage full/blocked → still works for this session */
  }
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  load();
  listeners.add(listener);
  // Another tab changed the preferences → pick them up.
  const onStorage = (e: StorageEvent) => {
    if (e.key !== STORAGE_KEY) return;
    loaded = false;
    state = DEFAULTS;
    load();
    listeners.forEach((l) => l());
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

const getSnapshot = (): NavPrefs => {
  load();
  return state;
};
const getServerSnapshot = (): NavPrefs => DEFAULTS;

export function useNavPrefs(): NavPrefs {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Non-hook read for event handlers (keyboard shortcuts). */
export function readNavPrefs(): NavPrefs {
  return getSnapshot();
}

export function togglePin(href: string): void {
  load();
  commit({ ...state, pins: togglePinned(state.pins, href) });
}

export function recordVisit(href: string): void {
  load();
  commit({ ...state, recents: pushRecent(state.recents, href) });
}
