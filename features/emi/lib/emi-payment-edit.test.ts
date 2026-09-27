import { describe, expect, it } from "vitest";
import { netBalanceDeltas } from "@/lib/engines/payment-correction";
import type { Installment, InstallmentPayment } from "@/lib/models/payment-schedule";
import { buildEmiPaymentWrites, emiScheduleFigures, planEmiPaymentAllocation, planEmiPaymentEdit } from "./emi-payment-allocation";

function inst(n: number, amountDue = 5000, opts: { principal?: number; interest?: number; paid?: number } = {}): Installment {
  return {
    id: `i${n}`,
    scheduleId: "sched-emi",
    ownerType: "emi",
    ownerId: "emi-1",
    sequenceNumber: n,
    dueDate: new Date(2026, 8 + n, 5),
    amountDue,
    amountPaid: opts.paid ?? 0,
    isSkipped: false,
    principalPortion: opts.principal ?? null,
    interestPortion: opts.interest ?? null,
    createdAt: new Date(2026, 8, 1),
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
  };
}
/** ₹20,000 phone on EMI, 4 × ₹5,000. */
const schedule = () => [inst(1), inst(2), inst(3), inst(4)];
const onDue = new Date(2026, 9, 5, 12);

/** Record `amount`, return the schedule after it and the payment docs it wrote. */
function recorded(base: Installment[], amount: number, key = "orig") {
  const a = planEmiPaymentAllocation({ installments: base, amount, date: onDue });
  if (!a.ok) throw new Error(a.error);
  const writes = buildEmiPaymentWrites({ portions: a.portions, idempotencyKey: key, date: onDue });
  const byId = new Map(writes.installments.map((i) => [i.id, i]));
  return { after: base.map((i) => byId.get(i.id) ?? i), payments: writes.payments, breakdowns: writes.breakdowns };
}

function corrected(current: Installment[], original: InstallmentPayment[], amount: number) {
  const plan = planEmiPaymentEdit({ installments: current, original, amount, date: onDue, idempotencyKey: "fix" });
  if (!plan.ok) throw new Error(plan.error);
  const byId = new Map(plan.writes.installments.map((i) => [i.id, i]));
  return { plan, after: current.map((i) => byId.get(i.id) ?? i) };
}
const paid = (list: Installment[]) => list.map((i) => i.amountPaid);

