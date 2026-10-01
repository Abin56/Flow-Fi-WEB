import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Account } from "@/lib/models/account";
import type { LedgerEntry, Person } from "@/lib/models/person";
import type { Transaction } from "@/lib/models/transaction";
import { AccountRepository } from "./account-repository";
import { LedgerRepository, PersonRepository } from "./person-repository";
import { TransactionRepository } from "./transaction-repository";

/**
 * Money borrowed from a person, end-to-end through the real repositories: the "borrowed" ledger entry and
 * its cash-leg Transaction (into the chosen account) must stay linked through create, a second borrowing,
 * edit, repayment, repayment delete and borrowing delete. Same fake-Firestore transaction as
 * `person-repository.balance.test.ts` — one shared store, writes commit only if the callback resolves.
 */
vi.mock("firebase/firestore", () => ({
  doc: vi.fn((_collection: unknown, id: string) => ({ id })),
  runTransaction: vi.fn(),
  getDocs: vi.fn(),
  query: vi.fn((...args: unknown[]) => ({ args })),
  where: vi.fn((field: string, op: string, value: unknown) => ({ field, op, value })),
}));

import { runTransaction } from "firebase/firestore";

function setUpRunTransaction(store: Map<string, unknown>) {
  const impl = async (_db: unknown, updateFn: (tx: unknown) => Promise<unknown>) => {
    const pending = new Map<string, unknown>();
    const tx = {
      get: vi.fn(async (ref: { id: string }) => {
        const data = pending.has(ref.id) ? pending.get(ref.id) : store.get(ref.id);
        return { exists: () => data !== undefined, data: () => data };
      }),
      set: vi.fn((ref: { id: string }, value: unknown) => {
        pending.set(ref.id, value);
      }),
    };
    const result = await updateFn(tx);
    for (const [k, v] of pending) store.set(k, v);
    return result;
  };
  vi.mocked(runTransaction).mockImplementation(impl as unknown as typeof runTransaction);
}

const AMMA: Person = {
  id: "amma",
  name: "AMMA",
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
};

const SBI = { id: "sbi", name: "SBI", type: "bank", currentBalance: 2000, openingBalance: 2000, deletedAt: null, editHistory: [] } as unknown as Account;

function setup() {
  const store = new Map<string, unknown>([
    ["amma", { ...AMMA }],
    ["sbi", { ...SBI }],
  ]);
  setUpRunTransaction(store);
  const accounts = new AccountRepository({ firestore: {} } as never);
  const transactions = new TransactionRepository({ firestore: {} } as never, accounts);
  const people = new PersonRepository({ firestore: {} } as never);
  const ledger = new LedgerRepository({ firestore: {} } as never, people);
  const sbi = () => (store.get("sbi") as Account).currentBalance;
  const owed = () => (store.get("amma") as Person).currentBalance;
  const amma = () => store.get("amma") as Person;
  const get = <T,>(id: string) => store.get(id) as T;
  const borrow = (amount: number, date = new Date("2026-09-12T10:00:00Z")) =>
    ledger.addEntryWithTransaction(
      amma(),
      { type: "borrowed", amount, date, note: "Borrowed from AMMA" },
      { type: "income", accountId: "sbi", categoryId: "personal-loan", description: "AMMA" },
      transactions,
    );
  const repay = (amount: number, parentEntryId: string) =>
    ledger.addEntryWithTransaction(
      amma(),
      { type: "repaid", amount, date: new Date("2026-09-25T10:00:00Z"), parentEntryId, receivedStatus: "received" },
      { type: "expense", accountId: "sbi", categoryId: "personal-loan", description: "AMMA" },
      transactions,
    );
  return { store, transactions, ledger, sbi, owed, amma, get, borrow, repay };
}

