/**
 * Permanent regression for Loan / EMI advance payments — the bug class where money above the due
 * installment disappeared into rounded installment counts. Every figure is read from the canonical
 * engines (`planLoanPaymentCore`, `planEmiPaymentAllocation`, `reversePaymentPortions`,
 * `outstandingPrincipal*`, `personEmiObligations` + `allocatePayment`); nothing is re-derived here.
 */

import { describe, expect, it } from "vitest";
import { planEmiPaymentAllocation, planEmiPaymentEdit, planEmiPaymentReversal, buildEmiPaymentWrites } from "@/features/emi/lib/emi-payment-allocation";
import { calculate, totalPayable } from "@/lib/engines/interest-calculator";
import { installmentProgress } from "@/lib/engines/installment-progress";
import { planLoanPaymentCore, type LoanPaymentCore } from "@/lib/engines/loan-payment-core";
import { outstandingPrincipalAfterPrepaymentsFor, outstandingPrincipalFor, principalPaidFor } from "@/lib/engines/loan-outstanding";
import { mergeInstallmentWrites, reversePaymentPortions } from "@/lib/engines/payment-correction";
import { allocatePayment, type PaymentObligation } from "@/lib/engines/person-payment";
import { personEmiObligations } from "@/lib/engines/person-emi-obligations";
import type { OwnershipShare } from "@/lib/engines/debt-ownership";
import type { Loan } from "@/lib/models/loan";
import type { Installment } from "@/lib/models/payment-schedule";

const round2 = (v: number) => Math.round(v * 100) / 100;
const sum = (xs: number[]) => round2(xs.reduce((s, x) => s + x, 0));

function inst(n: number, amountDue = 1000, opts: { principal?: number | null; interest?: number | null; owner?: "loan" | "emi" } = {}): Installment {
  return {
    id: `i${n}`,
    scheduleId: "sched",
    ownerType: opts.owner ?? "loan",
    ownerId: "agreement-1",
    sequenceNumber: n,
    dueDate: new Date(2026, 9 + n - 1, 5),
    amountDue,
    amountPaid: 0,
    isSkipped: false,
    principalPortion: opts.principal ?? null,
    interestPortion: opts.interest ?? null,
    createdAt: new Date(2026, 8, 1),
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
  };
}
/** ₹10,000, no interest, 10 × ₹1,000 monthly from 5 Oct 2026. */
const tenByThousand = (owner: "loan" | "emi" = "loan") => Array.from({ length: 10 }, (_, k) => inst(k + 1, 1000, { owner }));
const onFirstDue = new Date(2026, 9, 5, 12);

const loan = { id: "agreement-1", name: "Family loan", loanAmount: 10000, direction: "taken", repaymentType: "installment", scheduleId: "sched", category: "personal" } as Loan;

function recordLoan(installments: Installment[], amount: number, opts: { upcoming?: boolean; key?: string } = {}): LoanPaymentCore {
  return planLoanPaymentCore({
    loan,
    fresh: installments,
    lastInstallmentId: installments[installments.length - 1].id,
    accountId: "hdfc",
    amount,
    date: onFirstDue,
    idempotencyKey: opts.key ?? "k1",
    includeUpcomingInstallments: opts.upcoming,
  });
}
const apply = (installments: Installment[], writes: Installment[]) => {
  const byId = new Map(writes.map((i) => [i.id, i]));
  return installments.map((i) => byId.get(i.id) ?? i);
};
const paid = (list: Installment[]) => list.map((i) => i.amountPaid);