describe("editing a recorded EMI payment", () => {
  it("1/3/12/13. ₹8,000 recorded by mistake, corrected to ₹5,000 → #1 paid, #2 untouched, ₹15,000 outstanding", () => {
    const orig = recorded(schedule(), 8000);
    expect(paid(orig.after)).toEqual([5000, 3000, 0, 0]);
    const { plan, after } = corrected(orig.after, orig.payments, 5000);
    expect(paid(after)).toEqual([5000, 0, 0, 0]);
    expect(plan.writes.payments.map((p) => [p.installmentId, p.amount, p.remainingBalanceAfterPayment])).toEqual([["i1", 5000, 0]]);
    expect(emiScheduleFigures(after)).toMatchObject({ remainingBalance: 15000, installmentsPaid: 1, nextInstallment: { id: "i2" } });
  });

  it("2. upward: ₹5,000 corrected to ₹8,000 → ₹3,000 advanced into #2", () => {
    const orig = recorded(schedule(), 5000);
    const { after, plan } = corrected(orig.after, orig.payments, 8000);
    expect(paid(after)).toEqual([5000, 3000, 0, 0]);
    expect(plan.writes.payments.map((p) => p.allocationType)).toEqual(["regularEmi", "advanceEmi"]);
  });

  it("4. partial ₹2,000 corrected to ₹3,500 → ₹1,500 left on #1", () => {
    const orig = recorded(schedule(), 2000);
    const { after } = corrected(orig.after, orig.payments, 3500);
    expect(paid(after)).toEqual([3500, 0, 0, 0]);
    expect(emiScheduleFigures(after).remainingBalance).toBe(16500);
  });

  it("5/12. advance ₹12,000 corrected to ₹8,000 — no stale ₹2,000 left on #3", () => {
    const orig = recorded(schedule(), 12000);
    expect(paid(orig.after)).toEqual([5000, 5000, 2000, 0]);
    const { after, plan } = corrected(orig.after, orig.payments, 8000);
    expect(paid(after)).toEqual([5000, 3000, 0, 0]);
    // Every installment the original touched is written once with its final value (#3 back to 0); #1 is
    // reversed then re-applied, so its audit trail shows both steps.
    expect(plan.writes.installments.map((i) => [i.id, i.amountPaid]).sort()).toEqual([
      ["i1", 5000],
      ["i2", 3000],
      ["i3", 0],
    ]);
    expect(plan.writes.installments[0].editHistory.map((e) => `${e.oldValue}→${e.newValue}`)).toEqual(["0→5000", "5000→0", "0→5000"]);
  });

  it("matches recording the corrected amount in the first place, for any pair", () => {
    for (const [from, to] of [[8000, 5000], [5000, 12000], [12000, 2000], [20000, 7500]]) {
      const orig = recorded(schedule(), from);
      const { after } = corrected(orig.after, orig.payments, to);
      expect(paid(after)).toEqual(paid(recorded(schedule(), to).after));
    }
  });

  it("an edit on top of an earlier payment keeps that earlier payment intact", () => {
    const first = recorded(schedule(), 5000, "first");
    const second = recorded(first.after, 8000, "second"); // #2 5000 + #3 3000
    const { after } = corrected(second.after, second.payments, 6000);
    expect(paid(after)).toEqual([5000, 5000, 1000, 0]);
  });

  it("6/9. interest-bearing, card-linked: principal restored to the card follows the correction", () => {
    const base = () => [inst(1, 5000, { principal: 4000, interest: 1000 }), inst(2, 5000, { principal: 4100, interest: 900 }), inst(3, 5000, { principal: 4200, interest: 800 })];
    const orig = recorded(base(), 8000);
    expect(orig.breakdowns.reduce((s, b) => s + b.principalPaid, 0)).toBe(6460);
    const { plan } = corrected(orig.after, orig.payments, 5000);
    // Card credit is derived from ACTIVE payments' breakdowns: the originals are soft-deleted, only these count.
    expect(plan.writes.breakdowns.map((b) => [b.principalPaid, b.interestPaid])).toEqual([[4000, 1000]]);

    // The card account moves by the difference only: ₹8,000 spend replaced by ₹5,000 → +₹3,000.
    const card = (amount: number) => ({ accountId: "hdfc-card", type: "expense" as const, amount, excludeFromCalculations: false });
    expect(Object.fromEntries(netBalanceDeltas([card(8000)], [card(5000)]))).toEqual({ "hdfc-card": 3000 });
  });

  it("7. final payment: ₹2,000 on a ₹2,500 last installment corrected to ₹2,500 settles it; more is refused", () => {
    const base = [inst(1, 5000, { paid: 5000 }), inst(2, 5000, { paid: 5000 }), inst(3, 5000, { paid: 5000 }), inst(4, 2500)];
    const orig = recorded(base, 2000);
    const { after } = corrected(orig.after, orig.payments, 2500);
    expect(emiScheduleFigures(after)).toEqual({ remainingBalance: 0, nextInstallment: null, installmentsPaid: 4 });
    const tooMuch = planEmiPaymentEdit({ installments: orig.after, original: orig.payments, amount: 3000, date: onDue, idempotencyKey: "x" });
    expect(tooMuch.ok).toBe(false);
    expect(!tooMuch.ok && tooMuch.error).toMatch(/₹2,500/);
  });

  it("refuses when the original is already gone (edited elsewhere)", () => {
    expect(planEmiPaymentEdit({ installments: schedule(), original: [], amount: 5000, date: onDue, idempotencyKey: "x" }).ok).toBe(false);
  });

  it("10. an EMI taken for a Person writes only schedule documents — no People entry to go stale", () => {
    const orig = recorded(schedule(), 8000);
    const { plan } = corrected(orig.after, orig.payments, 5000);
    expect(Object.keys(plan.writes).sort()).toEqual(["breakdowns", "installments", "payments"]);
  });
});
