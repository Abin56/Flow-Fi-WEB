import { describe, expect, it } from "vitest";
import { planInstallmentSettlement } from "@/lib/engines/installment-settlement";
import { outstandingPrincipalFor } from "@/lib/engines/loan-outstanding";
import { personPosition } from "@/lib/engines/person-position";
import { emiStatusGiven, type Emi } from "@/lib/models/emi";
import { installmentStatus, type Installment } from "@/lib/models/payment-schedule";
import {
  buildEmiPaymentWrites,
  emiPaymentId,
  emiScheduleFigures,
  emiTotalRemaining,
  planEmiPaymentAllocation,
  type EmiPaymentAllocation,
} from "./emi-payment-allocation";

function inst(
  sequenceNumber: number,
  amountDue: number,
  opts: { amountPaid?: number; principal?: number; interest?: number; due?: string } = {},
): Installment {
  return {
    id: `i${sequenceNumber}`,
    scheduleId: "sched-emi",
    ownerType: "emi",
    ownerId: "emi-1",
    sequenceNumber,
    dueDate: new Date(opts.due ?? `2026-${String(9 + sequenceNumber).padStart(2, "0")}-05T00:00:00`),
    amountDue,
    amountPaid: opts.amountPaid ?? 0,
    isSkipped: false,
    principalPortion: opts.principal ?? null,
    interestPortion: opts.interest ?? null,
    createdAt: new Date("2026-09-01T00:00:00"),
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
  };
}

/** ₹20,000 phone EMI, 4 × ₹5,000, no interest — #1 due 5 Oct 2026. */
const schedule = () => [inst(1, 5000), inst(2, 5000), inst(3, 5000), inst(4, 5000)];
const onDueDate = new Date("2026-10-05T12:00:00");

type Ok = Extract<EmiPaymentAllocation, { ok: true }>;
function plan(installments: Installment[], amount: number, targetInstallmentId?: string): Ok {
  const result = planEmiPaymentAllocation({ installments, amount, date: onDueDate, targetInstallmentId });
  if (!result.ok) throw new Error(result.error);
  return result;
}

/** What the live listener delivers after the write: the schedule with the written installments swapped in. */
function afterWrite(installments: Installment[], allocation: Ok, key = "k1"): Installment[] {
  const writes = buildEmiPaymentWrites({ portions: allocation.portions, idempotencyKey: key, date: onDueDate });
  const byId = new Map(writes.installments.map((i) => [i.id, i]));
  return installments.map((i) => byId.get(i.id) ?? i);
}

