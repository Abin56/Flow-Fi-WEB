import { describe, expect, it } from "vitest";
import type { BulkImportResult } from "./import-candidate";
import { bulkImportSummaryText, describePartialImport, isRollbackIncomplete, summarizeBulkImport, type PartialImportNotice } from "./import-messages";

function notice(overrides: Partial<PartialImportNotice> = {}): PartialImportNotice {
  return {
    id: "c1",
    merchant: "Dominos",
    amountText: "₹640",
    failedStep: "person_split",
    peopleRequested: true,
    reusedExisting: false,
    rollbackIncomplete: false,
    ...overrides,
  };
}

describe("summarizeBulkImport — already imported with a skipped person/split", () => {
  it("counts and words the skipped person/split so a retry is never read as a clean success", () => {
    const results: BulkImportResult[] = [
      { candidateId: "a", outcome: { status: "already_imported", transactionId: "t1", changed: false, personAssignmentSkipped: true } },
      { candidateId: "b", outcome: { status: "already_imported", transactionId: "t2", changed: false } },
    ];
    const summary = summarizeBulkImport(results);
    expect(summary.alreadyImported).toBe(2);
    expect(summary.alreadyImportedPersonSkipped).toBe(1);
    expect(bulkImportSummaryText(summary)).toContain("2 already imported earlier (1 without the person/split you chose");
  });
});

describe("describePartialImport", () => {
  it("person/split failure: the transaction exists as a plain expense, balance updated, split not applied, nothing retried", () => {
    const d = describePartialImport(notice());
    const text = [d.title, ...d.facts, ...d.steps].join(" ");
    expect(d.title).toContain("Dominos was imported");
    expect(text).toContain("already exists as a plain expense");
    expect(text).toContain("balance is already updated");
    expect(text).toContain("was not applied");
    expect(text).toContain("Nothing was retried and nothing was recreated");
    expect(text).toMatch(/will not create another transaction/);
    expect(text).not.toMatch(/nothing was created|still pending|try again/i);
    expect(text).not.toContain("People ledger"); // only when the rollback itself failed
  });

  it("person/split failure whose rollback also failed: warns that split entries may remain", () => {
    const text = describePartialImport(notice({ rollbackIncomplete: true })).facts.join(" ");
    expect(text).toContain("Some split entries may remain");
    expect(text).toContain("People ledger");
  });

  it("never carries raw error text — there is no field for it", () => {
    const d = describePartialImport(notice());
    expect(JSON.stringify(d)).not.toMatch(/PERMISSION_DENIED|FirebaseError|firestore|rules?\b/i);
  });

  it("candidate-delete failure: transaction and balance are done; the person/split is reported as applied when one was chosen", () => {
    const d = describePartialImport(notice({ failedStep: "candidate_delete" }));
    const text = [d.title, ...d.facts].join(" ");
    expect(d.title).toContain("still in the queue");
    expect(text).toContain("already exists and your account balance is already updated");
    expect(text).toContain("person or split you chose was applied");
    expect(text).toContain("Only removing the message from the queue did not finish");
  });

  it("candidate-delete failure on a re-import: says no person/split was applied this time", () => {
    const text = describePartialImport(notice({ failedStep: "candidate_delete", reusedExisting: true })).facts.join(" ");
    expect(text).toContain("No person or split was applied this time");
  });

  it("candidate-delete failure when no person was chosen: says nothing about people", () => {
    const text = describePartialImport(notice({ failedStep: "candidate_delete", peopleRequested: false })).facts.join(" ");
    expect(text).not.toMatch(/person|split/i);
  });
});

describe("isRollbackIncomplete", () => {
  it("recognises the repository's own 'couldn't be fully undone' marker and nothing else", () => {
    expect(isRollbackIncomplete(new Error("boom — and it couldn't be fully undone; please check this expense and the people in it."))).toBe(true);
    expect(isRollbackIncomplete(new Error("Choose at least one person to share with"))).toBe(false);
    expect(isRollbackIncomplete("fully undone")).toBe(false);
  });
});

function result(candidateId: string, outcome: BulkImportResult["outcome"]): BulkImportResult {
  return { candidateId, outcome };
}

describe("summarizeBulkImport", () => {
  const results: BulkImportResult[] = [
    result("ok", { status: "success", transactionId: "t1" }),
    result("old", { status: "already_imported", transactionId: "t2", changed: false }),
    result("dup", { status: "duplicate_detected", result: {} as never }),
    result("split", { status: "imported_not_deleted", failedStep: "person_split", transactionId: "t3", error: new Error("x — and it couldn't be fully undone; check") }),
    result("del", { status: "imported_not_deleted", failedStep: "candidate_delete", transactionId: "t4", error: new Error("y"), reusedExisting: true }),
    result("bad", { status: "validation_failed", reason: "Select a category before importing." }),
    result("fail", { status: "transaction_create_failed", error: new Error("z") }),
  ];

  it("counts every outcome separately and truthfully", () => {
    expect(summarizeBulkImport(results)).toMatchObject({ imported: 1, alreadyImported: 1, duplicates: 1, personSplitFailed: 1, deleteFailed: 1, notImported: 2 });
  });

  it("settles only new/already-imported rows; created-but-incomplete rows are tracked apart, flagged duplicates are neither", () => {
    const summary = summarizeBulkImport(results);
    expect(summary.settledIds).toEqual(["ok", "old"]);
    expect(summary.createdButUnsettledIds).toEqual(["split", "del"]);
  });

  it("carries what each partial needs for the persistent notice — and never the error itself", () => {
    const { partials } = summarizeBulkImport(results);
    expect(partials).toEqual([
      { candidateId: "split", failedStep: "person_split", reusedExisting: false, rollbackIncomplete: true },
      { candidateId: "del", failedStep: "candidate_delete", reusedExisting: true, rollbackIncomplete: false },
    ]);
  });

  it("describes what is and isn't committed — a created transaction is never reported as 'failed'", () => {
    const text = bulkImportSummaryText(summarizeBulkImport(results));
    expect(text).toContain("1 imported");
    expect(text).toContain("1 imported but person/split not applied");
    expect(text).toContain("1 imported but still in the queue");
    expect(text).toContain("2 not imported (nothing created)");
    expect(text).toContain("1 held back as possible duplicates (nothing written)");
  });
});
