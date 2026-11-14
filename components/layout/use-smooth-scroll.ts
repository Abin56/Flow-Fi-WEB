"use client";

import { useCallback, useEffect, useRef, type RefObject } from "react";

/** Fraction of the remaining distance covered per 60fps frame — higher = snappier, lower = floatier. */
const EASE = 0.42;
/** Wheel events smaller than this (pixel mode) come from touchpads / precision devices, which already have momentum. */
const TOUCHPAD_DELTA = 40;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Smooth, inertial scrolling for the drawer's page list (presentation only).
 *  - Mouse wheel notches glide to their target instead of jumping; rapid notches accumulate into one glide.
 *  - Touchpads follow the finger 1:1 (they already have native momentum, smoothing them would feel laggy).
 *  - The wheel works anywhere over `rootRef` (logo, tiles, tabs…), so the whole drawer is one scroll pad, and it never
 *    chains to the page behind it.
 *  - `scrollTo` uses the same glide, so tab jumps and wheel scrolls feel identical.
 * Disabled (native scrolling, instant jumps) when `enabled` is false — e.g. prefers-reduced-motion.
 */
export function useSmoothScroll(
  scrollerRef: RefObject<HTMLElement | null>,
  rootRef: RefObject<HTMLElement | null>,
  enabled: boolean,
) {
  const state = useRef({ target: 0, raf: 0, last: 0 });

  const stop = useCallback(() => {
    window.cancelAnimationFrame(state.current.raf);
    state.current.raf = 0;
  }, []);

  const run = useCallback(() => {
    const s = state.current;
    if (s.raf) return;
    s.last = performance.now();
    const step = (now: number) => {
      const el = scrollerRef.current;
      if (!el) {
        s.raf = 0;
        return;
      }
      const dt = Math.min(120, now - s.last); // after a dropped frame, catch up instead of crawling
      s.last = now;
      const cur = el.scrollTop;
      const diff = s.target - cur;
      if (Math.abs(diff) < 2.5) {
        el.scrollTop = s.target;
        s.raf = 0;
        return;
      }
      const k = 1 - Math.pow(1 - EASE, dt / 16.667);
      const move = diff * k;
      // Always make at least 1px of progress, so integer-rounded scrollTop can never stall the glide.
      el.scrollTop = cur + (Math.abs(move) < 1 ? Math.sign(diff) : move);
      s.raf = window.requestAnimationFrame(step);
    };
    s.raf = window.requestAnimationFrame(step);
  }, [scrollerRef]);

  const scrollTo = useCallback(
    (y: number, instant = false) => {
      const el = scrollerRef.current;
      if (!el) return;
      const target = clamp(y, 0, Math.max(0, el.scrollHeight - el.clientHeight));
      if (instant || !enabled) {
        stop();
        el.scrollTop = target;
        return;
      }
      state.current.target = target;
      run();
    },
    [enabled, run, scrollerRef, stop],
  );

  useEffect(() => {
    const root = rootRef.current;
    const el = scrollerRef.current;
    if (!root || !el || !enabled) return;

    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return; // pinch-zoom / sideways swipe
      const max = el.scrollHeight - el.clientHeight;
      if (max <= 0) return;
      e.preventDefault(); // the drawer is its own scroll pad — never scroll the page behind it
      const unit = e.deltaMode === 1 ? 18 : e.deltaMode === 2 ? el.clientHeight : 1;
      const dy = e.deltaY * unit;
      const s = state.current;
      const base = s.raf ? s.target : el.scrollTop;
      const next = clamp(base + dy, 0, max);
      if (next === base) return;
      if (e.deltaMode === 0 && Math.abs(e.deltaY) < TOUCHPAD_DELTA) {
        stop();
        el.scrollTop = next;
        return;
      }
      s.target = next;
      run();
    };
    // A finger or a scrollbar grab takes over immediately — never fight the user.
    const interrupt = () => stop();

    root.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("touchstart", interrupt, { passive: true });
    el.addEventListener("pointerdown", interrupt);
    return () => {
      root.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", interrupt);
      el.removeEventListener("pointerdown", interrupt);
      stop();
    };
  }, [enabled, rootRef, run, scrollerRef, stop]);

  return { scrollTo, stop };
}
