import { describe, expect, it } from "vitest";
import type { Transaction } from "@/lib/models/transaction";
import { StatementRepository } from "./credit-card-repository";

/**
 * Regression test for the audit finding: `StatementRepository.totalFor` only
 * filtered on `deletedAt`/period, unlike every other financial total in the
 * app (`dashboard-aggregation.ts`), which also excludes
 * `excludeFromCalculations` and transfer legs. Since `materializeIfDue`
 * persists `totalAmount` once and never recomputes it, a statement generated
 * while an excluded/transfer transaction was present carried a permanently
 * wrong total.
 */
function txn(overrides: Partial<Transaction>): Transaction {
  return {
    id: "txn-1",
    type: "expense",
    amount: 100,
    dateTime: new Date("2026-09-10T00:00:00Z"),
    accountId: "card-account-1",
    categoryId: "cat-1",
    description: "",
    notes: "",
    receiptPurpose: null,
    transferId: null,
    excludeFromCalculations: false,
    accountingMonth: null,
    linkedPersonId: null,
    owesPersonToggle: false,
    createdAt: new Date("2026-09-10T00:00:00Z"),
    transferMatchedAt: null,
    loanId: null,
    emiId: null,
    installmentId: null,
    installmentPaymentId: null,
    paymentAllocationType: null,
    status: "posted",
    isBusiness: false,
    source: null,
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    ...overrides,
  };
}

describe("StatementRepository.totalFor", () => {
  // biome-ignore lint: constructor only reads `this.collection` in other methods, not totalFor.
  const repo = new StatementRepository(null as never);
  const period = { periodStart: new Date("2026-09-01T00:00:00Z"), periodEnd: new Date("2026-09-30T23:59:59Z") };

  it("sums ordinary card purchases in the period", () => {
    const transactions = [txn({ id: "t1", amount: 300 }), txn({ id: "t2", amount: 200 })];
    expect(repo.totalFor(transactions, period)).toBe(500);
  });

  it("excludes excludeFromCalculations transactions", () => {
    const transactions = [txn({ id: "t1", amount: 300 }), txn({ id: "t2", amount: 200, excludeFromCalculations: true })];
    expect(repo.totalFor(transactions, period)).toBe(300);
  });

  it("excludes transfer legs", () => {
    const transactions = [txn({ id: "t1", amount: 300 }), txn({ id: "t2", amount: 200, transferId: "transfer-1" })];
    expect(repo.totalFor(transactions, period)).toBe(300);
  });

  it("excludes soft-deleted transactions", () => {
    const transactions = [txn({ id: "t1", amount: 300 }), txn({ id: "t2", amount: 200, deletedAt: new Date() })];
    expect(repo.totalFor(transactions, period)).toBe(300);
  });

  it("excludes transactions outside the period", () => {
    const transactions = [txn({ id: "t1", amount: 300, dateTime: new Date("2026-08-31T00:00:00Z") })];
    expect(repo.totalFor(transactions, period)).toBe(0);
  });
});
