import { describe, expect, it } from "vitest";
import { planLoanPaymentCore, type LoanPaymentCore } from "@/lib/engines/loan-payment-core";
import { outstandingPrincipalFor } from "@/lib/engines/loan-outstanding";
import { personPosition } from "@/lib/engines/person-position";
import type { Loan } from "@/lib/models/loan";
import type { Installment } from "@/lib/models/payment-schedule";
import { mergeInstallmentWrites, netBalanceDeltas, reversePaymentPortions } from "./payment-correction";

/** ₹20,000 borrowed, 4 × ₹5,000 monthly from 5 Oct 2026 — "taken", paid from HDFC. */
const loan = {
  id: "loan-1",
  name: "Bike loan",
  loanAmount: 20000,
  direction: "taken",
  repaymentType: "installment",
  scheduleId: "sched-1",
  personId: "person-arun",
  category: "personal",
} as Loan;

function inst(n: number, amountDue = 5000, opts: { principal?: number; interest?: number; paid?: number } = {}): Installment {
  return {
    id: `i${n}`,
    scheduleId: "sched-1",
    ownerType: "loan",
    ownerId: "loan-1",
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
const schedule = () => [inst(1), inst(2), inst(3), inst(4)];
const onDue = new Date(2026, 9, 5, 12);

function record(installments: Installment[], amount: number, opts: { key?: string; upcoming?: boolean; accountId?: string } = {}): LoanPaymentCore {
  return planLoanPaymentCore({
    loan,
    fresh: installments,
    lastInstallmentId: installments[installments.length - 1].id,
    accountId: opts.accountId ?? "hdfc",
    amount,
    date: onDue,
    idempotencyKey: opts.key ?? "k1",
    includeUpcomingInstallments: opts.upcoming,
  });
}
const apply = (installments: Installment[], writes: Installment[]) => {
  const byId = new Map(writes.map((i) => [i.id, i]));
  return installments.map((i) => byId.get(i.id) ?? i);
};

/** Edit = reverse the original's portions, then record the correction against that state. */
function edit(current: Installment[], original: LoanPaymentCore, amount: number, opts: { upcoming?: boolean; accountId?: string } = {}) {
  const reversed = reversePaymentPortions(current, original.payments);
  const corrected = record(reversed, amount, { key: "k2", ...opts });
  const writes = mergeInstallmentWrites(current, reversed, corrected.installments);
  return { after: apply(current, writes), corrected, writes };
}

const paid = (list: Installment[]) => list.map((i) => i.amountPaid);

describe("editing a recorded Loan payment", () => {
  it("1. normal ₹5,000 installment payment edited to ₹4,000 → partial on #1, ₹16,000 outstanding", () => {
    const original = record(schedule(), 5000);
    const afterOriginal = apply(schedule(), original.installments);
    const { after, corrected } = edit(afterOriginal, original, 4000);
    expect(paid(after)).toEqual([4000, 0, 0, 0]);
    expect(corrected.payments.map((p) => [p.installmentId, p.amount, p.remainingBalanceAfterPayment])).toEqual([["i1", 4000, 1000]]);
    expect(outstandingPrincipalFor(20000, after)).toBe(16000);
  });

  it("2/3/12. upward and downward edits land exactly where recording the corrected amount would", () => {
    for (const [from, to] of [
      [5000, 8000],
      [8000, 5000],
      [12000, 8000],
      [3000, 15000],
    ] as const) {
      const original = record(schedule(), from, { upcoming: true });
      const current = apply(schedule(), original.installments);
      const { after } = edit(current, original, to, { upcoming: true });
      const direct = apply(schedule(), record(schedule(), to, { upcoming: true }).installments);
      expect(paid(after)).toEqual(paid(direct));
    }
  });

  it("4. partial ₹2,000 corrected to ₹3,000 → ₹2,000 left on #1, never duplicated", () => {
    const original = record(schedule(), 2000);
    const { after } = edit(apply(schedule(), original.installments), original, 3000);
    expect(paid(after)).toEqual([3000, 0, 0, 0]);
    expect(after).toHaveLength(4);
  });

  it("5/6. advance ₹12,000 corrected to ₹8,000 → #1 paid, ₹3,000 on #2; no stale allocation on #3", () => {
    const original = record(schedule(), 12000, { upcoming: true });
    const current = apply(schedule(), original.installments);
    expect(paid(current)).toEqual([5000, 5000, 2000, 0]);
    const { after, corrected } = edit(current, original, 8000, { upcoming: true });
    expect(paid(after)).toEqual([5000, 3000, 0, 0]);
    expect(corrected.overallType).toBe("regularEmi");
    expect(corrected.payments.map((p) => [p.installmentId, p.amount, p.allocationType])).toEqual([
      ["i1", 5000, "regularEmi"],
      ["i2", 3000, "advanceEmi"],
    ]);
  });

  it("6. an ₹8,000 'reduce principal' correction is detected as needing the re-plan path", () => {
    const original = record(schedule(), 5000);
    const reversed = reversePaymentPortions(apply(schedule(), original.installments), original.payments);
    const corrected = record(reversed, 8000);
    expect(corrected.overflow).toBe(3000);
    expect(corrected.overallType).toBe("principalPrepayment");
  });

  it("interest-bearing: outstanding principal follows the corrected allocation", () => {
    const withInterest = () => [inst(1, 5000, { principal: 4000, interest: 1000 }), inst(2, 5000, { principal: 4100, interest: 900 }), inst(3, 5000, { principal: 4200, interest: 800 })];
    const original = record(withInterest(), 8000, { upcoming: true });
    const current = apply(withInterest(), original.installments);
    // 4000 + 3000 × 4100/5000 = 6460 principal repaid of 12,300.
    expect(outstandingPrincipalFor(12300, current)).toBe(5840);
    const { after } = edit(current, original, 5000, { upcoming: true });
    expect(paid(after)).toEqual([5000, 0, 0]);
    expect(outstandingPrincipalFor(12300, after)).toBe(8300);
  });

  it("7. final-payment correction: ₹2,500 last installment recorded as ₹2,000, corrected to ₹2,500 → settled, never negative", () => {
    const base = [inst(1, 5000, { paid: 5000 }), inst(2, 5000, { paid: 5000 }), inst(3, 5000, { paid: 5000 }), inst(4, 2500)];
    const original = record(base, 2000);
    const current = apply(base, original.installments);
    const { after } = edit(current, original, 2500);
    expect(paid(after)).toEqual([5000, 5000, 5000, 2500]);
    expect(outstandingPrincipalFor(17500, after)).toBe(0);
    expect(after.every((i) => i.amountPaid <= i.amountDue && i.amountPaid >= 0)).toBe(true);
  });

  it("8/11. account-linked: HDFC moves by the difference only; switching account moves each once", () => {
    const original = record(schedule(), 8000, { upcoming: true });
    const corrected = record(schedule(), 5000, { key: "k2", upcoming: true });
    // Original took ₹8,000 out; the correction takes ₹5,000 → HDFC gets ₹3,000 back, not −₹13,000.
    expect(Object.fromEntries(netBalanceDeltas([original.transaction], [corrected.transaction]))).toEqual({ hdfc: 3000 });

    const fromIcici = record(schedule(), 5000, { key: "k3", accountId: "icici" });
    expect(Object.fromEntries(netBalanceDeltas([original.transaction], [fromIcici.transaction]))).toEqual({ hdfc: 8000, icici: -5000 });
  });

  it("10/11/13. person-linked: the People amount follows the corrected outstanding — counted once", () => {
    const original = record(schedule(), 8000, { upcoming: true });
    const { after } = edit(apply(schedule(), original.installments), original, 5000, { upcoming: true });
    const outstanding = outstandingPrincipalFor(20000, after);
    expect(outstanding).toBe(15000);
    const pos = personPosition({
      personId: "person-arun",
      currentBalance: 0,
      loans: [{ id: "loan-1", personId: "person-arun", direction: "taken", outstandingPrincipal: outstanding, isDeleted: false }],
      ledgerEntries: [],
      loanIds: new Set(["loan-1"]),
    });
    expect(pos).toMatchObject({ loanPayable: 15000, iOwe: 15000 });
  });

  it("reversal skips ledger-only extra-principal records and never goes below zero", () => {
    const original = record(schedule(), 8000);
    const current = apply(schedule(), original.installments);
    const reversed = reversePaymentPortions(current, [...original.payments, original.overflowPayment!, { ...original.payments[0], id: "dup", amount: 99999 }]);
    expect(paid(reversed)).toEqual([0, 0, 0, 0]);
  });

  it("mergeInstallmentWrites writes only changed installments, the latest layer winning", () => {
    const original = record(schedule(), 5000);
    const current = apply(schedule(), original.installments);
    const reversed = reversePaymentPortions(current, original.payments);
    const same = record(reversed, 5000, { key: "k2" });
    const writes = mergeInstallmentWrites(current, reversed, same.installments);
    expect(writes.map((i) => [i.id, i.amountPaid])).toEqual([["i1", 5000]]);
  });
});

describe("recording through the shared core (unchanged behaviour)", () => {
  it("regular / advance / extra-principal classification and ids", () => {
    const regular = record(schedule(), 5000);
    expect([regular.overallType, regular.transactionId, regular.paymentIds]).toEqual(["regularEmi", "adv_k1_txn", ["adv_k1_p0"]]);
    expect(regular.transaction).toMatchObject({ type: "expense", amount: 5000, accountId: "hdfc", loanId: "loan-1", installmentPaymentId: "adv_k1_p0" });

    const early = planLoanPaymentCore({ loan, fresh: schedule(), lastInstallmentId: "i4", accountId: "hdfc", amount: 5000, date: new Date(2026, 9, 1), idempotencyKey: "k" });
    expect(early.overallType).toBe("advanceEmi");

    const extra = record(schedule(), 8000);
    expect(extra.overflow).toBe(3000);
    expect(extra.overflowPayment).toMatchObject({ id: "adv_k1_principal", installmentId: "i4", amount: 3000, prepaymentPrincipalAmount: 3000 });
  });

  it("one-time loans refuse an overflow; a fully paid loan refuses any payment", () => {
    const oneTime = { ...loan, repaymentType: "oneTime" } as Loan;
    expect(() => planLoanPaymentCore({ loan: oneTime, fresh: [inst(1)], lastInstallmentId: "i1", accountId: "a", amount: 6000, date: onDue, idempotencyKey: "k" })).toThrow(/more than/);
    expect(() => record([inst(1, 5000, { paid: 5000 })], 1)).toThrow(/fully paid/);
  });
});