describe("Money borrowed from a person — Transaction ↔ Account ↔ People ledger linkage", () => {
  beforeEach(() => {
    vi.mocked(runTransaction).mockClear();
  });

  it("1/5/6. borrow ₹1,000 into SBI → SBI ₹3,000, I owe ₹1,000, cash leg is a non-income People movement", async () => {
    const t = setup();
    const { entry, transaction } = await t.borrow(1000);
    expect(t.sbi()).toBe(3000);
    expect(t.owed()).toBe(-1000);
    expect(entry.transactionRef).toBe(transaction.id);
    expect(transaction).toMatchObject({ isPersonLedgerMovement: true, linkedPersonId: "amma", amount: 1000 });
  });

  it("2. borrow ₹1,000 then another ₹500 → two entries, I owe ₹1,500, SBI ₹3,500", async () => {
    const t = setup();
    const a = await t.borrow(1000);
    const b = await t.borrow(500, new Date("2026-09-20T10:00:00Z"));
    expect(a.entry.id).not.toBe(b.entry.id);
    expect(t.owed()).toBe(-1500);
    expect(t.sbi()).toBe(3500);
  });

  it("3/14. repay ₹500 against the ₹1,000 borrowing → I owe ₹500, SBI back to ₹2,500", async () => {
    const t = setup();
    const { entry } = await t.borrow(1000);
    await t.repay(500, entry.id);
    expect(t.owed()).toBe(-500);
    expect(t.sbi()).toBe(2500);
  });

  it("12. edit borrowing ₹1,000 → ₹1,200 from People → ledger AND its SBI cash leg move together", async () => {
    const t = setup();
    const { entry, transaction } = await t.borrow(1000);
    await t.ledger.editEntry(t.amma(), t.get<LedgerEntry>(entry.id), { amount: 1200 }, t.transactions);
    expect(t.owed()).toBe(-1200);
    expect(t.get<Transaction>(transaction.id).amount).toBe(1200);
    expect(t.sbi()).toBe(3200);
  });

  it("12b. editing the date moves the cash leg's date too", async () => {
    const t = setup();
    const { entry, transaction } = await t.borrow(1000);
    const newDate = new Date("2026-09-14T10:00:00Z");
    await t.ledger.editEntry(t.amma(), t.get<LedgerEntry>(entry.id), { date: newDate }, t.transactions);
    expect(t.get<Transaction>(transaction.id).dateTime).toEqual(newDate);
    expect(t.sbi()).toBe(3000);
  });

  it("12c. without a transaction repository the edit keeps its previous ledger-only behavior", async () => {
    const t = setup();
    const { entry, transaction } = await t.borrow(1000);
    await t.ledger.editEntry(t.amma(), t.get<LedgerEntry>(entry.id), { amount: 1200 });
    expect(t.owed()).toBe(-1200);
    expect(t.get<Transaction>(transaction.id).amount).toBe(1000);
  });

  it("12d. a payment's cash leg is never edited through a borrowing edit (only the entry's own 1:1 leg)", async () => {
    const t = setup();
    const { entry } = await t.borrow(1000);
    const pay = await t.repay(400, entry.id);
    await t.ledger.editEntry(t.amma(), t.get<LedgerEntry>(pay.entry.id), { note: "cash" }, t.transactions);
    expect(t.get<Transaction>(pay.transaction.id).amount).toBe(400);
  });

  it("13. delete the borrowing → obligation and SBI cash both reverse, nothing orphaned", async () => {
    const t = setup();
    const a = await t.borrow(1000);
    await t.borrow(500);
    await t.ledger.softDeleteEntriesWithCashLegs(t.amma(), [t.get<LedgerEntry>(a.entry.id)], t.transactions);
    expect(t.owed()).toBe(-500);
    expect(t.sbi()).toBe(2500);
    expect(t.get<Transaction>(a.transaction.id).deletedAt).not.toBeNull();
  });

  it("15. delete the repayment → the ₹1,000 outstanding returns and SBI gets the ₹500 back", async () => {
    const t = setup();
    const { entry } = await t.borrow(1000);
    const pay = await t.repay(500, entry.id);
    await t.ledger.softDeleteEntriesWithCashLegs(t.amma(), [t.get<LedgerEntry>(pay.entry.id)], t.transactions);
    expect(t.owed()).toBe(-1000);
    expect(t.sbi()).toBe(3000);
  });
});
