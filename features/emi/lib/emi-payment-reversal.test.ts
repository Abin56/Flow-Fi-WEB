import { describe, expect, it } from "vitest";
import { netBalanceDeltas } from "@/lib/engines/payment-correction";
import { installmentStatus, type Installment } from "@/lib/models/payment-schedule";
import { buildEmiPaymentWrites, emiScheduleFigures, planEmiPaymentAllocation, planEmiPaymentReversal } from "./emi-payment-allocation";

function inst(n: number, amountDue = 5000, paid = 0): Installment {
  return {
    id: `i${n}`,
    scheduleId: "sched-emi",
    ownerType: "emi",
    ownerId: "emi-1",
    sequenceNumber: n,
    dueDate: new Date(2026, 8 + n, 5),
    amountDue,
    amountPaid: paid,
    isSkipped: false,
    principalPortion: null,
    interestPortion: null,
    createdAt: new Date(2026, 8, 1),
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
  };
}
const onDue = new Date(2026, 9, 5, 12);

function recorded(base: Installment[], amount: number, key = "orig") {
  const a = planEmiPaymentAllocation({ installments: base, amount, date: onDue });
  if (!a.ok) throw new Error(a.error);
  const writes = buildEmiPaymentWrites({ portions: a.portions, idempotencyKey: key, date: onDue });
  const byId = new Map(writes.installments.map((i) => [i.id, i]));
  return { after: base.map((i) => byId.get(i.id) ?? i), payments: writes.payments };
}

function apply(base: Installment[], changed: Installment[]) {
  const byId = new Map(changed.map((i) => [i.id, i]));
  return base.map((i) => byId.get(i.id) ?? i);
}

describe("Mark an EMI payment as unpaid", () => {
  it("an accidental ₹5,000 on installment 1 goes back to Upcoming with the full amount owed", () => {
    const base = [inst(1), inst(2), inst(3)];
    const orig = recorded(base, 5000);
    expect(installmentStatus(orig.after[0])).toBe("paid");
    const plan = planEmiPaymentReversal({ installments: orig.after, original: orig.payments })!;
    const after = apply(orig.after, plan.installments);
    expect(after.map((i) => i.amountPaid)).toEqual([0, 0, 0]);
    const figures = emiScheduleFigures(after);
    expect(figures.remainingBalance).toBe(15000);
    expect(figures.installmentsPaid).toBe(0);
    expect(figures.nextInstallment?.id).toBe("i1");
    expect(installmentStatus(after[0])).not.toBe("paid");
    expect(after[0].editHistory.at(-1)).toMatchObject({ field: "amountPaid", oldValue: "5000", newValue: "0" });
    expect(plan.installments.map((i) => i.id)).toEqual(["i1"]);
  });

  it("an advance payment across two installments reverts both, and leaves an earlier payment intact", () => {
    const first = recorded([inst(1), inst(2), inst(3), inst(4)], 5000, "first");
    const second = recorded(first.after, 8000, "second"); // #2 5000 + #3 3000
    const plan = planEmiPaymentReversal({ installments: second.after, original: second.payments })!;
    expect(apply(second.after, plan.installments).map((i) => i.amountPaid)).toEqual([5000, 0, 0, 0]);
  });

  it("the card account gets the payment's spend back in full", () => {
    const card = { accountId: "hdfc-card", type: "expense" as const, amount: 5000, excludeFromCalculations: false };
    expect(Object.fromEntries(netBalanceDeltas([card], []))).toEqual({ "hdfc-card": 5000 });
  });

  it("nothing to reverse when the payment is already gone", () => {
    expect(planEmiPaymentReversal({ installments: [inst(1)], original: [] })).toBeNull();
  });
});