describe("₹10,000 / ₹1,000 EMI — ₹6,500 advance (no interest)", () => {
  it("Loan, apply to upcoming installments: 6 paid + ₹500 partial, ₹3,500 remaining, one payment event", () => {
    const core = recordLoan(tenByThousand(), 6500, { upcoming: true });
    const after = apply(tenByThousand(), core.installments);
    expect(paid(after)).toEqual([1000, 1000, 1000, 1000, 1000, 1000, 500, 0, 0, 0]);
    expect(core.overflow).toBe(0);
    expect(sum(core.payments.map((p) => p.amount))).toBe(6500);
    // One real payment event: a single Transaction for the whole amount; per-installment portions are its allocation.
    expect(core.transaction.amount).toBe(6500);
    expect(new Set(core.payments.map((p) => p.transactionId))).toEqual(new Set([core.transactionId]));
    expect(core.payments.map((p) => p.allocationType)).toEqual(["regularEmi", ...Array(6).fill("advanceEmi")]);
    expect(outstandingPrincipalFor(10000, after)).toBe(3500);

    const progress = installmentProgress(after);
    expect(progress).toMatchObject({ paid: 6, partial: 1, unpaid: 3, paidTotal: 6500, remainingTotal: 3500, percentPaid: 65 });
    expect(progress.next).toMatchObject({ installment: { id: "i7" }, original: 1000, covered: 500, stillDue: 500 });
  });

  it("Loan, reduce principal (default): #1 settled, ₹5,500 principal prepayment — same ₹3,500 remaining", () => {
    const core = recordLoan(tenByThousand(), 6500);
    const after = apply(tenByThousand(), core.installments);
    expect(paid(after)[0]).toBe(1000);
    expect(core.overflow).toBe(5500);
    expect(core.overflowPayment).toMatchObject({ allocationType: "principalPrepayment", prepaymentPrincipalAmount: 5500 });
    expect(core.transaction.amount).toBe(6500);
    expect(outstandingPrincipalAfterPrepaymentsFor(10000, after, core.overflow)).toBe(3500);
  });

  it("paying the remaining ₹500 finishes #7 — no duplicate installment, #8 is next at a full ₹1,000", () => {
    const first = apply(tenByThousand(), recordLoan(tenByThousand(), 6500, { upcoming: true }).installments);
    const second = recordLoan(first, 500, { key: "k2" });
    expect(second.payments.map((p) => [p.installmentId, p.amount])).toEqual([["i7", 500]]);
    const after = apply(first, second.installments);
    expect(installmentProgress(after)).toMatchObject({ paid: 7, partial: 0, unpaid: 3, remainingTotal: 3000, next: { installment: { id: "i8" }, covered: 0, stillDue: 1000 } });
  });

  it("edit ₹6,500 → ₹5,500 recomputes from history: #6 back to ₹500 partial, #7 reopened, remaining +₹1,000", () => {
    const original = recordLoan(tenByThousand(), 6500, { upcoming: true });
    const current = apply(tenByThousand(), original.installments);
    const reversed = reversePaymentPortions(current, original.payments);
    const corrected = recordLoan(reversed, 5500, { upcoming: true, key: "k2" });
    const after = apply(current, mergeInstallmentWrites(current, reversed, corrected.installments));
    expect(paid(after)).toEqual([1000, 1000, 1000, 1000, 1000, 500, 0, 0, 0, 0]);
    expect(installmentProgress(after)).toMatchObject({ paid: 5, partial: 1, remainingTotal: 4500, next: { installment: { id: "i6" }, stillDue: 500 } });
  });

  it("revert restores every installment exactly — no ghost payment, no negative paid amounts", () => {
    const original = recordLoan(tenByThousand(), 6500, { upcoming: true });
    const current = apply(tenByThousand(), original.installments);
    const after = apply(current, mergeInstallmentWrites(current, reversePaymentPortions(current, original.payments)));
    expect(paid(after)).toEqual(Array(10).fill(0));
    expect(installmentProgress(after)).toMatchObject({ paid: 0, partial: 0, remainingTotal: 10000 });
  });

  it("EMI: same allocation, edit and reversal through the EMI allocator", () => {
    const base = tenByThousand("emi");
    const a = planEmiPaymentAllocation({ installments: base, amount: 6500, date: onFirstDue });
    if (!a.ok) throw new Error(a.error);
    expect(a.portions.map((p) => p.amount)).toEqual([1000, 1000, 1000, 1000, 1000, 1000, 500]);
    expect(a).toMatchObject({ applied: 6500, remainingBefore: 10000, remainingAfter: 3500, nextAfter: { installment: { id: "i7" }, remaining: 500 } });
    const writes = buildEmiPaymentWrites({ portions: a.portions, idempotencyKey: "e1", date: onFirstDue });
    const after = apply(base, writes.installments);

    const edit = planEmiPaymentEdit({ installments: after, original: writes.payments, amount: 5500, date: onFirstDue, idempotencyKey: "e2" });
    if (!edit.ok) throw new Error(edit.error);
    expect(installmentProgress(apply(after, edit.writes.installments))).toMatchObject({ paid: 5, partial: 1, remainingTotal: 4500 });

    const reversal = planEmiPaymentReversal({ installments: after, original: writes.payments });
    expect(paid(apply(after, reversal!.installments))).toEqual(Array(10).fill(0));
  });
});

describe("₹6,005 — a non-round remainder is never lost", () => {
  it("Loan: 6 paid, ₹5 on #7, ₹3,995 remaining", () => {
    const core = recordLoan(tenByThousand(), 6005, { upcoming: true });
    const after = apply(tenByThousand(), core.installments);
    expect(paid(after)).toEqual([1000, 1000, 1000, 1000, 1000, 1000, 5, 0, 0, 0]);
    expect(sum(core.payments.map((p) => p.amount))).toBe(6005);
    expect(outstandingPrincipalFor(10000, after)).toBe(3995);
    expect(installmentProgress(after)).toMatchObject({ paidTotal: 6005, remainingTotal: 3995, next: { original: 1000, covered: 5, stillDue: 995 } });
  });

  it("EMI: ₹6,005.50 keeps the paise", () => {
    const a = planEmiPaymentAllocation({ installments: tenByThousand("emi"), amount: 6005.5, date: onFirstDue });
    if (!a.ok) throw new Error(a.error);
    expect(a.applied).toBe(6005.5);
    expect(a.remainingAfter).toBe(3994.5);
    expect(a.nextAfter).toMatchObject({ remaining: 994.5 });
  });
});

