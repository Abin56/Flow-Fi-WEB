// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { formatCurrency } from "@/lib/format";

/**
 * Month Cycle compact bar: the bar is a second, zero-footprint home for the cycle navigation and New transaction. It must
 * (a) stay out of the accessibility tree while hidden, (b) call the SAME handlers as the header, (c) never lose an open
 * popover or focused control to a scroll, and (d) leave the header and every figure exactly as they were.
 */

const motionPrefs = vi.hoisted(() => ({ reduce: false }));
vi.mock("framer-motion", async (importOriginal) => ({ ...(await importOriginal<typeof import("framer-motion")>()), useReducedMotion: () => motionPrefs.reduce }));
vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));
vi.mock("@/features/people/components/purpose-money-signals", () => ({ MonthCyclePurposePanel: () => null, MoneyToUseSignal: () => null }));
vi.mock("next/link", () => ({ default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => <a href={href} {...rest}>{children}</a> }));
vi.mock("@/components/foundation/animated-number", () => ({
  AnimatedNumber: ({ value, format }: { value: number; format: (v: number) => string }) => <span>{format(value)}</span>,
}));

const MY_SPENT = 4200;
const group = { count: 0, total: 0, items: [] };
const data = {
  isLoading: false,
  financialView: { spent: 9700, spentBreakdown: { "My Expenses": 4200 }, mySpent: MY_SPENT, net: 0, myNet: 0, income: 0, spentChangePercent: null, mySpentChangePercent: null },
  expenseRows: [],
  accountSpends: [],
  bills: group,
  cards: group,
  emi: group,
  loans: { ...group, carriedOverdue: 0, dueThisCycle: 0 },
  budgetOverview: null,
  cycleRange: { start: new Date(2026, 8, 18), end: new Date(2026, 9, 17, 23, 59, 59, 999) },
  daysLeftInMonth: 16,
  goToCurrentCycle: vi.fn(),
  goToCycleForMonth: vi.fn(),
  goToNextCycle: vi.fn(),
  goToPreviousCycle: vi.fn(),
  isCurrentCycle: true,
  isCustomCycle: true,
  monthCycleStartDay: 18,
  monthLabel: "18 Sep – 17 Oct",
  monthRangeLabel: "18 Sep – 17 Oct",
  monthSummary: { avgDailySpend: 0, highestSpendCategory: null, mostUsedAccount: null, pendingActionsCount: 0, totalTransactions: 1 },
  peopleHandoverPending: [],
  peopleSides: { giveCount: 0, receiveCount: 0, totalToGive: 0, totalToReceive: 0 },
  peopleStats: { netBalance: 0 },
  peopleYouNeedToGive: [],
  savingsRatePercent: 0,
};
vi.mock("@/features/month-cycle/hooks/use-month-cycle-data", () => ({ useMonthCycleData: () => data }));
vi.mock("@/hooks/use-accounts", () => ({ useAccounts: () => ({ data: [] }) }));