describe("EMI payment allocation", () => {
  it("1. exact ₹5,000 payment settles installment #1 only", () => {
    const before = schedule();
    const a = plan(before, 5000);
    expect(a.portions.map((p) => [p.installment.sequenceNumber, p.amount, p.remainingAfter, p.allocationType])).toEqual([[1, 5000, 0, "regularEmi"]]);
    expect(a.remainingBefore).toBe(20000);
    expect(a.remainingAfter).toBe(15000);
    expect(a.nextAfter?.installment.sequenceNumber).toBe(2);
    expect(a.nextAfter?.remaining).toBe(5000);

    const after = afterWrite(before, a);
    expect(after.map((i) => i.amountPaid)).toEqual([5000, 0, 0, 0]);
    expect(installmentStatus(after[0], onDueDate)).toBe("paid");
  });

  it("2. partial ₹2,000 keeps ₹3,000 on the same installment and continues from it — never duplicated", () => {
    const before = schedule();
    const a = plan(before, 2000);
    expect(a.portions.map((p) => [p.installment.sequenceNumber, p.amount, p.remainingAfter])).toEqual([[1, 2000, 3000]]);
    expect(a.remainingAfter).toBe(18000);
    expect(a.nextAfter).toMatchObject({ installment: { id: "i1" }, remaining: 3000 });

    const after = afterWrite(before, a);
    expect(after).toHaveLength(4);
    expect(installmentStatus(after[0], onDueDate)).toBe("partiallyPaid");

    // The next payment continues from the ₹3,000 still owed on #1.
    const next = plan(after, 5000);
    expect(next.portions.map((p) => [p.installment.sequenceNumber, p.amount])).toEqual([[1, 3000], [2, 2000]]);
    expect(next.remainingAfter).toBe(13000);
  });

  it("3. ₹8,000 on a ₹5,000 EMI: #1 fully paid, ₹3,000 advanced to #2 — nothing lost, nothing counted twice", () => {
    const before = schedule();
    const a = plan(before, 8000);
    expect(a.portions.map((p) => [p.installment.sequenceNumber, p.amount, p.remainingAfter, p.allocationType])).toEqual([
      [1, 5000, 0, "regularEmi"],
      [2, 3000, 2000, "advanceEmi"],
    ]);
    expect(a.applied).toBe(8000);
    expect(a.remainingAfter).toBe(12000);
    expect(a.nextAfter).toMatchObject({ installment: { id: "i2" }, remaining: 2000 });

    const after = afterWrite(before, a);
    expect(after.map((i) => i.amountPaid)).toEqual([5000, 3000, 0, 0]);
    expect(after.map((i) => installmentStatus(i, onDueDate))).toEqual(["paid", "partiallyPaid", "upcoming", "upcoming"]);
  });

  it("4. ₹12,000 covers #1 and #2 and ₹2,000 of #3", () => {
    const before = schedule();
    const a = plan(before, 12000);
    expect(a.portions.map((p) => [p.installment.sequenceNumber, p.amount, p.remainingAfter])).toEqual([
      [1, 5000, 0],
      [2, 5000, 0],
      [3, 2000, 3000],
    ]);
    expect(a.remainingAfter).toBe(8000);
    expect(a.nextAfter).toMatchObject({ installment: { id: "i3" }, remaining: 3000 });
    const after = afterWrite(before, a);
    expect(emiTotalRemaining(after)).toBe(8000);
    expect(after.map((i) => installmentStatus(i, onDueDate))).toEqual(["paid", "paid", "partiallyPaid", "upcoming"]);
  });

  it("fills the installment picked from the schedule first", () => {
    const a = plan(schedule(), 6000, "i3");
    expect(a.portions.map((p) => [p.installment.sequenceNumber, p.amount])).toEqual([[3, 5000], [1, 1000]]);
  });

  it("5. interest-bearing EMI: each portion splits by its own installment's principal/interest ratio", () => {
    // ₹5,000 EMIs on a reducing-balance plan: principal share grows each month.
    const before = [
      inst(1, 5000, { principal: 4000, interest: 1000 }),
      inst(2, 5000, { principal: 4100, interest: 900 }),
      inst(3, 5000, { principal: 4200, interest: 800 }),
    ];
    const a = plan(before, 8000);
    expect(a.portions.map((p) => [p.installment.sequenceNumber, p.amount, p.principalPaid, p.interestPaid])).toEqual([
      [1, 5000, 4000, 1000],
      [2, 3000, 2460, 540],
    ]);
    // Never the whole payment as principal: ₹6,460 principal, ₹1,540 interest.
    expect(a.portions.reduce((s, p) => s + p.principalPaid, 0)).toBe(6460);
    expect(a.portions.reduce((s, p) => s + p.interestPaid, 0)).toBe(1540);
    // Outstanding follows the schedule (principal + scheduled interest), same as every EMI screen.
    expect(a.remainingAfter).toBe(7000);
  });

  it("6/7. final payment settles only what remains; more than that is refused — never negative, no phantom installment", () => {
    // ₹17,500 at ₹5,000/month: last installment ₹2,500, first three already paid.
    const before = [inst(1, 5000, { amountPaid: 5000 }), inst(2, 5000, { amountPaid: 5000 }), inst(3, 5000, { amountPaid: 5000 }), inst(4, 2500)];
    const tooMuch = planEmiPaymentAllocation({ installments: before, amount: 5000, date: onDueDate });
    expect(tooMuch.ok).toBe(false);
    expect(!tooMuch.ok && tooMuch.error).toMatch(/₹2,500/);

    const a = plan(before, 2500);
    expect(a.portions.map((p) => [p.installment.sequenceNumber, p.amount, p.remainingAfter])).toEqual([[4, 2500, 0]]);
    expect(a.remainingAfter).toBe(0);
    expect(a.nextAfter).toBeNull();

    const after = afterWrite(before, a);
    expect(after).toHaveLength(4);
    expect(after.every((i) => i.amountPaid <= i.amountDue)).toBe(true);
    expect(emiScheduleFigures(after)).toEqual({ remainingBalance: 0, nextInstallment: null, installmentsPaid: 4 });
    expect(emiStatusGiven({ isClosed: false, isDefaulted: false } as Emi, after)).toBe("completed");
    // Nothing left to pay at all.
    expect(planEmiPaymentAllocation({ installments: after, amount: 1, date: onDueDate }).ok).toBe(false);
  });

  it("7. paying the whole ₹20,000 at once lands on exactly zero", () => {
    const a = plan(schedule(), 20000);
    expect(a.portions).toHaveLength(4);
    expect(a.remainingAfter).toBe(0);
    expect(planEmiPaymentAllocation({ installments: schedule(), amount: 20000.01, date: onDueDate }).ok).toBe(false);
  });

  it("rejects zero, negative and non-numeric amounts", () => {
    for (const amount of [0, -500, Number.NaN]) expect(planEmiPaymentAllocation({ installments: schedule(), amount, date: onDueDate }).ok).toBe(false);
  });
});

