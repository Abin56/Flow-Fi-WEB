// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { glideTarget, resetEngine } from "@/lib/scroll/engine";
import { findWheelScroller, isWheelNotch, mountSmoothWheel, resetWheelState, wheelPixels } from "@/lib/scroll/wheel";

/** jsdom has no layout: give an element real scroll metrics. */
function scroller(opts: { client?: number; scroll?: number; top?: number; overflow?: string; overscroll?: string; parent?: HTMLElement }) {
  const el = document.createElement("div");
  el.style.overflowY = opts.overflow ?? "auto";
  if (opts.overscroll) el.style.setProperty("overscroll-behavior-y", opts.overscroll);
  Object.defineProperty(el, "clientHeight", { configurable: true, value: opts.client ?? 400 });
  Object.defineProperty(el, "scrollHeight", { configurable: true, value: opts.scroll ?? 2000 });
  let top = opts.top ?? 0;
  Object.defineProperty(el, "scrollTop", { configurable: true, get: () => top, set: (v: number) => (top = v) });
  el.scrollTo = ((o: ScrollToOptions) => {
    top = o.top ?? 0;
  }) as typeof el.scrollTo;
  (opts.parent ?? document.body).appendChild(el);
  return el;
}

beforeEach(() => {
  document.body.innerHTML = "";
  resetEngine();
  resetWheelState();
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isWheelNotch", () => {
  it("treats line/page modes as notches", () => {
    expect(isWheelNotch({ deltaMode: 1, deltaY: 3 })).toBe(true);
    expect(isWheelNotch({ deltaMode: 2, deltaY: 1 })).toBe(true);
  });
  it("Chrome mouse wheel: wheelDeltaY in whole 120s is a notch (any page zoom)", () => {
    expect(isWheelNotch({ deltaMode: 0, deltaY: 100, wheelDeltaY: -120 })).toBe(true);
    expect(isWheelNotch({ deltaMode: 0, deltaY: 80, wheelDeltaY: -120 })).toBe(true);
    expect(isWheelNotch({ deltaMode: 0, deltaY: 33, wheelDeltaY: -120 })).toBe(true);
    expect(isWheelNotch({ deltaMode: 0, deltaY: 200, wheelDeltaY: -240 })).toBe(true);
  });
  it("touchpad: arbitrary wheelDeltaY or small pixel deltas are never smoothed", () => {
    expect(isWheelNotch({ deltaMode: 0, deltaY: 12, wheelDeltaY: -36 })).toBe(false);
    expect(isWheelNotch({ deltaMode: 0, deltaY: 57, wheelDeltaY: -171 })).toBe(false);
    expect(isWheelNotch({ deltaMode: 0, deltaY: 7 })).toBe(false);
    expect(isWheelNotch({ deltaMode: 0, deltaY: 12, wheelDeltaY: -120 })).toBe(false); // a synthetic/odd 120 with a tiny delta
  });
  it("without wheelDeltaY the delta size decides", () => {
    expect(isWheelNotch({ deltaMode: 0, deltaY: 100 })).toBe(true);
    expect(isWheelNotch({ deltaMode: 0, deltaY: 39 })).toBe(false);
  });
});

describe("wheelPixels", () => {
  it("converts line and page modes to CSS px", () => {
    expect(wheelPixels({ deltaMode: 0, deltaY: 100 }, { clientHeight: 500 })).toBe(100);
    expect(wheelPixels({ deltaMode: 1, deltaY: 3 }, { clientHeight: 500 })).toBe(99);
    expect(wheelPixels({ deltaMode: 2, deltaY: 1 }, { clientHeight: 800 })).toBe(700);
  });
});

describe("findWheelScroller", () => {
  it("picks the nearest scrollable ancestor with room", () => {
    const outer = scroller({});
    const inner = scroller({ parent: outer });
    const leaf = document.createElement("span");
    inner.appendChild(leaf);
    expect(findWheelScroller(leaf, 100)).toBe(inner);
  });

  it("chains to the parent when the inner one is at its end and may chain", () => {
    const outer = scroller({});
    const inner = scroller({ parent: outer, top: 1600 }); // at the bottom (2000 − 400)
    expect(findWheelScroller(inner, 100)).toBe(outer);
    expect(findWheelScroller(inner, -100)).toBe(inner); // up still has room
  });

  it("swallows (null) at the end of an overscroll-contained list — nothing else scrolls", () => {
    const outer = scroller({});
    const inner = scroller({ parent: outer, top: 1600, overscroll: "contain" });
    expect(findWheelScroller(inner, 100)).toBeNull();
  });

  it("ignores overflow:hidden and non-overflowing boxes", () => {
    const outer = scroller({});
    const hidden = scroller({ parent: outer, overflow: "hidden" });
    const short = scroller({ parent: outer, scroll: 400, client: 400 });
    expect(findWheelScroller(hidden, 100)).toBe(outer);
    expect(findWheelScroller(short, 100)).toBe(outer);
  });

  it("returns null when nothing scrolls", () => {
    const plain = document.createElement("div");
    document.body.appendChild(plain);
    expect(findWheelScroller(plain, 100)).toBeNull();
  });
});

