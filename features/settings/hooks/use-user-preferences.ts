"use client";

/**
 * Persists the Settings page's preference fields to localStorage, keyed per
 * signed-in user — this app's Firestore collections mirror the Flutter app's
 * schema byte-for-byte (see `lib/firestore/collections.ts`), so a new
 * web-only "user preferences" collection isn't added here; localStorage is
 * the appropriate persistence layer for this device-local settings surface.
 */

import { useEffect, useRef, useState } from "react";
import { normalizeCycleStartDay } from "@/lib/engines/month-cycle-range";
import { useAuthStore } from "@/store/auth-store";

export interface UserPreferences {
  phone: string;
  timezone: string;
  currency: string;
  defaultHomeView: string;
  defaultAccount: string;
  dateFormat: string;
  numberFormat: string;
  language: string;
  startWeekOn: string;
  /** The ONE global accounting-cycle start day (1-31) — e.g. 18 means each cycle runs the 18th
   *  through the 17th of the next month. Month Cycle, People Ledger/statements and Debt Planner
   *  all derive their cycle from it (`cycleRangeFor`). 1 (the default) is the plain calendar month.
   *
   *  KNOWN LIMITATION: Month Cycle preference is currently stored per user per browser/device.
   *  It is not yet synchronized across Web/Flutter devices.
   *
   *  Scope — which views use what:
   *  - GLOBAL ACCOUNTING CYCLE (this setting): Month Cycle; People Ledger / People statements;
   *    Debt Planner cycle calculations.
   *  - CALENDAR MONTH (intentionally not this setting): Dashboard "This month"; Bills page "This month";
   *    Budgets; Analytics; Reports; Credit Cards "Spent this month"; Transactions "This month".
   *  - OWN INDEPENDENT SCHEDULE (never this setting): credit-card statement cycle (card `statementDay`);
   *    Loan/EMI installment schedules. */
  monthCycleStartDay: number;
  /** When true, the Dashboard's Net Worth hero hides its amount behind the eye toggle. */
  hideNetWorth: boolean;
  biometricLock: boolean;
  autoLockMinutes: string;
  privacyMode: boolean;
  transactionAlerts: boolean;
  billReminders: boolean;
  emiReminders: boolean;
  budgetAlerts: boolean;
  marketingUpdates: boolean;
  monthlyBudget: number;
  betaFeatures: boolean;
  theme: string;
  accentColor: string;
  density: number;
  twoFactor: boolean;
  digestCategories: string[];
  channels: Record<string, Record<string, boolean>>;
  marketingEmails: boolean;
}

export const DEFAULT_PREFERENCES: UserPreferences = {
  phone: "",
  timezone: "ist",
  currency: "inr",
  defaultHomeView: "dashboard",
  defaultAccount: "select",
  dateFormat: "dd-mmm-yyyy",
  numberFormat: "indian",
  language: "en",
  startWeekOn: "monday",
  monthCycleStartDay: 1,
  hideNetWorth: false,
  biometricLock: true,
  autoLockMinutes: "5",
  privacyMode: false,
  transactionAlerts: true,
  billReminders: true,
  emiReminders: true,
  budgetAlerts: true,
  marketingUpdates: false,
  monthlyBudget: 25000,
  betaFeatures: true,
  theme: "system",
  accentColor: "var(--primary)",
  density: 50,
  twoFactor: true,
  digestCategories: ["bills", "budgets"],
  channels: {
    bills: { email: true, push: true, sms: false },
    budgets: { email: true, push: false, sms: false },
    security: { email: true, push: true, sms: true },
  },
  marketingEmails: false,
};

function storageKey(uid: string): string {
  return `flowfi:user-preferences:${uid}`;
}

function loadPreferences(uid: string | undefined): UserPreferences {
  if (!uid || typeof window === "undefined") return DEFAULT_PREFERENCES;
  try {
    const raw = window.localStorage.getItem(storageKey(uid));
    if (!raw) return DEFAULT_PREFERENCES;
    return { ...DEFAULT_PREFERENCES, ...(JSON.parse(raw) as Partial<UserPreferences>) };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

/** Fired (same tab) after a user-initiated change is written, so every other mounted instance reloads. */
const PREFERENCES_CHANGED_EVENT = "flowfi:user-preferences-changed";

/** Loads once per signed-in user, then keeps localStorage in sync with every change. */
export function useUserPreferences() {
  const uid = useAuthStore((s) => s.user?.uid);
  const [preferences, setPreferences] = useState<UserPreferences>(() => loadPreferences(uid));
  const loadedUidRef = useRef<string | undefined>(undefined);
  // Set only by `update` — a reload triggered by another instance must not re-broadcast (no ping-pong).
  const broadcastRef = useRef(false);

  useEffect(() => {
    if (uid !== loadedUidRef.current) {
      loadedUidRef.current = uid;
      setPreferences(loadPreferences(uid));
    }
  }, [uid]);

  useEffect(() => {
    if (!uid || typeof window === "undefined") return;
    window.localStorage.setItem(storageKey(uid), JSON.stringify(preferences));
    if (broadcastRef.current) {
      broadcastRef.current = false;
      window.dispatchEvent(new CustomEvent(PREFERENCES_CHANGED_EVENT, { detail: uid }));
    }
  }, [uid, preferences]);

  // Another instance in this tab (e.g. Settings) or another tab changed the stored preferences.
  useEffect(() => {
    if (!uid || typeof window === "undefined") return;
    const reload = () => setPreferences(loadPreferences(uid));
    const onLocal = (e: Event) => {
      if ((e as CustomEvent<string>).detail === uid) reload();
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === storageKey(uid)) reload();
    };
    window.addEventListener(PREFERENCES_CHANGED_EVENT, onLocal);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(PREFERENCES_CHANGED_EVENT, onLocal);
      window.removeEventListener("storage", onStorage);
    };
  }, [uid]);

  function update<K extends keyof UserPreferences>(key: K, value: UserPreferences[K]) {
    broadcastRef.current = true;
    setPreferences((prev) => ({ ...prev, [key]: value }));
  }

  return { preferences, update };
}

/**
 * The ONE accounting-cycle start day (Settings → Month cycle) every cycle-based view — Month Cycle,
 * People Ledger & statements, Debt Planner — resolves its cycle from, via `cycleRangeFor`.
 */
export function useMonthCycleStartDay(): number {
  return normalizeCycleStartDay(useUserPreferences().preferences.monthCycleStartDay);
}
