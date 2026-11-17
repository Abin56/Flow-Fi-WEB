// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cycleContaining } from "@/lib/engines/person-cycle-statement";
import type { PersonPaymentDeferral } from "@/lib/models/person-payment-deferral";
import { UpcomingCycleAlert } from "./upcoming-cycle-alert";

/**
 * The in-app "Upcoming cycle" reminder: a day before the next Month Cycle starts it lists what was postponed INTO that
 * cycle — as a reminder (not an overdue notice), reading only, opening the collection directly, shown once per cycle.
 */

const h = vi.hoisted(() => ({
  deferrals: {} as Record<string, unknown[]>,
  remaining: {} as Record<string, Record<string, number>>,
  startDay: 18,
}));

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));
vi.mock("@/store/auth-store", () => ({ useAuthStore: (sel: (s: { user: { uid: string } }) => unknown) => sel({ user: { uid: "u1" } }) }));
vi.mock("@/hooks/use-people", () => ({
  usePeople: () => ({
    data: [
      { id: "dad", name: "DAD" },
      { id: "rahul", name: "Rahul" },
    ],
  }),
}));
vi.mock("@/features/settings/hooks/use-user-preferences", () => ({ useMonthCycleStartDay: () => h.startDay }));
vi.mock("@/features/people/hooks/use-payment-deferrals", () => ({ useAllPersonDeferrals: () => ({ deferralsByPerson: h.deferrals, isLoading: false }) }));
vi.mock("@/features/people/hooks/use-person-cycle-statement", () => ({
  usePeopleCycleStatements: () => ({
    statementsByPersonId: Object.fromEntries(Object.entries(h.remaining).map(([id, rows]) => [id, { rows: Object.entries(rows).map(([key, remainingNow]) => ({ kind: "obligation", key, remainingNow })) }])),
    isLoading: false,
  }),
}));

const d = (y: number, m: number, day: number) => new Date(y, m - 1, day);

function deferral(personId: string, key: string, title: string, cycleOf: Date, startDay = 18): PersonPaymentDeferral {
  const cycle = cycleContaining(cycleOf, startDay);
  return {
    id: encodeURIComponent(key), personId, obligationKey: key, obligationTitle: title, state: "active",
    expected: { cycle: { start: cycle.start, end: cycle.end }, date: null, reason: null, note: null },
    cycleStartDay: startDay, revision: 1, lastRequestId: "r", frames: [], history: [], createdAt: d(2026, 10, 1), updatedAt: d(2026, 10, 1),
  } as PersonPaymentDeferral;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(d(2026, 11, 17)); // the day before the cycle starting 18 Nov
  window.localStorage.clear();
  h.startDay = 18;
  h.deferrals = {
    dad: [deferral("dad", "ledger:a", "September EMI", d(2026, 12, 1))],
    rahul: [deferral("rahul", "ledger:b", "Trip", d(2026, 12, 1))],
  };
  h.remaining = { dad: { "ledger:a": 1000 }, rahul: { "ledger:b": 2000 } };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("UpcomingCycleAlert", () => {
  it("on 17 Nov: 'Upcoming cycle · 18 Nov', 2 postponed collections, who owes what, the total — and says it is not due yet", () => {
    render(<UpcomingCycleAlert onOpen={vi.fn()} />);
    const card = screen.getByTestId("upcoming-cycle-alert");
    expect(card.textContent).toContain("Upcoming cycle · 18 Nov");
    expect(card.textContent).toContain("Not due yet — starts tomorrow");
    expect(card.textContent).toContain("2 postponed collections");
    expect(card.textContent).toContain("DAD₹1,000");
    expect(card.textContent).toContain("Rahul₹2,000");
    expect(card.textContent).toContain("Total expected₹3,000");
    expect(card.textContent).toContain("Reminder only — nothing is recorded.");
  });

  it("renders nothing outside the window, with nothing postponed into the cycle, or once everything is paid", () => {
    vi.setSystemTime(d(2026, 11, 10));
    const { container, rerender } = render(<UpcomingCycleAlert onOpen={vi.fn()} />);
    expect(container.textContent).toBe("");
    vi.setSystemTime(d(2026, 11, 17));
    h.remaining = { dad: { "ledger:a": 0 }, rahul: { "ledger:b": 0 } };
    rerender(<UpcomingCycleAlert onOpen={vi.fn()} />);
    expect(container.textContent).toBe("");
  });

  it("View collections lists each item; choosing one opens exactly that collection", () => {
    const onOpen = vi.fn();
    render(<UpcomingCycleAlert onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: /view collections/i }));
    fireEvent.click(screen.getByRole("button", { name: /rahul/i }));
    expect(onOpen).toHaveBeenCalledWith("rahul", "ledger:b");
  });

  it("a single collection opens straight from its own button", () => {
    h.deferrals = { dad: h.deferrals.dad };
    h.remaining = { dad: { "ledger:a": 1000 } };
    const onOpen = vi.fn();
    render(<UpcomingCycleAlert onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: /view collection$/i }));
    expect(onOpen).toHaveBeenCalledWith("dad", "ledger:a");
  });

  it("dismissing hides it for this cycle (no duplicate reminder), and it stays hidden after a reload", () => {
    const { unmount } = render(<UpcomingCycleAlert onOpen={vi.fn()} />);
    act(() => fireEvent.click(screen.getByRole("button", { name: /dismiss reminder/i })));
    expect(screen.queryByTestId("upcoming-cycle-alert")).toBeNull();
    unmount();
    const again = render(<UpcomingCycleAlert onOpen={vi.fn()} />);
    expect(again.container.textContent).toBe("");
  });

  it("calendar-month cycles and the year boundary: 31 Dec → items postponed into January", () => {
    h.startDay = 1;
    vi.setSystemTime(d(2026, 12, 31));
    h.deferrals = { dad: [deferral("dad", "ledger:a", "Rent share", d(2027, 1, 10), 1)] };
    h.remaining = { dad: { "ledger:a": 900 } };
    render(<UpcomingCycleAlert onOpen={vi.fn()} />);
    expect(screen.getByTestId("upcoming-cycle-alert").textContent).toContain("Upcoming cycle · 01 Jan 2027");
  });
});
