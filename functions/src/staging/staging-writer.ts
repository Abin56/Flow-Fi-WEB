/**
 * Firestore Staging Writer — Statement Intelligence Layer's final stage.
 * Persists a `StatementWorkspaceModel` (the Review Model Builder's output)
 * as a `users/{uid}/documentImports/{importId}` doc plus its `records`
 * subcollection, in the exact shape `lib/models/document-import.ts`'s
 * `DocumentImport`/`StagedRecord` already define for the client SDK side.
 * Mirrors `FirestoreCollections` (lib/firestore/collections.ts) as local
 * constants rather than importing them — `functions/` is a separate
 * npm package (firebase-admin/CommonJS) with no existing path for
 * importing the Next.js app's `lib/`, same accepted duplication as
 * `duplicate-lookup-repository.ts` and `FinancialDocumentStatus` (see
 * docs/parity-matrix.md).
 *
 * Nothing here is live financial data — this only ever writes to the
 * staging collection; the future commit pipeline (Milestone 9, not this
 * task) is what turns a `StagedRecord` into a real
 * `users/{uid}/transactions/{id}` doc.
 *
 * Idempotent by construction: the import doc ID is deterministic
 * (`documentId` itself — a financial document produces at most one
 * staging import), and every record write is a deterministic-ID `set()`
 * keyed by the transaction's own `originalRowNumber`, so re-running this
 * writer for the same document (e.g. a retried worker invocation) replaces
 * the same docs rather than duplicating them. Batched in chunks of 400 to
 * stay under Firestore's 500-writes-per-batch limit with headroom for the
 * parent doc's own write in the same logical operation.
 *
 * B7/B16 (transaction-studio-implementation-roadmap.md) — one-click import
 * needs every row to land with a non-null `flowType`/`ownership` rather than
 * `null` across the board, or the reviewer has to hand-classify every plain
 * debit/credit before Approve & Import can do anything. `defaultActionAxesFor`
 * is the policy: plain debit -> expense/mine, plain credit -> income/mine,
 * overridden to a recurring/bill-linked expense when `recurringDetected`
 * (B16 — the signal is already computed upstream and was otherwise thrown
 * away at review time) or left flowType-null for `transferDetected` (B7 —
 * a transfer needs a destination account the parser can't know, so it stays
 * unset for the reviewer to fill in, rather than guessing a same-owner
 * transfer that's actually a `debt_movement` or an external payment).
 */

import type { Firestore, WriteBatch } from "firebase-admin/firestore";
import { Timestamp } from "firebase-admin/firestore";
import type { StatementWorkspaceModel, WorkspaceTransaction } from "../workspace/statement-workspace-model";

const USERS_COLLECTION = "users";
const DOCUMENT_IMPORTS_COLLECTION = "documentImports";
const DOCUMENT_IMPORT_RECORDS_COLLECTION = "records";
const BATCH_CHUNK_SIZE = 400;

function toTimestampOrNull(date: Date | null): Timestamp | null {
  return date == null ? null : Timestamp.fromDate(date);
}

/** Mirrors `lib/models/document-import.ts`'s `RecordModifiers` — see that file's module doc for why `functions/` duplicates rather than imports `lib/`. */
export interface StagedRecordModifiers {
  business: boolean;
  recurring: boolean;
  splitByCategory: boolean;
}

export interface DefaultActionAxes {
  flowType: "expense" | "income" | null;
  ownership: "mine" | null;
  modifiers: StagedRecordModifiers;
}

const DEFAULT_MODIFIERS: StagedRecordModifiers = { business: false, recurring: false, splitByCategory: false };

/**
 * B7 + B16 default-action-per-direction policy. Never returns `debt_movement`,
 * `transfer`, or any Action needing a linked record the parser can't resolve
 * (EMI/loan/institution) — those stay `flowType: null` so the reviewer picks
 * explicitly rather than the writer guessing wrong and silently committing a
 * misclassified transaction (the exact failure mode B7's roadmap entry warns
 * against: "wrong defaults become committed transactions requiring
 * correction").
 */
export function defaultActionAxesFor(t: Pick<WorkspaceTransaction, "direction" | "recurringDetected" | "transferDetected">): DefaultActionAxes {
  if (t.transferDetected) {
    return { flowType: null, ownership: null, modifiers: DEFAULT_MODIFIERS };
  }
  const flowType = t.direction.value === "credit" ? "income" : "expense";
  if (t.recurringDetected && flowType === "expense") {
    return { flowType, ownership: "mine", modifiers: { ...DEFAULT_MODIFIERS, recurring: true } };
  }
  return { flowType, ownership: "mine", modifiers: DEFAULT_MODIFIERS };
}

