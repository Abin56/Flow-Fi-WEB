/**
 * Master Financial Integrity Audit (2026-10-16) — emulator-backed synthetic scenarios for
 * `docs/FLOWFI_WEB_MASTER_FINANCIAL_INTEGRITY_AUDIT.md`.
 *
 * Two kinds of test:
 *  - MFI-P1-01 / MFI-P1-02: regression tests for the repaired stale-edit-of-a-trashed-record defects.
 *  - Lifecycle scenarios: connected, multi-module sequences whose every step is asserted against an expected
 *    balance computed independently in integer paise (never read back from the code under test), then
 *    cross-checked with the read-only drift detectors in `lib/engines/stored-balance-drift.ts`.
 *
 * Synthetic data only. Run via `npm run test:integration`.
 */

import { readFileSync } from "node:fs";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, getDocs, query, where, type Firestore } from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { accountBalanceDrift, personBalanceDrift } from "@/lib/engines/stored-balance-drift";
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
import {
  advanceApplicationFromFirestore,
  advanceApplicationToFirestore,
  ledgerEntryFromFirestore,
  ledgerEntryToFirestore,
  personFromFirestore,
  personToFirestore,
} from "@/lib/models/person";
import { transactionFromFirestore, transactionToFirestore } from "@/lib/models/transaction";
import { AccountRepository } from "@/lib/repositories/account-repository";
import { ExpenseRepository, participantKey } from "@/lib/repositories/expense-repository";
import { LoanAdvancePaymentRepository } from "@/lib/repositories/loan-advance-payment-repository";
import { LoanRepository } from "@/lib/repositories/loan-repository";
import { InstallmentPaymentRepository, InstallmentRepository, PaymentScheduleRepository } from "@/lib/repositories/payment-schedule-repository";
import { PersonPaymentRepository } from "@/lib/repositories/person-payment-repository";
import { LedgerRepository, PersonRepository } from "@/lib/repositories/person-repository";
import { TransactionDeletedError, TransactionRepository } from "@/lib/repositories/transaction-repository";

const PROJECT_ID = "flowfi-master-financial-integrity-audit";
const UID = "master-audit-uid";
const LOAN_DATE = new Date(2026, 0, 10);
const FIRST_DUE = new Date(2026, 1, 10);
const NOON_FIRST_DUE = new Date(2026, 1, 10, 12);

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
  // Wired exactly like `createTransactionRepository`.
  const transactions = new TransactionRepository(
    collection(db, "users", UID, "transactions").withConverter({ toFirestore: transactionToFirestore, fromFirestore: transactionFromFirestore }),
    accounts,
  ).withExpenseOwnerLookup(async (transactionId) => (await getDocs(query(expensesCol, where("transactionId", "==", transactionId)))).docs.map((d) => d.ref));
  const people = new PersonRepository(collection(db, "users", UID, "people").withConverter({ toFirestore: personToFirestore, fromFirestore: personFromFirestore }));
  const ledgerFor = (personId: string) =>
    new LedgerRepository(
      collection(db, "users", UID, "people", personId, "ledger").withConverter({ toFirestore: ledgerEntryToFirestore, fromFirestore: ledgerEntryFromFirestore }),
      people,
    );
  const installmentsRef = (scheduleId: string) =>
    collection(db, "users", UID, "paymentSchedules", scheduleId, "installments").withConverter({ toFirestore: installmentToFirestore, fromFirestore: installmentFromFirestore });
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
  const loans = new LoanRepository(
    collection(db, "users", UID, "loans").withConverter({ toFirestore: loanToFirestore, fromFirestore: loanFromFirestore }),
    schedules,
    installmentRepositoryFor,
  );
  const lender = new LoanAdvancePaymentRepository(db, UID);
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
  return { db, accounts, transactions, people, ledgerFor, expenses, loans, lender, paymentsFor, installmentRepositoryFor };
}
type R = ReturnType<typeof setup>;