// Controllable IntersectionObserver: the compact-header hook is the one built with a `threshold` array.
type IoCallback = (entries: unknown[]) => void;
let headerIo: IoCallback | null = null;
class MockIntersectionObserver {
  constructor(cb: IoCallback, options?: { threshold?: unknown }) {
    if (Array.isArray(options?.threshold)) headerIo = cb;
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

/** Reports how much of the page's original title is still in view (1 = fully visible, 0 = scrolled away above). */
function titleVisible(ratio: number) {
  act(() => {
    headerIo?.([{ isIntersecting: ratio > 0, intersectionRatio: ratio, boundingClientRect: { top: ratio >= 1 ? 20 : -20 }, rootBounds: { top: 0 } }]);
  });
}

const { MonthCycleWorkspace } = await import("./month-cycle-workspace");

function renderPage() {
  return render(<TooltipProvider><MonthCycleWorkspace /></TooltipProvider>);
}
const bar = () => screen.getByRole("region", { name: "Month Cycle quick bar" });
const barEl = () => document.querySelector<HTMLElement>("[data-compact-bar]")!;

beforeEach(() => {
  headerIo = null;
  vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
  for (const fn of [data.goToCurrentCycle, data.goToCycleForMonth, data.goToNextCycle, data.goToPreviousCycle]) fn.mockClear();
  data.isCurrentCycle = true;
  motionPrefs.reduce = false;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Month Cycle compact bar — hidden", () => {
  it("is out of the accessibility tree and not focusable while the title is in view", () => {
    renderPage();
    titleVisible(1);
    expect(screen.queryByRole("region", { name: "Month Cycle quick bar" })).toBeNull();
    expect(barEl().hasAttribute("inert")).toBe(true);
    expect(barEl().getAttribute("aria-hidden")).toBe("true");
    expect(barEl().style.visibility).toBe("hidden");
    // The header keeps its single, original set of controls.
    expect(screen.getAllByRole("button", { name: "Previous cycle" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Next cycle" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Choose cycle" })).toHaveLength(1);
    expect(screen.getAllByRole("link", { name: "New transaction" })).toHaveLength(1);
  });

  it("without IntersectionObserver the bar never shows and the page is unchanged", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    renderPage();
    expect(barEl().hasAttribute("inert")).toBe(true);
    expect(screen.getAllByRole("button", { name: "Previous cycle" })).toHaveLength(1);
  });

  it("while it is still fading in (title mostly in view) it is visible but not interactive", () => {
    renderPage();
    titleVisible(0.7);
    expect(barEl().style.visibility).toBe("visible");
    expect(barEl().hasAttribute("inert")).toBe(true);
    expect(barEl().getAttribute("aria-hidden")).toBe("true");
  });
});

describe("Month Cycle compact bar — shown", () => {
  it("offers cycle navigation and New transaction, wired to the same handlers as the header", () => {
    renderPage();
    titleVisible(0);
    const b = within(bar());
    expect(barEl().hasAttribute("inert")).toBe(false);

    fireEvent.click(b.getByRole("button", { name: "Previous cycle" }));
    fireEvent.click(b.getByRole("button", { name: "Next cycle" }));
    expect(data.goToPreviousCycle).toHaveBeenCalledTimes(1);
    expect(data.goToNextCycle).toHaveBeenCalledTimes(1);

    const newTx = b.getByRole("link", { name: "New transaction" });
    expect(newTx.getAttribute("href")).toBe("/transactions");

    // Picking a month in the bar's picker reaches the very same cycle action.
    fireEvent.click(b.getByRole("button", { name: "Choose cycle" }));
    fireEvent.click(screen.getByRole("button", { name: "Next year" }));
    fireEvent.click(screen.getByRole("button", { name: "Jan" }));
    expect(data.goToCycleForMonth).toHaveBeenCalledWith(2027, 0);
  });

  it("the picker's Current cycle (Today) calls goToCurrentCycle", () => {
    renderPage();
    titleVisible(0);
    fireEvent.click(within(bar()).getByRole("button", { name: "Choose cycle" }));
    fireEvent.click(screen.getByRole("button", { name: "Current cycle" }));
    expect(data.goToCurrentCycle).toHaveBeenCalledTimes(1);
  });

  it("Back to current appears only off the current cycle, and calls goToCurrentCycle", () => {
    renderPage();
    titleVisible(0);
    expect(within(bar()).queryByRole("button", { name: "Back to current" })).toBeNull();
    cleanup();

    data.isCurrentCycle = false;
    renderPage();
    titleVisible(0);
    fireEvent.click(within(bar()).getByRole("button", { name: "Back to current" }));
    expect(data.goToCurrentCycle).toHaveBeenCalledTimes(1);
  });

  it("shows the same spend figure as the header (no recalculation) and leaves the header untouched", () => {
    renderPage();
    titleVisible(0);
    expect(within(bar()).getByText("My spend")).toBeTruthy();
    expect(within(bar()).getByText(formatCurrency(MY_SPENT))).toBeTruthy();
    const summary = within(screen.getByRole("region", { name: "Cycle summary" }));
    expect(summary.getByText(formatCurrency(MY_SPENT))).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "Month Cycle" })).toBeTruthy();
  });

  it("the ⋯ menu carries the cycle status and the About this cycle text", async () => {
    renderPage();
    titleVisible(0);
    fireEvent.keyDown(within(bar()).getByRole("button", { name: "Cycle details" }), { key: "Enter" });
    expect(await screen.findByText("About this cycle")).toBeTruthy();
    expect(screen.getByText(/Cycle totals cover the 18th of each month through the 17th of the next/)).toBeTruthy();
    expect(screen.getAllByText("16 days left").length).toBeGreaterThan(0);
  });

  it("keeps SectionNav as its own sticky row beneath the bar, with all six actions", () => {
    renderPage();
    titleVisible(0);
    const nav = screen.getByRole("navigation", { name: "Month cycle sections" });
    expect(nav.className).toContain("sticky");
    expect(nav.style.top).toBe("64px");
    for (const name of ["Overview", "Obligations", "Due", "People & accounts", "At a glance", "Budget"]) {
      expect(within(nav).getByRole("button", { name })).toBeTruthy();
    }
    expect(nav.closest("[data-compact-bar]")).toBeNull();
  });

  it("section anchors leave room for the bar and SectionNav", () => {
    renderPage();
    for (const id of ["mc-overview", "mc-obligations", "mc-due", "mc-people", "mc-glance", "mc-budget"]) {
      const el = document.getElementById(id)!;
      expect((el.className + (el.firstElementChild?.className ?? "")).includes("scroll-mt-28")).toBe(true);
    }
  });
});

