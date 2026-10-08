import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Account } from "@/lib/models/account";
import { myShare, type Expense } from "@/lib/models/expense";
import type { Installment } from "@/lib/models/payment-schedule";
import { signedAmount, type LedgerEntry, type Person } from "@/lib/models/person";
import type { Transaction } from "@/lib/models/transaction";
import { buildMySpendContext, myConsumptionAmount } from "@/lib/engines/my-spend";
import { personBalanceBreakdown, personDirectGross, personPosition, peopleDirectGross, peopleDirectionSides } from "@/lib/engines/person-position";
import { personDebtPosition } from "@/lib/engines/debt-position";
import { buildPersonCycleStatement, cycleContaining } from "@/lib/engines/person-cycle-statement";
import { derivePendingSplitParticipants } from "@/lib/engines/person-pending-split-participants";
import { classifySplitGhost } from "@/lib/engines/split-ghost-repair";
import { buildLedgerRows } from "@/features/people/lib/person-ledger-rows";
import { payableObligations } from "@/features/people/lib/person-payment-obligations";
import { deletePersonCashLegTransaction } from "@/lib/services/person-cash-leg-deletion";
import { deleteTransactionWithLinkedEffects } from "@/lib/services/transaction-deletion";
import { repairSplitGhost } from "@/lib/services/split-ghost-repair";
import { AccountRepository } from "./account-repository";
import { TransactionRepository } from "./transaction-repository";
import { ExpenseRepository, ReceivedWithoutCashError } from "./expense-repository";
import { LedgerRepository, PersonRepository } from "./person-repository";
import { InstallmentPaymentRepository, InstallmentRepository, PaymentScheduleRepository } from "./payment-schedule-repository";

