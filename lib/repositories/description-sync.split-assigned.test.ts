import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Account } from "@/lib/models/account";
import type { Expense } from "@/lib/models/expense";
import type { LedgerEntry, Person } from "@/lib/models/person";
import type { Transaction } from "@/lib/models/transaction";
import { syncLinkedDescription } from "@/lib/services/transaction-description-sync";
import { AccountRepository } from "./account-repository";
import { TransactionRepository } from "./transaction-repository";
import { ExpenseRepository } from "./expense-repository";
import { LedgerRepository, PersonRepository } from "./person-repository";
import { PaymentScheduleRepository, InstallmentRepository } from "./payment-schedule-repository";

/**
 * Renaming the source transaction of a split / assigned expense: the People rows (ledger entry `note`,
 * read by `ledgerTitle`) and the Expense's own description follow the new text, while every amount,
 * share, installment, settlement and balance stays exactly as it was. Real repositories over an in-memory
 * fake of the modular Firestore API (same style as `expense-repository.split-ledger.test.ts`).
 */

interface FakeDoc {
  id: string;
  collectionPath: string;
  data: unknown;
}

function makeFakeFirestore() {
  const docs = new Map<string, FakeDoc>();
  const keyOf = (collectionPath: string, id: string) => `${collectionPath}/${id}`;
  const collection = (pathSegments: string[]) => ({ __collectionPath: pathSegments.join("/"), firestore: {} }) as unknown as { __collectionPath: string };
  const doc = (coll: { __collectionPath: string }, id: string) => ({ __collectionPath: coll.__collectionPath, id });
  async function getDoc(ref: { __collectionPath: string; id: string }) {
    const entry = docs.get(keyOf(ref.__collectionPath, ref.id));
    return { exists: () => entry !== undefined, data: () => entry?.data, id: ref.id };
  }
  async function setDoc(ref: { __collectionPath: string; id: string }, value: unknown) {
    docs.set(keyOf(ref.__collectionPath, ref.id), { id: ref.id, collectionPath: ref.__collectionPath, data: value });
  }
  const query = (coll: { __collectionPath: string }, ...clauses: unknown[]) => ({ __collectionPath: coll.__collectionPath, __clauses: clauses });
  const where = (field: string, op: string, value: unknown) => ({ field, op, value });
  async function getDocs(q: { __collectionPath: string; __clauses: { field: string; op: string; value: unknown }[] }) {
    const filtered = [...docs.values()]
      .filter((d) => d.collectionPath === q.__collectionPath)
      .filter((d) =>
        q.__clauses.every((c) => {
          const value = (d.data as Record<string, unknown>)[c.field];
          if (c.op === "==") return value === c.value;
          if (c.op === "!=") return value !== c.value;
          return true;
        }),
      );
    return { docs: filtered.map((d) => ({ id: d.id, data: () => d.data })) };
  }
  async function runTransaction(_db: unknown, updateFn: (tx: unknown) => Promise<unknown>) {
    const pending = new Map<string, unknown>();
    const tx = {
      get: async (ref: { __collectionPath: string; id: string }) => {
        const key = keyOf(ref.__collectionPath, ref.id);
        const data = pending.has(key) ? pending.get(key) : docs.get(key)?.data;
        return { exists: () => data !== undefined, data: () => data };
      },
      set: (ref: { __collectionPath: string; id: string }, value: unknown) => {
        pending.set(keyOf(ref.__collectionPath, ref.id), value);
      },
    };
    const result = await updateFn(tx);
    for (const [key, value] of pending) {
      const cut = key.lastIndexOf("/");
      docs.set(key, { id: key.slice(cut + 1), collectionPath: key.slice(0, cut), data: value });
    }
    return result;
  }
  return { docs, collection, doc, getDoc, setDoc, query, where, getDocs, runTransaction };
}

const fake = makeFakeFirestore();

vi.mock("firebase/firestore", () => ({
  doc: (...args: unknown[]) => fake.doc(...(args as [{ __collectionPath: string }, string])),
  getDoc: (...args: Parameters<typeof fake.getDoc>) => fake.getDoc(...args),
  setDoc: (...args: Parameters<typeof fake.setDoc>) => fake.setDoc(...args),
  query: (...args: unknown[]) => fake.query(...(args as [{ __collectionPath: string }])),
  where: (...args: Parameters<typeof fake.where>) => fake.where(...args),
  getDocs: (...args: Parameters<typeof fake.getDocs>) => fake.getDocs(...args),
  runTransaction: (...args: Parameters<typeof fake.runTransaction>) => fake.runTransaction(...args),
  onSnapshot: vi.fn(),
  deleteDoc: vi.fn(async () => {}),
  collection: vi.fn(),
}));

const SBI = {
  id: "sbi",
  name: "SBI",
  type: "bank",
  openingBalance: 10000,
  currentBalance: 10000,
  colorValue: 0,
  isDefault: false,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  deletedAt: null,
  lastEditedAt: null,
  editHistory: [],
} as unknown as Account;

