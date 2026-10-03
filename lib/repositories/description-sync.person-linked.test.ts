import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Account } from "@/lib/models/account";
import type { LedgerEntry, Person } from "@/lib/models/person";
import type { Transaction } from "@/lib/models/transaction";
import { buildMySpendContext, classifyForMySpend } from "@/lib/engines/my-spend";
import { followsDescription, syncLinkedDescription } from "@/lib/services/transaction-description-sync";
import { AccountRepository } from "./account-repository";
import { LedgerRepository, PersonRepository } from "./person-repository";
import { TransactionRepository } from "./transaction-repository";

/**
 * Renaming a person-linked transaction (person-funded expense, "Money I Gave" cash leg): the People row
 * (its ledger entry's `note`) follows the new description with ZERO financial effect â€” no SBI move, no
 * People balance change, no My Spend change, no new entry. Same fake-Firestore transaction as
 * `person-funded-expense.test.ts`.
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

const SBI = { id: "sbi", name: "SBI", type: "bank", currentBalance: 10000, openingBalance: 10000, deletedAt: null, editHistory: [] } as unknown as Account;
const DATE = new Date("2026-09-12T10:00:00Z");

function setup() {
  const store = new Map<string, unknown>([
    ["amma", person("amma", "AMMA")],
    ["sbi", { ...SBI }],
  ]);
  setUpRunTransaction(store);
  const accounts = new AccountRepository({ firestore: {} } as never);
  const transactions = new TransactionRepository({ firestore: {} } as never, accounts);
  const people = Object.assign(new PersonRepository({ firestore: {} } as never), { getByKey: async (id: string) => (store.get(id) as Person) ?? null });
  const entriesOf = (personId: string) =>
    [...store.values()].filter((v): v is LedgerEntry => (v as LedgerEntry).personId === personId && (v as LedgerEntry).deletedAt == null && "type" in (v as object) && "note" in (v as object));
  const ledgerFor = (personId: string) => {
    const ledger = new LedgerRepository({ firestore: {} } as never, people);
    ledger.getAll = async () => entriesOf(personId);
    ledger.getByTransactionRef = async (ref: string) => entriesOf(personId).filter((e) => e.transactionRef === ref);
    return ledger;
  };
  const ammaLedger = ledgerFor("amma");
  const deps = {
    // No split/assigned Expense in these scenarios.
    expenseRepository: { getAll: async () => [], syncDescription: vi.fn(async () => {}) },
    personRepository: people,
    ledgerRepositoryFor: ledgerFor,
  };
  const amma = () => store.get("amma") as Person;
  const tx = (id: string) => store.get(id) as Transaction;
  /** Every number a description-only edit must leave alone. */
  const money = (transactionId: string) => ({
    sbi: (store.get("sbi") as Account).currentBalance,
    amma: amma().currentBalance,
    entries: entriesOf("amma").map((e) => ({ id: e.id, type: e.type, amount: e.amount, receivedStatus: e.receivedStatus })),
    transaction: { amount: tx(transactionId).amount, accountId: tx(transactionId).accountId, type: tx(transactionId).type, fundedByPersonId: tx(transactionId).fundedByPersonId },
    mySpend: classifyForMySpend(tx(transactionId), buildMySpendContext({ expenses: [] })).myAmount,
  });
  return { store, transactions, ammaLedger, deps, amma, tx, money, entriesOf };
}

