import { describe, expect, it } from "vitest";
import { peoplePaymentsForMonth } from "@/features/transactions/lib/people-payments-by-month";

const t = (over: Record<string, unknown>) => ({
  type: "income" as const,
  amount: 1000,
  dateTime: new Date(2026, 9, 5),
  transferId: null,
  excludeFromCalculations: false,
  isPersonLedgerMovement: true,
  linkedPersonId: "abin",
  deletedAt: null,
  ...over,
});

describe("peoplePaymentsForMonth", () => {
  it("sums what each person paid me in the month, largest first, and keeps paid-out apart", () => {
    const r = peoplePaymentsForMonth(
      [t({}), t({ linkedPersonId: "dad", amount: 3000 }), t({ type: "expense", amount: 500 }), t({ dateTime: new Date(2026, 8, 1) })],
      2026,
      9,
    );
    expect(r.received.people.map((p) => p.personId)).toEqual(["dad", "abin"]);
    expect(r.received.total).toBe(4000);
    expect(r.paid.total).toBe(500);
  });
  it("skips rows already in the balance, transfers, deleted rows and non-person rows", () => {
    const r = peoplePaymentsForMonth(
      [t({ excludeFromCalculations: true }), t({ transferId: "x" }), t({ deletedAt: new Date() }), t({ isPersonLedgerMovement: false })],
      2026,
      9,
    );
    expect(r.received.total).toBe(0);
    expect(r.received.people).toEqual([]);
  });
});