describe("interest-bearing — the existing schedule's own principal/interest split", () => {
  // ₹10,000 at 12% p.a. reducing balance over 10 months, straight from the canonical calculator.
  const breakdown = calculate({ principal: 10000, type: "reducingBalance", ratePercent: 12, period: "yearly", installmentCount: 10, installmentFrequency: "monthly" });
  const scheduled = (owner: "loan" | "emi") =>
    breakdown.periods.map((p) => inst(p.periodNumber, p.paymentAmount, { principal: p.principalPortion, interest: p.interestPortion, owner }));

  it("Loan: payment = principal settled + interest settled; remaining matches the schedule", () => {
    const base = scheduled("loan");
    const core = recordLoan(base, 6500, { upcoming: true });
    const after = apply(base, core.installments);
    expect(sum(core.payments.map((p) => p.amount))).toBe(6500);
    const principalSettled = round2(principalPaidFor(after));
    const interestSettled = round2(6500 - principalSettled);
    expect(principalSettled).toBeGreaterThan(0);
    expect(interestSettled).toBeGreaterThan(0);
    expect(round2(principalSettled + interestSettled)).toBe(6500);
    expect(round2(outstandingPrincipalFor(10000, after))).toBe(round2(10000 - principalSettled));
    // Nothing disappears: what is still scheduled = everything payable − what was paid.
    expect(installmentProgress(after).remainingTotal).toBe(round2(sum(base.map((i) => i.amountDue)) - 6500));
    expect(round2(sum(base.map((i) => i.amountDue)))).toBeCloseTo(totalPayable(breakdown), 0);
  });

  it("EMI: each portion books its own installment's principal/interest ratio, summing to the payment", () => {
    const a = planEmiPaymentAllocation({ installments: scheduled("emi"), amount: 6500, date: onFirstDue });
    if (!a.ok) throw new Error(a.error);
    expect(round2(sum(a.portions.map((p) => p.principalPaid)) + sum(a.portions.map((p) => p.interestPaid)))).toBeCloseTo(6500, 1);
    expect(sum(a.portions.map((p) => p.interestPaid))).toBeGreaterThan(0);
  });
});

describe("People — the person's own installment obligations", () => {
  const emiSource = (shares: OwnershipShare[] | null) => ({
    id: "agreement-1",
    name: "Family loan",
    scheduleId: "sched",
    beneficiaryPersonId: shares ? null : "amma",
    beneficiaryRepaysInstallments: true,
    ownershipShares: shares,
    isClosed: false,
    deletedAt: null,
  });
  const obligationsFor = (personId: string, shares: OwnershipShare[] | null): PaymentObligation[] =>
    personEmiObligations({ personId, emis: [emiSource(shares)], loans: [], installments: tenByThousand("emi"), now: onFirstDue }).map((o) => ({
      key: o.key,
      title: `#${o.installmentNumber}`,
      date: o.dueDate,
      createdAt: o.createdAt,
      amount: o.amount,
      outstanding: o.amount,
      side: "theyOwe",
    }));

  it("AMMA owes the whole ₹10,000 and pays ₹6,500 → 6 settled, #7 ₹500 still due, ₹3,500 remaining", () => {
    const obligations = obligationsFor("amma", null);
    expect(sum(obligations.map((o) => o.amount))).toBe(10000);
    const a = allocatePayment({ obligations, selectedKeys: obligations.map((o) => o.key), amount: 6500 });
    expect(a.lines.map((l) => l.amount)).toEqual([1000, 1000, 1000, 1000, 1000, 1000, 500]);
    expect(a.lines[6]).toMatchObject({ outstanding: 1000, remainingAfter: 500 });
    expect(a).toMatchObject({ allocated: 6500, extra: 0, unpaid: 3500, outcome: "partial" });
  });

  it("₹6,005 from AMMA keeps the ₹5", () => {
    const obligations = obligationsFor("amma", null);
    const a = allocatePayment({ obligations, selectedKeys: obligations.map((o) => o.key), amount: 6005 });
    expect(a).toMatchObject({ allocated: 6005, unpaid: 3995 });
    expect(a.lines[6]).toMatchObject({ amount: 5, remainingAfter: 995 });
  });

  it("60/40 shares: AMMA's ₹3,500 settles only AMMA's ₹600 shares; SOJAN's ₹4,000 is untouched", () => {
    const shares: OwnershipShare[] = [{ personId: "amma", amount: 6000 }, { personId: "sojan", amount: 4000 }];
    const amma = obligationsFor("amma", shares);
    const sojan = obligationsFor("sojan", shares);
    expect(amma.every((o) => o.amount === 600)).toBe(true);
    expect(sum(amma.map((o) => o.amount)) + sum(sojan.map((o) => o.amount))).toBe(10000);
    const a = allocatePayment({ obligations: amma, selectedKeys: amma.map((o) => o.key), amount: 3500 });
    expect(a.lines.map((l) => l.amount)).toEqual([600, 600, 600, 600, 600, 500]);
    expect(a).toMatchObject({ allocated: 3500, unpaid: 2500 });
    // Each person's obligations come from their own statement — AMMA's payment never reaches SOJAN's ₹400 shares.
    expect(a.lines.every((l) => l.outstanding === 600)).toBe(true);
    expect(sum(sojan.map((o) => o.outstanding))).toBe(4000);
  });
});
