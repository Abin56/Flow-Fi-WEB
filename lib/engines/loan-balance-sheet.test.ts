import { describe, expect, it } from "vitest";
import { loanBalanceSheet, netWorthWithLoans } from "./loan-balance-sheet";
import { calculateNetWorth } from "./net-worth";
import { outstandingPrincipalAfterPrepaymentsFor, outstandingPrincipalFor, principalPrepaidFor } from "./loan-outstanding";
import { availableCredit, creditCardStanding, emiPrincipalRestored, emiPurchaseRepresentedOnCard } from "./credit-utilization";

describe("loanBalanceSheet — direction decides liability vs receivable (Reports fix C)", () => {
  it("borrowed principal is a liability; lent principal is a receivable, never a liability", () => {
    const sheet = loanBalanceSheet(
      [
        { direction: "taken", outstandingPrincipal: 10000 },
        { direction: "given", outstandingPrincipal: 25000 },
      ],
      [],
    );
    expect(sheet.borrowedPrincipal).toBe(10000);
    expect(sheet.lentPrincipal).toBe(25000);
  });

  it("an EMI owned by a tracked credit card is left out of the EMI liability (the card owns it)", () => {
    const sheet = loanBalanceSheet([], [
      { outstandingPrincipal: 30000, ownedByTrackedCard: false },
      { outstandingPrincipal: 60000, ownedByTrackedCard: true },
    ]);
    expect(sheet.emiPrincipal).toBe(30000);
    expect(sheet.cardOwnedEmiPrincipal).toBe(60000);
  });

  it("EMI liability is principal, not the remaining installment total with future interest", () => {
    // 12,000 at 12% over 12 → scheduled total > 12,000; nothing paid yet.
    const installments = Array.from({ length: 12 }, () => ({ amountDue: 1066.19, amountPaid: 0, isSkipped: false, principalPortion: 1000 }));
    expect(outstandingPrincipalFor(12000, installments)).toBe(12000);
    expect(installments.reduce((s, i) => s + i.amountDue, 0)).toBeGreaterThan(12000);
  });
});

describe("Net Worth (Decision 6) — documented before/after", () => {
  const accounts = [{ currentBalance: 60000 }, { currentBalance: -5000 /* credit-card account */ }];

  it("BEFORE: Net Worth was only the sum of account balances", () => {
    expect(calculateNetWorth(accounts)).toBe(55000);
  });

  it("AFTER: + principal owed to me − loan/EMI principal I owe (card debt already in the card account)", () => {
    const sheet = loanBalanceSheet(
      [
        { direction: "taken", outstandingPrincipal: 10000 },
        { direction: "given", outstandingPrincipal: 25000 },
      ],
      [
        { outstandingPrincipal: 30000, ownedByTrackedCard: false },
        { outstandingPrincipal: 60000, ownedByTrackedCard: true },
      ],
    );
    expect(netWorthWithLoans(calculateNetWorth(accounts), sheet)).toBe(55000 + 25000 - 10000 - 30000);
  });

  it("Invariant 1: borrowing ₹10,000 into an account leaves Net Worth unchanged", () => {
    const before = netWorthWithLoans(50000, loanBalanceSheet([], []));
    const after = netWorthWithLoans(60000, loanBalanceSheet([{ direction: "taken", outstandingPrincipal: 10000 }], []));
    expect(after).toBe(before);
  });

  it("Invariant 2: lending ₹10,000 out of an account leaves Net Worth unchanged", () => {
    const before = netWorthWithLoans(50000, loanBalanceSheet([], []));
    const after = netWorthWithLoans(40000, loanBalanceSheet([{ direction: "given", outstandingPrincipal: 10000 }], []));
    expect(after).toBe(before);
  });

  it("Invariant 3: repaying ₹4,000 of borrowed principal leaves Net Worth unchanged (cash −4,000, liability −4,000)", () => {
    const before = netWorthWithLoans(60000, loanBalanceSheet([{ direction: "taken", outstandingPrincipal: 10000 }], []));
    const after = netWorthWithLoans(56000, loanBalanceSheet([{ direction: "taken", outstandingPrincipal: 6000 }], []));
    expect(after).toBe(before);
  });
});

describe("Decision 5 — extra principal derived from payment records", () => {
  const p = (over: Partial<Parameters<typeof principalPrepaidFor>[0][number]>) => ({ allocationType: "principalPrepayment", prepaymentPrincipalAmount: 3000, amount: 3000, deletedAt: null, ...over });

  it("sums only active principalPrepayment records", () => {
    expect(principalPrepaidFor([p({}), p({ prepaymentPrincipalAmount: 2000, amount: 2000 }), p({ deletedAt: new Date() }), p({ allocationType: "regularEmi" })])).toBe(5000);
  });

  it("₹10,000 − ₹5,000 extra principal = ₹5,000 remaining — never more", () => {
    const untouched = Array.from({ length: 10 }, () => ({ amountDue: 1000, amountPaid: 0, isSkipped: false, principalPortion: null }));
    expect(outstandingPrincipalAfterPrepaymentsFor(10000, untouched, 5000)).toBe(5000);
  });
});

