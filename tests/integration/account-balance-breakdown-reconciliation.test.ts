/**
 * Accounts "Explain my balance" — emulator-backed reconciliation. After every kind of financial action the app
 * supports, the balance breakdown computed from the RECORDS (`buildBalanceBreakdown`) must explain the balance the
 * Accounts screen shows (the stored `currentBalance`) to the paisa: `unexplained === 0` for each account and for
 * the group total. A non-zero value here would be a real write-path bug (a delta applied twice or missed), never
 * something to hide in the UI.
 *
 * Run via `npm run test:integration`.
 */

import { readFileSync } from "node:fs";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, getDocs, query, where, type Firestore } from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildBalanceBreakdown } from "@/features/accounts/lib/balance-breakdown";
import { accountFromFirestore, accountToFirestore } from "@/lib/models/account";
import { expenseFromFirestore, expenseToFirestore } from "@/lib/models/expense";
import { loanFromFirestore, loanToFirestore } from "@/lib/models/loan";
import {
  installmentFromFirestore,
  installmentPaymentFromFirestore,
  installmentPaymentToFirestore,
  installmentToFirestore,
  paymentScheduleFromFirestore,
  paymentScheduleToFirestore,
} from "@/lib/models/payment-schedule";
import { advanceApplicationFromFirestore, advanceApplicationToFirestore, ledgerEntryFromFirestore, ledgerEntryToFirestore, personFromFirestore, personToFirestore } from "@/lib/models/person";
import { transactionFromFirestore, transactionToFirestore } from "@/lib/models/transaction";
import { AccountRepository } from "@/lib/repositories/account-repository";
import { ExpenseRepository, participantKey } from "@/lib/repositories/expense-repository";
import { LoanAdvancePaymentRepository } from "@/lib/repositories/loan-advance-payment-repository";
import { LoanRepository } from "@/lib/repositories/loan-repository";
import { InstallmentPaymentRepository, InstallmentRepository, PaymentScheduleRepository } from "@/lib/repositories/payment-schedule-repository";
import { PersonPaymentRepository } from "@/lib/repositories/person-payment-repository";
import { LedgerRepository, PersonRepository } from "@/lib/repositories/person-repository";
import { TransactionRepository } from "@/lib/repositories/transaction-repository";

const PROJECT_ID = "flowfi-account-balance-breakdown-reconciliation";
const UID = "breakdown-owner-uid";

let testEnv: RulesTestEnvironment;

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: readFileSync("firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 },
  });
});
afterAll(async () => {
  await testEnv.cleanup();
});
afterEach(async () => {
  await testEnv.clearFirestore();
});

