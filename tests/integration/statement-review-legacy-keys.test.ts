/**
 * Legacy Statement Review import keys — read-only investigation, synthetic data, Firestore EMULATOR.
 *
 * Key formats (`importTransferKey` in commit-review-import.ts — not changed here):
 *  - unkeyed (no documentId): single writes get a GENERATED id — not findable by key at all
 *  - legacy, record-only:     `imp_<recordId>` padded to 8 chars → transfers `xfer_imp_1____out|_in`; a pre-scoping build
 *                             that keyed single writes would have produced `txn_imp_1___` (modelled below; the shipped
 *                             history can't be confirmed without git, which this investigation may not use)
 *  - current, document-scoped: `imp_<28-hex document scope>_<recordId>` → `txn_imp_<scope>_1`, `xfer_imp_<scope>_1_out|_in`
 * Staged record ids restart at "1" in every statement document, so a legacy key is SHARED by every statement's row 1.
 * The L-1 cases were reproduced here as failing (double post) and are now regression tests for the Phase C policy.
 */

import { readFileSync } from "node:fs";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, getDocs } from "firebase/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { actionToAxesPatch } from "@/features/transaction-studio/lib/action-metadata";
import { commitReviewImport, detectFreshDuplicatesForCommit, importTransferKey, type CommitRepositories } from "@/features/transaction-studio/lib/commit-review-import";
import { accountFromFirestore, accountToFirestore, type Account } from "@/lib/models/account";
import type { Category } from "@/lib/models/category";
import { DEFAULT_RECORD_MODIFIERS, type StagedRecord } from "@/lib/models/document-import";
import { transactionFromFirestore, transactionToFirestore } from "@/lib/models/transaction";
import { AccountRepository } from "@/lib/repositories/account-repository";
import { transferPairIdsFor, TransactionRepository } from "@/lib/repositories/transaction-repository";