describe("mountSmoothWheel", () => {
  function fire(target: Element, init: WheelEventInit & { wheelDeltaY?: number }) {
    const e = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
    if (init.wheelDeltaY !== undefined) Object.defineProperty(e, "wheelDeltaY", { value: init.wheelDeltaY });
    target.dispatchEvent(e);
    return e;
  }

  it("turns a mouse notch into a glide on the container (default prevented), leaving other containers alone", () => {
    const off = mountSmoothWheel();
    const main = scroller({});
    const table = scroller({ parent: main });
    const e = fire(table, { deltaY: 100, wheelDeltaY: -120 });
    expect(e.defaultPrevented).toBe(true);
    expect(glideTarget(table)).toBe(100);
    expect(glideTarget(main)).toBeNull();
    off();
  });

  it("leaves touchpad deltas to the browser (not prevented, nothing animated)", () => {
    const off = mountSmoothWheel();
    const el = scroller({});
    const e = fire(el, { deltaY: 12, wheelDeltaY: -36 });
    expect(e.defaultPrevented).toBe(false);
    expect(glideTarget(el)).toBeNull();
    off();
  });

  it("skips ctrl+wheel (zoom), shift+wheel and sideways swipes", () => {
    const off = mountSmoothWheel();
    const el = scroller({});
    expect(fire(el, { deltaY: 100, wheelDeltaY: -120, ctrlKey: true }).defaultPrevented).toBe(false);
    expect(fire(el, { deltaY: 100, wheelDeltaY: -120, shiftKey: true }).defaultPrevented).toBe(false);
    expect(fire(el, { deltaX: 200, deltaY: 20, wheelDeltaY: -120 }).defaultPrevented).toBe(false);
    off();
  });

  it("skips the drawer (data-smooth=own), opt-outs and text areas", () => {
    const off = mountSmoothWheel();
    const drawer = scroller({});
    drawer.setAttribute("data-smooth", "own");
    const optOut = scroller({});
    optOut.setAttribute("data-smooth", "off");
    const area = document.createElement("textarea");
    document.body.appendChild(area);
    expect(fire(drawer, { deltaY: 100, wheelDeltaY: -120 }).defaultPrevented).toBe(false);
    expect(fire(optOut, { deltaY: 100, wheelDeltaY: -120 }).defaultPrevented).toBe(false);
    expect(fire(area, { deltaY: 100, wheelDeltaY: -120 }).defaultPrevented).toBe(false);
    off();
  });

  it("respects an event something else already handled (e.g. a modal's scroll lock)", () => {
    const off = mountSmoothWheel();
    const el = scroller({});
    el.addEventListener("wheel", (ev) => ev.preventDefault());
    fire(el, { deltaY: 100, wheelDeltaY: -120 });
    expect(glideTarget(el)).toBeNull();
    off();
  });

  it("a spin that reaches the end of a container stays on it (latching) instead of moving the parent", () => {
    const off = mountSmoothWheel();
    const main = scroller({});
    const table = scroller({ parent: main, top: 1500 });
    fire(table, { deltaY: 100, wheelDeltaY: -120 }); // 1500 → target 1600 (the end)
    expect(glideTarget(table)).toBe(1600);
    fire(table, { deltaY: 100, wheelDeltaY: -120 }); // already at the end — still the table's gesture
    expect(glideTarget(table)).toBe(1600);
    expect(glideTarget(main)).toBeNull();
    off();
  });

  it("successive notches accelerate modestly (capped)", () => {
    const off = mountSmoothWheel();
    const el = scroller({ scroll: 100000 });
    let t = 1000;
    const dist: number[] = [];
    let prev = 0;
    for (let i = 0; i < 20; i++) {
      const e = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 100 });
      Object.defineProperty(e, "wheelDeltaY", { value: -120 });
      Object.defineProperty(e, "timeStamp", { value: t });
      el.dispatchEvent(e);
      const now = glideTarget(el)!;
      dist.push(now - prev);
      prev = now;
      t += 40;
    }
    expect(dist[0]).toBe(100);
    expect(dist[5]!).toBeGreaterThan(dist[0]!);
    expect(Math.max(...dist)).toBeLessThanOrEqual(160.001); // 1 + 0.6 cap
    off();
  });

  it("is silent after uninstall", () => {
    const off = mountSmoothWheel();
    off();
    const el = scroller({});
    expect(fire(el, { deltaY: 100, wheelDeltaY: -120 }).defaultPrevented).toBe(false);
  });
});