/**
 * Transaction ↔ People lifecycle hardening:
 *  A. a Split Expense is all-or-nothing — a failure after ANY write leaves zero partial financial state;
 *  B. historical split ghosts (Expense alive, Transaction deleted alone) are repaired only when no payment
 *     history exists, idempotently; otherwise blocked with diagnostics;
 *  C. one obligation, read through every consumer engine (People, Record Payment, Month Cycle, Net Worth,
 *     Debt Planner, Statement, My Spend), agrees across create / settle / delete / restore.
 * Real repositories over an in-memory fake of the modular Firestore API (same style as
 * `expense-repository.split-ledger.test.ts`). No engine is changed for these tests.
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
  const getDoc = async (ref: { __collectionPath: string; id: string }) => {
    const entry = docs.get(keyOf(ref.__collectionPath, ref.id));
    return { exists: () => entry !== undefined, data: () => entry?.data, id: ref.id };
  };
  const setDoc = async (ref: { __collectionPath: string; id: string }, value: unknown) => {
    docs.set(keyOf(ref.__collectionPath, ref.id), { id: ref.id, collectionPath: ref.__collectionPath, data: value });
  };
  const query = (coll: { __collectionPath: string }, ...clauses: unknown[]) => ({ __collectionPath: coll.__collectionPath, __clauses: clauses });
  const where = (field: string, op: string, value: unknown) => ({ field, op, value });
  const getDocs = async (q: { __collectionPath: string; __clauses?: { field: string; op: string; value: unknown }[] }) => {
    const filtered = [...docs.values()]
      .filter((d) => d.collectionPath === q.__collectionPath)
      .filter((d) =>
        (q.__clauses ?? []).every((c) => {
          const value = (d.data as Record<string, unknown>)[c.field];
          if (c.op === "==") return value === c.value;
          if (c.op === "!=") return value !== c.value;
          return true;
        }),
      );
    return { docs: filtered.map((d) => ({ id: d.id, data: () => d.data })) };
  };
  const runTransaction = async (_db: unknown, updateFn: (tx: unknown) => Promise<unknown>) => {
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
    const result = await updateFn(tx); // throws → nothing commits, like Firestore
    for (const [key, value] of pending) {
      const cut = key.lastIndexOf("/");
      docs.set(key, { id: key.slice(cut + 1), collectionPath: key.slice(0, cut), data: value });
    }
    return result;
  };
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
  Timestamp: { fromDate: (d: Date) => ({ toDate: () => d }) },
}));

const NOW = new Date();
const DATE = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate(), 10);
const NO_LOANS: ReadonlySet<string> = new Set();

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
  const installmentPaymentRepositoryFor = (scheduleId: string, installmentId: string) =>
    new InstallmentPaymentRepository(
      fake.collection(["paymentSchedules", scheduleId, "installments", installmentId, "payments"]) as never,
      installmentRepositoryFor(scheduleId),
    );
  const linkedDelete = (t: Transaction, expense?: Expense | null) =>
    deleteTransactionWithLinkedEffects(
      t,
      {
        transactionRepository,
        findExpense: async (id) => (await expenseRepository.getAll()).find((e) => e.transactionId === id) ?? null,
        deleteExpense: (e) => expenseRepository.deleteExpense(e),
        deletePersonLinked: (txn) => deletePersonCashLegTransaction({ transaction: txn, transactionRepository, personRepository, ledgerRepositoryFor }),
      },
      expense,
    );
  const repairGhost = (expenseId: string) =>
    repairSplitGhost(expenseId, {
      getExpense: (id) => expenseRepository.getByKey(id),
      getTransaction: (id) => transactionRepository.getByKey(id),
      installmentsFor: (scheduleId) => installmentRepositoryFor(scheduleId).getAll(),
      ledgerEntriesFor: (personId) => ledgerRepositoryFor(personId).getAll(),
      deleteExpense: (e) => expenseRepository.deleteExpense(e),
    });
  return {
    accountRepository,
    transactionRepository,
    personRepository,
    paymentScheduleRepository,
    expenseRepository,
    installmentRepositoryFor,
    ledgerRepositoryFor,
    installmentPaymentRepositoryFor,
    linkedDelete,
    repairGhost,
  };
}

async function seed() {
  const sbi = { id: "sbi", name: "SBI", type: "bank", openingBalance: 10000, currentBalance: 10000, deletedAt: null, lastEditedAt: null, editHistory: [] } as unknown as Account;
  await fake.setDoc({ __collectionPath: "accounts", id: "sbi" }, sbi);
  await fake.setDoc({ __collectionPath: "people", id: "amma" }, person("amma", "AMMA"));
  await fake.setDoc({ __collectionPath: "people", id: "tripthee" }, person("tripthee", "TRIPTHEE"));
}

// ---------- store readers ----------
const inCollection = <T,>(pred: (path: string) => boolean) => [...fake.docs.values()].filter((d) => pred(d.collectionPath)).map((d) => d.data as T);
const isActive = (v: { deletedAt?: Date | null }) => v.deletedAt == null;
const sbiBalance = () => inCollection<Account>((p) => p === "accounts").find((a) => a.id === "sbi")!.currentBalance;
const people = () => inCollection<Person>((p) => p === "people");
const balanceOf = (id: string) => people().find((p) => p.id === id)!.currentBalance;
const entriesOf = (personId: string) => inCollection<LedgerEntry>((p) => p === `people/${personId}/ledger`);
const activeTransactions = () => inCollection<Transaction>((p) => p === "transactions").filter(isActive);
const expenses = () => inCollection<Expense>((p) => p === "expenses");
const activeExpenses = () => expenses().filter(isActive);
const activeSchedules = () => inCollection<{ deletedAt: Date | null }>((p) => p === "paymentSchedules").filter(isActive);
const installmentsBySchedule = () => {
  const out: Record<string, Installment[]> = {};
  for (const i of inCollection<Installment>((p) => /^paymentSchedules\/[^/]+\/installments$/.test(p))) (out[i.scheduleId] ??= []).push(i);
  return out;
};
const activeInstallments = () => Object.values(installmentsBySchedule()).flat().filter(isActive);
const activeLedgerEntries = () => inCollection<LedgerEntry>((p) => /^people\/[^/]+\/ledger$/.test(p)).filter(isActive);

/** Every consumer engine's reading of the current state — the same inputs the hooks pass them. */
function consumers() {
  const allExpenses = expenses();
  const ctx = buildMySpendContext({ expenses: allExpenses.map((e) => ({ transactionId: e.transactionId, totalAmount: e.totalAmount, myShare: myShare(e), deletedAt: e.deletedAt })) });
  const mySpend = inCollection<Transaction>((p) => p === "transactions").reduce((s, t) => s + myConsumptionAmount(t, ctx), 0);
  const byPerson = people()
    .filter(isActive)
    .map((p) => {
      const entries = entriesOf(p.id);
      const position = personPosition({
        personId: p.id,
        currentBalance: p.currentBalance,
        loans: [],
        ledgerEntries: entries.map((e) => ({ transactionRef: e.transactionRef, signedAmount: signedAmount(e), isDeleted: e.deletedAt != null })),
        loanIds: NO_LOANS,
      });
      const breakdownEntries = entries.map((e) => ({ id: e.id, type: e.type, amount: e.amount, parentEntryId: e.parentEntryId, transactionRef: e.transactionRef, isDeleted: e.deletedAt != null }));
      const breakdown = personBalanceBreakdown(position, breakdownEntries, NO_LOANS);
      const gross = personDirectGross(position, breakdownEntries, NO_LOANS);
      const debt = personDebtPosition({ personId: p.id, name: p.name, directBalance: position.directBalance, emiReceivable: 0, loanReceivable: 0, loanPayable: 0, directToGive: gross.payable, directToReceive: gross.receivable });
      const statement = buildPersonCycleStatement({
        person: { id: p.id, name: p.name, openingBalance: 0, createdAt: p.createdAt },
        ledgerEntries: entries,
        loanIds: NO_LOANS,
        emis: [],
        loans: [],
        installments: [],
        cycle: cycleContaining(DATE),
        now: NOW,
      });
      const pending = derivePendingSplitParticipants(p.id, activeExpenses(), installmentsBySchedule());
      const obligations = payableObligations(buildLedgerRows({ statement, entries, pending, now: NOW }));
      const recordPayment = {
        theyOwe: obligations.filter((o) => o.side === "theyOwe").reduce((s, o) => s + o.outstanding, 0),
        iOwe: obligations.filter((o) => o.side === "iOwe").reduce((s, o) => s + o.outstanding, 0),
      };
      return { id: p.id, position, entries: breakdownEntries, breakdown, debt: debt?.outstanding ?? 0, statement, recordPayment };
    });
  const view = (id: string) => {
    const v = byPerson.find((x) => x.id === id)!;
    return {
      peopleToReceive: v.breakdown.toReceive,
      peopleToGive: v.breakdown.toGive,
      statementToReceive: v.statement.toReceive,
      statementToGive: v.statement.toGive,
      recordPaymentTheyOwe: v.recordPayment.theyOwe,
      recordPaymentIOwe: v.recordPayment.iOwe,
      debtPlanner: v.debt,
    };
  };
  const netWorth = peopleDirectGross(byPerson.map((v) => ({ position: v.position, entries: v.entries })), NO_LOANS);
  const monthCycle = peopleDirectionSides(byPerson.map((v) => ({ id: v.id, breakdown: v.breakdown })));
  return { mySpend, sbi: sbiBalance(), view, netWorth, monthCycle: { toGive: monthCycle.totalToGive, toReceive: monthCycle.totalToReceive } };
}

