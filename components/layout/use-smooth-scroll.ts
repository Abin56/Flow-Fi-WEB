"use client";

import { useCallback, useEffect, type RefObject } from "react";
import { glideTo, maxScroll, stopGlide } from "@/lib/scroll/engine";
import { isWheelNotch, smoothWheelOn, wheelPixels } from "@/lib/scroll/wheel";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Smooth scrolling for the drawer's page list (presentation only), on the shared engine in `lib/scroll`.
 *  - Mouse-wheel notches glide on the same critically damped spring as every other scroll area (soft start, soft exact
 *    stop; quick notches flow into one motion).
 *  - Touchpad deltas are applied 1:1 (the OS already supplies momentum; smoothing it would feel laggy).
 *  - The wheel works anywhere over `rootRef` (logo, tiles, tabs…), so the whole drawer is one scroll pad, and it never
 *    chains to the page behind it. (The drawer root is `data-smooth="own"`, so the app-wide wheel listener skips it.)
 *  - `scrollTo` uses the same glide, so tab jumps, track presses and wheel scrolls all feel identical.
 * Disabled (native scrolling, instant jumps) when `enabled` is false — e.g. prefers-reduced-motion.
 */
export function useSmoothScroll(
  scrollerRef: RefObject<HTMLElement | null>,
  rootRef: RefObject<HTMLElement | null>,
  enabled: boolean,
) {
  const stop = useCallback(() => {
    const el = scrollerRef.current;
    if (el) stopGlide(el);
  }, [scrollerRef]);

  const scrollTo = useCallback(
    (y: number, instant = false) => {
      const el = scrollerRef.current;
      if (!el) return;
      glideTo(el, y, { instant: instant || !enabled });
    },
    [enabled, scrollerRef],
  );

  useEffect(() => {
    const root = rootRef.current;
    const el = scrollerRef.current;
    if (!root || !el || !enabled) return;

    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return; // pinch-zoom / sideways swipe
      if (maxScroll(el) <= 0) return;
      e.preventDefault(); // the drawer is its own scroll pad — never scroll the page behind it
      if (isWheelNotch(e as WheelEvent & { wheelDeltaY?: number })) {
        smoothWheelOn(el, e);
        return;
      }
      stopGlide(el);
      el.scrollTop = clamp(el.scrollTop + wheelPixels(e, el), 0, maxScroll(el));
    };
    // A finger or a scrollbar grab takes over immediately — never fight the user.
    const interrupt = () => stopGlide(el);

    root.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("touchstart", interrupt, { passive: true });
    el.addEventListener("pointerdown", interrupt);
    return () => {
      root.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", interrupt);
      el.removeEventListener("pointerdown", interrupt);
      stopGlide(el);
    };
  }, [enabled, rootRef, scrollerRef]);

  return { scrollTo, stop };
}
