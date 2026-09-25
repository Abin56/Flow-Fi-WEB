import { describe, expect, it } from "vitest";
import type { Loan } from "@/lib/models/loan";
import type { Installment } from "@/lib/models/payment-schedule";
import { previewAdditionalDisbursement, previewPrincipalPrepayment } from "./loan-adjustment-preview";

const loan = {
  id: "loan-1",
  loanAmount: 3000,
  loanDate: new Date("2026-01-01T00:00:00Z"),
  repaymentType: "installment",
  direction: "taken",
  interest: null,
  installmentFrequency: "monthly",
  installmentCount: 3,
  scheduleId: "schedule-1",
} as Loan;

function installment(sequenceNumber: number, dueDate: string): Installment {
  return {
    id: `installment-${sequenceNumber}`,
    scheduleId: "schedule-1",
    ownerType: "loan",
    ownerId: "loan-1",
    sequenceNumber,
    dueDate: new Date(dueDate),
    amountDue: 1000,
    amountPaid: 0,
    isSkipped: false,
    principalPortion: null,
    interestPortion: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
  };
}

const installments = [
  installment(1, "2026-02-01T00:00:00Z"),
  installment(2, "2026-03-01T00:00:00Z"),
  installment(3, "2026-04-01T00:00:00Z"),
];

describe("loan adjustment previews", () => {
  it("keeps scheduled settlement and explicit principal prepayment distinct", () => {
    const preview = previewPrincipalPrepayment(loan, installments, 500, new Date("2026-01-15T00:00:00Z"));
    expect(preview.scheduledAmount).toBe(1000);
    expect(preview.principalAmount).toBe(500);
    expect(preview.transactionAmount).toBe(1500);
    expect(preview.principalBefore).toBe(3000);
    expect(preview.principalAfter).toBe(1500);
    expect(preview.outcome).toEqual({ kind: "solved", remainingInstallmentCount: 2, installmentAmount: 750 });
  });

  it("uses Hold Tenure for an additional disbursement preview", () => {
    const preview = previewAdditionalDisbursement(loan, installments, 1500);
    expect(preview.principalBefore).toBe(3000);
    expect(preview.principalAfter).toBe(4500);
    expect(preview.remainingInstallmentCount).toBe(3);
    expect(preview.outcome).toEqual({ kind: "solved", remainingInstallmentCount: 3, installmentAmount: 1500 });
  });
});