/** "they owe me R / I owe G" as every People consumer must see it. */
function expectPerson(id: string, toReceive: number, toGive: number) {
  const c = consumers().view(id);
  expect(c).toEqual({
    peopleToReceive: toReceive,
    peopleToGive: toGive,
    statementToReceive: toReceive,
    statementToGive: toGive,
    recordPaymentTheyOwe: toReceive,
    recordPaymentIOwe: toGive,
    debtPlanner: toGive,
  });
}

const SPLIT_3000 = {
  description: "Trip dinner",
  totalAmount: 3000,
  date: DATE,
  categoryId: "food",
  accountId: "sbi",
  splitType: "custom" as const,
  participantInputs: [
    { name: "Me", isMe: true, value: 1000 },
    { name: "AMMA", personId: "amma", value: 1000 },
    { name: "TRIPTHEE", personId: "tripthee", value: 1000 },
  ],
};

beforeEach(async () => {
  fake.docs.clear();
  vi.restoreAllMocks();
  await seed();
});

// ====================================================================================================
// A. Split creation is financially atomic
// ====================================================================================================

/** Zero partial financial state — exactly the state before the split was attempted. */
function expectUntouched() {
  expect(sbiBalance()).toBe(10000);
  expect(balanceOf("amma")).toBe(0);
  expect(balanceOf("tripthee")).toBe(0);
  expect(activeTransactions()).toHaveLength(0);
  expect(activeExpenses()).toHaveLength(0);
  expect(activeLedgerEntries()).toHaveLength(0);
  expect(activeInstallments()).toHaveLength(0);
  expect(activeSchedules()).toHaveLength(0);
  expect(people().filter(isActive).map((p) => p.id).sort()).toEqual(["amma", "tripthee"]);
  const c = consumers();
  expect(c.mySpend).toBe(0);
  expect(c.monthCycle).toEqual({ toGive: 0, toReceive: 0 });
  expect(c.netWorth).toMatchObject({ receivable: 0, payable: 0 });
}

