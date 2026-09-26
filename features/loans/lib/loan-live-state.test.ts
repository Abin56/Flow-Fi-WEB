import { describe, expect, it } from "vitest";
import { friendlyLoanError, historyInstallmentIds, loanHistoryQueryKey } from "./loan-live-state";

const loan = { id: "loan1", scheduleId: "s1", loanAmount: 10000, installmentCount: 3, editHistory: [] };
const installments = [
  { id: "i1", amountPaid: 0, isSkipped: false },
  { id: "i2", amountPaid: 0, isSkipped: false },
  { id: "i3", amountPaid: 0, isSkipped: false },
];

describe("loanHistoryQueryKey — history re-reads after every persisted money operation", () => {
  const before = JSON.stringify(loanHistoryQueryKey("u1", loan, installments));

  it("regression: a regular/partial/advance EMI payment changes the key (installment ids stay the same)", () => {
    const afterPayment = installments.map((i) => (i.id === "i1" ? { ...i, amountPaid: 1500 } : i));
    expect(JSON.stringify(loanHistoryQueryKey("u1", loan, afterPayment))).not.toBe(before);
  });

  it("a multi-EMI payment spread over several installments changes the key", () => {
    const after = installments.map((i) => (i.id !== "i3" ? { ...i, amountPaid: 3400 } : i));
    expect(JSON.stringify(loanHistoryQueryKey("u1", loan, after))).not.toBe(before);
  });

  it("extra principal (regenerated tail) and borrow/lend more (loanAmount) change the key", () => {
    const retiredTail = [installments[0], { id: "i9", amountPaid: 0, isSkipped: false }];
    expect(JSON.stringify(loanHistoryQueryKey("u1", { ...loan, installmentCount: 2 }, retiredTail))).not.toBe(before);
    expect(JSON.stringify(loanHistoryQueryKey("u1", { ...loan, loanAmount: 15000 }, installments))).not.toBe(before);
  });

  it("a reversal that restores the exact prior state yields the prior key again (cache reuse is correct)", () => {
    const restored = installments.map((i) => ({ ...i }));
    expect(JSON.stringify(loanHistoryQueryKey("u1", { ...loan }, restored))).toBe(before);
  });

  it("is stable when nothing changed, so an open dialog doesn't refetch on unrelated renders", () => {
    expect(JSON.stringify(loanHistoryQueryKey("u1", loan, installments))).toBe(before);
  });
});

describe("historyInstallmentIds", () => {
  it("includes installments retired by a re-plan, where the extra-principal payment record lives", () => {
    const ids = historyInstallmentIds(["i1", "i4"], [{ retiredInstallmentIds: ["i2", "i3"] }, { retiredInstallmentIds: ["i3", "i4"] }]);
    expect(ids.sort()).toEqual(["i1", "i2", "i3", "i4"]);
  });
});

describe("friendlyLoanError", () => {
  it("shows repository validation messages, which are written for people", () => {
    expect(friendlyLoanError(new Error("Loan amount can't be less than the principal already paid off"))).toBe(
      "Loan amount can't be less than the principal already paid off",
    );
  });

  it("hides raw Firestore error text", () => {
    const firestoreError = Object.assign(new Error("FirebaseError: [code=permission-denied]: Missing or insufficient permissions."), {
      code: "permission-denied",
      name: "FirebaseError",
    });
    expect(friendlyLoanError(firestoreError)).toBe("Something went wrong. Please try again.");
    expect(friendlyLoanError(Object.assign(new Error("x"), { code: "unavailable" }))).toMatch(/offline/);
  });

  it("uses the fallback for non-Error values", () => {
    expect(friendlyLoanError("boom", "Fallback")).toBe("Fallback");
  });
});
