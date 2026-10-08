/**
 * Web Financial Integrity Audit — emulator-backed tests for `docs/web-financial-integrity-audit.md`.
 *
 * P0-01 / P0-02 / P0-03 (Phase 1) and P1-01 / P1-09 / P1-10 (People / Split) are FIXED. Their tests are permanent
 * regressions and check the MONEY — account balances, person balances, installments, shares, My Spend, income,
 * Net Worth — not just `deletedAt` flags.
 *
 * No "PINS BUG" tests remain in this file (the card / Month Cycle pins live in
 * `features/credit-cards/hooks/web-financial-integrity-audit.test.ts`).
 *
 * Run via `npm run test:integration`.
 */

import { readFileSync } from "node:fs";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, getDocs, query, where, type Firestore } from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { myConsumptionAmount, mySpendContextFromRecords } from "@/lib/engines/my-spend";
import { breakdownEntryOf, personBalanceBreakdown, personPosition } from "@/lib/engines/person-position";
import { advanceApplicationFromFirestore, advanceApplicationToFirestore } from "@/lib/models/person";
import { isNonIncomeExpenseMovement } from "@/lib/models/transaction";
import { participantKey, ReceivedWithoutCashError, type EditExpenseParams } from "@/lib/repositories/expense-repository";
import { PersonPaymentRepository, StalePersonPaymentError } from "@/lib/repositories/person-payment-repository";

import { accountBalanceDrift, personBalanceDrift, splitLinkDrift } from "@/lib/engines/stored-balance-drift";
import { accountFromFirestore, accountToFirestore } from "@/lib/models/account";
import { expenseFromFirestore, expenseToFirestore } from "@/lib/models/expense";
import {
  installmentFromFirestore,
  installmentPaymentFromFirestore,
  installmentPaymentToFirestore,
  installmentToFirestore,
  paymentScheduleFromFirestore,
  paymentScheduleToFirestore,
} from "@/lib/models/payment-schedule";
import { ledgerEntryFromFirestore, ledgerEntryToFirestore, personFromFirestore, personToFirestore } from "@/lib/models/person";
import { transactionFromFirestore, transactionToFirestore } from "@/lib/models/transaction";
import { AccountRepository } from "@/lib/repositories/account-repository";
import { ExpenseRepository } from "@/lib/repositories/expense-repository";
import { InstallmentPaymentRepository, InstallmentRepository, PaymentScheduleRepository } from "@/lib/repositories/payment-schedule-repository";
import { LedgerRepository, PersonRepository } from "@/lib/repositories/person-repository";
import {
  LoanPaymentTransactionRestrictedError,
  OwnedTransactionDeleteError,
  OwnedTransactionEditError,
  TransactionChangedError,
  TransactionRepository,
  TransferEditRestrictedError,
} from "@/lib/repositories/transaction-repository";

// Distinct project id — concurrently-run integration files must not share one (clearFirestore cross-talk).
const PROJECT_ID = "flowfi-web-financial-integrity-audit";
const UID = "audit-owner-uid";

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
  const accounts = new AccountRepository(
    collection(db, "users", UID, "accounts").withConverter({ toFirestore: accountToFirestore, fromFirestore: accountFromFirestore }),
  );
  const expensesCol = collection(db, "users", UID, "expenses").withConverter({ toFirestore: expenseToFirestore, fromFirestore: expenseFromFirestore });
  // Wired exactly like `createTransactionRepository`: generic edits/deletes recognise split-owned transactions.
  const transactions = new TransactionRepository(
    collection(db, "users", UID, "transactions").withConverter({ toFirestore: transactionToFirestore, fromFirestore: transactionFromFirestore }),
    accounts,
  ).withExpenseOwnerLookup(async (transactionId) => (await getDocs(query(expensesCol, where("transactionId", "==", transactionId)))).docs.map((d) => d.ref));
  const people = new PersonRepository(
    collection(db, "users", UID, "people").withConverter({ toFirestore: personToFirestore, fromFirestore: personFromFirestore }),
  );
  const ledgerFor = (personId: string) =>
    new LedgerRepository(
      collection(db, "users", UID, "people", personId, "ledger").withConverter({ toFirestore: ledgerEntryToFirestore, fromFirestore: ledgerEntryFromFirestore }),
      people,
    );
  const installmentsRef = (scheduleId: string) =>
    collection(db, "users", UID, "paymentSchedules", scheduleId, "installments").withConverter({
      toFirestore: installmentToFirestore,
      fromFirestore: installmentFromFirestore,
    });
  const installmentRepositoryFor = (scheduleId: string) => new InstallmentRepository(installmentsRef(scheduleId));
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
  return { accounts, transactions, people, ledgerFor, expenses, installmentRepositoryFor, installmentPaymentRepositoryFor };
}

const balanceOf = async (accounts: AccountRepository, id: string) => (await accounts.getByKey(id))!.currentBalance;
const round2 = (v: number) => Math.round(v * 100) / 100;
const personBalance = async (people: PersonRepository, id: string) => (await people.getByKey(id))!.currentBalance;

/** No stored balance has drifted from what its own live records imply (the read-only detector). */
async function expectNoDrift(r: ReturnType<typeof setup>) {
  const allTxns = [...(await r.transactions.getAll()), ...(await r.transactions.getTrash())];
  for (const a of await r.accounts.getAll()) expect(accountBalanceDrift(a, allTxns)).toBeNull();
  for (const p of await r.people.getAll()) {
    const ledger = r.ledgerFor(p.id);
    expect(personBalanceDrift(p, [...(await ledger.getAll()), ...(await ledger.getTrash())])).toBeNull();
  }
}

async function bankWithExpense(r: ReturnType<typeof setup>, amount = 1_000) {
  const bank = await r.accounts.createAccount({ name: "Bank", type: "bank", openingBalance: 5_000, colorValue: 0 });
  const expense = await r.transactions.createTransaction({ type: "expense", amount, dateTime: new Date(2026, 9, 1, 10), accountId: bank.id, categoryId: "cat" });
  return { bank, expense };
}

