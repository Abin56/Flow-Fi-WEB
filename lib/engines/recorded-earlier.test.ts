import { describe, expect, it } from "vitest";
import { planLoanPaymentCore } from "@/lib/engines/loan-payment-core";
import { netBalanceDeltas } from "@/lib/engines/payment-correction";
import {
  RECORDED_EARLIER_PEOPLE_ACK,
  RecordedEarlierError,
  assertRecordedEarlierDate,
  assertRecordedEarlierNoExtra,
  assertRecordedEarlierTarget,
  carriedRecordedEarlier,
} from "@/lib/engines/recorded-earlier";
import { hasPeopleGateAcknowledgement } from "@/lib/engines/linked-people-readiness";
import type { Loan } from "@/lib/models/loan";
import { installmentPaymentFromFirestore, installmentPaymentToFirestore, type Installment, type InstallmentPayment } from "@/lib/models/payment-schedule";
import { balanceEffect } from "@/lib/models/transaction";
import { countsFromSchedule } from "@/lib/engines/loan-cash-flow";

const NOW = new Date(2026, 9, 13, 10);

describe("Already paid earlier — guards", () => {
  it("today (any time) is earlier; tomorrow is not", () => {
    expect(() => assertRecordedEarlierDate(new Date(2026, 9, 13, 23, 30), NOW)).not.toThrow();
    expect(() => assertRecordedEarlierDate(new Date(2026, 0, 5), NOW)).not.toThrow();
    expect(() => assertRecordedEarlierDate(new Date(2026, 9, 14, 0, 1), NOW)).toThrow(RecordedEarlierError);
  });

  it("must start on the installment the user picked (when one is named)", () => {
    expect(() => assertRecordedEarlierTarget("i1", "i1")).not.toThrow();
    expect(() => assertRecordedEarlierTarget("i2", "i1")).toThrow(/already paid — nothing was recorded/);
    expect(() => assertRecordedEarlierTarget(undefined, "i1")).toThrow(RecordedEarlierError);
    expect(() => assertRecordedEarlierTarget("i2", null)).not.toThrow();
  });

  it("covers installments only — any extra principal is refused", () => {
    expect(() => assertRecordedEarlierNoExtra(0)).not.toThrow();
    expect(() => assertRecordedEarlierNoExtra(0.01)).toThrow(RecordedEarlierError);
  });

  it("its People acknowledgement is a valid, explicit one", () => {
    expect(hasPeopleGateAcknowledgement(RECORDED_EARLIER_PEOPLE_ACK)).toBe(true);
  });
});

describe("Already paid earlier — an edit keeps the original's treatment", () => {
  const D = new Date(2026, 0, 5);
  it("an ordinary payment stays ordinary", () => {
    expect(carriedRecordedEarlier({ recordedEarlier: null, date: D }, new Date(2026, 0, 9))).toBeNull();
    expect(carriedRecordedEarlier(null, D)).toBeNull();
  });
  it("an undated past payment stays undated until its date changes", () => {
    expect(carriedRecordedEarlier({ recordedEarlier: { dateKnown: false }, date: D }, new Date(D))).toEqual({ dateKnown: false });
    expect(carriedRecordedEarlier({ recordedEarlier: { dateKnown: false }, date: D }, new Date(2026, 0, 3))).toEqual({ dateKnown: true });
    expect(carriedRecordedEarlier({ recordedEarlier: { dateKnown: true }, date: D }, new Date(D))).toEqual({ dateKnown: true });
  });
});

function inst(id: string, seq: number, due: Date, o: Partial<Installment> = {}): Installment {
  return {
    id, scheduleId: "sch", ownerType: "loan", ownerId: "loan-1", sequenceNumber: seq, dueDate: due, amountDue: 3000, amountPaid: 0, isSkipped: false,
    principalPortion: null, interestPortion: null, createdAt: new Date(2025, 11, 1), deletedAt: null, lastEditedAt: null, editHistory: [], ...o,
  };
}
const loan = { id: "loan-1", name: "Car", scheduleId: "sch", direction: "taken", repaymentType: "installment" } as unknown as Loan;
const fresh = [inst("i1", 1, new Date(2026, 0, 10)), inst("i2", 2, new Date(2026, 1, 10)), inst("i3", 3, new Date(2026, 2, 10))];
const core = (recordedEarlier: { dateKnown: boolean } | null, amount = 3000) =>
  planLoanPaymentCore({ loan, fresh, lastInstallmentId: "i3", accountId: "sbi", amount, date: new Date(2026, 0, 10, 12), idempotencyKey: "k", includeUpcomingInstallments: true, recordedEarlier, now: NOW });

