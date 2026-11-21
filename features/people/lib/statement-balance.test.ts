import { describe, expect, it } from "vitest";
import type { LedgerRow, PaymentRecord } from "@/features/people/lib/person-ledger-rows";
import { buildStatementBalances, paymentLinesOf } from "@/features/people/lib/statement-balance";

const d = (day: number, month = 10) => new Date(2026, month - 1, day);

function pay(key: string, day: number, amount: number, direction: PaymentRecord["direction"] = "theyPaid"): PaymentRecord {
  return { key, entryId: key, date: d(day), amount, direction, source: "cash", paymentId: null, remainingAfter: 0, undo: null, undoBlock: null };
}

function obligation(key: string, day: number, amount: number, direction: "theyOwe" | "iOwe", payments: PaymentRecord[] = []): LedgerRow {
  return {
    key,
    entryId: key,
    date: d(day),
    createdAt: d(day),
    title: key,
    typeLabel: "Money given",
    category: "gave",
    amount,
    direction,
    state: "open",
    remaining: amount,
    paid: 0,
    paymentId: null,
    advanceRemaining: null,
    statementRow: { kind: "obligation", category: "gave" } as LedgerRow["statementRow"],
    settle: null,
    deletable: true,
    deleteBlock: null,
    payments,
    loanId: null,
    overdue: false,
  };
}

function generalPayment(key: string, day: number, amount: number, direction: "theyPaid" | "youPaid"): LedgerRow {
  return { ...obligation(key, day, amount, "theyOwe"), direction, category: "received" as LedgerRow["category"], state: null, remaining: null, paid: null, statementRow: { kind: "settlement", category: "received" } as LedgerRow["statementRow"] };
}

describe("statement running balance", () => {
  it("₹10,000 repaid in several parts → 9,500 · 8,500 · 8,400 · 3,400 · 0", () => {
    const row = obligation("debt", 1, 10000, "theyOwe", [pay("p1", 2, 500), pay("p2", 3, 1000), pay("p3", 4, 100), pay("p4", 5, 5000), pay("p5", 6, 3400)]);
    const b = buildStatementBalances([row]);
    expect(["debt", "p1", "p2", "p3", "p4", "p5"].map((k) => b.get(k)?.amount)).toEqual([10000, 9500, 8500, 8400, 3400, 0]);
    expect(b.get("p5")?.side).toBe("receivable");
  });

  it("keeps the two directions apart — they never net", () => {
    const b = buildStatementBalances([obligation("a", 1, 10000, "theyOwe"), obligation("b", 2, 2000, "iOwe", [pay("pb", 3, 500, "youPaid")])]);
    expect(b.get("a")).toEqual({ side: "receivable", amount: 10000 });
    expect(b.get("b")).toEqual({ side: "payable", amount: 2000 });
    expect(b.get("pb")).toEqual({ side: "payable", amount: 1500 });
  });

  it("a general payment (no item chosen) lowers the overall balance once; same-day lines chain in display order", () => {
    const rows = [obligation("o1", 1, 1000, "theyOwe"), obligation("o2", 1, 5000, "theyOwe"), generalPayment("g1", 20, 500, "theyPaid"), generalPayment("g2", 20, 5000, "theyPaid")];
    const b = buildStatementBalances(rows);
    expect(b.get("o2")?.amount).toBeGreaterThan(0);
    const closing = Math.min(b.get("g1")!.amount, b.get("g2")!.amount);
    expect(closing).toBe(500); // 6,000 owed − 5,500 received
  });

  it("a payment listed as its own row is not counted twice", () => {
    const p = pay("p1", 2, 400);
    const rows = [obligation("debt", 1, 1000, "theyOwe", [p]), { ...generalPayment("p1", 2, 400, "theyPaid") }];
    expect(paymentLinesOf(rows)).toHaveLength(0);
    expect(buildStatementBalances(rows).get("p1")?.amount).toBe(600);
  });

  it("losing a payment (revert) simply recomputes — the balance goes back up", () => {
    const withPay = buildStatementBalances([obligation("debt", 1, 1000, "theyOwe", [pay("p1", 2, 400)])]);
    const reverted = buildStatementBalances([obligation("debt", 1, 1000, "theyOwe", [])]);
    expect(withPay.get("p1")?.amount).toBe(600);
    expect(reverted.get("debt")?.amount).toBe(1000);
  });
});