async function twoAccountTransfer(r: ReturnType<typeof setup>, key = "audit-transfer-001") {
  const a = await r.accounts.createAccount({ name: "A", type: "bank", openingBalance: 10_000, colorValue: 0 });
  const b = await r.accounts.createAccount({ name: "B", type: "bank", openingBalance: 0, colorValue: 0 });
  const [out, inn] = await r.transactions.createTransferPairAtomic({
    amount: 2_000,
    dateTime: new Date(2026, 9, 2, 9),
    sourceAccountId: a.id,
    destinationAccountId: b.id,
    categoryId: "transfer",
    idempotencyKey: key,
  });
  return { a, b, out, inn };
}

describe("P0-01 — transaction delete is idempotent and never trusts a stale copy", () => {
  it("1. normal expense delete once restores the account exactly", async () => {
    const r = setup();
    const { bank, expense } = await bankWithExpense(r);
    await r.transactions.softDeleteTransaction(expense);
    expect(await balanceOf(r.accounts, bank.id)).toBe(5_000);
    await expectNoDrift(r);
  });

  it("2 + 8. the same delete twice (repeat click / retry after a lost response) reverses once", async () => {
    const r = setup();
    const { bank, expense } = await bankWithExpense(r);
    await r.transactions.softDeleteTransaction(expense);
    await r.transactions.softDeleteTransaction(expense);
    expect(await balanceOf(r.accounts, bank.id)).toBe(5_000);
    await expectNoDrift(r);
  });

  it("3. two tabs deleting concurrently converge to one reversal", async () => {
    const r = setup();
    const { bank, expense } = await bankWithExpense(r);
    await Promise.all([r.transactions.softDeleteTransaction(expense), r.transactions.softDeleteTransaction(expense)]);
    expect(await balanceOf(r.accounts, bank.id)).toBe(5_000);
    await expectNoDrift(r);
  });

  it("7. a stale delete after another tab changed the amount is refused; nothing is written", async () => {
    const r = setup();
    const { bank, expense: stale } = await bankWithExpense(r);
    await r.transactions.editTransaction(stale, { amount: 1_500 });
    expect(await balanceOf(r.accounts, bank.id)).toBe(3_500);

    await expect(r.transactions.softDeleteTransaction(stale)).rejects.toBeInstanceOf(TransactionChangedError);
    expect(await balanceOf(r.accounts, bank.id)).toBe(3_500);
    const live = (await r.transactions.getAll()).find((t) => t.id === stale.id)!;
    expect(live.amount).toBe(1_500);

    // A fresh copy deletes the CURRENT ₹1,500 exactly once.
    await r.transactions.softDeleteTransaction(live);
    expect(await balanceOf(r.accounts, bank.id)).toBe(5_000);
    await expectNoDrift(r);
  });

  it("4 + 9. transfer delete once reverses both legs; the pair stays consistent", async () => {
    const r = setup();
    const { a, b, out, inn } = await twoAccountTransfer(r);
    await r.transactions.deleteTransferPair(out);
    expect(await balanceOf(r.accounts, a.id)).toBe(10_000);
    expect(await balanceOf(r.accounts, b.id)).toBe(0);
    const trash = await r.transactions.getTrash();
    expect(trash.map((t) => t.id).sort()).toEqual([out.id, inn.id].sort());
    await expectNoDrift(r);
  });

  it("5. transfer deleted twice (either leg, stale copies) creates no money", async () => {
    const r = setup();
    const { a, b, out, inn } = await twoAccountTransfer(r);
    await r.transactions.deleteTransferPair(out);
    await r.transactions.deleteTransferPair(out);
    await r.transactions.deleteTransferPair(inn);
    expect(await balanceOf(r.accounts, a.id)).toBe(10_000);
    expect(await balanceOf(r.accounts, b.id)).toBe(0);
    await expectNoDrift(r);
  });

  it("6. concurrent transfer deletes from two tabs converge — money conserved", async () => {
    const r = setup();
    const { a, b, out, inn } = await twoAccountTransfer(r);
    await Promise.all([r.transactions.deleteTransferPair(out), r.transactions.deleteTransferPair(inn)]);
    expect(await balanceOf(r.accounts, a.id)).toBe(10_000);
    expect(await balanceOf(r.accounts, b.id)).toBe(0);
    await expectNoDrift(r);
  });

  it("restore is idempotent too (restore twice / pair restore twice)", async () => {
    const r = setup();
    const { bank, expense } = await bankWithExpense(r);
    await r.transactions.softDeleteTransaction(expense);
    await r.transactions.restoreTransaction(expense);
    await r.transactions.restoreTransaction(expense);
    expect(await balanceOf(r.accounts, bank.id)).toBe(4_000);

    const { a, b, out } = await twoAccountTransfer(r, "audit-transfer-002");
    await r.transactions.deleteTransferPair(out);
    await r.transactions.restoreTransferPair(out);
    await r.transactions.restoreTransferPair(out);
    expect(await balanceOf(r.accounts, a.id)).toBe(8_000);
    expect(await balanceOf(r.accounts, b.id)).toBe(2_000);
    await expectNoDrift(r);
  });

  it("a transfer leg's type / exclusion cannot be changed on one side", async () => {
    const r = setup();
    const { a, out } = await twoAccountTransfer(r);
    await expect(r.transactions.editTransaction(out, { excludeFromCalculations: true })).rejects.toBeInstanceOf(TransferEditRestrictedError);
    await expect(r.transactions.editTransaction(out, { type: "income" })).rejects.toBeInstanceOf(TransferEditRestrictedError);
    await r.transactions.editTransaction(out, { description: "Savings sweep" }); // presentation stays editable
    expect(await balanceOf(r.accounts, a.id)).toBe(8_000);
  });
});

