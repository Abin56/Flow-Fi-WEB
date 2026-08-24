"use client";

/**
 * Persists the Settings page's preference fields to localStorage, keyed per
 * signed-in user — this app's Firestore collections mirror the Flutter app's
 * schema byte-for-byte (see `lib/firestore/collections.ts`), so a new
 * web-only "user preferences" collection isn't added here; localStorage is
 * the appropriate persistence layer for this device-local settings surface.
 */

import { useEffect, useRef, useState } from "react";
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

/** Loads once per signed-in user, then keeps localStorage in sync with every change. */
export function useUserPreferences() {
  const uid = useAuthStore((s) => s.user?.uid);
  const [preferences, setPreferences] = useState<UserPreferences>(() => loadPreferences(uid));
  const loadedUidRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (uid !== loadedUidRef.current) {
      loadedUidRef.current = uid;
      setPreferences(loadPreferences(uid));
    }
  }, [uid]);

  useEffect(() => {
    if (!uid || typeof window === "undefined") return;
    window.localStorage.setItem(storageKey(uid), JSON.stringify(preferences));
  }, [uid, preferences]);

  function update<K extends keyof UserPreferences>(key: K, value: UserPreferences[K]) {
    setPreferences((prev) => ({ ...prev, [key]: value }));
  }

  return { preferences, update };
}
