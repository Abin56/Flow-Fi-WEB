"use client";

/**
 * Immersive fullscreen for the whole app, using the native Fullscreen API (see fullscreen-api.ts).
 *
 *  - Browsers only allow fullscreen from a user gesture, so the first click / tap anywhere tries it once, and a small
 *    pill offers it in the meantime (and as the fallback if the browser refuses).
 *  - Dismissing the pill — or leaving fullscreen with Esc / the browser's own controls — is remembered, so neither the
 *    pill nor the automatic attempt comes back. Unsupported browsers (iPhone Safari) and installed/standalone windows
 *    show nothing at all.
 *  - Nothing here touches layout: the pill is a fixed overlay under dialogs, and fullscreen is on <html>.
 */

import { Expand, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { alreadyImmersive, enterFullscreen, fullscreenSupported, isFullscreen, subscribeFullscreen } from "./fullscreen-api";

const DISMISSED_KEY = "flowfi:fullscreen-dismissed";
const PROMPT_ATTR = "data-fullscreen-prompt";

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

const dismissListeners = new Set<() => void>();
let dismissedThisView = false;

function subscribeDismissed(onChange: () => void) {
  dismissListeners.add(onChange);
  return () => void dismissListeners.delete(onChange);
}

function writeDismissed() {
  dismissedThisView = true;
  dismissListeners.forEach((l) => l());
  try {
    window.localStorage.setItem(DISMISSED_KEY, "1");
  } catch {
    /* storage blocked — the dismissal lasts for this page view only */
  }
}

export function FullscreenPrompt() {
  const supported = useSyncExternalStore(subscribeFullscreen, fullscreenSupported, () => false);
  const fullscreen = useSyncExternalStore(subscribeFullscreen, isFullscreen, () => false);
  // Server / first render: dismissed + immersive, so nothing flashes before the real values are read.
  const dismissed = useSyncExternalStore(subscribeDismissed, () => dismissedThisView || readDismissed(), () => true);
  const immersive = useSyncExternalStore(subscribeFullscreen, alreadyImmersive, () => true);
  const [error, setError] = useState<string | null>(null);
  const wasFullscreen = useRef(false);
  const attempted = useRef(false);

  const dismiss = useCallback(() => {
    writeDismissed();
    setError(null);
  }, []);

  const enter = useCallback(async () => {
    try {
      await enterFullscreen();
      setError(null);
    } catch {
      setError("Your browser didn't allow full screen.");
    }
  }, []);

  // Leaving fullscreen on purpose (Esc, F11, browser UI) is a choice: remember it and stop offering.
  useEffect(() => {
    if (wasFullscreen.current && !fullscreen) dismiss();
    wasFullscreen.current = fullscreen;
  }, [fullscreen, dismiss]);

  // First real interaction anywhere: one automatic attempt. A refusal just leaves the pill in place.
  const active = supported && !dismissed && !immersive && !fullscreen;
  useEffect(() => {
    if (!active || attempted.current) return;
    const onGesture = (e: Event) => {
      if ((e.target as HTMLElement | null)?.closest?.(`[${PROMPT_ATTR}]`)) return;
      attempted.current = true;
      void enterFullscreen().catch(() => undefined);
    };
    document.addEventListener("click", onGesture, { once: true, capture: true });
    return () => document.removeEventListener("click", onGesture, true);
  }, [active]);

  if (!active) return null;

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center px-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
      {...{ [PROMPT_ATTR]: "" }}
    >
      <div
        role="region"
        aria-label="Fullscreen"
        data-testid="fullscreen-prompt"
        className="pointer-events-auto flex items-center gap-1 rounded-full border border-border bg-background/95 p-1 pl-1 shadow-lg backdrop-blur"
      >
        <Button type="button" size="sm" className="rounded-full" onClick={() => void enter()} data-testid="fullscreen-enter">
          <Expand data-icon="inline-start" aria-hidden />
          Enter full screen
        </Button>
        {error ? <span role="status" className="px-1 text-xs text-muted-foreground">{error}</span> : null}
        <Button type="button" variant="ghost" size="icon-sm" className="rounded-full" onClick={dismiss} aria-label="Dismiss fullscreen prompt" data-testid="fullscreen-dismiss">
          <X aria-hidden />
        </Button>
      </div>
    </div>
  );
}
