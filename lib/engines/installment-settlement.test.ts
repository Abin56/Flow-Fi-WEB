import { describe, expect, it } from "vitest";
import { planInstallmentSettlement, totalApplied } from "./installment-settlement";
import type { Installment } from "@/lib/models/payment-schedule";

function installment(overrides: Partial<Installment> = {}): Installment {
  return {
    id: "i1",
    scheduleId: "s1",
    ownerType: "loan",
    ownerId: "l1",
    sequenceNumber: 1,
    dueDate: new Date("2026-01-01"),
    amountDue: 1000,
    amountPaid: 0,
    isSkipped: false,
    principalPortion: null,
    interestPortion: null,
    createdAt: new Date("2026-01-01"),
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    ...overrides,
  };
}

describe("planInstallmentSettlement", () => {
  it("throws when the amount isn't positive", () => {
    expect(() => planInstallmentSettlement([installment()], 0)).toThrow("Settlement amount must be greater than 0");
    expect(() => planInstallmentSettlement([installment()], -5)).toThrow();
  });

  it("skips installments with no remaining balance — fully paid, or skipped-and-settled", () => {
    const paid = installment({ id: "paid", amountDue: 500, amountPaid: 500 });
    const skippedSettled = installment({ id: "skipped", amountDue: 500, amountPaid: 500, isSkipped: true });
    const owed = installment({ id: "owed", amountDue: 500, amountPaid: 0 });
    const plan = planInstallmentSettlement([paid, skippedSettled, owed], 500);
    expect(plan.portions).toEqual([{ installment: owed, portion: 500 }]);
    expect(plan.unallocated).toBe(0);
  });

  it("fans an amount across installments oldest-first, fully covering each until it runs out", () => {
    const a = installment({ id: "a", sequenceNumber: 1, amountDue: 300 });
    const b = installment({ id: "b", sequenceNumber: 2, amountDue: 300 });
    const c = installment({ id: "c", sequenceNumber: 3, amountDue: 300 });
    const plan = planInstallmentSettlement([a, b, c], 500);
    expect(plan.portions).toEqual([
      { installment: a, portion: 300 },
      { installment: b, portion: 200 },
    ]);
    expect(plan.unallocated).toBe(0);
    expect(totalApplied(plan)).toBe(500);
  });

  it("credits a partially-paid installment only its remaining balance", () => {
    const a = installment({ id: "a", amountDue: 300, amountPaid: 100 });
    const plan = planInstallmentSettlement([a], 1000);
    expect(plan.portions).toEqual([{ installment: a, portion: 200 }]);
    expect(plan.unallocated).toBe(800);
  });

  it("reports the leftover as unallocated once every installment is fully covered", () => {
    const a = installment({ id: "a", amountDue: 100 });
    const plan = planInstallmentSettlement([a], 250);
    expect(plan.portions).toEqual([{ installment: a, portion: 100 }]);
    expect(plan.unallocated).toBe(150);
  });
});
