import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Account } from "@/lib/models/account";
import type { LedgerEntry, Person } from "@/lib/models/person";
import {
  balanceEffect,
  isNonIncomeExpenseMovement,
  PERSON_FUNDED_ACCOUNT_ID,
  type Transaction,
  transactionFromFirestore,
  transactionToFirestore,
} from "@/lib/models/transaction";
import { buildMySpendContext, classifyForMySpend, mySpendRows, summarizeMySpend } from "@/lib/engines/my-spend";
import { paidFromLabel } from "@/features/transactions/lib/funding-label";
import { deletePersonCashLegTransaction } from "@/lib/services/person-cash-leg-deletion";
import { AccountRepository } from "./account-repository";
import { LedgerRepository, PersonRepository } from "./person-repository";
import { TransactionFundingMismatchError, TransactionRepository } from "./transaction-repository";

/**
 * "Money I Borrowed → AMMA paid directly": a real expense of mine with NO account cash leg, backed 1:1 by
 * an "I owe AMMA" entry — kept distinct from an account-funded expense and from borrowed cash received
 * into an account. Real repositories over the same fake-Firestore transaction as
 * `person-borrowing-linkage.test.ts` (one shared store; writes commit only if the callback resolves).
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
        // Firestore forbids a read after a write inside one transaction — fail loudly like it would.
        if (wrote) throw new Error(`read after write: ${ref.id}`);
        if (ref.id === "") throw new Error("an account with an empty id was read");
        const data = pending.has(ref.id) ? pending.get(ref.id) : store.get(ref.id);
        return { exists: () => data !== undefined, data: () => data };
      }),
      set: vi.fn((ref: { id: string }, value: unknown) => {
        if (ref.id === "") throw new Error("an account with an empty id was written");
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
    ["tripthee", person("tripthee", "Tripthee")],
    ["sbi", { ...SBI }],
  ]);
  setUpRunTransaction(store);
  const accounts = new AccountRepository({ firestore: {} } as never);
  const transactions = new TransactionRepository({ firestore: {} } as never, accounts);
  const people = new PersonRepository({ firestore: {} } as never);
  // One fake store for every collection: each ledger reads only its own person's entries.
  const ledgerFor = (personId: string) => {
    const ledger = new LedgerRepository({ firestore: {} } as never, people);
    ledger.getAll = async () =>
      [...store.values()].filter((v): v is LedgerEntry => (v as LedgerEntry).personId === personId && (v as LedgerEntry).deletedAt == null && "type" in (v as object));
    return ledger;
  };
  const ammaLedger = ledgerFor("amma");
  const sbi = () => (store.get("sbi") as Account).currentBalance;
  const balanceOf = (id: string) => (store.get(id) as Person).currentBalance;
  const amma = () => store.get("amma") as Person;
  const tripthee = () => store.get("tripthee") as Person;
  const get = <T,>(id: string) => store.get(id) as T;
  const activeEntries = (personId: string) =>
    [...store.values()].filter((v) => (v as LedgerEntry).personId === personId && (v as LedgerEntry).deletedAt == null && "transactionRef" in (v as object)) as LedgerEntry[];
  const mySpend = (t: Transaction) => classifyForMySpend(t, buildMySpendContext({ expenses: [] })).myAmount;
  const directlyFunded = (amount = 1000) =>
    ammaLedger.createPersonFundedExpense(amma(), { amount, date: DATE, categoryId: "food", description: "Restaurant" }, transactions);
  const sbiExpense = (amount = 1000) =>
    transactions.createTransaction({ type: "expense", amount, dateTime: DATE, accountId: "sbi", categoryId: "food", description: "Restaurant" });
  /** The existing People settlement: a "repaid" entry against the obligation, with its own SBI cash leg. */
  const repay = (amount: number, parentEntryId: string) =>
    ammaLedger.addEntryWithTransaction(
      amma(),
      { type: "repaid", amount, date: new Date("2026-09-25T10:00:00Z"), parentEntryId, receivedStatus: "received" },
      { type: "expense", accountId: "sbi", categoryId: "personal-loan", description: "AMMA" },
      transactions,
    );
  const deleteViaTransactions = (transaction: Transaction) =>
    deletePersonCashLegTransaction({
      transaction,
      transactionRepository: Object.assign(transactions, { getByKey: async (id: string) => (store.get(id) as Transaction) ?? null }),
      personRepository: Object.assign(people, { getByKey: async (id: string) => (store.get(id) as Person) ?? null }),
      ledgerRepositoryFor: ledgerFor,
    });
  return { store, transactions, people, ledgerFor, ammaLedger, sbi, balanceOf, amma, tripthee, get, activeEntries, mySpend, directlyFunded, sbiExpense, repay, deleteViaTransactions };
}

