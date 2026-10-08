import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Account } from "@/lib/models/account";
import type { LedgerEntry, Person } from "@/lib/models/person";
import type { Transaction } from "@/lib/models/transaction";
import { planOrphanReconciliation, transactionOwnership } from "@/lib/engines/transaction-owned-ledger";
import { deletePersonCashLegTransaction } from "@/lib/services/person-cash-leg-deletion";
import { deleteTransactionWithLinkedEffects } from "@/lib/services/transaction-deletion";
import { deleteCommittedAwareRow } from "@/features/transaction-studio/lib/committed-transaction-sync";
import type { GridRow } from "@/features/transaction-studio/lib/grid-types";
import { AccountRepository } from "./account-repository";
import { LedgerRepository, PersonRepository } from "./person-repository";
import { TransactionRepository } from "./transaction-repository";

/**
 * The "ghost Exam ₹1,000" regression: a People obligation owned by a Transaction must follow that
 * transaction's whole lifecycle — create, delete (from EVERY entry point), restore, edit, reassign — and a
 * ghost left behind by an older transaction-only delete must be repaired without touching anything that
 * isn't provably owned by the deleted transaction. Real repositories over the same fake-Firestore
 * transaction as `person-funded-expense.test.ts`.
 */
vi.mock("firebase/firestore", () => ({
  doc: vi.fn((_collection: unknown, id: string) => ({ id })),
  runTransaction: vi.fn(),
  getDocs: vi.fn(),
  query: vi.fn((...args: unknown[]) => ({ args })),
  where: vi.fn((field: string, op: string, value: unknown) => ({ field, op, value })),
  Timestamp: { fromDate: (d: Date) => ({ toDate: () => d }) },
}));

import { runTransaction } from "firebase/firestore";

function setUpRunTransaction(store: Map<string, unknown>) {
  const impl = async (_db: unknown, updateFn: (tx: unknown) => Promise<unknown>) => {
    const pending = new Map<string, unknown>();
    let wrote = false;
    const tx = {
      get: vi.fn(async (ref: { id: string }) => {
        if (wrote) throw new Error(`read after write: ${ref.id}`);
        const data = pending.has(ref.id) ? pending.get(ref.id) : store.get(ref.id);
        return { exists: () => data !== undefined, data: () => data };
      }),
      set: vi.fn((ref: { id: string }, value: unknown) => {
        wrote = true;
        pending.set(ref.id, value);
      }),
    };
    const result = await updateFn(tx);
    for (const [k, v] of pending) store.set(k, v);
    return result;
  };
  vi.mocked(runTransaction).mockImplementation(impl as unknown as typeof runTransaction);
}

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

const DATE = new Date("2026-09-12T10:00:00Z");

