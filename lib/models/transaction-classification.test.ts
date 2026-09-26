import { describe, expect, it } from "vitest";
import { cashFlowThisMonth } from "@/lib/engines/cash-flow";
import { isLoanPrincipalDisbursement, isNonIncomeExpenseMovement, type Transaction } from "@/lib/models/transaction";

type Row = Pick<Transaction, "type" | "amount" | "transferId" | "loanId" | "paymentAllocationType">;
const NOW = new Date(2026, 0, 15);

const rows: Record<string, Row> = {
  salary: { type: "income", amount: 90000, transferId: null, loanId: null, paymentAllocationType: null },
  groceries: { type: "expense", amount: 4000, transferId: null, loanId: null, paymentAllocationType: null },
  transferOut: { type: "expense", amount: 1000, transferId: "t1", loanId: null, paymentAllocationType: null },
  borrowedPrincipal: { type: "income", amount: 50000, transferId: null, loanId: "orig_k_loan", paymentAllocationType: "additionalDisbursement" },
  lentPrincipal: { type: "expense", amount: 25000, transferId: null, loanId: "orig_j_loan", paymentAllocationType: "additionalDisbursement" },
  downPayment: { type: "expense", amount: 10000, transferId: null, loanId: "orig_p_loan", paymentAllocationType: null },
  emiRepayment: { type: "expense", amount: 4500, transferId: null, loanId: "orig_k_loan", paymentAllocationType: "regularEmi" },
};

describe("income/expense classification", () => {
  it("principal disbursements and transfers are excluded; everything else counts", () => {
    const excluded = Object.entries(rows).filter(([, t]) => isNonIncomeExpenseMovement(t)).map(([k]) => k).sort();
    expect(excluded).toEqual(["borrowedPrincipal", "lentPrincipal", "transferOut"]);
    expect(isLoanPrincipalDisbursement(rows.downPayment)).toBe(false);
    // Without a loan link, the allocation alone never excludes anything.
    expect(isLoanPrincipalDisbursement({ loanId: null, paymentAllocationType: "additionalDisbursement" })).toBe(false);
  });

  it("Cash Flow (Dashboard + Reports income) counts salary, spending, down payment and EMI — not borrowed/lent principal", () => {
    const summary = cashFlowThisMonth({
      transactions: Object.values(rows).map((t) => ({ type: t.type, amount: t.amount, effectiveMonth: NOW, isDeleted: false, isTransfer: isNonIncomeExpenseMovement(t) })),
      emiPaidThisMonth: 0,
      loanPaidThisMonth: 0,
      billsPaidThisMonth: 0,
      moneyReceivedThisMonth: 0,
      now: NOW,
    });
    expect(summary).toEqual({ moneyIn: 90000, moneyOut: 4000 + 10000 + 4500, net: 90000 - 18500 });
  });
});
