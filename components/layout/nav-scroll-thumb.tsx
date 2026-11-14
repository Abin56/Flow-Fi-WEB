"use client";

import { useEffect, useRef, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

/**
 * Slim custom scroll thumb for the drawer list (replaces the native scrollbar there). It fades in while the list is
 * scrolling or hovered, widens under the pointer, can be dragged, and a click on the track glides to that spot.
 * Position/size are written straight to the DOM on scroll — no React re-render per frame. Decorative for assistive
 * tech (the list itself stays natively scrollable and keyboard-reachable).
 */
export function NavScrollThumb({
  scrollerRef,
  scrollTo,
}: {
  scrollerRef: RefObject<HTMLElement | null>;
  scrollTo: (y: number, instant?: boolean) => void;
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
      const h = Math.max(32, (trackH * sc.clientHeight) / sc.scrollHeight);
      const y = (sc.scrollTop / max) * (trackH - h);
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
    const ro = new ResizeObserver(update);
    ro.observe(sc);
    ro.observe(track);
    if (sc.firstElementChild) ro.observe(sc.firstElementChild);
    return () => {
      sc.removeEventListener("scroll", onScroll);
      ro.disconnect();
      window.clearTimeout(hideTimer);
    };
  }, [scrollerRef]);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const sc = scrollerRef.current;
    const track = trackRef.current;
    const thumb = thumbRef.current;
    if (!sc || !track || !thumb || e.button !== 0) return;
    e.preventDefault();
    const max = sc.scrollHeight - sc.clientHeight;
    const h = thumb.offsetHeight;
    const ratio = max / Math.max(1, track.clientHeight - h);
    if (e.target !== thumb) {
      // Track click: glide so the thumb centres on the pointer.
      const rect = track.getBoundingClientRect();
      scrollTo((e.clientY - rect.top - h / 2) * ratio);
      return;
    }
    track.setPointerCapture(e.pointerId);
    track.dataset.drag = "true";
    const startY = e.clientY;
    const startTop = sc.scrollTop;
    const move = (ev: PointerEvent) => scrollTo(startTop + (ev.clientY - startY) * ratio, true);
    const end = () => {
      delete track.dataset.drag;
      track.removeEventListener("pointermove", move);
      track.removeEventListener("pointerup", end);
      track.removeEventListener("pointercancel", end);
    };
    track.addEventListener("pointermove", move);
    track.addEventListener("pointerup", end);
    track.addEventListener("pointercancel", end);
  };

  return (
    <div ref={trackRef} aria-hidden onPointerDown={onPointerDown} className="nav-thumb-track">
      <div ref={thumbRef} className="nav-thumb" />
    </div>
  );
}