describe("P0-02 — owner-aware edit/delete contract", () => {
  it("10. a standalone transaction is still freely editable", async () => {
    const r = setup();
    const { bank, expense } = await bankWithExpense(r);
    await r.transactions.editTransaction(expense, { amount: 2_500, description: "Groceries" });
    expect(await balanceOf(r.accounts, bank.id)).toBe(2_500);
    await expectNoDrift(r);
  });

  it("11 + 12. Loan- and EMI-owned payments refuse a generic money edit and a generic delete; text edits still work", async () => {
    const r = setup();
    const bank = await r.accounts.createAccount({ name: "Bank", type: "bank", openingBalance: 50_000, colorValue: 0 });
    for (const link of [{ loanId: "loan-1" }, { emiId: "emi-1" }]) {
      const payment = await r.transactions.createTransaction({
        type: "expense",
        amount: 3_000,
        dateTime: new Date(2026, 9, 5, 10),
        accountId: bank.id,
        categoryId: "loan_payment",
        installmentId: "inst-1",
        installmentPaymentId: "pay-1",
        paymentAllocationType: "regularEmi",
        ...link,
      });
      await expect(r.transactions.editTransaction(payment, { amount: 2_000 })).rejects.toBeInstanceOf(OwnedTransactionEditError);
      await expect(r.transactions.editTransaction(payment, { dateTime: new Date(2026, 9, 6) })).rejects.toBeInstanceOf(OwnedTransactionEditError);
      await expect(r.transactions.softDeleteTransaction(payment)).rejects.toBeInstanceOf(LoanPaymentTransactionRestrictedError);
      await r.transactions.editTransaction(payment, { description: "Home loan EMI", categoryId: "housing" });
    }
    expect(await balanceOf(r.accounts, bank.id)).toBe(44_000);
    await expectNoDrift(r);
  });

  it("13 + 16. a People cash leg refuses a generic money edit; the People edit moves entry, person and account together", async () => {
    const r = setup();
    const bank = await r.accounts.createAccount({ name: "Bank", type: "bank", openingBalance: 10_000, colorValue: 0 });
    const ravi = await r.people.createPerson({ name: "Ravi", avatarColorValue: 0, openingBalance: 0 });
    const ledger = r.ledgerFor(ravi.id);
    const { entry, transaction } = await ledger.addEntryWithTransaction(
      ravi,
      { type: "gave", amount: 2_000, date: new Date(2026, 9, 3, 10) },
      { type: "expense", accountId: bank.id, categoryId: "personal-loan" },
      r.transactions,
    );

    // The modal's old edit branch (raw editTransaction) — now refused, nothing moves.
    await expect(r.transactions.editTransaction(transaction, { amount: 3_000, linkedPersonId: ravi.id, owesPersonToggle: false })).rejects.toBeInstanceOf(
      OwnedTransactionEditError,
    );
    await expect(r.transactions.editTransaction(transaction, { clearLinkedPersonId: true })).rejects.toBeInstanceOf(OwnedTransactionEditError);
    await expect(r.transactions.softDeleteTransaction(transaction)).rejects.toBeInstanceOf(OwnedTransactionDeleteError);
    expect(await balanceOf(r.accounts, bank.id)).toBe(8_000);
    expect(await personBalance(r.people, ravi.id)).toBe(2_000);

    // The owning path (what `actions.editTransaction` routes a cash leg to).
    await ledger.editEntry(ravi, entry, { amount: 3_000 }, r.transactions);
    expect(await balanceOf(r.accounts, bank.id)).toBe(7_000);
    expect(await personBalance(r.people, ravi.id)).toBe(3_000);
    expect((await ledger.getByKey(entry.id))!.amount).toBe(3_000);
    expect((await r.transactions.getByKey(transaction.id))!.amount).toBe(3_000);

    // The owning delete takes entry + cash leg together, once.
    await ledger.softDeleteEntriesWithCashLegs(ravi, [entry], r.transactions);
    await ledger.softDeleteEntriesWithCashLegs(ravi, [entry], r.transactions);
    expect(await balanceOf(r.accounts, bank.id)).toBe(10_000);
    expect(await personBalance(r.people, ravi.id)).toBe(0);
    await expectNoDrift(r);
  });

  it("14 + 15 + 16. a split expense refuses a generic money edit/delete; editExpense / deleteExpense keep shares and account in step", async () => {
    const r = setup();
    const bank = await r.accounts.createAccount({ name: "Bank", type: "bank", openingBalance: 10_000, colorValue: 0 });
    const meera = await r.people.createPerson({ name: "Meera", avatarColorValue: 0, openingBalance: 0 });
    const expense = await r.expenses.createExpense({
      description: "Dinner",
      totalAmount: 1_000,
      date: new Date(2026, 9, 4, 20),
      categoryId: "food",
      accountId: bank.id,
      splitType: "equal",
      participantInputs: [
        { name: "Me", isMe: true, value: null },
        { personId: meera.id, name: "Meera", value: null },
      ],
    });
    const txn = (await r.transactions.getByKey(expense.transactionId))!;

    // Transaction Studio grid / manage modal / generic modal path.
    await expect(r.transactions.editTransaction(txn, { amount: 1_400 })).rejects.toBeInstanceOf(OwnedTransactionEditError);
    await expect(r.transactions.softDeleteTransaction(txn)).rejects.toBeInstanceOf(OwnedTransactionDeleteError);
    await r.transactions.editTransaction(txn, { description: "Team dinner" }); // text is not ownership
    expect(await balanceOf(r.accounts, bank.id)).toBe(9_000);
    expect(await personBalance(r.people, meera.id)).toBe(500);

    // The owning edit: total and shares move together.
    const installments = await r.installmentRepositoryFor(expense.scheduleId!).getAll();
    await r.expenses.editExpense({
      expense,
      currentInstallments: installments,
      totalAmount: 1_400,
      splitType: "equal",
      participantInputs: [
        { name: "Me", isMe: true, value: null },
        { personId: meera.id, name: "Meera", value: null },
      ],
    });
    expect(await balanceOf(r.accounts, bank.id)).toBe(8_600);
    expect(await personBalance(r.people, meera.id)).toBe(700);

    // The owning delete: account and shares together.
    await r.expenses.deleteExpense((await r.expenses.getByKey(expense.id))!);
    expect(await balanceOf(r.accounts, bank.id)).toBe(10_000);
    expect(await personBalance(r.people, meera.id)).toBe(0);
    await expectNoDrift(r);
  });
});

