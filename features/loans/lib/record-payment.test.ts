import { describe, expect, it } from "vitest";
import type { Loan } from "@/lib/models/loan";
import type { Installment } from "@/lib/models/payment-schedule";
import {
  emiQuickOptions,
  loanPaymentFigures,
  loanPaymentSuccessTitle,
  loanQuickOptions,
  paymentDateFrom,
  planEmiPayment,
  planLoanPayment,
} from "./record-payment";

const loan = {
  id: "loan-1",
  loanAmount: 4000,
  loanDate: new Date("2026-01-01T00:00:00Z"),
  repaymentType: "installment",
  direction: "taken",
  interest: null,
  installmentFrequency: "monthly",
  installmentCount: 4,
  scheduleId: "schedule-1",
} as Loan;

function installment(sequenceNumber: number, dueDate: string, amountPaid = 0): Installment {
  return {
    id: `installment-${sequenceNumber}`,
    scheduleId: "schedule-1",
    ownerType: "loan",
    ownerId: "loan-1",
    sequenceNumber,
    dueDate: new Date(dueDate),
    amountDue: 1000,
    amountPaid,
    isSkipped: false,
    principalPortion: null,
    interestPortion: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
  };
}

const schedule = [
  installment(1, "2026-02-01T00:00:00Z", 1000),
  installment(2, "2026-03-01T00:00:00Z"),
  installment(3, "2026-04-01T00:00:00Z"),
  installment(4, "2026-05-01T00:00:00Z"),
];

describe("loan quick options", () => {
  it("offers the next installment first and all remaining when more is owed", () => {
    const figures = loanPaymentFigures(loan, schedule, new Date("2026-02-15T12:00:00Z"));
    expect(figures).toMatchObject({ dueAmount: 1000, dueCount: 1, totalRemaining: 3000, payableCount: 3 });
    expect(loanQuickOptions(loan, figures).map((o) => [o.choice, o.amount])).toEqual([
      ["installment", 1000],
      ["remaining", 3000],
    ]);
  });

  it("adds 'pay everything due' when several installments are overdue", () => {
    const figures = loanPaymentFigures(loan, schedule, new Date("2026-04-15T12:00:00Z"));
    expect(figures.dueCount).toBe(2);
    expect(loanQuickOptions(loan, figures).map((o) => o.choice)).toEqual(["installment", "allDue", "remaining"]);
  });

  it("offers nothing once fully paid", () => {
    const paid = schedule.map((i) => ({ ...i, amountPaid: 1000 }));
    const figures = loanPaymentFigures(loan, paid, new Date("2026-02-15T12:00:00Z"));
    expect(figures.next).toBeNull();
    expect(loanQuickOptions(loan, figures)).toEqual([]);
    expect(planLoanPayment({ loan, figures, choice: "installment", customAmount: "", treatment: "reducePrincipal" }).ok).toBe(false);
  });
});

describe("planLoanPayment → existing record() params", () => {
  const figures = loanPaymentFigures(loan, schedule, new Date("2026-02-15T12:00:00Z"));
  const plan = (choice: "installment" | "remaining" | "custom", customAmount = "", treatment: "reducePrincipal" | "payUpcoming" = "reducePrincipal") =>
    planLoanPayment({ loan, figures, choice, customAmount, treatment });

  it("installment and remaining map to the scheduled paths", () => {
    expect(plan("installment")).toEqual({ ok: true, amount: 1000, includeUpcomingInstallments: false, extra: 0 });
    expect(plan("remaining")).toEqual({ ok: true, amount: 3000, includeUpcomingInstallments: true, extra: 0 });
  });

  it("partial payment stays a plain payment (never a faked full installment)", () => {
    expect(plan("custom", "400")).toEqual({ ok: true, amount: 400, includeUpcomingInstallments: false, extra: 0 });
  });

  it("extra above what's due is prepayment by default, or upcoming installments when chosen", () => {
    expect(plan("custom", "2500")).toEqual({ ok: true, amount: 2500, includeUpcomingInstallments: false, extra: 1500 });
    expect(plan("custom", "2500", "payUpcoming")).toEqual({ ok: true, amount: 2500, includeUpcomingInstallments: true, extra: 1500 });
  });

  it("rejects bad amounts and one-time overpayment", () => {
    expect(plan("custom", "").ok).toBe(false);
    expect(plan("custom", "-5").ok).toBe(false);
    const oneTime = { ...loan, repaymentType: "oneTime" } as Loan;
    const oneTimeFigures = loanPaymentFigures(oneTime, [installment(1, "2026-03-01T00:00:00Z")], new Date("2026-02-15T12:00:00Z"));
    expect(planLoanPayment({ loan: oneTime, figures: oneTimeFigures, choice: "custom", customAmount: "1500", treatment: "reducePrincipal" }).ok).toBe(false);
    expect(loanQuickOptions(oneTime, oneTimeFigures).map((o) => o.choice)).toEqual(["installment"]);
  });

  it("names the outcome from the repository's classification", () => {
    expect(loanPaymentSuccessTitle("principalPrepayment")).toMatch(/Extra principal/);
    expect(loanPaymentSuccessTitle("advanceEmi")).toMatch(/Advance/);
    expect(loanPaymentSuccessTitle("regularEmi")).toBe("Payment recorded successfully");
  });
});

describe("EMI payment plan", () => {
  const next = installment(2, "2026-03-01T00:00:00Z", 250);
  it("defaults to the installment's remaining amount and allows partial", () => {
    expect(emiQuickOptions(next)[0].amount).toBe(750);
    expect(planEmiPayment(next, "installment", "")).toEqual({ ok: true, amount: 750 });
    expect(planEmiPayment(next, "custom", "300")).toEqual({ ok: true, amount: 300 });
  });
  it("never exceeds one installment (the EMI backend has no prepayment)", () => {
    expect(planEmiPayment(next, "custom", "800").ok).toBe(false);
    expect(planEmiPayment(null, "installment", "").ok).toBe(false);
  });
});

it("parses payment dates at local noon", () => {
  expect(paymentDateFrom("2026-09-27")?.getHours()).toBe(12);
  expect(paymentDateFrom("bad")).toBeNull();
});
