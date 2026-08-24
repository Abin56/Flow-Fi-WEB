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