describe("Person-funded expense — AMMA paid ₹1,000 directly for my expense", () => {
  beforeEach(() => {
    vi.mocked(runTransaction).mockClear();
  });

  it("1/2. SBI ₹10,000 → ₹10,000; My Spend ₹1,000; I owe AMMA ₹1,000; Income ₹0", async () => {
    const t = setup();
    const { entry, transaction } = await t.directlyFunded();
    expect(t.sbi()).toBe(10000);
    expect(t.balanceOf("amma")).toBe(-1000); // FlowFi sign: negative = I owe them
    expect(transaction).toMatchObject({ type: "expense", amount: 1000, accountId: PERSON_FUNDED_ACCOUNT_ID, fundedByPersonId: "amma", linkedPersonId: "amma", owesPersonToggle: false, isPersonLedgerMovement: false });
    expect(balanceEffect(transaction)).toBe(0);
    expect(t.mySpend(transaction)).toBe(1000);
    // An expense (counted as spend), never income, never a People cash movement.
    expect(transaction.type).not.toBe("income");
    expect(isNonIncomeExpenseMovement(transaction)).toBe(false);
    // 12. Two-way link: expense → AMMA, AMMA's obligation → expense.
    expect(entry).toMatchObject({ type: "borrowed", amount: 1000, transactionRef: transaction.id, sourceKind: "personFundedExpense", personId: "amma" });
    // 16. Exactly one obligation, no extra cash leg anywhere.
    expect(t.activeEntries("amma")).toHaveLength(1);
    const txns = [...t.store.values()].filter((v) => (v as Transaction).categoryId != null && (v as Transaction).deletedAt == null && "accountId" in (v as object));
    expect(txns).toHaveLength(1);
  });

  it("then settle AMMA through the existing People settlement → payable ₹0; SBI moves only by the repayment, no new My Spend", async () => {
    const t = setup();
    const { entry } = await t.directlyFunded();
    const pay = await t.repay(1000, entry.id);
    expect(t.balanceOf("amma")).toBe(0);
    expect(t.sbi()).toBe(9000);
    expect(pay.transaction.isPersonLedgerMovement).toBe(true);
    expect(t.mySpend(pay.transaction)).toBe(0); // repayment ≠ second spend
  });

  it("6. a stale account can never ride along: person-funded + an account id is refused, nothing written", async () => {
    const t = setup();
    await expect(
      t.transactions.createTransaction({ type: "expense", amount: 1000, dateTime: DATE, accountId: "sbi", categoryId: "food", fundedByPersonId: "amma" }),
    ).rejects.toBeInstanceOf(TransactionFundingMismatchError);
    expect(t.sbi()).toBe(10000);
    // …and an account-funded expense can't be saved without an account.
    await expect(t.transactions.createTransaction({ type: "expense", amount: 1000, dateTime: DATE, accountId: "", categoryId: "food" })).rejects.toBeInstanceOf(TransactionFundingMismatchError);
  });
});

