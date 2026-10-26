"use client";

import { useCallback, useEffect, useState } from "react";
import { ANDROID_RELEASE_MANIFEST_PATH, parseAndroidRelease, type AndroidRelease } from "@/lib/sms-pairing/android-release";

/**
 * - `loading`     — still asking.
 * - `ready`       — a complete, valid manifest describes a real APK.
 * - `unavailable` — the site answered, but there's no valid manifest (never published, or malformed).
 * - `error`       — the request itself failed (offline, blocked) — availability is unknown, so callers offer a retry
 *                   and never claim the release is missing.
 */
export type AndroidReleaseState = { status: "loading" } | { status: "unavailable" } | { status: "error" } | { status: "ready"; release: AndroidRelease };

/** Reads the published Android build description from this site's own hosting (same origin as the page). */
export function useAndroidRelease(): AndroidReleaseState & { retry: () => void } {
  const [state, setState] = useState<AndroidReleaseState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch(ANDROID_RELEASE_MANIFEST_PATH, { cache: "no-store", signal: controller.signal });
        const release = res.ok && (res.headers.get("content-type") ?? "").includes("json") ? parseAndroidRelease(await res.json(), window.location.origin) : null;
        if (!controller.signal.aborted) setState(release ? { status: "ready", release } : { status: "unavailable" });
      } catch {
        if (!controller.signal.aborted) setState({ status: "error" });
      }
    })();
    return () => controller.abort();
  }, [attempt]);

  const retry = useCallback(() => {
    setState({ status: "loading" });
    setAttempt((a) => a + 1);
  }, []);

  return { ...state, retry };
}
