/**
 * Backend audit (2026-11-17) — People Ledger direction + linked-record edit/delete integrity.
 *
 * Every expected value is computed by hand in integer paise (never read back from the code under test), and
 * every step is cross-checked with the read-only drift detectors. Sign convention (independent of the code):
 * a person's balance is POSITIVE when they owe ME, NEGATIVE when I owe THEM.
 *
 * Synthetic data only, on the Firestore emulator. Run via `npm run test:integration`.
 */

import { readFileSync } from "node:fs";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, getDocs, query, where, type Firestore } from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { personEmiObligations, emiReceivableThrough } from "@/lib/engines/person-emi-obligations";
import { personPosition } from "@/lib/engines/person-position";
import { accountBalanceDrift, personBalanceDrift } from "@/lib/engines/stored-balance-drift";
import { accountFromFirestore, accountToFirestore } from "@/lib/models/account";
import { emiFromFirestore, emiToFirestore } from "@/lib/models/emi";
import { expenseFromFirestore, expenseToFirestore } from "@/lib/models/expense";
import {
  installmentFromFirestore,
  installmentPaymentFromFirestore,
  installmentPaymentToFirestore,
  installmentToFirestore,
  paymentScheduleFromFirestore,
  paymentScheduleToFirestore,
  type Installment,
} from "@/lib/models/payment-schedule";
import {
  advanceApplicationFromFirestore,
  advanceApplicationToFirestore,
  ledgerEntryFromFirestore,
  ledgerEntryToFirestore,
  personFromFirestore,
  personToFirestore,
  signedAmount,
} from "@/lib/models/person";
import { transactionFromFirestore, transactionToFirestore } from "@/lib/models/transaction";
import { AccountRepository } from "@/lib/repositories/account-repository";
import { permanentlyDeleteAgreement } from "@/lib/repositories/agreement-deletion";
import { EmiRepository } from "@/lib/repositories/emi-repository";
import { ExpenseRepository } from "@/lib/repositories/expense-repository";
import { InstallmentPaymentRepository, InstallmentRepository, PaymentScheduleRepository } from "@/lib/repositories/payment-schedule-repository";
import { PersonPaymentRepository } from "@/lib/repositories/person-payment-repository";
import { LedgerRepository, PersonRepository } from "@/lib/repositories/person-repository";
import { TransactionRepository } from "@/lib/repositories/transaction-repository";

const PROJECT_ID = "flowfi-people-ledger-direction-audit";
const UID = "direction-audit-uid";

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
  ).withExpenseOwnerLookup(async (transactionId) => (await getDocs(query(expensesCol, where("transactionId", "==", transactionId)))).docs.map((d) => d.ref));
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
  const emis = new EmiRepository(collection(db, "users", UID, "emis").withConverter({ toFirestore: emiToFirestore, fromFirestore: emiFromFirestore }), schedules, installmentRepositoryFor);
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
  return { db, accounts, transactions, people, ledgerFor, expenses, emis, paymentsFor, installmentRepositoryFor };
}
type R = ReturnType<typeof setup>;

const paise = (rupees: number) => Math.round(rupees * 100);
const bal = async (r: R, id: string) => paise((await r.accounts.getByKey(id))!.currentBalance);
const owed = async (r: R, id: string) => paise((await r.people.getByKey(id))!.currentBalance);
const fresh = async (r: R, id: string) => (await r.people.getByKey(id))!;

async function expectNoDrift(r: R) {
  const allTxns = [...(await r.transactions.getAll()), ...(await r.transactions.getTrash())];
  for (const a of await r.accounts.getAll()) expect(accountBalanceDrift(a, allTxns), `account ${a.name}`).toBeNull();
  for (const p of await r.people.getAll()) {
    const ledger = r.ledgerFor(p.id);
    expect(personBalanceDrift(p, [...(await ledger.getAll()), ...(await ledger.getTrash())]), `person ${p.name}`).toBeNull();
  }
}

/** The People position exactly as the People page derives it (ledger + opted-in EMI shares). */
async function position(r: R, personId: string) {
  const person = await fresh(r, personId);
  const emis = await r.emis.getAll();
  const installments: Installment[] = (await Promise.all(emis.map((e) => r.installmentRepositoryFor(e.scheduleId).getAll()))).flat();
  const obligations = personEmiObligations({ personId, emis, loans: [], installments });
  const ledger = await r.ledgerFor(personId).getAll();
  return personPosition({
    personId,
    currentBalance: person.currentBalance,
    loans: [],
    ledgerEntries: ledger.map((e) => ({ transactionRef: e.transactionRef, signedAmount: signedAmount(e), isDeleted: e.deletedAt != null })),
    loanIds: new Set(),
    emiReceivable: emiReceivableThrough(obligations, new Date()),
  });
}