/** Integer paise — every expected value below is computed and compared as an exact integer. */
const paise = (rupees: number) => Math.round(rupees * 100);
const bal = async (r: R, id: string) => paise((await r.accounts.getByKey(id))!.currentBalance);
const owed = async (r: R, id: string) => paise((await r.people.getByKey(id))!.currentBalance);

/** Every stored balance agrees with its own live records (the read-only detector — it never writes). */
async function expectNoDrift(r: R) {
  const allTxns = [...(await r.transactions.getAll()), ...(await r.transactions.getTrash())];
  for (const a of await r.accounts.getAll()) expect(accountBalanceDrift(a, allTxns), `account ${a.name}`).toBeNull();
  for (const p of await r.people.getAll()) {
    const ledger = r.ledgerFor(p.id);
    expect(personBalanceDrift(p, [...(await ledger.getAll()), ...(await ledger.getTrash())]), `person ${p.name}`).toBeNull();
  }
}

// ─────────────────────────────────────────────── Confirmed defect pins ───────────────────────────────────────────────

describe("MFI-P1-01 — a stale edit of a TRASHED transaction is rejected with zero side effects (FIXED)", () => {
  it("tab A deletes ₹1,000, tab B (stale) saves ₹2,000 → rejected; account, trash and history unchanged", async () => {
    const r = setup();
    const bank = await r.accounts.createAccount({ name: "Bank", type: "bank", openingBalance: 5_000, colorValue: 0 });
    const other = await r.accounts.createAccount({ name: "Other", type: "bank", openingBalance: 700, colorValue: 0 });
    const staleCopy = await r.transactions.createTransaction({ type: "expense", amount: 1_000, dateTime: new Date(2026, 9, 1, 10), accountId: bank.id, categoryId: "cat" });
    await r.transactions.softDeleteTransaction(staleCopy);
    const before = (await r.accounts.getByKey(bank.id))!;
    const trashedBefore = (await r.transactions.getTrash()).find((t) => t.id === staleCopy.id)!;

    for (const params of [{ amount: 2_000 }, { accountId: other.id }, { type: "income" as const }, { excludeFromCalculations: true }, { description: "x" }]) {
      await expect(r.transactions.editTransaction(staleCopy, params)).rejects.toBeInstanceOf(TransactionDeletedError);
    }
    expect(await bal(r, bank.id)).toBe(paise(5_000));
    expect(await bal(r, other.id)).toBe(paise(700));
    expect((await r.accounts.getByKey(bank.id))!.editHistory.length).toBe(before.editHistory.length); // no write at all
    expect((await r.transactions.getTrash()).find((t) => t.id === staleCopy.id)).toEqual(trashedBefore);
    await expectNoDrift(r);

    // Restore → the same edit is legitimate again and applies once.
    await r.transactions.restoreTransaction(staleCopy);
    await r.transactions.editTransaction(staleCopy, { amount: 2_000 });
    expect(await bal(r, bank.id)).toBe(paise(3_000));
    await expectNoDrift(r);
  });

  it("a missing transaction is rejected before any balance change", async () => {
    const r = setup();
    const bank = await r.accounts.createAccount({ name: "Bank", type: "bank", openingBalance: 5_000, colorValue: 0 });
    const ghost = await r.transactions.createTransaction({ type: "expense", amount: 1_000, dateTime: new Date(2026, 9, 1), accountId: bank.id, categoryId: "cat" });
    await r.transactions.softDeleteTransaction(ghost);
    await r.transactions.permanentlyDeleteTransaction((await r.transactions.getTrash()).find((t) => t.id === ghost.id)!);
    await expect(r.transactions.editTransaction(ghost, { amount: 9_000 })).rejects.toThrow(/not found/i);
    expect(await bal(r, bank.id)).toBe(paise(5_000));
  });

  it("concurrent edit + delete converge: the account ends at exactly one outcome, never both applied", async () => {
    for (let i = 0; i < 4; i++) {
      const r = setup();
      const bank = await r.accounts.createAccount({ name: "Bank", type: "bank", openingBalance: 5_000, colorValue: 0 });
      const t = await r.transactions.createTransaction({ type: "expense", amount: 1_000, dateTime: new Date(2026, 9, 1), accountId: bank.id, categoryId: "cat" });
      await Promise.allSettled([r.transactions.editTransaction(t, { amount: 2_000 }), r.transactions.softDeleteTransaction(t)]);
      const live = (await r.transactions.getAll()).some((x) => x.id === t.id);
      // Deleted (edit-then-delete is refused as stale, delete-then-edit as deleted) → 5,000; or the edit won and
      // the delete was refused as stale → live at 2,000 (3,000 left). Nothing in between.
      expect(await bal(r, bank.id)).toBe(live ? paise(3_000) : paise(5_000));
      await expectNoDrift(r);
    }
  }, 60_000);

  it("idempotent retries and legitimate edits are unaffected", async () => {
    const r = setup();
    const bank = await r.accounts.createAccount({ name: "Bank", type: "bank", openingBalance: 5_000, colorValue: 0 });
    const t = await r.transactions.createTransaction({ type: "expense", amount: 1_000, dateTime: new Date(2026, 9, 1), accountId: bank.id, categoryId: "cat" });
    await r.transactions.editTransaction(t, { amount: 1_500, description: "Groceries" });
    await r.transactions.editTransaction(t, { amount: 1_500 }); // same value again (retry)
    expect(await bal(r, bank.id)).toBe(paise(3_500));
    await r.transactions.softDeleteTransaction((await r.transactions.getByKey(t.id))!);
    await r.transactions.softDeleteTransaction((await r.transactions.getByKey(t.id))!); // idempotent retry
    expect(await bal(r, bank.id)).toBe(paise(5_000));
    await expectNoDrift(r);
  });
});

