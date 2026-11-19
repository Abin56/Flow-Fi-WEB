/**
 * Shared smooth-scroll engine (presentation only — it moves scroll positions, nothing else).
 *
 * Every animated scroller (drawer list, main page, tables, dialog bodies, the capsule's track presses) is driven by
 * ONE critically damped spring per container and ONE requestAnimationFrame loop:
 *
 *   - starts from rest, so there is a gentle ramp-in instead of a first-frame lurch;
 *   - never overshoots a fixed target, so it comes to a soft, exact stop (top/bottom land exactly);
 *   - keeps its velocity when a new wheel notch retargets it, so quick successive notches flow into one motion;
 *   - is time-based (exact closed-form step), so 60Hz and 144Hz screens move identically and a dropped frame is
 *     caught up rather than crawled through.
 *
 * Anything else moving the container (a scrollbar drag, keyboard, scrollIntoView, a touchpad) wins immediately: the
 * glide notices the position it wrote was changed under it and lets go. Respects prefers-reduced-motion (instant).
 *
 * `onSmoothFrame` hooks run in the same frame, right after the scroll writes — that is how the capsule thumbs stay
 * locked to the content instead of trailing it by a frame.
 */

/** The bits of an element the engine needs (HTMLElement satisfies it; tests pass plain objects). */
export interface Scroller {
  scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly isConnected: boolean;
  scrollTo(options: ScrollToOptions): void;
}

/**
 * Spring stiffness (rad/s). Critically damped: ≈50% of a move in 60 ms, ≈90% in 135 ms, visually done by ≈200 ms and
 * snapped exact by ≈330 ms. Fast on purpose (the app is used for quick switching) but with a soft start and a soft
 * landing. Higher = snappier, lower = floatier.
 */
export const SPRING_OMEGA = 28;
/** Longest time step we integrate in one go. The closed-form step is exact for any dt, so after a slow frame the
 *  spring jumps to where it would be by now (catching up) instead of running in slow motion; the cap only guards a
 *  tab that was backgrounded for seconds. */
const MAX_DT = 0.12;
/** Resting thresholds: closer than this to the target AND slower than this = arrived. */
const REST_DIST = 0.5;
const REST_SPEED = 20;
/** A scroll position that differs from what we last wrote by more than this was moved by someone else. */
const EXTERNAL_TOLERANCE = 1.5;

type Glide = { el: Scroller; pos: number; vel: number; target: number; written: number };

const glides = new Map<Scroller, Glide>();
const frameHooks = new Set<() => void>();
let raf = 0;
let last = 0;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Furthest the container can scroll (never negative). */
export function maxScroll(el: Scroller): number {
  return Math.max(0, el.scrollHeight - el.clientHeight);
}

let reducedQuery: MediaQueryList | null = null;
/** True when the user asked the OS for less motion — the engine then never animates. */
export function reducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  reducedQuery ??= window.matchMedia("(prefers-reduced-motion: reduce)");
  return reducedQuery.matches;
}

/** Instant write; `behavior: "instant"` so a container with CSS `scroll-behavior: smooth` doesn't re-animate it. */
function write(el: Scroller, top: number) {
  el.scrollTo({ top, behavior: "instant" });
}

function schedule() {
  if (raf || typeof requestAnimationFrame !== "function") return;
  last = typeof performance !== "undefined" ? performance.now() : 0;
  raf = requestAnimationFrame(tick);
}

function tick(now: number) {
  raf = 0;
  const dt = clamp((now - last) / 1000, 0.001, MAX_DT);
  last = now;
  for (const g of [...glides.values()]) {
    const el = g.el;
    // Someone else moved it (scrollbar drag, keyboard, scrollIntoView…) or it left the page: let go.
    if (!el.isConnected || Math.abs(el.scrollTop - g.written) > EXTERNAL_TOLERANCE) {
      glides.delete(el);
      continue;
    }
    const max = maxScroll(el);
    if (g.target > max) g.target = max; // content shrank under us
    // Exact solution of x'' = -2ω x' - ω² (x - target) over dt (critically damped), so the step is frame-rate independent.
    const d = g.pos - g.target;
    const j = g.vel + SPRING_OMEGA * d;
    const e = Math.exp(-SPRING_OMEGA * dt);
    g.pos = g.target + (d + j * dt) * e;
    g.vel = (g.vel - SPRING_OMEGA * j * dt) * e;
    if (Math.abs(g.pos - g.target) < REST_DIST && Math.abs(g.vel) < REST_SPEED) {
      g.pos = g.target;
      glides.delete(el);
    }
    write(el, g.pos);
    g.written = el.scrollTop;
  }
  for (const hook of [...frameHooks]) hook();
  if (glides.size > 0) schedule();
}

/** Glide `el` to `y` (clamped to its scroll range). `instant` (or reduced motion) jumps there with no animation. */
export function glideTo(el: Scroller, y: number, options?: { instant?: boolean }) {
  const target = clamp(y, 0, maxScroll(el));
  if (options?.instant || reducedMotion()) {
    glides.delete(el);
    write(el, target);
    return;
  }
  const g = glides.get(el);
  if (g) {
    g.target = target;
  } else {
    const cur = el.scrollTop;
    glides.set(el, { el, pos: cur, vel: 0, target, written: cur });
  }
  schedule();
}

/** Glide by `dy` from wherever the current glide is heading (or from the current position when idle). */
export function glideBy(el: Scroller, dy: number) {
  glideTo(el, (glides.get(el)?.target ?? el.scrollTop) + dy);
}

/** Stop animating `el` where it is (a drag, a press or a touchpad takes over). */
export function stopGlide(el: Scroller) {
  glides.delete(el);
}

export function isGliding(el: Scroller): boolean {
  return glides.has(el);
}

/** Where the current glide is heading, or null when `el` isn't gliding. */
export function glideTarget(el: Scroller): number | null {
  return glides.get(el)?.target ?? null;
}

/** Runs in the same animation frame as the engine's scroll writes, after them. Returns an unsubscribe. */
export function onSmoothFrame(hook: () => void): () => void {
  frameHooks.add(hook);
  return () => {
    frameHooks.delete(hook);
  };
}

/** Test helper: drop every glide and pending frame. */
export function resetEngine() {
  glides.clear();
  frameHooks.clear();
  if (raf && typeof cancelAnimationFrame === "function") cancelAnimationFrame(raf);
  raf = 0;
  reducedQuery = null;
}
