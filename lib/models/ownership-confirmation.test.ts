import { Timestamp } from "firebase/firestore";
import { describe, expect, it } from "vitest";
import { emiFromFirestore, emiToFirestore } from "@/lib/models/emi";
import { loanFromFirestore, loanToFirestore } from "@/lib/models/loan";
import { ownershipConfirmationBlocker, ownershipConfirmationFromData, ownershipConfirmationToData } from "@/lib/models/ownership-confirmation";

const snap = (id: string, data: Record<string, unknown>) => ({ id, data: () => data }) as never;
const T = Timestamp.fromDate(new Date("2026-10-20T10:00:00.000Z"));

const loanData = {
  personId: null, loanAmount: 2000, interest: null, loanDate: T, repaymentType: "oneTime", dueDate: T, installmentFrequency: null,
  installmentCount: null, notes: "", scheduleId: "s", isClosed: false, createdAt: T, direction: "taken", category: "institutional",
};
const emiData = {
  name: "Phone", principalAmount: 9000, startDate: T, installmentFrequency: "monthly", installmentCount: 3, endDate: T,
  scheduleId: "s", createdAt: T, loanType: "personal",
};

describe("ownershipConfirmedMine serialization", () => {
  it("a document without the field loads as not confirmed and is written back without the key", () => {
    const loan = loanFromFirestore(snap("l", loanData));
    const emi = emiFromFirestore(snap("e", emiData));
    expect(loan.ownershipConfirmedMine).toBeNull();
    expect(emi.ownershipConfirmedMine).toBeNull();
    expect("ownershipConfirmedMine" in loanToFirestore(loan)).toBe(false);
    expect("ownershipConfirmedMine" in emiToFirestore(emi)).toBe(false);
  });

  it("round-trips on a Loan and an EMI", () => {
    const loan = loanFromFirestore(snap("l", { ...loanData, ownershipConfirmedMine: { at: T } }));
    expect(loan.ownershipConfirmedMine).toEqual({ at: T.toDate() });
    expect(loanToFirestore(loan).ownershipConfirmedMine).toEqual({ at: T });
    const emi = emiFromFirestore(snap("e", { ...emiData, ownershipConfirmedMine: { at: T } }));
    expect(emiToFirestore(emi).ownershipConfirmedMine).toEqual({ at: T });
  });

  it("malformed values are 'not confirmed', never a crash", () => {
    for (const bad of [true, "yes", 5, {}, { at: "x" }, []]) expect(ownershipConfirmationFromData(bad)).toBeNull();
    expect(ownershipConfirmationToData(null)).toEqual({});
  });
});

describe("ownershipConfirmationBlocker", () => {
  const ok = { deletedAt: null, isClosed: false, direction: "taken" as const };
  it("allows an active, taken, unassigned record — with or without a bare beneficiary association", () => {
    expect(ownershipConfirmationBlocker(ok)).toBeNull();
    expect(ownershipConfirmationBlocker({ ...ok, ownershipShares: [], beneficiaryRepaysInstallments: false })).toBeNull();
    expect(ownershipConfirmationBlocker({ deletedAt: null, isClosed: false })).toBeNull(); // an EMI has no direction
  });
  it("rejects deleted, closed, given, shared and repay-opt-in records", () => {
    expect(ownershipConfirmationBlocker({ ...ok, deletedAt: new Date() })).toMatch(/trash/);
    expect(ownershipConfirmationBlocker({ ...ok, isClosed: true })).toMatch(/closed/);
    expect(ownershipConfirmationBlocker({ ...ok, direction: "given" })).toMatch(/gave/);
    expect(ownershipConfirmationBlocker({ ...ok, ownershipShares: [{}] })).toMatch(/split/);
    expect(ownershipConfirmationBlocker({ ...ok, beneficiaryRepaysInstallments: true })).toMatch(/repays/);
  });
});