describe("EMI payment writes", () => {
  it("10. one payment per installment touched, each for exactly its portion — history sums to the ₹8,000 paid", () => {
    const a = plan(schedule(), 8000);
    const writes = buildEmiPaymentWrites({ portions: a.portions, idempotencyKey: "pay-1", date: onDueDate, charges: { gst: 90, processingFee: 199 } });
    expect(writes.payments.map((p) => [p.id, p.installmentId, p.amount, p.remainingBalanceAfterPayment, p.allocationType])).toEqual([
      [emiPaymentId("pay-1", 0), "i1", 5000, 0, "regularEmi"],
      [emiPaymentId("pay-1", 1), "i2", 3000, 2000, "advanceEmi"],
    ]);
    expect(writes.payments.reduce((s, p) => s + p.amount, 0)).toBe(8000);
    // Breakdowns are 1:1 with payments; principal+interest per breakdown equals its payment; charges once.
    expect(writes.breakdowns.map((b) => b.paymentId)).toEqual(writes.payments.map((p) => p.id));
    writes.breakdowns.forEach((b, i) => expect(b.principalPaid + b.interestPaid).toBe(writes.payments[i].amount));
    expect(writes.breakdowns.map((b) => [b.gst, b.processingFee])).toEqual([[90, 199], [0, 0]]);
    // Audit trail on each installment it changed.
    expect(writes.installments.map((i) => i.editHistory.at(-1))).toMatchObject([
      { field: "amountPaid", oldValue: "0", newValue: "5000" },
      { field: "amountPaid", oldValue: "0", newValue: "3000" },
    ]);
  });

  it("uses the bank's own principal/interest only when the payment lands on one installment", () => {
    const one = plan([inst(1, 5000, { principal: 4000, interest: 1000 }), inst(2, 5000)], 5000);
    const w1 = buildEmiPaymentWrites({ portions: one.portions, idempotencyKey: "k", date: onDueDate, principalPaid: 4100, interestPaid: 900 });
    expect([w1.breakdowns[0].principalPaid, w1.breakdowns[0].interestPaid]).toEqual([4100, 900]);

    const two = plan([inst(1, 5000, { principal: 4000, interest: 1000 }), inst(2, 5000)], 6000);
    const w2 = buildEmiPaymentWrites({ portions: two.portions, idempotencyKey: "k", date: onDueDate, principalPaid: 4100, interestPaid: 900 });
    expect(w2.breakdowns.map((b) => [b.principalPaid, b.interestPaid])).toEqual([[4000, 1000], [1000, 0]]);
  });

  it("the retry sentinel id doesn't depend on which installment is paid", () => {
    expect(emiPaymentId("same-key", 0)).toBe("emi_same-key_p0");
  });

  it("14. the live figures read straight off the written schedule — Outstanding, Next due, Paid, Status", () => {
    const before = schedule();
    expect(emiScheduleFigures(before)).toMatchObject({ remainingBalance: 20000, installmentsPaid: 0, nextInstallment: { id: "i1" } });
    const after = afterWrite(before, plan(before, 8000));
    const figures = emiScheduleFigures(after);
    expect(figures.remainingBalance).toBe(12000);
    expect(figures.installmentsPaid).toBe(1);
    expect(figures.nextInstallment?.id).toBe("i2");
    expect(figures.nextInstallment!.amountDue - figures.nextInstallment!.amountPaid).toBe(2000);
    expect(after.reduce((s, i) => s + i.amountPaid, 0)).toBe(8000);
    expect(emiStatusGiven({ isClosed: false, isDefaulted: false } as Emi, after)).toBe("active");
  });
});

