import { describe, expect, it } from "vitest";
import type { Installment, InstallmentPayment } from "@/lib/models/payment-schedule";
import {
  assertEmiReversalStillValid,
  EMI_LATER_PAYMENT_MESSAGE,
  EMI_SCHEDULE_CHANGED_MESSAGE,
  EMI_TARGET_CHANGED_MESSAGE,
  planEmiReversalPreflight,
} from "./emi-reversal-guard";

function inst(seq: number, amountPaid = 0): Installment {
  return {
    id: `i${seq}`,
    scheduleId: "s",
    ownerType: "emi",
    ownerId: "emi-1",
    sequenceNumber: seq,
    dueDate: new Date(2026, seq, 5),
    amountDue: 5_000,
    amountPaid,
    isSkipped: false,
    principalPortion: null,
    interestPortion: null,
    createdAt: new Date(2026, 0, 1),
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
  };
}

function pay(id: string, installmentId: string, amount: number, createdAtMs: number, deleted = false): InstallmentPayment {
  return {
    id,
    installmentId,
    scheduleId: "s",
    ownerType: "emi",
    ownerId: "emi-1",
    amount,
    date: new Date(createdAtMs),
    note: "",
    createdAt: new Date(createdAtMs),
    deletedAt: deleted ? new Date(createdAtMs + 1) : null,
    allocationType: "regularEmi",
  } as InstallmentPayment;
}

const T1 = Date.UTC(2026, 1, 1);
const T2 = T1 + 60_000;

describe("EMI reversal guard — preflight", () => {
  it("allows undoing the latest action (all its portions share one createdAt)", () => {
    const a = [pay("emi_k1_p0", "i1", 5_000, T1), pay("emi_k1_p1", "i2", 1_000, T1)];
    const { block } = planEmiReversalPreflight({ installments: [inst(1, 5_000), inst(2, 1_000)], activePayments: a, targetPaymentIds: ["emi_k1_p0", "emi_k1_p1"] });
    expect(block).toBeNull();
  });

  it("blocks an older action when a later active payment exists", () => {
    const active = [pay("emi_k1_p0", "i1", 5_000, T1), pay("emi_k2_p0", "i2", 5_000, T2)];
    const { block } = planEmiReversalPreflight({ installments: [inst(1, 5_000), inst(2, 5_000)], activePayments: active, targetPaymentIds: ["emi_k1_p0"] });
    expect(block).toBe(EMI_LATER_PAYMENT_MESSAGE);
  });

  it("ignores a later payment that was already reversed", () => {
    const active = [pay("emi_k1_p0", "i1", 5_000, T1), pay("emi_k2_p0", "i2", 5_000, T2, true)];
    const { block } = planEmiReversalPreflight({ installments: [inst(1, 5_000), inst(2)], activePayments: active, targetPaymentIds: ["emi_k1_p0"] });
    expect(block).toBeNull();
  });
});

describe("EMI reversal guard — inside the transaction", () => {
  const installments = [inst(1, 5_000), inst(2)];
  const target = pay("emi_k1_p0", "i1", 5_000, T1);
  const { preflight } = planEmiReversalPreflight({ installments, activePayments: [target], targetPaymentIds: [target.id] });
  const freshInstallments = new Map(installments.map((i) => [i.id, i] as const));

  it("proceeds when nothing changed", () => {
    expect(assertEmiReversalStillValid({ preflight, freshTargets: [target], freshInstallments })).toEqual({ ok: true, outcome: "proceed" });
  });

  it("is a no-op when the target is already reversed (repeat / second tab)", () => {
    const gone = { ...target, deletedAt: new Date() };
    expect(assertEmiReversalStillValid({ preflight, freshTargets: [gone], freshInstallments })).toEqual({ ok: true, outcome: "alreadyReversed" });
    expect(assertEmiReversalStillValid({ preflight, freshTargets: [null], freshInstallments })).toEqual({ ok: true, outcome: "alreadyReversed" });
  });

  it("refuses when a payment landed on any installment after the preflight", () => {
    const moved = new Map(freshInstallments);
    moved.set("i2", inst(2, 2_000));
    expect(assertEmiReversalStillValid({ preflight, freshTargets: [target], freshInstallments: moved })).toEqual({ ok: false, message: EMI_SCHEDULE_CHANGED_MESSAGE });
  });

  it("refuses when the target payment itself changed or is only partly live", () => {
    const edited = { ...target, amount: 4_000 };
    expect(assertEmiReversalStillValid({ preflight, freshTargets: [edited], freshInstallments })).toEqual({ ok: false, message: EMI_TARGET_CHANGED_MESSAGE });

    const two = [pay("emi_k3_p0", "i1", 5_000, T1), pay("emi_k3_p1", "i2", 500, T1)];
    const p2 = planEmiReversalPreflight({ installments, activePayments: two, targetPaymentIds: two.map((p) => p.id) }).preflight;
    const partly = [two[0], { ...two[1], deletedAt: new Date() }];
    expect(assertEmiReversalStillValid({ preflight: p2, freshTargets: partly, freshInstallments })).toEqual({ ok: false, message: EMI_TARGET_CHANGED_MESSAGE });
  });

  it("refuses a target that was not live when the preflight ran", () => {
    const { preflight: empty } = planEmiReversalPreflight({ installments, activePayments: [], targetPaymentIds: [target.id] });
    expect(assertEmiReversalStillValid({ preflight: empty, freshTargets: [target], freshInstallments })).toEqual({ ok: false, message: EMI_TARGET_CHANGED_MESSAGE });
  });
});
