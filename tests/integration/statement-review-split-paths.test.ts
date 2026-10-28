/**
 * Statement Review alternate write paths after the P0 deleted-key fix — shared_expense ("Shared Expense") and
 * someone_elses_expense ("Someone Else's Expense"), which write through ExpenseRepository (transaction + expense +
 * schedule + People ledger) instead of a single keyed transaction. REAL repositories + rules, Firestore EMULATOR,
 * synthetic data only. SR-1 (retry after an internal rollback), SR-2 (two tabs → duplicate Expense / People obligation)
 * and SR-3 (delete race → re-posted under a generated id) were reproduced here as failing cases and are now ordinary
 * regression tests, together with the atomic path's replay / mismatch / reversal behaviour.
 */

import { readFileSync } from "node:fs";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, getDocs, query, where, type Firestore } from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { actionToAxesPatch } from "@/features/transaction-studio/lib/action-metadata";
import { commitReviewImport, importTransferKey, type CommitRepositories } from "@/features/transaction-studio/lib/commit-review-import";
import { accountBalanceDrift } from "@/lib/engines/stored-balance-drift";
import { accountFromFirestore, accountToFirestore, type Account } from "@/lib/models/account";
import { categoryToFirestore, type Category } from "@/lib/models/category";
import { DEFAULT_RECORD_MODIFIERS, type RecordActionDetail, type StagedRecord } from "@/lib/models/document-import";
import { expenseFromFirestore, expenseToFirestore } from "@/lib/models/expense";
import { installmentFromFirestore, installmentToFirestore, paymentScheduleFromFirestore, paymentScheduleToFirestore } from "@/lib/models/payment-schedule";
import { ledgerEntryFromFirestore, ledgerEntryToFirestore, personFromFirestore, personToFirestore, signedAmount, type Person } from "@/lib/models/person";
import { transactionFromFirestore, transactionToFirestore } from "@/lib/models/transaction";
import { AccountRepository } from "@/lib/repositories/account-repository";
import { DuplicateSplitParticipantError, ExpenseRepository } from "@/lib/repositories/expense-repository";
import { InstallmentRepository, PaymentScheduleRepository } from "@/lib/repositories/payment-schedule-repository";
import { LedgerRepository, PersonRepository } from "@/lib/repositories/person-repository";
import { TransactionRepository } from "@/lib/repositories/transaction-repository";

