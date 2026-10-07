import { describe, expect, it } from "vitest";
import { installmentProgress } from "./installment-progress";
import type { Installment } from "@/lib/models/payment-schedule";

function inst(n: number, amountPaid: number, opts: Partial<Installment> = {}): Installment {
  return {
    id: `i${n}`,
    scheduleId: "s",
    ownerType: "loan",
    ownerId: "l",
    sequenceNumber: n,
    dueDate: new Date(2026, 9 + n, 5),
    amountDue: 1000,
    amountPaid,
    isSkipped: false,
    principalPortion: null,
    interestPortion: null,
    createdAt: new Date(2026, 9, 1),
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    ...opts,
  };
}

describe("installmentProgress", () => {
  it("never counts a partly covered installment as paid", () => {
    const p = installmentProgress([inst(1, 1000), inst(2, 500), inst(3, 0)]);
    expect(p).toMatchObject({ total: 3, paid: 1, partial: 1, unpaid: 1, paidTotal: 1500, remainingTotal: 1500, percentPaid: 50 });
    expect(p.next).toMatchObject({ installment: { id: "i2" }, original: 1000, covered: 500, stillDue: 500 });
  });

  it("ignores skipped and deleted installments, sorts by sequence", () => {
    const p = installmentProgress([inst(3, 0), inst(2, 0, { isSkipped: true }), inst(1, 1000), inst(4, 0, { deletedAt: new Date() })]);
    expect(p).toMatchObject({ total: 2, paid: 1, unpaid: 1, next: { installment: { id: "i3" } } });
  });

  it("fully paid → no next, 100%", () => {
    expect(installmentProgress([inst(1, 1000), inst(2, 1000)])).toMatchObject({ paid: 2, next: null, percentPaid: 100, remainingTotal: 0 });
  });

  it("empty schedule", () => {
    expect(installmentProgress([])).toMatchObject({ total: 0, percentPaid: 0, next: null });
  });
});
