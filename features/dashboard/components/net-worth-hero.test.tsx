// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { NetWorthHero } from "@/features/dashboard/components/net-worth-hero";

const nw = { amount: 16_000, changeAmount: 0, changePercent: 0, trend: [], assets: 68_000, debt: 52_000, assignedReceivable: 35_000, emiDueReceivable: 5_000, assignedDebt: 50_000, myDebt: 2_000 };

afterEach(cleanup);

describe("Net Worth card breakdown", () => {
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

  it("hides every amount when hidden and omits the notes when nothing is assigned", () => {
    const { rerender } = render(<NetWorthHero netWorth={nw} hideAmount />);
    expect(screen.queryByText("₹68,000")).toBeNull();
    expect(screen.queryByTestId("nw-emi-receivable")).toBeNull();
    rerender(<NetWorthHero netWorth={{ ...nw, assignedReceivable: 0, emiDueReceivable: 0, assignedDebt: 0, myDebt: 52_000 }} />);
    expect(screen.queryByTestId("nw-emi-receivable")).toBeNull();
    expect(screen.queryByTestId("nw-assigned-debt")).toBeNull();
  });
});