describe("Month Cycle compact bar — focus and anchors", () => {
  it("does not hide from under a focused control when the title comes back", () => {
    renderPage();
    titleVisible(0);
    const next = within(bar()).getByRole("button", { name: "Next cycle" });
    act(() => next.focus());
    titleVisible(1);
    expect(barEl().hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(next);
  });

  it("stays shown while its picker popover is open, then hides once it closes", async () => {
    renderPage();
    titleVisible(0);
    const trigger = within(bar()).getByRole("button", { name: "Choose cycle" });
    fireEvent.click(trigger);
    await waitFor(() => expect(trigger.getAttribute("aria-expanded")).toBe("true"));
    titleVisible(1);
    await waitFor(() => expect(barEl().hasAttribute("inert")).toBe(false));

    fireEvent.click(screen.getByRole("button", { name: "Current cycle" }));
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    await waitFor(() => expect(barEl().hasAttribute("inert")).toBe(true));
  });
});

describe("Month Cycle compact bar — spacing contract", () => {
  it("derives sticky offsets from the scroll area's measured padding instead of assuming it", () => {
    render(<main style={{ paddingTop: "24px" }}><TooltipProvider><MonthCycleWorkspace /></TooltipProvider></main>);
    const slot = barEl().parentElement!;
    expect(slot.style.top).toBe("-16px"); // 8px inset − 24px padding
    expect(screen.getByRole("navigation", { name: "Month cycle sections" }).style.top).toBe("40px"); // 64px stack − 24px padding
  });

  it("with no padding the bar sits 8px in and SectionNav 64px down", () => {
    renderPage();
    expect(barEl().parentElement!.style.top).toBe("8px");
    expect(screen.getByRole("navigation", { name: "Month cycle sections" }).style.top).toBe("64px");
  });

  it("the slot takes no space: h-0, sticky, pointer-events none", () => {
    renderPage();
    const slot = barEl().parentElement!;
    expect(slot.className).toContain("h-0");
    expect(slot.className).toContain("sticky");
    expect(slot.className).toContain("pointer-events-none");
  });

  it("slides in (translate only, no opacity ghosting) while the title leaves", () => {
    renderPage();
    titleVisible(0.5);
    expect(barEl().style.transform).toContain("translateY(");
    expect(barEl().style.opacity).toBe("");
  });
});

describe("Month Cycle compact bar — reduced motion", () => {
  it("appears with no slide or gradual fade", () => {
    motionPrefs.reduce = true;
    renderPage();
    titleVisible(0.7);
    expect(barEl().style.visibility).toBe("hidden");
    expect(barEl().style.transition).toBe("");
    titleVisible(0);
    expect(barEl().style.visibility).toBe("visible");
    expect(barEl().style.transform).toBe("");
    expect(barEl().hasAttribute("inert")).toBe(false);
  });
});
