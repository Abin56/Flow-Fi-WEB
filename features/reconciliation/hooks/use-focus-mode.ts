"use client";

/**
 * Focus Mode + browser fullscreen for the reconciliation workspace — view-only, nothing about the review changes.
 *
 *  - Focus Mode hides the app sidebar and topbar (via the shell's workspace-focus store), so the two sheets, the dock
 *    and the approval bar get the whole viewport. It works everywhere, phones included, and never needs fullscreen.
 *  - Fullscreen asks the browser (Fullscreen API, only from a click) to fill the screen with the page, and turns Focus
 *    Mode on with it. The whole document goes fullscreen, never one element, so dialogs and popovers (portalled to
 *    <body>) stay visible. Leaving fullscreen (Esc, the browser's own UI) also leaves the Focus Mode it turned on.
 *    Unsupported or refused: Focus Mode alone, with a short notice.
 *  - Escape leaves Focus Mode only when nothing else wants it: no dialog or popover open, not typing, not inside a
 *    sheet (the sheets give Escape their own meaning).
 * Focus Mode always ends when the workspace unmounts, so no other page ever sees it.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useWorkspaceFocusStore } from "@/store/workspace-focus-store";

/** The header button that toggles Focus Mode — focus goes back to it on exit, never to <body>. */
export const FOCUS_TOGGLE_TESTID = "focus-mode-toggle";

const OVERLAY = '[role="dialog"], [role="menu"], [role="listbox"], [data-radix-popper-content-wrapper]';

function fullscreenSupported(): boolean {
  return typeof document !== "undefined" && document.fullscreenEnabled === true && typeof document.documentElement.requestFullscreen === "function";
}

function subscribeFullscreen(onChange: () => void) {
  document.addEventListener("fullscreenchange", onChange);
  return () => document.removeEventListener("fullscreenchange", onChange);
}

function isTyping(el: HTMLElement | null): boolean {
  if (!el) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable;
}

function returnFocusToToggle() {
  requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-testid="${FOCUS_TOGGLE_TESTID}"]`)?.focus());
}

export function useFocusMode() {
  const focus = useWorkspaceFocusStore((s) => s.active);
  const setActive = useWorkspaceFocusStore((s) => s.setActive);
  const fullscreen = useSyncExternalStore(subscribeFullscreen, () => document.fullscreenElement != null, () => false);
  const canFullscreen = useSyncExternalStore(subscribeFullscreen, fullscreenSupported, () => false);
  const [notice, setNotice] = useState<string | null>(null);
  /** Focus Mode that fullscreen turned on — leaving fullscreen leaves it too. */
  const fromFullscreen = useRef(false);

  const exitFocus = useCallback(() => {
    fromFullscreen.current = false;
    if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => undefined);
    setActive(false);
    returnFocusToToggle();
  }, [setActive]);

  const toggleFocus = useCallback(() => {
    if (useWorkspaceFocusStore.getState().active) exitFocus();
    else {
      setNotice(null);
      setActive(true);
    }
  }, [exitFocus, setActive]);

  const toggleFullscreen = useCallback(async () => {
    if (document.fullscreenElement) {
      await document.exitFullscreen?.().catch(() => undefined);
      return;
    }
    const wasFocused = useWorkspaceFocusStore.getState().active;
    setActive(true);
    if (!fullscreenSupported()) {
      setNotice("This browser can't go full screen here — Focus Mode is on instead.");
      return;
    }
    try {
      await document.documentElement.requestFullscreen({ navigationUI: "hide" });
      fromFullscreen.current = !wasFocused;
      setNotice(null);
    } catch {
      setNotice("The browser didn't allow full screen — Focus Mode is on instead.");
    }
  }, [setActive]);

  // Leaving fullscreen by any route (Esc, F11, the browser's UI) also leaves the Focus Mode it turned on.
  useEffect(() => {
    if (!fullscreen && fromFullscreen.current) {
      fromFullscreen.current = false;
      setActive(false);
      returnFocusToToggle();
    }
  }, [fullscreen, setActive]);

  // Escape: decided in the capture phase (before a dialog or popover closes itself on the same key), acted on in the
  // bubble phase only if nothing handled it.
  useEffect(() => {
    if (!focus) return;
    let eligible = false;
    const capture = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const target = e.target as HTMLElement | null;
      eligible = !document.fullscreenElement && !document.querySelector(OVERLAY) && !isTyping(target) && !target?.closest?.('[role="grid"], [role="separator"]');
    };
    const bubble = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !eligible || e.defaultPrevented) return;
      eligible = false;
      exitFocus();
    };
    window.addEventListener("keydown", capture, true);
    window.addEventListener("keydown", bubble);
    return () => {
      window.removeEventListener("keydown", capture, true);
      window.removeEventListener("keydown", bubble);
    };
  }, [focus, exitFocus]);

  // Never leak Focus Mode or fullscreen to another page.
  useEffect(
    () => () => {
      setActive(false);
      if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => undefined);
    },
    [setActive],
  );

  return { focus, fullscreen, canFullscreen, toggleFocus, exitFocus, toggleFullscreen, notice, dismissNotice: () => setNotice(null) };
}
