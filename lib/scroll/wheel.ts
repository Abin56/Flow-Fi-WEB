import { glideBy, glideTarget, maxScroll, reducedMotion, stopGlide } from "@/lib/scroll/engine";

/**
 * Smooth mouse-wheel scrolling for every vertical scroll area (desktop). One window-level wheel listener.
 *
 *  - Mouse-wheel NOTCHES are turned into a glide (see engine.ts). Quick successive notches flow into one motion and
 *    speed up a little (a modest, capped boost), instead of stepping from position to position.
 *  - TOUCHPADS are left completely alone: they already deliver 1:1 deltas with the OS's own momentum, so the browser
 *    scrolls them natively (any glide running on that container is simply stopped).
 *  - The target container is the first scrollable ancestor that has room in the wheel's direction — exactly where the
 *    browser would have scrolled. A container that just scrolled keeps the wheel for a moment ("latching"), so a spin
 *    that hits its end never hands the rest of the gesture to another container. A container with
 *    `overscroll-behavior: contain|none` that is at its end swallows the wheel instead of chaining.
 *  - Never touches: text areas / selects / number inputs, `[data-smooth="off"]`, the drawer (`[data-smooth="own"]`,
 *    which runs its own wheel pad on the same engine), ctrl+wheel (zoom), shift+wheel / sideways swipes, pinch-zoomed
 *    pages, or any event something else already handled (`defaultPrevented` — e.g. a modal's scroll lock). Listening
 *    in the bubble phase on window is what lets those handlers run first.
 */

/** Wheel events (pixel mode) smaller than this are touchpad / hi-res-wheel deltas — never smoothed. Without
 *  `wheelDeltaY` (Firefox) the bar is higher, because the size is then the only signal. */
const NOTCH_MIN_PX = 40;
/** With `wheelDeltaY` in whole 120s a real notch is still ≥ 20px even at 500% page zoom. */
const NOTCH_MIN_PX_TICKED = 20;
/** One "line" of a line-mode wheel, in px (three lines = the usual 100px notch). */
const LINE_PX = 33;
/** Notches closer together than this count as one spin. */
const STREAK_GAP_MS = 140;
const BOOST_STEP = 0.08;
const BOOST_MAX = 0.6;
/** A container that scrolled this recently keeps the wheel even at its end. */
const LATCH_MS = 420;

const SKIP = 'textarea, select, input[type="number"], [contenteditable]:not([contenteditable="false"]), [data-smooth="off"], [data-smooth="own"]';

let latch: { el: HTMLElement; until: number } | null = null;
let streak = 0;
let lastNotchAt = -Infinity;

/** Test helper. */
export function resetWheelState() {
  latch = null;
  streak = 0;
  lastNotchAt = -Infinity;
}

/**
 * Is this wheel event a discrete mouse-wheel notch (vs a touchpad / high-resolution delta)?
 * Line/page modes are always notches. In pixel mode Chrome reports `wheelDeltaY` as whole multiples of 120 for a
 * real wheel and as an arbitrary value for a precision touchpad; without it (Firefox) the delta size decides.
 */
export function isWheelNotch(e: Pick<WheelEvent, "deltaMode" | "deltaY"> & { wheelDeltaY?: number }): boolean {
  if (e.deltaMode !== 0) return true;
  const wd = e.wheelDeltaY;
  if (typeof wd === "number" && Number.isFinite(wd) && wd !== 0) return Math.abs(wd) % 120 === 0 && Math.abs(e.deltaY) >= NOTCH_MIN_PX_TICKED;
  return Math.abs(e.deltaY) >= NOTCH_MIN_PX;
}

/** The wheel distance in CSS px. */
export function wheelPixels(e: Pick<WheelEvent, "deltaMode" | "deltaY">, el: { clientHeight: number }): number {
  if (e.deltaMode === 1) return e.deltaY * LINE_PX;
  if (e.deltaMode === 2) return e.deltaY * el.clientHeight * 0.875;
  return e.deltaY;
}

/** 1 for a lone notch, rising to 1.6 over a sustained spin. */
function boostFor(timeStamp: number): number {
  streak = timeStamp - lastNotchAt <= STREAK_GAP_MS ? streak + 1 : 1;
  lastNotchAt = timeStamp;
  return 1 + Math.min(BOOST_MAX, (streak - 1) * BOOST_STEP);
}

function verticalRoom(el: HTMLElement, dy: number): boolean {
  const pos = glideTarget(el) ?? el.scrollTop;
  return dy > 0 ? pos < maxScroll(el) - 0.5 : pos > 0.5;
}

/**
 * The container the wheel should scroll: the first scrollable ancestor of `start` with room in that direction.
 * `null` = leave it to the browser (nothing scrolls, or the container swallows it with overscroll containment).
 */
export function findWheelScroller(start: Element, dy: number, now = performance.now()): HTMLElement | null {
  for (let n: Element | null = start; n; n = n.parentElement) {
    if (!(n instanceof HTMLElement)) continue;
    if (n === document.body || n === document.documentElement) break;
    const cs = getComputedStyle(n);
    const oy = cs.overflowY;
    if ((oy !== "auto" && oy !== "scroll" && oy !== "overlay") || n.scrollHeight - n.clientHeight <= 1) continue;
    if (verticalRoom(n, dy)) return n;
    if (latch && latch.el === n && now < latch.until) return n; // keep the gesture on this container
    const ob = cs.overscrollBehaviorY;
    if (ob === "contain" || ob === "none") return null; // swallowed — never scrolls anything else
  }
  const doc = document.scrollingElement;
  if (doc instanceof HTMLElement && doc.scrollHeight - doc.clientHeight > 1 && verticalRoom(doc, dy)) {
    const o = getComputedStyle(document.body).overflowY;
    const h = getComputedStyle(document.documentElement).overflowY;
    if (o !== "hidden" && h !== "hidden" && o !== "clip" && h !== "clip") return doc;
  }
  return null;
}

/** Turn one wheel event into a glide on `el` (call only for notches; the caller has already `preventDefault`ed). */
export function smoothWheelOn(el: HTMLElement, e: WheelEvent) {
  const dy = wheelPixels(e, el) * boostFor(e.timeStamp);
  latch = { el, until: performance.now() + LATCH_MS };
  glideBy(el, dy);
}

/** Installs the app-wide wheel smoothing. Returns the uninstall function. */
export function mountSmoothWheel(): () => void {
  const onWheel = (e: WheelEvent) => {
    if (e.defaultPrevented || e.ctrlKey || e.shiftKey || e.deltaY === 0 || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    if (reducedMotion() || (window.visualViewport?.scale ?? 1) > 1.01) return;
    const t = e.target;
    if (!(t instanceof Element) || t.closest(SKIP)) return;
    const el = findWheelScroller(t, e.deltaY);
    if (!el) return;
    if (!isWheelNotch(e as WheelEvent & { wheelDeltaY?: number })) {
      stopGlide(el); // a touchpad takes over: native 1:1 scrolling + the OS's own momentum
      return;
    }
    e.preventDefault();
    smoothWheelOn(el, e);
  };
  window.addEventListener("wheel", onWheel, { passive: false });
  return () => window.removeEventListener("wheel", onWheel);
}