describe("Account-funded vs borrowed cash — the other two events stay separate", () => {
  it("2/3. I paid from SBI → SBI −₹1,000 exactly once, My Spend ₹1,000, no People obligation", async () => {
    const t = setup();
    const tx = await t.sbiExpense();
    expect(t.sbi()).toBe(9000);
    expect(t.mySpend(tx)).toBe(1000);
    expect(t.activeEntries("amma")).toHaveLength(0);
  });

  it("4. borrowed cash received into SBI → SBI +₹1,000, I owe ₹1,000, spend ₹0, income ₹0", async () => {
    const t = setup();
    const { transaction } = await t.ammaLedger.addEntryWithTransaction(
      t.amma(),
      { type: "borrowed", amount: 1000, date: DATE },
      { type: "income", accountId: "sbi", categoryId: "personal-loan" },
      t.transactions,
    );
    expect(t.sbi()).toBe(11000);
    expect(t.balanceOf("amma")).toBe(-1000);
    expect(t.mySpend(transaction)).toBe(0);
    expect(isNonIncomeExpenseMovement(transaction)).toBe(true); // never Income
  });

  it("4b/5. spending that borrowed cash → SBI −₹1,000, My Spend ₹1,000; repaying → SBI −₹1,000, payable ₹0, no extra spend", async () => {
    const t = setup();
    const { entry } = await t.ammaLedger.addEntryWithTransaction(
      t.amma(),
      { type: "borrowed", amount: 1000, date: DATE },
      { type: "income", accountId: "sbi", categoryId: "personal-loan" },
      t.transactions,
    );
    const spend = await t.sbiExpense();
    expect(t.sbi()).toBe(10000);
    expect(t.mySpend(spend)).toBe(1000);
    const pay = await t.repay(1000, entry.id);
    expect(t.sbi()).toBe(9000);
    expect(t.balanceOf("amma")).toBe(0);
    expect(t.mySpend(pay.transaction)).toBe(0);
  });
});

