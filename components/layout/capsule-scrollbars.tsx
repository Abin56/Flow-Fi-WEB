"use client";

import { useEffect } from "react";
import { capsuleLength, capsuleOffset, scrollForTrackPress, scrollPerThumbPx, TRACK_MAX } from "@/lib/scroll/capsule-math";
import { glideTo, onSmoothFrame, reducedMotion, stopGlide } from "@/lib/scroll/engine";
import { isWheelNotch, mountSmoothWheel, smoothWheelOn } from "@/lib/scroll/wheel";

/**
 * App-wide capsule scrollbars + smooth wheel (desktop, real mouse only).
 *
 * The same short-range capsule as the drawer's NavScrollThumb, for every other scrollable area — main pages, panels,
 * tables, drawers, sheets, dialogs, dropdowns, textareas. Native scrollbars keep their gutter (so no layout changes)
 * but are painted transparent while this is mounted (`html[data-capsule-scroll]`); a capsule is drawn into that gutter.
 *
 *  - One fixed overlay layer on <body>; capsules are positioned from each container's rect (no React state, no
 *    re-render). They appear for the containers under the pointer (and while dragging). Each frame READS every bar's
 *    geometry first and only then WRITES, and unchanged values are never re-written. The frame loop runs only while
 *    something is moving (scroll, resize, hover change, drag) — a still page costs nothing.
 *  - Track = min(228px ≈ 6 cm, visible length − 12px), centred on the visible part of the container; capsule 48px
 *    (smaller on short tracks). Mapping is proportional (lib/scroll/capsule-math.ts, shared with the drawer).
 *  - Drag is direct and 1:1 (pointer captured, click after release swallowed). A track press glides there on the
 *    shared spring engine and holding keeps dragging. The wheel over the capsule glides its container like anywhere else.
 *  - Smooth wheel for every vertical scroller is installed here too (lib/scroll/wheel.ts): notches glide, touchpads
 *    stay native, containers stay independent. The engine repaints the capsules in the same frame it moves content.
 *  - Skipped: containers whose scrollbar is deliberately hidden (`scrollbar-width: none`, e.g. tab strips and the
 *    drawer list which has its own), anything inside `[data-capsule="off"]`, and touch-only devices. Radix Select lists
 *    (scrollbar hidden by Radix) are opted back in; with no gutter the capsule hugs the inner edge.
 * Native pointerdown listeners stop propagation so Radix dialogs/popovers don't treat a capsule press as an
 * outside click.
 */

type Axis = "y" | "x";
type Painted = { track: string; len: number; cap: number; thumb: string };
type Bar = {
  el: HTMLElement;
  axis: Axis;
  track: HTMLDivElement;
  thumb: HTMLDivElement;
  clips: HTMLElement[];
  len: number;
  cap: number;
  drag: boolean;
  removeAt: number;
  hidden: boolean;
  painted: Painted | null;
};
type Layout = Painted;

const MIN_CAPSULE = 24;
const HIT = 16; // track hit-zone thickness
const MIN_VISIBLE = 56; // smaller areas keep no capsule
/** How long the paint loop keeps running after the last event that could move a capsule. */
const ACTIVE_MS = 320;
/** Re-checking which containers sit under a still pointer while content scrolls beneath it (ms). */
const REFRESH_GAP = 120;

const isDoc = (el: Element) => el === document.scrollingElement;

function scrollable(el: HTMLElement, axis: Axis): boolean {
  if (el.closest('[data-capsule="off"]')) return false;
  const size = axis === "y" ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth;
  if (size <= 1) return false;
  if (isDoc(el)) {
    const o = getComputedStyle(document.body)[axis === "y" ? "overflowY" : "overflowX"];
    const h = getComputedStyle(document.documentElement)[axis === "y" ? "overflowY" : "overflowX"];
    return o !== "hidden" && h !== "hidden" && o !== "clip" && h !== "clip";
  }
  const cs = getComputedStyle(el);
  const o = axis === "y" ? cs.overflowY : cs.overflowX;
  if (o !== "auto" && o !== "scroll" && o !== "overlay") return false;
  // Radix Select hides its native scrollbar but is a real scrolling list — opt it in (and anything marked data-capsule="on").
  if (el.hasAttribute("data-radix-select-viewport") || el.dataset.capsule === "on") return true;
  return (cs as CSSStyleDeclaration & { scrollbarWidth?: string }).scrollbarWidth !== "none";
}