describe("MFI-P1-02 — a stale edit of a TRASHED People entry is rejected with zero side effects (FIXED)", () => {
  it("delete ₹1,500 in one tab, stale edit in another → rejected; person, account, cash leg unchanged", async () => {
    const r = setup();
    const bank = await r.accounts.createAccount({ name: "Bank", type: "bank", openingBalance: 10_000, colorValue: 0 });
    const ravi = await r.people.createPerson({ name: "Ravi", avatarColorValue: 0, openingBalance: 0 });
    const ledger = r.ledgerFor(ravi.id);
    const { entry, transaction } = await ledger.addEntryWithTransaction(
      ravi,
      { type: "gave", amount: 1_500, date: new Date(2026, 9, 3, 10) },
      { type: "expense", accountId: bank.id, categoryId: "personal-loan" },
      r.transactions,
    );
    await ledger.softDeleteEntriesWithCashLegs(ravi, [entry], r.transactions);
    expect(await bal(r, bank.id)).toBe(paise(10_000));
    expect(await owed(r, ravi.id)).toBe(0);
    const trashedLeg = (await r.transactions.getTrash()).find((t) => t.id === transaction.id)!;

    await expect(ledger.editEntry(ravi, entry, { amount: 2_000 }, r.transactions)).rejects.toThrow(/deleted in another tab/);
    await expect(ledger.editEntry(ravi, entry, { note: "n" })).rejects.toThrow(/deleted in another tab/);
    expect(await owed(r, ravi.id)).toBe(0);
    expect(await bal(r, bank.id)).toBe(paise(10_000));
    expect((await r.transactions.getTrash()).find((t) => t.id === transaction.id)).toEqual(trashedLeg);
    await expectNoDrift(r);
  });

  it("an entry addressed through the wrong person, or one owned by a recorded payment, is refused", async () => {
    const r = setup();
    const bank = await r.accounts.createAccount({ name: "Bank", type: "bank", openingBalance: 1_000, colorValue: 0 });
    const a = await r.people.createPerson({ name: "A", avatarColorValue: 0, openingBalance: 0 });
    const b = await r.people.createPerson({ name: "B", avatarColorValue: 0, openingBalance: 0 });
    const ledgerA = r.ledgerFor(a.id);
    const entry = await ledgerA.addEntry(a, { type: "gave", amount: 300, date: new Date(2026, 9, 3) });
    await expect(ledgerA.editEntry(b, entry, { amount: 400 })).rejects.toThrow(/different person/);
    expect(await owed(r, a.id)).toBe(paise(300));
    expect(await owed(r, b.id)).toBe(0);

    // A Record Payment entry (paymentId) changes only through edit / revert payment.
    const paymentId = await r.paymentsFor(a.id).recordPayment((await r.people.getByKey(a.id))!, {
      direction: "theyPaid",
      amount: 100,
      date: new Date(2026, 9, 4),
      accountId: bank.id,
      lines: [{ key: `ledger:${entry.id}`, amount: 100, route: { kind: "entry", parentEntryId: entry.id } }],
      extra: null,
    });
    const settlement = (await ledgerA.getByPaymentId(paymentId))[0];
    await expect(ledgerA.editEntry((await r.people.getByKey(a.id))!, settlement, { amount: 50 })).rejects.toThrow(/recorded payment/);
    expect(await owed(r, a.id)).toBe(paise(200));
    expect(await bal(r, bank.id)).toBe(paise(1_100));
    await expectNoDrift(r);
  });

  it("legitimate edits still work and keep entry, person and cash leg in step; concurrent edit+delete converge", async () => {
    const r = setup();
    const bank = await r.accounts.createAccount({ name: "Bank", type: "bank", openingBalance: 10_000, colorValue: 0 });
    const ravi = await r.people.createPerson({ name: "Ravi", avatarColorValue: 0, openingBalance: 0 });
    const ledger = r.ledgerFor(ravi.id);
    const { entry } = await ledger.addEntryWithTransaction(ravi, { type: "gave", amount: 2_000, date: new Date(2026, 9, 3, 10) }, { type: "expense", accountId: bank.id, categoryId: "personal-loan" }, r.transactions);
    await ledger.editEntry(ravi, entry, { amount: 3_000 }, r.transactions);
    expect(await bal(r, bank.id)).toBe(paise(7_000));
    expect(await owed(r, ravi.id)).toBe(paise(3_000));
    await expectNoDrift(r);

    const person = (await r.people.getByKey(ravi.id))!;
    const plain = await ledger.addEntry(person, { type: "gave", amount: 500, date: new Date(2026, 9, 5) });
    const person2 = (await r.people.getByKey(ravi.id))!;
    await Promise.allSettled([ledger.editEntry(person2, plain, { amount: 900 }), ledger.softDeleteEntry(person2, plain)]);
    const after = (await ledger.getByKey(plain.id))!;
    expect(await owed(r, ravi.id)).toBe(paise(3_000) + (after.deletedAt == null ? paise(900) : 0));
    await expectNoDrift(r);
  });
});