describe("Editing who paid — exactly-once reversal, one obligation", () => {
  it("6. SBI paid → AMMA paid directly: SBI +₹1,000 back once, AMMA payable ₹1,000, My Spend unchanged", async () => {
    const t = setup();
    const tx = await t.sbiExpense();
    await t.ammaLedger.changeExpenseFunding({ transaction: tx, from: null, to: { kind: "person", person: t.amma(), ledger: t.ammaLedger }, transactionRepository: t.transactions });
    const after = t.get<Transaction>(tx.id);
    expect(t.sbi()).toBe(10000);
    expect(t.balanceOf("amma")).toBe(-1000);
    expect(after).toMatchObject({ accountId: PERSON_FUNDED_ACCOUNT_ID, fundedByPersonId: "amma", amount: 1000, deletedAt: null });
    expect(t.mySpend(after)).toBe(1000);
    const entries = t.activeEntries("amma");
    expect(entries).toHaveLength(1);
    expect(entries[0].transactionRef).toBe(tx.id);
  });

  it("7. AMMA paid directly → SBI paid: obligation removed, SBI −₹1,000 exactly once, same transaction", async () => {
    const t = setup();
    const { entry, transaction } = await t.directlyFunded();
    await t.ammaLedger.changeExpenseFunding({
      transaction,
      from: { person: t.amma(), ledger: t.ammaLedger, entry, hasSettlements: false },
      to: { kind: "account", accountId: "sbi" },
      transactionRepository: t.transactions,
    });
    const after = t.get<Transaction>(transaction.id);
    expect(t.sbi()).toBe(9000);
    expect(t.balanceOf("amma")).toBe(0);
    expect(after.fundedByPersonId).toBeNull();
    expect(after.accountId).toBe("sbi");
    expect(t.mySpend(after)).toBe(1000);
    expect(t.activeEntries("amma")).toHaveLength(0); // no orphan obligation
    expect(transactionToFirestore(after)).not.toHaveProperty("fundedByPersonId");
  });

  it("8. round trip SBI → AMMA → SBI moves SBI by exactly −₹1,000 net and leaves no entry behind", async () => {
    const t = setup();
    const tx = await t.sbiExpense();
    await t.ammaLedger.changeExpenseFunding({ transaction: tx, from: null, to: { kind: "person", person: t.amma(), ledger: t.ammaLedger }, transactionRepository: t.transactions });
    const entry = t.activeEntries("amma")[0];
    await t.ammaLedger.changeExpenseFunding({
      transaction: t.get<Transaction>(tx.id),
      from: { person: t.amma(), ledger: t.ammaLedger, entry, hasSettlements: false },
      to: { kind: "account", accountId: "sbi" },
      transactionRepository: t.transactions,
    });
    expect(t.sbi()).toBe(9000);
    expect(t.balanceOf("amma")).toBe(0);
    expect(t.activeEntries("amma")).toHaveLength(0);
  });

  it("9. same person, amount ₹1,000 → ₹1,500: the SAME entry is edited, payable ₹1,500, SBI untouched", async () => {
    const t = setup();
    const { entry, transaction } = await t.directlyFunded();
    await t.ammaLedger.changeExpenseFunding({
      transaction,
      from: { person: t.amma(), ledger: t.ammaLedger, entry, hasSettlements: false },
      to: { kind: "person", person: t.amma(), ledger: t.ammaLedger },
      edits: { amount: 1500 },
      transactionRepository: t.transactions,
    });
    expect(t.get<Transaction>(transaction.id).amount).toBe(1500);
    expect(t.balanceOf("amma")).toBe(-1500);
    expect(t.activeEntries("amma").map((e) => e.id)).toEqual([entry.id]);
    expect(t.sbi()).toBe(10000);
  });

  it("10. AMMA → Tripthee: AMMA's obligation moves to Tripthee, no account moves", async () => {
    const t = setup();
    const { entry, transaction } = await t.directlyFunded();
    const triptheeLedger = t.ledgerFor("tripthee");
    await t.ammaLedger.changeExpenseFunding({
      transaction,
      from: { person: t.amma(), ledger: t.ammaLedger, entry, hasSettlements: false },
      to: { kind: "person", person: t.tripthee(), ledger: triptheeLedger },
      transactionRepository: t.transactions,
    });
    expect(t.balanceOf("amma")).toBe(0);
    expect(t.balanceOf("tripthee")).toBe(-1000);
    expect(t.get<Transaction>(transaction.id).fundedByPersonId).toBe("tripthee");
    expect(t.activeEntries("tripthee")).toHaveLength(1);
    expect(t.sbi()).toBe(10000);
  });

  it("11. refuses to move an obligation away once it has settlements (nothing written)", async () => {
    const t = setup();
    const { entry, transaction } = await t.directlyFunded();
    await expect(
      t.ammaLedger.changeExpenseFunding({
        transaction,
        from: { person: t.amma(), ledger: t.ammaLedger, entry, hasSettlements: true },
        to: { kind: "account", accountId: "sbi" },
        transactionRepository: t.transactions,
      }),
    ).rejects.toThrow(/reverse them/);
    expect(t.sbi()).toBe(10000);
    expect(t.balanceOf("amma")).toBe(-1000);
  });

  it("a stale copy can't double-apply: switching an already-moved expense again is refused", async () => {
    const t = setup();
    const tx = await t.sbiExpense();
    await t.ammaLedger.changeExpenseFunding({ transaction: tx, from: null, to: { kind: "person", person: t.amma(), ledger: t.ammaLedger }, transactionRepository: t.transactions });
    await expect(
      t.ammaLedger.changeExpenseFunding({ transaction: tx, from: null, to: { kind: "person", person: t.amma(), ledger: t.ammaLedger }, transactionRepository: t.transactions }),
    ).rejects.toThrow(/changed since/);
    expect(t.balanceOf("amma")).toBe(-1000);
    expect(t.activeEntries("amma")).toHaveLength(1);
  });
});

describe("Delete / restore", () => {
  it("delete a direct-funded expense from Transactions → expense and obligation gone, SBI ₹0 change", async () => {
    const t = setup();
    const { entry, transaction } = await t.directlyFunded();
    await t.deleteViaTransactions(transaction);
    expect(t.get<Transaction>(transaction.id).deletedAt).not.toBeNull();
    expect(t.get<LedgerEntry>(entry.id).deletedAt).not.toBeNull();
    expect(t.balanceOf("amma")).toBe(0);
    expect(t.sbi()).toBe(10000);
  });

  it("delete an account-funded expense keeps the existing account reversal", async () => {
    const t = setup();
    const tx = await t.sbiExpense();
    await t.transactions.softDeleteTransaction(tx);
    expect(t.sbi()).toBe(10000);
  });

  it("restore → expense and obligation back exactly once (idempotent), SBI unchanged", async () => {
    const t = setup();
    const { entry, transaction } = await t.directlyFunded();
    await t.deleteViaTransactions(transaction);
    await t.ammaLedger.restorePersonFundedExpense(t.amma(), t.get<LedgerEntry>(entry.id), t.transactions);
    await t.ammaLedger.restorePersonFundedExpense(t.amma(), t.get<LedgerEntry>(entry.id), t.transactions);
    expect(t.get<Transaction>(transaction.id).deletedAt).toBeNull();
    expect(t.get<LedgerEntry>(entry.id).deletedAt).toBeNull();
    expect(t.balanceOf("amma")).toBe(-1000);
    expect(t.sbi()).toBe(10000);
  });
});

