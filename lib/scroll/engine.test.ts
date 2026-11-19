import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SPRING_OMEGA, glideBy, glideTarget, glideTo, isGliding, maxScroll, onSmoothFrame, resetEngine, stopGlide, type Scroller } from "@/lib/scroll/engine";

/** A scroller that behaves like a browser one: assignments clamp to [0, max] and `scrollTo` is instant. */
function fakeScroller(scrollHeight = 5000, clientHeight = 800): Scroller & { writes: number[] } {
  const writes: number[] = [];
  let top = 0;
  const el = {
    writes,
    scrollHeight,
    clientHeight,
    isConnected: true,
    get scrollTop() {
      return top;
    },
    set scrollTop(v: number) {
      top = Math.min(Math.max(0, v), scrollHeight - clientHeight);
    },
    scrollTo(o: ScrollToOptions) {
      writes.push(o.top ?? 0);
      el.scrollTop = o.top ?? 0;
    },
  };
  return el;
}

/** Fake frame clock: `run(ms)` advances time and fires the queued animation frame every `step` ms. */
function frameClock() {
  let now = 0;
  let cb: ((t: number) => void) | null = null;
  vi.stubGlobal("requestAnimationFrame", (f: (t: number) => void) => {
    cb = f;
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {
    cb = null;
  });
  vi.stubGlobal("performance", { now: () => now });
  return {
    run(ms: number, step = 1000 / 60, each?: (t: number) => void) {
      const end = now + ms;
      while (now < end && cb) {
        now += step;
        const f = cb;
        cb = null;
        f(now);
        each?.(now);
      }
    },
    get pending() {
      return cb !== null;
    },
  };
}

beforeEach(() => {
  resetEngine();
  vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
});
afterEach(() => {
  resetEngine();
  vi.unstubAllGlobals();
});

describe("smooth-scroll engine", () => {
  it("eases in from rest: the first frame moves only a little, and speed builds before it falls", () => {
    const clock = frameClock();
    const el = fakeScroller();
    glideTo(el, 400);
    const positions: number[] = [];
    clock.run(400, undefined, () => positions.push(el.scrollTop));
    const steps = positions.map((p, i) => p - (i === 0 ? 0 : positions[i - 1]!));
    expect(steps[0]!).toBeGreaterThan(0);
    expect(steps[0]!).toBeLessThan(400 * 0.12); // no first-frame lurch (the old ease moved 42% at once)
    const peak = steps.indexOf(Math.max(...steps));
    expect(peak).toBeGreaterThan(0); // accelerates first…
    expect(steps[peak + 3]!).toBeLessThan(steps[peak]!); // …then decelerates
  });

  it("never overshoots a fixed target and lands exactly on it", () => {
    const clock = frameClock();
    const el = fakeScroller();
    glideTo(el, 1234);
    let max = 0;
    clock.run(1500, undefined, () => (max = Math.max(max, el.scrollTop)));
    expect(max).toBeLessThanOrEqual(1234);
    expect(el.scrollTop).toBe(1234);
    expect(isGliding(el)).toBe(false);
    expect(clock.pending).toBe(false); // the loop stops by itself — nothing keeps running when still
  });

  it("settles quickly: ≈90% in ~135 ms, visually done by ~200 ms, exact within ~350 ms", () => {
    const clock = frameClock();
    const el = fakeScroller();
    glideTo(el, 500);
    clock.run(133);
    expect(el.scrollTop).toBeGreaterThan(430);
    clock.run(67);
    expect(el.scrollTop).toBeGreaterThan(490);
    clock.run(150);
    expect(el.scrollTop).toBe(500);
  });

  it("is frame-rate independent (50 Hz and 200 Hz agree at the same elapsed time)", () => {
    const at = (hz: number) => {
      resetEngine();
      const clock = frameClock();
      const el = fakeScroller();
      glideTo(el, 600);
      clock.run(120, 1000 / hz);
      return el.scrollTop;
    };
    expect(Math.abs(at(50) - at(200))).toBeLessThan(3);
  });

  it("clamps to the scroll range: top and bottom are exact", () => {
    const clock = frameClock();
    const el = fakeScroller(); // max 4200
    glideTo(el, 99999);
    clock.run(1000);
    expect(el.scrollTop).toBe(maxScroll(el));
    glideTo(el, -500);
    clock.run(1000);
    expect(el.scrollTop).toBe(0);
  });

  it("wheel notches accumulate: rapid retargets flow into one continuous motion", () => {
    const clock = frameClock();
    const el = fakeScroller();
    glideBy(el, 100);
    clock.run(33);
    const before = el.scrollTop;
    glideBy(el, 100);
    glideBy(el, 100);
    expect(glideTarget(el)).toBe(300);
    const speeds: number[] = [];
    let prev = before;
    clock.run(600, undefined, () => {
      speeds.push(el.scrollTop - prev);
      prev = el.scrollTop;
    });
    expect(el.scrollTop).toBe(300);
    expect(speeds.every((s) => s >= -0.001)).toBe(true); // never steps backwards while accumulating
  });

  it("lets go when something else moves the container (scrollbar drag, keyboard, scrollIntoView)", () => {
    const clock = frameClock();
    const el = fakeScroller();
    glideTo(el, 1000);
    clock.run(50);
    el.scrollTop = 3000; // external write
    clock.run(300);
    expect(el.scrollTop).toBe(3000);
    expect(isGliding(el)).toBe(false);
  });

  it("stopGlide freezes the container where it is", () => {
    const clock = frameClock();
    const el = fakeScroller();
    glideTo(el, 1000);
    clock.run(60);
    const here = el.scrollTop;
    stopGlide(el);
    clock.run(300);
    expect(el.scrollTop).toBe(here);
  });

  it("instant moves (and reduced motion) jump without animating", () => {
    const clock = frameClock();
    const el = fakeScroller();
    glideTo(el, 700, { instant: true });
    expect(el.scrollTop).toBe(700);
    expect(clock.pending).toBe(false);
    vi.stubGlobal("window", { matchMedia: () => ({ matches: true }) });
    resetEngine();
    glideTo(el, 900);
    expect(el.scrollTop).toBe(900);
    expect(clock.pending).toBe(false);
  });

  it("writes with behavior 'instant' so CSS scroll-behavior: smooth cannot re-animate each frame", () => {
    const clock = frameClock();
    const spy = vi.fn();
    const el = fakeScroller();
    el.scrollTo = (o: ScrollToOptions) => {
      spy(o.behavior);
      el.scrollTop = o.top ?? 0;
    };
    glideTo(el, 300);
    clock.run(100);
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls.every(([b]) => b === "instant")).toBe(true);
  });

  it("frame hooks run in the same frame, after the scroll write", () => {
    const clock = frameClock();
    const el = fakeScroller();
    const seen: number[] = [];
    const off = onSmoothFrame(() => seen.push(el.scrollTop));
    glideTo(el, 400);
    clock.run(60);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((v, i) => v === el.writes[i])).toBe(true); // each hook saw that frame's final position
    off();
  });

  it("a content-shrink during a glide retargets to the new maximum", () => {
    const clock = frameClock();
    const el = fakeScroller(5000, 800);
    glideTo(el, 4000);
    clock.run(40);
    (el as { scrollHeight: number }).scrollHeight = 2000; // max becomes 1200
    clock.run(500);
    expect(el.scrollTop).toBeLessThanOrEqual(1200);
  });

  it("uses a sensible stiffness (guards the documented ~135ms-to-90% feel)", () => {
    expect(SPRING_OMEGA).toBeGreaterThanOrEqual(24);
    expect(SPRING_OMEGA).toBeLessThanOrEqual(40);
  });
});