describe("P0-03 — People entry delete / restore are idempotent", () => {
  async function ashaWithEntry(r: ReturnType<typeof setup>) {
    const asha = await r.people.createPerson({ name: "Asha", avatarColorValue: 0, openingBalance: 0 });
    const ledger = r.ledgerFor(asha.id);
    const entry = await ledger.addEntry(asha, { type: "gave", amount: 1_500, date: new Date(2026, 9, 3) });
    return { asha, ledger, entry };
  }

  it("17 + 18. delete once reverses; the same delete again changes nothing", async () => {
    const r = setup();
    const { asha, ledger, entry } = await ashaWithEntry(r);
    await ledger.softDeleteEntry(asha, entry);
    expect(await personBalance(r.people, asha.id)).toBe(0);
    await ledger.softDeleteEntry(asha, entry);
    expect(await personBalance(r.people, asha.id)).toBe(0);
    await expectNoDrift(r);
  });

  it("19. concurrent deletes from two tabs converge", async () => {
    const r = setup();
    const { asha, ledger, entry } = await ashaWithEntry(r);
    await Promise.all([ledger.softDeleteEntry(asha, entry), ledger.softDeleteEntry(asha, entry)]);
    expect(await personBalance(r.people, asha.id)).toBe(0);
    await expectNoDrift(r);
  });

  it("20 + 21 + 22. restore once applies; restore twice / concurrently applies once", async () => {
    const r = setup();
    const { asha, ledger, entry } = await ashaWithEntry(r);
    await ledger.softDeleteEntry(asha, entry);
    await ledger.restoreEntry(asha, entry);
    expect(await personBalance(r.people, asha.id)).toBe(1_500);
    await ledger.restoreEntry(asha, entry);
    await Promise.all([ledger.restoreEntry(asha, entry), ledger.restoreEntry(asha, entry)]);
    expect(await personBalance(r.people, asha.id)).toBe(1_500);
    await expectNoDrift(r);
  });

  it("23. delete → restore → delete ends at zero", async () => {
    const r = setup();
    const { asha, ledger, entry } = await ashaWithEntry(r);
    await ledger.softDeleteEntry(asha, entry);
    await ledger.restoreEntry(asha, entry);
    await ledger.softDeleteEntry(asha, entry);
    expect(await personBalance(r.people, asha.id)).toBe(0);
    await expectNoDrift(r);
  });

  it("24 + 25. a stale tab's delete after another tab edited the amount reverses the CURRENT amount; stored = canonical", async () => {
    const r = setup();
    const { asha, ledger, entry: stale } = await ashaWithEntry(r);
    await ledger.editEntry(asha, stale, { amount: 2_000 });
    expect(await personBalance(r.people, asha.id)).toBe(2_000);
    await ledger.softDeleteEntry(asha, stale); // stale copy says ₹1,500
    expect(await personBalance(r.people, asha.id)).toBe(0);
    await expectNoDrift(r);
  });

  it("the read-only detector flags drift it is given (it never writes)", async () => {
    const r = setup();
    const { asha } = await ashaWithEntry(r);
    const p = (await r.people.getByKey(asha.id))!;
    expect(personBalanceDrift({ ...p, currentBalance: 3_000 }, await r.ledgerFor(asha.id).getAll())).toEqual({ id: asha.id, stored: 3_000, expected: 1_500, drift: 1_500 });
  });
});

// ─────────────────────────────── Phase 2: People / Split (P1-01, P1-09, P1-10) ───────────────────────────────

function phase2() {
  const r = setup();
  const db = testEnv.authenticatedContext(UID).firestore() as unknown as Firestore;
  const paymentsFor = (personId: string) =>
    new PersonPaymentRepository({
      personRepository: r.people,
      ledgerRepository: r.ledgerFor(personId),
      transactionRepository: r.transactions,
      advanceApplications: collection(db, "users", UID, "people", personId, "advanceApplications").withConverter({
        toFirestore: advanceApplicationToFirestore,
        fromFirestore: advanceApplicationFromFirestore,
      }),
      expenseDocRef: (id) => r.expenses.docRef(id),
      installmentDocRef: (scheduleId, id) => r.installmentRepositoryFor(scheduleId).docRef(id),
      installmentPaymentDocRef: (scheduleId, installmentId, paymentId) => r.installmentPaymentRepositoryFor(scheduleId, installmentId).docRef(paymentId),
      cashLegCategoryId: "personal-loan",
    });
  return { ...r, paymentsFor };
}
type P2 = ReturnType<typeof phase2>;

/** The money every section reads, from live documents. */
async function money(r: P2) {
  const transactions = await r.transactions.getAll();
  const expenses = await r.expenses.getAll();
  const accounts = await r.accounts.getAll();
  const people = await r.people.getAll();
  const ctx = mySpendContextFromRecords({ transactions, expenses, loans: [], emis: [] });
  return {
    income: round2(transactions.filter((t) => t.type === "income" && !isNonIncomeExpenseMovement(t) && !t.excludeFromCalculations).reduce((s, t) => s + t.amount, 0)),
    mySpend: round2(transactions.reduce((s, t) => s + myConsumptionAmount(t, ctx), 0)),
    // Accounts + People direct balances (no loans/EMIs in these scenarios) — `netWorthWithLoans`' inputs.
    netWorth: round2(accounts.reduce((s, a) => s + a.currentBalance, 0) + people.reduce((s, p) => s + p.currentBalance, 0)),
  };
}

async function dinner(r: P2, total = 2_000) {
  const card = await r.accounts.createAccount({ name: "Card", type: "card", openingBalance: 0, colorValue: 0 });
  const bank = await r.accounts.createAccount({ name: "Bank", type: "bank", openingBalance: 10_000, colorValue: 0 });
  const other = await r.accounts.createAccount({ name: "Cash", type: "cash", openingBalance: 500, colorValue: 0 });
  const amma = await r.people.createPerson({ name: "Amma", avatarColorValue: 0, openingBalance: 0 });
  const expense = await r.expenses.createExpense({
    description: "Dinner",
    totalAmount: total,
    date: new Date(2026, 9, 4, 20),
    categoryId: "food",
    accountId: card.id,
    splitType: "equal",
    participantInputs: [
      { name: "Me", isMe: true, value: null },
      { personId: amma.id, name: "Amma", value: null },
    ],
  });
  return { card, bank, other, amma, expense };
}

