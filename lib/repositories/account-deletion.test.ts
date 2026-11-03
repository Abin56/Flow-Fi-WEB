import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Account } from "@/lib/models/account";
import type { Bill } from "@/lib/models/bill";
import type { Expense } from "@/lib/models/expense";
import type { Emi } from "@/lib/models/emi";
import type { Loan } from "@/lib/models/loan";
import type { Installment } from "@/lib/models/payment-schedule";
import type { LedgerEntry, Person } from "@/lib/models/person";
import type { Transaction } from "@/lib/models/transaction";
import type { AccountRepository } from "./account-repository";
import type { BillRepository } from "./bill-repository";
import type { EmiRepository } from "./emi-repository";
import type { ExpenseRepository } from "./expense-repository";
import type { LoanRepository } from "./loan-repository";
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
    loanId: null,
    emiId: null,
    installmentId: null,
    installmentPaymentId: null,
    paymentAllocationType: null,
    isPersonLedgerMovement: false,
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
    bankAccountSubtype: null,
    minimumBalance: null,
    interestRatePercent: null,
    maturityDate: null,
    tenureMonths: null,
    cardSubtype: null,
    cardProvider: null,
    linkedAccountId: null,
    reloadable: null,
    currency: null,
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
    parentEntryId: null,
    createdAt: new Date("2026-08-01T00:00:00Z"),
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    receivedStatus: "yetToReceive",
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
    participants: [{ personId: "person-bob", name: "Bob", share: 100, installmentId: null, isMe: false, receivedStatus: "yetToReceive" }],
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

function loan(overrides: Partial<Loan> = {}): Loan {
  return {
    id: "loan-1",
    name: "Bike loan",
    direction: "taken",
    scheduleId: "schedule-loan-1",
    isClosed: false,
    deletedAt: null,
    ...overrides,
  } as Loan;
}

function emi(overrides: Partial<Emi> = {}): Emi {
  return {
    id: "emi-1",
    name: "Phone EMI",
    scheduleId: "schedule-emi-1",
    isClosed: false,
    deletedAt: null,
    ...overrides,
  } as Emi;
}

function installment(overrides: Partial<Installment> = {}): Installment {
  return {
    id: "inst-1",
    scheduleId: "schedule-loan-1",
    sequenceNumber: 1,
    dueDate: new Date("2026-12-01T00:00:00Z"),
    amountDue: 1000,
    amountPaid: 0,
    isSkipped: false,
    deletedAt: null,
    ...overrides,
  } as Installment;
}

interface Fixture {
  repos: AccountDeletionRepos;
  billRepo: { getAll: ReturnType<typeof vi.fn>; getTrash: ReturnType<typeof vi.fn>; docRef: ReturnType<typeof vi.fn> };
  accountRepo: { getByKey: ReturnType<typeof vi.fn>; applyBalanceDelta: ReturnType<typeof vi.fn>; docRef: ReturnType<typeof vi.fn> };
  personRepo: { getByKey: ReturnType<typeof vi.fn>; applyBalanceDelta: ReturnType<typeof vi.fn>; docRef: ReturnType<typeof vi.fn> };
}