describe("Loan payment core — Already paid earlier", () => {
  it("posts the action's Transaction excluded from calculations: zero balance effect, never schedule-only cash", () => {
    const c = core({ dateKnown: true });
    expect(c.transaction.excludeFromCalculations).toBe(true);
    expect(balanceEffect(c.transaction)).toBe(0);
    expect(c.transaction.description).toBe("Loan payment — Car (already paid earlier)");
    expect(c.payments).toHaveLength(1);
    expect(c.payments[0]).toMatchObject({ installmentId: "i1", amount: 3000, recordedEarlier: { dateKnown: true }, transactionId: c.transactionId });
    expect(countsFromSchedule(c.payments[0])).toBe(false);
  });

  it("several past installments in one go: each marked, one excluded Transaction", () => {
    const c = core({ dateKnown: false }, 7500);
    expect(c.payments.map((p) => [p.installmentId, p.amount, p.recordedEarlier])).toEqual([
      ["i1", 3000, { dateKnown: false }],
      ["i2", 3000, { dateKnown: false }],
      ["i3", 1500, { dateKnown: false }],
    ]);
    expect(c.overflow).toBe(0);
  });

  it("an ordinary payment is unchanged: counted Transaction, no mark written", () => {
    const c = core(null);
    expect(c.transaction.excludeFromCalculations).toBe(false);
    expect(balanceEffect(c.transaction)).toBe(-3000);
    expect("recordedEarlier" in c.payments[0]).toBe(false);
  });

  it("editing / reversing a past payment nets to zero on every account; a normal one moves exactly once", () => {
    const past = core({ dateKnown: true }).transaction;
    const normal = core(null).transaction;
    expect(Object.fromEntries(netBalanceDeltas([past], [{ ...past, amount: 4000, accountId: "icici" }]))).toEqual({ sbi: 0, icici: 0 });
    expect(Object.fromEntries(netBalanceDeltas([past], []))).toEqual({ sbi: 0 });
    expect(Object.fromEntries(netBalanceDeltas([normal], []))).toEqual({ sbi: 3000 });
  });
});

describe("InstallmentPayment ↔ Firestore — the mark is additive", () => {
  const payment: InstallmentPayment = {
    id: "p", installmentId: "i1", scheduleId: "sch", ownerType: "emi", ownerId: "e", amount: 3000, date: new Date(2026, 0, 5), note: "", createdAt: NOW,
    settlementMethod: null, billingCycleLabel: null, remainingBalanceAfterPayment: 0, allocationType: "regularEmi", prepaymentPrincipalAmount: null,
    prepaymentPolicyApplied: null, reamortizationEventId: null, transactionId: null, deletedAt: null, lastEditedAt: null, editHistory: [],
  };
  const roundTrip = (p: InstallmentPayment) => {
    const data = installmentPaymentToFirestore(p);
    return { data, back: installmentPaymentFromFirestore({ id: p.id, data: () => data } as never) };
  };

  it("an ordinary payment keeps its exact document shape and reads back unmarked", () => {
    const { data, back } = roundTrip(payment);
    expect("recordedEarlier" in data).toBe(false);
    expect(back.recordedEarlier).toBeNull();
  });

  it("a past payment writes and reads its mark (date known or not)", () => {
    for (const dateKnown of [true, false]) {
      const { data, back } = roundTrip({ ...payment, recordedEarlier: { dateKnown } });
      expect(data.recordedEarlier).toEqual({ dateKnown });
      expect(back.recordedEarlier).toEqual({ dateKnown });
    }
  });
});
