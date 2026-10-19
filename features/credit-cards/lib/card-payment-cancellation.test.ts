import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {} }));

import type { Account } from "@/lib/models/account";
import type { CreditCardProfile, SharedCreditLimit } from "@/lib/models/credit-card";
import type { Transaction } from "@/lib/models/transaction";
import { cardPaymentCancellationLines, cardPaymentCancellationPreview, type CardPaymentCancellationInput } from "./card-payment-cancellation";

/**
 * The read-only preflight/preview behind "Cancel recorded payment". Card closes on the 16th, due the 5th: the
 * ₹8,000 purchase on 20 Sep is in the statement that closed 16 Oct (due 5 Nov); "now" is 20 Oct.
 */

const d = (m: number, day: number) => new Date(2026, m - 1, day, 12);
const NOW = d(10, 20);
let seq = 0;

function card(id: string, overrides: Partial<CreditCardProfile> = {}): CreditCardProfile {
  return {
    id, accountId: `acc-${id}`, sharedLimitId: null, statementDay: 16, paymentDueDay: 5, creditLimit: 100000,
    minimumDuePercent: null, autoPay: false, status: "active", cardNetwork: null, lastFourDigits: null, issuer: null,
    annualFee: 0, joiningFee: 0, interestRatePercent: null, rewardNotes: null, autoDebitAccount: null, cardHolderName: null,
    createdAt: d(1, 1), deletedAt: null, lastEditedAt: null, editHistory: [], ...overrides,
  } as CreditCardProfile;
}

function account(id: string, type: "bank" | "card", currentBalance: number, name = id): Account {
  return { id, name, type, currentBalance, openingBalance: 0, deletedAt: null } as Account;
}

function txn(accountId: string, type: "expense" | "income", amount: number, dateTime: Date, o: Partial<Transaction> = {}): Transaction {
  return {
    id: `t-${++seq}`, type, amount, dateTime, accountId, categoryId: "c", description: "", notes: "", receiptPurpose: null,
    transferId: null, excludeFromCalculations: false, accountingMonth: null, linkedPersonId: null, owesPersonToggle: false,
    createdAt: dateTime, transferMatchedAt: null, loanId: null, emiId: null, installmentId: null, installmentPaymentId: null,
    paymentAllocationType: null, isPersonLedgerMovement: false, status: "posted", isBusiness: false, source: null,
    deletedAt: null, lastEditedAt: null, editHistory: [], ...o,
  } as Transaction;
}

/** A bill payment pair: bank expense leg + card income leg. */
function payment(transferId: string, bankAccountId: string, cardAccountId: string, amount: number) {
  const out = txn(bankAccountId, "expense", amount, d(10, 18), { id: `${transferId}-out`, transferId });
  const inn = txn(cardAccountId, "income", amount, d(10, 18), { id: `${transferId}-in`, transferId });
  return { out, inn };
}

function setup(paid: number[] = [3000, 2000]) {
  const c = card("a");
  const purchase = txn(c.accountId, "expense", 8000, d(9, 20));
  const pays = paid.map((amt, i) => payment(`tr${i}`, "bank", c.accountId, amt));
  const input: CardPaymentCancellationInput = {
    transactionId: "",
    transactions: [purchase, ...pays.flatMap((p) => [p.out, p.inn])],
    accounts: [account("bank", "bank", 40000, "SBI"), account(c.accountId, "card", 0, "HDFC")],
    cards: [c],
    sharedLimits: [],
    statements: [],
    utilizationEmis: [],
    now: NOW,
  };
  return { c, pays, input };
}

const money = (n: number) => `₹${n}`;

