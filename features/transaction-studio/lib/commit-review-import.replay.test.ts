/**
 * Statement Review Phase 2 — replay safety of the commit engine.
 *
 * The scenario that matters: the money write lands, then persisting `committedTransactionId` on the staged row
 * fails (network drop / tab closed). The user (or a retry) runs Approve & Import again. Nothing financial may be
 * written a second time — no second expense, transfer/payment, installment payment, EMI/loan, or split.
 *
 * Uses small in-memory repositories that honour the real idempotency contract of `TransactionRepository.
 * createTransaction` (`idempotencyKey` → id `txn_<key>`, same money returns the existing doc, a mismatch throws)
 * and `createTransferPair`, so a missing/unstable key shows up as a duplicate write, not a mocked-away pass.
 */

import { describe, expect, it, vi } from "vitest";
import { DEFAULT_RECORD_MODIFIERS, type StagedRecord } from "@/lib/models/document-import";
import type { Transaction } from "@/lib/models/transaction";
import { actionToAxesPatch } from "./action-metadata";
import { commitReviewImport, detectFreshDuplicatesForCommit, importTransferKey, type CommitRepositories } from "./commit-review-import";

function row(overrides: Partial<StagedRecord> = {}): StagedRecord {
  return {
    id: "r1",
    recordType: "transaction",
    rawText: "AMZN",
    date: new Date("2026-07-15T06:30:00.000Z"),
    counterpartyRaw: "AMZN RAW",
    counterpartyNormalized: "Amazon",
    amount: 100,
    direction: "debit",
    referenceNumber: null,
    currency: "INR",
    category: "Shopping",
    subcategory: null,
    confidenceScores: {},
    sourcePage: 1,
    sourceLineIndex: 0,
    splitParentId: null,
    mergedInto: null,
    userEdited: false,
    lastEditedAt: null,
    lastEditedBy: null,
    tags: [],
    notes: "",
    duplicateOfTransactionId: null,
    include: true,
    flowType: "expense",
    ownership: "mine",
    modifiers: DEFAULT_RECORD_MODIFIERS,
    actionDetail: null,
    committedTransactionId: null,
    excludeFromCalculations: false,
    accountingMonth: null,
    suggestedCategory: null,
    suggestedAccount: null,
    suggestedPerson: null,
    suggestedTags: [],
    expenseType: null,
    transferDetected: false,
    recurringDetected: false,
    subscriptionDetected: false,
    duplicateCandidateOf: null,
    needsReview: false,
    ...overrides,
  };
}

const baseParams = {
  accountId: "acc-card",
  categories: [{ id: "cat-shopping", name: "Shopping" } as never],
  people: [],
  accounts: [],
  emis: [{ id: "emi-1", scheduleId: "sched-1", isClosed: false, name: "Phone EMI" } as never],
  loans: [],
  bills: [],
  linkRetryDelayMs: 0,
};

