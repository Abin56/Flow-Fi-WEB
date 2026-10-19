/**
 * Bill payments with real accounting (audit MFI-P1-03) — real Firestore emulator.
 *
 * Proves, with synthetic data, that "Pay from my account now" posts exactly one debit and marks the bill paid in
 * the same atomic write; that "Already paid earlier" moves no money; and that retries, insufficient funds, stale
 * edits, cancellation and the downstream totals (Accounts, Transactions, Month Cycle / Dashboard cash flow, My
 * Spend, drift detectors) all agree — each bill rupee counted exactly once. Run via `npm run test:integration`.
 */

import { readFileSync } from "node:fs";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, doc, getDoc, setDoc, type Firestore } from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { cashFlowThisMonth } from "@/lib/engines/cash-flow";
import { cashFlowTransactions, monthCycleDashboardTransactions } from "@/lib/engines/cycle-transaction-mapping";
import { InsufficientFundsError } from "@/lib/engines/payment-funding";
import { accountBalanceDrift } from "@/lib/engines/stored-balance-drift";
import { accountFromFirestore, accountToFirestore } from "@/lib/models/account";
import {
  billFromFirestore,
  billOccurrenceFromFirestore,
  billOccurrenceToFirestore,
  billToFirestore,
  paymentRecordFromFirestore,
  paymentRecordToFirestore,
  type Bill,
  type BillOccurrence,
} from "@/lib/models/bill";
import { transactionFromFirestore, transactionToFirestore } from "@/lib/models/transaction";
import { AccountRepository } from "@/lib/repositories/account-repository";
import { BillPaymentError, BillPaymentRepository } from "@/lib/repositories/bill-payment-repository";
import { OwnedTransactionDeleteError, OwnedTransactionEditError, TransactionRepository } from "@/lib/repositories/transaction-repository";

const PROJECT_ID = "flowfi-bill-payment-integration";
const UID = "bill-owner-uid";