describe("MFI-T1 — a loan's principal can't drift from its deposit (WFI-P1-07 fix had no test)", () => {
  it("editing the principal while the origination deposit is active is refused; nothing moves; a non-principal term edit still works", async () => {
    const r = setup();
    const bank = await r.accounts.createAccount({ name: "Bank", type: "bank", openingBalance: 5_000, colorValue: 0 });
    const created = await r.loans.createAgreementWithOrigination({
      idempotencyKey: "master-edit-terms-01",
      name: "Loan",
      category: "institutional",
      institutionName: "Bank",
      fundingSource: "bank",
      direction: "taken",
      loanAmount: 30_000,
      loanDate: LOAN_DATE,
      firstDueDate: FIRST_DUE,
      repaymentType: "installment",
      installmentFrequency: "monthly",
      installmentCount: 5,
      movementAccountId: bank.id,
    });
    expect(await bal(r, bank.id)).toBe(paise(35_000));
    const installments = await r.installmentRepositoryFor(created.loan.scheduleId).getAll();

    await expect(
      r.loans.editLoanTerms(created.loan, { currentInstallments: installments, loanAmount: 40_000, installmentFrequency: "monthly", newInstallmentCount: 5 }),
    ).rejects.toThrow(/deposited to an account/);
    expect(paise((await r.loans.getByKey(created.loan.id))!.loanAmount)).toBe(paise(30_000));
    expect(await bal(r, bank.id)).toBe(paise(35_000));

    // The same principal with a different count is still allowed (the deposit still matches).
    await r.loans.editLoanTerms(created.loan, { currentInstallments: installments, loanAmount: 30_000, installmentFrequency: "monthly", newInstallmentCount: 6 });
    expect(await bal(r, bank.id)).toBe(paise(35_000));
    await expectNoDrift(r);
  });
});