const UID = "legacy-key-owner";
const DOC_A = "card-1_" + "a".repeat(64);
const DOC_B = "card-1_" + "b".repeat(64);
let testEnv: RulesTestEnvironment;
beforeAll(async () => {
  testEnv = await initializeTestEnvironment({ projectId: "flowfi-legacy-keys", firestore: { rules: readFileSync("firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 } });
});
afterAll(async () => {
  await testEnv.cleanup();
});
afterEach(async () => {
  await testEnv.clearFirestore();
});

const category: Category = { id: "cat-shopping", name: "Shopping", type: "expense", iconKey: "x", colorValue: 0, isDefault: false, isActive: true, createdAt: new Date(2026, 0, 1), deletedAt: null, lastEditedAt: null, editHistory: [] };

async function world() {
  const db = testEnv.authenticatedContext(UID).firestore();
  const accounts = new AccountRepository(collection(db, "users", UID, "accounts").withConverter({ toFirestore: accountToFirestore, fromFirestore: accountFromFirestore }));
  const transactionsCol = collection(db, "users", UID, "transactions").withConverter({ toFirestore: transactionToFirestore, fromFirestore: transactionFromFirestore });
  const transactions = new TransactionRepository(transactionsCol, accounts);
  const bank = await accounts.createAccount({ name: "SBI Savings", type: "bank", openingBalance: 10_000, colorValue: 0 });
  const savings = await accounts.createAccount({ name: "Axis Savings", type: "bank", openingBalance: 0, colorValue: 0 });
  const repositories: CommitRepositories = { transactionRepository: transactions, expenseRepository: {} as never, emiRepository: {} as never, loanRepository: {} as never, installmentRepositoryFor: () => { throw new Error("unused"); } };
  const commit = (rows: StagedRecord[], documentId: string | undefined, onRowCommitted: (recordId: string) => Promise<void> = async () => undefined) =>
    commitReviewImport({ documentId, rows, accountId: bank.id, categories: [category], people: [], accounts: [bank as Account], emis: [], loans: [], bills: [], repositories, onRowCommitted, linkRetryDelayMs: 0 });
  const live = async () => (await getDocs(transactionsCol)).docs.map((d) => d.data()).filter((t) => t.deletedAt == null);
  const balance = async () => (await accounts.getByKey(bank.id))!.currentBalance;
  /** A pre-scoping build's keyed single write for staged row `id` (legacy key `imp_<id>`). */
  const legacyKeyedWrite = (row: StagedRecord) =>
    transactions.createTransaction({ type: "expense", amount: row.amount, dateTime: row.date, accountId: bank.id, categoryId: category.id, description: "Amazon", idempotencyKey: importTransferKey(row.id) });
  /** The same legacy keyed write, but with the stored transaction differing from the row (edited later, or another statement's row). */
  const legacyKeyedWriteAs = (row: StagedRecord, o: { description?: string; amount?: number; dateTime?: Date; accountId?: string; type?: "expense" | "income" }) =>
    transactions.createTransaction({ type: o.type ?? "expense", amount: o.amount ?? row.amount, dateTime: o.dateTime ?? row.date, accountId: o.accountId ?? bank.id, categoryId: category.id, description: o.description ?? "Amazon", idempotencyKey: importTransferKey(row.id) });
  /** The current no-documentId transfer path: record-only key `xfer_imp_<id>`. */
  const legacyTransfer = (row: StagedRecord) =>
    commitReviewImport({ documentId: undefined, rows: [row], accountId: bank.id, categories: [category], people: [], accounts: [bank as Account, savings as Account], emis: [], loans: [], bills: [], repositories, onRowCommitted: lostAck, linkRetryDelayMs: 0 });
  const transferRow = (id: string, amount: number): StagedRecord => ({ ...staged(id, amount), ...actionToAxesPatch("transfer", { kind: "transfer", destinationAccountId: savings.id }) });
  const scopedTransfer = (row: StagedRecord) =>
    commitReviewImport({ documentId: DOC_A, rows: [row], accountId: bank.id, categories: [category], people: [], accounts: [bank as Account, savings as Account], emis: [], loans: [], bills: [], repositories, onRowCommitted: async () => undefined, linkRetryDelayMs: 0 });
  const all = async () => (await getDocs(transactionsCol)).docs.map((d) => d.data());
  const softDelete = (t: Awaited<ReturnType<typeof legacyKeyedWrite>>) => transactions.softDeleteTransaction(t);
  return { commit, live, all, balance, softDelete, legacyKeyedWrite, legacyKeyedWriteAs, savingsId: savings.id, legacyTransfer, transferRow, scopedTransfer, bankId: bank.id };
}

function staged(id: string, amount: number): StagedRecord {
  return {
    id, recordType: "transaction", rawText: "AMAZON", date: new Date("2026-07-15T06:30:00.000Z"), counterpartyRaw: "AMAZON", counterpartyNormalized: "Amazon", amount, direction: "debit",
    referenceNumber: null, currency: "INR", category: "Shopping", subcategory: null, confidenceScores: {}, sourcePage: 1, sourceLineIndex: 0, splitParentId: null, mergedInto: null,
    userEdited: false, lastEditedAt: null, lastEditedBy: null, tags: [], notes: "", duplicateOfTransactionId: null, include: true, ...actionToAxesPatch("normal_expense"),
    modifiers: DEFAULT_RECORD_MODIFIERS, committedTransactionId: null, excludeFromCalculations: false, accountingMonth: null, suggestedCategory: null, suggestedAccount: null,
    suggestedPerson: null, suggestedTags: [], expenseType: null, transferDetected: false, recurringDetected: false, subscriptionDetected: false, duplicateCandidateOf: null, needsReview: false,
  };
}
const lostAck = async () => {
  throw new Error("network interrupted");
};

describe("key formats", () => {
  it("legacy keys are record-only (padded), shared by every statement's row 1; scoped keys differ per document", () => {
    expect(importTransferKey("1")).toBe("imp_1___");
    expect(`txn_${importTransferKey("1")}`).toBe("txn_imp_1___");
    expect(transferPairIdsFor(importTransferKey("1"))).toMatchObject({ sourceLegId: "xfer_imp_1____out", destinationLegId: "xfer_imp_1____in" });
    expect(importTransferKey("1", DOC_A)).toMatch(/^imp_[0-9a-f]{28}_1$/);
    expect(importTransferKey("1", DOC_A)).not.toBe(importTransferKey("1", DOC_B));
  });
});

describe("legacy → scoped retry (Phase C: matching legacy imports are blocked for manual review, never auto-resolved)", () => {
  const reasonOf = (r: Awaited<ReturnType<typeof commitReviewImport>>) => r.results[0].blockingReasons?.[0];

  it("L-1a lost acknowledgement under the legacy key txn_imp_1___: the scoped retry is BLOCKED for review — not posted again, not auto-acknowledged", async () => {
    const w = await world();
    await w.legacyKeyedWrite(staged("1", 1499)); // the staged row never got committedTransactionId
    const acks: string[] = [];
    const retry = await commitReviewImportWithAck(w, [staged("1", 1499)], acks);
    expect(reasonOf(retry)).toMatchObject({ code: "import_review" });
    expect(reasonOf(retry)!.message).toMatch(/txn_imp_1___.*same account, amount, date and description/);
    expect(acks).toEqual([]); // never acknowledged from a heuristic match
    expect(await w.live()).toHaveLength(1);
    expect(await w.balance()).toBe(10_000 - 1499);
  });

  it("L-1c a transfer under the legacy xfer_imp key: the scoped retry is BLOCKED — no second transfer", async () => {
    const w = await world();
    await w.legacyTransfer(w.transferRow("1", 2000));
    const retry = await w.scopedTransfer(w.transferRow("1", 2000));
    expect(reasonOf(retry)).toMatchObject({ code: "import_review" });
    expect(await w.live()).toHaveLength(2);
    expect(await w.balance()).toBe(10_000 - 2000);
  });

  it("a DELETED legacy import that matches is blocked too — never restored, never re-posted", async () => {
    const w = await world();
    const legacy = await w.legacyKeyedWrite(staged("1", 1499));
    await w.softDelete(legacy);
    const retry = await w.commit([staged("1", 1499)], DOC_A);
    expect(reasonOf(retry)!.message).toMatch(/was later deleted/);
    expect(await w.live()).toHaveLength(0);
    expect(await w.balance()).toBe(10_000);
    expect((await w.all()).find((t) => t.id === "txn_imp_1___")!.deletedAt).not.toBeNull();
  });

  it("same account + type + SAME DAY under the legacy key is held even when the money differs — an edited amount must not bypass the guard", async () => {
    const w = await world();
    await w.legacyKeyedWrite(staged("1", 1499)); // statement A, row 1
    const result = await w.commit([staged("1", 250)], DOC_B); // could be the same purchase, edited — or another statement's row 1
    expect(reasonOf(result)).toMatchObject({ code: "import_review" });
    expect(reasonOf(result)!.message).toMatch(/amount, date or description differs/);
    expect(await w.live()).toHaveLength(1);
    expect(await w.balance()).toBe(10_000 - 1499);
  });

  it("a different DESCRIPTION on the same day is held; a row 1 day away is held too (inside 36 h)", async () => {
    const w = await world();
    await w.legacyKeyedWrite(staged("1", 1499));
    const otherMerchant = { ...staged("1", 1499), counterpartyNormalized: "Flipkart", counterpartyRaw: "FLIPKART" };
    const nextDay = { ...staged("1", 1499), date: new Date("2026-07-16T06:30:00.000Z") };
    expect(reasonOf(await w.commit([otherMerchant], DOC_B))).toMatchObject({ code: "import_review" });
    expect(reasonOf(await w.commit([nextDay], "card-1_" + "c".repeat(64)))).toMatchObject({ code: "import_review" });
    expect(await w.live()).toHaveLength(1);
  });

  it("same-day repeated purchases: only the row whose own legacy key matches is held; its identical twin (row 2) imports", async () => {
    const w = await world();
    await w.legacyKeyedWrite(staged("1", 1499)); // row 1 of this statement landed under the legacy key, ack lost
    const result = await w.commit([staged("1", 1499), staged("2", 1499)], DOC_A); // two identical Amazon purchases
    expect(result.results.map((r) => r.outcome)).toEqual(["blocked", "committed"]);
    expect(await w.live()).toHaveLength(2);
    expect(await w.balance()).toBe(10_000 - 2 * 1499);
  });

  it("a row whose SCOPED key already landed replays normally — a matching legacy key never second-guesses it", async () => {
    const w = await world();
    await w.commit([staged("1", 1499)], DOC_A, lostAck); // scoped write landed, acknowledgement lost
    await w.legacyKeyedWrite(staged("1", 1499)); // an older legacy copy also exists (another earlier attempt)
    const retry = await w.commit([staged("1", 1499)], DOC_A);
    expect(retry.results[0].outcome).toBe("committed");
    expect(retry.results[0].transactionId).toBe(`txn_${importTransferKey("1", DOC_A)}`);
    expect(await w.live()).toHaveLength(2); // nothing new written by the retry
  });

  it("L-1b an UNKEYED legacy write (generated id) can't be found by key — the pre-commit duplicate check flags the retry instead", async () => {
    const w = await world();
    await w.commit([staged("1", 1499)], undefined, lostAck); // no documentId → generated id, ack lost
    const warnings = detectFreshDuplicatesForCommit([staged("1", 1499)], await w.live(), w.bankId, DOC_A);
    expect(warnings.map((x) => x.recordId)).toEqual(["1"]);
    expect(warnings[0].result.status).toBe("duplicate_candidate");
  });
});

async function commitReviewImportWithAck(w: Awaited<ReturnType<typeof world>>, rows: StagedRecord[], acks: string[]) {
  return w.commit(rows, DOC_A, async (recordId?: string) => {
    acks.push(String(recordId));
  });
}

/**
 * M1 investigation — how the exact-match legacy policy behaves when the legacy key really is this row but the stored
 * transaction no longer matches field-for-field, and when it really is ANOTHER statement's row with the same number.
 * Policy (approved): hold for manual review when the legacy-keyed transaction is on the same account, of the same type,
 * within ±36 h (boundary included); amount and description are NOT compared. Limitation kept on record: a date edited by
 * more than 36 h is not recognised, so this is NOT complete legacy duplicate protection.
 */
describe("M1: legacy-key ambiguity (synthetic)", () => {
  const reasonOf = (r: Awaited<ReturnType<typeof commitReviewImport>>) => r.results[0].blockingReasons?.[0];
  const outcome = (r: Awaited<ReturnType<typeof commitReviewImport>>) => r.results[0].outcome;
  const DAY = 24 * 60 * 60 * 1000;

  // ---- the SAME row, but the legacy transaction no longer matches exactly ----
  it("same row, legacy transaction's DESCRIPTION edited after import (Amazon → 'Amazon - headphones'): should be held", async () => {
    const w = await world();
    const row = staged("1", 1499);
    await w.legacyKeyedWriteAs(row, { description: "Amazon - headphones" });
    expect(outcome(await w.commit([row], DOC_A))).toBe("blocked");
    expect(await w.live()).toHaveLength(1);
  });

  it("same row, legacy AMOUNT corrected after import (1499 → 1500): should be held", async () => {
    const w = await world();
    const row = staged("1", 1499);
    await w.legacyKeyedWriteAs(row, { amount: 1500 });
    expect(outcome(await w.commit([row], DOC_A))).toBe("blocked");
  });

  it("same row, staged time shifted 5:30 (UTC vs IST parsing between builds): should be held", async () => {
    const w = await world();
    const row = staged("1", 1499);
    await w.legacyKeyedWriteAs(row, { dateTime: new Date(row.date.getTime() + 5.5 * 60 * 60 * 1000) });
    expect(outcome(await w.commit([row], DOC_A))).toBe("blocked");
  });

  // ---- a DIFFERENT statement's row with the same number (true collisions) ----
  it("collision: another month's statement, same account, recurring subscription (same amount + merchant, ~30 days later) imports", async () => {
    const w = await world();
    await w.legacyKeyedWrite(staged("1", 649)); // July statement row 1: Netflix-like recurring charge
    const august = { ...staged("1", 649), date: new Date(staged("1", 649).date.getTime() + 31 * DAY) };
    expect(outcome(await w.commit([august], DOC_B))).toBe("committed");
    expect(await w.live()).toHaveLength(2);
  });

  it("collision: another account's statement row 1 (same amount, same day, same merchant) imports", async () => {
    const w = await world();
    await w.legacyKeyedWriteAs(staged("1", 1499), { accountId: w.savingsId });
    expect(outcome(await w.commit([staged("1", 1499)], DOC_B))).toBe("committed");
  });

  it("collision near a statement boundary: same account, ONE day apart, different amount and merchant — HELD (a safe false block, resolved by hand)", async () => {
    const w = await world();
    await w.legacyKeyedWrite(staged("5", 1499)); // last row of a short statement A
    const rowB = { ...staged("5", 320), counterpartyNormalized: "Swiggy", counterpartyRaw: "SWIGGY", date: new Date(staged("5", 320).date.getTime() + DAY) };
    expect(outcome(await w.commit([rowB], DOC_B))).toBe("blocked");
    expect(await w.live()).toHaveLength(1);
  });

  describe("±36 h boundary (same account, same type, different amount and merchant — only the clock decides)", () => {
    const H = 60 * 60 * 1000;
    const MIN = 60 * 1000;
    const base = staged("1", 1499).date.getTime();
    const check = async (offsetMs: number) => {
      const w = await world();
      await w.legacyKeyedWrite(staged("1", 1499));
      const row = { ...staged("1", 77), counterpartyNormalized: "Other", counterpartyRaw: "OTHER", date: new Date(base + offsetMs) };
      return { result: await w.commit([row], DOC_B), live: (await w.live()).length };
    };

    it.each([
      ["35h59m after", 36 * H - MIN],
      ["35h59m before", -(36 * H - MIN)],
      ["exactly 36h after (boundary is held)", 36 * H],
      ["exactly 36h before (boundary is held)", -36 * H],
    ])("%s → held for review, nothing written", async (_label, offset) => {
      const { result, live } = await check(offset);
      expect(reasonOf(result)).toMatchObject({ code: "import_review" });
      expect(live).toBe(1);
    });

    it.each([
      ["36h01m after", 36 * H + MIN],
      ["36h01m before", -(36 * H + MIN)],
      ["31 days after (monthly recurring charge)", 31 * 24 * H],
      ["31 days before", -31 * 24 * H],
    ])("%s → another statement's row: imports", async (_label, offset) => {
      const { result, live } = await check(offset);
      expect(result.results[0].outcome).toBe("committed");
      expect(live).toBe(2);
    });

    it("a 5:30 UTC-vs-IST shift of the same purchase is inside the window (held)", async () => {
      const { result } = await check(5.5 * H);
      expect(reasonOf(result)).toMatchObject({ code: "import_review" });
    });
  });

  it("a held legacy transaction is never touched: not acknowledged, restored, merged or deleted — live or deleted", async () => {
    const w = await world();
    const live = await w.legacyKeyedWrite(staged("1", 1499));
    const acks: string[] = [];
    await w.commit([staged("1", 80)], DOC_A, async (id?: string) => void acks.push(String(id)));
    expect(acks).toEqual([]);
    expect((await w.all()).find((t) => t.id === live.id)).toMatchObject({ deletedAt: null, amount: 1499 });
    await w.softDelete(live);
    const retry = await w.commit([staged("1", 80)], DOC_A);
    expect(reasonOf(retry)).toMatchObject({ code: "import_review" });
    expect(reasonOf(retry)!.message).toMatch(/since deleted/);
    expect((await w.all()).find((t) => t.id === live.id)!.deletedAt).not.toBeNull();
    expect(await w.balance()).toBe(10_000);
  });

  it("a different DIRECTION (credit vs debit) or a different ACCOUNT in the same slot never holds the row, whatever the time", async () => {
    const w = await world();
    await w.legacyKeyedWriteAs(staged("1", 1499), { type: "income" });
    expect((await w.commit([staged("1", 1499)], DOC_A)).results[0].outcome).toBe("committed");
  });

  it("collision: the occupied legacy slot is a CREDIT, this row a debit — imports", async () => {
    const w = await world();
    await w.legacyKeyedWriteAs(staged("1", 1499), { type: "income" });
    expect(outcome(await w.commit([staged("1", 1499)], DOC_B))).toBe("committed");
  });
});