const boom = () => new Error("injected failure");

/** Lets the first `n` calls through, then fails. */
function failAfter<T extends object, K extends keyof T>(target: T, method: K, n: number) {
  const original = target[method] as unknown as (...a: unknown[]) => Promise<unknown>;
  let calls = 0;
  return vi.spyOn(target, method as never).mockImplementation((async function (this: unknown, ...args: unknown[]) {
    calls += 1;
    if (calls > n) throw boom();
    return original.apply(this, args);
  }) as never);
}

describe("A. Split creation — failure after every stage leaves zero partial state", () => {
  it("baseline: a successful ₹3,000 split writes everything once", async () => {
    const { expenseRepository } = buildRepos();
    await expenseRepository.createExpense(SPLIT_3000);
    expect(sbiBalance()).toBe(7000);
    expect(balanceOf("amma")).toBe(1000);
    expect(balanceOf("tripthee")).toBe(1000);
    expect(activeExpenses()).toHaveLength(1);
    expect(activeLedgerEntries()).toHaveLength(2);
    expect(activeInstallments()).toHaveLength(2);
  });

  it("fails before the Transaction is created", async () => {
    const { expenseRepository, transactionRepository } = buildRepos();
    vi.spyOn(transactionRepository, "createTransaction").mockRejectedValue(boom());
    await expect(expenseRepository.createExpense(SPLIT_3000)).rejects.toThrow("injected failure");
    expectUntouched();
  });

  it("fails while moving the account balance (inside the Transaction write)", async () => {
    const { expenseRepository, accountRepository } = buildRepos();
    vi.spyOn(accountRepository, "applyBalanceDelta").mockImplementation(() => {
      throw boom();
    });
    await expect(expenseRepository.createExpense(SPLIT_3000)).rejects.toThrow("injected failure");
    expectUntouched();
  });

  it("fails right after the Transaction (schedule creation)", async () => {
    const { expenseRepository, paymentScheduleRepository } = buildRepos();
    vi.spyOn(paymentScheduleRepository, "createSchedule").mockRejectedValue(boom());
    await expect(expenseRepository.createExpense(SPLIT_3000)).rejects.toThrow("injected failure");
    expectUntouched();
  });

  it("fails part-way through installment creation (one installment already written)", async () => {
    const { expenseRepository } = buildRepos();
    failAfter(InstallmentRepository.prototype, "add", 1);
    await expect(expenseRepository.createExpense(SPLIT_3000)).rejects.toThrow("injected failure");
    vi.restoreAllMocks();
    expectUntouched();
  });

  it("fails after the first People share (AMMA posted, TRIPTHEE not)", async () => {
    const { expenseRepository } = buildRepos();
    failAfter(LedgerRepository.prototype, "addEntry", 1);
    await expect(expenseRepository.createExpense(SPLIT_3000)).rejects.toThrow("injected failure");
    vi.restoreAllMocks();
    expectUntouched();
  });

  it("a share 'received at the table' with no money recorded is refused before anything is written", async () => {
    const { expenseRepository } = buildRepos();
    const input = { ...SPLIT_3000, participantInputs: SPLIT_3000.participantInputs.map((p) => (p.personId === "amma" ? { ...p, receivedStatus: "received" as const } : p)) };
    await expect(expenseRepository.createExpense(input)).rejects.toBeInstanceOf(ReceivedWithoutCashError);
    expectUntouched();
  });

  it("fails after the Expense document lands (immediately before completion)", async () => {
    const { expenseRepository } = buildRepos();
    const original = expenseRepository.add.bind(expenseRepository);
    vi.spyOn(expenseRepository, "add").mockImplementation(async (id, value) => {
      await original(id, value);
      throw boom();
    });
    await expect(expenseRepository.createExpense(SPLIT_3000)).rejects.toThrow("injected failure");
    vi.restoreAllMocks();
    expectUntouched();
  });

  it("a person auto-created for this split (custom name) is not left behind", async () => {
    const { expenseRepository } = buildRepos();
    failAfter(LedgerRepository.prototype, "addEntry", 1); // Priya's Person exists, her share fails
    const input = { ...SPLIT_3000, participantInputs: [...SPLIT_3000.participantInputs.slice(0, 2), { name: "Priya", value: 1000 }] };
    await expect(expenseRepository.createExpense(input as never)).rejects.toThrow("injected failure");
    vi.restoreAllMocks();
    expectUntouched();
  });

  it("convertToSplit failing after a share undoes the share and keeps the pre-existing Transaction untouched", async () => {
    const { expenseRepository, transactionRepository } = buildRepos();
    const tx = await transactionRepository.createTransaction({ type: "expense", amount: 3000, dateTime: DATE, accountId: "sbi", categoryId: "food" });
    failAfter(LedgerRepository.prototype, "addEntry", 1);
    await expect(
      expenseRepository.convertToSplit({ existingExpense: null, transactionId: tx.id, description: "Trip dinner", totalAmount: 3000, date: DATE, categoryId: "food", accountId: "sbi", notes: "", splitType: "custom", participantInputs: SPLIT_3000.participantInputs }),
    ).rejects.toThrow("injected failure");
    vi.restoreAllMocks();
    expect(sbiBalance()).toBe(7000); // the plain expense itself stays, exactly as before the conversion
    expect(activeTransactions().map((t) => t.id)).toEqual([tx.id]);
    expect(activeExpenses()).toHaveLength(0);
    expect(activeLedgerEntries()).toHaveLength(0);
    expect(activeInstallments()).toHaveLength(0);
    expect(balanceOf("amma")).toBe(0);
  });

  it("no duplicate on retry: a failed attempt then a successful one = exactly one split", async () => {
    const { expenseRepository } = buildRepos();
    failAfter(LedgerRepository.prototype, "addEntry", 1);
    await expect(expenseRepository.createExpense(SPLIT_3000)).rejects.toThrow();
    vi.restoreAllMocks();
    await expenseRepository.createExpense(SPLIT_3000);
    expect(sbiBalance()).toBe(7000);
    expect(balanceOf("amma")).toBe(1000);
    expect(activeLedgerEntries()).toHaveLength(2);
    expect(activeTransactions()).toHaveLength(1);
  });
});

