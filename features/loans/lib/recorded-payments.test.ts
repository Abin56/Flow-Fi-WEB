import { describe, expect, it } from "vitest";
import type { Installment, InstallmentPayment } from "@/lib/models/payment-schedule";
import {
  editEligibility,
  groupRecordedPayments,
  installmentRangeLabel,
  installmentRowAction,
  originalRefs,
  paymentTypeLabel,
} from "./recorded-payments";

function inst(n: number, amountPaid = 0, amountDue = 5000): Installment {
  return {
    id: `i${n}`,
    scheduleId: "s",
    ownerType: "loan",
    ownerId: "l",
    sequenceNumber: n,
    dueDate: new Date(2026, 8 + n, 5),
    amountDue,
    amountPaid,
    isSkipped: false,
    principalPortion: null,
    interestPortion: null,
    createdAt: new Date(2026, 8, 1),
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
  };
}

function pay(id: string, installmentId: string, amount: number, extra: Partial<InstallmentPayment> = {}): InstallmentPayment {
  return {
    id,
    installmentId,
    scheduleId: "s",
    ownerType: "loan",
    ownerId: "l",
    amount,
    date: new Date(2026, 9, 5),
    note: "",
    createdAt: new Date(2026, 9, 5, 10),
    settlementMethod: null,
    billingCycleLabel: null,
    remainingBalanceAfterPayment: 0,
    allocationType: "regularEmi",
    prepaymentPrincipalAmount: null,
    prepaymentPolicyApplied: null,
    reamortizationEventId: null,
    transactionId: null,
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    ...extra,
  };
}

const installments = [inst(1, 5000), inst(2, 3000), inst(3), inst(4)];

describe("grouping recorded payments into what the user entered", () => {
  it("a Loan action's portions + extra principal become one ₹ amount (by transactionId)", () => {
    const [action] = groupRecordedPayments(
      [
        pay("adv_a_p0", "i1", 5000, { transactionId: "adv_a_txn" }),
        pay("adv_a_p1", "i2", 3000, { transactionId: "adv_a_txn", allocationType: "advanceEmi", remainingBalanceAfterPayment: 2000 }),
      ],
      installments,
      "loan",
    );
    expect(action).toMatchObject({ amount: 8000, installmentSeqs: [1, 2], remainingAfter: 2000, transactionId: "adv_a_txn", reversed: false });
    expect(paymentTypeLabel(action)).toBe("Installment + advance");
    expect(installmentRangeLabel(action.installmentSeqs)).toBe("#1–#2");
    expect(originalRefs(action)).toEqual({ paymentIds: ["adv_a_p0", "adv_a_p1"], installmentIds: ["i1", "i2"], overflowPaymentId: null, overflowInstallmentId: null });

    const [prepay] = groupRecordedPayments(
      [pay("adv_b_p0", "i1", 5000, { transactionId: "adv_b_txn" }), pay("adv_b_principal", "i4", 3000, { transactionId: "adv_b_txn", allocationType: "principalPrepayment" })],
      installments,
      "loan",
    );
    expect(prepay).toMatchObject({ amount: 8000, allocationType: "principalPrepayment", installmentSeqs: [1] });
    expect(prepay.overflow?.id).toBe("adv_b_principal");
  });

  it("EMI actions group by their key; an older random-id EMI payment is its own action", () => {
    const actions = groupRecordedPayments(
      [pay("emi_k_p0", "i1", 5000), pay("emi_k_p1", "i2", 3000, { remainingBalanceAfterPayment: 2000 }), pay("legacy123", "i2", 1000, { createdAt: new Date(2026, 8, 20) })],
      installments,
      "emi",
    );
    expect(actions.map((a) => a.amount)).toEqual([8000, 1000]);
  });

  it("a replaced (soft-deleted) original stays in history as reversed and never merges with its correction", () => {
    const actions = groupRecordedPayments(
      [pay("adv_a_p0", "i1", 8000, { transactionId: "adv_a_txn", deletedAt: new Date() }), pay("adv_c_p0", "i1", 5000, { transactionId: "adv_c_txn", createdAt: new Date(2026, 9, 6) })],
      installments,
      "loan",
    );
    expect(actions.map((a) => [a.amount, a.reversed])).toEqual([
      [5000, false],
      [8000, true],
    ]);
  });
});

describe("edit eligibility", () => {
  const older = pay("adv_a_p0", "i1", 5000, { transactionId: "adv_a_txn", createdAt: new Date(2026, 9, 1) });
  const latest = pay("adv_b_p0", "i2", 3000, { transactionId: "adv_b_txn", createdAt: new Date(2026, 9, 6) });
  const all = groupRecordedPayments([older, latest], installments, "loan");
  const [latestAction, olderAction] = all;

  it("only the latest payment action is editable (same rule the repositories enforce)", () => {
    expect(editEligibility(latestAction, all, { closed: false })).toEqual({ ok: true });
    expect(editEligibility(olderAction, all, { closed: false })).toMatchObject({ ok: false, reason: expect.stringMatching(/latest/) });
  });
  it("closed records, reversed payments and pre-account-tracking Loan payments are not editable", () => {
    expect(editEligibility(latestAction, all, { closed: true }).ok).toBe(false);
    const [legacy] = groupRecordedPayments([pay("old", "i1", 5000)], installments, "loan");
    expect(editEligibility(legacy, [legacy], { closed: false })).toMatchObject({ ok: false, reason: expect.stringMatching(/account tracking/) });
    const [gone] = groupRecordedPayments([pay("x", "i1", 5000, { transactionId: "t", deletedAt: new Date() })], installments, "loan");
    expect(editEligibility(gone, [gone], { closed: false }).ok).toBe(false);
  });
});

describe("14. installment rows are actionable in both states", () => {
  const actions = groupRecordedPayments(
    [pay("adv_a_p0", "i1", 5000, { transactionId: "t1" }), pay("adv_a_p1", "i2", 3000, { transactionId: "t1", remainingBalanceAfterPayment: 2000 })],
    installments,
    "loan",
  );
  it("paid and partly paid installments open their recorded payment; unpaid ones open Pay", () => {
    expect(installmentRowAction(installments[0], actions, false)).toMatchObject({ kind: "view", action: { amount: 8000 } });
    expect(installmentRowAction(installments[1], actions, false)).toMatchObject({ kind: "view" });
    expect(installmentRowAction(installments[2], actions, false)).toEqual({ kind: "pay" });
  });
  it("a closed record still lets you view payments, but not pay", () => {
    expect(installmentRowAction(installments[0], actions, true)).toMatchObject({ kind: "view" });
    expect(installmentRowAction(installments[2], actions, true)).toBeNull();
  });
});
