import { describe, expect, it } from "vitest";
import { cashFlowThisMonth } from "@/lib/engines/cash-flow";
import { cashFlowTransactions, weeklyCashFlowTotals } from "@/lib/engines/cycle-transaction-mapping";
import type { Transaction } from "@/lib/models/transaction";
import { TransactionRepository } from "@/lib/repositories/transaction-repository";

const NOW = new Date(2026, 9, 15, 12);
const BANK = "bank";
const CARD = "card";
const cardIds = new Set([CARD]);
const tx = (p: Partial<Parameters<typeof TransactionRepository.buildTransaction>[0]> & { id: string }): Transaction => ({
  ...TransactionRepository.buildTransaction({ type: "expense", amount: 0, dateTime: NOW, accountId: BANK, categoryId: "c", ...p }),
  id: p.id,
});
const day = (d: number) => new Date(2026, 9, d, 12);
const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
const headline = (txns: Transaction[]) =>
  cashFlowThisMonth({ transactions: cashFlowTransactions(txns, cardIds), emiPaidThisMonth: 0, loanPaidThisMonth: 0, billsPaidThisMonth: 0, moneyReceivedThisMonth: 0, now: NOW });

describe("weeklyCashFlowTotals — bars sum to the headline Money In − Money Out", () => {
  const rows = () => [
    tx({ id: "salary", type: "income", amount: 5_000, dateTime: day(2) }),
    tx({ id: "food", amount: 300, dateTime: day(9) }),
    tx({ id: "rent", amount: 1_200, dateTime: day(20) }),
  ];

  it("plain rows: bars land in the right weeks and total exactly the headline net", () => {
    const bars = weeklyCashFlowTotals(rows(), cardIds, NOW, "net");
    expect(Object.fromEntries(bars)).toEqual({ "1-7": 5_000, "8-14": -300, "15-21": -1_200 });
    expect(sum(bars)).toBe(headline(rows()).net);
  });

  it("REGRESSION: a row flagged 'don't count' (never moved an account) is in NEITHER the headline nor a bar", () => {
    const withExcluded = [...rows(), tx({ id: "earlier", amount: 700, dateTime: day(10), excludeFromCalculations: true })];
    expect(headline(withExcluded).moneyOut).toBe(1_500); // the headline already ignored it
    const bars = weeklyCashFlowTotals(withExcluded, cardIds, NOW, "net");
    expect(bars.get("8-14")).toBe(-300); // used to be −1,000 (the excluded 700 leaked into the bar)
    expect(sum(bars)).toBe(headline(withExcluded).net);
    expect(weeklyCashFlowTotals(withExcluded, cardIds, NOW, "expenses").get("8-14")).toBe(300);
  });

  it("trashed rows, other months, transfers, loan principal, People cash and card-account purchases never appear", () => {
    const noise = [
      ...rows(),
      { ...tx({ id: "gone", amount: 999, dateTime: day(3) }), deletedAt: new Date() },
      tx({ id: "lastMonth", amount: 999, dateTime: new Date(2026, 8, 20, 12) }),
      tx({ id: "xfer-out", amount: 999, dateTime: day(4), transferId: "t1" }),
      tx({ id: "xfer-in", type: "income", amount: 999, dateTime: day(4), transferId: "t1", accountId: "bank2" }),
      tx({ id: "people", type: "income", amount: 999, dateTime: day(5), isPersonLedgerMovement: true }),
      tx({ id: "cardBuy", amount: 999, dateTime: day(6), accountId: CARD }),
    ];
    expect(sum(weeklyCashFlowTotals(noise, cardIds, NOW, "net"))).toBe(headline(noise).net);
    expect(sum(weeklyCashFlowTotals(noise, cardIds, NOW, "net"))).toBe(5_000 - 300 - 1_200);
  });

  it("a card BILL payment (bank → card transfer) counts once, as cash out of the bank — in the bars and in the headline", () => {
    const bill = [
      tx({ id: "pay-out", amount: 2_000, dateTime: day(12), transferId: "bill1", accountId: BANK }),
      tx({ id: "pay-in", type: "income", amount: 2_000, dateTime: day(12), transferId: "bill1", accountId: CARD }),
    ];
    expect(sum(weeklyCashFlowTotals(bill, cardIds, NOW, "net"))).toBe(-2_000);
    expect(headline(bill).net).toBe(-2_000);
  });
});