// ====================================================================================================
// B. Historical split ghosts
// ====================================================================================================

/** The old Transaction Studio bug: only the Transaction was soft-deleted; Expense + shares survived. */
async function splitGhost() {
  const repos = buildRepos();
  const expense = await repos.expenseRepository.createExpense(SPLIT_3000);
  const tx = (await repos.transactionRepository.getByKey(expense.transactionId))!;
  await repos.transactionRepository.softDeleteTransaction(tx);
  return { ...repos, expense };
}

describe("B. Historical split ghosts", () => {
  it("is detected and repaired through deleteExpense: AMMA/TRIPTHEE ₹0, SBI not reversed twice", async () => {
    const { expense, repairGhost } = await splitGhost();
    expect(sbiBalance()).toBe(10000);
    expect(balanceOf("amma")).toBe(1000); // the ghost

    const verdict = await repairGhost(expense.id);
    expect(verdict.kind).toBe("repair");
    expect(sbiBalance()).toBe(10000);
    expect(balanceOf("amma")).toBe(0);
    expect(balanceOf("tripthee")).toBe(0);
    expect(activeExpenses()).toHaveLength(0);
    expect(activeLedgerEntries()).toHaveLength(0);
    expect(activeInstallments()).toHaveLength(0);
    expect(activeSchedules()).toHaveLength(0);
  });

  it("is idempotent: 1, 2 and 10 runs give the same final state", async () => {
    const { expense, repairGhost } = await splitGhost();
    const states: string[] = [];
    const snapshot = () => JSON.stringify({ sbi: sbiBalance(), amma: balanceOf("amma"), tripthee: balanceOf("tripthee"), e: activeExpenses().length, l: activeLedgerEntries().length });
    await repairGhost(expense.id);
    states.push(snapshot());
    await repairGhost(expense.id);
    states.push(snapshot());
    for (let i = 0; i < 8; i++) await repairGhost(expense.id);
    states.push(snapshot());
    expect(new Set(states).size).toBe(1);
    expect(await repairGhost(expense.id)).toEqual({ kind: "notGhost" });
  });

  it("a missing (hard-deleted) Transaction is a ghost too — Expense.transactionId always names a Transaction", async () => {
    const { expense, repairGhost } = await splitGhost();
    fake.docs.delete(`transactions/${expense.transactionId}`);
    expect((await repairGhost(expense.id)).kind).toBe("repair");
    expect(balanceOf("amma")).toBe(0);
  });

  it("a healthy split is never touched", async () => {
    const { expenseRepository, repairGhost } = buildRepos();
    const expense = await expenseRepository.createExpense(SPLIT_3000);
    expect(await repairGhost(expense.id)).toEqual({ kind: "notGhost" });
    expect(balanceOf("amma")).toBe(1000);
    expect(sbiBalance()).toBe(7000);
  });

  it("BLOCKED: a partial settlement exists → nothing deleted, diagnostics name person, share and payment", async () => {
    const { expenseRepository, transactionRepository, installmentRepositoryFor, installmentPaymentRepositoryFor, repairGhost } = buildRepos();
    const expense = await expenseRepository.createExpense(SPLIT_3000);
    const amma = expense.participants.find((p) => p.personId === "amma")!;
    const installment = (await installmentRepositoryFor(expense.scheduleId!).getByKey(amma.installmentId!))!;
    await expenseRepository.settleParticipant({ expense, participant: amma, installment, installmentPaymentRepository: installmentPaymentRepositoryFor(expense.scheduleId!, installment.id), amount: 400, date: DATE });
    await transactionRepository.softDeleteTransaction((await transactionRepository.getByKey(expense.transactionId))!);
    const before = { amma: balanceOf("amma"), tripthee: balanceOf("tripthee"), entries: activeLedgerEntries().length };

    const verdict = await repairGhost(expense.id);
    expect(verdict.kind).toBe("blocked");
    if (verdict.kind !== "blocked") return;
    expect(verdict.reason).toBe("paymentHistory");
    expect(verdict.diagnostics).toHaveLength(1);
    expect(verdict.diagnostics[0]).toMatchObject({ personId: "amma", personName: "AMMA", amount: 1000, expenseId: expense.id, transactionId: expense.transactionId });
    expect(verdict.diagnostics[0].dependentPayments.map((p) => p.kind).sort()).toEqual(["installmentPayment", "receivedAtSplit"]);
    expect({ amma: balanceOf("amma"), tripthee: balanceOf("tripthee"), entries: activeLedgerEntries().length }).toEqual(before);
    expect(activeExpenses()).toHaveLength(1);
  });

  it("BLOCKED: (legacy) cash 'received at the table' at split time counts as payment history", async () => {
    const { expenseRepository, transactionRepository, repairGhost, personRepository, ledgerRepositoryFor } = buildRepos();
    const expense = await expenseRepository.createExpense(SPLIT_3000);
    // Legacy data: what the pre-guard "received at the table" flag wrote for TRIPTHEE.
    const tripthee = expense.participants.find((p) => p.personId === "tripthee")!;
    await ledgerRepositoryFor("tripthee").addEntry((await personRepository.getByKey("tripthee"))!, {
      type: "receivedBack",
      amount: tripthee.share,
      date: expense.date,
      note: `Received: ${expense.description}`,
      transactionRef: expense.transactionId,
      receivedStatus: "received",
    });
    await expenseRepository.update({ ...expense, participants: expense.participants.map((p) => (p.personId === "tripthee" ? { ...p, receivedStatus: "received" as const } : p)) });
    await transactionRepository.softDeleteTransaction((await transactionRepository.getByKey(expense.transactionId))!);
    const verdict = await repairGhost(expense.id);
    expect(verdict.kind).toBe("blocked");
    expect(activeLedgerEntries()).toHaveLength(3);
  });

  it("classifier: an unknown (not yet loaded) transaction proves nothing", () => {
    const expense = { id: "e", transactionId: "t", scheduleId: null, participants: [], deletedAt: null } as unknown as Expense;
    expect(classifySplitGhost({ expense, transaction: undefined, installments: [], entriesByPersonId: {} })).toEqual({ kind: "notGhost" });
  });

  it("deleting the ghost's Transaction alone can no longer happen: the linked delete takes the whole split", async () => {
    const { expenseRepository, transactionRepository, linkedDelete } = buildRepos();
    const expense = await expenseRepository.createExpense(SPLIT_3000);
    await linkedDelete((await transactionRepository.getByKey(expense.transactionId))!); // no expense passed — looked up
    expect(activeExpenses()).toHaveLength(0);
    expect(balanceOf("amma")).toBe(0);
    expect(sbiBalance()).toBe(10000);
  });
});