describe("Credit-card EMI — the card owns the liability (Decision 3), numeric", () => {
  const card = { id: "hdfc", statementDay: 1, creditLimit: 100000 };
  const emi = (principalPaid: number) => ({ linkedCreditCardId: "hdfc", isClosed: false, principalAmount: 60000, principalPaid });

  it("Case B (issuer converted the purchase; not on a statement): exposure ₹60,000 once, available ₹40,000", () => {
    const standing = creditCardStanding({ card, statements: [], currentCycleStatement: null, emis: [emi(0)] });
    expect(standing.available).toBe(40000);
    expect(standing.outstanding + standing.lockedEmiPrincipal).toBe(60000);
  });

  it("Case B after ₹5,000 of EMI principal repaid: locked ₹55,000, available ₹45,000", () => {
    const standing = creditCardStanding({ card, statements: [], currentCycleStatement: null, emis: [emi(5000)] });
    expect(standing.lockedEmiPrincipal).toBe(55000);
    expect(standing.available).toBe(45000);
  });

  it("Reports: a tracked-card EMI appears once — on the Credit Cards line, not also under EMIs", () => {
    const standing = creditCardStanding({ card, statements: [], currentCycleStatement: null, emis: [emi(0)] });
    const sheet = loanBalanceSheet([], [{ outstandingPrincipal: 60000, ownedByTrackedCard: true }]);
    const creditCardsLine = standing.outstanding + standing.lockedEmiPrincipal;
    expect(creditCardsLine + sheet.emiPrincipal).toBe(60000);
  });

  // Formerly the pinned BLOCKER (`it.fails`): now fixed by `purchaseTransactionId` — the linked,
  // still-represented purchase owns the exposure, so the EMI stops locking the same ₹60,000.
  it("Case A (purchase on the card statement, linked via purchaseTransactionId): exposure ₹60,000, not ₹1,20,000", () => {
    const statement = { id: "s1", periodStart: new Date(2026, 7, 1), periodEnd: new Date(2026, 7, 31), dueDate: new Date(2026, 8, 20), totalAmount: 60000, amountPaid: 0, remainingAmount: 60000, isPaid: false };
    const purchase = { id: "p1", accountId: "hdfc-acct", deletedAt: null, excludeFromCalculations: false, transferId: null };
    const linked = { ...emi(0), purchaseRepresented: emiPurchaseRepresentedOnCard("p1", purchase, "hdfc-acct") };
    const standing = creditCardStanding({ card, statements: [statement], currentCycleStatement: null, emis: [linked] });
    expect(standing.outstanding + standing.lockedEmiPrincipal).toBe(60000);
    expect(standing.available).toBe(40000);
  });

  it("the unlinked version of the same data still counts both — never auto-linked by amount/date", () => {
    const statement = { id: "s1", periodStart: new Date(2026, 7, 1), periodEnd: new Date(2026, 7, 31), dueDate: new Date(2026, 8, 20), totalAmount: 60000, amountPaid: 0, remainingAmount: 60000, isPaid: false };
    const standing = creditCardStanding({ card, statements: [statement], currentCycleStatement: null, emis: [emi(0)] });
    expect(standing.outstanding + standing.lockedEmiPrincipal).toBe(120000);
  });

  describe("emiPurchaseRepresentedOnCard — Case A only while the purchase is really in the card's liability", () => {
    const base = { id: "p1", accountId: "hdfc-acct", deletedAt: null as Date | null, excludeFromCalculations: false, transferId: null as string | null };
    it("A: active, calculable purchase on this card's account", () => expect(emiPurchaseRepresentedOnCard("p1", base, "hdfc-acct")).toBe(true));
    it("B: no link", () => expect(emiPurchaseRepresentedOnCard(null, base, "hdfc-acct")).toBe(false));
    it("C: linked purchase deleted/reversed (absent from active transactions)", () => expect(emiPurchaseRepresentedOnCard("p1", null, "hdfc-acct")).toBe(false));
    it("C: linked purchase soft-deleted", () => expect(emiPurchaseRepresentedOnCard("p1", { ...base, deletedAt: new Date() }, "hdfc-acct")).toBe(false));
    it("C: excluded from calculations (not in the statement total)", () => expect(emiPurchaseRepresentedOnCard("p1", { ...base, excludeFromCalculations: true }, "hdfc-acct")).toBe(false));
    it("C: a transfer leg (not in the statement total)", () => expect(emiPurchaseRepresentedOnCard("p1", { ...base, transferId: "x" }, "hdfc-acct")).toBe(false));
    it("C: posted to a different account", () => expect(emiPurchaseRepresentedOnCard("p1", base, "other-acct")).toBe(false));
  });

  it("emiPrincipalRestored: breakdown first, else the principal share (Flutter parity)", () => {
    const installments = [{ id: "i1", amountDue: 1000, principalPortion: 800 }, { id: "i2", amountDue: 1000, principalPortion: null }];
    const payments = [
      { id: "a", installmentId: "i1", amount: 1000, deletedAt: null },
      { id: "b", installmentId: "i1", amount: 500, deletedAt: null },
      { id: "c", installmentId: "i2", amount: 300, deletedAt: null },
      { id: "d", installmentId: "i2", amount: 999, deletedAt: new Date() },
    ];
    expect(emiPrincipalRestored(installments, payments, new Map([["a", 850]]))).toBe(850 + 400 + 300);
  });

  it("availableCredit never goes below 0 or above the limit", () => {
    expect(availableCredit({ creditLimit: 100000, outstanding: 60000, linkedEmiPrincipal: 60000, principalRestored: 0 })).toBe(0);
  });
});
