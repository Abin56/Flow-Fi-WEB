import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Account } from "@/lib/models/account";
import type { Bill } from "@/lib/models/bill";
import type { Expense } from "@/lib/models/expense";
import type { LedgerEntry, Person } from "@/lib/models/person";
import type { Transaction } from "@/lib/models/transaction";
import type { AccountRepository } from "./account-repository";
import type { BillRepository } from "./bill-repository";
import type { ExpenseRepository } from "./expense-repository";
import type { InstallmentRepository, PaymentScheduleRepository } from "./payment-schedule-repository";
import type { LedgerRepository, PersonRepository } from "./person-repository";
import type { TransactionRepository } from "./transaction-repository";

/**
 * Covers the account/credit-card permanent-delete cascade — the replacement for the old
 * "block deletion while anything references the account" behavior. Every dependency is a plain
 * fake object implementing only the methods the cascade actually calls (same style as
 * `expense-repository.partial-failure.test.ts`), so these tests exercise the cascade's own logic
 * (what gets swept up, whose balance gets reversed, what gets left alone) without needing a real
 * Firestore connection for anything beyond the final `writeBatch` commit.
 */
vi.mock("firebase/firestore", () => ({
  collection: vi.fn(),
  getDocs: vi.fn(async () => ({ docs: [] })),
  writeBatch: vi.fn(() => {
    const ops: Array<{ type: "set" | "delete"; ref: unknown; value?: unknown }> = [];
    return {
      set: vi.fn((ref: unknown, value: unknown) => ops.push({ type: "set", ref, value })),
      delete: vi.fn((ref: unknown) => ops.push({ type: "delete", ref })),
      commit: vi.fn(async () => {
        committedOps.push(...ops);
      }),
    };
  }),
}));
vi.mock("@/lib/firebase/client", () => ({ db: {} }));

import { permanentlyDeleteAccountHistory, previewAccountDeletionImpact, type AccountDeletionRepos } from "./account-deletion";

let committedOps: Array<{ type: "set" | "delete"; ref: unknown; value?: unknown }> = [];

function fakeDocRef(id: string) {
  return { id };
}

function transaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: "tx-1",
    type: "expense",
    amount: 100,
    dateTime: new Date("2026-08-01T00:00:00Z"),
    accountId: "acc-del",
    categoryId: "cat-1",
    description: "",
    notes: "",
    receiptPurpose: null,
    transferId: null,
    excludeFromCalculations: false,
    accountingMonth: null,
    linkedPersonId: null,
    owesPersonToggle: false,
    createdAt: new Date("2026-08-01T00:00:00Z"),
    transferMatchedAt: null,
    status: "posted",
    isBusiness: false,
    source: null,
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    ...overrides,
  };
}

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: "acc-survivor",
    name: "Survivor",
    type: "bank",
    openingBalance: 1000,
    currentBalance: 1000,
    colorValue: 0,
    isDefault: false,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    bankId: null,
    accountHolderName: null,
    notes: null,
    accountNumberLast4: null,
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    ...overrides,
  };
}

function person(overrides: Partial<Person> = {}): Person {
  return {
    id: "person-bob",
    name: "Bob",
    phone: null,
    email: null,
    notes: "",
    avatarColorValue: 0,
    openingBalance: 0,
    currentBalance: 100,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    ...overrides,
  };
}

function ledgerEntry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    id: "entry-1",
    personId: "person-bob",
    type: "gave",
    amount: 100,
    date: new Date("2026-08-01T00:00:00Z"),
    note: "Split: Dinner",
    increasesBalance: true,
    transactionRef: "tx-1",
    createdAt: new Date("2026-08-01T00:00:00Z"),
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    ...overrides,
  };
}

function expense(overrides: Partial<Expense> = {}): Expense {
  return {
    id: "expense-1",
    description: "Dinner",
    totalAmount: 100,
    date: new Date("2026-08-01T00:00:00Z"),
    categoryId: "cat-1",
    accountId: "acc-del",
    transactionId: "tx-1",
    splitType: "custom",
    participants: [{ personId: "person-bob", name: "Bob", share: 100, installmentId: null, isMe: false }],
    scheduleId: null,
    notes: "",
    createdAt: new Date("2026-08-01T00:00:00Z"),
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    ...overrides,
  };
}

function bill(overrides: Partial<Bill> = {}): Bill {
  return {
    id: "bill-1",
    name: "Rent",
    amount: 500,
    nextDueDate: new Date("2026-09-01T00:00:00Z"),
    recurrence: "monthly",
    accountId: "acc-del",
    categoryId: null,
    customIntervalDays: null,
    reminderOffsets: [],
    notes: "",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    ...overrides,
  };
}

