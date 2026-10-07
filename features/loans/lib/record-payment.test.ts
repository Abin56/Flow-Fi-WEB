import { describe, expect, it } from "vitest";
import type { Loan } from "@/lib/models/loan";
import type { Installment } from "@/lib/models/payment-schedule";
import {
  emiPaymentOutcome,
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
  // Installments of ₹1,000; #1 paid, #2 has ₹250 paid.
  const installments = [installment(1, "2026-02-01T00:00:00Z", 1000), installment(2, "2026-03-01T00:00:00Z", 250), installment(3, "2026-04-01T00:00:00Z"), installment(4, "2026-05-01T00:00:00Z")];
  const next = installments[1];
  const date = new Date("2026-03-01T12:00:00Z");
  const plan = (choice: "installment" | "remaining" | "custom", customAmount = "") => planEmiPayment({ next, installments, choice, customAmount, date });

  it("defaults to the installment's remaining amount and allows partial", () => {
    expect(emiQuickOptions(next, installments).map((o) => [o.choice, o.amount])).toEqual([["installment", 750], ["remaining", 2750]]);
    expect(plan("installment")).toMatchObject({ ok: true, amount: 750 });
    expect(plan("custom", "300")).toMatchObject({ ok: true, amount: 300 });
  });
  it("lets an amount above one installment advance into the next ones, through the same allocation the write uses", () => {
    const result = plan("custom", "1250");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.allocation.portions.map((p) => [p.installment.sequenceNumber, p.amount])).toEqual([[2, 750], [3, 500]]);
    expect(emiPaymentOutcome(result.allocation)).toBe("Covered #2 and part of #3. ₹500 still due on installment #3.");
    expect(plan("remaining")).toMatchObject({ ok: true, amount: 2750 });
  });
  it("never exceeds what the EMI still owes", () => {
    expect(plan("custom", "2750.5").ok).toBe(false);
    expect(planEmiPayment({ next: null, installments, choice: "installment", customAmount: "", date }).ok).toBe(false);
  });
  it("describes partial and settling payments", () => {
    const partial = plan("custom", "300");
    expect(partial.ok && emiPaymentOutcome(partial.allocation)).toBe("Partial payment — ₹450 still due on installment #2.");
    const settle = plan("remaining");
    expect(settle.ok && emiPaymentOutcome(settle.allocation)).toBe("This EMI is now fully paid.");
  });
});

it("parses payment dates at local noon", () => {
  expect(paymentDateFrom("2026-09-27")?.getHours()).toBe(12);
  expect(paymentDateFrom("bad")).toBeNull();
});

describe("paymentCoverage — the pre-save preview's regrouping of the allocator's portions", () => {
  it("₹6,500 over ₹1,000 installments → 6 settled (#1–#6, ₹6,000) + #7 ₹500 with ₹500 still due", async () => {
    const { paymentCoverage } = await import("./record-payment");
    const portions = [1, 2, 3, 4, 5, 6].map((n) => ({ sequenceNumber: n, amount: 1000, remainingAfter: 0 }));
    portions.push({ sequenceNumber: 7, amount: 500, remainingAfter: 500 });
    expect(paymentCoverage(portions)).toEqual({ settled: { count: 6, amount: 6000, first: 1, last: 6 }, partial: { sequenceNumber: 7, amount: 500, left: 500 } });
  });

  it("a partial-only payment has no settled group; ₹5 is kept exactly", async () => {
    const { paymentCoverage } = await import("./record-payment");
    expect(paymentCoverage([{ sequenceNumber: 7, amount: 5, remainingAfter: 995 }])).toEqual({ settled: null, partial: { sequenceNumber: 7, amount: 5, left: 995 } });
  });
});
