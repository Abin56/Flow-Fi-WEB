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
