import { describe, expect, it } from "vitest";
import { buildDebtSnapshot, installmentPayments, personDirectPayable } from "./debt-position";
import { personPosition } from "./person-position";
import { cardInput, emiInput, flatSchedule, installment, loanInput, monthly, NOW, personInput } from "./debt-planner.fixtures";

/**
 * Debt Planner read model — every liability exactly once, receivables never, amounts straight from the
 * authoritative engines (outstanding principal, card standing, People position).
 */

const empty = { loans: [], emis: [], cards: [], people: [], now: NOW };

describe("buildDebtSnapshot — the canonical current debt", () => {
  it("reference scenario: ₹22,500 loan + ₹4,000 card + ₹2,000 person = ₹28,500, nothing duplicated", () => {
    // Loan ₹25,000 in 10 × ₹2,500, one paid.
    const loan = loanInput({ id: "personal-loan", installments: flatSchedule("pl", 25000, 10, new Date(2026, 8, 5), 1) });
    // Borrowed ₹3,000 from Amma, repaid ₹1,000 → ledger balance −₹2,000.
    const amma = personInput({ personId: "amma", name: "Amma", directBalance: -2000 });
    const snapshot = buildDebtSnapshot({
      ...empty,
      loans: [loan],
      cards: [cardInput({ id: "hdfc", outstanding: 4000 })],
      people: [amma],
    });
    expect(snapshot.positions.map((p) => [p.id, p.outstanding])).toEqual([
      ["loan:personal-loan", 22500],
      ["creditCard:hdfc", 4000],
      ["person:amma", 2000],
    ]);
    expect(snapshot.total).toBe(28500);
    expect(snapshot.byCategory).toEqual({ creditCards: 4000, loans: 22500, emis: 0, people: 2000 });
  });

  it("a Loan borrowed from a person is ONE debt — its legacy ledger entries never add a People debt", () => {
    // ₹5,000 borrowed from Amma as a Loan, ₹2,000 repaid. The old Loan form also posted ledger entries
    // stamped with the Loan id (borrowed −5,000, repaid +2,000) — they must not count again.
    const installments = flatSchedule("amma-loan", 5000, 5, new Date(2026, 5, 10), 2);
    const loan = loanInput({ id: "amma-loan", name: "Amma", category: "personal", personId: "amma", loanAmount: 5000, installments });
    const position = personPosition({
      personId: "amma",
      currentBalance: -3000,
      loans: [{ id: "amma-loan", personId: "amma", direction: "taken", outstandingPrincipal: loan.outstandingPrincipal, isDeleted: false }],
      ledgerEntries: [
        { transactionRef: "amma-loan", signedAmount: -5000, isDeleted: false },
        { transactionRef: "amma-loan", signedAmount: 2000, isDeleted: false },
      ],
      loanIds: new Set(["amma-loan"]),
    });
    const snapshot = buildDebtSnapshot({ ...empty, loans: [loan], people: [personInput({ personId: "amma", name: "Amma", ...position })] });
    expect(snapshot.positions).toHaveLength(1);
    expect(snapshot.positions[0]).toMatchObject({ id: "loan:amma-loan", outstanding: 3000, category: "people", kindLabel: "Borrowed from person" });
    expect(snapshot.total).toBe(3000);
  });

  it("a receivable is never debt: Amma owes me ₹3,000, a Loan I lent ₹8,000", () => {
    const snapshot = buildDebtSnapshot({
      ...empty,
      loans: [loanInput({ id: "lent", direction: "given", loanAmount: 8000, installments: flatSchedule("lent", 8000, 4, new Date(2026, 9, 5)) })],
      people: [personInput({ personId: "amma", directBalance: 3000 })],
    });
    expect(snapshot.positions).toEqual([]);
    expect(snapshot.total).toBe(0);
    expect(snapshot.receivables).toEqual({ lentLoans: 8000, people: 3000 });
  });

  it("a person's direct payable is net of other money they owe me (not of a Loan)", () => {
    expect(personDirectPayable(personInput({ personId: "x", directBalance: -3000, emiReceivable: 1000 }))).toBe(2000);
    expect(personDirectPayable(personInput({ personId: "x", directBalance: 2000, loanPayable: 5000 }))).toBe(0);
  });

  it("settled obligations drop out: fully paid loan, ₹0 card, ₹0 person", () => {
    const snapshot = buildDebtSnapshot({
      ...empty,
      loans: [loanInput({ id: "done", loanAmount: 6000, installments: flatSchedule("done", 6000, 3, new Date(2026, 3, 5), 3) })],
      cards: [cardInput({ id: "paid-card", outstanding: 0 })],
      people: [personInput({ personId: "settled" })],
    });
    expect(snapshot.positions).toEqual([]);
  });

  it("a card-linked EMI is counted once, on the card (outstanding + locked principal)", () => {
    const emi = emiInput({
      id: "phone",
      principalAmount: 18000,
      installments: flatSchedule("phone", 18000, 6, new Date(2026, 8, 12), 1),
      ownedByCardId: "hdfc",
    });
    const snapshot = buildDebtSnapshot({ ...empty, emis: [emi], cards: [cardInput({ id: "hdfc", outstanding: 5000, lockedEmiPrincipal: 15000 })] });
    expect(snapshot.positions).toHaveLength(1);
    const card = snapshot.positions[0];
    expect(card.outstanding).toBe(20000);
    expect(card.components.map((c) => c.amount)).toEqual([5000, 15000]);
    // The EMI's unpaid installments are the monthly amount the card will bill.
    expect(card.schedule.filter((s) => s.kind === "installment")).toHaveLength(5);
  });

  it("a card-linked EMI whose purchase is already on the card adds no installments (Case A)", () => {
    const emi = emiInput({ id: "tv", principalAmount: 12000, installments: flatSchedule("tv", 12000, 6, new Date(2026, 9, 12)), ownedByCardId: "hdfc", purchaseRepresented: true });
    const snapshot = buildDebtSnapshot({ ...empty, emis: [emi], cards: [cardInput({ id: "hdfc", outstanding: 12000 })] });
    expect(snapshot.total).toBe(12000);
    expect(snapshot.positions[0].schedule).toEqual([]);
  });

  it("a closed Loan with principal left stays in total debt (as Net Worth does) but is not projected", () => {
    const loan = loanInput({ id: "closed", isClosed: true, loanAmount: 10000, installments: flatSchedule("closed", 10000, 4, new Date(2026, 5, 5), 2) });
    const snapshot = buildDebtSnapshot({ ...empty, loans: [loan] });
    expect(snapshot.total).toBe(5000);
    expect(snapshot.positions[0].excludedFromPlan).toBe("Closed in FlowFi");
    expect(snapshot.positions[0].schedule).toEqual([]);
  });

  it("overdue and partially paid EMI installments", () => {
    const installments = [
      installment("e", 1, new Date(2026, 7, 10), 3000, 3000, 2500, 500),
      installment("e", 2, new Date(2026, 8, 10), 3000, 1000, 2500, 500), // partly paid, overdue
      installment("e", 3, new Date(2026, 9, 10), 3000, 0, 2600, 400),
    ];
    const emi = emiInput({ id: "e", principalAmount: 7600, interest: { type: "reducingBalance", ratePercent: 18, period: "yearly" }, installments });
    const [position] = buildDebtSnapshot({ ...empty, emis: [emi] }).positions;
    expect(position.status).toBe("overdue");
    expect(position.overdueAmount).toBe(2000);
    // ₹2,000 of ₹3,000 left → two-thirds of the ₹2,500 principal portion.
    expect(position.schedule[0]).toMatchObject({ amount: 2000, principal: 1666.67, interest: 333.33 });
    expect(position.installmentsPaid).toBe(1);
  });

  it("an advance payment already recorded is not owed again", () => {
    const installments = [installment("a", 1, new Date(2026, 9, 5), 2500, 2500), installment("a", 2, new Date(2026, 10, 5), 2500, 2500), installment("a", 3, new Date(2026, 11, 5), 2500)];
    expect(installmentPayments(installments, "Installment").map((p) => p.dueDate.getMonth())).toEqual([11]);
  });

  it("missing data is flagged, not invented", () => {
    const snapshot = buildDebtSnapshot({
      ...empty,
      loans: [loanInput({ id: "bank", installments: flatSchedule("bank", 25000, 10, monthly(new Date(2026, 9, 5), 0)) })],
      cards: [cardInput({ id: "hdfc", outstanding: 4000 })],
      people: [personInput({ personId: "amma", name: "Amma", directBalance: -4000 })],
    });
    const messages = snapshot.warnings.map((w) => w.message).join("\n");
    expect(messages).toContain("No interest terms recorded for bank");
    expect(messages).toContain("interest rate missing — card interest projection unavailable");
    expect(messages).toContain("no statement generated yet");
    expect(messages).toContain("owed to Amma has no repayment schedule");
    expect(snapshot.positions.find((p) => p.sourceType === "creditCard")?.interest).toEqual({ kind: "unknown", statedRatePercent: null });
  });

  it("card statement: minimum due tracked vs full statement due", () => {
    const withMin = buildDebtSnapshot({
      ...empty,
      cards: [cardInput({ id: "c", outstanding: 18420, statements: [{ id: "s1", dueDate: new Date(2026, 9, 12), totalAmount: 12000, amountPaid: 0, minimumDue: 1200 }] })],
    }).positions[0];
    expect(withMin.card).toMatchObject({ statementDue: 12000, minimumDue: 1200 });
    expect(withMin.schedule[0]).toMatchObject({ amount: 1200, label: "Minimum due" });

    const noMin = buildDebtSnapshot({
      ...empty,
      cards: [cardInput({ id: "c", outstanding: 5000, statements: [{ id: "s1", dueDate: new Date(2026, 9, 12), totalAmount: 5000, amountPaid: 2000, minimumDue: null }] })],
    }).positions[0];
    expect(noMin.card?.minimumDue).toBeNull();
    expect(noMin.schedule[0]).toMatchObject({ amount: 3000, label: "Statement due" });
  });
});