// ──────────────────────────────────────────── Connected lifecycle scenarios ────────────────────────────────────────────

describe("Lifecycle A — loan, shared expense, partial reimbursement, lender payment edit/reverse, card bill pay/cancel, backdated edit, delete", () => {
  it("every step lands exactly once; People stays independent of the lender; stored balances never drift", async () => {
    const r = setup();
    const bank = await r.accounts.createAccount({ name: "Bank", type: "bank", openingBalance: 100_000, colorValue: 0 });
    const savings = await r.accounts.createAccount({ name: "Savings", type: "bank", openingBalance: 20_000, colorValue: 0 });
    const card = await r.accounts.createAccount({ name: "Card", type: "card", openingBalance: 0, colorValue: 0 });
    const ravi = await r.people.createPerson({ name: "Ravi", avatarColorValue: 0, openingBalance: 0 });
    // Expected balances, in paise, tracked independently of anything read back.
    const exp = { bank: paise(100_000), savings: paise(20_000), card: 0, ravi: 0 };
    const check = async (label: string) => {
      expect(await bal(r, bank.id), `${label}: bank`).toBe(exp.bank);
      expect(await bal(r, savings.id), `${label}: savings`).toBe(exp.savings);
      expect(await bal(r, card.id), `${label}: card`).toBe(exp.card);
      expect(await owed(r, ravi.id), `${label}: Ravi`).toBe(exp.ravi);
      await expectNoDrift(r);
    };
    await check("start");

    // 2. A real loan disbursement: cash +50,000 and a liability — NOT income.
    const created = await r.loans.createAgreementWithOrigination({
      idempotencyKey: "master-loan-0001",
      name: "Bike loan",
      category: "institutional",
      institutionName: "Bank",
      fundingSource: "bank",
      direction: "taken",
      loanAmount: 50_000,
      loanDate: LOAN_DATE,
      firstDueDate: FIRST_DUE,
      repaymentType: "installment",
      installmentFrequency: "monthly",
      installmentCount: 5,
      movementAccountId: bank.id,
    });
    exp.bank += paise(50_000);
    await check("loan disbursed");
    const originationTxn = (await r.transactions.getAll()).find((t) => t.loanId === created.loan.id)!;
    expect(originationTxn.paymentAllocationType).toBe("additionalDisbursement"); // classified as a principal disbursement, not income

    // 3. Dinner ₹2,000 on the bank, split equally with Ravi → Ravi owes ₹1,000.
    const dinner = await r.expenses.createExpense({
      description: "Dinner",
      totalAmount: 2_000,
      date: new Date(2026, 1, 4, 20),
      categoryId: "food",
      accountId: bank.id,
      splitType: "equal",
      participantInputs: [
        { name: "Me", isMe: true, value: null },
        { personId: ravi.id, name: "Ravi", value: null },
      ],
    });
    exp.bank -= paise(2_000);
    exp.ravi += paise(1_000);
    await check("dinner split");

    // 4. Ravi repays ₹400 into SAVINGS (Record Payment `split` route): savings +400, receivable −400, bank untouched.
    const expense = (await r.expenses.getByKey(dinner.id))!;
    const participant = expense.participants.find((p) => p.personId === ravi.id)!;
    const gave = (await r.ledgerFor(ravi.id).getByTransactionRef(expense.transactionId)).find((e) => e.type === "gave")!;
    const reimbursementId = await r.paymentsFor(ravi.id).recordPayment((await r.people.getByKey(ravi.id))!, {
      direction: "theyPaid",
      amount: 400,
      date: new Date(2026, 1, 6, 9),
      accountId: savings.id,
      lines: [
        {
          key: `ledger:${gave.id}`,
          amount: 400,
          route: {
            kind: "split",
            parentEntryId: gave.id,
            sourceKind: "splitExpense",
            expenseId: expense.id,
            participantKey: participantKey(participant),
            scheduleId: expense.scheduleId!,
            installmentId: participant.installmentId!,
          },
        },
      ],
      extra: null,
    });
    exp.savings += paise(400);
    exp.ravi -= paise(400);
    await check("Ravi partial reimbursement");

    // 5. Lender installment ₹10,000 from the bank.
    const installments = await r.installmentRepositoryFor(created.loan.scheduleId).getAll();
    const firstInstallment = installments.sort((a, b) => a.sequenceNumber - b.sequenceNumber)[0];
    expect(paise(firstInstallment.amountDue)).toBe(paise(10_000));
    const paid = await r.lender.record({ loan: created.loan, scheduleInstallments: installments, accountId: bank.id, amount: 10_000, date: NOON_FIRST_DUE, idempotencyKey: "master-pay-0001" });
    exp.bank -= paise(10_000);
    await check("lender installment");
    // The lender payment never touches Ravi's obligation (and vice-versa — asserted above: Ravi unchanged).

    // 6. Edit that payment to ₹6,000: the original movement is replaced, not stacked.
    await r.lender.editPayment({
      loan: created.loan,
      scheduleInstallments: installments,
      original: { transactionId: paid.transactionId, paymentIds: paid.paymentIds, installmentIds: paid.installmentIds },
      accountId: bank.id,
      amount: 6_000,
      date: NOON_FIRST_DUE,
      idempotencyKey: "master-pay-0002",
    });
    exp.bank += paise(4_000);
    await check("lender payment edited 10,000 → 6,000");

    // 7. Reverse the lender payment entirely; People remains independent.
    // (The edit result carries no ids; the corrected action is the one live installment-payment transaction.)
    const corrected = (await r.transactions.getAll()).find((t) => t.loanId === created.loan.id && t.installmentPaymentId != null)!;
    expect(paise(corrected.amount)).toBe(paise(6_000));
    await r.lender.reversePayment({
      loan: created.loan,
      transactionId: corrected.id,
      paymentIds: [corrected.installmentPaymentId!],
      installmentIds: [corrected.installmentId!],
      reversalIdempotencyKey: "master-rev-0001",
    });
    exp.bank += paise(6_000);
    await check("lender payment reversed");
    expect((await r.installmentRepositoryFor(created.loan.scheduleId).getAll()).every((i) => i.amountPaid === 0)).toBe(true);

    // 8. Card: a ₹3,000 purchase (card account −3,000), then pay the bill from the bank (idempotent), then cancel it.
    const purchase = await r.transactions.createTransaction({ type: "expense", amount: 3_000, dateTime: new Date(2026, 1, 8, 11), accountId: card.id, categoryId: "shopping" });
    exp.card -= paise(3_000);
    await check("card purchase");
    const [out] = await r.transactions.createTransferPairAtomic({
      amount: 3_000,
      dateTime: new Date(2026, 1, 9, 10),
      sourceAccountId: bank.id,
      destinationAccountId: card.id,
      categoryId: "transfer",
      description: "Card bill payment",
      idempotencyKey: "master-billpay-0001",
      enforceFunds: true,
    });
    exp.bank -= paise(3_000);
    exp.card += paise(3_000);
    await check("card bill paid");
    // Retry of the same action (lost response) writes nothing.
    await r.transactions.createTransferPairAtomic({
      amount: 3_000,
      dateTime: new Date(2026, 1, 9, 10),
      sourceAccountId: bank.id,
      destinationAccountId: card.id,
      categoryId: "transfer",
      description: "Card bill payment",
      idempotencyKey: "master-billpay-0001",
      enforceFunds: true,
    });
    await check("card bill retry is a no-op");
    await r.transactions.deleteTransferPair(out);
    await r.transactions.deleteTransferPair(out); // repeat
    exp.bank += paise(3_000);
    exp.card -= paise(3_000);
    await check("card bill payment cancelled (twice)");

    // 9. Edit an OLDER (backdated) ordinary expense: the card purchase from ₹3,000 to ₹3,500.
    await r.transactions.editTransaction(purchase, { amount: 3_500, dateTime: new Date(2026, 0, 20, 9) });
    exp.card -= paise(500);
    await check("backdated edit of the card purchase");

    // 10. A historical, account-neutral record (already in the balance) changes nothing.
    await r.transactions.createTransaction({
      type: "expense",
      amount: 7_777,
      dateTime: new Date(2026, 0, 2),
      accountId: bank.id,
      categoryId: "cat",
      excludeFromCalculations: true,
    });
    await check("account-neutral historical row");

    // 11. Delete the shared dinner (owner-aware): the bank gets the full ₹2,000 back; Ravi's original share is
    //     retired, but his ₹400 real repayment stays (money that changed hands) → he is now owed ₹400 by me.
    await r.expenses.deleteExpense((await r.expenses.getByKey(dinner.id))!);
    exp.bank += paise(2_000);
    exp.ravi = paise(-400);
    await check("shared expense deleted");

    // 12. Reverting the reimbursement now returns savings and clears the −400.
    await r.paymentsFor(ravi.id).revertPayment((await r.people.getByKey(ravi.id))!, reimbursementId);
    exp.savings -= paise(400);
    exp.ravi = 0;
    await check("reimbursement reverted");

    // Whole-system conservation: bank + savings + card (+ People) equals the opening money plus real inflows.
    // 100,000 + 20,000 + 50,000 (loan) − 3,500 (card purchase) = 166,500.
    const total = (await bal(r, bank.id)) + (await bal(r, savings.id)) + (await bal(r, card.id));
    expect(total).toBe(paise(166_500));
  });
});