const person = (id: string, name: string): Person => ({
  id,
  name,
  phone: null,
  email: null,
  notes: "",
  avatarColorValue: 0,
  openingBalance: 0,
  currentBalance: 0,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  deletedAt: null,
  lastEditedAt: null,
  editHistory: [],
});

const DATE = new Date("2026-09-20T10:00:00Z");

function buildRepos() {
  const accountRepository = new AccountRepository(fake.collection(["accounts"]) as never);
  const transactionRepository = new TransactionRepository(fake.collection(["transactions"]) as never, accountRepository);
  const personRepository = new PersonRepository(fake.collection(["people"]) as never);
  const paymentScheduleRepository = new PaymentScheduleRepository(fake.collection(["paymentSchedules"]) as never);
  const installmentRepositoryFor = (scheduleId: string) => new InstallmentRepository(fake.collection(["paymentSchedules", scheduleId, "installments"]) as never);
  const ledgerRepositoryFor = (personId: string) => new LedgerRepository(fake.collection(["people", personId, "ledger"]) as never, personRepository);
  const expenseRepository = new ExpenseRepository(
    fake.collection(["expenses"]) as never,
    transactionRepository,
    paymentScheduleRepository,
    personRepository,
    installmentRepositoryFor,
    ledgerRepositoryFor,
  );
  const deps = { expenseRepository, personRepository, ledgerRepositoryFor };
  return { accountRepository, transactionRepository, personRepository, expenseRepository, installmentRepositoryFor, ledgerRepositoryFor, deps };
}

async function seed() {
  await fake.setDoc({ __collectionPath: "accounts", id: "sbi" }, { ...SBI });
  for (const [id, name] of [["amma", "AMMA"], ["tripthee", "TRIPTHEE"], ["anu", "ANU"]] as const) {
    await fake.setDoc({ __collectionPath: "people", id }, person(id, name));
  }
}

/** Every number a description edit must never move — account, People balances, shares, installments, entries. */
async function financialSnapshot(r: ReturnType<typeof buildRepos>, expenseId: string) {
  const expense = (await r.expenseRepository.getByKey(expenseId)) as Expense;
  const tx = (await r.transactionRepository.getByKey(expense.transactionId)) as Transaction;
  const installments = expense.scheduleId ? await r.installmentRepositoryFor(expense.scheduleId).getAll() : [];
  const people = await r.personRepository.getAll();
  const entries: Record<string, { type: string; amount: number; receivedStatus: unknown }[]> = {};
  for (const p of people) {
    entries[p.id] = (await r.ledgerRepositoryFor(p.id).getAll()).map((e: LedgerEntry) => ({ type: e.type, amount: e.amount, receivedStatus: e.receivedStatus }));
  }
  return {
    sbi: ((await r.accountRepository.getByKey("sbi")) as Account).currentBalance,
    transaction: { amount: tx.amount, type: tx.type, accountId: tx.accountId, excluded: tx.excludeFromCalculations },
    expense: { totalAmount: expense.totalAmount, splitType: expense.splitType, participants: expense.participants.map((p) => ({ personId: p.personId, share: p.share, isMe: p.isMe, receivedStatus: p.receivedStatus })) },
    installments: installments.map((i) => ({ amountDue: i.amountDue, amountPaid: i.amountPaid })),
    balances: Object.fromEntries(people.map((p) => [p.id, p.currentBalance])),
    entries,
  };
}

async function shareNotes(r: ReturnType<typeof buildRepos>, personId: string) {
  return (await r.ledgerRepositoryFor(personId).getAll()).map((e) => e.note);
}

/** The edit the Transactions screen makes: the transaction itself, then the linked-description sync. */
async function renameTransaction(r: ReturnType<typeof buildRepos>, transactionId: string, description: string) {
  const before = (await r.transactionRepository.getByKey(transactionId)) as Transaction;
  await r.transactionRepository.editTransaction(before, { description });
  await syncLinkedDescription(r.deps, before, description);
}

beforeEach(() => {
  fake.docs.clear();
});