function clipAncestors(el: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
    const cs = getComputedStyle(p);
    if (cs.overflowX !== "visible" || cs.overflowY !== "visible") out.push(p);
    if (cs.position === "fixed") break;
  }
  return out;
}

export function CapsuleScrollbars() {
  useEffect(() => {
    // Any fine pointer with hover (a touch laptop, a tablet with a mouse…) — not only when the mouse is the PRIMARY input.
    const mq = window.matchMedia("(any-hover: hover) and (any-pointer: fine)");
    let teardown: (() => void) | null = null;
    let unwatch: (() => void) | null = null;
    const apply = () => {
      teardown?.();
      teardown = null;
      unwatch?.();
      unwatch = null;
      if (mq.matches) {
        teardown = mount();
        return;
      }
      // Browser says "touch only": switch on the moment a real mouse moves (hybrids and odd reports are common).
      const firstMouse = (e: PointerEvent) => {
        if (e.pointerType !== "mouse") return;
        unwatch?.();
        unwatch = null;
        teardown = mount();
      };
      document.addEventListener("pointermove", firstMouse, { passive: true });
      unwatch = () => document.removeEventListener("pointermove", firstMouse);
    };
    apply();
    mq.addEventListener("change", apply);
    return () => {
      mq.removeEventListener("change", apply);
      unwatch?.();
      teardown?.();
    };
  }, []);
  return null;
}