describe("13/14/15. Month Cycle + Dashboard My Spend, Net Worth — over the whole lifecycle", () => {
  it("a cycle with: direct-funded ₹1,000, borrowed cash ₹1,000, its spend ₹1,000, repayment ₹1,000 → My Spend ₹2,000; SBI net −₹1,000", async () => {
    const t = setup();
    const funded = await t.directlyFunded();
    const borrowed = await t.ammaLedger.addEntryWithTransaction(
      t.amma(),
      { type: "borrowed", amount: 1000, date: DATE },
      { type: "income", accountId: "sbi", categoryId: "personal-loan" },
      t.transactions,
    );
    const spend = await t.sbiExpense();
    const repayment = await t.repay(1000, funded.entry.id);
    const all = [funded.transaction, borrowed.transaction, spend, repayment.transaction].map((x) => t.get<Transaction>(x.id));

    // The same classifier Month Cycle's "My spend" and the Dashboard categories use.
    const rows = mySpendRows({ transactions: all, ctx: buildMySpendContext({ expenses: [] }), bucketDate: (x) => x.dateTime, range: { start: new Date("2026-09-01"), end: new Date("2026-09-30T23:59:59") } });
    const summary = summarizeMySpend(rows);
    expect(summary.mySpend).toBe(2000);
    expect(summary.byCategoryId.get("food")).toBe(2000);
    expect(summary.byCategoryId.has("personal-loan")).toBe(false);
    expect(rows.map((r) => r.transaction.id).sort()).toEqual([funded.transaction.id, spend.id].sort());

    // Net Worth = accounts − what I owe: SBI 10,000 +1,000 −1,000 −1,000 = 9,000; I still owe AMMA the borrowed ₹1,000.
    expect(t.sbi()).toBe(9000);
    expect(t.balanceOf("amma")).toBe(-1000);
    // Income: nothing here is income.
    expect(all.filter((x) => x.type === "income" && !isNonIncomeExpenseMovement(x))).toHaveLength(0);
  });

  it("row label: a direct-funded expense reads 'Paid by AMMA', never 'Unknown account'; account rows unchanged", async () => {
    const t = setup();
    const { transaction } = await t.directlyFunded();
    expect(paidFromLabel(transaction, undefined, new Map([["amma", "AMMA"]]))).toBe("Paid by AMMA");
    expect(paidFromLabel(await t.sbiExpense(), "SBI")).toBe("SBI");
  });
});

describe("Model compatibility", () => {
  const snapshot = (data: Record<string, unknown>) => ({ id: "x", data: () => data }) as never;
  const base = {
    type: "expense",
    amount: 1000,
    dateTime: { toDate: () => DATE },
    accountId: "sbi",
    categoryId: "food",
    createdAt: { toDate: () => DATE },
  };

  it("15. a legacy document (no fundedByPersonId) reads as account-funded and keeps its balance effect", () => {
    const legacy = transactionFromFirestore(snapshot(base));
    expect(legacy.fundedByPersonId).toBeNull();
    expect(balanceEffect(legacy)).toBe(-1000);
    // Written back unchanged: no new key on account-funded documents.
    expect(transactionToFirestore(legacy)).not.toHaveProperty("fundedByPersonId");
  });

  it("a person-funded document round-trips with its funder and no balance effect", () => {
    const funded = transactionFromFirestore(snapshot({ ...base, accountId: "", fundedByPersonId: "amma" }));
    expect(funded.fundedByPersonId).toBe("amma");
    expect(balanceEffect(funded)).toBe(0);
    expect(transactionToFirestore(funded)).toMatchObject({ accountId: "", fundedByPersonId: "amma" });
  });
});