let testEnv: RulesTestEnvironment;
beforeAll(async () => {
  testEnv = await initializeTestEnvironment({ projectId: PROJECT_ID, firestore: { rules: readFileSync("firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 } });
});
afterAll(async () => {
  await testEnv.cleanup();
});
afterEach(async () => {
  await testEnv.clearFirestore();
});

const paise = (n: number) => Math.round(n * 100);
const NOW = new Date();
const TODAY_NOON = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate(), 12);
const EARLIER = new Date(NOW.getFullYear(), NOW.getMonth(), 1, 12);

function setup() {
  const db = testEnv.authenticatedContext(UID).firestore() as unknown as Firestore;
  const accounts = new AccountRepository(collection(db, "users", UID, "accounts").withConverter({ toFirestore: accountToFirestore, fromFirestore: accountFromFirestore }));
  const transactions = new TransactionRepository(
    collection(db, "users", UID, "transactions").withConverter({ toFirestore: transactionToFirestore, fromFirestore: transactionFromFirestore }),
    accounts,
  );
  const bills = new BillPaymentRepository(db, UID);

  async function makeBill(amount = 1_000, extra: Partial<BillOccurrence> = {}) {
    const bill: Bill = {
      id: "bill-1", name: "Electricity", amount, nextDueDate: TODAY_NOON, recurrence: "monthly", accountId: null, categoryId: "utilities",
      customIntervalDays: null, reminderOffsets: [], notes: "", createdAt: new Date(), deletedAt: null, lastEditedAt: null, editHistory: [],
    };
    const occurrence: BillOccurrence = {
      id: "occ-1", billId: bill.id, dueDate: TODAY_NOON, amount, amountPaid: 0, isSkipped: false, createdAt: new Date(),
      deletedAt: null, lastEditedAt: null, editHistory: [], ...extra,
    };
    await setDoc(doc(collection(db, "users", UID, "bills").withConverter({ toFirestore: billToFirestore, fromFirestore: billFromFirestore }), bill.id), bill);
    await setDoc(doc(collection(db, "users", UID, "bills", bill.id, "occurrences").withConverter({ toFirestore: billOccurrenceToFirestore, fromFirestore: billOccurrenceFromFirestore }), occurrence.id), occurrence);
    return { bill, occurrence };
  }
  const occurrenceNow = async () =>
    (await getDoc(doc(collection(db, "users", UID, "bills", "bill-1", "occurrences").withConverter({ toFirestore: billOccurrenceToFirestore, fromFirestore: billOccurrenceFromFirestore }), "occ-1"))).data()!;
  const payment = async (id: string) =>
    (await getDoc(doc(collection(db, "users", UID, "bills", "bill-1", "payments").withConverter({ toFirestore: paymentRecordToFirestore, fromFirestore: paymentRecordFromFirestore }), id))).data();
  const bal = async (id: string) => paise((await accounts.getByKey(id))!.currentBalance);

  async function drift() {
    const all = [...(await transactions.getAll()), ...(await transactions.getTrash())];
    for (const a of await accounts.getAll()) expect(accountBalanceDrift(a, all), `account ${a.name}`).toBeNull();
  }
  /** What Month Cycle / Dashboard cash flow report for this month — bills contribute ONLY through transactions. */
  async function flows() {
    const txns = await transactions.getAll();
    const cf = cashFlowThisMonth({ transactions: cashFlowTransactions(txns, new Set()), emiPaidThisMonth: 0, loanPaidThisMonth: 0, billsPaidThisMonth: 0, moneyReceivedThisMonth: 0, now: TODAY_NOON });
    const outflow = monthCycleDashboardTransactions(txns, new Set()).filter((t) => t.type === "expense" && !t.isTransfer).reduce((s, t) => s + paise(t.amount), 0);
    return { moneyOut: paise(cf.moneyOut), cycleOutflow: outflow };
  }
  return { db, accounts, transactions, bills, makeBill, occurrenceNow, payment, bal, drift, flows };
}

describe("A. Pay from my account now", () => {
  it("posts one debit, marks the bill paid, and every module sees it exactly once", async () => {
    const s = setup();
    const bank = await s.accounts.createAccount({ name: "Bank", type: "bank", openingBalance: 5_000, colorValue: 0 });
    const { bill, occurrence } = await s.makeBill(1_000);

    const r = await s.bills.payFromAccount({ billId: bill.id, occurrenceId: occurrence.id, accountId: bank.id, date: TODAY_NOON, idempotencyKey: "bill-pay-0001" });

    expect(r.alreadyRecorded).toBe(false);
    expect(await s.bal(bank.id)).toBe(paise(4_000));
    const txns = await s.transactions.getAll();
    expect(txns).toHaveLength(1);
    expect(txns[0]).toMatchObject({ type: "expense", amount: 1_000, accountId: bank.id, billPaymentId: r.paymentId, description: "Electricity", categoryId: "utilities" });
    expect((await s.occurrenceNow()).amountPaid).toBe(1_000);
    expect(await s.payment(r.paymentId)).toMatchObject({ amount: 1_000, transactionId: txns[0].id, accountId: bank.id });
    // Cross-module: ONE rupee-for-rupee debit in cash flow and Month Cycle outflow.
    expect(await s.flows()).toEqual({ moneyOut: paise(1_000), cycleOutflow: paise(1_000) });
    await s.drift();
  });

  it("a retry of the same action (double click / lost response) debits once; concurrent duplicates too", async () => {
    const s = setup();
    const bank = await s.accounts.createAccount({ name: "Bank", type: "bank", openingBalance: 5_000, colorValue: 0 });
    const { bill, occurrence } = await s.makeBill(1_000);
    const p = { billId: bill.id, occurrenceId: occurrence.id, accountId: bank.id, date: TODAY_NOON, idempotencyKey: "bill-pay-0002" };
    await s.bills.payFromAccount(p);
    expect((await s.bills.payFromAccount(p)).alreadyRecorded).toBe(true);
    await Promise.allSettled([s.bills.payFromAccount(p), s.bills.payFromAccount(p)]);
    expect(await s.bal(bank.id)).toBe(paise(4_000));
    expect(await s.transactions.getAll()).toHaveLength(1);
    expect((await s.occurrenceNow()).amountPaid).toBe(1_000);
    await s.drift();
  });

  it("insufficient funds is refused in the write: no debit, no payment record, bill still unpaid", async () => {
    const s = setup();
    const bank = await s.accounts.createAccount({ name: "Poor", type: "bank", openingBalance: 300, colorValue: 0 });
    const { bill, occurrence } = await s.makeBill(1_000);
    await expect(s.bills.payFromAccount({ billId: bill.id, occurrenceId: occurrence.id, accountId: bank.id, date: TODAY_NOON, idempotencyKey: "bill-pay-0003" })).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(await s.bal(bank.id)).toBe(paise(300));
    expect(await s.transactions.getAll()).toHaveLength(0);
    expect((await s.occurrenceNow()).amountPaid).toBe(0);
    expect(await s.payment("billpay_bill-pay-0003")).toBeUndefined();
    expect(await s.flows()).toEqual({ moneyOut: 0, cycleOutflow: 0 });
  });

  it("a credit card, a missing account, an over-payment and a skipped cycle are all refused with zero side effects", async () => {
    const s = setup();
    const bank = await s.accounts.createAccount({ name: "Bank", type: "bank", openingBalance: 5_000, colorValue: 0 });
    const card = await s.accounts.createAccount({ name: "Card", type: "card", openingBalance: 0, colorValue: 0 });
    const { bill, occurrence } = await s.makeBill(1_000);
    const base = { billId: bill.id, occurrenceId: occurrence.id, date: TODAY_NOON };
    await expect(s.bills.payFromAccount({ ...base, accountId: card.id, idempotencyKey: "bill-pay-0004" })).rejects.toBeInstanceOf(BillPaymentError);
    await expect(s.bills.payFromAccount({ ...base, accountId: "nope", idempotencyKey: "bill-pay-0005" })).rejects.toBeInstanceOf(BillPaymentError);
    await expect(s.bills.payFromAccount({ ...base, accountId: bank.id, amount: 1_200, idempotencyKey: "bill-pay-0006" })).rejects.toThrow(/still due/);
    await expect(s.bills.payFromAccount({ ...base, accountId: bank.id, amount: 0, idempotencyKey: "bill-pay-0007" })).rejects.toBeInstanceOf(BillPaymentError);
    expect(await s.bal(bank.id)).toBe(paise(5_000));
    expect(await s.bal(card.id)).toBe(0);
    expect(await s.transactions.getAll()).toHaveLength(0);

    await testEnv.clearFirestore();
    const skipped = setup();
    const b2 = await skipped.accounts.createAccount({ name: "Bank", type: "bank", openingBalance: 5_000, colorValue: 0 });
    await skipped.makeBill(1_000, { isSkipped: true });
    await expect(skipped.bills.payFromAccount({ billId: "bill-1", occurrenceId: "occ-1", accountId: b2.id, date: TODAY_NOON, idempotencyKey: "bill-pay-0008" })).rejects.toThrow(/skipped/);
    expect(await skipped.bal(b2.id)).toBe(paise(5_000));
  });

  it("partial payments add up, never exceed the bill, and the last one completes it", async () => {
    const s = setup();
    const bank = await s.accounts.createAccount({ name: "Bank", type: "bank", openingBalance: 5_000, colorValue: 0 });
    const { bill, occurrence } = await s.makeBill(1_000);
    const base = { billId: bill.id, occurrenceId: occurrence.id, accountId: bank.id, date: TODAY_NOON };
    await s.bills.payFromAccount({ ...base, amount: 400, idempotencyKey: "bill-part-01" });
    await s.bills.payFromAccount({ ...base, amount: 600, idempotencyKey: "bill-part-02" });
    await expect(s.bills.payFromAccount({ ...base, amount: 1, idempotencyKey: "bill-part-03" })).rejects.toThrow(/already paid/);
    expect(await s.bal(bank.id)).toBe(paise(4_000));
    expect((await s.occurrenceNow()).amountPaid).toBe(1_000);
    expect(await s.flows()).toEqual({ moneyOut: paise(1_000), cycleOutflow: paise(1_000) });
    await s.drift();
  });

  it("the debit is owned by the bill: generic delete and money edits are refused; a text edit still works", async () => {
    const s = setup();
    const bank = await s.accounts.createAccount({ name: "Bank", type: "bank", openingBalance: 5_000, colorValue: 0 });
    const { bill, occurrence } = await s.makeBill(1_000);
    await s.bills.payFromAccount({ billId: bill.id, occurrenceId: occurrence.id, accountId: bank.id, date: TODAY_NOON, idempotencyKey: "bill-own-0001" });
    const t = (await s.transactions.getAll())[0];
    await expect(s.transactions.softDeleteTransaction(t)).rejects.toBeInstanceOf(OwnedTransactionDeleteError);
    await expect(s.transactions.editTransaction(t, { amount: 1 })).rejects.toBeInstanceOf(OwnedTransactionEditError);
    await s.transactions.editTransaction(t, { notes: "March bill" });
    expect(await s.bal(bank.id)).toBe(paise(4_000));
    expect((await s.occurrenceNow()).amountPaid).toBe(1_000);
    await s.drift();
  });
});

describe("B. Already paid earlier — included in my balance", () => {
  it("marks the bill paid on the real date with NO debit and no cash movement anywhere", async () => {
    const s = setup();
    const bank = await s.accounts.createAccount({ name: "Bank", type: "bank", openingBalance: 5_000, colorValue: 0 });
    const { bill, occurrence } = await s.makeBill(1_000);
    const r = await s.bills.recordPaidEarlier({ billId: bill.id, occurrenceId: occurrence.id, date: EARLIER, idempotencyKey: "bill-early-001" });
    expect(r.transactionId).toBeNull();
    expect(await s.bal(bank.id)).toBe(paise(5_000));
    expect(await s.transactions.getAll()).toHaveLength(0);
    expect((await s.occurrenceNow()).amountPaid).toBe(1_000);
    const rec = (await s.payment(r.paymentId))!;
    expect(rec).toMatchObject({ amount: 1_000, recordedEarlier: true });
    expect(rec.date.getTime()).toBe(EARLIER.getTime());
    expect(rec.transactionId ?? null).toBeNull();
    expect(await s.flows()).toEqual({ moneyOut: 0, cycleOutflow: 0 });
    // retry: still nothing new
    expect((await s.bills.recordPaidEarlier({ billId: bill.id, occurrenceId: occurrence.id, date: EARLIER, idempotencyKey: "bill-early-001" })).alreadyRecorded).toBe(true);
    await s.drift();
  });

  it("a future date is refused; nothing is written", async () => {
    const s = setup();
    await s.makeBill(1_000);
    const future = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + 3);
    await expect(s.bills.recordPaidEarlier({ billId: "bill-1", occurrenceId: "occ-1", date: future, idempotencyKey: "bill-early-002" })).rejects.toThrow(/future/);
    expect((await s.occurrenceNow()).amountPaid).toBe(0);
  });
});

describe("C. Cancel, edit, stale writes", () => {
  it("cancelling restores the account and reopens the bill; a repeat cancel is a no-op", async () => {
    const s = setup();
    const bank = await s.accounts.createAccount({ name: "Bank", type: "bank", openingBalance: 5_000, colorValue: 0 });
    const { bill, occurrence } = await s.makeBill(1_000);
    const r = await s.bills.payFromAccount({ billId: bill.id, occurrenceId: occurrence.id, accountId: bank.id, date: TODAY_NOON, idempotencyKey: "bill-can-0001" });
    expect((await s.bills.reversePayment({ billId: bill.id, paymentId: r.paymentId })).alreadyReversed).toBe(false);
    expect((await s.bills.reversePayment({ billId: bill.id, paymentId: r.paymentId })).alreadyReversed).toBe(true);
    await Promise.allSettled([s.bills.reversePayment({ billId: bill.id, paymentId: r.paymentId }), s.bills.reversePayment({ billId: bill.id, paymentId: r.paymentId })]);
    expect(await s.bal(bank.id)).toBe(paise(5_000));
    expect((await s.occurrenceNow()).amountPaid).toBe(0);
    expect(await s.transactions.getAll()).toHaveLength(0);
    expect(await s.flows()).toEqual({ moneyOut: 0, cycleOutflow: 0 });
    await s.drift();
    // and it can be paid again with a new action
    await s.bills.payFromAccount({ billId: bill.id, occurrenceId: occurrence.id, accountId: bank.id, date: TODAY_NOON, idempotencyKey: "bill-can-0002" });
    expect(await s.bal(bank.id)).toBe(paise(4_000));
  });

  it("cancelling a paid-earlier bill reopens it without touching any account; a legacy paid record is left alone", async () => {
    const s = setup();
    const bank = await s.accounts.createAccount({ name: "Bank", type: "bank", openingBalance: 5_000, colorValue: 0 });
    const { bill, occurrence } = await s.makeBill(1_000);
    const r = await s.bills.recordPaidEarlier({ billId: bill.id, occurrenceId: occurrence.id, date: EARLIER, idempotencyKey: "bill-can-0003" });
    await s.bills.reversePayment({ billId: bill.id, paymentId: r.paymentId });
    expect((await s.occurrenceNow()).amountPaid).toBe(0);
    expect(await s.bal(bank.id)).toBe(paise(5_000));

    // Legacy: an old "Mark paid" left amountPaid with a bare record (no transactionId / recordedEarlier).
    await testEnv.clearFirestore();
    const legacy = setup();
    const b2 = await legacy.accounts.createAccount({ name: "Bank", type: "bank", openingBalance: 5_000, colorValue: 0 });
    await legacy.makeBill(1_000, { amountPaid: 1_000 });
    await setDoc(
      doc(collection(legacy.db, "users", UID, "bills", "bill-1", "payments").withConverter({ toFirestore: paymentRecordToFirestore, fromFirestore: paymentRecordFromFirestore }), "legacy-pay"),
      { id: "legacy-pay", billId: "bill-1", occurrenceId: "occ-1", amount: 1_000, date: EARLIER, note: "", createdAt: EARLIER, deletedAt: null, lastEditedAt: null, editHistory: [] },
    );
    await expect(legacy.bills.reversePayment({ billId: "bill-1", paymentId: "legacy-pay" })).rejects.toThrow(/recorded before/);
    expect((await legacy.occurrenceNow()).amountPaid).toBe(1_000);
    expect(await legacy.bal(b2.id)).toBe(paise(5_000));
    expect(await legacy.flows()).toEqual({ moneyOut: 0, cycleOutflow: 0 }); // legacy paid bills never count as cash out
    await expect(legacy.bills.payFromAccount({ billId: "bill-1", occurrenceId: "occ-1", accountId: b2.id, date: TODAY_NOON, idempotencyKey: "bill-leg-0001" })).rejects.toThrow(/already paid/);
  });

  it("edit replaces the debit (net difference once), can move accounts, and is idempotent", async () => {
    const s = setup();
    const a = await s.accounts.createAccount({ name: "A", type: "bank", openingBalance: 5_000, colorValue: 0 });
    const b = await s.accounts.createAccount({ name: "B", type: "cash", openingBalance: 2_000, colorValue: 0 });
    const { bill, occurrence } = await s.makeBill(1_000);
    const r = await s.bills.payFromAccount({ billId: bill.id, occurrenceId: occurrence.id, accountId: a.id, amount: 600, date: TODAY_NOON, idempotencyKey: "bill-edit-001" });
    const e = await s.bills.editPayment({ billId: bill.id, paymentId: r.paymentId, accountId: a.id, amount: 900, date: TODAY_NOON, idempotencyKey: "bill-edit-002" });
    expect(await s.bal(a.id)).toBe(paise(4_100));
    expect((await s.occurrenceNow()).amountPaid).toBe(900);
    expect((await s.bills.editPayment({ billId: bill.id, paymentId: r.paymentId, accountId: a.id, amount: 900, date: TODAY_NOON, idempotencyKey: "bill-edit-002" })).alreadyRecorded).toBe(true);
    await s.bills.editPayment({ billId: bill.id, paymentId: e.paymentId, accountId: b.id, amount: 700, date: TODAY_NOON, idempotencyKey: "bill-edit-003" });
    expect(await s.bal(a.id)).toBe(paise(5_000));
    expect(await s.bal(b.id)).toBe(paise(1_300));
    expect((await s.occurrenceNow()).amountPaid).toBe(700);
    expect(await s.transactions.getAll()).toHaveLength(1);
    expect(await s.flows()).toEqual({ moneyOut: paise(700), cycleOutflow: paise(700) });
    await s.drift();
  });

  it("stale edit after cancel, over-limit edit and under-funded edit are rejected with zero side effects", async () => {
    const s = setup();
    const a = await s.accounts.createAccount({ name: "A", type: "bank", openingBalance: 1_200, colorValue: 0 });
    const { bill, occurrence } = await s.makeBill(1_000);
    const r = await s.bills.payFromAccount({ billId: bill.id, occurrenceId: occurrence.id, accountId: a.id, amount: 500, date: TODAY_NOON, idempotencyKey: "bill-stale-01" });
    await expect(s.bills.editPayment({ billId: bill.id, paymentId: r.paymentId, accountId: a.id, amount: 1_100, date: TODAY_NOON, idempotencyKey: "bill-stale-02" })).rejects.toThrow(/more than the bill/);
    await expect(s.bills.editPayment({ billId: bill.id, paymentId: r.paymentId, accountId: a.id, amount: 1_000, date: TODAY_NOON, idempotencyKey: "bill-stale-03" })).resolves.toBeDefined(); // net −500 of 700 left → fine
    expect(await s.bal(a.id)).toBe(paise(200));

    await testEnv.clearFirestore();
    const s2 = setup();
    const a2 = await s2.accounts.createAccount({ name: "A", type: "bank", openingBalance: 1_000, colorValue: 0 });
    await s2.makeBill(1_000);
    const r2 = await s2.bills.payFromAccount({ billId: "bill-1", occurrenceId: "occ-1", accountId: a2.id, amount: 600, date: TODAY_NOON, idempotencyKey: "bill-stale-04" });
    await s2.bills.reversePayment({ billId: "bill-1", paymentId: r2.paymentId });
    const snap = { bal: await s2.bal(a2.id), paid: (await s2.occurrenceNow()).amountPaid };
    await expect(s2.bills.editPayment({ billId: "bill-1", paymentId: r2.paymentId, accountId: a2.id, amount: 700, date: TODAY_NOON, idempotencyKey: "bill-stale-05" })).rejects.toThrow(/another tab/);
    expect({ bal: await s2.bal(a2.id), paid: (await s2.occurrenceNow()).amountPaid }).toEqual(snap);
    expect(await s2.transactions.getAll()).toHaveLength(0);

    // under-funded edit: 600 paid from a 1,000 account (400 left); raising to 1,000 needs 400 more → exactly affordable; a 1,000-account paying 600 then edit to a poorer account fails.
    const poor = await s2.accounts.createAccount({ name: "Poor", type: "bank", openingBalance: 100, colorValue: 0 });
    const r3 = await s2.bills.payFromAccount({ billId: "bill-1", occurrenceId: "occ-1", accountId: a2.id, amount: 600, date: TODAY_NOON, idempotencyKey: "bill-stale-06" });
    await expect(s2.bills.editPayment({ billId: "bill-1", paymentId: r3.paymentId, accountId: poor.id, amount: 600, date: TODAY_NOON, idempotencyKey: "bill-stale-07" })).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(await s2.bal(a2.id)).toBe(paise(400));
    expect(await s2.bal(poor.id)).toBe(paise(100));
    expect((await s2.occurrenceNow()).amountPaid).toBe(600);
    await s2.drift();
  });
});

describe("D. Credit-card bill payments stay a transfer", () => {
  it("a bank→card payment and a bill payment together: each counted once, the card payment is never an expense", async () => {
    const s = setup();
    const bank = await s.accounts.createAccount({ name: "Bank", type: "bank", openingBalance: 10_000, colorValue: 0 });
    const card = await s.accounts.createAccount({ name: "Card", type: "card", openingBalance: 0, colorValue: 0 });
    await s.transactions.createTransaction({ type: "expense", amount: 2_000, dateTime: TODAY_NOON, accountId: card.id, categoryId: "shopping" });
    await s.transactions.createTransferPairAtomic({ amount: 2_000, dateTime: TODAY_NOON, sourceAccountId: bank.id, destinationAccountId: card.id, categoryId: "transfer", idempotencyKey: "card-pay-00001" });
    const { bill, occurrence } = await s.makeBill(1_000);
    await s.bills.payFromAccount({ billId: bill.id, occurrenceId: occurrence.id, accountId: bank.id, date: TODAY_NOON, idempotencyKey: "bill-card-001" });

    expect(await s.bal(bank.id)).toBe(paise(7_000));
    expect(await s.bal(card.id)).toBe(0);
    const txns = await s.transactions.getAll();
    const cf = cashFlowThisMonth({ transactions: cashFlowTransactions(txns, new Set([card.id])), emiPaidThisMonth: 0, loanPaidThisMonth: 0, billsPaidThisMonth: 0, moneyReceivedThisMonth: 0, now: TODAY_NOON });
    expect(paise(cf.moneyOut)).toBe(paise(3_000)); // 2,000 card bill (cash out once, when paid) + 1,000 bill
    const cycle = monthCycleDashboardTransactions(txns, new Set([card.id])).filter((t) => t.type === "expense" && !t.isTransfer).reduce((x, t) => x + paise(t.amount), 0);
    expect(cycle).toBe(paise(3_000)); // 2,000 card purchase (at purchase) + 1,000 bill; the transfer is not an expense
    await s.drift();
  });
});