function mount(): () => void {
  const root = document.documentElement;
  root.dataset.capsuleScroll = "true";
  const layer = document.createElement("div");
  layer.className = "cap-layer";
  layer.setAttribute("aria-hidden", "true");
  document.body.appendChild(layer);
  const unmountWheel = mountSmoothWheel();

  const bars = new Map<string, Bar>();
  const ids = new WeakMap<HTMLElement, number>();
  let nextId = 1;
  const key = (el: HTMLElement, axis: Axis) => {
    let id = ids.get(el);
    if (!id) ids.set(el, (id = nextId++));
    return `${id}:${axis}`;
  };
  let raf = 0;
  let activeUntil = 0;
  let lastTarget: Element | null = null;

  const geometry = (b: Bar) => {
    const el = b.el;
    let r: { left: number; top: number; right: number; bottom: number };
    let gutterStart: number;
    let gutter: number;
    if (isDoc(el)) {
      r = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
      gutter = b.axis === "y" ? window.innerWidth - root.clientWidth : window.innerHeight - root.clientHeight;
      gutterStart = b.axis === "y" ? root.clientWidth : root.clientHeight;
    } else {
      const br = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (b.axis === "y") {
        const bl = parseFloat(cs.borderLeftWidth) || 0;
        const brw = parseFloat(cs.borderRightWidth) || 0;
        gutter = el.offsetWidth - el.clientWidth - bl - brw;
        gutterStart = br.left + bl + el.clientWidth;
        r = { left: br.left + bl, top: br.top + el.clientTop, right: br.right - brw, bottom: br.top + el.clientTop + el.clientHeight };
      } else {
        const bt = parseFloat(cs.borderTopWidth) || 0;
        const bb = parseFloat(cs.borderBottomWidth) || 0;
        gutter = el.offsetHeight - el.clientHeight - bt - bb;
        gutterStart = br.top + bt + el.clientHeight;
        r = { left: br.left + el.clientLeft, top: br.top + bt, right: br.left + el.clientLeft + el.clientWidth, bottom: br.bottom - bb };
      }
      // Clip to every overflow-clipping ancestor and the viewport, so the capsule centres on what is actually visible.
      for (const c of b.clips) {
        const cr = c.getBoundingClientRect();
        r = { left: Math.max(r.left, cr.left), top: Math.max(r.top, cr.top), right: Math.min(r.right, cr.right), bottom: Math.min(r.bottom, cr.bottom) };
      }
    }
    r = { left: Math.max(r.left, 0), top: Math.max(r.top, 0), right: Math.min(r.right, window.innerWidth), bottom: Math.min(r.bottom, window.innerHeight) };
    return { r, gutterStart, gutter };
  };

  /** READ phase: where this bar goes and how it looks right now. `null` = nothing to show. */
  const measure = (b: Bar): Layout | null => {
    const el = b.el;
    if (!el.isConnected) return null;
    // Behind an open modal (sheet/dialog) the page is inert: Radix marks it aria-hidden. Its capsule would float over the
    // sheet at the sidebar's gutter, ignoring the sheet's size — so while a modal is open only containers inside it get one.
    if (isDoc(el) ? document.querySelector('[role="dialog"][data-open], [role="dialog"][data-state="open"]') : el.closest('[aria-hidden="true"]')) return null;
    const { r, gutterStart, gutter } = geometry(b);
    const visible = b.axis === "y" ? r.bottom - r.top : r.right - r.left;
    const max = b.axis === "y" ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth;
    if (visible < MIN_VISIBLE || max <= 1) return null;
    const len = Math.round(Math.min(TRACK_MAX, visible - 12));
    const cap = capsuleLength(len, MIN_CAPSULE);
    // Cross-axis: centre in the native gutter when there is one, else hug the inner edge.
    // A thin native gutter (~8px) is narrower than the capsule (12–14px), and at the window edge the overhang would be
    // cut off — so the capsule is always kept fully inside the viewport (its hit zone is HIT wide, centred on `cross`).
    const edge = (b.axis === "y" ? window.innerWidth : window.innerHeight) - HIT / 2;
    const cross = Math.min(gutter >= 4 ? gutterStart + gutter / 2 : (b.axis === "y" ? r.right : r.bottom) - 8, edge);
    const pos = b.axis === "y" ? el.scrollTop : el.scrollLeft;
    const off = capsuleOffset(pos, max, len, cap);
    if (b.axis === "y") {
      const top = Math.round(r.top + (visible - len) / 2);
      return { track: `translate3d(${Math.round(cross - HIT / 2)}px, ${top}px, 0)`, len, cap, thumb: `translate3d(0, ${off}px, 0)` };
    }
    const left = Math.round(r.left + (visible - len) / 2);
    return { track: `translate3d(${left}px, ${Math.round(cross - HIT / 2)}px, 0)`, len, cap, thumb: `translate3d(${off}px, 0, 0)` };
  };

  /** WRITE phase: only the values that actually changed touch the DOM. */
  const apply = (b: Bar, m: Layout | null) => {
    if (!m) {
      if (!b.hidden) {
        b.track.dataset.hidden = "true";
        b.hidden = true;
      }
      return;
    }
    if (b.hidden) {
      delete b.track.dataset.hidden;
      b.hidden = false;
    }
    const p = b.painted;
    const size = b.axis === "y" ? "height" : "width";
    if (p?.track !== m.track) b.track.style.transform = m.track;
    if (p?.len !== m.len) b.track.style[size] = `${m.len}px`;
    if (p?.cap !== m.cap) b.thumb.style[size] = `${m.cap}px`;
    if (p?.thumb !== m.thumb) b.thumb.style.transform = m.thumb;
    b.painted = m;
    b.len = m.len;
    b.cap = m.cap;
  };

  const paint = () => {
    const now = performance.now();
    const work: Array<[Bar, Layout | null]> = [];
    const gone: string[] = [];
    for (const [k, b] of bars) {
      if (!b.drag && b.removeAt && now >= b.removeAt) gone.push(k);
      else work.push([b, measure(b)]);
    }
    for (const k of gone) {
      bars.get(k)?.track.remove();
      bars.delete(k);
    }
    for (const [b, m] of work) apply(b, m);
  };

  const frame = () => {
    raf = 0;
    paint();
    if (bars.size > 0 && (performance.now() < activeUntil || [...bars.values()].some((b) => b.drag))) raf = requestAnimationFrame(frame);
  };
  /** Keep the paint loop alive for a moment (scroll, resize, hover change, drag…); it stops by itself when still. */
  const kick = (ms = ACTIVE_MS) => {
    activeUntil = Math.max(activeUntil, performance.now() + ms);
    if (!raf && bars.size > 0) raf = requestAnimationFrame(frame);
  };
  // Content growing/shrinking under a still pointer emits no event: a cheap low-rate check covers it.
  const poll = window.setInterval(() => {
    if (bars.size > 0) kick(60);
  }, 450);
  // The smooth-scroll engine moves content inside its own animation frame; repaint right after it, in that same frame.
  const offFrame = onSmoothFrame(() => {
    if (bars.size > 0) paint();
  });

  const create = (el: HTMLElement, axis: Axis): Bar => {
    const track = document.createElement("div");
    track.className = "cap-track";
    track.dataset.axis = axis;
    track.dataset.testid = "capsule-track";
    const thumb = document.createElement("div");
    thumb.className = "nav-thumb cap-thumb";
    thumb.dataset.testid = "capsule-thumb";
    track.appendChild(thumb);
    layer.appendChild(track);
    const b: Bar = { el, axis, track, thumb, clips: isDoc(el) ? [] : clipAncestors(el), len: 0, cap: 0, drag: false, removeAt: 0, hidden: false, painted: null };
    track.addEventListener("pointerdown", (e) => onPointerDown(e, b));
    track.addEventListener("wheel", (e) => onWheel(e, b), { passive: false });
    track.addEventListener("pointerenter", () => (b.removeAt = 0));
    track.addEventListener("pointerleave", () => {
      if (!b.drag) refresh(document.elementFromPoint(lastX, lastY));
    });
    apply(b, measure(b));
    return b;
  };

  /** Show capsules for the scrollable ancestors of `target`; let the rest fade out. */
  const refresh = (target: Element | null) => {
    lastTarget = target;
    lastRefresh = performance.now();
    const want = new Set<string>();
    if (target && !layer.contains(target)) {
      for (let n: Element | null = target; n; n = n.parentElement) {
        if (!(n instanceof HTMLElement) || n === document.body) continue;
        if (n === document.documentElement) break;
        for (const axis of ["y", "x"] as const) {
          if (!scrollable(n, axis)) continue;
          const k = key(n, axis);
          want.add(k);
          const existing = bars.get(k);
          if (existing) existing.removeAt = 0;
          else bars.set(k, create(n, axis));
        }
      }
      const doc = document.scrollingElement as HTMLElement | null;
      if (doc) {
        for (const axis of ["y", "x"] as const) {
          if (!scrollable(doc, axis)) continue;
          const k = key(doc, axis);
          want.add(k);
          if (!bars.get(k)) bars.set(k, create(doc, axis));
          else bars.get(k)!.removeAt = 0;
        }
      }
    } else if (target && layer.contains(target)) {
      return; // pointer is on a capsule — keep the current set
    }
    const now = performance.now();
    for (const [k, b] of bars) {
      if (!want.has(k) && !b.drag && !b.removeAt) {
        b.removeAt = now + 350;
        b.track.dataset.leaving = "true";
      } else if (want.has(k)) delete b.track.dataset.leaving;
    }
    kick(420); // covers the 350ms fade-out
  };

  let lastX = -1;
  let lastY = -1;
  let lastRefresh = 0;
  let pending = false;
  const onMove = (e: PointerEvent) => {
    if (e.pointerType !== "mouse") return;
    lastX = e.clientX;
    lastY = e.clientY;
    const t = e.target as Element | null;
    if (t === lastTarget || pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      refresh(e.target as Element | null);
    });
  };
  const onLeaveDoc = (e: MouseEvent) => {
    if (!e.relatedTarget) refresh(null);
  };
  // Content that changes size/scroll (new rows, dialogs opening under a still pointer) re-checks the hovered chain —
  // at most every REFRESH_GAP ms, because walking the ancestors' styles on every scroll frame would be wasted work.
  const onScrollAny = () => {
    kick();
    if (lastX < 0 || pending) return;
    pending = true;
    window.setTimeout(() => {
      requestAnimationFrame(() => {
        pending = false;
        refresh(document.elementFromPoint(lastX, lastY));
      });
    }, Math.max(0, REFRESH_GAP - (performance.now() - lastRefresh)));
  };

  const scrollPos = (b: Bar, v?: number) => {
    if (v === undefined) return b.axis === "y" ? b.el.scrollTop : b.el.scrollLeft;
    if (b.axis === "y") b.el.scrollTop = v;
    else b.el.scrollLeft = v;
    return v;
  };

  const onWheel = (e: WheelEvent, b: Bar) => {
    e.preventDefault();
    e.stopPropagation();
    if (b.axis === "y" && !reducedMotion() && isWheelNotch(e)) {
      smoothWheelOn(b.el, e); // same glide as anywhere else in the container
      return;
    }
    stopGlide(b.el); // touchpad deltas apply 1:1
    const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? (b.axis === "y" ? b.el.clientHeight : b.el.clientWidth) : 1;
    const d = (b.axis === "y" ? e.deltaY || e.deltaX : e.deltaX || e.deltaY) * unit;
    scrollPos(b, scrollPos(b) + d);
  };

  const onPointerDown = (e: PointerEvent, b: Bar) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation(); // not an "outside click" for dialogs/popovers, no focus change, no selection
    const el = b.el;
    const max = b.axis === "y" ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth;
    if (max <= 1 || !b.len) return;
    const ratio = scrollPerThumbPx(max, b.len, b.cap);
    const tr = b.track.getBoundingClientRect();
    const th = b.thumb.getBoundingClientRect();
    const p = b.axis === "y" ? e.clientY : e.clientX;
    const thStart = b.axis === "y" ? th.top : th.left;
    const thEnd = b.axis === "y" ? th.bottom : th.right;
    const trStart = b.axis === "y" ? tr.top : tr.left;
    const clamp = (v: number) => Math.min(max, Math.max(0, v));
    const prevBehavior = el.style.scrollBehavior;

    let startPos = scrollPos(b);
    if (p < thStart || p > thEnd) {
      // Track press: glide so the capsule centres on the pointer; keep holding to drag from there.
      startPos = scrollForTrackPress(p - trStart, b.cap, ratio, max);
      if (b.axis === "y") glideTo(el, startPos);
      else el.scrollTo({ left: startPos, behavior: reducedMotion() ? "auto" : "smooth" });
    } else {
      stopGlide(el); // grabbing the capsule stops any glide right where it is
    }
    let moved = false;
    b.drag = true;
    b.removeAt = 0;
    b.track.dataset.drag = "true";
    root.dataset.navThumbDrag = "true";
    b.track.setPointerCapture(e.pointerId);
    kick();

    const move = (ev: PointerEvent) => {
      const q = b.axis === "y" ? ev.clientY : ev.clientX;
      if (!moved && Math.abs(q - p) < 2) return;
      if (!moved) {
        stopGlide(el); // direct dragging is 1:1 — nothing animates under the pointer
        el.style.scrollBehavior = "auto";
      }
      moved = true;
      scrollPos(b, clamp(startPos + (q - p) * ratio));
    };
    const swallow = (ev: MouseEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
    };
    const end = () => {
      b.drag = false;
      el.style.scrollBehavior = prevBehavior;
      delete b.track.dataset.drag;
      delete root.dataset.navThumbDrag;
      b.track.removeEventListener("pointermove", move);
      b.track.removeEventListener("pointerup", end);
      b.track.removeEventListener("pointercancel", end);
      b.track.removeEventListener("lostpointercapture", end);
      window.addEventListener("click", swallow, { capture: true, once: true });
      window.setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
      refresh(document.elementFromPoint(lastX, lastY));
    };
    b.track.addEventListener("pointermove", move);
    b.track.addEventListener("pointerup", end);
    b.track.addEventListener("pointercancel", end);
    b.track.addEventListener("lostpointercapture", end);
  };

  const onResize = () => kick();
  document.addEventListener("pointermove", onMove, { passive: true });
  document.addEventListener("pointerover", onMove, { passive: true });
  document.addEventListener("mouseout", onLeaveDoc);
  document.addEventListener("scroll", onScrollAny, { capture: true, passive: true });
  window.addEventListener("resize", onResize);

  return () => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerover", onMove);
    document.removeEventListener("mouseout", onLeaveDoc);
    document.removeEventListener("scroll", onScrollAny, { capture: true });
    window.removeEventListener("resize", onResize);
    window.clearInterval(poll);
    offFrame();
    unmountWheel();
    if (raf) cancelAnimationFrame(raf);
    layer.remove();
    delete root.dataset.capsuleScroll;
  };
}