function setup() {
  const store = new Map<string, unknown>([
    ["amma", person("amma", "AMMA")],
    ["tripthee", person("tripthee", "Tripthee")],
    ["sbi", { id: "sbi", name: "SBI", type: "bank", currentBalance: 10000, openingBalance: 10000, deletedAt: null, editHistory: [] } as unknown as Account],
  ]);
  setUpRunTransaction(store);
  const accounts = new AccountRepository({ firestore: {} } as never);
  const transactions = Object.assign(new TransactionRepository({ firestore: {} } as never, accounts), {
    getByKey: async (id: string) => (store.get(id) as Transaction) ?? null,
  });
  const people = Object.assign(new PersonRepository({ firestore: {} } as never), {
    getByKey: async (id: string) => (store.get(id) as Person) ?? null,
  });
  const isEntry = (v: unknown): v is LedgerEntry => typeof v === "object" && v != null && "transactionRef" in v && "personId" in v;
  const ledgerFor = (personId: string) => {
    const ledger = new LedgerRepository({ firestore: {} } as never, people);
    ledger.getAll = async () => [...store.values()].filter((v): v is LedgerEntry => isEntry(v) && v.personId === personId && v.deletedAt == null);
    return ledger;
  };
  const ammaLedger = ledgerFor("amma");
  const amma = () => store.get("amma") as Person;
  const tripthee = () => store.get("tripthee") as Person;
  const get = <T,>(id: string) => store.get(id) as T;
  const sbi = () => get<Account>("sbi").currentBalance;
  /** FlowFi sign: negative = I owe them ("You need to pay"), positive = they owe me. */
  const balanceOf = (id: string) => get<Person>(id).currentBalance;
  const activeEntries = (personId: string) => [...store.values()].filter((v): v is LedgerEntry => isEntry(v) && v.personId === personId && v.deletedAt == null);
  /** Independent check of the cached balance: the sum the statement engines read from active entries. */
  const payableFromEntries = (personId: string) =>
    activeEntries(personId).reduce((s, e) => s + (e.type === "borrowed" || e.type === "receivedBack" ? -e.amount : e.amount), 0);

  const exam = (amount = 1000) =>
    ammaLedger.createPersonFundedExpense(amma(), { amount, date: DATE, categoryId: "education", description: "Exam" }, transactions);

  /** The one delete every screen uses — no expenses exist in these scenarios. */
  const linkedDelete = (t: Transaction) =>
    deleteTransactionWithLinkedEffects(t, {
      transactionRepository: transactions,
      findExpense: async () => null,
      deleteExpense: async () => {
        throw new Error("no expense expected");
      },
      deletePersonLinked: (txn) =>
        deletePersonCashLegTransaction({ transaction: txn, transactionRepository: transactions, personRepository: people, ledgerRepositoryFor: ledgerFor }),
    });

  return { store, transactions, people, ledgerFor, ammaLedger, amma, tripthee, get, sbi, balanceOf, activeEntries, payableFromEntries, exam, linkedDelete };
}

const studioRow = (committedTransactionId: string) => ({ id: "row-1", committedTransactionId }) as unknown as GridRow;

