import { describe, expect, it } from "vitest";
import {
  buildMySpendContext,
  classifyForMySpend,
  myConsumptionAmount,
  mySpendRows,
  repaymentRecognitionByAgreement,
  summarizeMySpend,
  type MySpendContext,
  type MySpendExpense,
  type MySpendTransaction,
} from "@/lib/engines/my-spend";
import { cashFlowThisMonth } from "@/lib/engines/cash-flow";
import { myExpenses } from "@/lib/engines/dashboard-aggregation";
import { isNonIncomeExpenseMovement } from "@/lib/models/transaction";

/**
 * The one authoritative "My Spend" contract. Every amount below is the answer to
 * "how much did I actually spend for MYSELF?" — independent of how it was funded.
 */

type Tx = MySpendTransaction & { dateTime: Date };
const d = (m: number, day: number, h = 12) => new Date(2026, m - 1, day, h);
let seq = 0;
function tx(p: Partial<Tx> & { amount: number }): Tx {
  seq += 1;
  return {
    id: p.id ?? `t${seq}`,
    type: "expense",
    categoryId: "food",
    accountId: "sbi",
    transferId: null,
    loanId: null,
    emiId: null,
    paymentAllocationType: null,
    isPersonLedgerMovement: false,
    excludeFromCalculations: false,
    deletedAt: null,
    dateTime: d(9, 20),
    ...p,
  };
}
const exp = (transactionId: string, totalAmount: number, myShare: number, deletedAt: Date | null = null): MySpendExpense => ({ transactionId, totalAmount, myShare, deletedAt });
const ctxOf = (expenses: MySpendExpense[] = [], agreements?: Map<string, boolean>): MySpendContext =>
  buildMySpendContext({ expenses, repaymentIsConsumptionByAgreementId: agreements });

/** User-configured cycle 18 Sep → 17 Oct (inclusive, end at 23:59:59.999). */
const CYCLE = { start: new Date(2026, 8, 18), end: new Date(2026, 9, 17, 23, 59, 59, 999) };
const byDate = (t: Tx) => t.dateTime;
const spend = (txns: Tx[], ctx: MySpendContext, range = CYCLE) => summarizeMySpend(mySpendRows({ transactions: txns, ctx, bucketDate: byDate, range })).mySpend;

