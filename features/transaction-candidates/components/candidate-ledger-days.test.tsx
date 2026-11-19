// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SmsTransactionCandidate } from "@/lib/models/sms-transaction-candidate";
import { deriveCandidateStatus } from "../lib/candidate-status";
import { CandidateLedger, type LedgerGroup, type ScopeSelection } from "./candidate-ledger";
import { DOCK_MAX, DOCK_REACH, dockScale } from "./day-navigator";
import type { CandidateRowModel } from "./candidate-row-parts";

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));
vi.mock("@/store/toast-store", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

beforeEach(() => {
  window.localStorage.setItem("flowfi.inbox.layout", "grid");
  window.sessionStorage.removeItem("flowfi.inbox.day");
});
afterEach(() => {
  cleanup();
  window.localStorage.removeItem("flowfi.inbox.layout");
  window.sessionStorage.removeItem("flowfi.inbox.day");
});

function candidate(id: string, date: Date, over: Partial<SmsTransactionCandidate> = {}): SmsTransactionCandidate {
  return {
    id,
    amount: 321,
    direction: "debit",
    eventType: "upiPayment",
    transactionDate: date,
    merchant: `Merchant ${id}`,
    bankName: "QA Bank",
    rawLastFour: null,
    accountId: "acc-1",
    cardId: null,
    referenceNumber: null,
    confidenceLevel: "high",
    confidenceScore: 0.9,
    needsReview: false,
    needsReviewReasons: [],
    source: "sms",
    createdAt: date,
    deletedAt: null,
    ...over,
  };
}

function row(c: SmsTransactionCandidate, selected = false): CandidateRowModel {
  return {
    candidate: c,
    number: 1,
    status: deriveCandidateStatus(c, null, "matched"),
    duplicate: null,
    destinationState: "matched",
    accountLabel: "QA Bank •••• 4821",
    identity: null,
    accountHint: "QA Bank",
    selected,
    selectBlockedReason: null,
  };
}

/** Rows given newest-first (what the default sort hands the ledger), grouped per day like the workspace does. */
function groupsOf(rows: CandidateRowModel[]): LedgerGroup[] {
  const byDay = new Map<string, CandidateRowModel[]>();
  for (const r of rows) {
    const d = r.candidate.transactionDate;
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    byDay.set(key, [...(byDay.get(key) ?? []), r]);
  }
  return [...byDay.entries()].map(([key, rs]) => ({ key, label: key, dateText: null, flat: false, rows: rs }));
}

const d = (m: number, day: number, h = 12) => new Date(2026, m - 1, day, h);

// Oct: 21 (1), 18 (1), 3 (2) · Sep: 30 (1) · Jan 2026: 2 (1)
const ids = (list: HTMLElement[]) => list.map((li) => li.getAttribute("data-candidate-id"));
const baseRows = () => [
  row(candidate("o21", d(10, 21))),
  row(candidate("o18", d(10, 18))),
  row(candidate("o03b", d(10, 3, 18))),
  row(candidate("o03a", d(10, 3, 9))),
  row(candidate("s30", d(9, 30))),
  row(candidate("j02", d(1, 2))),
];

function renderGrid(rows: CandidateRowModel[], extra: { onToggleAll?: (checked: boolean, scopeIds?: readonly string[]) => void; selectionForScope?: (ids: readonly string[]) => ScopeSelection } = {}) {
  const groups = groupsOf(rows);
  const ui = (g: LedgerGroup[]) => (
    <CandidateLedger
      groups={g}
      shownCount={rows.length}
      queueCount={rows.length}
      allSelected={false}
      someSelected={false}
      selectAllDisabled={false}
      onToggleAll={extra.onToggleAll ?? (() => {})}
      selectionForScope={extra.selectionForScope}
      onToggle={() => {}}
      onReview={() => {}}
      candidateRepository={null}
      onHide={() => {}}
      onUnhide={() => {}}
    />
  );
  const view = render(ui(groups));
  return { ...view, update: (next: CandidateRowModel[]) => view.rerender(ui(groupsOf(next))) };
}

const cards = () => within(screen.getByTestId("candidate-grid")).getAllByTestId("candidate-row");
const chips = () => screen.getAllByTestId("candidate-day-chip");
/** "03:2" — the day number a chip shows, and the transaction count it carries. */
const chipLabel = (c: HTMLElement) => `${c.textContent}:${c.getAttribute("data-count")}`;
const chipOf = (day: string) => chips().find((c) => c.getAttribute("data-day") === day)!;
const openDay = () => screen.getByTestId("candidate-group").getAttribute("data-group-key");

describe("day-wise grid", () => {
  it("opens on the newest day and shows only that day's cards", () => {
    renderGrid(baseRows());
    expect(openDay()).toBe("2026-10-21");
    expect(ids(cards())).toEqual(["o21"]);
    expect(screen.getByRole("heading", { name: "21 October 2026" })).toBeTruthy();
    expect(screen.getByTestId("candidate-day-total").textContent).toBe("1 transaction");
  });

  it("lists only days of the open month that have transactions — a compact day number with its count behind it", () => {
    renderGrid(baseRows());
    expect(chips().map((c) => c.getAttribute("data-day"))).toEqual(["2026-10-03", "2026-10-18", "2026-10-21"]);
    const third = chipOf("2026-10-03");
    // The visible chip is just the number (no weekday, no count box); weekday + exact count live in the accessible name and the hover label.
    expect(third.textContent).toBe("03");
    expect(third.getAttribute("data-count")).toBe("2");
    expect(third.getAttribute("aria-label")).toBe("Saturday, 03 October 2026, 2 transactions");
    expect(chipOf("2026-10-21").getAttribute("aria-selected")).toBe("true");
    expect(third.getAttribute("aria-selected")).toBe("false");
  });

  it("one click on a day swaps the cards — a day with several transactions shows them all, in the existing order", () => {
    renderGrid(baseRows());
    fireEvent.click(chipOf("2026-10-03"));
    expect(openDay()).toBe("2026-10-03");
    expect(ids(cards())).toEqual(["o03b", "o03a"]);
    expect(screen.getByTestId("candidate-day-total").textContent).toBe("2 transactions");
    expect(screen.getByRole("heading", { name: "03 October 2026" })).toBeTruthy();
    expect(chipOf("2026-10-03").getAttribute("aria-selected")).toBe("true");
  });

  it("cards keep their existing content and controls (checkbox, Review, amount, merchant)", () => {
    renderGrid(baseRows());
    const card = cards()[0];
    expect(within(card).getByRole("checkbox")).toBeTruthy();
    expect(within(card).getByRole("button", { name: /^Review/ })).toBeTruthy();
    expect(card.textContent).toContain("Merchant o21");
    expect(card.textContent).toContain("−₹321");
  });

  it("previous / next day cross month and year boundaries and stop at the ends", () => {
    renderGrid(baseRows());
    const prev = screen.getByTestId("candidate-day-prev");
    const next = screen.getByTestId("candidate-day-next");
    expect(next.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(prev);
    expect(openDay()).toBe("2026-10-18");
    fireEvent.click(prev);
    fireEvent.click(prev);
    expect(openDay()).toBe("2026-09-30"); // Oct 3 → Sep 30, skipping the empty days between
    fireEvent.click(prev);
    expect(openDay()).toBe("2026-01-02");
    expect(prev.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(prev);
    expect(openDay()).toBe("2026-01-02");
    fireEvent.click(next);
    expect(openDay()).toBe("2026-09-30");
  });

  it("previous / next month skip empty months and land on the day next to where you were", () => {
    renderGrid(baseRows());
    expect(screen.getByTestId("candidate-month-title").textContent).toBe("October 2026");
    fireEvent.click(screen.getByTestId("candidate-month-prev"));
    expect(screen.getByTestId("candidate-month-title").textContent).toBe("September 2026");
    expect(openDay()).toBe("2026-09-30");
    fireEvent.click(screen.getByTestId("candidate-month-prev"));
    expect(screen.getByTestId("candidate-month-title").textContent).toBe("January 2026"); // Feb–Aug are empty → skipped
    expect(screen.getByTestId("candidate-month-prev").getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(screen.getByTestId("candidate-month-next"));
    fireEvent.click(screen.getByTestId("candidate-month-next"));
    expect(openDay()).toBe("2026-10-03"); // arriving forward opens the FIRST day of October
  });

  it("arrow keys, Home and End move between the days in the strip", () => {
    renderGrid(baseRows());
    const strip = screen.getByTestId("candidate-day-strip");
    fireEvent.keyDown(strip, { key: "Home" });
    expect(openDay()).toBe("2026-10-03");
    fireEvent.keyDown(strip, { key: "ArrowRight" });
    expect(openDay()).toBe("2026-10-18");
    fireEvent.keyDown(strip, { key: "End" });
    expect(openDay()).toBe("2026-10-21");
    fireEvent.keyDown(strip, { key: "ArrowRight" }); // already last: nothing happens, no error
    expect(openDay()).toBe("2026-10-21");
    // Roving focus: only the open day is in the tab order.
    expect(chips().filter((c) => c.tabIndex === 0)).toHaveLength(1);
  });

  it("is a tablist with a labelled tabpanel for the cards", () => {
    renderGrid(baseRows());
    const panel = screen.getByRole("tabpanel");
    expect(panel.getAttribute("aria-labelledby")).toBe(chipOf("2026-10-21").id);
    expect(screen.getByRole("tablist").getAttribute("aria-label")).toMatch(/October 2026/);
  });
});

describe("day-wise grid follows the filters and live changes", () => {
  it("keeps the open day through ordinary updates and updates its count when a card is dismissed", () => {
    const { update } = renderGrid(baseRows());
    fireEvent.click(chipOf("2026-10-03"));
    update(baseRows().filter((r) => r.candidate.id !== "o03a")); // one of the two leaves
    expect(openDay()).toBe("2026-10-03");
    expect(ids(cards())).toEqual(["o03b"]);
    expect(chipLabel(chipOf("2026-10-03"))).toBe("03:1");
  });

  it("moves to the nearest day when the open day empties, and returns to it when it is back (Undo / filter cleared)", () => {
    const { update } = renderGrid(baseRows());
    fireEvent.click(chipOf("2026-10-18"));
    update(baseRows().filter((r) => r.candidate.id !== "o18"));
    expect(chips().some((c) => c.getAttribute("data-day") === "2026-10-18")).toBe(false); // no empty-day button
    expect(openDay()).toBe("2026-10-21"); // 3 days away vs 15 → the 21st
    update(baseRows());
    expect(openDay()).toBe("2026-10-18");
  });

  it("filtered-out days and months disappear from the strip and the month menu", () => {
    const { update } = renderGrid(baseRows());
    update(baseRows().filter((r) => r.candidate.id.startsWith("o")));
    fireEvent.click(chipOf("2026-10-03"));
    expect(screen.getByTestId("candidate-month-prev").getAttribute("aria-disabled")).toBe("true"); // September/January filtered away
    expect(screen.queryByTestId("candidate-month-picker")).toBeNull(); // one month left: nothing to choose
    expect(chips().map(chipLabel)).toEqual(["03:2", "18:1", "21:1"]);
  });

  it("remembers the chosen day for the session, so coming back lands on it", () => {
    const first = renderGrid(baseRows());
    fireEvent.click(chipOf("2026-10-03"));
    first.unmount();
    cleanup();
    renderGrid(baseRows());
    expect(openDay()).toBe("2026-10-03");
  });

  it("does not slide to a newer day when one arrives while you are reviewing", () => {
    const { update } = renderGrid(baseRows());
    expect(openDay()).toBe("2026-10-21");
    update([row(candidate("o22", d(10, 22))), ...baseRows()]);
    expect(openDay()).toBe("2026-10-21");
    expect(chips().some((c) => c.getAttribute("data-day") === "2026-10-22")).toBe(true);
  });

  it("opens on the oldest day when the list is sorted oldest first", () => {
    const rows = baseRows().reverse();
    renderGrid(rows);
    expect(openDay()).toBe("2026-01-02");
  });

  it("on a non-date sort the open day still lists its cards in that sort's order, and opens on the newest day", () => {
    const rows = [row(candidate("o03a", d(10, 3, 9), { amount: 900 })), row(candidate("o21", d(10, 21), { amount: 800 })), row(candidate("o03b", d(10, 3, 18), { amount: 100 }))];
    const flat: LedgerGroup = { key: "sorted", label: "Amount", dateText: null, flat: true, rows };
    render(
      <CandidateLedger
        groups={[flat]}
        shownCount={3}
        queueCount={3}
        allSelected={false}
        someSelected={false}
        selectAllDisabled={false}
        onToggleAll={() => {}}
        onToggle={() => {}}
        onReview={() => {}}
        candidateRepository={null}
        onHide={() => {}}
        onUnhide={() => {}}
      />,
    );
    expect(openDay()).toBe("2026-10-21");
    fireEvent.click(chipOf("2026-10-03"));
    expect(ids(cards())).toEqual(["o03a", "o03b"]);
  });
});

describe("day-wise grid and selection", () => {
  it("Select all applies to the open day's cards only", () => {
    const onToggleAll = vi.fn();
    const selectionForScope = vi.fn((scope: readonly string[]) => ({ allSelected: false, someSelected: false, disabled: scope.length === 0 }));
    renderGrid(baseRows(), { onToggleAll, selectionForScope });
    fireEvent.click(chipOf("2026-10-03"));
    expect(selectionForScope).toHaveBeenLastCalledWith(["o03b", "o03a"]);
    fireEvent.click(screen.getByRole("checkbox", { name: /Select all visible candidates on this day/ }));
    expect(onToggleAll).toHaveBeenCalledWith(true, ["o03b", "o03a"]);
    expect(screen.getByText("Select all eligible on this day")).toBeTruthy();
  });

  it("says how many ticked cards sit on other days, and keeps them ticked across day changes", () => {
    const rows = baseRows();
    rows[1] = row(candidate("o18", d(10, 18)), true);
    renderGrid(rows);
    expect(screen.getByTestId("candidate-selected-elsewhere").textContent).toBe("1 selected on other days");
    fireEvent.click(chipOf("2026-10-18"));
    expect(screen.queryByTestId("candidate-selected-elsewhere")).toBeNull();
    expect(within(cards()[0]).getByRole("checkbox").getAttribute("aria-checked")).toBe("true");
  });
});

describe("list view is day-wise too", () => {
  const listRows = () => within(screen.getByTestId("candidate-list")).getAllByTestId("candidate-row");

  it("shows the open day's rows only, under the same day bar and heading", () => {
    window.localStorage.setItem("flowfi.inbox.layout", "list");
    renderGrid(baseRows());
    expect(screen.getByTestId("candidate-day-nav")).toBeTruthy();
    expect(screen.queryByTestId("candidate-grid")).toBeNull();
    expect(openDay()).toBe("2026-10-21");
    expect(ids(listRows())).toEqual(["o21"]);
    expect(screen.getAllByTestId("candidate-row")).toHaveLength(1);
    fireEvent.click(chipOf("2026-10-03"));
    expect(ids(listRows())).toEqual(["o03b", "o03a"]);
    expect(screen.getByRole("heading", { name: "03 October 2026" })).toBeTruthy();
    expect(screen.getByTestId("candidate-day-total").textContent).toBe("2 transactions");
    // Under a day heading each row shows its time, not the date again.
    expect(listRows()[0].textContent).toMatch(/6:00\s*pm/i);
    expect(listRows()[0].textContent).not.toMatch(/2026/);
  });

  it("keeps every row control (checkbox, Review) and scopes Select all to the day", () => {
    window.localStorage.setItem("flowfi.inbox.layout", "list");
    const onToggleAll = vi.fn();
    const selectionForScope = vi.fn(() => ({ allSelected: false, someSelected: false, disabled: false }));
    renderGrid(baseRows(), { onToggleAll, selectionForScope });
    fireEvent.click(chipOf("2026-10-03"));
    const first = listRows()[0];
    expect(within(first).getByRole("checkbox")).toBeTruthy();
    expect(within(first).getAllByRole("button", { name: /^Review/ }).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("checkbox", { name: /Select all visible candidates on this day/ }));
    expect(onToggleAll).toHaveBeenCalledWith(true, ["o03b", "o03a"]);
  });

  it("switching Grid ⇄ List keeps the open day and shows that day in the new layout", () => {
    renderGrid(baseRows());
    fireEvent.click(chipOf("2026-10-03"));
    fireEvent.click(screen.getByRole("button", { name: "List view" }));
    expect(openDay()).toBe("2026-10-03");
    expect(ids(listRows())).toEqual(["o03b", "o03a"]);
    expect(screen.getAllByTestId("candidate-row")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Grid view" }));
    expect(openDay()).toBe("2026-10-03");
    expect(ids(cards())).toEqual(["o03b", "o03a"]);
  });
});

describe("compact calendar navigator: small dates with subtle count dots", () => {
  it("shows one dot per transaction up to three, and two dots plus a short bar when there are more", () => {
    const many = Array.from({ length: 6 }, (_, i) => row(candidate(`m${i}`, d(10, 21, 8 + i))));
    renderGrid([...many, ...baseRows().slice(1, 4)]);
    const dotsOf = (day: string) => within(chipOf(day)).getByTestId("candidate-day-dots").children;
    expect(dotsOf("2026-10-21")).toHaveLength(3); // 6 transactions → two dots and a bar
    expect(dotsOf("2026-10-21")[2].className).toMatch(/w-2\.5/);
    expect(dotsOf("2026-10-21")[0].className).toMatch(/size-1/);
    expect(dotsOf("2026-10-03")).toHaveLength(2);
    expect(dotsOf("2026-10-18")).toHaveLength(1);
  });

  it("marks the open day with the accent pill and the others plain", () => {
    renderGrid(baseRows());
    const number = (day: string) => within(chipOf(day)).getByTestId("candidate-day-number");
    expect(number("2026-10-21").className).toMatch(/bg-primary/);
    expect(number("2026-10-03").className).not.toMatch(/bg-primary/);
    fireEvent.click(chipOf("2026-10-03"));
    expect(number("2026-10-03").className).toMatch(/bg-primary/);
    expect(number("2026-10-21").className).not.toMatch(/bg-primary/);
  });

  it("keeps the previous / next day buttons inside the navigator, one pair only", () => {
    renderGrid(baseRows());
    const nav = screen.getByTestId("candidate-day-nav");
    expect(within(nav).getByTestId("candidate-day-prev")).toBeTruthy();
    expect(within(nav).getByTestId("candidate-day-next")).toBeTruthy();
    expect(screen.getAllByTestId("candidate-day-prev")).toHaveLength(1);
    expect(within(screen.getByTestId("candidate-day-heading")).queryByTestId("candidate-day-prev")).toBeNull();
  });

  it("clicking a day selects it and swaps the cards", () => {
    renderGrid(baseRows());
    fireEvent.click(chipOf("2026-10-03"));
    expect(openDay()).toBe("2026-10-03");
    expect(ids(cards())).toEqual(["o03b", "o03a"]);
    expect(chipOf("2026-10-03").getAttribute("aria-selected")).toBe("true");
  });

  it("each date title carries the weekday, date and exact count", () => {
    renderGrid(baseRows());
    expect(chipOf("2026-10-03").getAttribute("title")).toBe("Sat, 03 Oct · 2 transactions");
    expect(chipOf("2026-10-18").getAttribute("title")).toBe("Sun, 18 Oct · 1 transaction");
  });
});

describe("dockScale (the magnification curve)", () => {
  it("is 1.5× under the pointer, ~1.2× over the next date, and gone beyond the reach", () => {
    expect(DOCK_MAX).toBe(1.5);
    expect(dockScale(0)).toBeCloseTo(DOCK_MAX, 5);
    const neighbour = dockScale(34); // one 34px cell over
    expect(neighbour).toBeGreaterThan(1.15);
    expect(neighbour).toBeLessThan(1.25);
    expect(dockScale(68)).toBeLessThan(1.05);
    expect(dockScale(DOCK_REACH)).toBe(1);
    expect(dockScale(500)).toBe(1);
  });
  it("only ever falls as the pointer moves away, and never magnifies without a pointer", () => {
    let last = Infinity;
    for (let x = 0; x <= DOCK_REACH; x += 3) {
      const s = dockScale(x);
      expect(s).toBeLessThanOrEqual(last + 1e-9);
      expect(s).toBeGreaterThanOrEqual(1);
      last = s;
    }
    expect(dockScale(Infinity)).toBe(1);
    expect(dockScale(Number.NaN)).toBe(1);
  });
});

describe("date strip under a mouse: magnification, wheel and drag", () => {
  // jsdom has no layout: give each date a 34px cell on a 34px pitch (so its centre is known), and drive animation frames by hand —
  // the dock EASES toward its targets over time, so a test advances the clock until it settles.
  let restoreRect: (() => void) | null = null;
  let queue: FrameRequestCallback[] = [];
  const flush = () =>
    act(() => {
      let now = 1000;
      for (let i = 0; i < 90; i++) {
        const frames = queue;
        queue = [];
        if (frames.length === 0) break;
        now += 16;
        frames.forEach((cb) => cb(now));
      }
    });
  const move = (strip: HTMLElement, x: number, pointerType = "mouse") => {
    fireEvent.pointerMove(strip, { clientX: x, pointerType });
    flush();
  };
  const leave = (strip: HTMLElement) => {
    fireEvent.pointerLeave(strip);
    flush();
  };
  beforeEach(() => {
    queue = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => queue.push(cb));
    const original = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      if (this.getAttribute("data-day")) {
        const i = [...document.querySelectorAll("[data-day]")].indexOf(this);
        return { left: 100 + i * 34, right: 134 + i * 34, width: 34, top: 200, bottom: 234, height: 34, x: 100 + i * 34, y: 200, toJSON() {} } as DOMRect;
      }
      if (this.getAttribute("data-testid") === "candidate-day-strip") return { left: 80, right: 600, width: 520, top: 200, bottom: 234, height: 34, x: 80, y: 200, toJSON() {} } as DOMRect;
      return original.call(this);
    };
    restoreRect = () => {
      Element.prototype.getBoundingClientRect = original;
    };
    if (typeof window.PointerEvent === "undefined") {
      class PointerEventPolyfill extends MouseEvent {
        pointerType: string;
        pointerId: number;
        constructor(type: string, init: MouseEventInit & { pointerType?: string; pointerId?: number } = {}) {
          super(type, init);
          this.pointerType = init.pointerType ?? "mouse";
          this.pointerId = init.pointerId ?? 1;
        }
      }
      vi.stubGlobal("PointerEvent", PointerEventPolyfill);
    }
  });
  afterEach(() => {
    restoreRect?.();
    vi.unstubAllGlobals();
  });

  const dock = (day: string) => chipOf(day).style.getPropertyValue("--dock");
  const lift = (day: string) => chipOf(day).style.getPropertyValue("--lift");
  const centreOf = (index: number) => 117 + index * 34; // 100 + 17 + i*34

  /** Gives the strip a scrollable width (jsdom has none) and a settable scrollLeft. */
  function scrollable(strip: HTMLElement, content = 1000, view = 300) {
    let left = 0;
    Object.defineProperty(strip, "scrollWidth", { configurable: true, value: content });
    Object.defineProperty(strip, "clientWidth", { configurable: true, value: view });
    Object.defineProperty(strip, "scrollLeft", { configurable: true, get: () => left, set: (v: number) => void (left = Math.min(content - view, Math.max(0, v))) });
    return { get left() { return left; }, set left(v: number) { left = v; } };
  }

  it("magnifies the date under the pointer 1.5×, its neighbours ≈1.2×, and the rest not at all", () => {
    renderGrid(baseRows());
    const strip = screen.getByTestId("candidate-day-strip");
    move(strip, centreOf(1), "mouse"); // over 18 Oct
    expect(Number(dock("2026-10-18"))).toBeCloseTo(DOCK_MAX, 2);
    const near = Number(dock("2026-10-03"));
    expect(near).toBeGreaterThan(1.15);
    expect(near).toBeLessThan(1.25);
    expect(Number(dock("2026-10-21"))).toBeCloseTo(near, 3); // symmetric
    expect(Number(lift("2026-10-18"))).toBeCloseTo(1, 2); // the soft backdrop is at full strength under the pointer
  });

  it("flows with the pointer: moving along the row shifts the peak", () => {
    renderGrid(baseRows());
    const strip = screen.getByTestId("candidate-day-strip");
    move(strip, centreOf(0), "mouse");
    const first = Number(dock("2026-10-03"));
    move(strip, centreOf(0) + 17, "mouse"); // half-way to 18
    expect(Number(dock("2026-10-03"))).toBeLessThan(first);
    expect(Number(dock("2026-10-18"))).toBeGreaterThan(1.3);
    move(strip, centreOf(2), "mouse");
    expect(Number(dock("2026-10-21"))).toBeCloseTo(DOCK_MAX, 2);
    expect(Number(dock("2026-10-03"))).toBeLessThan(1.05); // two dates away: all but gone
  });

  it("returns every date to rest when the pointer leaves", () => {
    renderGrid(baseRows());
    const strip = screen.getByTestId("candidate-day-strip");
    move(strip, centreOf(1), "mouse");
    expect(Number(dock("2026-10-18"))).toBeGreaterThan(1.4);
    leave(strip);
    for (const day of ["2026-10-03", "2026-10-18", "2026-10-21"]) {
      expect(dock(day)).toBe("1");
      expect(lift(day)).toBe("0");
    }
  });

  it("keeps the open day highlighted while hovering other days, and after the pointer leaves", () => {
    renderGrid(baseRows());
    const strip = screen.getByTestId("candidate-day-strip");
    move(strip, centreOf(0), "mouse");
    expect(chipOf("2026-10-21").getAttribute("aria-selected")).toBe("true");
    expect(within(chipOf("2026-10-21")).getByTestId("candidate-day-number").className).toMatch(/bg-primary/);
    leave(strip);
    expect(within(chipOf("2026-10-21")).getByTestId("candidate-day-number").className).toMatch(/bg-primary/);
  });

  it("ignores touch input, and magnifies nothing under reduced motion", () => {
    renderGrid(baseRows());
    const strip = screen.getByTestId("candidate-day-strip");
    move(strip, centreOf(1), "touch");
    expect(dock("2026-10-18")).toBe("");
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: /reduce/.test(query), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }));
    move(strip, centreOf(1), "mouse");
    expect(dock("2026-10-18")).toBe("");
  });

  it("clicking a date while it is magnified selects it and swaps the cards", () => {
    renderGrid(baseRows());
    const strip = screen.getByTestId("candidate-day-strip");
    move(strip, centreOf(0), "mouse");
    fireEvent.click(chipOf("2026-10-03"));
    expect(openDay()).toBe("2026-10-03");
    expect(ids(cards())).toEqual(["o03b", "o03a"]);
    expect(chipOf("2026-10-03").getAttribute("aria-selected")).toBe("true");
  });

  it("the wheel scrolls the strip sideways (eased), and gives the page the wheel at either end", () => {
    renderGrid(baseRows());
    const strip = screen.getByTestId("candidate-day-strip");
    const pos = scrollable(strip);
    pos.left = 0;
    // at the start, scrolling UP has nowhere to go: the page keeps it
    const up = new WheelEvent("wheel", { deltaY: -100, cancelable: true, bubbles: true });
    strip.dispatchEvent(up);
    expect(up.defaultPrevented).toBe(false);
    // scrolling down moves the strip, not the page
    const down = new WheelEvent("wheel", { deltaY: 120, cancelable: true, bubbles: true });
    strip.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    flush();
    expect(pos.left).toBeCloseTo(120, 0);
    // a trackpad's sideways swipe is the browser's own: not intercepted
    const side = new WheelEvent("wheel", { deltaX: 80, deltaY: 4, cancelable: true, bubbles: true });
    strip.dispatchEvent(side);
    expect(side.defaultPrevented).toBe(false);
    // at the far end the page takes the wheel again
    pos.left = 700;
    const end = new WheelEvent("wheel", { deltaY: 100, cancelable: true, bubbles: true });
    strip.dispatchEvent(end);
    expect(end.defaultPrevented).toBe(false);
  });

  it("does not take the wheel at all when every date already fits", () => {
    renderGrid(baseRows());
    const strip = screen.getByTestId("candidate-day-strip");
    scrollable(strip, 300, 300);
    const wheel = new WheelEvent("wheel", { deltaY: 100, cancelable: true, bubbles: true });
    strip.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(false);
  });

  it("click-and-drag scrolls the strip 1:1 and the click that ends the drag selects nothing", () => {
    renderGrid(baseRows());
    const strip = screen.getByTestId("candidate-day-strip");
    const pos = scrollable(strip);
    pos.left = 200;
    fireEvent.pointerDown(strip, { clientX: 400, pointerType: "mouse", button: 0, pointerId: 1 });
    fireEvent.pointerMove(strip, { clientX: 380, pointerType: "mouse", pointerId: 1 });
    fireEvent.pointerMove(strip, { clientX: 340, pointerType: "mouse", pointerId: 1 });
    expect(pos.left).toBe(260); // dragged 60px left → content moves with the pointer
    expect(strip.dataset.dragging).toBe("true");
    fireEvent.pointerUp(strip, { clientX: 340, pointerType: "mouse", pointerId: 1 });
    expect(strip.dataset.dragging).toBeUndefined();
    fireEvent.click(chipOf("2026-10-03")); // the click a browser sends after the drag
    expect(openDay()).toBe("2026-10-21"); // swallowed
    fireEvent.click(chipOf("2026-10-03")); // an ordinary click works again
    expect(openDay()).toBe("2026-10-03");
  });

  it("a press without movement is a plain click, not a drag", () => {
    renderGrid(baseRows());
    const strip = screen.getByTestId("candidate-day-strip");
    scrollable(strip);
    fireEvent.pointerDown(strip, { clientX: 400, pointerType: "mouse", button: 0, pointerId: 1 });
    fireEvent.pointerMove(strip, { clientX: 402, pointerType: "mouse", pointerId: 1 });
    fireEvent.pointerUp(strip, { clientX: 402, pointerType: "mouse", pointerId: 1 });
    expect(strip.dataset.dragging).toBeUndefined();
    fireEvent.click(chipOf("2026-10-03"));
    expect(openDay()).toBe("2026-10-03");
  });
});
