import { describe, expect, it } from "vitest";
import { findSameAmountDateDuplicateIds, type TransactionForDuplicateGrouping } from "./same-amount-date-duplicates";

function txn(overrides: Partial<TransactionForDuplicateGrouping> = {}): TransactionForDuplicateGrouping {
  return {
    id: "txn-1",
    amount: 1000,
    dateTime: new Date("2026-08-04T00:00:00.000Z"),
    transferId: null,
    ...overrides,
  };
}

describe("findSameAmountDateDuplicateIds", () => {
  it("flags two transactions with the same amount and exact date", () => {
    const a = txn({ id: "a" });
    const b = txn({ id: "b" });
    const result = findSameAmountDateDuplicateIds([a, b]);
    expect(result.has("a")).toBe(true);
    expect(result.has("b")).toBe(true);
  });

  it("does not flag a transaction with no matching pair", () => {
    const a = txn({ id: "a" });
    const b = txn({ id: "b", amount: 500 });
    const result = findSameAmountDateDuplicateIds([a, b]);
    expect(result.size).toBe(0);
  });

  it("does not flag same amount on a different date", () => {
    const a = txn({ id: "a" });
    const b = txn({ id: "b", dateTime: new Date("2026-08-05T00:00:00.000Z") });
    const result = findSameAmountDateDuplicateIds([a, b]);
    expect(result.size).toBe(0);
  });

  it("does not flag same date with a different amount", () => {
    const a = txn({ id: "a" });
    const b = txn({ id: "b", amount: 999 });
    const result = findSameAmountDateDuplicateIds([a, b]);
    expect(result.size).toBe(0);
  });

  it("excludes transfer pairs — same amount/date is expected for a transfer's two legs", () => {
    const a = txn({ id: "a", transferId: "transfer-1" });
    const b = txn({ id: "b", transferId: "transfer-1" });
    const result = findSameAmountDateDuplicateIds([a, b]);
    expect(result.size).toBe(0);
  });

  it("a transfer leg does not suppress an unrelated real duplicate at the same amount/date", () => {
    const transferLeg = txn({ id: "transfer-leg", transferId: "transfer-1" });
    const real1 = txn({ id: "real-1" });
    const real2 = txn({ id: "real-2" });
    const result = findSameAmountDateDuplicateIds([transferLeg, real1, real2]);
    expect(result.has("transfer-leg")).toBe(false);
    expect(result.has("real-1")).toBe(true);
    expect(result.has("real-2")).toBe(true);
  });

  it("skips separate Loan and People movements while still flagging ordinary transactions of the same amount", () => {
    const amount = 2000;
    const transactions = [
      txn({ id: "borrowed", amount, isPersonLedgerMovement: true }),
      txn({ id: "repaid", amount, isPersonLedgerMovement: true }),
      txn({ id: "borrowed-again", amount, isPersonLedgerMovement: true }),
      txn({ id: "loan-origination", amount, loanId: "loan-1" }),
      txn({ id: "loan-repayment", amount, loanId: "loan-1" }),
      txn({ id: "emi-repayment", amount, emiId: "emi-1" }),
      txn({ id: "linked-payment", amount, earlierPaymentLink: { ownerType: "loan", ownerId: "loan-2", scheduleId: "s1", installmentId: "i1", paymentId: "p1" } }),
      txn({ id: "ordinary-1", amount }),
      txn({ id: "ordinary-2", amount }),
    ];
    expect(findSameAmountDateDuplicateIds(transactions)).toEqual(new Set(["ordinary-1", "ordinary-2"]));
  });

  it("groups three or more matching transactions together, not just pairs", () => {
    const a = txn({ id: "a" });
    const b = txn({ id: "b" });
    const c = txn({ id: "c" });
    const result = findSameAmountDateDuplicateIds([a, b, c]);
    expect(result.size).toBe(3);
  });

  it("ignores description/direction — grouping is amount+date only", () => {
    // TransactionForDuplicateGrouping doesn't even carry description/direction — this test documents
    // that omission is intentional, not an oversight; two transactions can only be compared on what
    // the type exposes.
    const a = txn({ id: "a" });
    const b = txn({ id: "b" });
    const result = findSameAmountDateDuplicateIds([a, b]);
    expect(result.size).toBe(2);
  });

  it("'exact calendar day' is the user's own day — late night and just after midnight are different days, early morning and afternoon are the same", () => {
    // Local clock times (not UTC): in IST 00:30 is still the previous UTC day, which used to merge/split these wrongly.
    const lateNight = txn({ id: "late", dateTime: new Date(2026, 10, 9, 23, 0) });
    const afterMidnight = txn({ id: "after", dateTime: new Date(2026, 10, 10, 0, 30) });
    const afternoon = txn({ id: "pm", dateTime: new Date(2026, 10, 10, 14, 0) });
    expect(findSameAmountDateDuplicateIds([lateNight, afterMidnight]).size).toBe(0);
    const sameDay = findSameAmountDateDuplicateIds([afterMidnight, afternoon]);
    expect(sameDay.has("after")).toBe(true);
    expect(sameDay.has("pm")).toBe(true);
  });

  it("returns an empty set for an empty list", () => {
    expect(findSameAmountDateDuplicateIds([]).size).toBe(0);
  });

  it("returns an empty set when nothing matches anything else", () => {
    const a = txn({ id: "a", amount: 100 });
    const b = txn({ id: "b", amount: 200 });
    const c = txn({ id: "c", amount: 300 });
    expect(findSameAmountDateDuplicateIds([a, b, c]).size).toBe(0);
  });
});
