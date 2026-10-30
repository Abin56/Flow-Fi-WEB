/**
 * Lender-charge classification inside the two shared predicates every income/expense and spend total goes through:
 * `classifyForMySpend` (Dashboard categories, Reports, Analytics, Budgets, Month Cycle my-spend) and
 * `isNonIncomeExpenseMovement` (Month Cycle, Reports, Analytics, Dashboard, cycle mapping).
 *
 * Part 1 pins today's behaviour for every ordinary kind of transaction. It was written and run BEFORE the
 * predicates were extended and must keep passing unchanged: the lender-charge marker is additive and absent on
 * every existing transaction.
 * Part 2 covers the new classification.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {} }));

import { buildMySpendContext, classifyForMySpend, type MySpendTransaction } from "@/lib/engines/my-spend";
import { cashFlowThisMonth, type CashFlowTransaction } from "@/lib/engines/cash-flow";
import { isNonIncomeExpenseMovement } from "@/lib/models/transaction";

const ctx = buildMySpendContext({ expenses: [] });
const ctxCashLoan = buildMySpendContext({ expenses: [], repaymentIsConsumptionByAgreementId: new Map([["loan1", false], ["emi1", true]]) });

function tx(over: Partial<MySpendTransaction> = {}): MySpendTransaction {
  return {
    id: "t1", type: "expense", amount: 500, categoryId: "food", accountId: "a1", transferId: null, loanId: null, emiId: null,
    paymentAllocationType: null, isPersonLedgerMovement: false, excludeFromCalculations: false, deletedAt: null, ...over,
  };
}
const movement = (over: Partial<Parameters<typeof isNonIncomeExpenseMovement>[0]> = {}) =>
  ({ transferId: null, loanId: null, paymentAllocationType: null, isPersonLedgerMovement: false, ...over }) as Parameters<typeof isNonIncomeExpenseMovement>[0];

describe("Part 1 — existing behaviour is unchanged", () => {
  describe("classifyForMySpend", () => {
    it("an ordinary expense is my consumption in full", () => expect(classifyForMySpend(tx(), ctx)).toMatchObject({ kind: "consumption", myAmount: 500 }));
    it("a refund (income) is not an expense", () => expect(classifyForMySpend(tx({ type: "income" }), ctx).kind).toBe("notExpense"));
    it("a transfer leg is never spend", () => expect(classifyForMySpend(tx({ transferId: "x" }), ctx).kind).toBe("transfer"));
    it("a People ledger movement is never spend", () => expect(classifyForMySpend(tx({ isPersonLedgerMovement: true }), ctx).kind).toBe("personLedgerMovement"));
    it("a loan principal disbursement is never spend", () => expect(classifyForMySpend(tx({ loanId: "loan1", paymentAllocationType: "additionalDisbursement" }), ctx).kind).toBe("loanPrincipalDisbursement"));
    it("a repayment of a cash loan is a liability repayment", () => expect(classifyForMySpend(tx({ loanId: "loan1", paymentAllocationType: "regularEmi" }), ctxCashLoan).kind).toBe("liabilityRepayment"));
    it("an EMI repayment that is the sole record of the purchase still counts", () => expect(classifyForMySpend(tx({ emiId: "emi1", paymentAllocationType: "regularEmi" }), ctxCashLoan).kind).toBe("consumption"));
    it("a loan repayment against an unknown agreement keeps counting (pre-existing default)", () => expect(classifyForMySpend(tx({ loanId: "unknown", paymentAllocationType: "regularEmi" }), ctx).kind).toBe("consumption"));
    it("an excluded or deleted transaction is not spend", () => {
      expect(classifyForMySpend(tx({ excludeFromCalculations: true }), ctx).kind).toBe("excludedFromCalculations");
      expect(classifyForMySpend(tx({ deletedAt: new Date() }), ctx).kind).toBe("deleted");
    });
    it("an explicit null or empty marker behaves like no marker", () => {
      expect(classifyForMySpend(tx({ lenderChargeId: null }), ctx).kind).toBe("consumption");
      expect(classifyForMySpend(tx({ lenderChargeId: "" }), ctx).kind).toBe("consumption");
    });
  });

  describe("isNonIncomeExpenseMovement", () => {
    it("ordinary income and expense are counted", () => expect(isNonIncomeExpenseMovement(movement())).toBe(false));
    it("transfers, loan disbursements and People ledger movements are not", () => {
      expect(isNonIncomeExpenseMovement(movement({ transferId: "x" }))).toBe(true);
      expect(isNonIncomeExpenseMovement(movement({ loanId: "l", paymentAllocationType: "additionalDisbursement" }))).toBe(true);
      expect(isNonIncomeExpenseMovement(movement({ isPersonLedgerMovement: true }))).toBe(true);
    });
    it("loan and EMI repayments are still counted by this predicate (My Spend decides separately)", () => {
      expect(isNonIncomeExpenseMovement(movement({ loanId: "l", paymentAllocationType: "regularEmi" }))).toBe(false);
      expect(isNonIncomeExpenseMovement(movement({ loanId: "l", paymentAllocationType: "principalPrepayment" }))).toBe(false);
    });
    it("an explicit null or empty marker behaves like no marker", () => {
      expect(isNonIncomeExpenseMovement({ ...movement(), lenderChargeId: null })).toBe(false);
      expect(isNonIncomeExpenseMovement({ ...movement(), lenderChargeId: "" })).toBe(false);
    });
  });

  describe("cashFlowThisMonth (cash basis)", () => {
    const now = new Date(2026, 9, 15);
    const cf = (over: Partial<CashFlowTransaction>): CashFlowTransaction => ({ type: "expense", amount: 100, effectiveMonth: now, isDeleted: false, isTransfer: false, ...over });
    const run = (transactions: CashFlowTransaction[]) => cashFlowThisMonth({ transactions, emiPaidThisMonth: 0, loanPaidThisMonth: 0, billsPaidThisMonth: 0, moneyReceivedThisMonth: 0, now });
    it("ordinary expense and income count; transfers do not", () => {
      expect(run([cf({}), cf({ type: "income", amount: 40 }), cf({ isTransfer: true, amount: 999 })])).toEqual({ moneyIn: 40, moneyOut: 100, net: -60 });
    });
  });
});

describe("Part 2 — lender-charge settlement", () => {
  const settlement = (over: Partial<MySpendTransaction> = {}) => tx({ lenderChargeId: "c1", amount: 1000, ...over });

  it("is not my spend — the expense was recognised at billing", () => {
    expect(classifyForMySpend(settlement(), ctx)).toMatchObject({ kind: "liabilityRepayment", myAmount: 0, grossAmount: 1000 });
  });
  it("is not spend however the payment transaction is linked", () => {
    for (const link of [{}, { loanId: "loan1", paymentAllocationType: "regularEmi" as const }, { emiId: "emi1", paymentAllocationType: "regularEmi" as const }]) {
      expect(classifyForMySpend(settlement(link), ctxCashLoan).myAmount).toBe(0);
    }
  });
  it("is not an income/expense movement for the totals", () => {
    expect(isNonIncomeExpenseMovement({ ...movement(), lenderChargeId: "c1" })).toBe(true);
  });
  it("still really moves cash: cash flow counts it once as money out, and it keeps its balance effect", () => {
    const now = new Date(2026, 9, 15);
    const cash = cashFlowThisMonth({
      transactions: [{ type: "expense", amount: 1000, effectiveMonth: now, isDeleted: false, isTransfer: false }],
      emiPaidThisMonth: 0, loanPaidThisMonth: 0, billsPaidThisMonth: 0, moneyReceivedThisMonth: 0, now,
    });
    expect(cash.moneyOut).toBe(1000);
    // excludeFromCalculations stays false: that flag would zero the account effect.
    expect(settlement().excludeFromCalculations).toBe(false);
  });
});
