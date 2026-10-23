import type { BulkImportResult, ImportFollowUpStep } from "./import-candidate";

/**
 * Honest user-facing copy for an import that created the transaction but not everything after it.
 *
 * The committed state is always spelled out: in both cases the transaction EXISTS and the account balance is already
 * updated, so the copy never says "failed" / "nothing was created". Raw error text (Firestore codes, rule names) is never
 * shown — the only thing taken from the error is whether the split's own rollback also failed, which changes the advice.
 */

/** `ExpenseRepository` appends this when its attempt to undo a half-written split could not finish. */
export function isRollbackIncomplete(error: unknown): boolean {
  return error instanceof Error && /fully undone/i.test(error.message);
}

export interface PartialImportNotice {
  /** The candidate's id — one notice per candidate. */
  id: string;
  merchant: string;
  amountText: string;
  failedStep: ImportFollowUpStep;
  /** The reviewer chose a person or a split for this import. */
  peopleRequested: boolean;
  /** The transaction already existed (imported earlier) — follow-ups are never re-run in that case. */
  reusedExisting: boolean;
  rollbackIncomplete: boolean;
}

export interface PartialImportDescription {
  title: string;
  facts: string[];
  steps: string[];
}

export function describePartialImport(n: PartialImportNotice): PartialImportDescription {
  if (n.failedStep === "person_split") {
    return {
      title: `${n.merchant} was imported, but the person/split was not applied`,
      facts: [
        `The transaction (${n.amountText}) already exists as a plain expense, and your account balance is already updated.`,
        "The person or split you chose was not applied. Nothing was retried and nothing was recreated.",
        ...(n.rollbackIncomplete ? ["Some split entries may remain. Check this expense and the People ledger."] : []),
        "The message is still in the queue.",
      ],
      steps: [
        "Open Transactions, find this expense, and assign or split it there.",
        "Then remove the leftover message from the queue. Importing it again will not create another transaction and will not apply the split.",
      ],
    };
  }
  const peopleLine = !n.peopleRequested
    ? []
    : n.reusedExisting
      ? ["No person or split was applied this time, because this message had been imported before."]
      : ["The person or split you chose was applied."];
  return {
    title: `${n.merchant} was imported, but is still in the queue`,
    facts: [`The transaction (${n.amountText}) already exists and your account balance is already updated.`, ...peopleLine, "Only removing the message from the queue did not finish."],
    steps: ["Remove the message from the queue. Importing it again will not create a duplicate."],
  };
}

export interface BulkImportSummary {
  /** Newly created transactions. */
  imported: number;
  /** Imported earlier — nothing new was written. */
  alreadyImported: number;
  /** Held back as possible duplicates — nothing written for these yet. */
  duplicates: number;
  /** Transaction created, person/split NOT applied. */
  personSplitFailed: number;
  /** Transaction created, candidate document still present. */
  deleteFailed: number;
  /** Not imported at all (validation or create failure) — nothing was created for these. */
  notImported: number;
  /** Rows that no longer need a bulk action (new or already imported). */
  settledIds: string[];
  /** Rows whose transaction exists but that still need attention — never leave these selected for a blind second click. */
  createdButUnsettledIds: string[];
  /** One entry per created-but-incomplete row, for the persistent notice. */
  partials: { candidateId: string; failedStep: ImportFollowUpStep; reusedExisting: boolean; rollbackIncomplete: boolean }[];
}

export function summarizeBulkImport(results: BulkImportResult[]): BulkImportSummary {
  const summary: BulkImportSummary = {
    imported: 0,
    alreadyImported: 0,
    duplicates: 0,
    personSplitFailed: 0,
    deleteFailed: 0,
    notImported: 0,
    settledIds: [],
    createdButUnsettledIds: [],
    partials: [],
  };
  for (const { candidateId, outcome } of results) {
    switch (outcome.status) {
      case "success":
        summary.imported += 1;
        summary.settledIds.push(candidateId);
        break;
      case "already_imported":
        summary.alreadyImported += 1;
        summary.settledIds.push(candidateId);
        break;
      case "duplicate_detected":
        summary.duplicates += 1;
        break;
      case "imported_not_deleted":
        if (outcome.failedStep === "person_split") summary.personSplitFailed += 1;
        else summary.deleteFailed += 1;
        summary.createdButUnsettledIds.push(candidateId);
        summary.partials.push({
          candidateId,
          failedStep: outcome.failedStep,
          reusedExisting: outcome.reusedExisting === true,
          rollbackIncomplete: isRollbackIncomplete(outcome.error),
        });
        break;
      default:
        summary.notImported += 1;
    }
  }
  return summary;
}

/** The toast body for a bulk import — every count says exactly what is and isn't committed. */
export function bulkImportSummaryText(summary: BulkImportSummary): string {
  const parts: string[] = [];
  if (summary.imported > 0) parts.push(`${summary.imported} imported`);
  if (summary.alreadyImported > 0) parts.push(`${summary.alreadyImported} already imported earlier`);
  if (summary.duplicates > 0) parts.push(`${summary.duplicates} held back as possible duplicates (nothing written)`);
  if (summary.personSplitFailed > 0) parts.push(`${summary.personSplitFailed} imported but person/split not applied (details below the header)`);
  if (summary.deleteFailed > 0) parts.push(`${summary.deleteFailed} imported but still in the queue (details below the header)`);
  if (summary.notImported > 0) parts.push(`${summary.notImported} not imported (nothing created)`);
  return parts.join(", ") + ".";
}
