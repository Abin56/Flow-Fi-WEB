"use client";

import { useEffect, useRef, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { capsuleLength, capsuleOffset, scrollForTrackPress, scrollPerThumbPx } from "@/lib/scroll/capsule-math";
import { onSmoothFrame } from "@/lib/scroll/engine";

/** Shortest capsule (px) — the thumb stays a fixed 48px pill and only shrinks on a very short track, never below this
 *  so it can still travel. (Geometry is shared with the app-wide overlay: lib/scroll/capsule-math.ts.) */
const MIN_CAPSULE = 32;

/**
 * Compact short-range capsule scrollbar for the drawer list. The track is ~6 cm tall (CSS), and the whole list maps
 * proportionally onto it (capsule at 25% of its travel = list 25% scrolled), so a short drag covers the entire menu.
 * Replaces the native scrollbar there. It sits in its own gutter beside the rows, so grabbing it can never hit a
 * navigation item. The whole gutter width is the grab zone:
 *  - press on the capsule (anywhere across the gutter at its height) and drag → list scrolls proportionally
 *    (each px of capsule travel = max scroll / (track − capsule) px of list);
 *  - press on the empty track → list glides so the capsule centres there, and keeping the button held drags on.
 * While dragging the pointer is captured, text selection is off and the click that ends the drag is swallowed, so
 * scrolling never selects, hovers or opens a page. Position/size are written straight to the DOM — no React
 * re-render per frame. Decorative for assistive tech (the list stays natively scrollable and keyboard-reachable).
 */
export function NavScrollThumb({
  scrollerRef,
  scrollTo,
  collapsed = false,
}: {
  scrollerRef: RefObject<HTMLElement | null>;
  scrollTo: (y: number, instant?: boolean) => void;
  collapsed?: boolean;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const sc = scrollerRef.current;
    const track = trackRef.current;
    const thumb = thumbRef.current;
    if (!sc || !track || !thumb) return;
    let hideTimer = 0;
    const update = () => {
      const max = sc.scrollHeight - sc.clientHeight;
      const trackH = track.clientHeight;
      if (max <= 1 || trackH === 0) {
        track.dataset.hidden = "true";
        return;
      }
      delete track.dataset.hidden;
      const h = capsuleLength(trackH, MIN_CAPSULE);
      // Whole pixels: keeps the capsule and its grip lines crisp (no half-pixel blur mid-travel).
      const y = capsuleOffset(sc.scrollTop, max, trackH, h);
      thumb.style.height = `${h}px`;
      thumb.style.transform = `translate3d(0, ${y}px, 0)`;
    };
    const onScroll = () => {
      update();
      track.dataset.active = "true";
      window.clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => delete track.dataset.active, 900);
    };
    update();
    sc.addEventListener("scroll", onScroll, { passive: true });
    // The smooth-scroll engine writes scrollTop inside an animation frame, so the scroll event (and this thumb's
    // update) would otherwise land a frame later than the content. This hook repaints it in the SAME frame.
    const offFrame = onSmoothFrame(update);
    const ro = new ResizeObserver(update);
    ro.observe(sc);
    ro.observe(track);
    if (sc.firstElementChild) ro.observe(sc.firstElementChild);
    return () => {
      sc.removeEventListener("scroll", onScroll);
      offFrame();
      ro.disconnect();
      window.clearTimeout(hideTimer);
    };
  }, [scrollerRef]);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const sc = scrollerRef.current;
    const track = trackRef.current;
    const thumb = thumbRef.current;
    if (!sc || !track || !thumb || e.button !== 0) return;
    e.preventDefault(); // no text selection, no focus change
    e.stopPropagation();
    const max = sc.scrollHeight - sc.clientHeight;
    if (max <= 1) return;
    const rect = track.getBoundingClientRect();
    const t = thumb.getBoundingClientRect();
    const h = t.height;
    const ratio = scrollPerThumbPx(max, rect.height, h);
    const clamp = (y: number) => Math.min(max, Math.max(0, y));

    let startTop = sc.scrollTop;
    if (e.clientY < t.top || e.clientY > t.bottom) {
      // Track press: glide so the capsule centres on the pointer; holding on turns it into a drag from there.
      startTop = scrollForTrackPress(e.clientY - rect.top, h, ratio, max);
      scrollTo(startTop);
    } else {
      scrollTo(startTop, true); // grabbing the capsule stops any glide in progress right where it is
    }
    const startY = e.clientY;
    let moved = false;

    track.setPointerCapture(e.pointerId);
    track.dataset.drag = "true";
    document.documentElement.dataset.navThumbDrag = "true";

    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientY - startY) < 2) return; // ignore jitter so a plain track click keeps its glide
      moved = true;
      scrollTo(clamp(startTop + (ev.clientY - startY) * ratio), true);
    };
    // Swallow the click that ends the press, wherever the browser decides to send it.
    const swallowClick = (ev: MouseEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
    };
    const end = () => {
      delete track.dataset.drag;
      delete document.documentElement.dataset.navThumbDrag;
      track.removeEventListener("pointermove", move);
      track.removeEventListener("pointerup", end);
      track.removeEventListener("pointercancel", end);
      track.removeEventListener("lostpointercapture", end);
      window.addEventListener("click", swallowClick, { capture: true, once: true });
      window.setTimeout(() => window.removeEventListener("click", swallowClick, { capture: true }), 0);
    };
    track.addEventListener("pointermove", move);
    track.addEventListener("pointerup", end);
    track.addEventListener("pointercancel", end);
    track.addEventListener("lostpointercapture", end);
  };

  return (
    <div
      ref={trackRef}
      aria-hidden
      data-collapsed={collapsed || undefined}
      data-testid="nav-scroll-track"
      onPointerDown={onPointerDown}
      className="nav-thumb-track"
    >
      <div ref={thumbRef} className="nav-thumb" data-testid="nav-scroll-thumb" />
    </div>
  );
}
