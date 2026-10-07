import { describe, expect, it } from "vitest";
import type { CreditCardProfile } from "@/lib/models/credit-card";
import type { Transaction } from "@/lib/models/transaction";
import { cardBillsForCard, cardStatementPaymentScope, payBillAmount } from "./card-cycle-bills";

/**
 * Card "Pay bill" scope — the CARD's own statement cycle (statementDay 17 / paymentDueDay 5), never
 * Settings → Month Cycle, never the shared facility.
 */
const d = (m: number, day: number) => new Date(2026, m - 1, day, 12);
const NOW = d(11, 5);

function card(id: string, overrides: Partial<CreditCardProfile> = {}): CreditCardProfile {
  return {
    id,
    accountId: `acc-${id}`,
    sharedLimitId: null,
    statementDay: 17,
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
    createdAt: d(1, 1),
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    ...overrides,
  };
}

let seq = 0;
function txn(overrides: Partial<Transaction>): Transaction {
  seq += 1;
  return {
    id: `t-${seq}`,
    type: "expense",
    amount: 100,
    dateTime: d(9, 10),
    accountId: "acc-c1",
    categoryId: "cat-1",
    description: "",
    notes: "",
    receiptPurpose: null,
    transferId: null,
    excludeFromCalculations: false,
    accountingMonth: null,
    linkedPersonId: null,
    owesPersonToggle: false,
    createdAt: d(9, 10),
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

/** A bill payment: one transfer — bank expense leg + card income leg, sharing a transferId. */
function billPayment(amount: number, date: Date, cardAccount = "acc-c1") {
  const transferId = `tr-${(seq += 1)}`;
  return [
    txn({ type: "expense", amount, dateTime: date, accountId: "acc-sbi", transferId }),
    txn({ type: "income", amount, dateTime: date, accountId: cardAccount, transferId }),
  ];
}


/**
 * PERMANENT regression — card statementDay 17, paymentDueDay 5.
 * Closed cycle 18 Sep – 17 Oct (inclusive both ends), due 5 Nov. Today 5 Nov.
 * Closed purchases ₹10,000, ₹2,000 paid → ₹8,000 due. After close: ₹1,000 + ₹1,500 + ₹500 = ₹3,000.
 */
const C = card("c1");
const closed = [
  txn({ amount: 4000, dateTime: d(9, 18) }), // first day of the cycle
  txn({ amount: 3000, dateTime: d(10, 16) }), // day before close
  txn({ amount: 3000, dateTime: d(10, 17) }), // statement close day
];
const afterClose = [
  txn({ amount: 1000, dateTime: d(10, 18) }), // day immediately after close → next statement
  txn({ amount: 1500, dateTime: d(10, 25) }),
  txn({ amount: 500, dateTime: d(11, 2) }),
];
const base = [...closed, ...afterClose, ...billPayment(2000, d(10, 20))];
const scope = (all: Transaction[], now = NOW) =>
  cardStatementPaymentScope(cardBillsForCard(C, all.filter((t) => t.accountId === C.accountId), [], now));

describe("Card Pay bill — statement closing 17 Oct (permanent regression)", () => {
  it("boundary: 18 Sep–17 Oct is one bill due 5 Nov; 18 Oct starts the next — nothing double-counted or dropped", () => {
    const bills = cardBillsForCard(C, base, [], NOW);
    const closedBill = bills.find((b) => b.isClosed)!;
    expect(closedBill.periodStart).toEqual(new Date(2026, 8, 18));
    expect(closedBill.periodEnd).toEqual(new Date(2026, 9, 17));
    expect(closedBill.dueDate.getMonth()).toBe(10);
    expect(closedBill.dueDate.getDate()).toBe(5);
    expect(closedBill.totalAmount).toBe(10000);
    const open = bills.filter((b) => !b.isClosed);
    expect(open.reduce((s, b) => s + b.totalAmount, 0)).toBe(3000);
    expect(bills.reduce((s, b) => s + b.totalAmount, 0)).toBe(13000);
  });

  it("on the due date: Pay bill ₹8,000; full outstanding ₹11,000 only when explicit", () => {
    const s = scope(base);
    expect(s).toMatchObject({ statementDue: 8000, unbilled: 3000, cardOutstanding: 11000 });
    expect(payBillAmount(s, "statement", 11000)).toBe(8000);
    expect(payBillAmount(s, "full", 11000)).toBe(11000);
  });

  it("on the close day itself the cycle is still open — it becomes payable from 18 Oct", () => {
    const upTo17 = [...closed, ...billPayment(2000, d(10, 1))];
    expect(scope(upTo17, d(10, 17)).statementDue).toBe(0);
    expect(scope(upTo17, d(10, 18)).statementDue).toBe(8000);
  });

  it("partial ₹5,000 → ₹3,000 still due (not ₹6,000); then paid off → ₹3,000 stays next statement", () => {
    const p1 = billPayment(5000, d(11, 1));
    expect(scope([...base, ...p1])).toMatchObject({ statementDue: 3000, unbilled: 3000, cardOutstanding: 6000 });
    expect(payBillAmount(scope([...base, ...p1]), "statement", 6000)).toBe(3000);
    const paidOff = scope([...base, ...p1, ...billPayment(3000, d(11, 4))]);
    expect(paidOff).toMatchObject({ statementDue: 0, unbilled: 3000, cardOutstanding: 3000 });
    expect(payBillAmount(paidOff, "statement", 3000)).toBeUndefined();
  });

  it("after a normal ₹8,000 payment the ₹3,000 becomes the next bill only when its own cycle closes (17 Nov)", () => {
    const all = [...base, ...billPayment(8000, d(11, 5))];
    expect(scope(all)).toMatchObject({ statementDue: 0, unbilled: 3000 });
    expect(scope(all, d(11, 17)).statementDue).toBe(0);
    expect(scope(all, d(11, 18))).toMatchObject({ statementDue: 3000, unbilled: 0 });
  });

  it("edit ₹5,000 → ₹6,000 then revert", () => {
    const pay = billPayment(5000, d(11, 1));
    const edited = pay.map((t) => ({ ...t, amount: 6000 }));
    expect(scope([...base, ...edited])).toMatchObject({ statementDue: 2000, unbilled: 3000, cardOutstanding: 5000 });
    const reverted = edited.map((t) => ({ ...t, deletedAt: d(11, 5) }));
    expect(scope([...base, ...reverted])).toMatchObject({ statementDue: 8000, unbilled: 3000, cardOutstanding: 11000 });
  });

  it("several unpaid closed statements: allocation stays oldest first, but normal Pay bill = the OLDEST one only", () => {
    const all = [
      txn({ amount: 1000, dateTime: d(8, 10) }), // 18 Jul – 17 Aug
      txn({ amount: 2000, dateTime: d(9, 10) }), // 18 Aug – 17 Sep
      txn({ amount: 4000, dateTime: d(9, 20) }), // open at 1 Oct
    ];
    const s = scope(all, d(10, 1));
    // A. allocation engine: every closed unpaid statement, oldest due first.
    expect(s.statements.map((b) => b.remaining)).toEqual([1000, 2000]);
    expect(s).toMatchObject({ closedDue: 3000, unbilled: 4000, cardOutstanding: 7000 });
    // B. Pay Now product scope: ONE bill — the oldest; the later statement stays on the card.
    expect(s.statementDue).toBe(1000);
    expect(s.current?.remaining).toBe(1000);
    expect(s.later.map((b) => b.remaining)).toEqual([2000]);
    expect(payBillAmount(s, "statement", 7000)).toBe(1000);
  });
});