describe("My Spend — funding never decides spend", () => {
  it("1. normal ₹1,000 bank expense → ₹1,000", () => {
    expect(spend([tx({ amount: 1000 })], ctxOf())).toBe(1000);
  });

  it("2–3. ₹1,000 card purchase → ₹1,000; paying the card bill keeps it ₹1,000", () => {
    const purchase = tx({ amount: 1000, accountId: "octane" });
    const billOut = tx({ amount: 1000, accountId: "sbi", transferId: "x1" });
    const billIn = tx({ amount: 1000, accountId: "octane", transferId: "x1", type: "income" });
    expect(spend([purchase], ctxOf())).toBe(1000);
    expect(spend([purchase, billOut, billIn], ctxOf())).toBe(1000);
    expect(classifyForMySpend(billOut, ctxOf()).kind).toBe("transfer");
  });

  it("4–6. borrow ₹5,000 from AMMA → ₹0; spend ₹2,000 → ₹2,000; repay → still ₹2,000", () => {
    const borrowed = tx({ amount: 5000, type: "income", isPersonLedgerMovement: true, categoryId: "people" });
    const spent = tx({ amount: 2000 });
    const repaid = tx({ amount: 2000, isPersonLedgerMovement: true, categoryId: "people" });
    expect(spend([borrowed], ctxOf())).toBe(0);
    expect(spend([borrowed, spent], ctxOf())).toBe(2000);
    expect(spend([borrowed, spent, repaid], ctxOf())).toBe(2000);
    expect(classifyForMySpend(repaid, ctxOf()).kind).toBe("personLedgerMovement");
  });

  it("7. ₹3,000 split 1k/1k/1k on my card → My Spend ₹1,000, Total Purchase ₹3,000", () => {
    const t = tx({ id: "rest", amount: 3000, accountId: "octane" });
    const rows = mySpendRows({ transactions: [t], ctx: ctxOf([exp("rest", 3000, 1000)]), bucketDate: byDate, range: CYCLE });
    expect(summarizeMySpend(rows)).toMatchObject({ mySpend: 1000, totalPurchase: 3000, othersShare: 2000 });
  });

  it("8. fully assigned to AMMA → ₹0 (cash moved ₹1,000)", () => {
    const t = tx({ id: "a", amount: 1000 });
    const c = classifyForMySpend(t, ctxOf([exp("a", 1000, 0)]));
    expect(c).toEqual({ kind: "consumption", grossAmount: 1000, myAmount: 0, othersAmount: 1000 });
  });

  it("9. partially assigned ₹2,000 (mine ₹800) → ₹800", () => {
    expect(spend([tx({ id: "p", amount: 2000 })], ctxOf([exp("p", 2000, 800)]))).toBe(800);
  });

  it("10. person reimburses ₹1,200 → historical My Spend unchanged, never negative", () => {
    const t = tx({ id: "p", amount: 2000 });
    const reimbursed = tx({ amount: 1200, type: "income", isPersonLedgerMovement: true });
    expect(spend([t, reimbursed], ctxOf([exp("p", 2000, 800)]))).toBe(800);
  });

  it("11. loan origination ₹30,000 → ₹0; spending ₹10,000 of it → ₹10,000", () => {
    const disb = tx({ amount: 30000, type: "income", loanId: "L1", paymentAllocationType: "additionalDisbursement" });
    expect(spend([disb], ctxOf())).toBe(0);
    expect(spend([disb, tx({ amount: 10000 })], ctxOf())).toBe(10000);
    // A lent-loan principal sent out is a receivable, not spend.
    expect(classifyForMySpend(tx({ amount: 5000, loanId: "L2", paymentAllocationType: "additionalDisbursement" }), ctxOf()).kind).toBe("loanPrincipalDisbursement");
  });

  it("12. cash-loan principal repayment never re-counts the spending", () => {
    const agreements = repaymentRecognitionByAgreement({ loans: [{ id: "L1", agreementKind: "loan" }], emis: [], liveTransactionIds: new Set() });
    const txns = [
      tx({ amount: 30000, type: "income", loanId: "L1", paymentAllocationType: "additionalDisbursement" }),
      tx({ amount: 10000 }),
      tx({ amount: 3000, loanId: "L1", paymentAllocationType: "regularEmi" }),
      tx({ amount: 5000, loanId: "L1", paymentAllocationType: "principalPrepayment" }),
    ];
    expect(spend(txns, ctxOf([], agreements))).toBe(10000);
  });

  it("13. EMI purchase recorded + EMI repayments → counted once; unrecorded purchase → repayments are the record", () => {
    const purchase = tx({ id: "phone", amount: 12000, accountId: "octane" });
    const emiPay = (emiId: string) => tx({ amount: 1000, accountId: "octane", emiId, paymentAllocationType: "regularEmi" });
    const recorded = repaymentRecognitionByAgreement({ loans: [], emis: [{ id: "E1", purchaseTransactionId: "phone" }], liveTransactionIds: new Set(["phone"]) });
    expect(spend([purchase, emiPay("E1"), emiPay("E1")], ctxOf([], recorded))).toBe(12000);

    const unrecorded = repaymentRecognitionByAgreement({
      loans: [{ id: "IP", agreementKind: "installmentPurchase", purchaseTransactionId: null }],
      emis: [{ id: "E2", purchaseTransactionId: null }],
      liveTransactionIds: new Set(),
    });
    const ipPay = tx({ amount: 2500, loanId: "IP", paymentAllocationType: "regularEmi" });
    expect(spend([emiPay("E2"), ipPay], ctxOf([], unrecorded))).toBe(3500);
    // A deleted purchase no longer represents the consumption — repayments carry it again.
    const purchaseGone = repaymentRecognitionByAgreement({ loans: [], emis: [{ id: "E1", purchaseTransactionId: "phone" }], liveTransactionIds: new Set() });
    expect(purchaseGone.get("E1")).toBe(true);
    // Unknown agreement keeps the pre-existing behaviour (counted).
    expect(spend([emiPay("unknown")], ctxOf())).toBe(1000);
    // A down payment is an ordinary purchase.
    expect(spend([tx({ amount: 5000, loanId: "IP" })], ctxOf([], unrecorded))).toBe(5000);
  });

  it("14–15. account transfer and card-payment transfer → ₹0", () => {
    const out = tx({ amount: 7000, transferId: "x2" });
    const into = tx({ amount: 7000, transferId: "x2", type: "income", accountId: "hdfc" });
    expect(spend([out, into], ctxOf())).toBe(0);
  });

  it("16–17. lend to / borrow from a person → neither spend nor income", () => {
    const lent = tx({ amount: 1000, isPersonLedgerMovement: true });
    const borrowed = tx({ amount: 1000, type: "income", isPersonLedgerMovement: true });
    expect(spend([lent, borrowed], ctxOf())).toBe(0);
    expect(isNonIncomeExpenseMovement({ ...borrowed })).toBe(true);
  });

  it("excludeFromCalculations and deleted transactions never count", () => {
    expect(spend([tx({ amount: 900, excludeFromCalculations: true }), tx({ amount: 400, deletedAt: d(9, 21) })], ctxOf())).toBe(0);
  });
});

