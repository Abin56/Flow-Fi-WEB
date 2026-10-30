import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {} }));

import type { Emi } from "@/lib/models/emi";
import type { Installment } from "@/lib/models/payment-schedule";
import { currentEmiTerms, emiTermsEditBlocker, planEmiTermsEdit, scheduleFingerprint, type EmiTermsInput } from "./emi-terms-plan";

const START = new Date(2026, 0, 10);

function emi(over: Partial<Emi> = {}): Emi {
  return {
    id: "e1", scheduleId: "s1", name: "Phone", principalAmount: 24000, startDate: START, installmentFrequency: "monthly",
    installmentCount: 6, dueDayOfMonth: null, interest: null, isClosed: false, ownershipShares: null, beneficiaryRepaysInstallments: false,
    ...over,
  } as Emi;
}

/** 6 × ₹4,000 interest-free, due monthly from 10 Jan; `paid` first installments fully paid. */
function sched(paid: number, partial?: { seq: number; paid: number }): Installment[] {
  return Array.from({ length: 6 }, (_, k) => {
    const seq = k + 1;
    const amountPaid = partial?.seq === seq ? partial.paid : seq <= paid ? 4000 : 0;
    return {
      id: `i${seq}`, scheduleId: "s1", ownerType: "emi", ownerId: "e1", sequenceNumber: seq, dueDate: new Date(2026, k, 10),
      amountDue: 4000, amountPaid, isSkipped: false, principalPortion: null, interestPortion: null, createdAt: START, deletedAt: null, lastEditedAt: null, editHistory: [],
    } as Installment;
  });
}

const same = (e: Emi, i: Installment[]): EmiTermsInput => currentEmiTerms(e, i);
const sum = (xs: { amountDue: number }[]) => xs.reduce((a, x) => a + x.amountDue, 0);

describe("planEmiTermsEdit", () => {
  it("reports unchanged terms as unchanged, with the schedule untouched", () => {
    const e = emi();
    const i = sched(1);
    const plan = planEmiTermsEdit(e, i, same(e, i));
    expect(plan.unchanged).toBe(true);
    expect(plan.errors).toEqual([]);
    expect(plan.before.remainingPayable).toBe(20000);
    expect(plan.after.remainingPayable).toBe(20000);
    expect(plan.outstandingPrincipal).toBe(20000);
  });

  it("a longer tenure re-spreads only the unpaid principal; settled installments are kept", () => {
    const e = emi();
    const i = sched(1);
    const plan = planEmiTermsEdit(e, i, { ...same(e, i), installmentCount: 9 });
    expect(plan.settledCount).toBe(1);
    expect(plan.newTail).toHaveLength(8);
    expect(sum(plan.newTail)).toBeCloseTo(20000, 2);
    expect(plan.newTail[0]!.sequenceNumber).toBe(2);
    expect(plan.effectiveFrom).toMatchObject({ sequenceNumber: 2 });
    expect(plan.after.installmentCount).toBe(9);
    expect(plan.after.emiAmount).toBeCloseTo(2500, 2);
    expect(plan.outstandingPrincipal).toBe(20000);
    expect(plan.unchanged).toBe(false);
  });

  it("adding interest raises what is still payable but never the outstanding principal", () => {
    const e = emi();
    const i = sched(1);
    const plan = planEmiTermsEdit(e, i, { ...same(e, i), ratePercent: 12 });
    expect(plan.interest).toEqual({ type: "reducingBalance", ratePercent: 12, period: "yearly" });
    expect(plan.outstandingPrincipal).toBe(20000);
    expect(plan.after.remainingPayable).toBeGreaterThan(20000);
    expect(plan.after.remainingInterest).toBeGreaterThan(0);
    expect(plan.newTail.reduce((a, x) => a + (x.principalPortion ?? 0), 0)).toBeCloseTo(20000, 1);
    expect(plan.before.remainingInterest).toBe(0);
  });

  it("removing interest on an interest-bearing EMI splits the unpaid principal evenly", () => {
    const e = emi({ interest: { type: "reducingBalance", ratePercent: 12, period: "yearly" } });
    const i = sched(1).map((x) => ({ ...x, principalPortion: 3000, interestPortion: 1000 }));
    const plan = planEmiTermsEdit(e, i, { ...same(e, i), ratePercent: null });
    expect(plan.interest).toBeNull();
    expect(plan.outstandingPrincipal).toBe(21000);
    expect(sum(plan.newTail)).toBeCloseTo(21000, 2);
    expect(plan.after.remainingInterest).toBe(0);
  });

  it("a part-paid installment stays settled, with its principal prorated", () => {
    const e = emi();
    const i = sched(0, { seq: 1, paid: 1000 });
    const plan = planEmiTermsEdit(e, i, { ...same(e, i), installmentCount: 7 });
    expect(plan.settledCount).toBe(1);
    expect(plan.principalPaid).toBe(1000);
    expect(plan.outstandingPrincipal).toBe(23000);
    expect(sum(plan.newTail)).toBeCloseTo(23000, 2);
    expect(plan.after.remainingPayable).toBeCloseTo(3000 + 23000, 2); // the part-paid remainder still has to be paid
  });

  it("refuses fewer installments than are already settled, and a count that leaves principal unscheduled", () => {
    const e = emi();
    const i = sched(3);
    expect(planEmiTermsEdit(e, i, { ...same(e, i), installmentCount: 2 }).errors[0]).toMatch(/At least 3/);
    const exact = planEmiTermsEdit(e, i, { ...same(e, i), installmentCount: 3 });
    expect(exact.errors[0]).toMatch(/still owed/);
    expect(exact.newTail).toEqual(exact.currentTail); // a refused plan shows nothing as changed
  });

  it("validates rate, count and due day", () => {
    const e = emi();
    const i = sched(0);
    expect(planEmiTermsEdit(e, i, { ...same(e, i), ratePercent: -1 }).errors.join()).toMatch(/negative/);
    expect(planEmiTermsEdit(e, i, { ...same(e, i), ratePercent: 150 }).errors.join()).toMatch(/100%/);
    expect(planEmiTermsEdit(e, i, { ...same(e, i), installmentCount: NaN }).errors.join()).toMatch(/whole number/);
    expect(planEmiTermsEdit(e, i, { ...same(e, i), installmentCount: 2.5 }).errors.join()).toMatch(/whole number/);
    expect(planEmiTermsEdit(e, i, { ...same(e, i), dueDayOfMonth: 40 }).errors.join()).toMatch(/between 1 and 31/);
  });

  it("a monthly due day pins every unpaid installment after the settled ones", () => {
    const e = emi();
    const i = sched(1);
    const plan = planEmiTermsEdit(e, i, { ...same(e, i), dueDayOfMonth: 28 });
    expect(plan.newTail.every((x) => x.dueDate.getDate() === 28)).toBe(true);
    expect(plan.effectiveFrom!.dueDate.getMonth()).toBe(1); // February, the month after the settled #1
  });

  it("weekly frequency spaces the tail a week apart", () => {
    const e = emi();
    const i = sched(1);
    const plan = planEmiTermsEdit(e, i, { ...same(e, i), frequency: "weekly" });
    const gaps = plan.newTail.slice(1).map((x, k) => (x.dueDate.getTime() - plan.newTail[k]!.dueDate.getTime()) / 86400000);
    expect(gaps.every((g) => g === 7)).toBe(true);
  });

  it("nothing settled: the first due date stays the EMI's start date for every kind of edit", () => {
    const e = emi();
    const i = sched(0);
    for (const change of [{ installmentCount: 9 }, { ratePercent: 12 }, { frequency: "weekly" as const }, { dueDayOfMonth: 25 }]) {
      const plan = planEmiTermsEdit(e, i, { ...same(e, i), ...change });
      expect(plan.errors).toEqual([]);
      expect(plan.newTail[0]!.dueDate.getTime()).toBe(START.getTime());
      expect(plan.newTail[0]!.sequenceNumber).toBe(1);
    }
    const dueDay = planEmiTermsEdit(e, i, { ...same(e, i), dueDayOfMonth: 25 });
    expect(dueDay.newTail.slice(1).every((x) => x.dueDate.getDate() === 25)).toBe(true);
  });

  it("refuses a count that leaves outstanding principal unscheduled", () => {
    const e = emi();
    const i = sched(2);
    const plan = planEmiTermsEdit(e, i, { ...same(e, i), installmentCount: 2 });
    expect(plan.errors.join(" ")).toMatch(/still owed/);
  });

  it("never mutates its inputs", () => {
    const e = emi();
    const i = sched(1);
    const frozen = JSON.stringify([e, i]);
    planEmiTermsEdit(e, i, { ...same(e, i), installmentCount: 9, ratePercent: 10 });
    expect(JSON.stringify([e, i])).toBe(frozen);
  });
});

