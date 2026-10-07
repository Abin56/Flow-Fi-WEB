import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {} }));

import type { CreditCardProfile, Statement } from "@/lib/models/credit-card";
import type { Transaction } from "@/lib/models/transaction";
import { cardBillsForCard, cardStatementPaymentScope } from "@/lib/engines/card-cycle-bills";
import { computeCreditCardStandings } from "./use-credit-cards-data";

/**
 * Two engines read one card: the standing (card outstanding / available / utilization) and the bill
 * scope (closed statements due + open-cycle spend, used by Pay bill and Month Cycle). This web app
 * almost never materializes statements, so stored statement history routinely has holes: spend before
 * the first stored statement, and closed cycles in between that were never saved. Neither engine may
 * drop that money, and the two must agree:
 *
 *   statement due + open-cycle spend = physical card outstanding
 *
 * Card: statementDay 16 / paymentDueDay 5 — cycles end on the 16th. Today 5 Nov 2026.
 */

const d = (m: number, day: number) => new Date(2026, m - 1, day, 12);
const NOW = d(11, 5);
let seq = 0;

const CARD: CreditCardProfile = {
  id: "visa",
  accountId: "acc-visa",
  sharedLimitId: null,
  statementDay: 16,
  paymentDueDay: 5,
  creditLimit: 100000,
  minimumDuePercent: null,
  autoPay: false,
  status: "active",
  cardNetwork: null,
  lastFourDigits: null,
  issuer: null,
  annualFee: 0,
  joiningFee: 0,
  interestRatePercent: null,
  rewardNotes: null,
  autoDebitAccount: null,
  cardHolderName: null,
  createdAt: d(1, 1),
  deletedAt: null,
  lastEditedAt: null,
  editHistory: [],
};

function txn(amount: number, dateTime: Date, overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: `t-${++seq}`,
    type: "expense",
    amount,
    dateTime,
    accountId: CARD.accountId,
    categoryId: "cat",
    description: "",
    notes: "",
    receiptPurpose: null,
    transferId: null,
    excludeFromCalculations: false,
    accountingMonth: null,
    linkedPersonId: null,
    owesPersonToggle: false,
    createdAt: dateTime,
    transferMatchedAt: null,
    loanId: null,
    emiId: null,
    installmentId: null,
    installmentPaymentId: null,
    paymentAllocationType: null,
    isPersonLedgerMovement: false,
    status: "posted",
    isBusiness: false,
    source: null,
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    ...overrides,
  };
}
const payment = (amount: number, date: Date) => txn(amount, date, { type: "income", transferId: `tr-${seq + 1}` });

function stored(id: string, periodStart: Date, periodEnd: Date, dueDate: Date, totalAmount: number): Statement {
  return {
    id,
    cardId: CARD.id,
    periodStart,
    periodEnd,
    generatedDate: periodEnd,
    dueDate,
    totalAmount,
    minimumDue: null,
    amountPaid: 0,
    interestCharged: null,
    lateFee: null,
    createdAt: periodEnd,
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
  } as Statement;
}

// Stored: 17 Jul – 16 Aug (due 5 Sep) and 17 Sep – 16 Oct (due 5 Nov). MISSING: 17 Aug – 16 Sep.
const STORED = [stored("s-jul-aug", d(7, 17), d(8, 16), d(9, 5), 2000), stored("s-sep-oct", d(9, 17), d(10, 16), d(11, 5), 8000)];
const PURCHASES = [
  txn(1000, d(7, 1)), // before the first stored statement (16 Jun – 16 Jul cycle, never saved)
  txn(2000, d(8, 12)), // inside stored Jul–Aug
  txn(1500, d(9, 1)), // the gap: Aug–Sep cycle has no stored statement
  txn(8000, d(10, 5)), // inside stored Sep–Oct
  txn(3000, d(10, 20)), // open cycle (17 Oct – 16 Nov)
];

function both(transactions: Transaction[]) {
  const [standing] = computeCreditCardStandings({ cards: [CARD], sharedLimits: [], statements: STORED, transactions, utilizationEmis: [], now: NOW });
  const scope = cardStatementPaymentScope(cardBillsForCard(CARD, transactions, STORED, NOW));
  return { standing, scope };
}

describe("card outstanding = closed-statement due + open-cycle spend, with gaps in stored statements", () => {
  it("no payments: ₹15,500 — pre-statement ₹1,000 and gap ₹1,500 are NOT dropped", () => {
    const { standing, scope } = both(PURCHASES);
    expect(scope).toMatchObject({ closedDue: 12500, unbilled: 3000, cardOutstanding: 15500 });
    expect(scope.statementDue).toBe(1000); // normal Pay Now = the oldest unpaid bill only
    expect(standing.ownOutstanding).toBe(15500);
    expect(standing.outstanding).toBe(15500);
  });

  it("closed statements listed oldest first, gap cycles derived, open cycle excluded", () => {
    const { scope } = both(PURCHASES);
    expect(scope.statements.map((s) => [s.isMaterialized, s.totalAmount])).toEqual([
      [false, 1000],
      [true, 2000],
      [false, 1500],
      [true, 8000],
    ]);
  });

  it.each([
    ["partial ₹2,500", [payment(2500, d(9, 3))], 10000, 3000],
    ["two partials ₹2,500 + ₹4,000", [payment(2500, d(9, 3)), payment(4000, d(11, 1))], 6000, 3000],
    ["all statements ₹12,500", [payment(12500, d(11, 5))], 0, 3000],
    ["full outstanding ₹15,500", [payment(15500, d(11, 5))], 0, 0],
    ["reverted payment", [{ ...payment(5000, d(11, 5)), deletedAt: NOW }], 12500, 3000],
  ])("%s keeps the invariant", (_label, payments, due, unbilled) => {
    const { standing, scope } = both([...PURCHASES, ...payments]);
    expect(scope.closedDue).toBe(due);
    expect(scope.unbilled).toBe(unbilled);
    expect(standing.ownOutstanding).toBe(scope.closedDue + scope.unbilled);
  });

  it("complete stored history (no gaps) — same invariant holds", () => {
    const complete = [txn(2000, d(8, 12)), txn(8000, d(10, 5)), txn(3000, d(10, 20)), payment(5000, d(11, 1))];
    const statements = [STORED[0], stored("s-aug-sep", d(8, 17), d(9, 16), d(10, 5), 0), STORED[1]];
    const [standing] = computeCreditCardStandings({ cards: [CARD], sharedLimits: [], statements, transactions: complete, utilizationEmis: [], now: NOW });
    const scope = cardStatementPaymentScope(cardBillsForCard(CARD, complete, statements, NOW));
    expect(scope).toMatchObject({ statementDue: 5000, unbilled: 3000 });
    expect(standing.ownOutstanding).toBe(8000);
  });
});