describe("My Spend — cycle boundaries (18 Sep → 17 Oct)", () => {
  it("18–21. before start / exact start / exact end / day after end", () => {
    const before = tx({ amount: 1, dateTime: new Date(2026, 8, 17, 23, 59, 59, 999) });
    const atStart = tx({ amount: 10, dateTime: new Date(2026, 8, 18, 0, 0, 0, 0) });
    const atEnd = tx({ amount: 100, dateTime: new Date(2026, 9, 17, 23, 59, 59, 999) });
    const after = tx({ amount: 1000, dateTime: new Date(2026, 9, 18, 0, 0, 0, 0) });
    expect(spend([before, atStart, atEnd, after], ctxOf())).toBe(110);
  });

  it("consumption stays in its own cycle when the card bill / reimbursement / loan is paid in the next", () => {
    const purchase = tx({ id: "dinner", amount: 3000, accountId: "octane", dateTime: d(10, 10) });
    const billNextCycle = tx({ amount: 3000, transferId: "x3", dateTime: d(10, 25) });
    const reimbursedNextCycle = tx({ amount: 2000, type: "income", isPersonLedgerMovement: true, dateTime: d(10, 26) });
    const ctx = ctxOf([exp("dinner", 3000, 1000)]);
    const all = [purchase, billNextCycle, reimbursedNextCycle];
    expect(spend(all, ctx)).toBe(1000);
    expect(spend(all, ctx, { start: new Date(2026, 9, 18), end: new Date(2026, 10, 17, 23, 59, 59, 999) })).toBe(0);
  });
});

describe("My Spend — edit / delete / reversal (pure: recomputed from current data, no stale state)", () => {
  it("22. edit amount", () => {
    const t = tx({ id: "e", amount: 1000 });
    expect(spend([t], ctxOf())).toBe(1000);
    expect(spend([{ ...t, amount: 1500 }], ctxOf())).toBe(1500);
  });

  it("23. edit split allocation / switch person allocation", () => {
    const t = tx({ id: "s", amount: 3000 });
    expect(spend([t], ctxOf([exp("s", 3000, 1000)]))).toBe(1000);
    expect(spend([t], ctxOf([exp("s", 3000, 2000)]))).toBe(2000);
    expect(spend([t], ctxOf([exp("s", 3000, 0)]))).toBe(0);
    // Split removed (deleted Expense record) → the plain transaction counts in full again.
    expect(spend([t], ctxOf([exp("s", 3000, 1000, d(9, 30))]))).toBe(3000);
  });

  it("24–25. delete, then restore", () => {
    const t = tx({ id: "r", amount: 800 });
    expect(spend([{ ...t, deletedAt: d(9, 25) }], ctxOf())).toBe(0);
    expect(spend([{ ...t, deletedAt: null }], ctxOf())).toBe(800);
  });

  it("moving the date out of the cycle or to another account/category is reflected", () => {
    const t = tx({ id: "m", amount: 500 });
    expect(spend([{ ...t, dateTime: d(10, 20) }], ctxOf())).toBe(0);
    const rows = mySpendRows({ transactions: [{ ...t, categoryId: "travel", accountId: "cash" }], ctx: ctxOf(), bucketDate: byDate, range: CYCLE });
    expect(summarizeMySpend(rows).byCategoryId.get("travel")).toBe(500);
  });
});

