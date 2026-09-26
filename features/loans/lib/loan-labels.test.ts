import { describe, expect, it } from "vitest";
import { additionalAmountCopy, historyEntryTitle, isMoneyIn, loanTransactionLabel, PAY_EXTRA_PRINCIPAL, PAY_MULTIPLE_EMIS } from "./loan-labels";

describe("Loan action copy", () => {
  it("uses plain-language labels, never the old ambiguous ones", () => {
    expect(PAY_EXTRA_PRINCIPAL.label).toBe("Pay Extra Principal");
    expect(PAY_MULTIPLE_EMIS.label).toBe("Pay Multiple EMIs");
    const all = [PAY_EXTRA_PRINCIPAL.label, PAY_MULTIPLE_EMIS.label, additionalAmountCopy("taken").label, additionalAmountCopy("given").label];
    for (const label of all) {
      expect(label).not.toMatch(/Toward Balance|Add More to This Loan|Pay Off Remaining Balance|re-?amorti/i);
    }
  });

  it("additional-amount wording follows the loan direction", () => {
    expect(additionalAmountCopy("taken")).toEqual({ label: "Borrow More", description: "Add more money received under this loan." });
    expect(additionalAmountCopy("given")).toEqual({ label: "Lend More", description: "Add more money given under this loan." });
  });
});

describe("isMoneyIn — account direction comes from the loan direction", () => {
  it("borrowed loan: repaying and paying extra principal take money out; borrowing more brings money in", () => {
    expect(isMoneyIn("taken", "payment")).toBe(false);
    expect(isMoneyIn("taken", "additionalAmount")).toBe(true);
  });
  it("lent loan: repayments and extra principal bring money in; lending more takes money out", () => {
    expect(isMoneyIn("given", "payment")).toBe(true);
    expect(isMoneyIn("given", "additionalAmount")).toBe(false);
  });
});

describe("historyEntryTitle", () => {
  it("names each payment kind in plain language", () => {
    expect(historyEntryTitle({ kind: "payment", allocationType: "regularEmi", partial: false }, "taken")).toBe("EMI payment");
    expect(historyEntryTitle({ kind: "payment", allocationType: "regularEmi", partial: true }, "taken")).toBe("Partial EMI");
    expect(historyEntryTitle({ kind: "payment", allocationType: "advanceEmi", partial: false }, "taken")).toBe("Advance EMI");
    expect(historyEntryTitle({ kind: "payment", allocationType: "principalPrepayment", partial: false }, "taken")).toBe("Extra principal payment");
  });
  it("additional amounts read as Borrowed more / Lent more", () => {
    expect(historyEntryTitle({ kind: "additionalAmount" }, "taken")).toBe("Borrowed more");
    expect(historyEntryTitle({ kind: "additionalAmount" }, "given")).toBe("Lent more");
  });
});

describe("loanTransactionLabel", () => {
  const home = { name: "Home Loan", direction: "taken" as const };
  const rahul = { name: "Rahul Loan", direction: "given" as const };

  it("returns null for transactions that were not created by a Loan", () => {
    expect(loanTransactionLabel({ loanId: null, paymentAllocationType: null, type: "expense" }, null)).toBeNull();
    expect(loanTransactionLabel({ loanId: "l1", paymentAllocationType: null, type: "expense" }, home)).toBeNull();
  });

  it("borrowed loan labels", () => {
    expect(loanTransactionLabel({ loanId: "l1", paymentAllocationType: "regularEmi", type: "expense" }, home)).toBe("Loan EMI — Home Loan");
    expect(loanTransactionLabel({ loanId: "l1", paymentAllocationType: "advanceEmi", type: "expense" }, home)).toBe("Advance EMI — Home Loan");
    expect(loanTransactionLabel({ loanId: "l1", paymentAllocationType: "principalPrepayment", type: "expense" }, home)).toBe("Extra Principal Payment — Home Loan");
    expect(loanTransactionLabel({ loanId: "l1", paymentAllocationType: "additionalDisbursement", type: "income" }, home)).toBe("Borrowed More — Home Loan");
  });

  it("lent loan labels", () => {
    expect(loanTransactionLabel({ loanId: "l2", paymentAllocationType: "regularEmi", type: "income" }, rahul)).toBe("Loan Repayment Received — Rahul Loan");
    expect(loanTransactionLabel({ loanId: "l2", paymentAllocationType: "additionalDisbursement", type: "expense" }, rahul)).toBe("Lent More — Rahul Loan");
  });

  it("falls back to the stored transaction type for direction when the loan is gone, without a name", () => {
    expect(loanTransactionLabel({ loanId: "gone", paymentAllocationType: "additionalDisbursement", type: "expense" }, null)).toBe("Lent More");
    expect(loanTransactionLabel({ loanId: "gone", paymentAllocationType: "additionalDisbursement", type: "income" }, null)).toBe("Borrowed More");
    expect(loanTransactionLabel({ loanId: "gone", paymentAllocationType: "regularEmi", type: "income" }, null)).toBe("Loan Repayment Received");
    expect(loanTransactionLabel({ loanId: "gone", paymentAllocationType: "regularEmi", type: "expense" }, null)).toBe("Loan EMI");
  });

  it("never exposes a raw enum name", () => {
    for (const type of ["regularEmi", "advanceEmi", "principalPrepayment", "additionalDisbursement"] as const) {
      const label = loanTransactionLabel({ loanId: "l1", paymentAllocationType: type, type: "expense" }, home)!;
      expect(label).not.toContain(type);
    }
  });
});
