import { describe, expect, it } from "vitest";
import { availableCredit, cardOwnStanding } from "@/lib/engines/credit-utilization";
import { statementRemainingAmount, statementStatus, type Statement } from "@/lib/models/credit-card";
import { balanceEffect, type Transaction } from "@/lib/models/transaction";
import {
  cardPaymentTotal,
  settleCardPayments,
  statementPeriodTotal,
  unbilledSpendForCard,
} from "./credit-card-repository";

/**
 * Credit-card bill payment (SBI → card). The payment is a `createTransferPair`: an expense leg on
 * the bank account and an income leg on the card account sharing a `transferId`. Regression for the
 * bug where `unbilledSpendForCard` summed that income leg as *more* card spend (outstanding went UP
 * by the payment) and nothing ever settled the bill.
 */
const CARD = "card-acc";
const SBI = "sbi-acc";
let seq = 0;

function txn(overrides: Partial<Transaction>): Transaction {
  return {
    id: `t-${++seq}`,
    type: "expense",
    amount: 0,
    dateTime: new Date("2026-09-10T00:00:00Z"),
    accountId: CARD,
    categoryId: "cat",
    description: "",
    notes: "",
    receiptPurpose: null,
    transferId: null,
    excludeFromCalculations: false,
    accountingMonth: null,
    linkedPersonId: null,
    owesPersonToggle: false,
    createdAt: new Date("2026-09-10T00:00:00Z"),
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

const purchase = (amount: number, date = "2026-09-10") => txn({ amount, dateTime: new Date(`${date}T00:00:00Z`) });

/** Both legs of an SBI → card payment, as `createTransferPair` writes them. */
function payment(amount: number, date = "2026-09-20") {
  const transferId = `tr-${++seq}`;
  const dateTime = new Date(`${date}T00:00:00Z`);
  return {
    sbiLeg: txn({ type: "expense", amount, accountId: SBI, transferId, dateTime }),
    cardLeg: txn({ type: "income", amount, accountId: CARD, transferId, dateTime }),
  };
}

function statement(totalAmount: number, periodStart: string, periodEnd: string, dueDate: string): Statement {
  return {
    id: `s-${++seq}`,
    cardId: "card",
    periodStart: new Date(`${periodStart}T00:00:00Z`),
    periodEnd: new Date(`${periodEnd}T00:00:00Z`),
    generatedDate: new Date(`${periodEnd}T00:00:00Z`),
    dueDate: new Date(`${dueDate}T00:00:00Z`),
    totalAmount,
    minimumDue: null,
    amountPaid: 0,
    interestCharged: null,
    lateFee: null,
    createdAt: new Date(),
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
  };
}

/** Same composition `useCreditCardStandings` does for a standalone card. */
function standing(cardTxns: Transaction[], statements: Statement[], creditLimit: number) {
  const live = statements.map((s) => ({ ...s, totalAmount: statementPeriodTotal(cardTxns, s) }));
  const unbilled = unbilledSpendForCard(cardTxns, statements);
  const settled = settleCardPayments(live, unbilled.totalAmount, cardPaymentTotal(cardTxns));
  const own = cardOwnStanding(
    { id: "card", statementDay: 1, creditLimit, sharedLimitId: null },
    settled.statements.map((s) => ({
      ...s,
      remainingAmount: statementRemainingAmount(s),
      isPaid: statementStatus(s) === "paid",
    })),
    { ...unbilled, totalAmount: settled.unbilledTotal },
  );
  return {
    ...own,
    statements: settled.statements,
    available: availableCredit({ creditLimit, outstanding: own.outstanding, linkedEmiPrincipal: 0, principalRestored: 0 }),
  };
}

describe("credit card bill payment", () => {
  it("full payment: SBI -2000, bill settled, outstanding 0, no reverse/duplicate movement", () => {
    const p = payment(2000);
    const sbiBalance = 10000 + balanceEffect(p.sbiLeg);
    expect(sbiBalance).toBe(8000);

    // Unbilled (no statement materialized) — the common case in this app.
    const s = standing([purchase(2000), p.cardLeg], [], 50000);
    expect(s.outstanding).toBe(0);
    expect(s.available).toBe(50000);

    // Materialized statement.
    const bill = statement(0, "2026-08-01", "2026-09-15", "2026-10-05");
    const withBill = standing([purchase(2000), p.cardLeg], [bill], 50000);
    expect(withBill.statements[0].amountPaid).toBe(2000);
    expect(statementRemainingAmount(withBill.statements[0])).toBe(0);
    expect(statementStatus(withBill.statements[0])).toBe("paid");
    expect(withBill.outstanding).toBe(0);
  });

  it("the payment leg is never counted as card spend", () => {
    const p = payment(2000);
    expect(unbilledSpendForCard([purchase(2000), p.cardLeg], []).totalAmount).toBe(2000);
    expect(cardPaymentTotal([purchase(2000), p.cardLeg])).toBe(2000);
  });

  it("partial payment: 5000 bill, 2000 paid → 3000 remaining, partially paid", () => {
    const p = payment(2000);
    const bill = statement(0, "2026-08-01", "2026-09-15", "2026-10-05");
    const s = standing([purchase(5000), p.cardLeg], [bill], 50000);
    expect(s.statements[0].amountPaid).toBe(2000);
    expect(statementRemainingAmount(s.statements[0])).toBe(3000);
    expect(statementStatus(s.statements[0])).toBe("partiallyPaid");
    expect(s.outstanding).toBe(3000);
    expect(s.available).toBe(47000);
  });

  it("multiple payments: 2000 + 3000 against 5000 → settled", () => {
    const bill = statement(0, "2026-08-01", "2026-09-15", "2026-10-05");
    const s = standing([purchase(5000), payment(2000).cardLeg, payment(3000, "2026-09-25").cardLeg], [bill], 50000);
    expect(s.statements[0].amountPaid).toBe(5000);
    expect(statementStatus(s.statements[0])).toBe("paid");
    expect(s.outstanding).toBe(0);
  });

  it("available credit: limit 50000, used 10000, pay 2000 → used 8000, available 42000", () => {
    const s = standing([purchase(10000), payment(2000).cardLeg], [], 50000);
    expect(s.outstanding).toBe(8000);
    expect(s.available).toBe(42000);
  });

  it("settles oldest statement first, then new unbilled spend", () => {
    const old = statement(0, "2026-07-01", "2026-07-31", "2026-08-20");
    const txns = [purchase(1000, "2026-07-10"), purchase(4000, "2026-09-10"), payment(3000).cardLeg];
    const s = standing(txns, [old], 50000);
    expect(statementStatus(s.statements[0])).toBe("paid");
    expect(s.currentCycleSpend).toBe(2000);
    expect(s.outstanding).toBe(2000);
  });

  it("deleted payment no longer settles the bill", () => {
    const p = payment(2000);
    const s = standing([purchase(2000), { ...p.cardLeg, deletedAt: new Date() }], [], 50000);
    expect(s.outstanding).toBe(2000);
  });
});