/** Record Payment for Amma's split share — exactly what the People row "Settle" now sends (`routeFor`). */
async function repay(r: P2, f: Awaited<ReturnType<typeof dinner>>, amount: number, opts: { line?: number; advance?: number; accountId?: string } = {}) {
  const expense = (await r.expenses.getByKey(f.expense.id))!;
  const participant = expense.participants.find((p) => p.personId === f.amma.id)!;
  const gave = (await r.ledgerFor(f.amma.id).getByTransactionRef(expense.transactionId)).find((e) => e.type === "gave")!;
  const person = (await r.people.getByKey(f.amma.id))!;
  return r.paymentsFor(f.amma.id).recordPayment(person, {
    direction: "theyPaid",
    amount,
    date: new Date(2026, 9, 6, 9),
    accountId: opts.accountId ?? f.bank.id,
    lines: [
      {
        key: `ledger:${gave.id}`,
        amount: opts.line ?? amount,
        route: {
          kind: "split",
          parentEntryId: gave.id,
          sourceKind: "splitExpense",
          expenseId: expense.id,
          participantKey: participantKey(participant),
          scheduleId: participant.installmentId ? expense.scheduleId! : "",
          installmentId: participant.installmentId!,
        },
      },
    ],
    extra: opts.advance ? { kind: "advance", amount: opts.advance } : null,
  });
}

describe("P1-01 — settling a split share records real money (Record Payment `split` route)", () => {
  it("1 + 7 + 8 + 9 + 10. full repayment: receivable 0, chosen account +₹1,000, income 0, My Spend and Net Worth unchanged", async () => {
    const r = phase2();
    const f = await dinner(r);
    const before = await money(r);
    expect(await personBalance(r.people, f.amma.id)).toBe(1_000);

    await repay(r, f, 1_000);

    expect(await personBalance(r.people, f.amma.id)).toBe(0);
    expect(await balanceOf(r.accounts, f.bank.id)).toBe(11_000);
    expect(await balanceOf(r.accounts, f.other.id)).toBe(500); // only the chosen account
    expect(await balanceOf(r.accounts, f.card.id)).toBe(-2_000); // the card still owes the full purchase
    const after = await money(r);
    expect(after.income).toBe(0);
    expect(after.mySpend).toBe(before.mySpend); // ₹1,000 — the historical expense is untouched
    expect(after.mySpend).toBe(1_000);
    expect(after.netWorth).toBe(before.netWorth);
    expect((await r.transactions.getByKey(f.expense.transactionId))!.amount).toBe(2_000);
    await expectNoDrift(r);
  });

  it("2 + 3. partial and multiple partial repayments", async () => {
    const r = phase2();
    const f = await dinner(r);
    await repay(r, f, 400);
    expect(await personBalance(r.people, f.amma.id)).toBe(600);
    expect(await balanceOf(r.accounts, f.bank.id)).toBe(10_400);
    await repay(r, f, 600);
    expect(await personBalance(r.people, f.amma.id)).toBe(0);
    expect(await balanceOf(r.accounts, f.bank.id)).toBe(11_000);
    const installment = (await r.installmentRepositoryFor(f.expense.scheduleId!).getAll())[0];
    expect(installment.amountPaid).toBe(1_000);
    await expectNoDrift(r);
  });

  it("4. overpayment ₹1,200 against ₹1,000: share settled, ₹200 held as advance, account +₹1,200 once, no income", async () => {
    const r = phase2();
    const f = await dinner(r);
    const before = await money(r);
    await repay(r, f, 1_200, { line: 1_000, advance: 200 });
    expect(await balanceOf(r.accounts, f.bank.id)).toBe(11_200);
    const entries = await r.ledgerFor(f.amma.id).getAll();
    const position = personPosition({ personId: f.amma.id, currentBalance: await personBalance(r.people, f.amma.id), loans: [], ledgerEntries: [], loanIds: new Set() });
    const breakdown = personBalanceBreakdown(position, entries.map(breakdownEntryOf), new Set());
    expect(breakdown.advance).toBe(-200); // held for Amma — neither payable nor income
    expect(breakdown.toGive).toBe(0);
    expect(breakdown.toReceive).toBe(0);
    const after = await money(r);
    expect(after.income).toBe(0);
    expect(after.netWorth).toBe(before.netWorth);
    await expectNoDrift(r);
  });

  it("5. reverting the repayment restores receivable, account and installment exactly", async () => {
    const r = phase2();
    const f = await dinner(r);
    const paymentId = await repay(r, f, 1_000);
    await r.paymentsFor(f.amma.id).revertPayment((await r.people.getByKey(f.amma.id))!, paymentId);
    expect(await personBalance(r.people, f.amma.id)).toBe(1_000);
    expect(await balanceOf(r.accounts, f.bank.id)).toBe(10_000);
    expect((await r.installmentRepositoryFor(f.expense.scheduleId!).getAll())[0].amountPaid).toBe(0);
    await expectNoDrift(r);
  });

  it("6. a duplicate submit from the same (now stale) screen is refused — cash recorded once", async () => {
    const r = phase2();
    const f = await dinner(r);
    const stalePerson = (await r.people.getByKey(f.amma.id))!;
    await repay(r, f, 1_000);
    await expect(
      r.paymentsFor(f.amma.id).recordPayment(stalePerson, { direction: "theyPaid", amount: 1_000, date: new Date(), accountId: f.bank.id, lines: [], extra: { kind: "advance", amount: 1_000 } }),
    ).rejects.toBeInstanceOf(StalePersonPaymentError);
    expect(await balanceOf(r.accounts, f.bank.id)).toBe(11_000);
    await expectNoDrift(r);
  });
});