const UID = "sr-split-owner";
const DOC = "card-1_" + "d".repeat(64);
let testEnv: RulesTestEnvironment;
beforeAll(async () => {
  testEnv = await initializeTestEnvironment({ projectId: "flowfi-sr-split-paths", firestore: { rules: readFileSync("firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 } });
});
afterAll(async () => {
  await testEnv.cleanup();
});
afterEach(async () => {
  await testEnv.clearFirestore();
});

const category: Category = { id: "cat-shopping", name: "Shopping", type: "expense", iconKey: "x", colorValue: 0, isDefault: false, isActive: true, createdAt: new Date(2026, 0, 1), deletedAt: null, lastEditedAt: null, editHistory: [] };

async function world() {
  const db = testEnv.authenticatedContext(UID).firestore() as unknown as Firestore;
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const { doc, setDoc } = await import("firebase/firestore");
    await setDoc(doc(ctx.firestore(), "users", UID, "categories", category.id), categoryToFirestore(category));
  });
  const accounts = new AccountRepository(collection(db, "users", UID, "accounts").withConverter({ toFirestore: accountToFirestore, fromFirestore: accountFromFirestore }));
  const expensesCol = collection(db, "users", UID, "expenses").withConverter({ toFirestore: expenseToFirestore, fromFirestore: expenseFromFirestore });
  const transactionsCol = collection(db, "users", UID, "transactions").withConverter({ toFirestore: transactionToFirestore, fromFirestore: transactionFromFirestore });
  const transactions = new TransactionRepository(transactionsCol, accounts).withExpenseOwnerLookup(async (transactionId) => (await getDocs(query(expensesCol, where("transactionId", "==", transactionId)))).docs.map((d) => d.ref));
  const people = new PersonRepository(collection(db, "users", UID, "people").withConverter({ toFirestore: personToFirestore, fromFirestore: personFromFirestore }));
  const ledgerFor = (personId: string) => new LedgerRepository(collection(db, "users", UID, "people", personId, "ledger").withConverter({ toFirestore: ledgerEntryToFirestore, fromFirestore: ledgerEntryFromFirestore }), people);
  /** Test seam: the next schedule-scoped write fails once (a network drop part-way through a split). */
  const faults = { failInstallmentsOnce: false };
  const installmentRepositoryFor = (scheduleId: string) => {
    if (faults.failInstallmentsOnce) {
      faults.failInstallmentsOnce = false;
      throw new Error("network interrupted");
    }
    return realInstallmentRepositoryFor(scheduleId);
  };
  const realInstallmentRepositoryFor = (scheduleId: string) =>
    new InstallmentRepository(collection(db, "users", UID, "paymentSchedules", scheduleId, "installments").withConverter({ toFirestore: installmentToFirestore, fromFirestore: installmentFromFirestore }));
  const schedules = new PaymentScheduleRepository(collection(db, "users", UID, "paymentSchedules").withConverter({ toFirestore: paymentScheduleToFirestore, fromFirestore: paymentScheduleFromFirestore }));
  const expenses = new ExpenseRepository(expensesCol, transactions, schedules, people, installmentRepositoryFor, ledgerFor);

  const bank = await accounts.createAccount({ name: "SBI Savings", type: "bank", openingBalance: 10_000, colorValue: 0 });
  const ravi = await people.createPerson({ name: "Ravi", avatarColorValue: 0, openingBalance: 0 });

  const repositories = (transactionRepository: TransactionRepository = transactions): CommitRepositories => ({
    transactionRepository,
    expenseRepository: expenses,
    emiRepository: {} as never,
    loanRepository: {} as never,
    installmentRepositoryFor,
  });
  const commit = (rows: StagedRecord[], repos: CommitRepositories = repositories()) =>
    commitReviewImport({ documentId: DOC, rows, accountId: bank.id, categories: [category], people: [ravi], accounts: [bank as Account], emis: [], loans: [], bills: [], repositories: repos, onRowCommitted: async () => undefined, linkRetryDelayMs: 0 });

  const liveTxns = async () => (await getDocs(transactionsCol)).docs.map((d) => d.data()).filter((t) => t.deletedAt == null);
  const liveExpenses = async () => (await getDocs(expensesCol)).docs.map((d) => d.data()).filter((e) => e.deletedAt == null);
  const raviLedger = async () => (await ledgerFor(ravi.id).getAll()).filter((e) => e.deletedAt == null);
  const raviBalance = async () => (await people.getByKey(ravi.id))!.currentBalance;
  const bankBalance = async () => (await accounts.getByKey(bank.id))!.currentBalance;
  const bankDrift = async () => accountBalanceDrift((await accounts.getByKey(bank.id))!, await liveTxns());
  const state = async () => ({ txns: (await liveTxns()).length, expenses: (await liveExpenses()).length, ledger: (await raviLedger()).length, bank: await bankBalance(), ravi: await raviBalance() });
  const allExpenses = async () => (await getDocs(expensesCol)).docs.map((d) => d.data());
  const allTxns = async () => (await getDocs(transactionsCol)).docs.map((d) => d.data());
  /** People invariant: every person's stored balance = opening balance + the signed sum of their live ledger entries. */
  const ledgerDrift = async () => {
    const drift: { name: string; balance: number; ledger: number; entries: number }[] = [];
    for (const person of await people.getAll()) {
      const entries = (await ledgerFor(person.id).getAll()).filter((e) => e.deletedAt == null);
      const ledger = Math.round((person.openingBalance + entries.reduce((sum, e) => sum + signedAmount(e), 0)) * 100) / 100;
      if (Math.abs(ledger - person.currentBalance) >= 0.005) drift.push({ name: person.name, balance: person.currentBalance, ledger, entries: entries.length });
    }
    return drift;
  };
  const commitWith = (rows: StagedRecord[], peopleList: Person[]) =>
    commitReviewImport({ documentId: DOC, rows, accountId: bank.id, categories: [category], people: peopleList, accounts: [bank as Account], emis: [], loans: [], bills: [], repositories: repositories(), onRowCommitted: async () => undefined, linkRetryDelayMs: 0 });
  return { people, ledgerFor, ledgerDrift, commitWith, db, bank, ravi, transactions, expenses, repositories, commit, liveTxns, liveExpenses, allExpenses, allTxns, raviLedger, bankDrift, state, faults };
}

function staged(id: string, action: "shared_expense" | "someone_elses_expense", detail: RecordActionDetail): StagedRecord {
  return {
    id, recordType: "transaction", rawText: "DINNER", date: new Date("2026-10-10T06:30:00.000Z"), counterpartyRaw: "DINNER", counterpartyNormalized: "Dinner", amount: 1000, direction: "debit",
    referenceNumber: null, currency: "INR", category: "Shopping", subcategory: null, confidenceScores: {}, sourcePage: 1, sourceLineIndex: 0, splitParentId: null, mergedInto: null,
    userEdited: false, lastEditedAt: null, lastEditedBy: null, tags: [], notes: "", duplicateOfTransactionId: null, include: true, ...actionToAxesPatch(action, detail),
    modifiers: DEFAULT_RECORD_MODIFIERS, committedTransactionId: null, excludeFromCalculations: false, accountingMonth: null, suggestedCategory: null, suggestedAccount: null,
    suggestedPerson: null, suggestedTags: [], expenseType: null, transferDetected: false, recurringDetected: false, subscriptionDetected: false, duplicateCandidateOf: null, needsReview: false,
  };
}
const shared = (w: Awaited<ReturnType<typeof world>>) =>
  staged("1", "shared_expense", {
    kind: "shared_expense",
    splitType: "custom",
    participants: [
      { personId: null, name: "Me", share: 500, isMe: true },
      { personId: w.ravi.id, name: "Ravi", share: 500, isMe: false },
    ],
  });
const forRavi = (w: Awaited<ReturnType<typeof world>>) => staged("2", "someone_elses_expense", { kind: "someone_elses_expense", personId: w.ravi.id, personName: "Ravi" });
/** One posting of the 1,000 dinner: one transaction, one expense, Ravi owes once. */
const ONCE = { txns: 1, expenses: 1, ledger: 1, bank: 9_000 };

describe.each([
  ["Shared Expense (split)", shared],
  ["Someone Else's Expense", forRavi],
] as const)("%s", (_label, rowFor) => {
  it("baseline: imports once; a re-run (lost acknowledgement) posts nothing more", async () => {
    const w = await world();
    expect((await w.commit([rowFor(w)])).committedCount).toBe(1);
    expect(await w.state()).toMatchObject(ONCE);
    const raviOwes = (await w.state()).ravi;
    expect((await w.commit([rowFor(w)])).committedCount).toBe(1);
    expect(await w.state()).toMatchObject({ ...ONCE, ravi: raviOwes });
    expect(await w.bankDrift()).toBeNull();
  });

  it("user deleted the imported expense: re-import is BLOCKED (deleted_import) — no transaction, expense or People entry is recreated", async () => {
    const w = await world();
    await w.commit([rowFor(w)]);
    await w.expenses.deleteExpense((await w.liveExpenses())[0]);
    const before = await w.state();
    expect(before).toMatchObject({ txns: 0, expenses: 0, ledger: 0, bank: 10_000 });
    const again = await w.commit([rowFor(w)]);
    expect(again.results[0].blockingReasons?.[0].code).toBe("deleted_import");
    expect(await w.state()).toEqual(before);
  });

  const keyOf = (row: StagedRecord) => importTransferKey(row.id, DOC);
  const paramsFor = (w: Awaited<ReturnType<typeof world>>, row: StagedRecord) => {
    const detail = row.actionDetail!;
    const participantInputs =
      detail.kind === "shared_expense"
        ? detail.participants.map((x) => ({ personId: x.personId, name: x.name, value: x.share, isMe: x.isMe }))
        : [{ personId: w.ravi.id, name: "Ravi", value: 1000 }];
    return { description: "Dinner", totalAmount: 1000, date: row.date, categoryId: category.id, accountId: w.bank.id, splitType: "custom" as const, participantInputs, idempotencyKey: keyOf(row) };
  };

  it("SR-1: an atomic attempt that fails part-way writes NOTHING and is simply retryable", async () => {
    const w = await world();
    w.faults.failInstallmentsOnce = true;
    const first = await w.commit([rowFor(w)]);
    expect(first.failedCount).toBe(1);
    expect(await w.state()).toMatchObject({ txns: 0, expenses: 0, ledger: 0, bank: 10_000, ravi: 0 });
    expect(await w.allTxns()).toHaveLength(0); // not even a deleted document
    const retry = await w.commit([rowFor(w)]);
    expect(retry.results[0].outcome).toBe("committed");
    expect(await w.state()).toMatchObject(ONCE);
    expect(await w.bankDrift()).toBeNull();
  });

  it("SR-1: a keyed split rolled back by its OWN rollback leaves a durable marker, and is retryable exactly once", async () => {
    const w = await world();
    const row = rowFor(w);
    // The older, non-atomic path (still the default createExpense) with a key: the Expense write fails, it rolls back.
    const repo = w.expenses as unknown as { add: (id: string, e: unknown) => Promise<void> };
    const realAdd = repo.add.bind(repo);
    repo.add = async () => {
      repo.add = realAdd;
      throw new Error("network interrupted");
    };
    await expect(w.expenses.createExpense(paramsFor(w, row))).rejects.toThrow(/network interrupted/);
    expect(await w.state()).toMatchObject({ txns: 0, expenses: 0, ledger: 0, bank: 10_000, ravi: 0 });
    const marker = await w.transactions.getImportRollbackMarker(`txn_${keyOf(row)}`);
    expect(marker).toMatchObject({ kind: "import_rollback", consumedAt: null });
    expect(marker!.reason).toMatch(/network interrupted/);

    const retry = await w.commit([row]);
    expect(retry.results[0].outcome).toBe("committed");
    expect(retry.results[0].transactionId).toBe(`txn_${keyOf(row)}`); // same id, re-recorded
    expect(await w.state()).toMatchObject(ONCE);
    expect(await w.bankDrift()).toBeNull();
    expect((await w.transactions.getImportRollbackMarker(`txn_${keyOf(row)}`))!.consumedAt).not.toBeNull(); // audit kept

    // The marker is spent: if the user now deletes the import, it stays deleted.
    await w.expenses.deleteExpense((await w.liveExpenses())[0]);
    const after = await w.commit([row]);
    expect(after.results[0].blockingReasons?.[0].code).toBe("deleted_import");
    expect(await w.state()).toMatchObject({ txns: 0, expenses: 0, ledger: 0, bank: 10_000, ravi: 0 });
  });

  it("SR-1: a deleted keyed transaction WITHOUT a marker (a user delete, or an unmarked historical rollback) stays blocked", async () => {
    const w = await world();
    const row = rowFor(w);
    const t = await w.transactions.createTransaction({ type: "expense", amount: 1000, dateTime: row.date, accountId: w.bank.id, categoryId: category.id, description: "Dinner", idempotencyKey: keyOf(row) });
    await w.transactions.softDeleteTransaction(t);
    const before = await w.state();
    const result = await w.commit([row]);
    expect(result.results[0].blockingReasons?.[0].code).toBe("deleted_import");
    expect(await w.state()).toEqual(before);
  });

  it("SR-1: an INTERRUPTED rollback (transaction left live, no split) is never completed automatically — manual review, no second debit", async () => {
    const w = await world();
    const row = rowFor(w);
    const repo = w.expenses as unknown as { add: (id: string, e: unknown) => Promise<void> };
    const realAdd = repo.add.bind(repo);
    repo.add = async () => {
      repo.add = realAdd;
      throw new Error("network interrupted");
    };
    const tx = w.transactions as unknown as { rollBackKeyedImportInTransaction: unknown };
    const realRollback = tx.rollBackKeyedImportInTransaction;
    tx.rollBackKeyedImportInTransaction = async () => {
      throw new Error("offline during rollback");
    };
    await expect(w.expenses.createExpense(paramsFor(w, row))).rejects.toThrow(/couldn't be fully undone/);
    tx.rollBackKeyedImportInTransaction = realRollback;
    const before = await w.state();
    expect(before).toMatchObject({ txns: 1, expenses: 0, ledger: 0, bank: 9_000 });
    const retry = await w.commit([row]);
    expect(retry.results[0].blockingReasons?.[0]).toMatchObject({ code: "import_review" });
    expect(retry.results[0].blockingReasons?.[0].message).toMatch(/not its split \/ People details/);
    expect(await w.state()).toEqual(before);
  });

  it("SR-2: two TABS approving the same statement at once: one transaction, one expense, Ravi owes ONCE", async () => {
    const w = await world();
    const results = await Promise.all([w.commit([rowFor(w)]), w.commit([rowFor(w)]), w.commit([rowFor(w)])]);
    for (const r of results) expect(r.results[0].outcome, JSON.stringify(r.results[0])).toBe("committed");
    expect(new Set(results.map((r) => r.results[0].transactionId)).size).toBe(1);
    expect(await w.state()).toMatchObject(ONCE);
    expect((await w.allExpenses()).length).toBe(1);
    expect(await w.bankDrift()).toBeNull();
  });

  it("SR-2: a retry replays an identical split; one with a different allocation is REFUSED, never reused", async () => {
    const w = await world();
    await w.commit([rowFor(w)]);
    const once = await w.state();
    // Same row key, different split: a different allocation for the split (Me 400 / Ravi 600), a different amount for
    // the single-person assignment.
    const base = rowFor(w);
    const changed: StagedRecord =
      base.actionDetail?.kind === "shared_expense"
        ? { ...base, actionDetail: { ...base.actionDetail, participants: [{ personId: null, name: "Me", share: 400, isMe: true }, { personId: w.ravi.id, name: "Ravi", share: 600, isMe: false }] } }
        : { ...base, amount: 1200 };
    const r1 = await w.commit([changed]);
    expect(r1.results[0].blockingReasons?.[0].code, JSON.stringify(r1.results[0])).toBe("import_review");
    expect(r1.results[0].blockingReasons?.[0].message).toMatch(/different details/);
    expect(await w.state()).toEqual(once);
    expect((await w.allExpenses()).length).toBe(1);
  });

  it("SR-2: an older non-atomic import that DID complete (lost acknowledgement) is replayed after comparison — no second Expense", async () => {
    const w = await world();
    const row = rowFor(w);
    await w.expenses.createExpense(paramsFor(w, row)); // complete, generated expense id
    const once = await w.state();
    expect(once).toMatchObject(ONCE);
    const retry = await w.commit([row]);
    expect(retry.results[0].outcome).toBe("committed");
    expect(await w.state()).toEqual(once);
    expect((await w.allExpenses()).length).toBe(1);
  });

  it("SR-3: deleted between the engine's check and the write (race): nothing is recreated under a generated id", async () => {
    const w = await world();
    await w.commit([rowFor(w)]);
    await w.expenses.deleteExpense((await w.liveExpenses())[0]);
    const before = await w.state();
    // The engine's pre-check read is stale (it ran before the delete landed).
    const blind = Object.assign(Object.create(Object.getPrototypeOf(w.transactions)), w.transactions, { getByKey: async () => null }) as TransactionRepository;
    const result = await w.commit([rowFor(w)], w.repositories(blind));
    expect(result.results[0].outcome).toBe("blocked");
    expect(await w.state()).toEqual(before);
    expect((await w.liveTxns()).length + (await w.allExpenses()).filter((e) => e.deletedAt == null).length).toBe(0);
  });

  it("reversal compatibility: deleting and restoring an atomically imported split moves the account and People balance exactly once each way", async () => {
    const w = await world();
    await w.commit([rowFor(w)]);
    const once = await w.state();
    const expense = (await w.liveExpenses())[0];
    await w.expenses.deleteExpense(expense);
    expect(await w.state()).toMatchObject({ txns: 0, expenses: 0, ledger: 0, bank: 10_000, ravi: 0 });
    await w.expenses.restoreExpense((await w.allExpenses())[0]);
    expect(await w.state()).toEqual(once);
    expect(await w.bankDrift()).toBeNull();
  });
});

/** H1 — the same person twice in one split (picked from People AND typed as a custom name that resolves to them). */
describe("H1: one person, one share — duplicate participants never reach the ledger", () => {
  const split = (id: string, participants: { personId: string | null; name: string; share: number; isMe: boolean }[]) =>
    staged(id, "shared_expense", { kind: "shared_expense", splitType: "custom", participants });
  const NOTHING = { txns: 0, expenses: 0, ledger: 0, bank: 10_000, ravi: 0 };

  it("picked Ravi + typed 'ravi' through Statement Review: BLOCKED (inconsistent_detail), nothing written, no contact created", async () => {
    const w = await world();
    const peopleBefore = (await w.people.getAll()).length;
    for (const typed of ["Ravi", " ravi "]) {
      const row = split("1", [
        { personId: null, name: "Me", share: 500, isMe: true },
        { personId: w.ravi.id, name: "Ravi", share: 300, isMe: false },
        { personId: null, name: typed, share: 200, isMe: false },
      ]);
      const result = await w.commit([row]);
      expect(result.results[0].outcome).toBe("blocked");
      expect(result.results[0].blockingReasons?.[0]).toMatchObject({ code: "inconsistent_detail" });
      expect(result.results[0].blockingReasons?.[0].message).toMatch(/already in this split/);
    }
    expect(await w.state()).toEqual(NOTHING);
    expect(await w.allTxns()).toHaveLength(0);
    expect((await w.people.getAll()).length).toBe(peopleBefore);
    expect(await w.ledgerDrift()).toEqual([]);
  });

  it("the repository refuses it directly too — before the transaction, even alongside a NEW typed name (no stray contact)", async () => {
    const w = await world();
    const attempt = w.expenses.createExpenseAtomic({
      description: "Dinner",
      totalAmount: 1000,
      date: new Date("2026-10-10T06:30:00.000Z"),
      categoryId: category.id,
      accountId: w.bank.id,
      splitType: "custom",
      participantInputs: [
        { personId: null, name: "Me", value: 400, isMe: true },
        { personId: null, name: "Sam", value: 100 },
        { personId: w.ravi.id, name: "Ravi", value: 300 },
        { personId: null, name: "RAVI", value: 200 },
      ],
      idempotencyKey: importTransferKey("9", DOC),
    });
    await expect(attempt).rejects.toBeInstanceOf(DuplicateSplitParticipantError);
    expect(await w.state()).toEqual(NOTHING);
    expect((await w.people.getAll()).map((p) => p.name)).toEqual(["Ravi"]); // "Sam" was never created
  });

  it("deterministic ledger ids are never shared: a valid 4-way split writes one entry per person and balance = ledger for everyone", async () => {
    const w = await world();
    const anu = await w.people.createPerson({ name: "Anu", avatarColorValue: 0, openingBalance: 0 });
    const row = split("1", [
      { personId: null, name: "Me", share: 250, isMe: true },
      { personId: w.ravi.id, name: "Ravi", share: 300, isMe: false },
      { personId: anu.id, name: "Anu", share: 200, isMe: false },
      { personId: null, name: "Sam", share: 250, isMe: false }, // a new contact, promoted once
    ]);
    const result = await w.commitWith([row], [w.ravi, anu]);
    expect(result.results[0].outcome).toBe("committed");
    const sam = (await w.people.getAll()).find((p) => p.name === "Sam")!;
    const key = importTransferKey("1", DOC);
    for (const [person, share] of [[w.ravi, 300], [anu, 200], [sam, 250]] as const) {
      const entries = (await w.ledgerFor(person.id).getAll()).filter((e) => e.deletedAt == null);
      expect(entries.map((e) => [e.id, e.amount])).toEqual([[`led_${key}_${person.id}`, share]]);
      expect((await w.people.getByKey(person.id))!.currentBalance).toBe(share);
    }
    expect(await w.ledgerDrift()).toEqual([]);
    expect(await w.bankDrift()).toBeNull();
  });

  it("existing valid split shapes are unaffected: an unpicked existing person typed by name links to them once", async () => {
    const w = await world();
    const row = split("1", [
      { personId: null, name: "Me", share: 600, isMe: true },
      { personId: null, name: "ravi", share: 400, isMe: false },
    ]);
    expect((await w.commit([row])).results[0].outcome).toBe("committed");
    expect(await w.state()).toMatchObject({ ...ONCE, ravi: 400 });
    expect((await w.people.getAll()).length).toBe(1);
    expect(await w.ledgerDrift()).toEqual([]);
  });

  it("concurrent approvals of a multi-person split stay idempotent: three tabs → one posting, balance = ledger", async () => {
    const w = await world();
    const anu = await w.people.createPerson({ name: "Anu", avatarColorValue: 0, openingBalance: 0 });
    const row = () =>
      split("1", [
        { personId: null, name: "Me", share: 400, isMe: true },
        { personId: w.ravi.id, name: "Ravi", share: 350, isMe: false },
        { personId: anu.id, name: "Anu", share: 250, isMe: false },
      ]);
    const results = await Promise.all([0, 1, 2].map(() => w.commitWith([row()], [w.ravi, anu])));
    for (const r of results) expect(r.results[0].outcome).toBe("committed");
    expect(new Set(results.map((r) => r.results[0].transactionId)).size).toBe(1);
    expect(await w.state()).toMatchObject({ ...ONCE, ravi: 350 });
    expect((await w.people.getByKey(anu.id))!.currentBalance).toBe(250);
    expect((await w.allExpenses()).length).toBe(1);
    expect(await w.ledgerDrift()).toEqual([]);
    expect(await w.bankDrift()).toBeNull();
  });

  it("concurrent DUPLICATE attempts from several tabs all block — nothing written", async () => {
    const w = await world();
    const row = () =>
      split("1", [
        { personId: null, name: "Me", share: 500, isMe: true },
        { personId: w.ravi.id, name: "Ravi", share: 300, isMe: false },
        { personId: null, name: "Ravi", share: 200, isMe: false },
      ]);
    const results = await Promise.all([0, 1, 2].map(() => w.commit([row()])));
    for (const r of results) expect(r.results[0].outcome).toBe("blocked");
    expect(await w.state()).toEqual(NOTHING);
    expect(await w.ledgerDrift()).toEqual([]);
  });
});

/** L3 — the rollback marker only vouches for a FULLY undone attempt; L4 — a ₹0 / negative share for anyone but "Me" is refused up front. */
describe("L3: rollback marker only after every undo step succeeded", () => {
  const key = (id: string) => importTransferKey(id, DOC);
  const params = (w: Awaited<ReturnType<typeof world>>, id: string) => ({
    description: "Dinner", totalAmount: 1000, date: new Date("2026-10-10T06:30:00.000Z"), categoryId: category.id, accountId: w.bank.id, splitType: "custom" as const,
    participantInputs: [{ personId: null, name: "Me", value: 500, isMe: true }, { personId: w.ravi.id, name: "Ravi", value: 500 }], idempotencyKey: key(id),
  });
  /** Makes the old non-atomic path's Expense write fail once (so it rolls back). */
  const failExpenseWriteOnce = (w: Awaited<ReturnType<typeof world>>) => {
    const repo = w.expenses as unknown as { add: (id: string, e: unknown) => Promise<void> };
    const real = repo.add.bind(repo);
    repo.add = async () => {
      repo.add = real;
      throw new Error("network interrupted");
    };
  };

  it("fully undone → marker written (retryable once); the transaction, schedule and ledger are all gone", async () => {
    const w = await world();
    failExpenseWriteOnce(w);
    await expect(w.expenses.createExpense(params(w, "1"))).rejects.toThrow(/network interrupted/);
    expect(await w.transactions.getImportRollbackMarker(`txn_${key("1")}`)).toMatchObject({ kind: "import_rollback", consumedAt: null });
    expect(await w.state()).toMatchObject({ txns: 0, expenses: 0, ledger: 0, bank: 10_000, ravi: 0 });
    expect(await w.ledgerDrift()).toEqual([]);
  });

  it("an undo step FAILS (the schedule can't be removed) → NO marker; the import stays blocked for manual review, never auto-retried", async () => {
    const w = await world();
    failExpenseWriteOnce(w);
    const schedules = (w.expenses as unknown as { paymentScheduleRepository: { softDelete: (s: unknown) => Promise<void> } }).paymentScheduleRepository;
    const realSoftDelete = schedules.softDelete.bind(schedules);
    schedules.softDelete = async () => {
      schedules.softDelete = realSoftDelete;
      throw new Error("offline during schedule undo");
    };
    await expect(w.expenses.createExpense(params(w, "1"))).rejects.toThrow(/couldn't be fully undone/);

    expect(await w.transactions.getImportRollbackMarker(`txn_${key("1")}`)).toBeNull(); // no marker
    const stored = (await w.allTxns()).find((t) => t.id === `txn_${key("1")}`)!;
    expect(stored.deletedAt).not.toBeNull(); // still soft-deleted (the bank balance is reversed) …
    expect((await w.state()).bank).toBe(10_000);

    const row = staged("1", "shared_expense", {
      kind: "shared_expense", splitType: "custom",
      participants: [{ personId: null, name: "Me", share: 500, isMe: true }, { personId: w.ravi.id, name: "Ravi", share: 500, isMe: false }],
    });
    const before = await w.state();
    const retry = await w.commit([row]);
    expect(retry.results[0].outcome).toBe("blocked"); // … so the retry is blocked, not replayed
    expect(retry.results[0].blockingReasons?.[0].code).toBe("deleted_import");
    expect(await w.state()).toEqual(before);
    expect((await w.allTxns()).filter((t) => t.deletedAt == null)).toHaveLength(0);
  });

  it("an undo step fails on the PEOPLE side (ledger undo throws) → also no marker", async () => {
    const w = await world();
    const people = (w.expenses as unknown as { personRepository: { getByKey: (id: string) => Promise<unknown> } }).personRepository;
    const realGet = people.getByKey.bind(people);
    const repo = w.expenses as unknown as { add: (id: string, e: unknown) => Promise<void> };
    const realAdd = repo.add.bind(repo);
    repo.add = async () => {
      repo.add = realAdd;
      // Armed only now: the first People read of the ROLLBACK (its ledger step) fails.
      people.getByKey = async () => {
        people.getByKey = realGet;
        throw new Error("offline during ledger undo");
      };
      throw new Error("network interrupted");
    };
    await expect(w.expenses.createExpense(params(w, "1"))).rejects.toThrow(/couldn't be fully undone/);
    people.getByKey = realGet;
    expect(await w.transactions.getImportRollbackMarker(`txn_${key("1")}`)).toBeNull();
    expect((await w.allTxns()).find((t) => t.id === `txn_${key("1")}`)!.deletedAt).not.toBeNull();
  });
});

describe("L4: zero or negative shares for non-Me participants", () => {
  const split = (participants: { personId: string | null; name: string; share: number; isMe: boolean }[]) =>
    staged("1", "shared_expense", { kind: "shared_expense", splitType: "custom", participants });
  const emptyState = async (w: Awaited<ReturnType<typeof world>>) => {
    const { collection: col, getDocs: docs } = await import("firebase/firestore");
    return {
      ...(await w.state()),
      all: (await w.allTxns()).length,
      expensesAll: (await w.allExpenses()).length,
      schedules: (await docs(col(w.db, "users", UID, "paymentSchedules"))).size,
      people: (await w.people.getAll()).length,
    };
  };
  const UNTOUCHED = { txns: 0, expenses: 0, ledger: 0, bank: 10_000, ravi: 0, all: 0, expensesAll: 0, schedules: 0, people: 1 };

  it.each([
    ["₹0 for a picked person", [{ personId: "RAVI", name: "Ravi", share: 0, isMe: false }]],
    ["₹0 for a NEW typed name (no contact may be created)", [{ personId: null, name: "Sam", share: 0, isMe: false }]],
    ["₹0 for one of several others", [{ personId: "RAVI", name: "Ravi", share: 400, isMe: false }, { personId: null, name: "Sam", share: 0, isMe: false }]],
  ])("%s → blocked as Inconsistent Details; no transaction, Expense, contact, ledger entry, schedule or balance change", async (_label, others) => {
    const w = await world();
    const mine = 1000 - others.reduce((sum, o) => sum + o.share, 0);
    const row = split([{ personId: null, name: "Me", share: mine, isMe: true }, ...others.map((o) => ({ ...o, personId: o.personId === "RAVI" ? w.ravi.id : null }))]);
    const result = await w.commit([row]);
    expect(result.results[0].outcome).toBe("blocked");
    expect(result.results[0].blockingReasons?.[0]).toMatchObject({ code: "inconsistent_detail" });
    expect(result.results[0].blockingReasons?.[0].message).toMatch(/₹0 or less/);
    expect(result.failedCount).toBe(0); // not a retryable technical failure
    expect(await emptyState(w)).toEqual(UNTOUCHED);
    expect(await w.ledgerDrift()).toEqual([]);
  });

  it("the repository refuses a negative share directly, before anything is written", async () => {
    const w = await world();
    await expect(
      w.expenses.createExpenseAtomic({
        description: "Dinner", totalAmount: 1000, date: new Date("2026-10-10T06:30:00.000Z"), categoryId: category.id, accountId: w.bank.id, splitType: "custom",
        participantInputs: [{ personId: null, name: "Me", value: 1100, isMe: true }, { personId: w.ravi.id, name: "Ravi", value: -100 }],
        idempotencyKey: importTransferKey("8", DOC),
      }),
    ).rejects.toThrow();
    expect(await emptyState(w)).toEqual(UNTOUCHED);
  });

  it("'Me' keeping ₹0 is still valid (everything assigned to others), and ordinary splits are unaffected", async () => {
    const w = await world();
    const allOnRavi = split([{ personId: null, name: "Me", share: 0, isMe: true }, { personId: w.ravi.id, name: "Ravi", share: 1000, isMe: false }]);
    expect((await w.commit([allOnRavi])).results[0].outcome).toBe("committed");
    expect(await w.state()).toMatchObject({ ...ONCE, ravi: 1000 });
    expect(await w.ledgerDrift()).toEqual([]);
  });
});