/** In-memory money store: every write that would move money is counted. */
function memoryRepos(options: { installments?: Array<{ id: string; dueDate: Date; amountPaid: number; amountDue: number; isSkipped: boolean }> } = {}) {
  const transactions = new Map<string, Transaction>();
  const installments = (options.installments ?? [{ id: "i1", dueDate: new Date("2026-08-01"), amountPaid: 0, amountDue: 100, isSkipped: false }]).map((i) => ({ ...i }));
  const expenses = new Map<string, { id: string; transactionId: string }>();
  let sequence = 0;

  const createTransaction = vi.fn(async (p: { idempotencyKey?: string; amount: number; type: string; accountId: string; dateTime: Date }) => {
    if (p.idempotencyKey != null) {
      const id = `txn_${p.idempotencyKey}`;
      const prior = transactions.get(id);
      if (prior && prior.deletedAt == null) {
        if (Math.abs(prior.amount - p.amount) > 0.005 || prior.accountId !== p.accountId) throw new Error("already saved with different details");
        return prior;
      }
      const created = { id, amount: p.amount, type: p.type, accountId: p.accountId, dateTime: p.dateTime, deletedAt: null } as unknown as Transaction;
      transactions.set(id, created);
      return created;
    }
    const created = { id: `auto_${++sequence}`, amount: p.amount, type: p.type, accountId: p.accountId, dateTime: p.dateTime, deletedAt: null } as unknown as Transaction;
    transactions.set(created.id, created);
    return created;
  });
  const getByKey = vi.fn(async (id: string) => transactions.get(id) ?? null);
  const createTransferPair = vi.fn(async (p: { idempotencyKey: string; amount: number; sourceAccountId: string; destinationAccountId: string; dateTime: Date }) => {
    const sourceId = `xfer_${p.idempotencyKey}_src`;
    const destId = `xfer_${p.idempotencyKey}_dst`;
    if (!transactions.has(sourceId)) {
      transactions.set(sourceId, { id: sourceId, amount: p.amount, type: "expense", accountId: p.sourceAccountId, dateTime: p.dateTime, transferId: `xfer_${p.idempotencyKey}`, deletedAt: null } as unknown as Transaction);
      transactions.set(destId, { id: destId, amount: p.amount, type: "income", accountId: p.destinationAccountId, dateTime: p.dateTime, transferId: `xfer_${p.idempotencyKey}`, deletedAt: null } as unknown as Transaction);
    }
    return [transactions.get(sourceId)!, transactions.get(destId)!] as [Transaction, Transaction];
  });

  const applyPayment = vi.fn(async (installment: { id: string }, delta: number) => {
    const target = installments.find((i) => i.id === installment.id)!;
    target.amountPaid += delta;
  });
  const getAll = vi.fn(async () => installments.map((i) => ({ ...i })));

  const createEmi = vi.fn(async () => ({ id: `emi_${++sequence}`, scheduleId: "sched-new" }));
  const createExpense = vi.fn(async (p: { idempotencyKey?: string; totalAmount: number; accountId: string; date: Date }) => {
    const tx = await createTransaction({ idempotencyKey: p.idempotencyKey, amount: p.totalAmount, type: "expense", accountId: p.accountId, dateTime: p.date });
    const expense = { id: `exp_${++sequence}`, transactionId: tx.id };
    expenses.set(expense.id, expense);
    return expense;
  });
  const findActiveByTransactionId = vi.fn(async (transactionId: string) => [...expenses.values()].find((e) => e.transactionId === transactionId) ?? null);

  const repositories = {
    transactionRepository: { createTransaction, getByKey, createTransferPair } as never,
    expenseRepository: { createExpense, assignToPerson: createExpense, findActiveByTransactionId } as never,
    emiRepository: { createEmi, permanentlyDeleteEmi: vi.fn() } as never,
    loanRepository: { createLoan: vi.fn(), permanentlyDeleteLoan: vi.fn() } as never,
    installmentRepositoryFor: () => ({ getAll, applyPayment }) as never,
  } satisfies CommitRepositories;

  return { repositories, transactions, installments, createTransaction, createTransferPair, applyPayment, createEmi, createExpense, expenses, findActiveByTransactionId };
}

/** An `onRowCommitted` that fails for the first `failures` calls (network interruption), then succeeds. */
function flakyAcknowledgement(failures: number) {
  const acknowledged: Array<{ recordId: string; transactionId: string }> = [];
  let calls = 0;
  const onRowCommitted = vi.fn(async (recordId: string, transactionId: string) => {
    calls++;
    if (calls <= failures) throw new Error("network interrupted");
    acknowledged.push({ recordId, transactionId });
  });
  return { onRowCommitted, acknowledged };
}

const DOC = "card-1_" + "a".repeat(64);