describe("Transaction-owned People obligation follows its transaction — 'Exam ₹1,000, you need to pay AMMA'", () => {
  beforeEach(() => {
    vi.mocked(runTransaction).mockClear();
  });

  it("1–4. create → exists; delete → ₹0; restore → ₹1,000 once; delete again → ₹0 once", async () => {
    const t = setup();
    const { entry, transaction } = await t.exam();
    expect(t.balanceOf("amma")).toBe(-1000);
    expect(t.payableFromEntries("amma")).toBe(-1000);

    await t.linkedDelete(t.get<Transaction>(transaction.id));
    expect(t.get<Transaction>(transaction.id).deletedAt).not.toBeNull();
    expect(t.balanceOf("amma")).toBe(0);
    expect(t.activeEntries("amma")).toHaveLength(0);

    await t.ammaLedger.restorePersonFundedExpense(t.amma(), t.get<LedgerEntry>(entry.id), t.transactions);
    await t.ammaLedger.restorePersonFundedExpense(t.amma(), t.get<LedgerEntry>(entry.id), t.transactions);
    expect(t.balanceOf("amma")).toBe(-1000);
    expect(t.activeEntries("amma").map((e) => e.id)).toEqual([entry.id]); // 15. no duplicate

    await t.linkedDelete(t.get<Transaction>(transaction.id));
    expect(t.balanceOf("amma")).toBe(0);
    expect(t.payableFromEntries("amma")).toBe(0);
    expect(t.sbi()).toBe(10000); // a person-funded expense never moved an account
  });

  it("5. edit amount ₹1,000 → ₹500 → AMMA ₹500 on the same entry", async () => {
    const t = setup();
    const { entry, transaction } = await t.exam();
    await t.ammaLedger.changeExpenseFunding({
      transaction,
      from: { person: t.amma(), ledger: t.ammaLedger, entry, hasSettlements: false },
      to: { kind: "person", person: t.amma(), ledger: t.ammaLedger },
      edits: { amount: 500 },
      transactionRepository: t.transactions,
    });
    expect(t.balanceOf("amma")).toBe(-500);
    expect(t.activeEntries("amma").map((e) => [e.id, e.amount])).toEqual([[entry.id, 500]]);
  });

  it("6. AMMA → TRIPTHEE: AMMA ₹0, TRIPTHEE ₹1,000 — never both", async () => {
    const t = setup();
    const { entry, transaction } = await t.exam();
    await t.ammaLedger.changeExpenseFunding({
      transaction,
      from: { person: t.amma(), ledger: t.ammaLedger, entry, hasSettlements: false },
      to: { kind: "person", person: t.tripthee(), ledger: t.ledgerFor("tripthee") },
      transactionRepository: t.transactions,
    });
    expect(t.balanceOf("amma")).toBe(0);
    expect(t.balanceOf("tripthee")).toBe(-1000);
    expect(t.activeEntries("amma")).toHaveLength(0);
    expect(t.activeEntries("tripthee")).toHaveLength(1);

    // …and deleting it afterwards clears TRIPTHEE, leaving AMMA untouched.
    await t.linkedDelete(t.get<Transaction>(transaction.id));
    expect(t.balanceOf("tripthee")).toBe(0);
    expect(t.balanceOf("amma")).toBe(0);
  });

  it("7. remove the person (paid from my account instead) → People effect clears, SBI −₹1,000 once", async () => {
    const t = setup();
    const { entry, transaction } = await t.exam();
    await t.ammaLedger.changeExpenseFunding({
      transaction,
      from: { person: t.amma(), ledger: t.ammaLedger, entry, hasSettlements: false },
      to: { kind: "account", accountId: "sbi" },
      transactionRepository: t.transactions,
    });
    expect(t.balanceOf("amma")).toBe(0);
    expect(t.activeEntries("amma")).toHaveLength(0);
    expect(t.sbi()).toBe(9000);
  });

  it("8a. Transaction Studio single-row delete takes the obligation with it (was: bare soft delete → ghost)", async () => {
    const t = setup();
    const { transaction } = await t.exam();
    const deleteRecord = vi.fn().mockResolvedValue(undefined);
    await deleteCommittedAwareRow({
      row: studioRow(transaction.id),
      committedTransaction: t.get<Transaction>(transaction.id),
      transactionRepository: t.transactions,
      mutations: { deleteRecord },
      deleteTransaction: t.linkedDelete,
    });
    expect(t.balanceOf("amma")).toBe(0);
    expect(t.activeEntries("amma")).toHaveLength(0);
    expect(deleteRecord).toHaveBeenCalledWith("row-1");
  });

  it("8b. a borrowed-cash People cash leg deleted from any screen takes its obligation and reverses SBI once", async () => {
    const t = setup();
    const { transaction } = await t.ammaLedger.addEntryWithTransaction(
      t.amma(),
      { type: "borrowed", amount: 1000, date: DATE, note: "Exam" },
      { type: "income", accountId: "sbi", categoryId: "personal-loan" },
      t.transactions,
    );
    expect(t.sbi()).toBe(11000);
    await t.linkedDelete(t.get<Transaction>(transaction.id));
    expect(t.sbi()).toBe(10000);
    expect(t.balanceOf("amma")).toBe(0);
  });

  it("8c. a plain expense still uses the plain balance-reversing delete", async () => {
    const t = setup();
    const tx = await t.transactions.createTransaction({ type: "expense", amount: 300, dateTime: DATE, accountId: "sbi", categoryId: "food" });
    await t.linkedDelete(tx);
    expect(t.sbi()).toBe(10000);
    expect(t.get<Transaction>(tx.id).deletedAt).not.toBeNull();
  });

  it("8d. a transaction backed by a split/assigned Expense is routed to deleteExpense even when the caller didn't pass it", async () => {
    const t = setup();
    const tx = await t.transactions.createTransaction({ type: "expense", amount: 600, dateTime: DATE, accountId: "sbi", categoryId: "food" });
    const expense = { id: "exp-1", transactionId: tx.id, deletedAt: null } as never;
    const deleteExpense = vi.fn().mockResolvedValue(undefined);
    const softDeleteTransaction = vi.fn();
    await deleteTransactionWithLinkedEffects(tx, {
      transactionRepository: { softDeleteTransaction, deleteTransferPair: vi.fn() },
      findExpense: async (id) => (id === tx.id ? expense : null),
      deleteExpense,
      deletePersonLinked: vi.fn(),
    });
    expect(deleteExpense).toHaveBeenCalledWith(expense);
    expect(softDeleteTransaction).not.toHaveBeenCalled();
  });

  it("gross sides stay separate: AMMA owes me ₹1,000 and I owe AMMA ₹500 — deleting the ₹500 leaves the ₹1,000 untouched", async () => {
    const t = setup();
    const gave = await t.ammaLedger.addEntry(t.amma(), { type: "gave", amount: 1000, date: DATE, note: "Lent" });
    const { transaction } = await t.exam(500);
    expect(t.balanceOf("amma")).toBe(500);
    await t.linkedDelete(t.get<Transaction>(transaction.id));
    expect(t.balanceOf("amma")).toBe(1000);
    expect(t.activeEntries("amma").map((e) => e.id)).toEqual([gave.id]);
  });
});