describe("Lifecycle B — different ordering: revert before delete, edit a split, re-delete is a no-op", () => {
  it("edit shares, revert the repayment, delete the expense twice, restore once", async () => {
    const r = setup();
    const bank = await r.accounts.createAccount({ name: "Bank", type: "bank", openingBalance: 10_000, colorValue: 0 });
    const cash = await r.accounts.createAccount({ name: "Cash", type: "cash", openingBalance: 500, colorValue: 0 });
    const meera = await r.people.createPerson({ name: "Meera", avatarColorValue: 0, openingBalance: 0 });
    const exp = { bank: paise(10_000), cash: paise(500), meera: 0 };
    const check = async (label: string) => {
      expect(await bal(r, bank.id), `${label}: bank`).toBe(exp.bank);
      expect(await bal(r, cash.id), `${label}: cash`).toBe(exp.cash);
      expect(await owed(r, meera.id), `${label}: Meera`).toBe(exp.meera);
      await expectNoDrift(r);
    };

    const e1 = await r.expenses.createExpense({
      description: "Trip",
      totalAmount: 1_200,
      date: new Date(2026, 8, 20, 18),
      categoryId: "travel",
      accountId: bank.id,
      splitType: "equal",
      participantInputs: [
        { name: "Me", isMe: true, value: null },
        { personId: meera.id, name: "Meera", value: null },
      ],
    });
    exp.bank -= paise(1_200);
    exp.meera += paise(600);
    await check("created");

    // Meera repays ₹600 in full into CASH.
    const expense = (await r.expenses.getByKey(e1.id))!;
    const participant = expense.participants.find((p) => p.personId === meera.id)!;
    const gave = (await r.ledgerFor(meera.id).getByTransactionRef(expense.transactionId)).find((e) => e.type === "gave")!;
    const paymentId = await r.paymentsFor(meera.id).recordPayment((await r.people.getByKey(meera.id))!, {
      direction: "theyPaid",
      amount: 600,
      date: new Date(2026, 8, 22, 9),
      accountId: cash.id,
      lines: [
        {
          key: `ledger:${gave.id}`,
          amount: 600,
          route: {
            kind: "split",
            parentEntryId: gave.id,
            sourceKind: "splitExpense",
            expenseId: expense.id,
            participantKey: participantKey(participant),
            scheduleId: expense.scheduleId!,
            installmentId: participant.installmentId!,
          },
        },
      ],
      extra: null,
    });
    exp.cash += paise(600);
    exp.meera -= paise(600);
    await check("repaid in full");

    // Editing the total below what Meera's share already paid is refused — nothing moves.
    await expect(
      r.expenses.editExpense({
        expense: (await r.expenses.getByKey(e1.id))!,
        currentInstallments: await r.installmentRepositoryFor(expense.scheduleId!).getAll(),
        totalAmount: 600,
        splitType: "equal",
        participantInputs: [
          { name: "Me", isMe: true, value: null },
          { personId: meera.id, name: "Meera", value: null },
        ],
      }),
    ).rejects.toThrow(/already been paid/);
    await check("refused edit changed nothing");

    // Revert the repayment, then the same edit succeeds: bank takes the −600 difference, Meera's share is 300.
    await r.paymentsFor(meera.id).revertPayment((await r.people.getByKey(meera.id))!, paymentId);
    exp.cash -= paise(600);
    exp.meera += paise(600);
    await check("repayment reverted");
    await r.expenses.editExpense({
      expense: (await r.expenses.getByKey(e1.id))!,
      currentInstallments: await r.installmentRepositoryFor(expense.scheduleId!).getAll(),
      totalAmount: 600,
      splitType: "equal",
      participantInputs: [
        { name: "Me", isMe: true, value: null },
        { personId: meera.id, name: "Meera", value: null },
      ],
    });
    exp.bank += paise(600);
    exp.meera -= paise(300);
    await check("total 1,200 → 600");

    // Delete twice (two tabs): one reversal. Restore twice: one re-application.
    const live = (await r.expenses.getByKey(e1.id))!;
    await r.expenses.deleteExpense(live);
    await r.expenses.deleteExpense(live);
    exp.bank += paise(600);
    exp.meera = 0;
    await check("deleted twice");
    const trashed = (await r.expenses.getByKey(e1.id))!;
    await r.expenses.restoreExpense(trashed);
    await r.expenses.restoreExpense(trashed);
    exp.bank -= paise(600);
    exp.meera = paise(300);
    await check("restored twice");

    // Concurrent duplicate Record Payment submits with ONE idempotency key record the cash once.
    const refreshed = (await r.expenses.getByKey(e1.id))!;
    const p2 = refreshed.participants.find((p) => p.personId === meera.id)!;
    const gave2 = (await r.ledgerFor(meera.id).getByTransactionRef(refreshed.transactionId)).find((e) => e.type === "gave")!;
    const input = {
      direction: "theyPaid" as const,
      amount: 100,
      date: new Date(2026, 8, 25, 9),
      accountId: cash.id,
      idempotencyKey: "master-dup-pay-0001",
      lines: [
        {
          key: `ledger:${gave2.id}`,
          amount: 100,
          route: {
            kind: "split" as const,
            parentEntryId: gave2.id,
            sourceKind: "splitExpense" as const,
            expenseId: refreshed.id,
            participantKey: participantKey(p2),
            scheduleId: refreshed.scheduleId!,
            installmentId: p2.installmentId!,
          },
        },
      ],
      extra: null,
    };
    const person = (await r.people.getByKey(meera.id))!;
    await Promise.allSettled([r.paymentsFor(meera.id).recordPayment(person, input), r.paymentsFor(meera.id).recordPayment(person, input)]);
    exp.cash += paise(100);
    exp.meera -= paise(100);
    await check("duplicate submit recorded once");
  });
});
