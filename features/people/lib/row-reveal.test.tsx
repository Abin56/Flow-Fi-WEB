// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { revealBlock, revealDelta, useRevealWhenItGrows } from "./row-reveal";

/**
 * Expanding a ledger row must bring it into comfortable view WITHOUT needless movement: nothing when it is already
 * visible, the smallest move when it is cut off, clear of sticky headers, and the right scroller (the table's own, then
 * the page's). `revealDelta` is the whole decision; `revealBlock` applies it to real scrolling ancestors.
 */

const VIEW = { top: 100, bottom: 600 }; // 500px tall

describe("revealDelta", () => {
  it("is 0 when the block is already comfortably inside the view", () => {
    expect(revealDelta({ top: 200, bottom: 400 }, VIEW)).toBe(0);
    // exactly on the safe edges (12px margin) still counts as visible
    expect(revealDelta({ top: 112, bottom: 588 }, VIEW)).toBe(0);
  });

  it("scrolls down by just enough when the panel runs past the bottom", () => {
    // bottom 700, safe bottom 588 → 112px
    expect(revealDelta({ top: 450, bottom: 700 }, VIEW)).toBe(112);
  });

  it("scrolls up by just enough when the row sits above the top", () => {
    expect(revealDelta({ top: 40, bottom: 200 }, VIEW)).toBe(-72); // safe top 112
  });

  it("keeps the block clear of a sticky header at the top and a bar at the bottom", () => {
    // 28px table header: safe top 140. A row at 120 is under the header's shadow → move it into the clear.
    expect(revealDelta({ top: 120, bottom: 300 }, VIEW, { top: 28 })).toBe(-20);
    // 56px bottom bar: safe bottom 532
    expect(revealDelta({ top: 300, bottom: 560 }, VIEW, { bottom: 56 })).toBe(28);
  });

  it("a block taller than the view leads with its top (the row header stays visible)", () => {
    expect(revealDelta({ top: 300, bottom: 1100 }, VIEW)).toBe(300 - 112);
    expect(revealDelta({ top: 20, bottom: 900 }, VIEW)).toBe(20 - 112);
  });

  it("ignores tiny moves and never acts in a view with no room", () => {
    expect(revealDelta({ top: 110, bottom: 300 }, VIEW)).toBe(0); // 2px off the margin
    expect(revealDelta({ top: 0, bottom: 10 }, { top: 0, bottom: 20 }, { top: 10, bottom: 10 })).toBe(0);
  });
});

const rect = (top: number, bottom: number, left = 0, width = 800) =>
  ({ top, bottom, left, right: left + width, width, height: bottom - top, x: left, y: top, toJSON() {} }) as DOMRect;

function scroller(top: number, bottom: number, scrollHeight = 3000): HTMLDivElement {
  const el = document.createElement("div");
  el.style.overflowY = "auto";
  Object.defineProperty(el, "scrollHeight", { value: scrollHeight, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: bottom - top, configurable: true });
  el.getBoundingClientRect = () => rect(top, bottom);
  el.scrollBy = vi.fn() as never;
  return el;
}

function block(parent: HTMLElement, top: number, bottom: number): HTMLDivElement {
  const el = document.createElement("div");
  el.getBoundingClientRect = () => rect(top, bottom);
  parent.appendChild(el);
  return el;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.body.innerHTML = "";
  // @ts-expect-error test cleanup of the probe stub
  delete document.elementsFromPoint;
});