describe("P1-09 — split edit / delete are atomic and idempotent", () => {
  const meAnd = (...people: { id: string; name: string }[]) => [{ name: "Me", isMe: true, value: null }, ...people.map((p) => ({ personId: p.id, name: p.name, value: null }))];

  async function edit(r: P2, expenseId: string, patch: Omit<EditExpenseParams, "expense" | "currentInstallments">) {
    const expense = (await r.expenses.getByKey(expenseId))!;
    return r.expenses.editExpense({ expense, currentInstallments: await r.installmentRepositoryFor(expense.scheduleId!).getAll(), ...patch });
  }

  it("11. amount edit ₹1,000 → ₹1,400: transaction, expense, share ₹700 and a ₹400 account delta, together", async () => {
    const r = phase2();
    const f = await dinner(r, 1_000);
    await edit(r, f.expense.id, { totalAmount: 1_400, splitType: "equal", participantInputs: meAnd({ id: f.amma.id, name: "Amma" }) });
    expect((await r.transactions.getByKey(f.expense.transactionId))!.amount).toBe(1_400);
    expect((await r.expenses.getByKey(f.expense.id))!.totalAmount).toBe(1_400);
    expect(await personBalance(r.people, f.amma.id)).toBe(700);
    expect(await balanceOf(r.accounts, f.card.id)).toBe(-1_400);
    expect((await r.installmentRepositoryFor(f.expense.scheduleId!).getAll())[0].amountDue).toBe(700);
    expect((await money(r)).mySpend).toBe(700);
    await expectNoDrift(r);
  });

  it("12. share edit (custom ₹300 me / ₹700 Amma) moves only the shares", async () => {
    const r = phase2();
    const f = await dinner(r, 1_000);
    await edit(r, f.expense.id, { splitType: "custom", participantInputs: [{ name: "Me", isMe: true, value: 300 }, { personId: f.amma.id, name: "Amma", value: 700 }] });
    expect(await personBalance(r.people, f.amma.id)).toBe(700);
    expect(await balanceOf(r.accounts, f.card.id)).toBe(-1_000);
    expect((await money(r)).mySpend).toBe(300);
    await expectNoDrift(r);
  });

  it("13 + 14. add a participant, then remove them — share, installment and balance follow", async () => {
    const r = phase2();
    const f = await dinner(r, 1_500);
    const ravi = await r.people.createPerson({ name: "Ravi", avatarColorValue: 0, openingBalance: 0 });
    await edit(r, f.expense.id, { splitType: "equal", participantInputs: meAnd({ id: f.amma.id, name: "Amma" }, { id: ravi.id, name: "Ravi" }) });
    expect(await personBalance(r.people, f.amma.id)).toBe(500);
    expect(await personBalance(r.people, ravi.id)).toBe(500);
    const expense = (await r.expenses.getByKey(f.expense.id))!;
    const raviInstallment = expense.participants.find((p) => p.personId === ravi.id)!.installmentId!;
    expect((await r.installmentRepositoryFor(expense.scheduleId!).getByKey(raviInstallment))!.amountDue).toBe(500);

    await edit(r, f.expense.id, { splitType: "equal", participantInputs: meAnd({ id: f.amma.id, name: "Amma" }) });
    expect(await personBalance(r.people, ravi.id)).toBe(0);
    expect(await personBalance(r.people, f.amma.id)).toBe(750);
    expect((await r.installmentRepositoryFor(expense.scheduleId!).getByKey(raviInstallment))!.deletedAt).not.toBeNull();
    expect(await balanceOf(r.accounts, f.card.id)).toBe(-1_500);
    await expectNoDrift(r);
  });

  it("15. edit after a partial repayment keeps what was paid; a share below it is refused with nothing changed", async () => {
    const r = phase2();
    const f = await dinner(r, 1_000);
    await repay(r, f, 300);
    await edit(r, f.expense.id, { totalAmount: 1_400, splitType: "equal", participantInputs: meAnd({ id: f.amma.id, name: "Amma" }) });
    expect(await personBalance(r.people, f.amma.id)).toBe(400); // 700 share − 300 paid
    await expect(
      edit(r, f.expense.id, { splitType: "custom", participantInputs: [{ name: "Me", isMe: true, value: 1_200 }, { personId: f.amma.id, name: "Amma", value: 200 }] }),
    ).rejects.toThrow(/can't be reduced/);
    expect(await personBalance(r.people, f.amma.id)).toBe(400);
    expect(await balanceOf(r.accounts, f.card.id)).toBe(-1_400);
    await expectNoDrift(r);
  });

  it("16 + 17. delete reverses the account and retires every share once; deleting again changes nothing", async () => {
    const r = phase2();
    const f = await dinner(r);
    const stale = (await r.expenses.getByKey(f.expense.id))!;
    await r.expenses.deleteExpense(stale);
    await r.expenses.deleteExpense(stale);
    expect(await balanceOf(r.accounts, f.card.id)).toBe(0);
    expect(await personBalance(r.people, f.amma.id)).toBe(0);
    expect((await money(r)).mySpend).toBe(0);
    await expectNoDrift(r);
  });

  it("18. concurrent deletes from two tabs converge", async () => {
    const r = phase2();
    const f = await dinner(r);
    const stale = (await r.expenses.getByKey(f.expense.id))!;
    await Promise.all([r.expenses.deleteExpense(stale), r.expenses.deleteExpense(stale)]);
    expect(await balanceOf(r.accounts, f.card.id)).toBe(0);
    expect(await personBalance(r.people, f.amma.id)).toBe(0);
    await expectNoDrift(r);
  });

  it("19. a failure inside the edit leaves EVERYTHING as it was", async () => {
    const r = phase2();
    const f = await dinner(r, 1_000);
    const spy = vi.spyOn(r.people, "applyBalanceDelta").mockImplementationOnce(() => {
      throw new Error("injected failure");
    });
    await expect(edit(r, f.expense.id, { totalAmount: 1_400, splitType: "equal", participantInputs: meAnd({ id: f.amma.id, name: "Amma" }) })).rejects.toThrow("injected failure");
    spy.mockRestore();
    expect((await r.transactions.getByKey(f.expense.transactionId))!.amount).toBe(1_000);
    expect((await r.expenses.getByKey(f.expense.id))!.totalAmount).toBe(1_000);
    expect(await personBalance(r.people, f.amma.id)).toBe(500);
    expect(await balanceOf(r.accounts, f.card.id)).toBe(-1_000);
    expect((await r.installmentRepositoryFor(f.expense.scheduleId!).getAll())[0].amountDue).toBe(500);
    await expectNoDrift(r);
  });

  it("20. a failure inside the delete leaves EVERYTHING as it was", async () => {
    const r = phase2();
    const f = await dinner(r);
    const spy = vi.spyOn(r.people, "applyBalanceDelta").mockImplementationOnce(() => {
      throw new Error("injected failure");
    });
    await expect(r.expenses.deleteExpense((await r.expenses.getByKey(f.expense.id))!)).rejects.toThrow("injected failure");
    spy.mockRestore();
    expect((await r.transactions.getByKey(f.expense.transactionId))!.deletedAt).toBeNull();
    expect((await r.expenses.getByKey(f.expense.id))!.deletedAt).toBeNull();
    expect(await balanceOf(r.accounts, f.card.id)).toBe(-2_000);
    expect(await personBalance(r.people, f.amma.id)).toBe(1_000);
    await expectNoDrift(r);
  });
});

describe("P1-10 — split restore restores exactly what its delete retired", () => {
  it("21 + 24 + 25. delete → restore brings back account and share once; restore twice / concurrently changes nothing more", async () => {
    const r = phase2();
    const f = await dinner(r);
    const expense = (await r.expenses.getByKey(f.expense.id))!;
    await r.expenses.deleteExpense(expense);
    await r.expenses.restoreExpense(expense);
    await r.expenses.restoreExpense(expense);
    await Promise.all([r.expenses.restoreExpense(expense), r.expenses.restoreExpense(expense)]);
    expect(await balanceOf(r.accounts, f.card.id)).toBe(-2_000);
    expect(await personBalance(r.people, f.amma.id)).toBe(1_000);
    expect((await r.installmentRepositoryFor(expense.scheduleId!).getAll())).toHaveLength(1);
    expect((await r.ledgerFor(f.amma.id).getAll()).every((e) => (e.retiredBy ?? null) === null)).toBe(true);
    await expectNoDrift(r);
  });

  it("22 + 23. an entry retired BEFORE the delete stays retired; the active participant comes back", async () => {
    const r = phase2();
    const bank = await r.accounts.createAccount({ name: "Bank", type: "bank", openingBalance: 10_000, colorValue: 0 });
    const amma = await r.people.createPerson({ name: "Amma", avatarColorValue: 0, openingBalance: 0 });
    const kiran = await r.people.createPerson({ name: "Kiran", avatarColorValue: 0, openingBalance: 0 });
    let expense = await r.expenses.createExpense({
      description: "Tickets",
      totalAmount: 1_200,
      date: new Date(2026, 9, 4, 20),
      categoryId: "fun",
      accountId: bank.id,
      splitType: "custom",
      participantInputs: [
        { personId: amma.id, name: "Amma", value: 400 },
        { personId: kiran.id, name: "Kiran", value: 800 },
      ],
    });
    // Kiran: a LEGACY ledger-only ✓ "received" status entry (pre-guard data), then ✕ undo — the status entry
    // is retired before any delete.
    await r.ledgerFor(kiran.id).addEntry((await r.people.getByKey(kiran.id))!, {
      type: "receivedBack",
      amount: 800,
      date: expense.date,
      note: `Received: ${expense.description}`,
      transactionRef: expense.transactionId,
      receivedStatus: "received",
    });
    expense = { ...expense, participants: expense.participants.map((p) => (p.personId === kiran.id ? { ...p, receivedStatus: "received" as const } : p)) };
    await r.expenses.update(expense);
    expense = await r.expenses.setParticipantReceivedStatus(expense, expense.participants.find((p) => p.personId === kiran.id)!, "yetToReceive");
    expect(await personBalance(r.people, kiran.id)).toBe(800);

    await r.expenses.deleteExpense(expense);
    expect(await personBalance(r.people, kiran.id)).toBe(0);
    expect(await personBalance(r.people, amma.id)).toBe(0);
    await r.expenses.restoreExpense(expense);

    expect(await personBalance(r.people, kiran.id)).toBe(800); // the undone ✓ entry stays retired
    expect(await personBalance(r.people, amma.id)).toBe(400);
    expect((await r.ledgerFor(kiran.id).getAll()).filter((e) => e.type === "receivedBack")).toHaveLength(0);
    expect(await balanceOf(r.accounts, bank.id)).toBe(8_800);
    await expectNoDrift(r);
  });

  it("26. a legacy delete (no provenance on its entries) restores the expense but resurrects no People entry", async () => {
    const r = phase2();
    const f = await dinner(r);
    const expense = (await r.expenses.getByKey(f.expense.id))!;
    await r.expenses.deleteExpense(expense);
    // Simulate a delete made before provenance existed.
    const ledger = r.ledgerFor(f.amma.id);
    for (const e of await ledger.getTrash()) await ledger.update({ ...e, retiredBy: null });

    await r.expenses.restoreExpense(expense);
    expect(await balanceOf(r.accounts, f.card.id)).toBe(-2_000); // transaction back
    expect(await personBalance(r.people, f.amma.id)).toBe(0); // share NOT resurrected — unproven
    expect(await r.ledgerFor(f.amma.id).getAll()).toHaveLength(0);
    await expectNoDrift(r);
  });
});

describe("Existing-data detector — split links (read-only)", () => {
  it("flags a split whose parent, transaction and People shares disagree; a consistent split is clean", async () => {
    const r = phase2();
    const f = await dinner(r);
    const read = async () => {
      const expense = (await r.expenses.getByKey(f.expense.id))!;
      return splitLinkDrift({
        expense,
        transaction: await r.transactions.getByKey(expense.transactionId),
        installments: await r.installmentRepositoryFor(expense.scheduleId!).getAll(),
        entriesByPerson: new Map([[f.amma.id, await r.ledgerFor(f.amma.id).getByTransactionRef(expense.transactionId)]]),
      });
    };
    expect(await read()).toEqual([]);
    const txn = (await r.transactions.getByKey(f.expense.transactionId))!;
    await r.transactions.update({ ...txn, amount: 2_500 }); // a desync written outside the app's paths
    expect((await read()).map((d) => d.kind)).toContain("transactionAmount");
  });
});

describe("✓ Received = real money (People quick action → Record payment)", () => {
  /** AMMA owes me ₹1,000 through an ordinary People entry: I gave her ₹1,000 cash from Bank. */
  async function ordinaryLoan(r: P2) {
    const bank = await r.accounts.createAccount({ name: "Bank", type: "bank", openingBalance: 10_000, colorValue: 0 });
    const other = await r.accounts.createAccount({ name: "Cash", type: "cash", openingBalance: 500, colorValue: 0 });
    const amma = await r.people.createPerson({ name: "Amma", avatarColorValue: 0, openingBalance: 0 });
    const { entry } = await r.ledgerFor(amma.id).addEntryWithTransaction(
      amma,
      { type: "gave", amount: 1_000, date: new Date(2026, 9, 1, 10) },
      { type: "expense", accountId: bank.id, categoryId: "personal-loan" },
      r.transactions,
    );
    return { bank, other, amma, entry };
  }

  /** Exactly what the ✓ now opens: Record payment with this `ledger:<id>` obligation preselected (`routeFor` → entry). */
  async function received(r: P2, f: Awaited<ReturnType<typeof ordinaryLoan>>, amount: number, accountId = f.bank.id) {
    const person = (await r.people.getByKey(f.amma.id))!;
    return r.paymentsFor(f.amma.id).recordPayment(person, {
      direction: "theyPaid",
      amount,
      date: new Date(2026, 9, 7, 9),
      accountId,
      lines: [{ key: `ledger:${f.entry.id}`, amount, route: { kind: "entry", parentEntryId: f.entry.id } }],
      extra: null,
    });
  }

  it("1–8 + 14. an ordinary obligation: account required; Bank +₹1,000, receivable 0, income 0, My Spend and Net Worth unchanged", async () => {
    const r = phase2();
    const f = await ordinaryLoan(r);
    const before = await money(r);
    expect(await personBalance(r.people, f.amma.id)).toBe(1_000);

    await expect(received(r, f, 1_000, "")).rejects.toThrow(/Choose the account/);
    expect(await balanceOf(r.accounts, f.bank.id)).toBe(9_000);

    await received(r, f, 1_000);
    expect(await balanceOf(r.accounts, f.bank.id)).toBe(10_000);
    expect(await balanceOf(r.accounts, f.other.id)).toBe(500);
    expect(await personBalance(r.people, f.amma.id)).toBe(0);
    const after = await money(r);
    expect(after.income).toBe(0);
    expect(after.mySpend).toBe(before.mySpend);
    expect(after.netWorth).toBe(before.netWorth);
    await expectNoDrift(r);
  });

  it("9 + 10 + 11. partial receipt works; a duplicate submit from the same (stale) screen records no second cash", async () => {
    const r = phase2();
    const f = await ordinaryLoan(r);
    const stale = (await r.people.getByKey(f.amma.id))!;
    await received(r, f, 400);
    expect(await personBalance(r.people, f.amma.id)).toBe(600);
    expect(await balanceOf(r.accounts, f.bank.id)).toBe(9_400);
    await expect(
      r.paymentsFor(f.amma.id).recordPayment(stale, {
        direction: "theyPaid",
        amount: 400,
        date: new Date(),
        accountId: f.bank.id,
        lines: [{ key: `ledger:${f.entry.id}`, amount: 400, route: { kind: "entry", parentEntryId: f.entry.id } }],
        extra: null,
      }),
    ).rejects.toBeInstanceOf(StalePersonPaymentError);
    expect(await balanceOf(r.accounts, f.bank.id)).toBe(9_400);
    await expectNoDrift(r);
  });

  it("12. revert restores both the cash and the receivable", async () => {
    const r = phase2();
    const f = await ordinaryLoan(r);
    const paymentId = await received(r, f, 1_000);
    await r.paymentsFor(f.amma.id).revertPayment((await r.people.getByKey(f.amma.id))!, paymentId);
    expect(await balanceOf(r.accounts, f.bank.id)).toBe(9_000);
    expect(await personBalance(r.people, f.amma.id)).toBe(1_000);
    await expectNoDrift(r);
  });

  it("13. a split-derived obligation behaves the same (cash in, receivable out, Net Worth unchanged)", async () => {
    const r = phase2();
    const f = await dinner(r);
    const before = await money(r);
    await repay(r, f, 1_000);
    expect(await balanceOf(r.accounts, f.bank.id)).toBe(11_000);
    expect(await personBalance(r.people, f.amma.id)).toBe(0);
    expect((await money(r)).netWorth).toBe(before.netWorth);
  });

  it("the old cashless write paths are refused at the write layer: ✓ toggle to 'received' and 'already paid' at creation", async () => {
    const r = phase2();
    const f = await dinner(r);
    const expense = (await r.expenses.getByKey(f.expense.id))!;
    const participant = expense.participants.find((p) => p.personId === f.amma.id)!;
    await expect(r.expenses.setParticipantReceivedStatus(expense, participant, "received")).rejects.toBeInstanceOf(ReceivedWithoutCashError);
    await expect(
      r.expenses.createExpense({
        description: "Lunch",
        totalAmount: 600,
        date: new Date(2026, 9, 5),
        categoryId: "food",
        accountId: f.bank.id,
        splitType: "equal",
        participantInputs: [
          { name: "Me", isMe: true, value: null },
          { personId: f.amma.id, name: "Amma", value: null, receivedStatus: "received" },
        ],
      }),
    ).rejects.toBeInstanceOf(ReceivedWithoutCashError);
    expect(await personBalance(r.people, f.amma.id)).toBe(1_000);
    expect(await balanceOf(r.accounts, f.bank.id)).toBe(10_000);
    expect(await r.expenses.getAll()).toHaveLength(1);
    await expectNoDrift(r);
  });
});
