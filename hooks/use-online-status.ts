"use client";

import { useEffect, useState } from "react";

/**
 * Tracks browser connectivity via `navigator.onLine` plus the `online`/
 * `offline` window events — device-level network presence, not whether
 * Firestore's own connection is currently healthy (those can differ, e.g. a
 * captive portal), but it's the signal the browser actually gives us, and
 * it's what every other finance app's "you're offline" banner is built on
 * too. Before this hook existed, the app had no connectivity detection at
 * all — a dropped connection left every live Firestore listener stalled on
 * stale data with nothing telling the user why (production-readiness audit
 * finding: "no offline/connectivity handling anywhere in the app").
 */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));

  useEffect(() => {
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  return online;
}