describe("Historical ghost repair — an obligation left behind by an older transaction-only delete", () => {
  beforeEach(() => {
    vi.mocked(runTransaction).mockClear();
  });

  /** Reproduces the old bug: the expense alone was soft-deleted, its People entry stayed active. */
  async function ghostExam() {
    const t = setup();
    const created = await t.exam();
    await t.transactions.softDeleteTransaction(t.get<Transaction>(created.transaction.id), { owner: "people" }); // simulates the pre-guard delete path
    return { t, ...created };
  }

  it("9. the ghost is detected, then removed: AMMA ₹1,000 → ₹0; the entry is kept in trash for audit", async () => {
    const { t, entry } = await ghostExam();
    expect(t.balanceOf("amma")).toBe(-1000); // the bug

    const plan = planOrphanReconciliation(t.activeEntries("amma"), (ref) => t.get<Transaction>(ref) ?? null);
    expect(plan.reconcile.map((e) => e.id)).toEqual([entry.id]);
    const removed = await t.ammaLedger.reconcileOrphanedTransactionEntries(t.amma(), [entry.id], t.transactions);

    expect(removed).toEqual([entry.id]);
    expect(t.balanceOf("amma")).toBe(0);
    expect(t.payableFromEntries("amma")).toBe(0);
    expect(t.get<LedgerEntry>(entry.id).deletedAt).not.toBeNull(); // soft delete, not destroyed
    expect(t.sbi()).toBe(10000);
  });

  it("repair is idempotent and restore still brings the obligation back exactly once", async () => {
    const { t, entry } = await ghostExam();
    await t.ammaLedger.reconcileOrphanedTransactionEntries(t.amma(), [entry.id], t.transactions);
    await t.ammaLedger.reconcileOrphanedTransactionEntries(t.amma(), [entry.id], t.transactions);
    expect(t.balanceOf("amma")).toBe(0);
    await t.ammaLedger.restorePersonFundedExpense(t.amma(), t.get<LedgerEntry>(entry.id), t.transactions);
    expect(t.balanceOf("amma")).toBe(-1000);
    expect(t.activeEntries("amma")).toHaveLength(1);
  });

  it("a hard-deleted (missing) person-funded expense is a ghost too — its sourceKind proves ownership", async () => {
    const { t, entry, transaction } = await ghostExam();
    t.store.delete(transaction.id);
    expect(await t.ammaLedger.reconcileOrphanedTransactionEntries(t.amma(), [entry.id], t.transactions)).toEqual([entry.id]);
    expect(t.balanceOf("amma")).toBe(0);
  });

  it("a borrowed-cash entry whose own cash leg was deleted alone is repaired; SBI is not moved again", async () => {
    const t = setup();
    const { entry, transaction } = await t.ammaLedger.addEntryWithTransaction(
      t.amma(),
      { type: "borrowed", amount: 1000, date: DATE, note: "Exam" },
      { type: "income", accountId: "sbi", categoryId: "personal-loan" },
      t.transactions,
    );
    await t.transactions.softDeleteTransaction(t.get<Transaction>(transaction.id), { owner: "people" }); // old bug — simulates the pre-guard delete path
    expect(t.sbi()).toBe(10000);
    expect(await t.ammaLedger.reconcileOrphanedTransactionEntries(t.amma(), [entry.id], t.transactions)).toEqual([entry.id]);
    expect(t.balanceOf("amma")).toBe(0);
    expect(t.sbi()).toBe(10000);
  });

  it("a live transaction is NEVER treated as a ghost — even if a stale client nominates it", async () => {
    const t = setup();
    const { entry } = await t.exam();
    expect(await t.ammaLedger.reconcileOrphanedTransactionEntries(t.amma(), [entry.id], t.transactions)).toEqual([]);
    expect(t.balanceOf("amma")).toBe(-1000);
  });

  it("11. a ghost with a real repayment recorded against it is NOT auto-removed (reported as blocked)", async () => {
    const t = setup();
    const { entry, transaction } = await t.exam();
    await t.ammaLedger.addEntryWithTransaction(
      t.amma(),
      { type: "repaid", amount: 400, date: DATE, parentEntryId: entry.id, receivedStatus: "received" },
      { type: "expense", accountId: "sbi", categoryId: "personal-loan" },
      t.transactions,
    );
    await t.transactions.softDeleteTransaction(t.get<Transaction>(transaction.id), { owner: "people" }); // simulates the pre-guard delete path
    const plan = planOrphanReconciliation(t.activeEntries("amma"), (ref) => t.get<Transaction>(ref) ?? null);
    expect(plan.reconcile).toHaveLength(0);
    expect(plan.blocked.map((e) => e.id)).toEqual([entry.id]);
    expect(await t.ammaLedger.reconcileOrphanedTransactionEntries(t.amma(), [entry.id], t.transactions)).toEqual([]);
    expect(t.balanceOf("amma")).toBe(-600);
    expect(t.sbi()).toBe(9600);
  });

  it("10/12/13/14. standalone, advance, Loan-linked and split-share entries are never ghosts", async () => {
    const t = setup();
    const deletedTxn = await t.transactions.createTransaction({ type: "expense", amount: 100, dateTime: DATE, accountId: "sbi", categoryId: "food" });
    await t.transactions.softDeleteTransaction(deletedTxn, { owner: "people" }); // simulates the pre-guard delete path
    const standalone = await t.ammaLedger.addEntry(t.amma(), { type: "borrowed", amount: 700, date: DATE, note: "Cash from AMMA" });
    const loanLinked = await t.ammaLedger.addEntry(t.amma(), { type: "gave", amount: 5000, date: DATE, transactionRef: "loan-123" });
    const advance = await t.ammaLedger.addEntry(t.amma(), { type: "receivedBack", amount: 200, date: DATE, transactionRef: "missing-cash-leg", sourceKind: "advance" });
    const splitShare = await t.ammaLedger.addEntry(t.amma(), { type: "gave", amount: 300, date: DATE, transactionRef: deletedTxn.id, sourceKind: "splitExpense" });
    const before = t.balanceOf("amma");

    const plan = planOrphanReconciliation(t.activeEntries("amma"), (ref) => t.get<Transaction>(ref) ?? null);
    expect(plan).toEqual({ reconcile: [], blocked: [] });
    const ids = [standalone.id, loanLinked.id, advance.id, splitShare.id];
    expect(await t.ammaLedger.reconcileOrphanedTransactionEntries(t.amma(), ids, t.transactions)).toEqual([]);
    expect(t.balanceOf("amma")).toBe(before);
    expect(t.activeEntries("amma")).toHaveLength(4);
  });

  it("Record Payment entries (paymentId) are never touched — they are reverted as one payment", () => {
    const entry = { id: "e", personId: "amma", type: "repaid", transactionRef: "gone", paymentId: "pay-1", sourceKind: "manual", deletedAt: null } as unknown as LedgerEntry;
    expect(transactionOwnership(entry, null)).toBe("notOwned");
  });

  it("an unknown (not yet loaded) owner proves nothing", () => {
    const entry = { id: "e", personId: "amma", type: "borrowed", transactionRef: "t1", paymentId: null, sourceKind: "personFundedExpense", deletedAt: null } as unknown as LedgerEntry;
    expect(transactionOwnership(entry, undefined)).toBe("notOwned");
  });
});
