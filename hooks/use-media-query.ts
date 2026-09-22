"use client";

import { useSyncExternalStore } from "react";

function subscribe(query: string, onChange: () => void) {
  const mql = window.matchMedia(query);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

/**
 * SSR-safe `matchMedia` read via `useSyncExternalStore` — snapshot is `false` on the server/first
 * paint (`getServerSnapshot`) and the real live value on the client, so a dialog/sheet can switch
 * by breakpoint without the "setState synchronously in an effect" cascading-render footgun.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => subscribe(query, onChange),
    () => window.matchMedia(query).matches,
    () => false,
  );
}