describe("cardPaymentCancellationPreview", () => {
  it("one of two partial payments: only that payment is reversed, the other stays", () => {
    const { pays, input } = setup([3000, 2000]);
    const p = cardPaymentCancellationPreview({ ...input, transactionId: pays[0].inn.id });
    expect(p.state).toBe("ready");
    expect(p.amount).toBe(3000);
    expect(p.cardLegId).toBe(pays[0].inn.id);
    expect(p.statementDue).toEqual({ before: 3000, after: 6000 }); // 8000 − 5000 paid → 8000 − 2000 paid
    expect(p.outstanding).toEqual({ before: 3000, after: 6000 });
    expect(p.paidFrom).toEqual({ accountId: "bank", name: "SBI", before: 40000, after: 43000 }); // money back in the bank
    expect(p.otherPaymentCount).toBe(1);
  });

  it("either leg yields the same preview, and nothing in the input is mutated", () => {
    const { pays, input } = setup([3000]);
    const before = JSON.stringify(input.transactions);
    const viaCard = cardPaymentCancellationPreview({ ...input, transactionId: pays[0].inn.id });
    const viaBank = cardPaymentCancellationPreview({ ...input, transactionId: pays[0].out.id });
    expect(viaBank).toEqual(viaCard);
    expect(JSON.stringify(input.transactions)).toBe(before);
  });

  it("full payment: bill returns to the full amount", () => {
    const { pays, input } = setup([8000]);
    const p = cardPaymentCancellationPreview({ ...input, transactionId: pays[0].inn.id });
    expect(p.statementDue).toEqual({ before: 0, after: 8000 });
    const lines = cardPaymentCancellationLines(p, money);
    expect(lines).toContain("Bill due: ₹0 → ₹8000");
    expect(lines).toContain("SBI balance: ₹40000 → ₹48000");
    expect(lines.some((l) => l.startsWith("Available credit"))).toBe(true);
  });

  it("shared limit: available credit is the facility's, and the card's sibling is untouched", () => {
    const shared: SharedCreditLimit = { id: "s1", name: "Pool", creditLimit: 100000, deletedAt: null } as SharedCreditLimit;
    const a = card("a", { sharedLimitId: "s1" });
    const b = card("b", { sharedLimitId: "s1", accountId: "acc-b" });
    const purchaseA = txn(a.accountId, "expense", 8000, d(9, 20));
    const purchaseB = txn(b.accountId, "expense", 5000, d(9, 20));
    const pay = payment("tr", "bank", a.accountId, 8000);
    const p = cardPaymentCancellationPreview({
      transactionId: pay.inn.id,
      transactions: [purchaseA, purchaseB, pay.out, pay.inn],
      accounts: [account("bank", "bank", 10000, "SBI"), account(a.accountId, "card", 0, "A"), account(b.accountId, "card", 0, "B")],
      cards: [a, b],
      sharedLimits: [shared],
      statements: [],
      utilizationEmis: [],
      now: NOW,
    });
    expect(p.state).toBe("ready");
    expect(p.sharedLimit).toBe(true);
    expect(p.available).toEqual({ before: 95000, after: 87000 });
    expect(p.outstanding).toEqual({ before: 0, after: 8000 }); // card B's ₹5,000 is not part of A's own figure
  });

  it("a fee that travels with the payment is returned to the paying account too", () => {
    const { pays, input } = setup([3000]);
    const fee = txn("bank", "expense", 20, d(10, 18), { id: "tr0_fee", transferFeeForId: "tr0" });
    const p = cardPaymentCancellationPreview({ ...input, transactions: [...input.transactions, fee], transactionId: pays[0].inn.id });
    expect(p.feeAmount).toBe(20);
    expect(p.paidFrom).toEqual({ accountId: "bank", name: "SBI", before: 40000, after: 43020 });
  });

  it("already cancelled → gone, nothing to reverse a second time", () => {
    const { pays, input } = setup([3000]);
    const gone = input.transactions.map((t) => (t.transferId === "tr0" ? { ...t, deletedAt: d(10, 19) } : t));
    const p = cardPaymentCancellationPreview({ ...input, transactions: gone, transactionId: pays[0].inn.id });
    expect(p.state).toBe("gone");
    expect(cardPaymentCancellationLines(p, money)).toEqual([]);
  });

  it("a leg handed to People or Loan & EMI blocks, naming the owner", () => {
    const { pays, input } = setup([3000]);
    const owned = input.transactions.map((t) => (t.id === pays[0].out.id ? { ...t, loanId: "loan-1" } : t));
    const p = cardPaymentCancellationPreview({ ...input, transactions: owned, transactionId: pays[0].inn.id });
    expect(p.state).toBe("blocked");
    expect(p.blockedReason).toMatch(/Loan & EMI/);
    const people = input.transactions.map((t) => (t.id === pays[0].out.id ? { ...t, isPersonLedgerMovement: true } : t));
    expect(cardPaymentCancellationPreview({ ...input, transactions: people, transactionId: pays[0].inn.id }).blockedReason).toMatch(/People/);
  });

  it("a fee owned by a split/assigned expense blocks before confirmation, matching deleteTransferPair", () => {
    const { pays, input } = setup([3000]);
    const fee = txn("bank", "expense", 20, d(10, 18), { id: "tr0_fee", transferFeeForId: "tr0" });
    const withFee = { ...input, transactions: [...input.transactions, fee], transactionId: pays[0].inn.id };
    expect(cardPaymentCancellationPreview(withFee).state).toBe("ready");
    const p = cardPaymentCancellationPreview({ ...withFee, splitOwnedTransactionIds: new Set(["tr0_fee"]) });
    expect(p.state).toBe("blocked");
    expect(p.blockedReason).toMatch(/shared expense/);
  });

  it("a paying account that no longer exists blocks (its balance can't be corrected)", () => {
    const { pays, input } = setup([3000]);
    const p = cardPaymentCancellationPreview({ ...input, accounts: input.accounts.filter((a) => a.id !== "bank"), transactionId: pays[0].inn.id });
    expect(p.state).toBe("blocked");
  });

  it("a bank-to-bank transfer is not a card payment", () => {
    const { input } = setup([]);
    const out = txn("bank", "expense", 500, d(10, 18), { transferId: "x" });
    const inn = txn("bank2", "income", 500, d(10, 18), { transferId: "x" });
    const p = cardPaymentCancellationPreview({ ...input, transactions: [...input.transactions, out, inn], transactionId: out.id });
    expect(p.state).toBe("notCardPayment");
  });
});
