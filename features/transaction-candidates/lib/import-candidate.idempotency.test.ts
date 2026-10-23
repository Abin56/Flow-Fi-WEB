import { describe, expect, it, vi } from "vitest";
import type { SmsTransactionCandidate } from "@/lib/models/sms-transaction-candidate";
import type { Transaction } from "@/lib/models/transaction";
import { candidateImportKey, importedTransactionId, isKeyedTransactionChangedError } from "./candidate-import-key";
import { bulkImportCandidates, importCandidate, type ImportCandidateParams } from "./import-candidate";
import { deriveCandidatesViewState } from "./candidates-load-state";

function candidate(overrides: Partial<SmsTransactionCandidate> = {}): SmsTransactionCandidate {
  return {
    id: "sms-0001",
    amount: 499,
    direction: "debit",
    eventType: "upiPayment",
    transactionDate: new Date("2026-08-10T10:00:00.000Z"),
    merchant: "Swiggy",
    bankName: "HDFC",
    rawLastFour: "4821",
    accountId: "acc-1",
    cardId: null,
    referenceNumber: null,
    confidenceLevel: "high",
    confidenceScore: 0.9,
    needsReview: false,
    needsReviewReasons: [],
    source: "sms",
    createdAt: new Date("2026-08-10T10:00:00.000Z"),
    deletedAt: null,
    ...overrides,
  };
}

function params(overrides: Partial<ImportCandidateParams> = {}): ImportCandidateParams {
  return { candidate: candidate(), accountId: "acc-1", matchedCard: null, categoryId: "cat-1", ...overrides };
}

/**
 * A fake repository that honours the real `idempotencyKey` contract (`txn_<key>`; same key + same money
 * returns the earlier transaction, different money throws the real error text), so these tests exercise
 * `importCandidate`'s reaction to it. The real contract is pinned against the emulator in
 * tests/integration/sms-candidate-import-idempotency.test.ts.
 */
