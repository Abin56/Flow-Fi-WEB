// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { buildDraft, clearDraft, loadDraft, restoreDecisions, saveDraft, sourceFingerprint } from "./capture-draft";
import { annotateOcrRows } from "./ocr-review";
import { parsePastedStatement } from "./parse-pasted-statement";
import { applyRowPatch, captureSessionId, toReviewRows, toStagedRecords, type ReviewRow } from "./capture-review";
import { ocrLine, ocrText } from "./ocr-test-helpers";
import { commitReviewImport, detectFreshDuplicatesForCommit, type CommitRepositories } from "@/features/transaction-studio/lib/commit-review-import";
import type { Category } from "@/lib/models/category";
import type { Transaction } from "@/lib/models/transaction";

const TEXT = `05/09/2026  SWIGGY BANGALORE  452.00 Dr
06/09/2026  AMAZON PAY INDIA  1,299.00 Dr
07/09/2026  REFUND MYNTRA  999.00 Cr`;

const rowsFor = (text: string) => toReviewRows(parsePastedStatement(text, { today: new Date(2026, 9, 26) }).rows);

describe("draft recovery (sessionStorage, no financial content)", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it("saves only decisions — never the text, descriptions or amounts", () => {
    const rows = rowsFor(TEXT).map((r) => applyRowPatch(r, { category: "Food" }));
    saveDraft(buildDraft({ sourceText: TEXT, source: "text", stage: "approve", accountId: "acc-1", crop: null, rows }));
    const raw = sessionStorage.getItem("flowfi.smartCapture.draft.v1")!;
    expect(raw).not.toMatch(/SWIGGY|AMAZON|MYNTRA|452|1,299|1299|999|2026/);
    expect(loadDraft()).toMatchObject({ stage: "approve", accountId: "acc-1", rowCount: 3 });
  });

  it("restores decisions when the same text is pasted again (whitespace-insensitive)", () => {
    const rows = rowsFor(TEXT).map((r) => applyRowPatch(r, { category: "Food", include: r.id !== "r2" }));
    rows[0] = applyRowPatch(rows[0], { confirmed: true });
    rows[0] = { ...rows[0], committedTransactionId: "txn_abc" };
    const draft = buildDraft({ sourceText: TEXT, source: "text", stage: "review", accountId: null, crop: null, rows });
    const again = TEXT.replace(/ {2}/g, "\t");
    const restored = restoreDecisions(draft, again, rowsFor(again))!;
    expect(restored.restored).toBe(3);
    expect(restored.rows.map((r) => [r.include, r.category, r.committedTransactionId])).toEqual([
      [true, "Food", "txn_abc"],
      [false, "Food", null],
      [true, "Food", null],
    ]);
    expect(restored.rows[0].confirmed).toBe(true);
  });

  it("does not carry confirmation over for hand-edited rows (their values were never stored)", () => {
    const rows = rowsFor(TEXT);
    rows[1] = applyRowPatch(applyRowPatch(rows[1], { amount: 1300 }), { confirmed: true });
    const draft = buildDraft({ sourceText: TEXT, source: "text", stage: "review", accountId: null, crop: null, rows });
    const restored = restoreDecisions(draft, TEXT, rowsFor(TEXT))!;
    expect(restored.needsRecheck).toBe(1);
    expect(restored.rows[1]).toMatchObject({ amount: 1299, confirmed: false });
  });

  it("refuses to restore onto different text", () => {
    const draft = buildDraft({ sourceText: TEXT, source: "text", stage: "review", accountId: null, crop: null, rows: rowsFor(TEXT) });
    const other = TEXT.replace("452.00", "453.00");
    expect(restoreDecisions(draft, other, rowsFor(other))).toBeNull();
    expect(sourceFingerprint(TEXT)).not.toBe(sourceFingerprint(other));
  });

  it("clears and tolerates corrupt storage", () => {
    sessionStorage.setItem("flowfi.smartCapture.draft.v1", "{not json");
    expect(loadDraft()).toBeNull();
    saveDraft(buildDraft({ sourceText: TEXT, source: "text", stage: "review", accountId: null, crop: null, rows: rowsFor(TEXT) }));
    clearDraft();
    expect(loadDraft()).toBeNull();
  });
});

