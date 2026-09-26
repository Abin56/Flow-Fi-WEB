import { describe, expect, it } from "vitest";
import { Timestamp } from "firebase/firestore";
import { loanFromFirestore, loanToFirestore } from "@/lib/models/loan";

const base = {
  loanAmount: 1000,
  interest: null,
  loanDate: Timestamp.fromDate(new Date("2026-01-01")),
  repaymentType: "oneTime",
  dueDate: Timestamp.fromDate(new Date("2026-02-01")),
  installmentFrequency: null,
  installmentCount: null,
  scheduleId: "schedule-1",
  createdAt: Timestamp.fromDate(new Date("2026-01-01")),
};
const snapshot = (data: Record<string, unknown>) => ({ id: "loan-1", data: () => data }) as Parameters<typeof loanFromFirestore>[0];

describe("Phase 5 unified creation persistence", () => {
  it("decodes a legacy Loan conservatively", () => {
    const value = loanFromFirestore(snapshot(base));
    expect(value.agreementKind).toBe("loan");
    expect(value.fundingSource).toBeNull();
    expect(value.purchaseAmount).toBeNull();
  });

  it("round-trips the additive cross-platform fields", () => {
    const value = loanFromFirestore(snapshot({ ...base, agreementKind: "installmentPurchase", fundingSource: "creditCard", linkedCreditCardId: "card-1", purchaseTransactionId: "txn-1", purchaseAmount: 60000, downPayment: 10000, loanAmount: 50000 }));
    const data = loanToFirestore(value);
    expect([data.agreementKind, data.fundingSource, data.linkedCreditCardId, data.purchaseTransactionId, data.purchaseAmount, data.downPayment, data.loanAmount]).toEqual(["installmentPurchase", "creditCard", "card-1", "txn-1", 60000, 10000, 50000]);
  });
});