// ====================================================================================================
// C. Cross-feature proof — every consumer agrees
// ====================================================================================================

describe("C1. Person-funded ₹1,000 — AMMA paid my expense directly", () => {
  it("create → delete → restore: every consumer agrees at each step", async () => {
    const { ledgerRepositoryFor, personRepository, transactionRepository, linkedDelete } = buildRepos();
    const amma = (await personRepository.getByKey("amma"))!;
    const ledger = ledgerRepositoryFor("amma");
    const { entry, transaction } = await ledger.createPersonFundedExpense(amma, { amount: 1000, date: DATE, categoryId: "education", description: "Exam" }, transactionRepository);

    let c = consumers();
    expect(c.mySpend).toBe(1000);
    expect(c.sbi).toBe(10000); // my account movement ₹0
    expectPerson("amma", 0, 1000);
    expect(c.netWorth).toMatchObject({ receivable: 0, payable: 1000 });
    expect(c.monthCycle).toEqual({ toGive: 1000, toReceive: 0 });
    expect(activeTransactions().map((t) => t.id)).toEqual([transaction.id]); // Transactions list

    await linkedDelete((await transactionRepository.getByKey(transaction.id))!);
    c = consumers();
    expect(c.mySpend).toBe(0);
    expect(c.sbi).toBe(10000);
    expectPerson("amma", 0, 0);
    expect(c.netWorth).toMatchObject({ receivable: 0, payable: 0 });
    expect(c.monthCycle).toEqual({ toGive: 0, toReceive: 0 });
    expect(activeTransactions()).toHaveLength(0);

    await ledger.restorePersonFundedExpense((await personRepository.getByKey("amma"))!, (await ledger.getByKey(entry.id))!, transactionRepository);
    await ledger.restorePersonFundedExpense((await personRepository.getByKey("amma"))!, (await ledger.getByKey(entry.id))!, transactionRepository);
    c = consumers();
    expect(c.mySpend).toBe(1000);
    expectPerson("amma", 0, 1000); // exactly once
    expect(c.netWorth).toMatchObject({ receivable: 0, payable: 1000 });
    expect(activeLedgerEntries()).toHaveLength(1);
  });
});