describe("commit replay — network interruption after the money write, before the staging acknowledgment", () => {
  it("normal expense: a failed acknowledgment reports the row as failed WITH its transaction id, and the re-run writes no second expense", async () => {
    const store = memoryRepos();
    const ack = flakyAcknowledgement(3); // exhausts the in-run retries too
    const staged = row();

    const first = await commitReviewImport({ ...baseParams, documentId: DOC, rows: [staged], repositories: store.repositories, onRowCommitted: ack.onRowCommitted });
    expect(first.failedCount).toBe(1);
    expect(first.results[0].transactionId).toBeTruthy();
    expect(first.results[0].error).toMatch(/will not create a duplicate/);
    expect(store.transactions.size).toBe(1);

    const second = await commitReviewImport({ ...baseParams, documentId: DOC, rows: [staged], repositories: store.repositories, onRowCommitted: ack.onRowCommitted });
    expect(second.committedCount).toBe(1);
    expect(second.results[0].transactionId).toBe(first.results[0].transactionId);
    expect(store.transactions.size).toBe(1); // still exactly one expense
    expect(ack.acknowledged).toEqual([{ recordId: "r1", transactionId: first.results[0].transactionId }]);
  });

  it("a transient acknowledgment failure is retried inside the same run and the row ends committed", async () => {
    const store = memoryRepos();
    const ack = flakyAcknowledgement(2);
    const result = await commitReviewImport({ ...baseParams, documentId: DOC, rows: [row()], repositories: store.repositories, onRowCommitted: ack.onRowCommitted });
    expect(result.committedCount).toBe(1);
    expect(ack.onRowCommitted).toHaveBeenCalledTimes(3);
    expect(store.transactions.size).toBe(1);
  });

  it("income / refund rows are keyed the same way (no double credit on replay)", async () => {
    const store = memoryRepos();
    const ack = flakyAcknowledgement(3);
    const refund = row({ id: "r2", direction: "credit", ...actionToAxesPatch("refund") });
    await commitReviewImport({ ...baseParams, documentId: DOC, rows: [refund], repositories: store.repositories, onRowCommitted: ack.onRowCommitted });
    await commitReviewImport({ ...baseParams, documentId: DOC, rows: [refund], repositories: store.repositories, onRowCommitted: ack.onRowCommitted });
    expect(store.transactions.size).toBe(1);
  });

  it("transfer / card payment: replay returns the same pair — never a second payment", async () => {
    const store = memoryRepos();
    const ack = flakyAcknowledgement(3);
    const payment = row({ id: "p1", direction: "credit", ...actionToAxesPatch("transfer", { kind: "transfer", destinationAccountId: "acc-bank" }) });
    await commitReviewImport({ ...baseParams, documentId: DOC, rows: [payment], repositories: store.repositories, onRowCommitted: ack.onRowCommitted });
    const second = await commitReviewImport({ ...baseParams, documentId: DOC, rows: [payment], repositories: store.repositories, onRowCommitted: ack.onRowCommitted });
    expect(second.committedCount).toBe(1);
    expect(store.transactions.size).toBe(2); // one pair
    expect(store.createTransferPair.mock.calls.every(([p]) => p.idempotencyKey === importTransferKey("p1", DOC))).toBe(true);
  });

  it("existing_emi: the replay pays NO second installment and writes NO second expense", async () => {
    const store = memoryRepos({
      installments: [
        { id: "i1", dueDate: new Date("2026-07-01"), amountPaid: 0, amountDue: 100, isSkipped: false },
        { id: "i2", dueDate: new Date("2026-08-01"), amountPaid: 0, amountDue: 100, isSkipped: false },
      ],
    });
    const ack = flakyAcknowledgement(3);
    const emiRow = row({ id: "e1", ...actionToAxesPatch("existing_emi", { kind: "existing_emi", emiId: "emi-1" }) });

    await commitReviewImport({ ...baseParams, documentId: DOC, rows: [emiRow], repositories: store.repositories, onRowCommitted: ack.onRowCommitted });
    const second = await commitReviewImport({ ...baseParams, documentId: DOC, rows: [emiRow], repositories: store.repositories, onRowCommitted: ack.onRowCommitted });

    expect(second.committedCount).toBe(1);
    expect(store.applyPayment).toHaveBeenCalledTimes(1);
    expect(store.installments.map((i) => i.amountPaid)).toEqual([100, 0]); // i2 untouched
    expect(store.transactions.size).toBe(1);
  });

  it("create_emi: the replay creates NO second EMI", async () => {
    const store = memoryRepos();
    const ack = flakyAcknowledgement(3);
    const createRow = row({
      id: "c1",
      ...actionToAxesPatch("create_emi", { kind: "create_emi", name: "New Phone", principalAmount: 1200, interestRatePercent: null, months: 12, startDate: new Date("2026-08-01") }),
    });
    await commitReviewImport({ ...baseParams, documentId: DOC, rows: [createRow], repositories: store.repositories, onRowCommitted: ack.onRowCommitted });
    await commitReviewImport({ ...baseParams, documentId: DOC, rows: [createRow], repositories: store.repositories, onRowCommitted: ack.onRowCommitted });
    expect(store.createEmi).toHaveBeenCalledTimes(1);
    expect(store.applyPayment).toHaveBeenCalledTimes(1);
    expect(store.transactions.size).toBe(1);
  });

  it("shared expense: the replay creates NO second expense / split", async () => {
    const store = memoryRepos();
    const ack = flakyAcknowledgement(3);
    const shared = row({
      id: "s1",
      ...actionToAxesPatch("shared_expense", { kind: "shared_expense", splitType: "equal", participants: [{ personId: null, name: "Me", share: 50, isMe: true }] }),
    });
    await commitReviewImport({ ...baseParams, documentId: DOC, rows: [shared], repositories: store.repositories, onRowCommitted: ack.onRowCommitted });
    const second = await commitReviewImport({ ...baseParams, documentId: DOC, rows: [shared], repositories: store.repositories, onRowCommitted: ack.onRowCommitted });
    expect(second.committedCount).toBe(1);
    expect(store.createExpense).toHaveBeenCalledTimes(1);
    expect(store.transactions.size).toBe(1);
  });

  it("shared expense: a transaction left WITHOUT its split details fails loudly instead of silently committing an expense-less row", async () => {
    const store = memoryRepos();
    // Simulate: the keyed transaction exists but the Expense/ledger writes never landed.
    await store.createTransaction({ idempotencyKey: importTransferKey("s2", DOC), amount: 100, type: "expense", accountId: "acc-card", dateTime: new Date() });
    const shared = row({
      id: "s2",
      ...actionToAxesPatch("shared_expense", { kind: "shared_expense", splitType: "equal", participants: [{ personId: null, name: "Me", share: 50, isMe: true }] }),
    });
    const result = await commitReviewImport({ ...baseParams, documentId: DOC, rows: [shared], repositories: store.repositories, onRowCommitted: vi.fn() });
    expect(result.failedCount).toBe(1);
    expect(result.results[0].error).toMatch(/not its split/);
    expect(store.createExpense).not.toHaveBeenCalled();
  });

  // P0 (2026-10-27): this used to "record afresh" under a generated id — a second copy of money the user deleted.
  it("a row whose earlier import was since DELETED is blocked: nothing written, never resurrected, never a random-id copy", async () => {
    const store = memoryRepos();
    await commitReviewImport({ ...baseParams, documentId: DOC, rows: [row()], repositories: store.repositories, onRowCommitted: flakyAcknowledgement(3).onRowCommitted });
    const [only] = [...store.transactions.values()];
    (only as { deletedAt: Date | null }).deletedAt = new Date();
    const createTransaction = store.createTransaction;
    createTransaction.mockClear();

    const again = await commitReviewImport({ ...baseParams, documentId: DOC, rows: [row()], repositories: store.repositories, onRowCommitted: vi.fn() });
    expect(again.committedCount).toBe(0);
    expect(again.blockedCount).toBe(1);
    expect(again.results[0].blockingReasons?.[0]).toMatchObject({ code: "deleted_import" });
    expect(again.results[0].blockingReasons?.[0].message).toMatch(/restore it from Transactions → Trash/);
    expect(createTransaction).not.toHaveBeenCalled();
    expect(store.transactions.size).toBe(1);
    expect([...store.transactions.values()].filter((t) => t.deletedAt == null)).toHaveLength(0);
  });
});

