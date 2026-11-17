"use client";

import { useEffect, type RefObject } from "react";

/**
 * Keeps an expanded People Ledger row comfortably in view. Pure scroll behaviour — it reads layout and calls
 * `scrollBy`; it never touches data, totals or handlers.
 *
 * - `revealDelta` is the whole decision (pure, unit-tested): how far to scroll so a block sits inside the visible
 *   area, clear of sticky headers — and 0 when it is already comfortably visible, so nothing moves needlessly.
 * - `revealBlock` applies it to every scrolling ancestor, nearest first: an internal table container, then the app
 *   shell's `<main>` (or the window), so a ledger inside a scrolling card inside a scrolling page works too.
 * - `useRevealWhenItGrows` nudges a panel that grows after the user's own click (More details, Postpone again).
 */

/** The row's `InlineReveal` animates for ~220ms; geometry is final shortly after, so reveal then. */
export const REVEAL_DELAY_MS = 240;
const EDGE_MARGIN = 12;
/** Below this many px a scroll is not worth starting. */
const MIN_STEP = 3;

export interface Span {
  top: number;
  bottom: number;
}

/**
 * Pixels to scroll (positive = down) so `block` fits inside `view`, keeping `margin` clear of the edges and `insets`
 * clear of sticky headers / bars.
 * - Already inside the safe area → 0.
 * - Fits but is cut off → the smallest move that shows all of it.
 * - Taller than the safe area → its top leads (the row header stays visible, the rest scrolls).
 */
export function revealDelta(block: Span, view: Span, insets: { top?: number; bottom?: number } = {}, margin = EDGE_MARGIN): number {
  const safeTop = view.top + (insets.top ?? 0) + margin;
  const safeBottom = view.bottom - (insets.bottom ?? 0) - margin;
  const room = safeBottom - safeTop;
  let delta = 0;
  if (room <= 0) delta = 0;
  else if (block.bottom - block.top > room) delta = block.top - safeTop;
  else if (block.top < safeTop) delta = block.top - safeTop;
  else if (block.bottom > safeBottom) delta = block.bottom - safeBottom;
  return Math.abs(delta) < MIN_STEP ? 0 : delta;
}

function reducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

const canScroll = (el: HTMLElement) => {
  const y = getComputedStyle(el).overflowY;
  return (y === "auto" || y === "scroll" || y === "overlay") && el.scrollHeight > el.clientHeight + 1;
};

/** Scrolling ancestors, nearest first; `null` stands for the window when the document itself scrolls. */
export function scrollParents(el: HTMLElement): (HTMLElement | null)[] {
  const out: (HTMLElement | null)[] = [];
  for (let p = el.parentElement; p; p = p.parentElement) if (canScroll(p)) out.push(p);
  const doc = document.scrollingElement;
  if (doc && doc.scrollHeight > doc.clientHeight + 1) out.push(null);
  return out;
}

const viewOf = (scroller: HTMLElement | null): Span => {
  if (!scroller) return { top: 0, bottom: window.innerHeight };
  const r = scroller.getBoundingClientRect();
  return { top: r.top, bottom: r.bottom };
};

/**
 * The box of the sticky / fixed UI that `el` belongs to, or null. It is the union of the chain from `el` up to the
 * sticky node, because a zero-height sticky slot can hold an overflowing bar (the compact page header) whose own
 * box is the one that actually covers the content.
 */
function stickyBox(el: Element, scroller: HTMLElement | null): { top: number; bottom: number; width: number; height: number } | null {
  let top = Infinity;
  let bottom = -Infinity;
  let left = Infinity;
  let right = -Infinity;
  for (let n: Element | null = el; n && n !== scroller && n !== document.body && n !== document.documentElement; n = n.parentElement) {
    const r = n.getBoundingClientRect();
    top = Math.min(top, r.top);
    bottom = Math.max(bottom, r.bottom);
    left = Math.min(left, r.left);
    right = Math.max(right, r.right);
    const pos = getComputedStyle(n).position;
    if (pos === "sticky" || pos === "fixed") return { top, bottom, width: right - left, height: bottom - top };
  }
  return null;
}

/**
 * How much of the scroller's top / bottom edge is covered by sticky or fixed UI (the table header, a month heading,
 * the compact page bar, a bottom nav). Found by asking the browser what is painted at the edge, so it follows
 * whatever the page really shows instead of assuming a header height. Without `elementsFromPoint` it is 0.
 */
