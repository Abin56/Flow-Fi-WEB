// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { formatCurrency } from "@/lib/format";

/**
 * Month Cycle hero view lock: "My spend" is the DEFAULT; toggling to "Total outflow" never alters the My Spend
 * figure; the Total outflow drill-down shows the exact components of its headline. The money itself is
 * proven in `lib/engines/month-cycle-my-spend.test.ts`.
 */

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));
vi.mock("@/features/people/components/purpose-money-signals", () => ({ MonthCyclePurposePanel: () => null, MoneyToUseSignal: () => null }));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock("@/components/foundation/animated-number", () => ({
  AnimatedNumber: ({ value, format }: { value: number; format: (v: number) => string }) => <span>{format(value)}</span>,
}));

const MY_SPENT = 4200;
const SPENT = 9700;
const BREAKDOWN = { "My Expenses": 4200, "Shared Expenses": 3500, Bills: 1200, EMIs: 800 };

const group = { count: 0, total: 0, items: [] };
const data = {
  isLoading: false,
  financialView: { spent: SPENT, spentBreakdown: BREAKDOWN, mySpent: MY_SPENT, net: 0, myNet: 0, income: 0, spentChangePercent: null, mySpentChangePercent: null },
  spendingFromAccounts: { loanPayments: { amount: 0, rows: [] }, expenses: { amount: 0, rows: [] } },
  expenseRows: [{ id: "t1", description: "Dinner", category: "Food", categoryIconKey: "food", account: "SBI", accountType: "bank", date: new Date(2026, 8, 20), fullAmount: 3000, myAmount: 1000, isSplit: true }],
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
  isFollowingGlobalCycle: true,
  followGlobalCycle: vi.fn(),
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
// Account list only feeds the bank logos on the account-outflow rows.
vi.mock("@/hooks/use-accounts", () => ({ useAccounts: () => ({ data: [] }) }));

const { MonthCycleWorkspace } = await import("./month-cycle-workspace");
afterEach(cleanup);

const summary = () => within(screen.getByRole("region", { name: "Cycle summary" }));

describe("Month Cycle — My spend is the default and never moves", () => {
  it("opens on My spend; Total outflow → back restores the same My Spend", () => {
    render(<TooltipProvider><MonthCycleWorkspace /></TooltipProvider>);
    expect(summary().getByText("My spend")).toBeTruthy();
    expect(summary().getByText(formatCurrency(MY_SPENT))).toBeTruthy();

    fireEvent.click(summary().getByRole("radio", { name: "Combined" }));
    expect(summary().getByText("Total outflow")).toBeTruthy();
    expect(summary().getByText(formatCurrency(SPENT))).toBeTruthy();
    expect(data.financialView.mySpent).toBe(MY_SPENT);

    fireEvent.click(summary().getByRole("radio", { name: "Mine only" }));
    expect(summary().getByText("My spend")).toBeTruthy();
    expect(summary().getByText(formatCurrency(MY_SPENT))).toBeTruthy();
  });

  it("My spend drill-down shows no outflow breakdown; Total outflow drill-down lines add back to its headline", () => {
    render(<TooltipProvider><MonthCycleWorkspace /></TooltipProvider>);
    fireEvent.click(summary().getByRole("button", { name: /View list/ }));
    expect(screen.queryByRole("region", { name: "Total outflow breakdown" })).toBeNull();

    fireEvent.click(within(screen.getByRole("dialog")).getByRole("radio", { name: "Combined" }));
    const breakdown = within(screen.getByRole("region", { name: "Total outflow breakdown" }));
    for (const [label, amount] of Object.entries(BREAKDOWN)) {
      expect(breakdown.getByText(label)).toBeTruthy();
      expect(breakdown.getAllByText(formatCurrency(amount)).length).toBeGreaterThan(0);
    }
    expect(breakdown.getByTestId("outflow-breakdown-total").textContent).toBe(formatCurrency(SPENT));
    expect(Object.values(BREAKDOWN).reduce((a, b) => a + b, 0)).toBe(SPENT);
  });
});

describe("Month Cycle — cycle picker", () => {
  it("prev/next call the stepping actions; picking a month jumps to that month's cycle", () => {
    render(<TooltipProvider><MonthCycleWorkspace /></TooltipProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Previous cycle" }));
    fireEvent.click(screen.getByRole("button", { name: "Next cycle" }));
    expect(data.goToPreviousCycle).toHaveBeenCalledTimes(1);
    expect(data.goToNextCycle).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Choose cycle" }));
    expect(screen.getByRole("button", { name: "Oct", pressed: true })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next year" }));
    fireEvent.click(screen.getByRole("button", { name: "Jan" }));
    expect(data.goToCycleForMonth).toHaveBeenCalledWith(2027, 0);
  });
});

describe("Month Cycle — lower sections (UI only)", () => {
  const person = (id: string, name: string, amount: number) => ({ id, name, note: "", amount, toGive: 0, toReceive: amount, net: amount, daysSince: 3 });
  const snapshot = { ...data };
  afterEach(() => Object.assign(data, snapshot));

  it("People ledger: each side's header holds its total once; +N more past the list cap; advance shown only when held", () => {
    Object.assign(data, {
      peopleSides: { giveCount: 0, receiveCount: 8, totalToGive: 0, totalToReceive: 5000, advanceHeld: 700 },
      peopleHandoverPending: [person("a", "Asha", 2000), person("b", "Ravi", 3000)],
    });
    render(<TooltipProvider><MonthCycleWorkspace /></TooltipProvider>);
    const ledger = within(screen.getByRole("region", { name: "People ledger" }));
    // One figure per side — the old tile row repeating it is gone.
    expect(ledger.getAllByText(formatCurrency(5000))).toHaveLength(1);
    expect(ledger.getByText("8 people")).toBeTruthy();
    expect(ledger.getByText("+6 more people")).toBeTruthy();
    expect(ledger.getByText("Nothing to give right now.")).toBeTruthy();
    expect(ledger.getByText(formatCurrency(700))).toBeTruthy();
  });

  it("People ledger: no advance line when none is held", () => {
    render(<TooltipProvider><MonthCycleWorkspace /></TooltipProvider>);
    expect(within(screen.getByRole("region", { name: "People ledger" })).queryByText(/Advance held/)).toBeNull();
  });

  it("Budget: with no budget the panel is one prompt row; set → percent used, and over-budget shows the overshoot", () => {
    render(<TooltipProvider><MonthCycleWorkspace /></TooltipProvider>);
    const empty = within(screen.getByRole("region", { name: "Budget overview" }));
    expect(empty.getByText("No monthly budget set")).toBeTruthy();
    expect(empty.getByRole("link", { name: /Set a budget/ })).toBeTruthy();
    cleanup();

    Object.assign(data, { budgetOverview: { limit: 10000, spent: 12500, remaining: -2500, usageRatio: 1.25, isOverBudget: true } });
    render(<TooltipProvider><MonthCycleWorkspace /></TooltipProvider>);
    const over = within(screen.getByRole("region", { name: "Budget overview" }));
    expect(over.getByText("125%")).toBeTruthy();
    expect(over.getByText("Over by")).toBeTruthy();
    expect(over.getByText(formatCurrency(2500))).toBeTruthy();
    expect(over.getByRole("link", { name: /Manage budget/ })).toBeTruthy();
  });
});
