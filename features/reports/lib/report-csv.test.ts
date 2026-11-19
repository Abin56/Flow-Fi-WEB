import { describe, expect, it } from "vitest";
import type { PeriodDetail } from "@/lib/engines/period-report";
import { resolveReportPeriod } from "@/lib/engines/report-period";
import { periodReportCsv } from "./report-csv";

const period = resolveReportPeriod({ kind: "month", year: 2026, month: 9 }, 1, new Date(2026, 10, 19));

const detail = {
  period,
  income: 50_000,
  outflow: 25_700.5,
  outflowBreakdown: { "My Expenses": 23_200.5, EMIs: 2_500 },
  net: 24_299.5,
  savingsRate: 48.6,
  mySpend: 20_000,
  totalPurchase: 22_000,
  othersShare: 2_000,
  spendByCategory: new Map([
    ["food", { amount: 5_000, count: 3 }],
    ["rent", { amount: 15_000, count: 1 }],
  ]),
  cash: { moneyIn: 50_500, moneyOut: 24_700, net: 25_800, income: 50_000, expenses: 19_200, creditCardPayments: 3_000 },
  debt: { emiPaid: 2_500, loanRepaid: 1_200, loanCollected: 0, cardBillPayments: 3_000 },
  people: { receivedFromPeople: 700, paidToPeople: 1_500 },
  accounts: [{ accountId: "bank", opening: 9_400, closing: 51_900, moneyIn: 70_700, moneyOut: 28_200, transfersIn: 0, transfersOut: 5_000, count: 9 }],
  cards: [],
  spendRows: [
    {
      transaction: { id: "t1", description: 'Dinner, "the big one"', categoryId: "food", accountId: "bank", dateTime: new Date(2026, 9, 6, 12) },
      grossAmount: 3_000,
      myAmount: 1_000,
      othersAmount: 2_000,
    },
  ],
  daily: new Map(),
} as unknown as PeriodDetail;

describe("periodReportCsv", () => {
  const csv = periodReportCsv({ detail, accountName: (id) => (id === "bank" ? "HDFC Savings" : id), categoryName: (id) => (id === "food" ? "Food" : "Rent") });
  const lines = csv.split("\n");

  it("copies the engine's figures verbatim, with the basis of each", () => {
    expect(lines).toContain("Income,50000,Month Cycle");
    expect(lines).toContain("Total outflow,25700.50,Month Cycle");
    expect(lines).toContain("My spend,20000,My share only");
    expect(lines).toContain("Cash money out,24700,Cash basis");
  });

  it("lists categories largest first and accounts with opening / closing", () => {
    const rent = lines.indexOf("Rent,15000,1");
    const food = lines.indexOf("Food,5000,3");
    expect(rent).toBeGreaterThan(-1);
    expect(food).toBeGreaterThan(rent);
    expect(lines).toContain("HDFC Savings,9400,70700,28200,51900,0,5000");
  });

  it("escapes commas and quotes in descriptions", () => {
    expect(lines).toContain('2026-10-06,"Dinner, ""the big one""",Food,HDFC Savings,3000,1000');
  });
});