describe("importTransferKey — statement scoping", () => {
  it("the same staged row id in two different statements never shares a key", () => {
    const docA = "card-1_" + "a".repeat(64);
    const docB = "card-1_" + "b".repeat(64);
    expect(importTransferKey("3", docA)).not.toBe(importTransferKey("3", docB));
    expect(importTransferKey("3", docA)).toBe(importTransferKey("3", docA)); // stable across runs
  });

  it("the same PDF on two different cards never shares a key", () => {
    expect(importTransferKey("3", "card-1_" + "a".repeat(64))).not.toBe(importTransferKey("3", "card-2_" + "a".repeat(64)));
  });

  it("stays within the repository's accepted charset and length", () => {
    const key = importTransferKey("some/odd id:with*chars", "card-1_" + "a".repeat(64));
    expect(key).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
  });

  it("without a documentId it keeps the legacy per-record key", () => {
    expect(importTransferKey("rec/7")).toBe("imp_rec-7");
  });

  it("two statements' row '1' commit to two distinct transactions", async () => {
    const store = memoryRepos();
    const ack = vi.fn();
    await commitReviewImport({ ...baseParams, documentId: "card-1_" + "a".repeat(64), rows: [row({ id: "1" })], repositories: store.repositories, onRowCommitted: ack });
    await commitReviewImport({ ...baseParams, documentId: "card-1_" + "b".repeat(64), rows: [row({ id: "1" })], repositories: store.repositories, onRowCommitted: ack });
    expect(store.transactions.size).toBe(2);
  });
});