describe("C2. ₹3,000 split from SBI — me / AMMA / TRIPTHEE ₹1,000 each", () => {
  async function settle(expense: Expense, personId: string, amount: number) {
    const { expenseRepository, installmentRepositoryFor, installmentPaymentRepositoryFor } = buildRepos();
    const fresh = (await expenseRepository.getByKey(expense.id))!;
    const participant = fresh.participants.find((p) => p.personId === personId)!;
    const installment = (await installmentRepositoryFor(fresh.scheduleId!).getByKey(participant.installmentId!))!;
    await expenseRepository.settleParticipant({ expense: fresh, participant, installment, installmentPaymentRepository: installmentPaymentRepositoryFor(fresh.scheduleId!, installment.id), amount, date: DATE });
  }

  it("create → partial → full settlement → delete → restore: every consumer agrees, nothing double-counted", async () => {
    const { expenseRepository } = buildRepos();
    const expense = await expenseRepository.createExpense(SPLIT_3000);

    let c = consumers();
    expect(c.sbi).toBe(7000);
    expect(c.mySpend).toBe(1000);
    expectPerson("amma", 1000, 0);
    expectPerson("tripthee", 1000, 0);
    expect(c.netWorth).toMatchObject({ receivable: 2000, payable: 0 });
    expect(c.monthCycle).toEqual({ toGive: 0, toReceive: 2000 });

    await settle(expense, "amma", 400); // partial
    c = consumers();
    expectPerson("amma", 600, 0);
    expect(c.netWorth.receivable).toBe(1600);
    expect(c.sbi).toBe(7000); // settlement tracking moves no account here
    expect(c.mySpend).toBe(1000);

    await settle(expense, "amma", 600); // full
    c = consumers();
    expectPerson("amma", 0, 0);
    expectPerson("tripthee", 1000, 0);
    expect(c.monthCycle).toEqual({ toGive: 0, toReceive: 1000 });

    await expenseRepository.deleteExpense((await expenseRepository.getByKey(expense.id))!);
    c = consumers();
    expect(c.sbi).toBe(10000);
    expect(c.mySpend).toBe(0);
    expectPerson("amma", 0, 0);
    expectPerson("tripthee", 0, 0);
    expect(c.netWorth).toMatchObject({ receivable: 0, payable: 0 });
    expect(activeLedgerEntries()).toHaveLength(0);

    await expenseRepository.restoreExpense((await expenseRepository.getByKey(expense.id))!);
    c = consumers();
    expect(c.sbi).toBe(7000); // −₹3,000 exactly once
    expect(c.mySpend).toBe(1000);
    expectPerson("tripthee", 1000, 0);
    expect(balanceOf("amma")).toBe(0); // AMMA's share and both settlements return together — still settled
    expect(c.netWorth.receivable).toBe(1000);
  });
});

describe("D. Both People directions stay separate", () => {
  it("AMMA owes me ₹1,000 (split share) and I owe AMMA ₹500 (she paid my expense) — two obligations, never netted", async () => {
    const { expenseRepository, ledgerRepositoryFor, personRepository, transactionRepository, linkedDelete } = buildRepos();
    await expenseRepository.createExpense({ ...SPLIT_3000, participantInputs: SPLIT_3000.participantInputs.slice(0, 2).map((p) => (p.isMe ? { ...p, value: 2000 } : p)) });
    const { transaction } = await ledgerRepositoryFor("amma").createPersonFundedExpense((await personRepository.getByKey("amma"))!, { amount: 500, date: DATE, categoryId: "food", description: "Lunch" }, transactionRepository);

    expectPerson("amma", 1000, 500);
    let c = consumers();
    expect(c.netWorth).toMatchObject({ receivable: 1000, payable: 500 });
    expect(c.monthCycle).toEqual({ toGive: 500, toReceive: 1000 });

    await linkedDelete((await transactionRepository.getByKey(transaction.id))!);
    expectPerson("amma", 1000, 0);
    c = consumers();
    expect(c.netWorth).toMatchObject({ receivable: 1000, payable: 0 });
  });
});
