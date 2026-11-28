// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { NetWorthHero } from "@/features/dashboard/components/net-worth-hero";

const nw = { amount: 16_000, changeAmount: 0, changePercent: 0, trend: [], assets: 68_000, debt: 52_000, assignedReceivable: 35_000, emiDueReceivable: 5_000, assignedDebt: 50_000, myDebt: 2_000 };

afterEach(cleanup);

describe("Net Worth card breakdown", () => {
  it("shows a flat seven-day trend and keeps a small negative balance visible", () => {
    const amount = -0.25;
    render(<NetWorthHero netWorth={{ ...nw, assets: 68_000, debt: 68_000.25, amount, trend: Array.from({ length: 7 }, () => amount) }} />);
    expect(screen.getByText("Last 7 days")).toBeTruthy();
    const chart = screen.getByRole("img", { name: /net worth -₹0\.25/ });
    expect(within(chart).getByText("Shortfall")).toBeTruthy();
    expect(within(chart).getByText("−₹0.25")).toBeTruthy();
  });

  it("holds the headline and trend until ready and shows the full amount immediately", () => {
    const { rerender } = render(<NetWorthHero netWorth={{ ...nw, trend: [15_000, 16_000] }} isLoading />);
    const card = screen.getByRole("region", { name: "Net worth" });
    expect(card.getAttribute("aria-busy")).toBe("true");
    expect(within(card).queryByText("₹16,000")).toBeNull();
    expect(within(card).queryByText("Last 7 days")).toBeNull();

    rerender(<NetWorthHero netWorth={nw} />);
    expect(within(card).getAllByText("₹16,000")).toHaveLength(2);
    expect(within(card).queryByText("₹0")).toBeNull();
  });

  it("shows own / owe / net worth in the chart and explains the EMI receivable and assigned debt without altering any figure", () => {
    render(<NetWorthHero netWorth={nw} />);
    const chart = screen.getByRole("img", { name: /You own ₹68,000, owe ₹52,000, net worth ₹16,000/ });
    expect(within(chart).getByText("₹68,000")).toBeTruthy();
    expect(within(chart).getByText("−₹52,000")).toBeTruthy();
    expect(within(chart).getByText("₹16,000")).toBeTruthy();
    const emi = screen.getByTestId("nw-emi-receivable").textContent ?? "";
    expect(emi).toContain("₹40,000"); // 35,000 coming up + 5,000 due now
    expect(emi).toContain("₹5,000 due now");
    expect(emi).toContain("₹35,000 coming up");
    expect(screen.getByTestId("nw-assigned-debt").textContent).toContain("not received yet");
    expect(screen.getByTestId("nw-assigned-debt").textContent).toContain("₹2,000");
  });

  it("counts split-expense / lent receivables (ABIN 3,000 + DAD 2,000) under From others, not Mine — totals unchanged", () => {
    const split = { amount: 105_000, changeAmount: 0, changePercent: 0, trend: [], assets: 105_000, debt: 0, peopleReceivable: 5_000, assignedReceivable: 0, emiDueReceivable: 0 };
    render(<NetWorthHero netWorth={split} />);
    const chart = screen.getByRole("img", { name: /You own ₹1,05,000/ });
    expect(within(chart).getByText("₹5,000")).toBeTruthy(); // From others
    expect(within(chart).getByText("₹1,00,000")).toBeTruthy(); // Mine = assets − 5,000
  });

  it("does not double count a due EMI share that is already inside peopleReceivable", () => {
    render(<NetWorthHero netWorth={{ ...nw, peopleReceivable: 5_000 }} />);
    expect(screen.getByTestId("nw-emi-receivable").textContent).toContain("₹40,000");
    const chart = screen.getByRole("img", { name: /You own ₹68,000/ });
    expect(within(chart).getByText("₹28,000")).toBeTruthy(); // Mine = 68,000 − 40,000
  });

  it("hides every amount when hidden and omits the notes when nothing is assigned", () => {
    const { rerender } = render(<NetWorthHero netWorth={nw} hideAmount />);
    expect(screen.queryByText("₹68,000")).toBeNull();
    expect(screen.queryByTestId("nw-emi-receivable")).toBeNull();
    rerender(<NetWorthHero netWorth={{ ...nw, assignedReceivable: 0, emiDueReceivable: 0, assignedDebt: 0, myDebt: 52_000 }} />);
    expect(screen.queryByTestId("nw-emi-receivable")).toBeNull();
    expect(screen.queryByTestId("nw-assigned-debt")).toBeNull();
  });
});
