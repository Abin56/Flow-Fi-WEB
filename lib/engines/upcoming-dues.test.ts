import { describe, expect, it } from "vitest";
import { computeUpcomingDues, type DueAgreementInput, type DueStatementInput } from "@/lib/engines/upcoming-dues";
import type { Installment } from "@/lib/models/payment-schedule";

const NOW = new Date(2026, 8, 26); // 26 Sep 2026
const day = (d: number, m = 8) => new Date(2026, m, d);

function inst(id: string, seq: number, dueDate: Date, amountDue: number, patch: Partial<Installment> = {}): Installment {
  return {
    id,
    scheduleId: "s",
    ownerType: "emi",
    ownerId: "o",
    sequenceNumber: seq,
    dueDate,
    amountDue,
    amountPaid: 0,
    isSkipped: false,
    principalPortion: null,
    interestPortion: null,
    createdAt: day(1, 0),
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    ...patch,
  };
}

function agreement(patch: Partial<DueAgreementInput>): DueAgreementInput {
  return {
    source: "loan",
    id: "a",
    title: "Agreement",
    providerName: null,
    borrowed: true,
    isClosed: false,
    installments: [],
    linkedCardLabel: null,
    purchaseRepresentedOnCard: false,
    forPersonName: null,
    ...patch,
  };
}

const statement = (patch: Partial<DueStatementInput> = {}): DueStatementInput => ({
  cardId: "card-1",
  cardLabel: "HDFC ••1234",
  statementId: "st-1",
  dueDate: day(5, 9),
  remainingAmount: 12000,
  isPaid: false,
  ...patch,
});

describe("computeUpcomingDues — sources", () => {
  it("My Loan: its installment is a Loan due", () => {
    const { items, totals } = computeUpcomingDues({
      statements: [],
      agreements: [agreement({ id: "home", title: "Home Loan", providerName: "SBI", installments: [inst("i1", 3, day(5, 9), 25000)] })],
      now: NOW,
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ source: "loan", title: "Home Loan", subtitle: "SBI", amount: 25000, installmentNumber: 3, countsTowardTotal: true, forPersonName: null });
    expect(totals).toMatchObject({ loan: 25000, emi: 0, creditCard: 0, total: 25000 });
  });

  it("My EMI: its installment is an EMI due", () => {
    const { totals, items } = computeUpcomingDues({
      statements: [],
      agreements: [agreement({ source: "emi", id: "tv", installments: [inst("i1", 1, day(1, 9), 3000)] })],
      now: NOW,
    });
    expect(items[0].source).toBe("emi");
    expect(totals).toMatchObject({ emi: 3000, total: 3000 });
  });

  it("a Credit Card statement is a Credit Card due; a paid one is not", () => {
    const { items, totals } = computeUpcomingDues({
      statements: [statement(), statement({ statementId: "st-0", isPaid: true, remainingAmount: 0 })],
      agreements: [],
      now: NOW,
    });
    expect(items.map((i) => i.key)).toEqual(["creditCard:st-1"]);
    expect(totals).toMatchObject({ creditCard: 12000, total: 12000 });
  });

  it("a lent Loan is a receivable, never a due", () => {
    const { items } = computeUpcomingDues({
      statements: [],
      agreements: [agreement({ borrowed: false, installments: [inst("i1", 1, day(1, 9), 5000)] })],
      now: NOW,
    });
    expect(items).toEqual([]);
  });

  it("a closed Loan/EMI has no dues", () => {
    const { items } = computeUpcomingDues({
      statements: [],
      agreements: [agreement({ isClosed: true, installments: [inst("i1", 1, day(1, 9), 5000)] })],
      now: NOW,
    });
    expect(items).toEqual([]);
  });
});

describe("computeUpcomingDues — For someone else", () => {
  it("Loan/EMI for another person is still my due, labelled with the person", () => {
    const { items, totals } = computeUpcomingDues({
      statements: [],
      agreements: [agreement({ source: "emi", id: "phone", forPersonName: "Rahul", installments: [inst("i1", 1, day(10, 9), 4000)] })],
      now: NOW,
    });
    expect(items[0]).toMatchObject({ forPersonName: "Rahul", countsTowardTotal: true });
    expect(totals.total).toBe(4000);
  });
});