describe("People link", () => {
  it("8/9. an EMI taken for a Person stays my liability — paying it writes no People ledger entry and leaves their position unchanged", () => {
    const before = schedule();
    const writes = buildEmiPaymentWrites({ portions: plan(before, 8000).portions, idempotencyKey: "k", date: onDueDate });
    // Only schedule documents are written — nothing that could land in a Person's ledger.
    expect(Object.keys(writes).sort()).toEqual(["breakdowns", "installments", "payments"]);

    const position = () =>
      personPosition({ personId: "person-riya", currentBalance: 0, loans: [], ledgerEntries: [], loanIds: new Set() });
    expect(position()).toMatchObject({ net: 0, owesMe: 0, iOwe: 0 });
  });

  it("8/9/10. a ₹20,000 EMI loan from a Person: an ₹8,000 payment moves their People amount to exactly ₹12,000 — counted once", () => {
    const loanInstallments = [1, 2, 3, 4].map((n) => ({ ...inst(n, 5000), ownerType: "loan" as const, ownerId: "loan-riya" }));
    const settlement = planInstallmentSettlement(loanInstallments, 8000);
    const paid = loanInstallments.map((i) => {
      const portion = settlement.portions.find((p) => p.installment.id === i.id)?.portion ?? 0;
      return { ...i, amountPaid: i.amountPaid + portion };
    });
    const outstanding = outstandingPrincipalFor(20000, paid);
    expect(outstanding).toBe(12000);

    // The Loan payment posts no ledger entry (see `useLoanActions().recordPayment`): the People amount
    // is derived from the Loan's live outstanding principal only.
    const pos = personPosition({
      personId: "person-riya",
      currentBalance: 0,
      loans: [{ id: "loan-riya", personId: "person-riya", direction: "taken", outstandingPrincipal: outstanding, isDeleted: false }],
      ledgerEntries: [],
      loanIds: new Set(["loan-riya"]),
    });
    expect(pos).toMatchObject({ loanPayable: 12000, iOwe: 12000, directBalance: 0 });

    // Even a legacy Loan-generated "repaid" ledger entry for the same payment is taken back out — never twice.
    const withLegacy = personPosition({
      personId: "person-riya",
      currentBalance: 8000,
      loans: [{ id: "loan-riya", personId: "person-riya", direction: "taken", outstandingPrincipal: outstanding, isDeleted: false }],
      ledgerEntries: [{ transactionRef: "loan-riya", signedAmount: 8000, isDeleted: false }],
      loanIds: new Set(["loan-riya"]),
    });
    expect(withLegacy.iOwe).toBe(12000);
  });
});