function setup() {
  const db = testEnv.authenticatedContext(UID).firestore() as unknown as Firestore;
  const accounts = new AccountRepository(collection(db, "users", UID, "accounts").withConverter({ toFirestore: accountToFirestore, fromFirestore: accountFromFirestore }));
  const expensesCol = collection(db, "users", UID, "expenses").withConverter({ toFirestore: expenseToFirestore, fromFirestore: expenseFromFirestore });
  const transactions = new TransactionRepository(
    collection(db, "users", UID, "transactions").withConverter({ toFirestore: transactionToFirestore, fromFirestore: transactionFromFirestore }),
    accounts,
  ).withExpenseOwnerLookup(async (id) => (await getDocs(query(expensesCol, where("transactionId", "==", id)))).docs.map((d) => d.ref));
  const people = new PersonRepository(collection(db, "users", UID, "people").withConverter({ toFirestore: personToFirestore, fromFirestore: personFromFirestore }));
  const ledgerFor = (personId: string) =>
    new LedgerRepository(
      collection(db, "users", UID, "people", personId, "ledger").withConverter({ toFirestore: ledgerEntryToFirestore, fromFirestore: ledgerEntryFromFirestore }),
      people,
    );
  const installmentRepositoryFor = (scheduleId: string) =>
    new InstallmentRepository(
      collection(db, "users", UID, "paymentSchedules", scheduleId, "installments").withConverter({ toFirestore: installmentToFirestore, fromFirestore: installmentFromFirestore }),
    );
  const installmentPaymentRepositoryFor = (scheduleId: string, installmentId: string) =>
    new InstallmentPaymentRepository(
      collection(db, "users", UID, "paymentSchedules", scheduleId, "installments", installmentId, "payments").withConverter({
        toFirestore: installmentPaymentToFirestore,
        fromFirestore: installmentPaymentFromFirestore,
      }),
      installmentRepositoryFor(scheduleId),
    );
  const schedules = new PaymentScheduleRepository(
    collection(db, "users", UID, "paymentSchedules").withConverter({ toFirestore: paymentScheduleToFirestore, fromFirestore: paymentScheduleFromFirestore }),
  );
  const expenses = new ExpenseRepository(expensesCol, transactions, schedules, people, installmentRepositoryFor, ledgerFor);
  const loans = new LoanRepository(
    collection(db, "users", UID, "loans").withConverter({ toFirestore: loanToFirestore, fromFirestore: loanFromFirestore }),
    schedules,
    installmentRepositoryFor,
  );
  const loanPayments = new LoanAdvancePaymentRepository(db, UID);
  const paymentsFor = (personId: string) =>
    new PersonPaymentRepository({
      personRepository: people,
      ledgerRepository: ledgerFor(personId),
      transactionRepository: transactions,
      advanceApplications: collection(db, "users", UID, "people", personId, "advanceApplications").withConverter({
        toFirestore: advanceApplicationToFirestore,
        fromFirestore: advanceApplicationFromFirestore,
      }),
      expenseDocRef: (id) => expenses.docRef(id),
      installmentDocRef: (scheduleId, id) => installmentRepositoryFor(scheduleId).docRef(id),
      installmentPaymentDocRef: (scheduleId, installmentId, paymentId) => installmentPaymentRepositoryFor(scheduleId, installmentId).docRef(paymentId),
      cashLegCategoryId: "personal-loan",
    });
  return { db, accounts, transactions, people, ledgerFor, expenses, loans, loanPayments, paymentsFor, installmentRepositoryFor };
}
type Env = ReturnType<typeof setup>;

/**
 * The breakdown of every account and of the whole non-card group, from stored documents — exactly the inputs the
 * sheet gets from the shared listeners. Asserts the records explain every stored balance to the paisa.
 */
async function expectReconciled(r: Env) {
  const accounts = await r.accounts.getAll();
  const transactions = await r.transactions.getAll();
  const cardAccountIds = new Set(accounts.filter((a) => a.type === "card").map((a) => a.id));
  for (const a of accounts) {
    const b = buildBalanceBreakdown({ accounts: [a], transactions, cardAccountIds });
    expect(b.unexplained, `${a.name} is explained by its records`).toBe(0);
    expect(b.current).toBe(a.currentBalance);
  }
  const money = accounts.filter((a) => !cardAccountIds.has(a.id));
  const total = buildBalanceBreakdown({ accounts: money, transactions, cardAccountIds });
  expect(total.unexplained).toBe(0);
  expect(total.current).toBe(Math.round(money.reduce((s, a) => s + a.currentBalance * 100, 0)) / 100);
  // Positive − negative accounts adds up to the total shown.
  expect(Math.round((total.positive.total + total.negative.total) * 100)).toBe(Math.round(total.current * 100));
  return { accounts, transactions, total };
}

const d = (m: number, day: number) => new Date(2026, m - 1, day, 10);

