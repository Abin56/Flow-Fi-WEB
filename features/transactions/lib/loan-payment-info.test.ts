import { describe, expect, it } from "vitest";
import { buildLoanPaymentInfo } from "@/features/transactions/lib/loan-payment-info";

const inst = (id: string, scheduleId: string, sequenceNumber: number, deletedAt: Date | null = null) => ({ id, scheduleId, sequenceNumber, deletedAt });
const info = buildLoanPaymentInfo({
  loans: [
    { id: "l1", name: "Personal Loan", institutionName: "HDFC", personId: null, scheduleId: "s1", deletedAt: null },
    { id: "l2", name: "Loan from Abin", institutionName: null, personId: "abin", scheduleId: "s2", deletedAt: null },
  ],
  emis: [{ id: "e1", name: "Phone", lenderName: "Amazon", scheduleId: "s3", deletedAt: null }],
  loanInstallments: [inst("a1", "s1", 1), inst("a2", "s1", 2), inst("a3", "s1", 3), inst("gone", "s1", 4, new Date())],
  emiInstallments: [inst("b1", "s3", 1), inst("b2", "s3", 2)],
  personNameById: new Map([["abin", "ABIN"]]),
});

describe("buildLoanPaymentInfo", () => {
  it("names the lender, the tag and 'n of total' for a loan installment (deleted installments are not counted)", () => {
    expect(info({ loanId: "l1", emiId: null, installmentId: "a2" })).toEqual({ kind: "Loan", lender: "HDFC", installment: { number: 2, total: 3 } });
  });
  it("tags an EMI payment and uses its lender", () => {
    expect(info({ loanId: null, emiId: "e1", installmentId: "b2" })).toEqual({ kind: "EMI", lender: "Amazon", installment: { number: 2, total: 2 } });
  });
  it("falls back to the person, then the loan name; no installment when none is named", () => {
    expect(info({ loanId: "l2", emiId: null, installmentId: null })).toEqual({ kind: "Loan", lender: "ABIN", installment: null });
  });
  it("is null for an ordinary transaction and ignores an installment from another schedule", () => {
    expect(info({ loanId: null, emiId: null, installmentId: null })).toBeNull();
    expect(info({ loanId: "l1", emiId: null, installmentId: "b1" })?.installment).toBeNull();
  });
});