interface Fixture {
  repos: AccountDeletionRepos;
  billRepo: { getAll: ReturnType<typeof vi.fn>; getTrash: ReturnType<typeof vi.fn>; docRef: ReturnType<typeof vi.fn> };
  accountRepo: { getByKey: ReturnType<typeof vi.fn>; applyBalanceDelta: ReturnType<typeof vi.fn>; docRef: ReturnType<typeof vi.fn> };
  personRepo: { getByKey: ReturnType<typeof vi.fn>; applyBalanceDelta: ReturnType<typeof vi.fn>; docRef: ReturnType<typeof vi.fn> };
  ledgerRepo: {
    getByTransactionRef: ReturnType<typeof vi.fn>;
    getTrashByTransactionRef: ReturnType<typeof vi.fn>;
    docRef: ReturnType<typeof vi.fn>;
  };
}

function makeFixture(params: {
  transactions: Transaction[];
  sibling?: Transaction | null;
  siblingAccount?: Account;
  expenses?: Expense[];
  bills?: Bill[];
  people?: Record<string, Person>;
  ledgerEntriesByPersonAndTx?: Record<string, LedgerEntry[]>;
}): Fixture {
  const { transactions, sibling = null, siblingAccount, expenses = [], bills = [], people = {}, ledgerEntriesByPersonAndTx = {} } = params;

  const transactionRepo = {
    getAllForAccountIncludingTrash: vi.fn(async () => transactions),
    findTransferSibling: vi.fn(async () => sibling),
    docRef: vi.fn((id: string) => fakeDocRef(`tx:${id}`)),
  } as unknown as TransactionRepository;

  const accountRepo = {
    getByKey: vi.fn(async (id: string) => (siblingAccount && siblingAccount.id === id ? siblingAccount : null)),
    applyBalanceDelta: vi.fn((acc: Account, delta: number) => ({ ...acc, currentBalance: acc.currentBalance + delta })),
    docRef: vi.fn((id: string) => fakeDocRef(`acc:${id}`)),
  };

  const billRepo = {
    getAll: vi.fn(async () => bills),
    getTrash: vi.fn(async () => []),
    docRef: vi.fn((id: string) => fakeDocRef(`bill:${id}`)),
  };

  const expenseRepo = {
    getAll: vi.fn(async () => expenses),
    getTrash: vi.fn(async () => []),
    docRef: vi.fn((id: string) => fakeDocRef(`expense:${id}`)),
  } as unknown as ExpenseRepository;

  const personRepo = {
    getByKey: vi.fn(async (id: string) => people[id] ?? null),
    applyBalanceDelta: vi.fn((p: Person, delta: number) => ({ ...p, currentBalance: p.currentBalance + delta })),
    docRef: vi.fn((id: string) => fakeDocRef(`person:${id}`)),
  };

  const ledgerRepo = {
    getByTransactionRef: vi.fn(async (txId: string) =>
      (ledgerEntriesByPersonAndTx[txId] ?? []).filter((e) => e.deletedAt == null),
    ),
    getTrashByTransactionRef: vi.fn(async (txId: string) =>
      (ledgerEntriesByPersonAndTx[txId] ?? []).filter((e) => e.deletedAt != null),
    ),
    docRef: vi.fn((id: string) => fakeDocRef(`ledger:${id}`)),
  };

  const repos: AccountDeletionRepos = {
    uid: "user-1",
    transactionRepository: transactionRepo,
    accountRepository: accountRepo as unknown as AccountRepository,
    billRepository: billRepo as unknown as BillRepository,
    expenseRepository: expenseRepo,
    personRepository: personRepo as unknown as PersonRepository,
    ledgerRepositoryFor: vi.fn(() => ledgerRepo as unknown as LedgerRepository),
    paymentScheduleRepository: { docRef: vi.fn((id: string) => fakeDocRef(`schedule:${id}`)) } as unknown as PaymentScheduleRepository,
    installmentRepositoryFor: vi.fn(
      () =>
        ({
          getAll: vi.fn(async () => []),
          getTrash: vi.fn(async () => []),
          docRef: vi.fn((id: string) => fakeDocRef(`installment:${id}`)),
        }) as unknown as InstallmentRepository,
    ),
  };

  return { repos, billRepo, accountRepo, personRepo, ledgerRepo };
}

describe("previewAccountDeletionImpact", () => {
  it("counts transactions, transfer siblings, expenses, affected people, and bills without writing anything", async () => {
    const tx1 = transaction({ id: "tx-1" });
    const tx2 = transaction({ id: "tx-2", transferId: "xfer-1" });
    const sibling = transaction({ id: "tx-sibling", accountId: "acc-survivor", transferId: "xfer-1", type: "income" });
    const linkedExpense = expense({ transactionId: "tx-1" });
    const linkedBill = bill({ accountId: "acc-del" });

    const { repos } = makeFixture({
      transactions: [tx1, tx2],
      sibling,
      siblingAccount: account(),
      expenses: [linkedExpense],
      bills: [linkedBill],
    });

    const impact = await previewAccountDeletionImpact("acc-del", repos);

    expect(impact).toEqual({
      transactionCount: 2,
      transferSiblingCount: 1,
      expenseCount: 1,
      affectedPersonCount: 1,
      billCount: 1,
    });
  });
});

