import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Account } from "@/lib/models/account";
import type { LedgerEntry, Person } from "@/lib/models/person";
import { isNonIncomeExpenseMovement, type Transaction } from "@/lib/models/transaction";
import { buildMySpendContext, classifyForMySpend } from "@/lib/engines/my-spend";
import { calculateNetWorth } from "@/lib/engines/net-worth";
import { AccountRepository } from "./account-repository";
import { LedgerRepository, PersonRepository } from "./person-repository";
import { TransactionRepository } from "./transaction-repository";

/**
 * Add Expense → "Money I Borrowed → Money received into my account" (`recordBorrowedCash`), through the real
 * repositories: one "borrowed" entry + its cash-IN leg (`addEntryWithTransaction`, the same path People →
 * Add entry uses). Borrowing is never an expense and never income; spending the borrowed cash later is a
 * separate ordinary expense that creates no second debt; repaying is a settlement, never My Spend.
 * Person-funded expenses ("<person> paid this expense for me") are covered in `person-funded-expense.test.ts`.
 * Same fake-Firestore transaction as that file: one shared store, writes commit only if the callback resolves.
 */
vi.mock("firebase/firestore", () => ({
  doc: vi.fn((_collection: unknown, id: string) => ({ id })),
  runTransaction: vi.fn(),
  getDocs: vi.fn(),
  query: vi.fn((...args: unknown[]) => ({ args })),
  where: vi.fn((field: string, op: string, value: unknown) => ({ field, op, value })),
  Timestamp: {
    fromDate: (d: Date) => ({ toDate: () => d }),
  },
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

const account = (id: string, balance: number) =>
  ({ id, name: id.toUpperCase(), type: "bank", currentBalance: balance, openingBalance: balance, deletedAt: null, editHistory: [] }) as unknown as Account;
const DATE = new Date("2026-09-12T10:00:00Z");

function setup() {
  const store = new Map<string, unknown>([
    ["amma", person("amma", "AMMA")],
    ["sbi", account("sbi", 10000)],
    ["hdfc", account("hdfc", 5000)],
  ]);
  setUpRunTransaction(store);
  const accounts = new AccountRepository({ firestore: {} } as never);
  const transactions = new TransactionRepository({ firestore: {} } as never, accounts);
  const people = new PersonRepository({ firestore: {} } as never);
  const ledger = new LedgerRepository({ firestore: {} } as never, people);
  const get = <T,>(id: string) => store.get(id) as T;
  const balance = (id: string) => get<Account>(id).currentBalance;
  const amma = () => get<Person>("amma");
  /** FlowFi sign: negative = I owe them. */
  const owed = () => amma().currentBalance;
  const live = <T extends { deletedAt: Date | null }>(pred: (v: T) => boolean) =>
    [...store.values()].filter((v) => (v as T).deletedAt == null && pred(v as T)) as T[];
  const entries = () => live<LedgerEntry>((v) => "transactionRef" in v && "personId" in v);
  const txns = () => live<Transaction>((v) => "accountId" in v && "type" in v);
  const ctx = buildMySpendContext({ expenses: [] });
  const mySpend = () => txns().reduce((s, t) => s + classifyForMySpend(t, ctx).myAmount, 0);
  /** Income as reported: income transactions that are not People/Loan movements. */
  const income = () => txns().filter((t) => t.type === "income" && !isNonIncomeExpenseMovement(t)).reduce((s, t) => s + t.amount, 0);
  /** Dashboard Net Worth: account balances + the People direct balance (what I owe is negative). */
  const netWorth = () => calculateNetWorth([get<Account>("sbi"), get<Account>("hdfc")]) + owed();

  /** Exactly what `recordBorrowedCash` (Add Expense → Money received into my account) writes. */
  const borrow = (amount: number, accountId = "sbi") =>
    ledger.addEntryWithTransaction(
      amma(),
      { type: "borrowed", amount, date: DATE, note: "Loan", receivedStatus: "yetToReceive" },
      { type: "income", accountId, categoryId: "personal-loan", description: "AMMA" },
      transactions,
    );
  const repay = (amount: number, parentEntryId: string) =>
    ledger.addEntryWithTransaction(
      amma(),
      { type: "repaid", amount, date: new Date("2026-09-25T10:00:00Z"), parentEntryId, receivedStatus: "received" },
      { type: "expense", accountId: "sbi", categoryId: "personal-loan", description: "AMMA" },
      transactions,
    );
  const spend = (amount: number) =>
    transactions.createTransaction({ type: "expense", amount, dateTime: DATE, accountId: "sbi", categoryId: "food", description: "Dinner" });
  return { store, transactions, ledger, get, balance, amma, owed, entries, txns, mySpend, income, netWorth, borrow, repay, spend };
}

describe("Money I Borrowed → Money received into my account", () => {
  beforeEach(() => {
    vi.mocked(runTransaction).mockClear();
  });

  it("1/17/18/19. borrow ₹1,000 into SBI → SBI +₹1,000, I owe ₹1,000, My Spend ₹0, Income ₹0, Net Worth unchanged", async () => {
    const t = setup();
    const before = t.netWorth();
    const { transaction, entry } = await t.borrow(1000);
    expect(t.balance("sbi")).toBe(11000);
    expect(t.balance("hdfc")).toBe(5000);
    expect(t.owed()).toBe(-1000);
    expect(t.mySpend()).toBe(0);
    expect(t.income()).toBe(0);
    expect(t.netWorth()).toBe(before);
    expect(transaction).toMatchObject({ type: "income", isPersonLedgerMovement: true, linkedPersonId: "amma", accountId: "sbi" });
    expect(entry).toMatchObject({ type: "borrowed", amount: 1000, transactionRef: transaction.id });
    // No expense of any kind exists merely because I borrowed.
    expect(t.txns().filter((x) => x.type === "expense")).toHaveLength(0);
  });

  it("2. borrow ₹1,000 into HDFC → only HDFC moves", async () => {
    const t = setup();
    await t.borrow(1000, "hdfc");
    expect(t.balance("hdfc")).toBe(6000);
    expect(t.balance("sbi")).toBe(10000);
    expect(t.owed()).toBe(-1000);
  });

  it("4/21. edit ₹1,000 → ₹1,500 → SBI and debt move by +₹500 exactly once; re-applying the stale edit is a no-op", async () => {
    const t = setup();
    const { entry } = await t.borrow(1000);
    await t.ledger.editEntry(t.amma(), entry, { amount: 1500 }, t.transactions);
    expect(t.balance("sbi")).toBe(11500);
    expect(t.owed()).toBe(-1500);
    // A second save from a stale copy (still says ₹1,000) asking for ₹1,500 again: the fresh read wins.
    await t.ledger.editEntry(t.amma(), entry, { amount: 1500 }, t.transactions);
    expect(t.balance("sbi")).toBe(11500);
    expect(t.owed()).toBe(-1500);
    expect(t.entries()).toHaveLength(1);
  });

  it("6. change the receiving account SBI → HDFC → SBI reversed once, HDFC credited once, debt unchanged", async () => {
    const t = setup();
    const { transaction } = await t.borrow(1000);
    await t.transactions.editTransaction(transaction, { accountId: "hdfc" });
    expect(t.balance("sbi")).toBe(10000);
    expect(t.balance("hdfc")).toBe(6000);
    expect(t.owed()).toBe(-1000);
    expect(t.entries()).toHaveLength(1);
  });

  it("8/22. delete → SBI and debt both reverse exactly once, no ghost People entry", async () => {
    const t = setup();
    const { entry, transaction } = await t.borrow(1000);
    await t.ledger.softDeleteEntriesWithCashLegs(t.amma(), [t.get<LedgerEntry>(entry.id)], t.transactions);
    expect(t.balance("sbi")).toBe(10000);
    expect(t.owed()).toBe(0);
    expect(t.entries()).toHaveLength(0);
    expect(t.get<Transaction>(transaction.id).deletedAt).not.toBeNull();
    // Deleting again from a stale copy doesn't reverse twice.
    await t.ledger.softDeleteEntriesWithCashLegs(t.amma(), [entry], t.transactions).catch(() => {});
    expect(t.balance("sbi")).toBe(10000);
    expect(t.owed()).toBe(0);
  });

  it("12/13. repay ₹400 then the remaining ₹600 → debt ₹0; SBI −₹1,000; My Spend and Income stay ₹0", async () => {
    const t = setup();
    const { entry } = await t.borrow(1000);
    await t.repay(400, entry.id);
    expect(t.owed()).toBe(-600);
    expect(t.balance("sbi")).toBe(10600);
    await t.repay(600, entry.id);
    expect(t.owed()).toBe(0);
    expect(t.balance("sbi")).toBe(10000);
    expect(t.mySpend()).toBe(0);
    expect(t.income()).toBe(0);
  });

  it("14. delete the repayment → the debt returns and SBI gets the money back, once", async () => {
    const t = setup();
    const { entry } = await t.borrow(1000);
    const pay = await t.repay(400, entry.id);
    await t.ledger.softDeleteEntriesWithCashLegs(t.amma(), [t.get<LedgerEntry>(pay.entry.id)], t.transactions);
    expect(t.owed()).toBe(-1000);
    expect(t.balance("sbi")).toBe(11000);
  });

  it("15/16. borrow ₹29,444 then separately spend ₹5,000 from SBI → My Spend ₹5,000, still owe exactly ₹29,444", async () => {
    const t = setup();
    await t.borrow(29444);
    await t.spend(5000);
    expect(t.balance("sbi")).toBe(10000 + 29444 - 5000);
    expect(t.owed()).toBe(-29444);
    expect(t.entries()).toHaveLength(1);
    expect(t.mySpend()).toBe(5000);
    expect(t.income()).toBe(0);
  });
});