// ---- Import through Transaction Studio's engine, with a fake repository ----
const CATEGORIES = [
  { id: "c-food", name: "Food", type: "expense" },
  { id: "c-ref", name: "Refunds", type: "income" },
] as unknown as Category[];

type Stored = { id: string; description: string; amount: number };

function fakeRepos(failOnDescription?: string, store = new Map<string, Stored>()) {
  let calls = 0;
  const transactionRepository = {
    async createTransaction(p: { idempotencyKey?: string; description: string; amount: number }) {
      calls++;
      if (failOnDescription && p.description.includes(failOnDescription)) throw new Error("network down");
      const id = `txn_${p.idempotencyKey}`;
      const t = { id, description: p.description, amount: p.amount };
      store.set(id, t);
      return t;
    },
    async getByKey(id: string) {
      const t = store.get(id);
      return t ? { ...t, deletedAt: null } : null;
    },
  };
  const repositories = { transactionRepository, expenseRepository: {}, emiRepository: {}, loanRepository: {}, installmentRepositoryFor: () => ({}) } as unknown as CommitRepositories;
  return { repositories, store, calls: () => calls };
}

function ocrReviewedRows(): ReviewRow[] {
  const lines = [ocrLine(0, ["05/09/2026", "SWIGGY BANGALORE", "452.00 Dr"]), ocrLine(40, ["06/09/2026", "AMAZON PAY", "1,299.00 Dr"])];
  const parsed = parsePastedStatement(ocrText(lines), { today: new Date(2026, 9, 26) });
  return toReviewRows(annotateOcrRows(parsed.rows, lines), "ocr").map((r) => applyRowPatch(r, { confirmed: true, category: "Food" }));
}

async function commit(rows: ReviewRow[], repositories: CommitRepositories, onCommitted: (id: string, txn: string) => void) {
  return commitReviewImport({
    documentId: captureSessionId(rows.map((r) => r.sourceText).join("\n"), "acc-card"),
    rows: toStagedRecords(rows),
    accountId: "acc-card",
    categories: CATEGORIES,
    people: [],
    accounts: [],
    emis: [],
    loans: [],
    bills: [],
    repositories,
    linkRetryDelayMs: 0,
    onRowCommitted: async (id, txn) => onCommitted(id, txn),
  });
}

describe("OCR rows through Studio's commit engine", () => {
  it("partial failure: the failed row is reported, and a retry writes only that row (no duplicates)", async () => {
    let rows = ocrReviewedRows();
    const flaky = fakeRepos("AMAZON");
    const first = await commit(rows, flaky.repositories, (id, txn) => {
      rows = rows.map((r) => (r.id === id ? { ...r, committedTransactionId: txn } : r));
    });
    expect([first.committedCount, first.failedCount]).toEqual([1, 1]);
    expect(first.results.find((r) => r.outcome === "failed")?.error).toMatch(/network down/);

    // Retry against the same store with the network back.
    const retryRepo = fakeRepos(undefined, flaky.store);
    const second = await commit(rows, retryRepo.repositories, (id, txn) => {
      rows = rows.map((r) => (r.id === id ? { ...r, committedTransactionId: txn } : r));
    });
    expect(second.committedCount).toBe(2);
    expect(retryRepo.calls()).toBe(1);
    expect(rows.every((r) => r.committedTransactionId)).toBe(true);
  });

  it("re-importing the same capture replays instead of writing twice", async () => {
    const rows = ocrReviewedRows();
    const repo = fakeRepos();
    await commit(rows, repo.repositories, () => undefined);
    // Draft lost the committed ids (e.g. a new tab) — the idempotency key still prevents a second write.
    const again = await commit(rows, repo.repositories, () => undefined);
    expect(again.committedCount).toBe(2);
    expect(repo.calls()).toBe(2);
    expect(repo.store.size).toBe(2);
  });

  it("flags OCR rows that duplicate an existing transaction before anything is written", () => {
    const staged = toStagedRecords(ocrReviewedRows());
    const existing = [
      { id: "t1", description: "SWIGGY BANGALORE", amount: 452, dateTime: new Date(2026, 8, 5, 21), accountId: "acc-card", type: "expense", deletedAt: null, transferId: null },
    ] as unknown as Transaction[];
    expect(detectFreshDuplicatesForCommit(staged, existing, "acc-card").map((w) => w.recordId)).toEqual(["r1"]);
  });
});