const D = new Date(2026, 5, 10, 12);

// ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Scenario A — the same person is both a receivable and a payable; edit/delete each independently
// ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe("Scenario A — receivable vs payable never swap direction", () => {
  it("they owe me ₹1,000 and I owe them ₹500: net +₹500; every edit/delete moves exactly the right side", async () => {
    const r = setup();
    const bank = await r.accounts.createAccount({ name: "Bank", type: "bank", openingBalance: 10_000, colorValue: 0 });
    const p = await r.people.createPerson({ name: "Ravi", avatarColorValue: 0, openingBalance: 0 });
    const ledger = r.ledgerFor(p.id);
    const exp = { bank: paise(10_000), ravi: 0 };
    const check = async (label: string) => {
      expect(await bal(r, bank.id), `${label}: bank`).toBe(exp.bank);
      expect(await owed(r, p.id), `${label}: Ravi`).toBe(exp.ravi);
      const pos = await position(r, p.id);
      expect(paise(pos.net), `${label}: position.net`).toBe(exp.ravi);
      expect(paise(pos.owesMe), `${label}: owesMe`).toBe(Math.max(exp.ravi, 0));
      expect(paise(pos.iOwe), `${label}: iOwe`).toBe(Math.max(-exp.ravi, 0));
      await expectNoDrift(r);
    };

    // I paid ₹1,000 for Ravi (cash OUT of the bank, he owes me).
    const gave = await ledger.addEntryWithTransaction(await fresh(r, p.id), { type: "gave", amount: 1_000, date: D }, { type: "expense", accountId: bank.id, categoryId: "c" }, r.transactions);
    exp.bank -= paise(1_000);
    exp.ravi += paise(1_000);
    await check("gave 1,000");

    // Ravi lent me ₹500 (cash IN to the bank, I owe him).
    const borrowed = await ledger.addEntryWithTransaction(await fresh(r, p.id), { type: "borrowed", amount: 500, date: D }, { type: "income", accountId: bank.id, categoryId: "c" }, r.transactions);
    exp.bank += paise(500);
    exp.ravi -= paise(500);
    await check("borrowed 500");

    // Edit ONLY the gave amount 1,000 → 1,200: bank −200 more, Ravi +200 more.
    await ledger.editEntry(await fresh(r, p.id), gave.entry, { amount: 1_200 }, r.transactions);
    exp.bank -= paise(200);
    exp.ravi += paise(200);
    await check("gave edited to 1,200");

    // Edit ONLY the borrowed amount 500 → 300: bank −200 (less cash in), Ravi +200 (I owe less).
    await ledger.editEntry(await fresh(r, p.id), borrowed.entry, { amount: 300 }, r.transactions);
    exp.bank -= paise(200);
    exp.ravi += paise(200);
    await check("borrowed edited to 300");

    // Delete ONLY the borrowed entry (with its cash leg): cash-in reversed (−300), my debt gone (+300 → Ravi owes full).
    await ledger.softDeleteEntriesWithCashLegs(await fresh(r, p.id), [borrowed.entry], r.transactions);
    exp.bank -= paise(300);
    exp.ravi += paise(300);
    await check("borrowed deleted");
    expect(exp.ravi).toBe(paise(1_200)); // sanity on the oracle itself

    // Delete the gave entry: cash back (+1,200), Ravi 0.
    await ledger.softDeleteEntriesWithCashLegs(await fresh(r, p.id), [gave.entry], r.transactions);
    exp.bank += paise(1_200);
    exp.ravi -= paise(1_200);
    await check("gave deleted");
    expect(exp.bank).toBe(paise(10_000));

    // Payable-only: I owe him ₹500 → NEGATIVE, shown as "I owe", never as receivable.
    await ledger.addEntryWithTransaction(await fresh(r, p.id), { type: "borrowed", amount: 500, date: D }, { type: "income", accountId: bank.id, categoryId: "c" }, r.transactions);
    exp.bank += paise(500);
    exp.ravi -= paise(500);
    await check("payable only");
    expect(exp.ravi).toBe(paise(-500));
  });
});

// ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Scenario C — an account transaction that is a person's cash leg, deleted/edited from Accounts
// ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe("Scenario C — deleting/editing a linked cash leg from the Transactions/Accounts side", () => {
  it("never leaves the ledger and the account disagreeing (blocked, or both reversed together)", async () => {
    const r = setup();
    const bank = await r.accounts.createAccount({ name: "Bank", type: "bank", openingBalance: 10_000, colorValue: 0 });
    const p = await r.people.createPerson({ name: "Ravi", avatarColorValue: 0, openingBalance: 0 });
    const ledger = r.ledgerFor(p.id);
    const { transaction } = await ledger.addEntryWithTransaction(await fresh(r, p.id), { type: "gave", amount: 1_000, date: D }, { type: "expense", accountId: bank.id, categoryId: "c" }, r.transactions);
    const live = (await r.transactions.getByKey(transaction.id))!;

    // Edit the amount from the Transactions side.
    await r.transactions.editTransaction(live, { amount: 1_500 }).catch(() => undefined);
    const afterEditBank = await bal(r, bank.id);
    const afterEditRavi = await owed(r, p.id);
    // Either refused (nothing moved) or both moved together by the same +500 — never one without the other.
    const bankMoved = paise(10_000) - paise(1_000) - afterEditBank; // extra cash out
    const raviMoved = afterEditRavi - paise(1_000);
    expect(bankMoved, "account and person must move together on a linked-leg edit").toBe(raviMoved);
    await expectNoDrift(r);

    // Delete from the Transactions side.
    await r.transactions.softDeleteTransaction((await r.transactions.getByKey(transaction.id))!).catch(() => undefined);
    const liveEntries = await ledger.getAll();
    const bankNow = await bal(r, bank.id);
    const raviNow = await owed(r, p.id);
    // Cash is back in the bank exactly when the person's obligation is gone.
    expect(bankNow === paise(10_000), "bank back to 10,000 ⇔ obligation removed").toBe(raviNow === 0);
    expect(liveEntries.length === 0, "entry gone ⇔ obligation removed").toBe(raviNow === 0);
    await expectNoDrift(r);
  });
});

// ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Scenario B — EMI shared with a person: partial repayment, then the EMI is deleted
// ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function sharedEmiWorld(r: R) {
  const bank = await r.accounts.createAccount({ name: "Bank", type: "bank", openingBalance: 50_000, colorValue: 0 });
  const amma = await r.people.createPerson({ name: "AMMA", avatarColorValue: 0, openingBalance: 0 });
  const start = new Date();
  start.setMonth(start.getMonth() - 3);
  const emi = await r.emis.createEmi({
    name: "Fridge EMI",
    principalAmount: 12_000,
    startDate: start,
    installmentFrequency: "monthly",
    installmentCount: 6,
    ownershipShares: [
      { personId: null, amount: 6_000 },
      { personId: amma.id, amount: 6_000 },
    ],
  });
  const installments = (await r.installmentRepositoryFor(emi.scheduleId).getAll()).sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  // Independent expectation: each installment is 2,000, AMMA's half is 1,000; the receivable is her share of every
  // installment whose due date has passed.
  const dueCount = installments.filter((i) => i.dueDate.getTime() <= Date.now()).length;
  return { bank, amma, emi, installments, dueCount };
}

describe("Scenario B — EMI shared with a person, partial repayment, then EMI deletion", () => {
  it("baseline: share receivable and a ₹1,000 repayment move the person and the bank correctly", async () => {
    const r = setup();
    const w = await sharedEmiWorld(r);
    expect(w.dueCount).toBeGreaterThan(0);
    expect(paise((await position(r, w.amma.id)).net)).toBe(w.dueCount * paise(1_000)); // she owes me her half of every due installment

    const first = w.installments[0];
    await r.paymentsFor(w.amma.id).recordPayment(await fresh(r, w.amma.id), {
      direction: "theyPaid",
      amount: 1_000,
      date: D,
      accountId: w.bank.id,
      lines: [{ key: `emi-inst:${first.id}`, amount: 1_000, route: { kind: "derived", obligationRef: `emi-inst:${first.id}`, sourceKind: "emiInstallment" } }],
      extra: null,
      idempotencyKey: "amma-pays-1",
    });
    expect(await bal(r, w.bank.id)).toBe(paise(51_000));
    expect(await owed(r, w.amma.id)).toBe(paise(-1_000)); // stored ledger: her repayment (direct balance)
    expect(paise((await position(r, w.amma.id)).net)).toBe((w.dueCount - 1) * paise(1_000)); // net owed after the repayment
    await expectNoDrift(r);
  });

  it("REGRESSION: deleting the EMI after AMMA repaid part of her share is blocked (nothing moves); after reverting her payment the delete leaves net 0 and the bank at its original balance", async () => {
    const r = setup();
    const w = await sharedEmiWorld(r);
    const first = w.installments[0];
    const paymentId = await r.paymentsFor(w.amma.id).recordPayment(await fresh(r, w.amma.id), {
      direction: "theyPaid",
      amount: 1_000,
      date: D,
      accountId: w.bank.id,
      lines: [{ key: `emi-inst:${first.id}`, amount: 1_000, route: { kind: "derived", obligationRef: `emi-inst:${first.id}`, sourceKind: "emiInstallment" } }],
      extra: null,
      idempotencyKey: "amma-pays-1",
    });
    const netBefore = paise((await position(r, w.amma.id)).net);

    // Blocked: the receivable would vanish while her stored repayment stayed (she would flip to "I owe AMMA").
    await expect(permanentlyDeleteAgreement(r.db, UID, "emi", w.emi.id)).rejects.toMatchObject({ name: "AgreementDeletionBlockedError" });
    expect(await bal(r, w.bank.id)).toBe(paise(51_000));
    expect(await owed(r, w.amma.id)).toBe(paise(-1_000));
    expect(paise((await position(r, w.amma.id)).net)).toBe(netBefore);
    expect((await r.emis.getAll()).length).toBe(1);
    expect((await r.installmentRepositoryFor(w.emi.scheduleId).getAll()).length).toBe(6);
    await expectNoDrift(r);

    // Revert her payment (the supported reversal): bank 50,000, her stored balance 0, receivable back to the full share.
    await r.paymentsFor(w.amma.id).revertPayment(await fresh(r, w.amma.id), paymentId);
    expect(await bal(r, w.bank.id)).toBe(paise(50_000));
    expect(await owed(r, w.amma.id)).toBe(0);

    // Now the delete is safe and the world is exactly "never existed".
    await permanentlyDeleteAgreement(r.db, UID, "emi", w.emi.id);
    expect((await r.emis.getAll()).length).toBe(0);
    expect(paise((await position(r, w.amma.id)).net)).toBe(0);
    expect(await owed(r, w.amma.id)).toBe(0);
    expect(await bal(r, w.bank.id)).toBe(paise(50_000));
    await expectNoDrift(r);
  });
});

// ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Scenario D — shared expense with two people: edit amount, change split, remove one participant, delete
// ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe("Scenario D — shared expense across multiple people", () => {
  it("amount edit, participant removal and delete keep every person's balance and the bank exactly in step", async () => {
    const r = setup();
    const bank = await r.accounts.createAccount({ name: "Bank", type: "bank", openingBalance: 20_000, colorValue: 0 });
    const a = await r.people.createPerson({ name: "Asha", avatarColorValue: 0, openingBalance: 0 });
    const b = await r.people.createPerson({ name: "Bala", avatarColorValue: 0, openingBalance: 0 });
    const exp = { bank: paise(20_000), a: 0, b: 0 };
    const check = async (label: string) => {
      expect(await bal(r, bank.id), `${label}: bank`).toBe(exp.bank);
      expect(await owed(r, a.id), `${label}: Asha`).toBe(exp.a);
      expect(await owed(r, b.id), `${label}: Bala`).toBe(exp.b);
      await expectNoDrift(r);
    };
    const inputs = [
      { name: "Me", isMe: true, value: null },
      { personId: a.id, name: "Asha", value: null },
      { personId: b.id, name: "Bala", value: null },
    ];

    // ₹3,000 equal three ways → each ₹1,000; I paid all of it.
    const e = await r.expenses.createExpense({ description: "Trip", totalAmount: 3_000, date: D, categoryId: "travel", accountId: bank.id, splitType: "equal", participantInputs: inputs });
    exp.bank -= paise(3_000);
    exp.a += paise(1_000);
    exp.b += paise(1_000);
    await check("created");

    // Edit total → ₹4,500: each share ₹1,500; bank −1,500 more.
    const sched = (await r.expenses.getByKey(e.id))!.scheduleId!;
    await r.expenses.editExpense({
      expense: (await r.expenses.getByKey(e.id))!,
      currentInstallments: await r.installmentRepositoryFor(sched).getAll(),
      totalAmount: 4_500,
      splitType: "equal",
      participantInputs: inputs,
    });
    exp.bank -= paise(1_500);
    exp.a += paise(500);
    exp.b += paise(500);
    await check("total 4,500");

    // Remove Bala → two-way equal of 4,500: Asha 2,250, Bala 0.
    await r.expenses.editExpense({
      expense: (await r.expenses.getByKey(e.id))!,
      currentInstallments: await r.installmentRepositoryFor(sched).getAll(),
      totalAmount: 4_500,
      splitType: "equal",
      participantInputs: inputs.filter((i) => i.personId !== b.id),
    });
    exp.a = paise(2_250);
    exp.b = 0;
    await check("Bala removed");

    // Delete: everything returns.
    await r.expenses.deleteExpense((await r.expenses.getByKey(e.id))!);
    exp.bank = paise(20_000);
    exp.a = 0;
    await check("deleted");
  });
});