function makeFixture(params: {
  transactions: Transaction[];
  /** Transactions on OTHER accounts (what `getAll` returns besides this account's own). */
  otherTransactions?: Transaction[];
  sibling?: Transaction | null;
  siblingAccount?: Account;
  expenses?: Expense[];
  bills?: Bill[];
  people?: Record<string, Person>;
  ledgerEntries?: LedgerEntry[];
  loans?: Loan[];
  emis?: Emi[];
  installmentsBySchedule?: Record<string, Installment[]>;
  accounts?: Record<string, Account>;
}): Fixture {
  const {
    transactions,
    otherTransactions = [],
    sibling = null,
    siblingAccount,
    expenses = [],
    bills = [],
    people = {},
    ledgerEntries = [],
    loans = [],
    emis = [],
    installmentsBySchedule = {},
    accounts = {},
  } = params;

  const transactionRepo = {
    getAllForAccountIncludingTrash: vi.fn(async () => transactions),
    findTransferSibling: vi.fn(async () => sibling),
    getAll: vi.fn(async () => [...transactions, ...otherTransactions].filter((t) => t.deletedAt == null)),
    getTrash: vi.fn(async () => [...transactions, ...otherTransactions].filter((t) => t.deletedAt != null)),
    docRef: vi.fn((id: string) => fakeDocRef(`tx:${id}`)),
  } as unknown as TransactionRepository;

  const accountRepo = {
    getByKey: vi.fn(async (id: string) => accounts[id] ?? (siblingAccount && siblingAccount.id === id ? siblingAccount : null)),
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
    getAll: vi.fn(async () => Object.values(people).filter((p) => p.deletedAt == null)),
    getTrash: vi.fn(async () => Object.values(people).filter((p) => p.deletedAt != null)),
    applyBalanceDelta: vi.fn((p: Person, delta: number) => ({ ...p, currentBalance: p.currentBalance + delta })),
    docRef: vi.fn((id: string) => fakeDocRef(`person:${id}`)),
  };

  const ledgerRepoFor = (personId: string) => ({
    getAll: vi.fn(async () => ledgerEntries.filter((e) => e.personId === personId && e.deletedAt == null)),
    getTrash: vi.fn(async () => ledgerEntries.filter((e) => e.personId === personId && e.deletedAt != null)),
    docRef: vi.fn((id: string) => fakeDocRef(`ledger:${id}`)),
  });

  const loanRepo = {
    getAll: vi.fn(async () => loans),
    getTrash: vi.fn(async () => []),
    docRef: vi.fn((id: string) => fakeDocRef(`loan:${id}`)),
  };
  const emiRepo = {
    getAll: vi.fn(async () => emis),
    getTrash: vi.fn(async () => []),
    docRef: vi.fn((id: string) => fakeDocRef(`emi:${id}`)),
  };

  const repos: AccountDeletionRepos = {
    uid: "user-1",
    transactionRepository: transactionRepo,
    accountRepository: accountRepo as unknown as AccountRepository,
    billRepository: billRepo as unknown as BillRepository,
    expenseRepository: expenseRepo,
    personRepository: personRepo as unknown as PersonRepository,
    ledgerRepositoryFor: vi.fn((personId: string) => ledgerRepoFor(personId) as unknown as LedgerRepository),
    paymentScheduleRepository: { docRef: vi.fn((id: string) => fakeDocRef(`schedule:${id}`)) } as unknown as PaymentScheduleRepository,
    installmentRepositoryFor: vi.fn(
      (scheduleId: string) =>
        ({
          getAll: vi.fn(async () => installmentsBySchedule[scheduleId] ?? []),
          getTrash: vi.fn(async () => []),
          docRef: vi.fn((id: string) => fakeDocRef(`installment:${id}`)),
        }) as unknown as InstallmentRepository,
    ),
    loanRepository: loanRepo as unknown as LoanRepository,
    emiRepository: emiRepo as unknown as EmiRepository,
  };

  return { repos, billRepo, accountRepo, personRepo };
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
      agreementLoanCount: 0,
      agreementEmiCount: 0,
      agreementLegCount: 0,
      ledgerEntryCount: 0,
      unsettled: [],
    });
  });

  it("warns about an unpaid loan, an unpaid EMI and an unsettled person — and not about closed or fully paid ones", async () => {
    const loanTx = transaction({ id: "tx-loan", loanId: "loan-1" });
    const emiTx = transaction({ id: "tx-emi", emiId: "emi-1" });
    const settledTx = transaction({ id: "tx-settled", loanId: "loan-2" });
    const personTx = transaction({ id: "tx-person", linkedPersonId: "person-bob", isPersonLedgerMovement: true });
    const bob = person({ id: "person-bob", name: "Bob", currentBalance: 750 });
    const { repos } = makeFixture({
      transactions: [loanTx, emiTx, settledTx, personTx],
      loans: [loan({ id: "loan-1", scheduleId: "schedule-loan-1" }), loan({ id: "loan-2", scheduleId: "schedule-loan-2" })],
      emis: [emi({ id: "emi-1", scheduleId: "schedule-emi-1" })],
      installmentsBySchedule: {
        "schedule-loan-1": [installment({ id: "a", amountDue: 1000, amountPaid: 400 }), installment({ id: "b", sequenceNumber: 2 })],
        "schedule-emi-1": [installment({ id: "c", scheduleId: "schedule-emi-1", amountDue: 500 })],
        "schedule-loan-2": [installment({ id: "d", scheduleId: "schedule-loan-2", amountDue: 300, amountPaid: 300 })],
      },
      people: { "person-bob": bob },
      ledgerEntries: [ledgerEntry({ id: "entry-bob", personId: "person-bob", transactionRef: "tx-person" })],
    });

    const impact = await previewAccountDeletionImpact("acc-del", repos);

    expect(impact.agreementLoanCount).toBe(2);
    expect(impact.agreementEmiCount).toBe(1);
    expect(impact.ledgerEntryCount).toBe(1);
    expect(impact.unsettled).toEqual([
      { kind: "loan", name: "Bike loan", amount: 1600, direction: "owedByMe", pendingInstallments: 2 },
      { kind: "emi", name: "Phone EMI", amount: 500, direction: "owedByMe", pendingInstallments: 1 },
      { kind: "person", name: "Bob", amount: 750, direction: "owedToMe" },
    ]);
  });

  it("reports a loan I lent as still owed to me, and nothing for a closed loan", async () => {
    const lentTx = transaction({ id: "tx-lent", loanId: "loan-1" });
    const closedTx = transaction({ id: "tx-closed", loanId: "loan-2" });
    const { repos } = makeFixture({
      transactions: [lentTx, closedTx],
      loans: [
        loan({ id: "loan-1", direction: "given", name: "To Asha" }),
        loan({ id: "loan-2", scheduleId: "schedule-loan-2", isClosed: true }),
      ],
      installmentsBySchedule: {
        "schedule-loan-1": [installment({ amountDue: 900 })],
        "schedule-loan-2": [installment({ id: "x", scheduleId: "schedule-loan-2" })],
      },
    });

    const impact = await previewAccountDeletionImpact("acc-del", repos);

    expect(impact.unsettled).toEqual([
      { kind: "loan", name: "To Asha", amount: 900, direction: "owedToMe", pendingInstallments: 1 },
    ]);
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
      ledgerEntries: [gaveEntry],
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

  it("sweeps a person's ledger entry from a plain person payment (no expense), reversing the balance once", async () => {
    const tx = transaction({ id: "tx-pay", linkedPersonId: "person-bob", isPersonLedgerMovement: true });
    const bob = person({ id: "person-bob", currentBalance: 300 });
    const borrowed = ledgerEntry({ id: "entry-b", type: "borrowed", amount: 300, transactionRef: "tx-pay" });
    const unrelated = ledgerEntry({ id: "entry-keep", type: "gave", amount: 50, transactionRef: "tx-other" });
    const { repos, personRepo } = makeFixture({
      transactions: [tx],
      people: { "person-bob": bob },
      ledgerEntries: [borrowed, unrelated],
    });

    await permanentlyDeleteAccountHistory("acc-del", repos);

    // "borrowed" moved the balance by -300, so removing it applies +300.
    expect(personRepo.applyBalanceDelta).toHaveBeenCalledTimes(1);
    expect(personRepo.applyBalanceDelta).toHaveBeenCalledWith(bob, 300);
    const deletedRefs = committedOps.filter((op) => op.type === "delete").map((op) => op.ref);
    expect(deletedRefs).toContainEqual(fakeDocRef("ledger:entry-b"));
    expect(deletedRefs).not.toContainEqual(fakeDocRef("ledger:entry-keep"));
  });

  it("deletes a loan and an EMI with their installments and schedules, and sweeps ledger entries settling them", async () => {
    const loanTx = transaction({ id: "tx-loan", loanId: "loan-1" });
    const emiTx = transaction({ id: "tx-emi", emiId: "emi-1" });
    const bob = person({ id: "person-bob", currentBalance: 0 });
    const share = ledgerEntry({
      id: "entry-share",
      personId: "person-bob",
      type: "repaid",
      amount: 200,
      transactionRef: null,
      obligationRef: "emi-inst:inst-emi",
    });
    const { repos } = makeFixture({
      transactions: [loanTx, emiTx],
      loans: [loan({ id: "loan-1", scheduleId: "schedule-loan-1" })],
      emis: [emi({ id: "emi-1", scheduleId: "schedule-emi-1" })],
      installmentsBySchedule: {
        "schedule-loan-1": [installment({ id: "inst-loan" })],
        "schedule-emi-1": [installment({ id: "inst-emi", scheduleId: "schedule-emi-1" })],
      },
      people: { "person-bob": bob },
      ledgerEntries: [share],
    });

    await permanentlyDeleteAccountHistory("acc-del", repos);

    const deletedRefs = committedOps.filter((op) => op.type === "delete").map((op) => op.ref);
    for (const id of ["loan:loan-1", "schedule:schedule-loan-1", "installment:inst-loan", "emi:emi-1", "schedule:schedule-emi-1", "installment:inst-emi", "ledger:entry-share"]) {
      expect(deletedRefs).toContainEqual(fakeDocRef(id));
    }
  });

  it("removes a loan's payment leg posted on another account and corrects that account's balance", async () => {
    const ownLeg = transaction({ id: "tx-own", loanId: "loan-1" });
    const otherLeg = transaction({ id: "tx-other-leg", accountId: "acc-survivor", loanId: "loan-1", type: "expense", amount: 400 });
    const survivor = account({ id: "acc-survivor", currentBalance: 600 });
    const { repos, accountRepo } = makeFixture({
      transactions: [ownLeg],
      otherTransactions: [otherLeg],
      loans: [loan({ id: "loan-1" })],
      installmentsBySchedule: { "schedule-loan-1": [installment()] },
      accounts: { "acc-survivor": survivor },
    });

    const impact = await previewAccountDeletionImpact("acc-del", repos);
    expect(impact.agreementLegCount).toBe(1);

    await permanentlyDeleteAccountHistory("acc-del", repos);

    // The expense leg took 400 out of the survivor; removing it gives 400 back.
    expect(accountRepo.applyBalanceDelta).toHaveBeenCalledWith(survivor, 400);
    const deletedRefs = committedOps.filter((op) => op.type === "delete").map((op) => op.ref);
    expect(deletedRefs).toContainEqual(fakeDocRef("tx:tx-other-leg"));
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