describe("Person-funded expense â€” AMMA paid â‚¹1,000 directly; Exam â†’ KSEB Bill", () => {
  beforeEach(() => {
    vi.mocked(runTransaction).mockClear();
  });

  it("canonical path (same-person changeExpenseFunding with only a description): note follows, zero financial delta", async () => {
    const t = setup();
    const { transaction } = await t.ammaLedger.createPersonFundedExpense(t.amma(), { amount: 1000, date: DATE, categoryId: "edu", description: "Exam" }, t.transactions);
    const before = t.money(transaction.id);

    await t.ammaLedger.changeExpenseFunding({
      transaction: t.tx(transaction.id),
      from: { person: t.amma(), ledger: t.ammaLedger, entry: t.entriesOf("amma")[0], hasSettlements: false },
      to: { kind: "person", person: t.amma(), ledger: t.ammaLedger },
      edits: { description: "KSEB Bill" },
      transactionRepository: t.transactions,
    });

    expect(t.entriesOf("amma").map((e) => e.note)).toEqual(["KSEB Bill"]);
    expect(t.tx(transaction.id).description).toBe("KSEB Bill");
    // SBI â‚¹10,000, I owe AMMA â‚¹1,000, My Spend â‚¹1,000, the same single entry â€” unchanged.
    expect(t.money(transaction.id)).toEqual(before);
    expect(before).toMatchObject({ sbi: 10000, amma: -1000, mySpend: 1000 });
  });

  it("the shared sync is a no-op once the canonical path already renamed it (no double edit)", async () => {
    const t = setup();
    const { transaction } = await t.ammaLedger.createPersonFundedExpense(t.amma(), { amount: 1000, date: DATE, categoryId: "edu", description: "Exam" }, t.transactions);
    const old = t.tx(transaction.id);
    await t.ammaLedger.changeExpenseFunding({
      transaction: old,
      from: { person: t.amma(), ledger: t.ammaLedger, entry: t.entriesOf("amma")[0], hasSettlements: false },
      to: { kind: "person", person: t.amma(), ledger: t.ammaLedger },
      edits: { description: "KSEB Bill" },
      transactionRepository: t.transactions,
    });
    const history = t.entriesOf("amma")[0].editHistory.length;
    await syncLinkedDescription(t.deps, old, "KSEB Bill");
    expect(t.entriesOf("amma")[0].editHistory).toHaveLength(history);
  });
});

describe("Money I Gave â€” â‚¹1,000 from SBI to AMMA (cash leg); Exam â†’ KSEB Bill", () => {
  beforeEach(() => {
    vi.mocked(runTransaction).mockClear();
  });

  async function gave(t: ReturnType<typeof setup>, note = "Exam") {
    return t.ammaLedger.addEntryWithTransaction(
      t.amma(),
      { type: "gave", amount: 1000, date: DATE, note, receivedStatus: "yetToReceive" },
      { type: "expense", accountId: "sbi", categoryId: "personal-loan", description: "Exam" },
      t.transactions,
    );
  }

  it("the People row reads the new description; SBI, AMMA owes â‚¹1,000 and My Spend unchanged", async () => {
    const t = setup();
    const { transaction } = await gave(t);
    const before = t.money(transaction.id);

    const old = t.tx(transaction.id);
    await t.transactions.editTransaction(old, { description: "KSEB Bill" });
    await syncLinkedDescription(t.deps, old, "KSEB Bill");

    expect(t.entriesOf("amma").map((e) => e.note)).toEqual(["KSEB Bill"]);
    expect(t.money(transaction.id)).toEqual(before);
    expect(before).toMatchObject({ sbi: 9000, amma: 1000 });
  });

  it("a note customised on the People side is the user's own text â€” never overwritten", async () => {
    const t = setup();
    const { transaction } = await gave(t, "Mom's exam fee (cash)");
    const old = t.tx(transaction.id);
    await t.transactions.editTransaction(old, { description: "KSEB Bill" });
    await syncLinkedDescription(t.deps, old, "KSEB Bill");
    expect(t.entriesOf("amma").map((e) => e.note)).toEqual(["Mom's exam fee (cash)"]);
  });

  it("a Record Payment entry (paymentId) is a payment-history snapshot â€” never rewritten", async () => {
    const t = setup();
    const { transaction } = await gave(t);
    // A payment line that happens to reference the same transaction and mirror its description.
    t.store.set("pay-1", { ...t.entriesOf("amma")[0], id: "pay-1", type: "receivedBack", amount: 200, paymentId: "p-1", note: "Exam" });
    const old = t.tx(transaction.id);
    await t.transactions.editTransaction(old, { description: "KSEB Bill" });
    await syncLinkedDescription(t.deps, old, "KSEB Bill");
    const notes = Object.fromEntries(t.entriesOf("amma").map((e) => [e.id, e.note]));
    expect(notes["pay-1"]).toBe("Exam");
  });
});

describe("followsDescription", () => {
  it("only renames a note that mirrors the old description (or is empty)", () => {
    expect(followsDescription("Exam", "Exam", "KSEB Bill")).toBe(true);
    expect(followsDescription("", "Exam", "KSEB Bill")).toBe(true);
    expect(followsDescription(" Exam ", "Exam", "KSEB Bill")).toBe(true);
    expect(followsDescription("Custom", "Exam", "KSEB Bill")).toBe(false);
    expect(followsDescription("KSEB Bill", "Exam", "KSEB Bill")).toBe(false);
    expect(followsDescription("Exam", "Exam", "   ")).toBe(false);
    expect(followsDescription("Exam", "Exam", undefined)).toBe(false);
    expect(followsDescription("Split: Exam", "Exam", "KSEB Bill")).toBe(false);
  });
});
