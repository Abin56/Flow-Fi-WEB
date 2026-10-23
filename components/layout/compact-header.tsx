"use client";

import { useReducedMotion } from "framer-motion";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Spacing contract (px). The bar floats `COMPACT_BAR_INSET` below the top edge of the scroll area, is
 * `COMPACT_BAR_HEIGHT` tall, and anything that must stack beneath it (a page's own sticky nav) sits `COMPACT_BAR_INSET`
 * below the bar: `COMPACT_STACK_TOP` from the scroll area's top edge. `useCompactHeader` turns these into the actual
 * sticky `top` values by measuring the scroll area's padding — `position: sticky` offsets ignore that padding, so the
 * shell's `py-*` is never assumed.
 */
export const COMPACT_BAR_HEIGHT = 48;
export const COMPACT_BAR_INSET = 8;
export const COMPACT_STACK_TOP = COMPACT_BAR_INSET + COMPACT_BAR_HEIGHT + COMPACT_BAR_INSET;

/** The bar slides in from above, so it travels its own height plus its inset (the scroll area clips it at its top edge). */
const SLIDE_DISTANCE = COMPACT_BAR_HEIGHT + COMPACT_BAR_INSET + 8;

/** 21 steps, so `progress` moves in 5% increments — smooth enough to read as continuous, cheap enough to skip a scroll listener. */
const THRESHOLDS = Array.from({ length: 21 }, (_, i) => i / 20);

/** Below this progress the bar is still sliding in: visible, but not yet interactive. */
const INTERACTIVE_AT = 0.5;

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * Watches one element (the page's original title block) inside the app shell's scrolling `<main>` and reports how far
 * it has scrolled out of view: 0 = fully visible, 1 = gone. One IntersectionObserver — no scroll listener, nothing is
 * resized, so it cannot change layout. Without IntersectionObserver (old browsers, jsdom) progress stays 0: the compact
 * bar never shows and the page keeps its full header.
 *
 * Also returns the sticky `top` values (px) for this scroll area: `barTop` for the bar, `stackTop` for a sticky element
 * that must sit under it.
 *
 * `watch` is a callback ref (pass it as the element's `ref`) so the observer follows the element when it mounts late
 * (e.g. after a loading state).
 */
export function useCompactHeader() {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [progress, setProgress] = useState(0);
  const [scrollPadTop, setScrollPadTop] = useState(0);
  const reduceMotion = useReducedMotion() ?? false;

  useEffect(() => {
    if (!target || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        // Several entries can arrive in one batch; the last one is the current state.
        const entry = entries[entries.length - 1];
        if (!entry) return;
        const rootTop = entry.rootBounds?.top ?? 0;
        const aboveTop = entry.boundingClientRect.top < rootTop;
        // Not intersecting and not above the top edge means it is below the fold — that is "fully visible" territory, not collapsed.
        const next = !aboveTop ? 0 : entry.isIntersecting ? 1 - entry.intersectionRatio : 1;
        setProgress((prev) => (Math.abs(prev - next) < 0.001 ? prev : next));
      },
      { root: target.closest("main"), threshold: THRESHOLDS },
    );
    io.observe(target);
    return () => io.disconnect();
  }, [target]);

  // The scroll area's own top padding, re-read whenever its size changes (the shell's padding steps with the breakpoint).
  useEffect(() => {
    const main = target?.closest("main");
    if (!main) return;
    const read = () => setScrollPadTop(parseFloat(getComputedStyle(main).paddingTop) || 0);
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(main);
    return () => ro.disconnect();
  }, [target]);

  return {
    watch: setTarget,
    progress,
    reduceMotion,
    barTop: COMPACT_BAR_INSET - scrollPadTop,
    stackTop: COMPACT_STACK_TOP - scrollPadTop,
  };
}

/**
 * The compact bar. Render it as the FIRST child of the page's flex-column root: its slot is `h-0` and sticky, so it takes
 * no space — the slot measures the root's row gap and cancels it, so the page below never moves.
 *
 * The bar is opaque and slides down from above the scroll area as the title leaves; the page's own content simply scrolls
 * under it (no cross-fade, so header text never ghosts through). Strips in the page background above and below it keep
 * scrolling content from peeking through the `COMPACT_BAR_INSET` gaps. They deliberately overshoot (the scroll area clips the top one,
 * the page's sticky nav paints over the bottom one) so the bar's 1px border can never leave a sliver uncovered.
 *
 * While hidden it is `inert`, `aria-hidden` and `visibility: hidden` — no tab stops, nothing for a screen reader. It stays
 * shown while focus is inside it or one of its menus/popovers is open, so an open popover never loses its anchor.
 */
export function CompactHeaderBar({
  label,
  progress,
  reduceMotion,
  top,
  children,
}: {
  /** Accessible name of the bar's region. */
  label: string;
  progress: number;
  reduceMotion: boolean;
  /** `barTop` from `useCompactHeader`. */
  top: number;
  children: React.ReactNode;
}) {
  const slotRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const [held, setHeld] = useState(false);
  const [rowGap, setRowGap] = useState(0);

  // The slot is a flex item of the page root, so the root's `gap` would add space around it; cancel exactly that.
  useIsomorphicLayoutEffect(() => {
    const parent = slotRef.current?.parentElement;
    if (!parent) return;
    const read = () => setRowGap(parseFloat(getComputedStyle(parent).rowGap) || 0);
    read();
    window.addEventListener("resize", read);
    return () => window.removeEventListener("resize", read);
  }, []);

  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const check = () => setHeld(bar.contains(document.activeElement) || bar.querySelector('[aria-expanded="true"]') != null);
    const mo = new MutationObserver(check);
    mo.observe(bar, { subtree: true, attributes: true, attributeFilter: ["aria-expanded"] });
    const afterBlur = () => requestAnimationFrame(check);
    bar.addEventListener("focusin", check);
    bar.addEventListener("focusout", afterBlur);
    check();
    return () => {
      mo.disconnect();
      bar.removeEventListener("focusin", check);
      bar.removeEventListener("focusout", afterBlur);
    };
  }, []);

  const shown = held ? 1 : progress;
  const gone = shown <= 0;
  const interactive = shown >= INTERACTIVE_AT;
  // Reduced motion: no slide — it simply appears once it would be interactive.
  const offset = reduceMotion ? 0 : (1 - shown) * -SLIDE_DISTANCE;
  const hiddenNow = gone || (reduceMotion && !interactive);

  return (
    <div ref={slotRef} className="pointer-events-none sticky z-hero h-0" style={{ top, marginBottom: -rowGap }}>
      <div
        ref={barRef}
        role="region"
        aria-label={label}
        aria-hidden={!interactive || undefined}
        inert={!interactive}
        data-compact-bar=""
        data-state={gone ? "hidden" : interactive ? "shown" : "entering"}
        style={{
          height: COMPACT_BAR_HEIGHT,
          transform: offset === 0 ? undefined : `translateY(${offset}px)`,
          visibility: hiddenNow ? "hidden" : "visible",
          transition: reduceMotion ? undefined : "transform 160ms ease-out",
        }}
        className={cn(
          "absolute inset-x-0 top-0 flex items-center gap-1.5 rounded-[12px] border border-border-strong/60 bg-card px-2 shadow-e1",
          "before:absolute before:-inset-x-1 before:-top-6 before:h-6 before:bg-background before:content-[''] after:absolute after:-inset-x-1 after:top-full after:h-3 after:bg-background after:content-['']",
          interactive && "pointer-events-auto",
        )}
      >
        {children}
      </div>
    </div>
  );
}