describe("Split expense — Dinner ₹4,000 (You, AMMA, TRIPTHEE, ANU ₹1,000 each) → Birthday Dinner", () => {
  async function createDinner(r: ReturnType<typeof buildRepos>) {
    await seed();
    return r.expenseRepository.createExpense({
      description: "Dinner",
      totalAmount: 4000,
      date: DATE,
      categoryId: "food",
      accountId: "sbi",
      splitType: "equal",
      participantInputs: [
        { name: "Me", isMe: true },
        { personId: "amma", name: "AMMA" },
        { personId: "tripthee", name: "TRIPTHEE" },
        { personId: "anu", name: "ANU" },
      ],
    });
  }

  it("every participant's People row and the Expense take the new description; nothing financial moves", async () => {
    const r = buildRepos();
    const expense = await createDinner(r);
    expect(await shareNotes(r, "amma")).toEqual(["Split: Dinner"]);
    const before = await financialSnapshot(r, expense.id);

    await renameTransaction(r, expense.transactionId, "Birthday Dinner");

    for (const id of ["amma", "tripthee", "anu"]) expect(await shareNotes(r, id)).toEqual(["Split: Birthday Dinner"]);
    expect(((await r.expenseRepository.getByKey(expense.id)) as Expense).description).toBe("Birthday Dinner");
    expect(((await r.transactionRepository.getByKey(expense.transactionId)) as Transaction).description).toBe("Birthday Dinner");
    // Original ₹4,000, every allocation, installment, balance and entry amount — unchanged; no entry created.
    expect(await financialSnapshot(r, expense.id)).toEqual(before);
  });

  it("keeps settlement history as a snapshot: a recorded 'Split settlement: Dinner' is not rewritten, paid/remaining unchanged", async () => {
    const r = buildRepos();
    const expense = await createDinner(r);
    const amma = (await r.personRepository.getByKey("amma"))!;
    await r.ledgerRepositoryFor("amma").addEntry(amma, {
      type: "receivedBack",
      amount: 400,
      date: DATE,
      note: "Split settlement: Dinner",
      transactionRef: expense.transactionId,
      receivedStatus: "received",
    });
    const before = await financialSnapshot(r, expense.id);

    await renameTransaction(r, expense.transactionId, "Birthday Dinner");

    expect((await shareNotes(r, "amma")).sort()).toEqual(["Split settlement: Dinner", "Split: Birthday Dinner"]);
    expect(await financialSnapshot(r, expense.id)).toEqual(before);
  });

  it("is idempotent — saving again (or after editExpense already synced) changes nothing and adds no edit history", async () => {
    const r = buildRepos();
    const expense = await createDinner(r);
    await renameTransaction(r, expense.transactionId, "Birthday Dinner");
    const entry = (await r.ledgerRepositoryFor("amma").getAll())[0];
    const historyLength = entry.editHistory.length;

    const fresh = (await r.expenseRepository.getByKey(expense.id)) as Expense;
    await r.expenseRepository.syncDescription(fresh, "Birthday Dinner");
    await r.expenseRepository.syncDescription(fresh, "Birthday Dinner");

    const after = (await r.ledgerRepositoryFor("amma").getAll())[0];
    expect(after.editHistory).toHaveLength(historyLength);
    expect(await r.ledgerRepositoryFor("amma").getAll()).toHaveLength(1);
  });

  it("an unchanged description is a no-op (no write at all)", async () => {
    const r = buildRepos();
    const expense = await createDinner(r);
    const tx = (await r.transactionRepository.getByKey(expense.transactionId)) as Transaction;
    const spy = vi.spyOn(r.expenseRepository, "syncDescription");
    await syncLinkedDescription(r.deps, tx, "  Dinner ");
    expect(spy).not.toHaveBeenCalled();
  });

  it("delete after a rename still removes every participant obligation (no stale share left behind)", async () => {
    const r = buildRepos();
    const expense = await createDinner(r);
    await renameTransaction(r, expense.transactionId, "Birthday Dinner");
    await r.expenseRepository.deleteExpense((await r.expenseRepository.getByKey(expense.id)) as Expense);
    for (const id of ["amma", "tripthee", "anu"]) {
      expect(await r.ledgerRepositoryFor(id).getAll()).toEqual([]);
      expect((await r.personRepository.getByKey(id))!.currentBalance).toBe(0);
    }
    expect(((await r.accountRepository.getByKey("sbi")) as Account).currentBalance).toBe(10000);
  });
});

describe("Assigned expense — Exam ₹1,000 assigned to AMMA → Electricity Bill", () => {
  it("AMMA's row reads the new description; amount, owed balance, SBI and settlement status unchanged", async () => {
    const r = buildRepos();
    await seed();
    const tx = await r.transactionRepository.createTransaction({ type: "expense", amount: 1000, dateTime: DATE, accountId: "sbi", categoryId: "edu", description: "Exam" });
    const expense = await r.expenseRepository.convertToAssigned({
      existingExpense: null,
      transactionId: tx.id,
      description: "Exam",
      totalAmount: 1000,
      date: DATE,
      categoryId: "edu",
      accountId: "sbi",
      notes: "",
      personId: "amma",
      personName: "AMMA",
    });
    expect(await shareNotes(r, "amma")).toEqual(["Split: Exam"]);
    const before = await financialSnapshot(r, expense.id);

    await renameTransaction(r, tx.id, "Electricity Bill");

    expect(await shareNotes(r, "amma")).toEqual(["Split: Electricity Bill"]);
    expect(((await r.expenseRepository.getByKey(expense.id)) as Expense).description).toBe("Electricity Bill");
    expect(await financialSnapshot(r, expense.id)).toEqual(before);
    expect((await r.personRepository.getByKey("amma"))!.currentBalance).toBe(1000);
  });
});
