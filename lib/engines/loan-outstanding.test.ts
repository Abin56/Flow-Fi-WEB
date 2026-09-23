import { describe, expect, it } from "vitest";
import { outstandingPrincipalFor, principalPaidFor, type OutstandingInstallment } from "./loan-outstanding";

/**
 * Regression test for the audit finding: `use-loans-data.ts`'s `toLoanRow`
 * used to credit a partially-paid installment's WHOLE `principalPortion` the
 * moment `amountPaid > 0`, instead of prorating by `amountPaid / amountDue`
 * like `LoanRepository.editLoanTerms` always did. The two independent
 * implementations disagreed on-screen ("Outstanding" vs. "Loan Amount Left"
 * on the same `LoanScheduleDialog`) for a loan with a partially-paid
 * installment. Both call sites now share this one implementation.
 */
function installment(overrides: Partial<OutstandingInstallment> = {}): OutstandingInstallment {
  return { amountDue: 1000, amountPaid: 0, isSkipped: false, principalPortion: 900, ...overrides };
}

describe("outstandingPrincipalFor / principalPaidFor", () => {
  it("prorates a partially-paid installment's principal contribution instead of crediting the whole share", () => {
    const installments = [installment({ amountPaid: 500 })];
    // paidTowardPrincipal = 900 * (500/1000) = 450.
    expect(principalPaidFor(installments)).toBe(450);
    expect(outstandingPrincipalFor(10000, installments)).toBe(10000 - 450);
  });

  it("credits the full principal share once an installment is fully paid", () => {
    const installments = [installment({ amountPaid: 1000 })];
    expect(principalPaidFor(installments)).toBe(900);
    expect(outstandingPrincipalFor(10000, installments)).toBe(10000 - 900);
  });

  it("credits nothing for an untouched installment", () => {
    const installments = [installment({ amountPaid: 0 })];
    expect(principalPaidFor(installments)).toBe(0);
    expect(outstandingPrincipalFor(10000, installments)).toBe(10000);
  });

  it("treats the full amountDue as principal for a non-interest-bearing installment", () => {
    const installments = [installment({ amountPaid: 500, principalPortion: null })];
    expect(principalPaidFor(installments)).toBe(500);
  });

  it("clamps outstanding principal to [0, loanAmount]", () => {
    const installments = [installment({ amountDue: 1000, amountPaid: 1000, principalPortion: 900 })];
    // Loan amount edited down below what's already paid off — should never go negative.
    expect(outstandingPrincipalFor(500, installments)).toBe(0);
  });

  it("agrees across a mixed schedule of fully/partially/un-paid installments", () => {
    const installments = [
      installment({ amountPaid: 1000 }), // fully paid: +900
      installment({ amountPaid: 300 }), // partial: 900*(300/1000)=270
      installment({ amountPaid: 0 }), // untouched: +0
    ];
    expect(principalPaidFor(installments)).toBe(900 + 270);
    expect(outstandingPrincipalFor(3000, installments)).toBe(3000 - (900 + 270));
  });
});