/** A real retry always begins at least a network round trip after the first attempt wrote its transaction. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

function fakeRepos(opts: { failCreateFor?: Set<string>; failDelete?: boolean } = {}) {
  const store = new Map<string, Transaction>();
  const createTransaction = vi.fn(async (p: { idempotencyKey?: string; amount: number; accountId: string; dateTime: Date; type: "income" | "expense"; description?: string }) => {
    await Promise.resolve();
    if (opts.failCreateFor?.has(p.description ?? "")) throw new Error("network down");
    const id = p.idempotencyKey ? importedTransactionId(p.idempotencyKey) : `txn-${store.size + 1}`;
    const prior = store.get(id);
    if (prior) {
      const same = prior.type === p.type && prior.amount === p.amount && prior.accountId === p.accountId && prior.dateTime.getTime() === p.dateTime.getTime();
      if (!same) throw new Error("This transaction was already saved with different details. Close and reopen it to edit the saved one.");
      return prior;
    }
    const txn = { id, type: p.type, amount: p.amount, accountId: p.accountId, dateTime: p.dateTime, description: p.description ?? "", createdAt: new Date() } as Transaction;
    store.set(id, txn);
    return txn;
  });
  const markHandled = vi.fn(async () => {
    if (opts.failDelete) throw new Error("permission denied");
  });
  const editTransaction = vi.fn(async () => undefined);
  const convertToAssigned = vi.fn(async () => undefined);
  const convertToSplit = vi.fn(async () => undefined);
  return {
    store,
    createTransaction,
    markHandled,
    editTransaction,
    convertToAssigned,
    convertToSplit,
    transactionRepository: { createTransaction, editTransaction } as never,
    candidateRepository: { markHandled } as never,
    expenseRepository: { convertToAssigned, convertToSplit } as never,
  };
}

describe("candidateImportKey", () => {
  it("is stable for the same candidate and distinct for different ones", async () => {
    expect(await candidateImportKey("sms-0001")).toBe(await candidateImportKey("sms-0001"));
    expect(await candidateImportKey("sms-0001")).not.toBe(await candidateImportKey("sms-0002"));
  });

  it("uses a readable key for a well-formed id and always satisfies the repository's key pattern", async () => {
    expect(await candidateImportKey("sms-0001")).toBe("sms_sms-0001");
    for (const id of ["a", "has space/and:odd#chars", "é".repeat(30), "x".repeat(300)]) {
      expect(await candidateImportKey(id)).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
    }
  });

  it("hashes unusable ids deterministically, without colliding with the readable form", async () => {
    const odd = await candidateImportKey("has space");
    expect(odd).toMatch(/^smsh_[0-9a-f]{64}$/);
    expect(odd).toBe(await candidateImportKey("has space"));
    expect(odd).not.toBe(await candidateImportKey("has_space"));
  });

  it("refuses an empty id", async () => {
    await expect(candidateImportKey("")).rejects.toThrow();
  });

  it("recognises the repository's changed-money error", () => {
    expect(isKeyedTransactionChangedError(new Error("This transaction was already saved with different details. Close and reopen it to edit the saved one."))).toBe(true);
    expect(isKeyedTransactionChangedError(new Error("network down"))).toBe(false);
    expect(isKeyedTransactionChangedError("nope")).toBe(false);
  });
});

describe("importCandidate — idempotency", () => {
  it("creates the transaction with a key derived from the candidate id", async () => {
    const r = fakeRepos();
    await importCandidate(params(), r.transactionRepository, r.candidateRepository, r.expenseRepository);
    expect(r.createTransaction).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: "sms_sms-0001", source: "sms" }));
  });

  it("repeated import of the same candidate (retry after a lost response) creates ONE transaction and reports already_imported", async () => {
    const r = fakeRepos();
    const first = await importCandidate(params(), r.transactionRepository, r.candidateRepository, r.expenseRepository);
    await tick();
    const second = await importCandidate(params(), r.transactionRepository, r.candidateRepository, r.expenseRepository);
    expect(first.status).toBe("success");
    expect(second).toMatchObject({ status: "already_imported", changed: false });
    expect(r.store.size).toBe(1);
  });

  it("candidate resurrection with 'Import anyway' (duplicate check skipped) still creates nothing new", async () => {
    const r = fakeRepos();
    await importCandidate(params(), r.transactionRepository, r.candidateRepository, r.expenseRepository);
    await tick();
    const resurrected = await importCandidate(params({ skipDuplicateCheck: true }), r.transactionRepository, r.candidateRepository, r.expenseRepository);
    expect(resurrected.status).toBe("already_imported");
    expect(r.store.size).toBe(1);
    expect(r.markHandled).toHaveBeenCalledTimes(2); // the resurrected document is removed again
  });

  it("does not re-apply a person assignment on a repeat (no second ledger entry)", async () => {
    const r = fakeRepos();
    const assignment = { kind: "assign", personId: "p1", personName: "Asha", owesPersonToggle: true } as const;
    await tick();
    await importCandidate(params({ personAssignment: assignment }), r.transactionRepository, r.candidateRepository, r.expenseRepository);
    expect(r.convertToAssigned).toHaveBeenCalledTimes(1);
    await tick();
    await importCandidate(params({ personAssignment: assignment }), r.transactionRepository, r.candidateRepository, r.expenseRepository);
    expect(r.convertToAssigned).toHaveBeenCalledTimes(1);
  });

  it("an imported transaction edited since (different amount) is reported as changed — still no second transaction", async () => {
    const r = fakeRepos();
    await importCandidate(params(), r.transactionRepository, r.candidateRepository, r.expenseRepository);
    const key = importedTransactionId(await candidateImportKey("sms-0001"));
    r.store.set(key, { ...r.store.get(key)!, amount: 500 });
    await tick();
    const again = await importCandidate(params(), r.transactionRepository, r.candidateRepository, r.expenseRepository);
    expect(again).toMatchObject({ status: "already_imported", changed: true, transactionId: key });
    expect(r.store.size).toBe(1);
    expect(r.editTransaction).not.toHaveBeenCalled();
  });

  it("two simultaneous imports of one candidate (double-click) share one attempt", async () => {
    const r = fakeRepos();
    const [a, b] = await Promise.all([
      importCandidate(params(), r.transactionRepository, r.candidateRepository, r.expenseRepository),
      importCandidate(params(), r.transactionRepository, r.candidateRepository, r.expenseRepository),
    ]);
    expect(r.createTransaction).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(r.store.size).toBe(1);
  });

  it("a failed create leaves the candidate in place and a later retry succeeds exactly once", async () => {
    const failing = new Set(["Swiggy"]);
    const r = fakeRepos({ failCreateFor: failing });
    const failed = await importCandidate(params(), r.transactionRepository, r.candidateRepository, r.expenseRepository);
    expect(failed.status).toBe("transaction_create_failed");
    expect(r.markHandled).not.toHaveBeenCalled();
    failing.clear();
    await tick();
    expect((await importCandidate(params(), r.transactionRepository, r.candidateRepository, r.expenseRepository)).status).toBe("success");
    expect(r.store.size).toBe(1);
  });

  it("if the candidate delete fails after import, the retry settles it as already_imported instead of duplicating", async () => {
    const r = fakeRepos({ failDelete: true });
    const first = await importCandidate(params(), r.transactionRepository, r.candidateRepository, r.expenseRepository);
    expect(first.status).toBe("imported_not_deleted");
    await tick();
    const retry = await importCandidate(params(), r.transactionRepository, r.candidateRepository, r.expenseRepository);
    expect(retry.status).toBe("imported_not_deleted"); // delete still failing — but...
    expect(r.store.size).toBe(1); // ...never a second transaction
  });

  it("the existing duplicate guard still runs first and still needs explicit confirmation", async () => {
    const r = fakeRepos();
    const existing = [{ id: "t-old", description: "Swiggy", amount: 499, dateTime: new Date("2026-08-10T10:00:00.000Z"), accountId: "acc-1", type: "expense" as const }];
    const flagged = await importCandidate(params({ existingTransactions: existing }), r.transactionRepository, r.candidateRepository, r.expenseRepository);
    expect(flagged.status).toBe("duplicate_detected");
    expect(r.createTransaction).not.toHaveBeenCalled();
  });
});

describe("bulkImportCandidates — in-batch duplicate protection", () => {
  const sameDay = new Date("2026-08-10T10:00:00.000Z");

  it("two messages for one real payment (different wording, same amount/day): first imports, second is flagged for review — not written, not dropped", async () => {
    const r = fakeRepos();
    const a = candidate({ id: "sms-bank-1", merchant: "Swiggy", transactionDate: sameDay });
    const b = candidate({ id: "sms-upi-01", merchant: "UPI-SWIGGY ORDER 9921", transactionDate: sameDay });
    const results = await bulkImportCandidates([a, b], "cat-1", [], r.transactionRepository, r.candidateRepository, r.expenseRepository, [], false, { accountId: "acc-1", matchedCard: null });
    expect(results[0].outcome.status).toBe("success");
    expect(results[1].outcome.status).toBe("duplicate_detected");
    expect(r.store.size).toBe(1);
    expect(r.markHandled).toHaveBeenCalledTimes(1); // the flagged candidate is still pending
  });

  it("lookalike candidates are flagged even with no merchant text (amount + exact day)", async () => {
    const r = fakeRepos();
    const a = candidate({ id: "sms-nom-001", merchant: null, bankName: null, transactionDate: sameDay });
    const b = candidate({ id: "sms-nom-002", merchant: null, bankName: null, transactionDate: sameDay });
    const results = await bulkImportCandidates([a, b], "cat-1", [], r.transactionRepository, r.candidateRepository, r.expenseRepository, [], false, { accountId: "acc-1", matchedCard: null });
    expect(results.map((x) => x.outcome.status)).toEqual(["success", "duplicate_detected"]);
  });

  it("legitimately repeated purchases on different days are both imported", async () => {
    const r = fakeRepos();
    const a = candidate({ id: "sms-rep-001", transactionDate: new Date("2026-08-01T10:00:00.000Z") });
    const b = candidate({ id: "sms-rep-002", transactionDate: new Date("2026-08-05T10:00:00.000Z") });
    const results = await bulkImportCandidates([a, b], "cat-1", [], r.transactionRepository, r.candidateRepository, r.expenseRepository, [], false, { accountId: "acc-1", matchedCard: null });
    expect(results.map((x) => x.outcome.status)).toEqual(["success", "success"]);
    expect(r.store.size).toBe(2);
  });

  it("a flagged in-batch repeat can still be imported after explicit confirmation (skipDuplicateCheck)", async () => {
    const r = fakeRepos();
    const a = candidate({ id: "sms-same-001", transactionDate: sameDay });
    const b = candidate({ id: "sms-same-002", transactionDate: sameDay });
    const dest = { accountId: "acc-1", matchedCard: null };
    const first = await bulkImportCandidates([a, b], "cat-1", [], r.transactionRepository, r.candidateRepository, r.expenseRepository, [], false, dest);
    expect(first[1].outcome.status).toBe("duplicate_detected");
    const confirmed = await bulkImportCandidates([b], "cat-1", [], r.transactionRepository, r.candidateRepository, r.expenseRepository, [], true, dest);
    expect(confirmed[0].outcome.status).toBe("success");
    expect(r.store.size).toBe(2);
  });

  it("partial failure: one failed row doesn't block the rest, and re-running the whole batch never re-imports the finished rows", async () => {
    const failing = new Set(["Zomato"]);
    const r = fakeRepos({ failCreateFor: failing });
    const a = candidate({ id: "sms-part-001", merchant: "Swiggy", transactionDate: new Date("2026-08-01T10:00:00.000Z") });
    const b = candidate({ id: "sms-part-002", merchant: "Zomato", amount: 120, transactionDate: new Date("2026-08-02T10:00:00.000Z") });
    const c = candidate({ id: "sms-part-003", merchant: "Uber", amount: 80, transactionDate: new Date("2026-08-03T10:00:00.000Z") });
    const dest = { accountId: "acc-1", matchedCard: null };
    const run1 = await bulkImportCandidates([a, b, c], "cat-1", [], r.transactionRepository, r.candidateRepository, r.expenseRepository, [], false, dest);
    expect(run1.map((x) => x.outcome.status)).toEqual(["success", "transaction_create_failed", "success"]);
    expect(r.store.size).toBe(2);

    failing.clear();
    await tick();
    const run2 = await bulkImportCandidates([a, b, c], "cat-1", [], r.transactionRepository, r.candidateRepository, r.expenseRepository, [], false, dest);
    expect(run2.map((x) => x.outcome.status)).toEqual(["already_imported", "success", "already_imported"]);
    expect(r.store.size).toBe(3); // exactly one transaction per candidate
  });
});

describe("deriveCandidatesViewState", () => {
  it("is loading until the first snapshot — never ready/empty first", () => {
    expect(deriveCandidatesViewState({ hasSnapshot: false, isError: false })).toEqual({ phase: "loading", showErrorNotice: false });
  });
  it("shows the error (not the empty state) when the listener fails before any snapshot", () => {
    expect(deriveCandidatesViewState({ hasSnapshot: false, isError: true })).toEqual({ phase: "error", showErrorNotice: false });
  });
  it("is ready after a snapshot, with an error notice if the listener later fails", () => {
    expect(deriveCandidatesViewState({ hasSnapshot: true, isError: false })).toEqual({ phase: "ready", showErrorNotice: false });
    expect(deriveCandidatesViewState({ hasSnapshot: true, isError: true })).toEqual({ phase: "ready", showErrorNotice: true });
  });
});
