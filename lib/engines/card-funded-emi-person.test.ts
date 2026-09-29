import { describe, expect, it } from "vitest";
import { creditCardStanding, creditUtilizationPercent, type UtilizationEmi } from "@/lib/engines/credit-utilization";
import { buildPersonCycleStatement, cycleContaining } from "@/lib/engines/person-cycle-statement";
import { emiReceivableThrough, personEmiObligations, type EmiObligationInstallment } from "@/lib/engines/person-emi-obligations";

/**
 * Card-funded EMI (no recorded purchase — Case B) assigned to a person:
 * ₹50,000 limit, ₹10,000 already used, ₹12,000 financed as 12 × ₹1,000.
 */
const d = (m: number, day: number, y = 2026) => new Date(y, m - 1, day);

const card = { id: "card1", statementDay: 5, creditLimit: 50_000, sharedLimitId: null };
const existingStatement = {
  id: "st1",
  periodStart: d(8, 6),
  periodEnd: d(9, 5),
  dueDate: d(9, 25),
  totalAmount: 10_000,
  amountPaid: 0,
  remainingAmount: 10_000,
  isPaid: false,
};
const emi: UtilizationEmi = { linkedCreditCardId: "card1", isClosed: false, principalAmount: 12_000, principalPaid: 0, purchaseRepresented: false };

/** 12 monthly ₹1,000 installments, first due 20 Oct 2026 (the first-installment date, not the purchase date). */
const installments: EmiObligationInstallment[] = Array.from({ length: 12 }, (_, i) => ({
  id: `i${i + 1}`,
  scheduleId: "S1",
  sequenceNumber: i + 1,
  dueDate: d(10 + i, 20),
  amountDue: 1_000,
  amountPaid: 0,
  isSkipped: false,
  deletedAt: null,
  createdAt: d(9, 28),
}));
const emiSource = (repays: boolean) => ({
  id: "emi1",
  name: "Phone on card",
  scheduleId: "S1",
  beneficiaryPersonId: "A",
  beneficiaryRepaysInstallments: repays,
  isClosed: false,
  deletedAt: null,
});

describe("card-funded EMI — card side (existing lock contract, no purchase transaction)", () => {
  it("₹50,000 limit / ₹10,000 used + ₹12,000 EMI → used ₹22,000, available ₹28,000, 44%", () => {
    const before = creditCardStanding({ card, statements: [existingStatement], currentCycleStatement: null, emis: [] });
    expect(before.outstanding).toBe(10_000);
    expect(before.available).toBe(40_000);

    const after = creditCardStanding({ card, statements: [existingStatement], currentCycleStatement: null, emis: [emi] });
    // Outstanding (billed) is unchanged — no fake purchase; the EMI is carried as locked principal.
    expect(after.outstanding).toBe(10_000);
    expect(after.lockedEmiPrincipal).toBe(12_000);
    expect(after.outstanding + after.lockedEmiPrincipal).toBe(22_000); // "Credit used"
    expect(after.available).toBe(28_000);
    expect(creditUtilizationPercent(after.outstanding + after.lockedEmiPrincipal, card.creditLimit)).toBeCloseTo(44, 5);
  });

  it("repaying ₹1,000 of principal on the EMI restores ₹1,000 of credit (paying the card/EMI, not the person)", () => {
    const paid = creditCardStanding({ card, statements: [existingStatement], currentCycleStatement: null, emis: [{ ...emi, principalPaid: 1_000 }] });
    expect(paid.lockedEmiPrincipal).toBe(11_000);
    expect(paid.available).toBe(29_000);
  });
});

describe("card-funded EMI — person side (shared obligation engine)", () => {
  it("association only ('Who is this for?') creates NO person obligation", () => {
    expect(personEmiObligations({ personId: "A", emis: [emiSource(false)], loans: [], installments })).toEqual([]);
  });

  it("with 'person repays the installments', each installment is owed on its own due date — never ₹12,000 at once", () => {
    const obligations = personEmiObligations({ personId: "A", emis: [emiSource(true)], loans: [], installments });
    expect(obligations).toHaveLength(12);
    expect(obligations.every((o) => o.amount === 1_000)).toBe(true);
    expect(emiReceivableThrough(obligations, d(9, 30))).toBe(0); // nothing due before the first installment date
    expect(emiReceivableThrough(obligations, d(10, 20))).toBe(1_000);
    expect(emiReceivableThrough(obligations, d(11, 20))).toBe(2_000);
  });

  const statementFor = (cycleDay: Date, repays = true) =>
    buildPersonCycleStatement({
      person: { id: "A", name: "Arun", openingBalance: 0, createdAt: d(1, 1) },
      ledgerEntries: [],
      loanIds: new Set(),
      emis: [emiSource(repays)],
      loans: [],
      installments,
      cycle: cycleContaining(cycleDay),
      now: d(10, 25),
    });

  it("the People cycle shows exactly the installment due in it (₹1,000), and the next cycle carries it forward", () => {
    const sep = statementFor(d(9, 28)); // 18 Sep – 17 Oct: nothing due yet
    expect(sep.cycleActivity).toBe(0);
    expect(sep.currentPending).toBe(0);

    const oct = statementFor(d(10, 28)); // 18 Oct – 17 Nov: installment #1 (20 Oct)
    expect(oct.cycleActivity).toBe(1_000);
    expect(oct.rows.filter((r) => r.category === "emi")).toHaveLength(1);
    expect(oct.currentPending).toBe(1_000);

    const nov = statementFor(d(11, 28)); // #2 (20 Nov) new; #1 unpaid carried as previous pending, not repeated
    expect(nov.previousPending).toBe(1_000);
    expect(nov.cycleActivity).toBe(1_000);
    expect(nov.rows.filter((r) => r.category === "emi")).toHaveLength(1);
    expect(nov.currentPending).toBe(2_000);
  });

  it("association only: the People statement stays at ₹0", () => {
    expect(statementFor(d(10, 28), false).currentPending).toBe(0);
  });

  it("the person repaying me reduces only the person side (the card lock is untouched)", () => {
    const repaid = buildPersonCycleStatement({
      person: { id: "A", name: "Arun", openingBalance: 0, createdAt: d(1, 1) },
      ledgerEntries: [
        {
          id: "r1", personId: "A", type: "receivedBack", amount: 1_000, date: d(10, 22), note: "EMI #1",
          increasesBalance: true, transactionRef: null, parentEntryId: null, createdAt: d(10, 22), deletedAt: null,
        },
      ],
      loanIds: new Set(),
      emis: [emiSource(true)],
      loans: [],
      installments,
      cycle: cycleContaining(d(10, 28)),
      now: d(10, 25),
    });
    expect(repaid.currentPending).toBe(0);
    // Card side is computed only from card statements + EMI principal paid to the bank — unchanged.
    expect(creditCardStanding({ card, statements: [existingStatement], currentCycleStatement: null, emis: [emi] }).available).toBe(28_000);
  });
});