describe("My Spend — consistency & money integrity", () => {
  /** The realistic mixed cycle from the spec — expected My Spend ₹4,000. */
  const fixture = () => {
    const txns = [
      tx({ id: "groc", amount: 1000, categoryId: "groceries" }),
      tx({ id: "card", amount: 2000, accountId: "octane", categoryId: "shopping" }),
      tx({ id: "split", amount: 3000, accountId: "octane", categoryId: "dining" }),
      tx({ id: "amma", amount: 1500, categoryId: "medical" }),
      tx({ id: "loan", amount: 30000, type: "income", loanId: "L1", paymentAllocationType: "additionalDisbursement" }),
      tx({ id: "bill-out", amount: 5000, transferId: "cc" }),
      tx({ id: "bill-in", amount: 5000, transferId: "cc", type: "income", accountId: "octane" }),
      tx({ id: "reimb", amount: 2000, type: "income", isPersonLedgerMovement: true }),
      tx({ id: "tr-out", amount: 4000, transferId: "tr" }),
      tx({ id: "tr-in", amount: 4000, transferId: "tr", type: "income", accountId: "hdfc" }),
    ];
    const ctx = ctxOf([exp("split", 3000, 1000), exp("amma", 1500, 0)]);
    return { txns, ctx };
  };

  it("mixed cycle → ₹4,000", () => {
    const { txns, ctx } = fixture();
    expect(spend(txns, ctx)).toBe(4000);
  });

  it("26. Dashboard-style per-row grouping and Month Cycle summary derive the same My Spend", () => {
    const { txns, ctx } = fixture();
    const perRow = txns.reduce((s, t) => s + myConsumptionAmount(t, ctx), 0);
    expect(perRow).toBe(spend(txns, ctx));
  });

  it("27. category totals add back exactly to My Spend", () => {
    const { txns, ctx } = fixture();
    const summary = summarizeMySpend(mySpendRows({ transactions: txns, ctx, bucketDate: byDate, range: CYCLE }));
    const sum = Array.from(summary.byCategoryId.values()).reduce((s, v) => s + v, 0);
    expect(sum).toBe(summary.mySpend);
    expect(summary.byCategoryId.has("medical")).toBe(false); // fully AMMA's
  });

  it("28. paise rounding for split shares (₹100 / 3)", () => {
    const t = tx({ id: "third", amount: 100 });
    const c = classifyForMySpend(t, ctxOf([exp("third", 100, 33.33)]));
    expect(c.myAmount).toBe(33.33);
    expect(c.othersAmount).toBe(66.67);
    expect(c.myAmount + c.othersAmount).toBe(100);
    const many = Array.from({ length: 3 }, (_, i) => tx({ id: `p${i}`, amount: 0.3 }));
    expect(spend(many, ctxOf(many.map((m) => exp(m.id, 0.3, 0.1))))).toBe(0.3);
  });

  it("29. gross card/account movement differs from My Spend without corrupting either", () => {
    const { txns, ctx } = fixture();
    const summary = summarizeMySpend(mySpendRows({ transactions: txns, ctx, bucketDate: byDate, range: CYCLE }));
    expect(summary.totalPurchase).toBe(1000 + 2000 + 3000 + 1500);
    expect(summary.totalPurchase - summary.othersShare).toBe(summary.mySpend);
    // The engine never mutates the transactions it classifies (balances derive from them).
    expect(txns.find((t) => t.id === "split")!.amount).toBe(3000);
  });

  it("30. existing invariants untouched: cash-flow and the legacy dashboard myExpenses still behave as before", () => {
    const now = new Date(2026, 8, 20);
    const flow = cashFlowThisMonth({
      transactions: [
        { type: "expense", amount: 1000, effectiveMonth: now, isDeleted: false, isTransfer: false },
        { type: "expense", amount: 2000, effectiveMonth: now, isDeleted: false, isTransfer: false, isCreditCardAccount: true },
      ],
      emiPaidThisMonth: 0,
      loanPaidThisMonth: 0,
      billsPaidThisMonth: 0,
      moneyReceivedThisMonth: 0,
      now,
    });
    expect(flow.moneyOut).toBe(1000); // card purchase still not cash out
    const legacy = myExpenses(
      [{ id: "s", type: "expense", amount: 3000, dateTime: now, effectiveMonth: now, isTransfer: false, accountId: "octane" }],
      [{ transactionId: "s", totalAmount: 3000, isSplit: true, myShare: 1000 }],
      { kind: "customRange" },
      CYCLE,
    );
    expect(legacy).toBe(1000);
  });
});
