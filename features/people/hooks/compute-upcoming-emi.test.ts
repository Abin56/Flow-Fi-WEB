import { describe, expect, it } from "vitest";
import type { Loan } from "@/lib/models/loan";
import type { Installment } from "@/lib/models/payment-schedule";
import { computeUpcomingEmi } from "./compute-upcoming-emi";

/**
 * Regression coverage for the "Upcoming EMI" reminder on a Person's page —
 * mirrors the Flutter app's `PersonLoansSummaryCard`. Covers the 3 cases
 * from the Loans hardening request: a loan this person only pays (Case 1,
 * `payerPersonId`), a personal loan this person lent/owes (Case 2,
 * `personId`), and that a closed loan or one with no unpaid installment
 * never surfaces a reminder.
 */

function loan(overrides: Partial<Loan> = {}): Loan {
  return {
    id: "loan-1",
    personId: null,
    direction: "taken",
    category: "institutional",
    institutionName: "HDFC Bank",
    name: null,
    loanAmount: 1000,
    interest: null,
    loanDate: new Date("2026-01-01T00:00:00.000Z"),
    repaymentType: "installment",
    dueDate: null,
    installmentFrequency: "monthly",
    installmentCount: 3,
    notes: "",
    scheduleId: "sched-1",
    isClosed: false,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    ...overrides,
  };
}

function installment(overrides: Partial<Installment> = {}): Installment {
  return {
    id: "inst-1",
    scheduleId: "sched-1",
    ownerType: "loan",
    ownerId: "loan-1",
    sequenceNumber: 1,
    dueDate: new Date("2026-02-01T00:00:00.000Z"),
    amountDue: 100,
    amountPaid: 0,
    isSkipped: false,
    principalPortion: null,
    interestPortion: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    ...overrides,
  };
}

describe("computeUpcomingEmi", () => {
  it("Case 1: finds a loan this person only pays (payerPersonId), tagged isPayerOnly", () => {
    const items = computeUpcomingEmi(
      [loan({ id: "l1", personId: null, payerPersonId: "friend-1", scheduleId: "s1" })],
      [installment({ scheduleId: "s1", dueDate: new Date("2026-03-01T00:00:00.000Z") })],
      "friend-1",
    );
    expect(items).toHaveLength(1);
    expect(items[0].isPayerOnly).toBe(true);
    expect(items[0].label).toBe("HDFC Bank");
  });

  it("Case 2: finds a personal loan this person is the lender/counterparty for (personId), not tagged isPayerOnly", () => {
    const items = computeUpcomingEmi(
      [loan({ id: "l2", category: "personal", personId: "friend-2", institutionName: null, scheduleId: "s2" })],
      [installment({ scheduleId: "s2" })],
      "friend-2",
    );
    expect(items).toHaveLength(1);
    expect(items[0].isPayerOnly).toBe(false);
  });

  it("excludes a closed loan even if it still has an unpaid installment", () => {
    const items = computeUpcomingEmi(
      [loan({ id: "l3", payerPersonId: "friend-1", scheduleId: "s3", isClosed: true })],
      [installment({ scheduleId: "s3" })],
      "friend-1",
    );
    expect(items).toHaveLength(0);
  });

  it("excludes a loan with no unpaid installment (fully paid)", () => {
    const items = computeUpcomingEmi(
      [loan({ id: "l4", payerPersonId: "friend-1", scheduleId: "s4" })],
      [installment({ scheduleId: "s4", amountPaid: 100 })],
      "friend-1",
    );
    expect(items).toHaveLength(0);
  });

  it("excludes a loan not connected to this person at all", () => {
    const items = computeUpcomingEmi(
      [loan({ id: "l5", personId: "someone-else", scheduleId: "s5" })],
      [installment({ scheduleId: "s5" })],
      "friend-1",
    );
    expect(items).toHaveLength(0);
  });

  it("sorts multiple upcoming EMIs soonest due date first", () => {
    const items = computeUpcomingEmi(
      [
        loan({ id: "l6", payerPersonId: "friend-1", scheduleId: "s6", name: "Later Loan" }),
        loan({ id: "l7", payerPersonId: "friend-1", scheduleId: "s7", name: "Sooner Loan" }),
      ],
      [
        installment({ scheduleId: "s6", dueDate: new Date("2026-05-01T00:00:00.000Z") }),
        installment({ scheduleId: "s7", dueDate: new Date("2026-02-01T00:00:00.000Z") }),
      ],
      "friend-1",
    );
    expect(items.map((i) => i.label)).toEqual(["Sooner Loan", "Later Loan"]);
  });
});
