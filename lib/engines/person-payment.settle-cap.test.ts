import { describe, expect, it } from "vitest";
import { allocatePayment, reconcilePayment, settleCapLines, type PaymentObligation } from "./person-payment";

/** "Use only ₹X to settle" — built on allocatePayment's own oldest-first order, never a new rule. */

const ob = (key: string, title: string, outstanding: number, day: number, amount = outstanding): PaymentObligation => ({
  key,
  title,
  date: new Date(2026, 8, day),
  createdAt: new Date(2026, 8, day),
  amount,
  outstanding,
  side: "theyOwe",
});
const AMMA = [ob("ledger:share", "Expense share", 2400, 20), ob("ledger:exam", "Exam", 1000, 18), ob("ledger:loan", "Loan installment", 2000, 19)];
const keys = AMMA.map((o) => o.key);

function record(amount: number, settle: number, obligations = AMMA) {
  const cap = settleCapLines({ obligations, selectedKeys: obligations.map((o) => o.key), amount, settle });
  const allocation = allocatePayment({ obligations, selectedKeys: obligations.map((o) => o.key), amount, manual: cap.manual });
  return { cap, allocation };
}

describe("settleCapLines", () => {
  it("₹29,800 received, ₹4,000 applied: oldest first, ₹1,400 owed, ₹25,800 left to classify", () => {
    const { cap, allocation } = record(29800, 4000);
    expect(cap.error).toBeNull();
    expect(cap.manual).toEqual({ "ledger:exam": 1000, "ledger:loan": 2000, "ledger:share": 1000 });
    expect(allocation.allocated).toBe(4000);
    expect(allocation.unpaid).toBe(1400);
    expect(allocation.extra).toBe(25800);
    // The share is partial on the SAME obligation: 2,400 → 1,400 remaining; no second obligation.
    expect(allocation.lines.find((l) => l.key === "ledger:share")).toEqual({ key: "ledger:share", amount: 1000, outstanding: 2400, remainingAfter: 1400 });
    // Keep the rest as advance: every rupee in exactly one bucket.
    expect(reconcilePayment({ received: 29800, allocated: allocation.allocated, advance: allocation.extra }).balanced).toBe(true);
  });

  it("matches the automatic allocation when the cap equals what the payment would settle anyway", () => {
    const auto = allocatePayment({ obligations: AMMA, selectedKeys: keys, amount: 4000 });
    expect(record(29800, 4000).allocation.lines).toEqual(auto.lines);
  });

  it("₹0 settles nothing: the whole receipt is extra", () => {
    const { cap, allocation } = record(29800, 0);
    expect(cap.manual).toEqual({});
    expect(allocation.lines).toEqual([]);
    expect(allocation.extra).toBe(29800);
    expect(allocation.unpaid).toBe(5400);
  });

  it("never silently caps: negative, above payment, above due, empty are errors", () => {
    expect(settleCapLines({ obligations: AMMA, selectedKeys: keys, amount: 29800, settle: -1 }).error).toMatch(/negative/);
    expect(settleCapLines({ obligations: AMMA, selectedKeys: keys, amount: 3000, settle: 4000 }).error).toMatch(/Only 3000\.00 was received/);
    expect(settleCapLines({ obligations: AMMA, selectedKeys: keys, amount: 29800, settle: 6000 }).error).toMatch(/Only 5400\.00 is due/);
    expect(settleCapLines({ obligations: AMMA, selectedKeys: keys, amount: 29800, settle: NaN }).error).toMatch(/Enter how much/);
  });

  it("edit 4,000 → 3,000 reopens ₹1,000; 4,000 → 5,000 settles ₹1,000 more, in the same order", () => {
    // Editing re-opens this payment's own lines (the panel adds them back to `outstanding`), then re-caps.
    const less = record(29800, 3000).allocation;
    expect(less.unpaid).toBe(2400);
    expect(less.lines.map((l) => [l.key, l.amount])).toEqual([
      ["ledger:exam", 1000],
      ["ledger:loan", 2000],
    ]);
    const more = record(29800, 5000).allocation;
    expect(more.unpaid).toBe(400);
    expect(more.lines.find((l) => l.key === "ledger:share")?.amount).toBe(2000);
  });

  it("full settlement leaves nothing owed", () => {
    const { allocation } = record(29800, 5400);
    expect(allocation.unpaid).toBe(0);
    expect(allocation.extra).toBe(24400);
  });
});
