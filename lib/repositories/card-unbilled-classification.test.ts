import { describe, expect, it } from "vitest";
import { cardBillsDueInCycle, cardBillsForCard } from "@/lib/engines/card-cycle-bills";
import { creditCardStanding, emiPurchaseRepresentedOnCard } from "@/lib/engines/credit-utilization";
import type { CreditCardProfile } from "@/lib/models/credit-card";
import { balanceEffect, type Transaction } from "@/lib/models/transaction";
import {
  cardPaymentTotal,
  countsTowardCardStatement,
  settleCardPayments,
  statementPeriodTotal,
  unbilledSpendForCard,
} from "./credit-card-repository";

/**
 * Regression: `unbilledSpendForCard` used its own inclusion rule (everything except deleted rows and
 * bill-payment legs), so EXCLUDED card rows and OUTGOING transfer legs counted as unbilled card
 * liability while statement totals (`statementPeriodTotal`) and the card-EMI ownership rule
 * (`emiPurchaseRepresentedOnCard`, Case C) both treat them as NOT card liability. An excluded EMI
 * purchase was therefore counted twice (unbilled + EMI lock). All three now share
 * `countsTowardCardStatement`.
 */
const CARD_ACC = "card-acc";
let seq = 0;
const at = (day: number) => new Date(2026, 8, day, 12); // Sep 2026

function txn(overrides: Partial<Transaction>): Transaction {
  seq += 1;
  return {
    id: `t-${seq}`,
    type: "expense",
    amount: 0,
    dateTime: at(10),
    accountId: CARD_ACC,
    categoryId: "cat",
    description: "",
    notes: "",
    receiptPurpose: null,
    transferId: null,
    excludeFromCalculations: false,
    accountingMonth: null,
    linkedPersonId: null,
    owesPersonToggle: false,
    createdAt: at(10),
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

const card: CreditCardProfile = {
  id: "card-1",
  accountId: CARD_ACC,
  sharedLimitId: null,
  statementDay: 15,
  paymentDueDay: 5,
  creditLimit: 100000,
  minimumDuePercent: null,
  autoPay: false,
  status: "active",
  cardNetwork: null,
  lastFourDigits: "4242",
  issuer: null,
  annualFee: 0,
  joiningFee: 0,
  interestRatePercent: null,
  rewardNotes: null,
  autoDebitAccount: null,
  cardHolderName: null,
  createdAt: at(1),
  deletedAt: null,
  lastEditedAt: null,
  editHistory: [],
};

const normal = txn({ amount: 1000 });
const excluded = txn({ amount: 400, excludeFromCalculations: true });
const outgoingTransfer = txn({ amount: 300, transferId: "tr-out" });
const billPaymentLeg = txn({ type: "income", amount: 200, transferId: "tr-pay", dateTime: at(12) });
const deleted = txn({ amount: 900, deletedAt: at(11) });
const assignedToPerson = txn({ amount: 250, linkedPersonId: "p1" }); // full amount is card liability
const all = [normal, excluded, outgoingTransfer, billPaymentLeg, deleted, assignedToPerson];
const wholeSep = { periodStart: at(1), periodEnd: at(30) };

describe("countsTowardCardStatement — one rule for statement, unbilled and card-EMI ownership", () => {
  it.each([
    ["normal expense", normal, true],
    ["excluded expense", excluded, false],
    ["outgoing transfer leg", outgoingTransfer, false],
    ["bill payment (incoming transfer leg)", billPaymentLeg, false],
    ["deleted", deleted, false],
    ["person-assigned expense", assignedToPerson, true],
  ])("%s → %s", (_label, t, expected) => {
    expect(countsTowardCardStatement(t)).toBe(expected);
    // Agrees with the card-EMI ownership rule for a purchase on this card.
    expect(emiPurchaseRepresentedOnCard(t.id, t, CARD_ACC)).toBe(expected);
  });

  it("unbilled now equals the statement total over the same window (no double counting)", () => {
    expect(statementPeriodTotal(all, wholeSep)).toBe(1250);
    expect(unbilledSpendForCard(all, []).totalAmount).toBe(1250);
  });

  it("bill payment still settles; balance / utilization / outstanding stay coherent", () => {
    const settled = settleCardPayments([], unbilledSpendForCard(all, []).totalAmount, cardPaymentTotal(all));
    expect(settled.unbilledTotal).toBe(1050);
    const standing = creditCardStanding({
      card: { id: card.id, statementDay: 15, creditLimit: 100000, sharedLimitId: null },
      statements: [],
      currentCycleStatement: { periodStart: new Date(0), periodEnd: at(30), totalAmount: settled.unbilledTotal },
      emis: [],
    });
    expect(standing.outstanding).toBe(1050);
    expect(standing.available).toBe(98950);
    // Card account balance is unchanged by this fix (repository-maintained via balanceEffect):
    // excluded rows never moved it; the outgoing transfer leg did (it is a real movement, not a bill).
    const balance = all.filter((t) => t.deletedAt == null).reduce((s, t) => s + balanceEffect(t), 0);
    expect(balance).toBe(-1000 - 300 + 200 - 250);
  });

  it("an EXCLUDED EMI purchase is owned by the EMI lock only — not also by unbilled", () => {
    const emiPurchase = txn({ amount: 12000, excludeFromCalculations: true });
    const txns = [normal, emiPurchase];
    const unbilled = unbilledSpendForCard(txns, []).totalAmount;
    const standing = creditCardStanding({
      card: { id: card.id, statementDay: 15, creditLimit: 100000, sharedLimitId: null },
      statements: [],
      currentCycleStatement: { periodStart: new Date(0), periodEnd: at(30), totalAmount: unbilled },
      emis: [
        {
          linkedCreditCardId: card.id,
          isClosed: false,
          principalAmount: 12000,
          principalPaid: 0,
          purchaseRepresented: emiPurchaseRepresentedOnCard(emiPurchase.id, emiPurchase, CARD_ACC),
        },
      ],
    });
    expect(unbilled).toBe(1000);
    expect(standing.outstanding + standing.lockedEmiPrincipal).toBe(13000); // was 25000 before the fix
  });

  it("Month Cycle bills use the same rule as unbilled / statements", () => {
    const now = at(20);
    const bills = cardBillsForCard(card, all, [], now);
    const total = bills.reduce((s, b) => s + b.totalAmount, 0);
    expect(total).toBe(statementPeriodTotal(all, wholeSep));
    const owed = cardBillsDueInCycle(bills, { start: at(18), end: new Date(2026, 9, 17, 23, 59) }, now);
    expect(owed.reduce((s, b) => s + b.remaining, 0)).toBe(1250 - 200);
  });
});