export function stuckInsets(view: Span, scroller: HTMLElement | null, ignore: Element): { top: number; bottom: number } {
  if (typeof document.elementsFromPoint !== "function") return { top: 0, bottom: 0 };
  const width = scroller ? scroller.getBoundingClientRect().width : window.innerWidth;
  const left = scroller ? scroller.getBoundingClientRect().left : 0;
  const xs = [left + width * 0.5, left + width * 0.2];
  const probe = (from: "top" | "bottom") => {
    let y = from === "top" ? view.top + 2 : view.bottom - 2;
    let edge = from === "top" ? view.top : view.bottom;
    for (let i = 0; i < 4; i++) {
      let hit: { top: number; bottom: number } | null = null;
      for (const x of xs) {
        for (const el of document.elementsFromPoint(x, y)) {
          if (ignore.contains(el)) continue;
          const box = stickyBox(el, scroller);
          if (!box) continue;
          // A real bar spans a good part of the area; a small floating thing (toast, popover) is not a header.
          if (box.width >= width * 0.3 && box.height < (view.bottom - view.top) * 0.4) hit = box;
          break;
        }
        if (hit) break;
      }
      if (!hit) break;
      const next = from === "top" ? hit.bottom : hit.top;
      if (from === "top" ? next <= edge : next >= edge) break;
      edge = next;
      y = from === "top" ? next + 2 : next - 2;
    }
    return Math.max(0, from === "top" ? edge - view.top : view.bottom - edge);
  };
  return { top: probe("top"), bottom: probe("bottom") };
}

function scrollBy(scroller: HTMLElement | null, top: number, behavior: ScrollBehavior) {
  const target = scroller ?? window;
  if (typeof target.scrollBy === "function") target.scrollBy({ top, behavior });
}

/**
 * Brings `start`…`end` (a row and its expansion) into comfortable view in every scrolling ancestor. Smooth, and
 * instant under reduced motion. Safe to call when nothing needs to move.
 */
export function revealBlock(start: HTMLElement, end: HTMLElement = start, opts: { margin?: number } = {}): void {
  if (typeof window === "undefined") return;
  const behavior: ScrollBehavior = reducedMotion() ? "auto" : "smooth";
  let block: Span = { top: start.getBoundingClientRect().top, bottom: end.getBoundingClientRect().bottom };
  for (const scroller of scrollParents(start)) {
    const view = viewOf(scroller);
    const insets = stuckInsets(view, scroller, start);
    const delta = revealDelta(block, view, insets, opts.margin);
    if (delta !== 0) {
      scrollBy(scroller, delta, behavior);
      block = { top: block.top - delta, bottom: block.bottom - delta };
    }
    // Where the block will be once this scroller has moved — what an outer scroller still has to reveal.
    block = { top: Math.max(block.top, view.top + insets.top), bottom: Math.min(block.bottom, view.bottom - insets.bottom) };
    if (block.bottom < block.top) return;
  }
}

/**
 * When the panel in `ref` grows because the user acted inside it (opened More details, Postpone again…), scroll just
 * enough to keep what they clicked AND what it revealed in view: the span runs from the clicked control down to the
 * panel's bottom, so the control stays put and the new content is below it. Ignores the first moments after mounting
 * (the row's own reveal handles those) and any growth that was not just triggered by a click / key press (a live data
 * update never moves the page).
 */
export function useRevealWhenItGrows(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const mountedAt = Date.now();
    let lastInput = -Infinity;
    let lastTarget: Element | null = null;
    let height = el.offsetHeight;
    let timer: number | undefined;
    const onInput = (e: Event) => {
      lastInput = Date.now();
      lastTarget = e.target instanceof Element ? e.target : null;
    };
    document.addEventListener("pointerdown", onInput, true);
    document.addEventListener("keydown", onInput, true);
    const ro = new ResizeObserver(() => {
      const next = el.offsetHeight;
      const grew = next > height + 4;
      height = next;
      const now = Date.now();
      if (!grew || now - mountedAt < REVEAL_DELAY_MS * 2 || now - lastInput > 800) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        // The clicked control may have been replaced by what it opened (Postpone → its panel): then lead with the panel.
        const from = lastTarget && lastTarget.isConnected && el.contains(lastTarget) ? (lastTarget as HTMLElement) : el;
        revealBlock(from, el);
      }, 60);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      window.clearTimeout(timer);
      document.removeEventListener("pointerdown", onInput, true);
      document.removeEventListener("keydown", onInput, true);
    };
  }, [ref]);
}