function stagedRecordDataFromTransaction(t: WorkspaceTransaction): Record<string, unknown> {
  const defaultAxes = defaultActionAxesFor(t);
  return {
    recordType: "transaction",
    rawText: t.originalRawText,
    date: toTimestampOrNull(t.date.value),
    counterpartyRaw: t.merchantRaw.value,
    counterpartyNormalized: t.normalizedMerchant?.value ?? null,
    amount: t.amount.value,
    direction: t.direction.value,
    referenceNumber: t.referenceNumber.value,
    currency: t.currency.value,
    category: t.suggestedCategory?.value ?? null,
    subcategory: null,
    confidenceScores: {
      date: t.date.confidence,
      merchant: t.merchantRaw.confidence,
      amount: t.amount.confidence,
      direction: t.direction.confidence,
      category: t.suggestedCategory?.confidence ?? 0,
      overall: t.confidence,
    },
    sourcePage: t.sourcePage,
    sourceLineIndex: t.sourceLineIndex,
    splitParentId: null,
    mergedInto: null,
    userEdited: false,
    lastEditedAt: null,
    lastEditedBy: null,
    tags: t.suggestedTags.map((tag) => tag.value),
    notes: "",
    duplicateOfTransactionId: t.duplicateCandidateOf,
    include: true,
    flowType: defaultAxes.flowType,
    ownership: defaultAxes.ownership,
    modifiers: defaultAxes.modifiers,
    actionDetail: null,
    committedTransactionId: null,
    excludeFromCalculations: false,
    accountingMonth: null,
    suggestedCategory: t.suggestedCategory,
    suggestedAccount: t.suggestedAccount,
    suggestedPerson: t.suggestedPerson,
    suggestedTags: t.suggestedTags,
    expenseType: t.expenseType,
    transferDetected: t.transferDetected,
    recurringDetected: t.recurringDetected,
    subscriptionDetected: t.subscriptionDetected,
    duplicateCandidateOf: t.duplicateCandidateOf,
    needsReview: t.needsReview,
  };
}

export interface WriteStagingDocumentsInput {
  uid: string;
  documentId: string;
  accountId: string;
  workspace: StatementWorkspaceModel;
}

export async function writeStagingDocuments(db: Firestore, input: WriteStagingDocumentsInput): Promise<{ importId: string; recordCount: number }> {
  const { uid, documentId, accountId, workspace } = input;
  const importRef = db.collection(USERS_COLLECTION).doc(uid).collection(DOCUMENT_IMPORTS_COLLECTION).doc(documentId);
  const recordsRef = importRef.collection(DOCUMENT_IMPORT_RECORDS_COLLECTION);

  await importRef.set({
    userId: uid,
    documentId,
    accountId,
    status: "draft",
    metadata: {
      statementInfo: workspace.statementInfo,
      cardInfo: workspace.cardInfo,
      billingSummary: workspace.billingSummary,
      diagnostics: workspace.diagnostics,
    },
    summary: {
      confidenceReport: workspace.confidenceReport,
      validationPanel: workspace.validationPanel,
      duplicatePanel: workspace.duplicatePanel,
      reviewQueue: workspace.reviewQueue,
      importStatistics: workspace.importStatistics,
      kpiMetrics: workspace.kpiMetrics,
      categoryTotals: workspace.categoryTotals,
      suggestedSplitRules: workspace.suggestedSplitRules,
      importReadiness: workspace.importReadiness,
    },
    createdAt: Timestamp.now(),
  });

  let batch: WriteBatch = db.batch();
  let opsInBatch = 0;
  for (const t of workspace.transactions) {
    const recordRef = recordsRef.doc(String(t.originalRowNumber));
    batch.set(recordRef, stagedRecordDataFromTransaction(t));
    opsInBatch++;
    if (opsInBatch >= BATCH_CHUNK_SIZE) {
      await batch.commit();
      batch = db.batch();
      opsInBatch = 0;
    }
  }
  if (opsInBatch > 0) {
    await batch.commit();
  }

  return { importId: importRef.id, recordCount: workspace.transactions.length };
}