describe("EMI installment selection against already-paid installments", () => {
  const emiRow = row({ id: "e1", amount: 100, ...actionToAxesPatch("existing_emi", { kind: "existing_emi", emiId: "emi-1" }) });
  const run = (store: ReturnType<typeof memoryRepos>, r = emiRow) =>
    commitReviewImport({ ...baseParams, documentId: DOC, rows: [r], repositories: store.repositories, onRowCommitted: vi.fn() });

  it("skips fully-paid and skipped installments and pays the earliest genuinely open one", async () => {
    const store = memoryRepos({
      installments: [
        { id: "paid", dueDate: new Date("2026-05-01"), amountPaid: 100, amountDue: 100, isSkipped: false },
        { id: "skipped", dueDate: new Date("2026-06-01"), amountPaid: 0, amountDue: 100, isSkipped: true },
        { id: "open-1", dueDate: new Date("2026-07-01"), amountPaid: 0, amountDue: 100, isSkipped: false },
        { id: "open-2", dueDate: new Date("2026-08-01"), amountPaid: 0, amountDue: 100, isSkipped: false },
      ],
    });
    const result = await run(store);
    expect(result.committedCount).toBe(1);
    expect(store.installments.map((i) => [i.id, i.amountPaid])).toEqual([["paid", 100], ["skipped", 0], ["open-1", 100], ["open-2", 0]]);
  });

  it("applies only what the earliest open installment still owes (part-paid), never over-paying it", async () => {
    const store = memoryRepos({
      installments: [
        { id: "part", dueDate: new Date("2026-07-01"), amountPaid: 70, amountDue: 100, isSkipped: false },
        { id: "next", dueDate: new Date("2026-08-01"), amountPaid: 0, amountDue: 100, isSkipped: false },
      ],
    });
    await run(store);
    expect(store.applyPayment).toHaveBeenCalledWith(expect.objectContaining({ id: "part" }), 30);
    expect(store.installments.map((i) => i.amountPaid)).toEqual([100, 0]);
  });

  it("when every installment is already paid, the row fails and writes NOTHING (no expense without an installment)", async () => {
    const store = memoryRepos({ installments: [{ id: "only", dueDate: new Date("2026-07-01"), amountPaid: 100, amountDue: 100, isSkipped: false }] });
    const result = await run(store);
    expect(result.failedCount).toBe(1);
    expect(result.results[0].error).toMatch(/No open installment/);
    expect(store.transactions.size).toBe(0);
    expect(store.applyPayment).not.toHaveBeenCalled();
  });

  it("a second statement line for the same installment moves on to the NEXT installment (no double-pay of one)", async () => {
    const store = memoryRepos({
      installments: [
        { id: "m1", dueDate: new Date("2026-07-01"), amountPaid: 0, amountDue: 100, isSkipped: false },
        { id: "m2", dueDate: new Date("2026-08-01"), amountPaid: 0, amountDue: 100, isSkipped: false },
      ],
    });
    await run(store, row({ ...emiRow, id: "e1" }));
    await run(store, row({ ...emiRow, id: "e2" }));
    expect(store.installments.map((i) => i.amountPaid)).toEqual([100, 100]);
    expect(store.transactions.size).toBe(2);
  });
});