describe("computeUpcomingDues — card-linked EMI never double counts", () => {
  it("Case B/C (no represented purchase): card due and EMI installment are separate obligations, each counted once", () => {
    // ₹80,000 limit card; ₹40,000 converted to EMI for Rahul, no purchase transaction on the card.
    const { items, totals } = computeUpcomingDues({
      statements: [statement({ remainingAmount: 12000 })],
      agreements: [
        agreement({
          source: "emi",
          id: "phone",
          title: "iPhone",
          linkedCardLabel: "HDFC ••1234",
          purchaseRepresentedOnCard: false,
          forPersonName: "Rahul",
          installments: [inst("i1", 1, day(5, 9), 40000 / 12)],
        }),
      ],
      now: NOW,
    });
    const emi = items.find((i) => i.source === "emi")!;
    expect(emi).toMatchObject({ cardLabel: "HDFC ••1234", forPersonName: "Rahul", countsTowardTotal: true });
    expect(totals.creditCard).toBe(12000);
    expect(totals.emi).toBe(3333.33);
    expect(totals.total).toBe(15333.33);
    expect(totals.includedInCardBills).toBe(0);
  });

  it("Case A (purchase already on the card statement): EMI installment is shown but not counted again", () => {
    const { items, totals } = computeUpcomingDues({
      statements: [statement({ remainingAmount: 40000 })],
      agreements: [
        agreement({
          source: "emi",
          id: "phone",
          linkedCardLabel: "HDFC ••1234",
          purchaseRepresentedOnCard: true,
          forPersonName: "Rahul",
          installments: [inst("i1", 1, day(5, 9), 3500)],
        }),
      ],
      now: NOW,
    });
    expect(items).toHaveLength(2);
    expect(items.find((i) => i.source === "emi")!.countsTowardTotal).toBe(false);
    expect(totals).toMatchObject({ creditCard: 40000, emi: 0, total: 40000, includedInCardBills: 3500 });
  });

  it("a card-funded Loan follows the same rule", () => {
    const { totals } = computeUpcomingDues({
      statements: [],
      agreements: [agreement({ linkedCardLabel: "Axis ••9", purchaseRepresentedOnCard: true, installments: [inst("i1", 1, day(1, 9), 2000)] })],
      now: NOW,
    });
    expect(totals).toMatchObject({ loan: 0, total: 0, includedInCardBills: 2000 });
  });

  it("represented-purchase flag without a tracked card is ignored (nothing on a card carries it)", () => {
    const { totals } = computeUpcomingDues({
      statements: [],
      agreements: [agreement({ linkedCardLabel: null, purchaseRepresentedOnCard: true, installments: [inst("i1", 1, day(1, 9), 2000)] })],
      now: NOW,
    });
    expect(totals.loan).toBe(2000);
  });
});

describe("computeUpcomingDues — window and installment state", () => {
  it("includes every overdue installment, excludes ones beyond the horizon, paid and skipped ones", () => {
    const { items, totals } = computeUpcomingDues({
      statements: [],
      agreements: [
        agreement({
          installments: [
            inst("jul", 1, day(26, 6), 1000),
            inst("aug", 2, day(26, 7), 1000, { amountPaid: 400 }),
            inst("sep", 3, day(20, 8), 1000, { amountPaid: 1000 }),
            inst("oct", 4, day(26, 9), 1000),
            inst("nov", 5, day(26, 10), 1000),
            inst("skip", 6, day(27, 8), 1000, { isSkipped: true }),
          ],
        }),
      ],
      now: NOW,
    });
    expect(items.map((i) => [i.key, i.amount, i.overdue])).toEqual([
      ["loan:a:jul", 1000, true],
      ["loan:a:aug", 600, true],
      ["loan:a:oct", 1000, false],
    ]);
    expect(totals).toMatchObject({ loan: 2600, total: 2600, overdue: 1600 });
  });

  it("sorts soonest first, card before loan before EMI on the same day", () => {
    const { items } = computeUpcomingDues({
      statements: [statement({ dueDate: day(5, 9) })],
      agreements: [
        agreement({ source: "emi", id: "e", installments: [inst("i", 1, day(5, 9), 1)] }),
        agreement({ id: "l", installments: [inst("i", 1, day(5, 9), 1)] }),
        agreement({ id: "early", installments: [inst("i", 1, day(1, 9), 1)] }),
      ],
      now: NOW,
    });
    expect(items.map((i) => i.key)).toEqual(["loan:early:i", "creditCard:st-1", "loan:l:i", "emi:e:i"]);
  });
});