describe("Accounts balance breakdown reconciles with stored balances after every action", () => {
  it("expenses and income: add, edit, delete, restore", async () => {
    const r = setup();
    const bank = await r.accounts.createAccount({ name: "Bank", type: "bank", openingBalance: 5_000.35, colorValue: 0 });
    const salary = await r.transactions.createTransaction({ type: "income", amount: 20_000.1, dateTime: d(10, 1), accountId: bank.id, categoryId: "c" });
    const spend = await r.transactions.createTransaction({ type: "expense", amount: 1_234.56, dateTime: d(10, 2), accountId: bank.id, categoryId: "c" });
    await expectReconciled(r);
    await r.transactions.editTransaction(spend, { amount: 999.99 });
    await expectReconciled(r);
    await r.transactions.softDeleteTransaction((await r.transactions.getByKey(spend.id))!);
    const afterDelete = await expectReconciled(r);
    expect(afterDelete.total.current).toBe(25_000.45);
    const trashed = (await r.transactions.getTrash()).find((t) => t.id === spend.id)!;
    await r.transactions.restoreTransaction(trashed);
    const restored = await expectReconciled(r);
    expect(restored.total.current).toBe(24_000.46);
    void salary;
  });

  it("transfers, transfer fee and card bill payment: create, cancel, restore", async () => {
    const r = setup();
    const a = await r.accounts.createAccount({ name: "A", type: "bank", openingBalance: 10_000, colorValue: 0 });
    const b = await r.accounts.createAccount({ name: "B", type: "bank", openingBalance: 0, colorValue: 0 });
    const card = await r.accounts.createAccount({ name: "Card", type: "card", openingBalance: 0, colorValue: 0 });
    await r.transactions.createTransaction({ type: "expense", amount: 4_000, dateTime: d(10, 1), accountId: card.id, categoryId: "c" });
    const [out] = await r.transactions.createTransferPairAtomic({
      amount: 1_500, dateTime: d(10, 2), sourceAccountId: a.id, destinationAccountId: b.id, categoryId: "c", description: "Move", idempotencyKey: "move-transfer-001",
    } as never);
    await expectReconciled(r);
    const [pay, payIn] = await r.transactions.createTransferPair({ amount: 2_500, dateTime: d(10, 3), sourceAccountId: a.id, destinationAccountId: card.id, categoryId: "c", description: "Card bill" });
    const paid = await expectReconciled(r);
    // The bank's paying leg is explained as a card bill payment, never as spending or a transfer.
    const bankView = buildBalanceBreakdown({ accounts: paid.accounts.filter((x) => x.id === a.id), transactions: paid.transactions, cardAccountIds: new Set([card.id]) });
    expect(bankView.moneyOut.map((c) => c.category).sort()).toEqual(["cardPayment", "transferOut"]);
    await r.transactions.deleteTransferPair(pay);
    await expectReconciled(r);
    await r.transactions.deleteTransferPair(pay); // duplicate cancel — nothing moves twice
    await r.transactions.deleteTransferPair(payIn);
    await expectReconciled(r);
    await r.transactions.deleteTransferPair(out);
    await expectReconciled(r);
  });

  it("People settlement into a bank: receive, partial, revert — received money is never income", async () => {
    const r = setup();
    const card = await r.accounts.createAccount({ name: "Card", type: "card", openingBalance: 0, colorValue: 0 });
    const bank = await r.accounts.createAccount({ name: "Bank", type: "bank", openingBalance: 10_000, colorValue: 0 });
    const amma = await r.people.createPerson({ name: "Amma", avatarColorValue: 0, openingBalance: 0 });
    const expense = await r.expenses.createExpense({
      description: "Dinner", totalAmount: 2_000, date: d(10, 4), categoryId: "food", accountId: card.id, splitType: "equal",
      participantInputs: [{ name: "Me", isMe: true, value: null }, { personId: amma.id, name: "Amma", value: null }],
    });
    await expectReconciled(r);
    const e = (await r.expenses.getByKey(expense.id))!;
    const participant = e.participants.find((p) => p.personId === amma.id)!;
    const gave = (await r.ledgerFor(amma.id).getByTransactionRef(e.transactionId)).find((x) => x.type === "gave")!;
    const person = (await r.people.getByKey(amma.id))!;
    const first = await r.paymentsFor(amma.id).recordPayment(person, {
      direction: "theyPaid", amount: 400, date: d(10, 6), accountId: bank.id,
      lines: [{ key: `ledger:${gave.id}`, amount: 400, route: { kind: "split", parentEntryId: gave.id, sourceKind: "splitExpense", expenseId: e.id, participantKey: participantKey(participant), scheduleId: participant.installmentId ? e.scheduleId! : "", installmentId: participant.installmentId! } }],
      extra: null,
    });
    const after = await expectReconciled(r);
    const bankView = buildBalanceBreakdown({ accounts: after.accounts.filter((x) => x.id === bank.id), transactions: after.transactions, cardAccountIds: new Set([card.id]) });
    expect(bankView.moneyIn.map((c) => c.category)).toEqual(["peopleIn"]);
    expect(bankView.moneyIn.some((c) => c.category === "income")).toBe(false);
    await r.paymentsFor(amma.id).revertPayment((await r.people.getByKey(amma.id))!, first);
    const reverted = await expectReconciled(r);
    expect(reverted.accounts.find((x) => x.id === bank.id)!.currentBalance).toBe(10_000);
  });

  it("People payment recorded as already in the account: the balance is not touched and stays explained", async () => {
    const r = setup();
    const card = await r.accounts.createAccount({ name: "Card", type: "card", openingBalance: 0, colorValue: 0 });
    const bank = await r.accounts.createAccount({ name: "Bank", type: "bank", openingBalance: 10_000, colorValue: 0 });
    const amma = await r.people.createPerson({ name: "Amma", avatarColorValue: 0, openingBalance: 0 });
    const expense = await r.expenses.createExpense({
      description: "Dinner", totalAmount: 2_000, date: d(10, 4), categoryId: "food", accountId: card.id, splitType: "equal",
      participantInputs: [{ name: "Me", isMe: true, value: null }, { personId: amma.id, name: "Amma", value: null }],
    });
    const e = (await r.expenses.getByKey(expense.id))!;
    const participant = e.participants.find((p) => p.personId === amma.id)!;
    const gave = (await r.ledgerFor(amma.id).getByTransactionRef(e.transactionId)).find((x) => x.type === "gave")!;
    const before = (await r.accounts.getByKey(bank.id))!.currentBalance;
    const paymentId = await r.paymentsFor(amma.id).recordPayment((await r.people.getByKey(amma.id))!, {
      direction: "theyPaid", amount: 1_000, date: d(9, 1), accountId: bank.id, recordedEarlier: true,
      lines: [{ key: `ledger:${gave.id}`, amount: 1_000, route: { kind: "split", parentEntryId: gave.id, sourceKind: "splitExpense", expenseId: e.id, participantKey: participantKey(participant), scheduleId: participant.installmentId ? e.scheduleId! : "", installmentId: participant.installmentId! } }],
      extra: null,
    });
    const after = await expectReconciled(r);
    expect(after.accounts.find((x) => x.id === bank.id)!.currentBalance).toBe(before);
    await r.paymentsFor(amma.id).revertPayment((await r.people.getByKey(amma.id))!, paymentId);
    const reverted = await expectReconciled(r);
    expect(reverted.accounts.find((x) => x.id === bank.id)!.currentBalance).toBe(before);
  });

  it("Loan/EMI payment: pay, partial, reverse — paid and reversed leave the balance explained", async () => {
    const r = setup();
    const bank = await r.accounts.createAccount({ name: "Bank", type: "bank", openingBalance: 100_000, colorValue: 0 });
    const loan = await r.loans.createLoan({
      loanAmount: 12_000, loanDate: new Date("2026-01-01T00:00:00Z"), repaymentType: "installment", direction: "taken", category: "institutional",
      institutionName: "Bank", interest: { type: "reducingBalance", ratePercent: 12, period: "yearly" }, installmentFrequency: "monthly", installmentCount: 12,
    });
    const installments = (await r.installmentRepositoryFor(loan.scheduleId).getAll()).sort((x, y) => x.sequenceNumber - y.sequenceNumber);
    const first = installments[0];
    const full = await r.loanPayments.record({ loan, scheduleInstallments: installments, accountId: bank.id, amount: first.amountDue, date: new Date("2026-02-01T00:00:00Z"), idempotencyKey: "emi-1" });
    const afterFull = await expectReconciled(r);
    const view = buildBalanceBreakdown({ accounts: afterFull.accounts.filter((x) => x.id === bank.id), transactions: afterFull.transactions });
    expect(view.moneyOut.map((c) => c.category)).toContain("loanPaid");
    await r.loanPayments.reversePayment({ loan, transactionId: full.transactionId, paymentIds: full.paymentIds, installmentIds: full.installmentIds, reversalIdempotencyKey: "rev-1" });
    const reversed = await expectReconciled(r);
    expect(reversed.accounts.find((x) => x.id === bank.id)!.currentBalance).toBeCloseTo(100_000, 2);
    // Duplicate reversal: balance and explanation unchanged.
    await r.loanPayments.reversePayment({ loan, transactionId: full.transactionId, paymentIds: full.paymentIds, installmentIds: full.installmentIds, reversalIdempotencyKey: "rev-1" });
    await expectReconciled(r);
  });
});
