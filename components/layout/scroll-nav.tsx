"use client";

import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "framer-motion";
import { ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";

/** Held-arrow scroll speed, px/frame at 60fps. */
const HOLD_SPEED = 14;
/** Delay before a press starts auto-repeating, so a single click/tap still feels like a small nudge. */
const HOLD_START_DELAY = 220;
const TRACK_HEIGHT = 128;
const MIN_THUMB_HEIGHT = 20;

/**
 * Mini vertical scroll controller — a small scrollbar-like widget beside the page's own native scrollbar, not a
 * section-jump menu. Mount it anywhere inside the app shell's scrolling `<main>`; it finds that container via
 * `closest("main")`, so it needs no props. Everything reads/writes the real scroll container's `scrollTop`
 * directly: the thumb's position and size are set via inline style on every animation frame (no React state per
 * frame), and dragging/holding write `scrollTop` the same way. React state only tracks whether the control is
 * visible and which interaction (if any) is active, so it only re-renders on boundary/visibility changes, not on
 * every pixel of scroll.
 */
export function ScrollNav() {
  const [hasMain, setHasMain] = useState(false);
  const [visible, setVisible] = useState(false);
  const [atTop, setAtTop] = useState(true);
  const [atBottom, setAtBottom] = useState(false);
  const [dragging, setDragging] = useState(false);
  const reduceMotion = useReducedMotion() ?? false;

  const anchorRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLElement | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const holdFrame = useRef<number | null>(null);
  const holdTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragState = useRef<{ startY: number; startScrollTop: number; maxScroll: number } | null>(null);

  useEffect(() => {
    const main = anchorRef.current?.closest("main");
    if (main instanceof HTMLElement) {
      mainRef.current = main;
      setHasMain(true);
    }
  }, []);

  // Paints the thumb from the container's live scroll metrics — called on scroll/resize, never via React state.
  useEffect(() => {
    const main = mainRef.current;
    if (!hasMain || !main) return;
    const paint = () => {
      const { scrollTop, scrollHeight, clientHeight } = main;
      const maxScroll = scrollHeight - clientHeight;
      const canScroll = maxScroll > 40;
      setVisible(canScroll);
      setAtTop(scrollTop <= 1);
      setAtBottom(scrollTop >= maxScroll - 1);
      if (!canScroll || !thumbRef.current) return;
      const trackSpan = TRACK_HEIGHT;
      const thumbHeight = Math.max(MIN_THUMB_HEIGHT, Math.min(trackSpan, (clientHeight / scrollHeight) * trackSpan));
      const travel = trackSpan - thumbHeight;
      const progress = maxScroll > 0 ? scrollTop / maxScroll : 0;
      thumbRef.current.style.height = `${thumbHeight}px`;
      thumbRef.current.style.transform = `translateY(${progress * travel}px)`;
    };
    paint();
    main.addEventListener("scroll", paint, { passive: true });
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(paint);
    ro?.observe(main);
    return () => {
      main.removeEventListener("scroll", paint);
      ro?.disconnect();
    };
  }, [hasMain]);

  const stopHold = () => {
    if (holdFrame.current != null) cancelAnimationFrame(holdFrame.current);
    if (holdTimeout.current != null) clearTimeout(holdTimeout.current);
    holdFrame.current = null;
    holdTimeout.current = null;
  };

  // Press-and-hold: a small nudge on click, then continuous scrolling until release or the boundary.
  const startHold = (direction: 1 | -1) => {
    const main = mainRef.current;
    if (!main) return;
    const step = () => {
      main.scrollTop += direction * HOLD_SPEED;
      holdFrame.current = requestAnimationFrame(step);
    };
    main.scrollTop += direction * HOLD_SPEED * 2;
    holdTimeout.current = setTimeout(() => {
      holdFrame.current = requestAnimationFrame(step);
    }, HOLD_START_DELAY);
  };

  useEffect(() => stopHold, []);

  const onTrackClick = (e: React.MouseEvent) => {
    const main = mainRef.current;
    if (!main || !trackRef.current || dragState.current) return;
    const rect = trackRef.current.getBoundingClientRect();
    const clickRatio = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
    const maxScroll = main.scrollHeight - main.clientHeight;
    main.scrollTo({ top: clickRatio * maxScroll, behavior: reduceMotion ? "auto" : "smooth" });
  };

  const onThumbPointerDown = (e: React.PointerEvent) => {
    const main = mainRef.current;
    if (!main) return;
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragState.current = { startY: e.clientY, startScrollTop: main.scrollTop, maxScroll: main.scrollHeight - main.clientHeight };
    setDragging(true);
  };
  const onThumbPointerMove = (e: React.PointerEvent) => {
    const drag = dragState.current;
    const main = mainRef.current;
    if (!drag || !main) return;
    const trackSpan = TRACK_HEIGHT;
    const deltaY = e.clientY - drag.startY;
    const scrollPerPx = drag.maxScroll / trackSpan;
    main.scrollTop = Math.min(drag.maxScroll, Math.max(0, drag.startScrollTop + deltaY * scrollPerPx));
  };
  const onThumbPointerUp = (e: React.PointerEvent) => {
    dragState.current = null;
    setDragging(false);
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
  };

  if (!hasMain || !visible) return <div ref={anchorRef} />;

  return (
    <div
      ref={anchorRef}
      role="group"
      aria-label="Page scroll control"
      className="fixed top-1/2 right-1.5 z-hero hidden -translate-y-1/2 flex-col items-center gap-1 rounded-full border border-border-strong/50 bg-card/95 px-1 py-1.5 shadow-e1 backdrop-blur-sm sm:right-2.5 sm:flex"
    >
      <button
        type="button"
        aria-label="Scroll up"
        disabled={atTop}
        onPointerDown={() => startHold(-1)}
        onPointerUp={stopHold}
        onPointerLeave={stopHold}
        className="flex size-5 items-center justify-center rounded-full text-foreground/55 transition-colors hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary-accent-text focus-visible:outline-none disabled:pointer-events-none disabled:opacity-25"
      >
        <ChevronUp className="size-3" strokeWidth={2.25} />
      </button>

      <div ref={trackRef} onClick={onTrackClick} className="relative w-1.5 cursor-pointer rounded-full bg-border-strong/40" style={{ height: TRACK_HEIGHT }}>
        <div
          ref={thumbRef}
          aria-hidden
          onPointerDown={onThumbPointerDown}
          onPointerMove={onThumbPointerMove}
          onPointerUp={onThumbPointerUp}
          className={cn(
            "absolute inset-x-0 top-0 w-1.5 touch-none rounded-full bg-foreground/30 transition-[background-color] hover:bg-primary-accent-text/70",
            dragging && "bg-primary-accent-text",
            !reduceMotion && !dragging && "transition-transform duration-100 ease-out",
          )}
        />
      </div>

      <button
        type="button"
        aria-label="Scroll down"
        disabled={atBottom}
        onPointerDown={() => startHold(1)}
        onPointerUp={stopHold}
        onPointerLeave={stopHold}
        className="flex size-5 items-center justify-center rounded-full text-foreground/55 transition-colors hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary-accent-text focus-visible:outline-none disabled:pointer-events-none disabled:opacity-25"
      >
        <ChevronDown className="size-3" strokeWidth={2.25} />
      </button>
    </div>
  );
}