describe("revealBlock", () => {
  it("does nothing when the row and its panel are already visible", () => {
    const s = scroller(100, 600);
    document.body.appendChild(s);
    revealBlock(block(s, 200, 400));
    expect(s.scrollBy).not.toHaveBeenCalled();
  });

  it("scrolls the table's own container smoothly when the panel is cut off at the bottom", () => {
    const s = scroller(100, 600);
    document.body.appendChild(s);
    revealBlock(block(s, 450, 700));
    expect(s.scrollBy).toHaveBeenCalledWith({ top: 112, behavior: "smooth" });
  });

  it("measures from the row to the END of its panel (desktop: two table rows)", () => {
    const s = scroller(100, 600);
    document.body.appendChild(s);
    const row = block(s, 450, 480);
    const panel = block(s, 480, 760);
    revealBlock(row, panel);
    expect(s.scrollBy).toHaveBeenCalledWith({ top: 760 - 588, behavior: "smooth" });
  });

  it("clears a sticky table header found at the top of the scroll area", () => {
    const s = scroller(100, 600);
    const th = document.createElement("div");
    th.style.position = "sticky";
    th.getBoundingClientRect = () => rect(100, 128);
    s.appendChild(th);
    document.body.appendChild(s);
    // Spatial stub: the header is what the browser paints in the top 28px of the area.
    document.elementsFromPoint = (_x: number, y: number) => (y >= 100 && y <= 128 ? [th, s] : [s]);
    revealBlock(block(s, 120, 300));
    expect(s.scrollBy).toHaveBeenCalledWith({ top: -20, behavior: "smooth" });
  });

  it("uses reduced motion when the user asks for it", () => {
    const s = scroller(100, 600);
    document.body.appendChild(s);
    window.matchMedia = ((q: string) => ({ matches: q.includes("reduce"), media: q })) as never;
    revealBlock(block(s, 450, 700));
    expect(s.scrollBy).toHaveBeenCalledWith({ top: 112, behavior: "auto" });
    // @ts-expect-error test cleanup
    delete window.matchMedia;
  });

  it("scrolls only the scroller that needs it: an inner table that fits leaves the page to move", () => {
    const page = scroller(0, 800);
    const inner = scroller(300, 1100); // taller than the page's view — its lower part is below the fold
    page.appendChild(inner);
    document.body.appendChild(page);
    revealBlock(block(inner, 900, 1000));
    expect(inner.scrollBy).not.toHaveBeenCalled(); // inside the inner view already
    expect(page.scrollBy).toHaveBeenCalledWith({ top: 1000 - 788, behavior: "smooth" });
  });

  it("is a no-op where nothing scrolls (jsdom / short page)", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    expect(() => revealBlock(block(el, 0, 10))).not.toThrow();
  });
});

describe("useRevealWhenItGrows", () => {
  /** A scroller (view 100–600) holding a panel with a control; the panel's height and the observer are ours to drive. */
  function mount() {
    let height = 100;
    let notify: () => void = () => {};
    class FakeObserver {
      constructor(cb: () => void) {
        notify = cb;
      }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", FakeObserver);
    function Panel() {
      const ref = useRef<HTMLDivElement>(null);
      useRevealWhenItGrows(ref);
      return (
        <div data-testid="scroller" style={{ overflowY: "auto" }}>
          <div ref={ref} data-testid="panel">
            <button type="button">More details</button>
          </div>
        </div>
      );
    }
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { getByTestId, getByRole } = render(<Panel />);
    const scroller = getByTestId("scroller");
    const panel = getByTestId("panel");
    const button = getByRole("button");
    Object.defineProperty(scroller, "scrollHeight", { value: 3000, configurable: true });
    Object.defineProperty(scroller, "clientHeight", { value: 500, configurable: true });
    Object.defineProperty(panel, "offsetHeight", { get: () => height, configurable: true });
    scroller.getBoundingClientRect = () => rect(100, 600);
    scroller.scrollBy = vi.fn() as never;
    // The panel starts at y=400; it grows downward. The control sits 60px into it.
    panel.getBoundingClientRect = () => rect(400, 400 + height);
    button.getBoundingClientRect = () => rect(460, 490);
    const grow = (to: number) => {
      height = to;
      act(() => notify());
      act(() => void vi.advanceTimersByTime(80));
    };
    return { scroller, button, grow };
  }

  it("after the user's click, keeps the control and what it revealed in view", () => {
    const { scroller, button, grow } = mount();
    act(() => void vi.advanceTimersByTime(600)); // past the row's own reveal window
    fireEvent.pointerDown(button);
    grow(300); // panel now 400–700; the span control→bottom is 460–700, past the safe bottom 588 by 112
    expect(scroller.scrollBy).toHaveBeenCalledWith({ top: 112, behavior: "smooth" });
  });

  it("never moves the page for growth the user did not just cause (a live data update)", () => {
    const { scroller, grow } = mount();
    act(() => void vi.advanceTimersByTime(600));
    grow(300);
    expect(scroller.scrollBy).not.toHaveBeenCalled();
  });

  it("leaves the first moments after mounting to the row's own reveal", () => {
    const { scroller, button, grow } = mount();
    fireEvent.pointerDown(button);
    grow(300); // still inside the mount window
    expect(scroller.scrollBy).not.toHaveBeenCalled();
  });

  it("does nothing when the grown panel is already comfortably in view", () => {
    const { scroller, button, grow } = mount();
    act(() => void vi.advanceTimersByTime(600));
    fireEvent.pointerDown(button);
    grow(150); // 400–550: inside the view
    expect(scroller.scrollBy).not.toHaveBeenCalled();
  });
});