describe("permanentlyDeleteAccountHistory", () => {
  beforeEach(() => {
    committedOps = [];
  });

  it("deletes every transaction on the account and reverses a transfer sibling's balance on its own surviving account", async () => {
    const tx1 = transaction({ id: "tx-1" });
    const tx2 = transaction({ id: "tx-2", transferId: "xfer-1", type: "expense", amount: 250 });
    const sibling = transaction({ id: "tx-sibling", accountId: "acc-survivor", transferId: "xfer-1", type: "income", amount: 250 });
    const survivor = account({ id: "acc-survivor", currentBalance: 1000 });

    const { repos, accountRepo } = makeFixture({
      transactions: [tx1, tx2],
      sibling,
      siblingAccount: survivor,
    });

    await permanentlyDeleteAccountHistory("acc-del", repos);

    // The sibling's own (surviving) account balance is reversed by exactly its balanceEffect —
    // it was an income leg of +250, so removing it must subtract 250.
    expect(accountRepo.applyBalanceDelta).toHaveBeenCalledWith(survivor, -250);

    const deletedRefs = committedOps.filter((op) => op.type === "delete").map((op) => op.ref);
    expect(deletedRefs).toContainEqual(fakeDocRef("tx:tx-1"));
    expect(deletedRefs).toContainEqual(fakeDocRef("tx:tx-2"));
    expect(deletedRefs).toContainEqual(fakeDocRef("tx:tx-sibling"));

    const setOps = committedOps.filter((op) => op.type === "set");
    expect(setOps).toContainEqual({ type: "set", ref: fakeDocRef("acc:acc-survivor"), value: { ...survivor, currentBalance: 750 } });
  });

  it("reverses and removes a split expense's ledger entries, its schedule/installments, and the expense itself", async () => {
    const tx1 = transaction({ id: "tx-1" });
    const bob = person({ id: "person-bob", currentBalance: 100 });
    const gaveEntry = ledgerEntry({ id: "entry-gave", personId: "person-bob", type: "gave", amount: 100, transactionRef: "tx-1" });
    const linkedExpense = expense({ id: "expense-1", transactionId: "tx-1", scheduleId: "schedule-1" });

    const { repos, personRepo } = makeFixture({
      transactions: [tx1],
      expenses: [linkedExpense],
      people: { "person-bob": bob },
      ledgerEntriesByPersonAndTx: { "tx-1": [gaveEntry] },
    });

    await permanentlyDeleteAccountHistory("acc-del", repos);

    // "gave" moves the person's balance up by its amount, so removing it must apply -100.
    expect(personRepo.applyBalanceDelta).toHaveBeenCalledWith(bob, -100);

    const deletedRefs = committedOps.filter((op) => op.type === "delete").map((op) => op.ref);
    expect(deletedRefs).toContainEqual(fakeDocRef("ledger:entry-gave"));
    expect(deletedRefs).toContainEqual(fakeDocRef("schedule:schedule-1"));
    expect(deletedRefs).toContainEqual(fakeDocRef("expense:expense-1"));
  });

  it("deletes a bill paying from the account (occurrences and payments included)", async () => {
    const tx1 = transaction({ id: "tx-1" });
    const linkedBill = bill({ id: "bill-1", accountId: "acc-del" });
    const { repos } = makeFixture({ transactions: [tx1], bills: [linkedBill] });

    await permanentlyDeleteAccountHistory("acc-del", repos);

    const deletedRefs = committedOps.filter((op) => op.type === "delete").map((op) => op.ref);
    expect(deletedRefs).toContainEqual(fakeDocRef("bill:bill-1"));
  });

  it("leaves an unrelated person's balance and a bill on a different account untouched", async () => {
    const tx1 = transaction({ id: "tx-1" });
    const otherBill = bill({ id: "bill-other", accountId: "acc-other" });
    const { repos, personRepo } = makeFixture({ transactions: [tx1], bills: [otherBill] });

    await permanentlyDeleteAccountHistory("acc-del", repos);

    expect(personRepo.applyBalanceDelta).not.toHaveBeenCalled();
    const deletedRefs = committedOps.filter((op) => op.type === "delete").map((op) => op.ref);
    expect(deletedRefs).not.toContainEqual(fakeDocRef("bill:bill-other"));
  });
});