describe("card-payment imports against payments already recorded", () => {
  const payment = (id: string, overrides: Partial<StagedRecord> = {}) =>
    row({ id, direction: "credit", amount: 5000, counterpartyRaw: "PAYMENT RECEIVED", counterpartyNormalized: "Card Payment", transferDetected: true, date: new Date("2026-07-10T06:30:00.000Z"), ...actionToAxesPatch("transfer", { kind: "transfer", destinationAccountId: "acc-bank" }), ...overrides });
  const leg = (overrides: Partial<Transaction> = {}) =>
    ({ id: "pay-existing", accountId: "acc-card", type: "income", amount: 5000, dateTime: new Date("2026-07-10T06:30:00.000Z"), description: "Credit card bill", transferId: "xfer_manual", deletedAt: null, ...overrides }) as unknown as Transaction;

  it("warns when the same payment is already logged — even titled differently and dated two days earlier", () => {
    const warnings = detectFreshDuplicatesForCommit([payment("p1")], [leg({ dateTime: new Date("2026-07-08T06:30:00.000Z") })], "acc-card", DOC);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].result.bestMatch?.transactionId).toBe("pay-existing");
    expect(warnings[0].result.bestMatch?.reason).toMatch(/twice/);
  });

  it("does not warn for a different amount, a deleted payment, or a payment more than 3 days away", () => {
    expect(detectFreshDuplicatesForCommit([payment("p1")], [leg({ amount: 4999 })], "acc-card", DOC)).toHaveLength(0);
    expect(detectFreshDuplicatesForCommit([payment("p1")], [leg({ deletedAt: new Date() })], "acc-card", DOC)).toHaveLength(0);
    expect(detectFreshDuplicatesForCommit([payment("p1")], [leg({ dateTime: new Date("2026-07-20T06:30:00.000Z") })], "acc-card", DOC)).toHaveLength(0);
  });

  it("does not treat an ordinary same-amount credit (refund) as a payment duplicate", () => {
    const refund = row({ id: "rf", direction: "credit", amount: 5000, ...actionToAxesPatch("refund"), counterpartyNormalized: "Zomato", counterpartyRaw: "ZOMATO", date: new Date("2026-07-10T06:30:00.000Z") });
    const otherDay = detectFreshDuplicatesForCommit([{ ...refund, date: new Date("2026-07-08T06:30:00.000Z") }], [leg()], "acc-card", DOC);
    expect(otherDay).toHaveLength(0);
  });

  it("a row whose own keyed transaction already exists replays silently instead of warning about itself", () => {
    const p = payment("p9");
    const own = leg({ id: `txn_${importTransferKey("p9", DOC)}`, transferId: null as never, type: "expense" as never });
    expect(detectFreshDuplicatesForCommit([row({ id: "p9" })], [{ ...own, description: "Amazon", amount: 100, accountId: "acc-card", dateTime: new Date("2026-07-15T06:30:00.000Z") } as never], "acc-card", DOC)).toHaveLength(0);
    // control: without the document scope the same row IS flagged as a duplicate of that transaction
    expect(detectFreshDuplicatesForCommit([row({ id: "p9" })], [{ ...own, description: "Amazon", amount: 100, accountId: "acc-card", dateTime: new Date("2026-07-15T06:30:00.000Z") } as never], "acc-card")).toHaveLength(1);
    expect(p.id).toBe("p9");
  });

  it("importing a payment through the engine records exactly one pair, and a repeat run records none", async () => {
    const store = memoryRepos();
    const ack = vi.fn();
    await commitReviewImport({ ...baseParams, documentId: DOC, rows: [payment("p1")], repositories: store.repositories, onRowCommitted: ack });
    await commitReviewImport({ ...baseParams, documentId: DOC, rows: [payment("p1")], repositories: store.repositories, onRowCommitted: ack });
    expect(store.transactions.size).toBe(2);
  });
});