describe("scheduleFingerprint", () => {
  it("is identical for the same schedule in any order, ignoring retired installments", () => {
    const i = sched(1);
    const retired = { ...i[5]!, id: "gone", deletedAt: new Date() };
    expect(scheduleFingerprint([...i].reverse())).toBe(scheduleFingerprint([...i, retired]));
  });
  it("changes when a payment lands, is edited or an installment is skipped — so a stale save is detected", () => {
    const base = sched(1);
    const fp = scheduleFingerprint(base);
    expect(scheduleFingerprint(sched(2))).not.toBe(fp); // another tab paid #2
    expect(scheduleFingerprint(sched(1, { seq: 2, paid: 100 }))).not.toBe(fp); // a part-payment
    expect(scheduleFingerprint(base.map((x, k) => (k === 3 ? { ...x, isSkipped: true } : x)))).not.toBe(fp);
  });
});

describe("emiTermsEditBlocker", () => {
  it("allows an ordinary EMI", () => expect(emiTermsEditBlocker(emi(), sched(1))).toBeNull());
  it("blocks a closed EMI", () => expect(emiTermsEditBlocker(emi({ isClosed: true }), sched(1))).toMatch(/closed/));
  it("blocks a shared EMI and explains why", () => {
    expect(emiTermsEditBlocker(emi({ ownershipShares: [{ personId: null, amount: 12000 }, { personId: "p", amount: 12000 }] as Emi["ownershipShares"] }), sched(1))).toMatch(/shared/);
    expect(emiTermsEditBlocker(emi({ beneficiaryRepaysInstallments: true }), sched(1))).toMatch(/shared/);
  });
  it("allows an EMI with nothing settled yet — the schedule keeps its first due date", () => {
    expect(emiTermsEditBlocker(emi(), sched(0))).toBeNull();
    expect(emiTermsEditBlocker(emi(), sched(0, { seq: 1, paid: 500 }))).toBeNull();
  });
  it("blocks when every installment is already settled", () => expect(emiTermsEditBlocker(emi(), sched(6))).toMatch(/nothing left/));
});
