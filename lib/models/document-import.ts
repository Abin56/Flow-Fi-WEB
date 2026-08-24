/**
 * users/{uid}/documentImports/{importId} (+ /records/{recordId} subcollection)
 * — Architecture v1.0 §10.1, §19, reconciled onto this app's per-user
 * collection convention by docs/adr/ADR-002.
 *
 * This is the staging area the Review Workspace (backlog Milestone 8) reads
 * and edits. Nothing here is live financial data — commit (backlog
 * Milestone 9) is what turns a staged record into a real
 * users/{uid}/transactions/{id} doc via the existing Transaction model.
 */

import type { DocumentData, QueryDocumentSnapshot, SnapshotOptions } from "firebase/firestore";
import { Timestamp } from "firebase/firestore";

export type DocumentImportStatus = "draft" | "reviewing" | "committed" | "discarded";

export interface DocumentImport {
  id: string;
  userId: string;
  documentId: string;
  accountId: string;
  status: DocumentImportStatus;
  /** Snapshot of the parsed metadata (Architecture §10.1's DocumentMetadata shape). */
  metadata: Record<string, unknown>;
  /** Precomputed totals for the Preview screen (Architecture §4.1 Screen 5). */
  summary: Record<string, unknown>;
  createdAt: Date;
}

export type RecordDirection = "debit" | "credit";

export type RecordType =
  | "transaction"
  | "holding"
  | "earningLine"
  | "deductionLine"
  | "installment"
  | "lineItem";

export type StagedExpenseType = "business" | "personal" | "shared";

/**
 * Transaction Studio's Action model (workflow review §3) — split into two
 * independent axes rather than one flat enum, because the old flat
 * `RecordAction` answered "what kind of money movement is this" and "whose
 * money is it" in a single value, which made combinations like a
 * roommate-financed EMI or a business cash withdrawal unrepresentable.
 *
 * `flowType` answers the first question and is what the commit engine
 * dispatches on (which collection family a row writes to).
 */
export type RecordFlowType =
  | "expense"
  | "income"
  | "transfer"
  | "debt_movement"
  | "investment_movement"
  | "reversal"
  | "ignore";

/** Answers "whose money is it" — only meaningful when `flowType` is `expense` or `income`; null otherwise. */
export type RecordOwnership = "mine" | "shared" | "someone_else";

/**
 * Applies independent of `flowType`/`ownership` (workflow review §3). Not
 * nullable — every row has a modifier set, even if every flag is false, so
 * there's always exactly one place these are read from.
 */
export interface RecordModifiers {
  business: boolean;
  recurring: boolean;
  splitByCategory: boolean;
}

export const DEFAULT_RECORD_MODIFIERS: RecordModifiers = { business: false, recurring: false, splitByCategory: false };

/**
 * Derived, UI-facing key — one of the fifteen* choices the Action column
 * presents (architecture §5's table), computed from `flowType`/`ownership`/
 * `actionDetail`/`modifiers` rather than stored directly, so there's no
 * longer a second field that can silently disagree with `ownership`
 * (workflow review §4's `owner`/`action` drift). See
 * `features/transaction-studio/lib/action-metadata.ts` for the
 * derivation (`deriveRecordAction`) and its inverse (`actionToAxesPatch`).
 *
 * *`normal_expense`/`my_expense` collapsed to one value (`normal_expense`) —
 * they mapped to the exact same `(flowType: "expense", ownership: "mine")`
 * pair and had identical display metadata, so keeping both was exactly the
 * redundancy this axis split exists to remove.
 */
export type RecordAction =
  | "normal_expense"
  | "income"
  | "shared_expense"
  | "someone_elses_expense"
  | "transfer"
  | "existing_emi"
  | "create_emi"
  | "existing_loan"
  | "create_loan"
  | "recurring_bill"
  | "investment"
  | "cashback"
  | "refund"
  | "ignore";

export interface SplitParticipantDraft {
  personId: string | null;
  name: string;
  share: number;
  /** Mirrors the real `ExpenseParticipant.isMe` (lib/models/expense.ts) — the reliable way to find "my" share, rather than string-matching on `name`. */
  isMe: boolean;
}

/**
 * Per-Action staging detail (architecture §5's table) — a discriminated
 * union keyed by `kind`, one shape per Action that needs more than the
 * row's own fields. Nothing here is written to a real Emi/Loan/Expense/
 * Transaction record until commit (Transaction Studio's "nothing touches
 * the database until approve" rule) — nested dates are plain `Date`,
 * converted to/from Firestore `Timestamp` the same way the rest of
 * `StagedRecord` is.
 */
export type RecordActionDetail =
  | { kind: "shared_expense"; participants: SplitParticipantDraft[]; splitType: "equal" | "custom" | "percentage" | "none" }
  | { kind: "someone_elses_expense"; personId: string | null; personName: string }
  | { kind: "transfer"; destinationAccountId: string }
  | { kind: "existing_emi"; emiId: string }
  | { kind: "create_emi"; name: string; principalAmount: number; interestRatePercent: number | null; months: number; startDate: Date }
  | { kind: "existing_loan"; loanId: string }
  | { kind: "create_loan"; name: string; loanAmount: number; interestRatePercent: number | null; months: number | null; startDate: Date; personId: string }
  | { kind: "recurring_bill"; billId: string }
  | { kind: "refund"; originalMerchant: string }
  | { kind: "cashback" };

/**
 * Suggestion placeholder shape mirrored from
 * `functions/src/workspace/statement-workspace-model.ts`'s `Suggestion<T>`.
 * Duplicated rather than imported — `lib/` (client SDK) has no existing
 * dependency on `functions/` (admin SDK, separate package), same accepted
 * boundary as `duplicate-lookup-repository.ts`'s collection-name constants.
 */
export interface StagedSuggestion<T> {
  value: T;
  confidence: number;
  source: string;
}

export interface StagedRecord {
  id: string;
  recordType: RecordType;
  rawText: string;
  date: Date;
  counterpartyRaw: string;
  counterpartyNormalized: string | null;
  amount: number;
  direction: RecordDirection;
  referenceNumber: string | null;
  currency: string;
  category: string | null;
  subcategory: string | null;
  /** Per-field confidence scores (Architecture §7) — key is the field name. */
  confidenceScores: Record<string, number>;
  sourcePage: number;
  sourceLineIndex: number;
  /** Split/merge audit trail (Architecture §10 review interaction model). */
  splitParentId: string | null;
  mergedInto: string | null;
  userEdited: boolean;
  /** RFC §28.9 concurrent-edit soft warning (backlog M8-T6). */
  lastEditedAt: Date | null;
  lastEditedBy: string | null;
  tags: string[];
  notes: string;
  /** Duplicate Detection (Architecture §13) — set when a match is found; unresolved until the user acts. */
  duplicateOfTransactionId: string | null;
  /** Whether this row is included in the commit. Defaults true; the user excludes rows via Include/Ignore. */
  include: boolean;
  /** What kind of money movement this row is (workflow review §3). Null until the user reviews the row. */
  flowType: RecordFlowType | null;
  /** Whose money it is — only meaningful when `flowType` is `expense`/`income`. Null until the user sets it, and null for every other flow type. */
  ownership: RecordOwnership | null;
  /** Business/recurring/split-by-category — apply independent of `flowType`/`ownership` (workflow review §3). */
  modifiers: RecordModifiers;
  /** Extra staged fields for flow types that need more than the row's own data (split participants, EMI terms, etc.). */
  actionDetail: RecordActionDetail | null;
  /**
   * Set once this row has been committed to a real record by the
   * client-side commit orchestrator (architecture §7) — the id of the
   * `transactions/{id}` doc it produced (or, for multi-doc outcomes like a
   * split or transfer, the primary/first doc's id). Makes "Approve &
   * Import" safely re-runnable: a retry skips any row that already has
   * this set, rather than double-committing it.
   */
  committedTransactionId: string | null;
  /** Mirrors `Transaction.excludeFromCalculations` — the row still commits normally; the resulting Transaction carries this flag. */
  excludeFromCalculations: boolean;
  /** Mirrors `Transaction.accountingMonth` — null means "use this row's own `date`'s month" once committed. */
  accountingMonth: Date | null;

  // --- Statement Intelligence placeholders (design doc §9) — additive, staging-only ---
  suggestedCategory: StagedSuggestion<string> | null;
  suggestedAccount: StagedSuggestion<string> | null;
  suggestedPerson: StagedSuggestion<string> | null;
  suggestedTags: StagedSuggestion<string>[];
  expenseType: StagedExpenseType | null;
  transferDetected: boolean;
  recurringDetected: boolean;
  subscriptionDetected: boolean;
  duplicateCandidateOf: string | null;
  needsReview: boolean;
}

export function documentImportFromFirestore(
  snapshot: QueryDocumentSnapshot<DocumentData>,
  _options?: SnapshotOptions,
): DocumentImport {
  const data = snapshot.data();
  return {
    id: snapshot.id,
    userId: data.userId as string,
    documentId: data.documentId as string,
    accountId: data.accountId as string,
    status: data.status as DocumentImportStatus,
    metadata: (data.metadata as Record<string, unknown>) ?? {},
    summary: (data.summary as Record<string, unknown>) ?? {},
    createdAt: (data.createdAt as Timestamp).toDate(),
  };
}

export function documentImportToFirestore(docImport: DocumentImport): DocumentData {
  return {
    userId: docImport.userId,
    documentId: docImport.documentId,
    accountId: docImport.accountId,
    status: docImport.status,
    metadata: docImport.metadata,
    summary: docImport.summary,
    createdAt: Timestamp.fromDate(docImport.createdAt),
  };
}

/** `create_emi`/`create_loan` carry a `startDate: Date`, which Firestore stores as a `Timestamp` — every other `RecordActionDetail` kind is plain JSON, safe to round-trip as-is. */
function actionDetailFromFirestore(raw: unknown): RecordActionDetail | null {
  if (raw == null || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;
  if (data.kind === "create_emi" || data.kind === "create_loan") {
    return { ...data, startDate: (data.startDate as Timestamp).toDate() } as RecordActionDetail;
  }
  return data as RecordActionDetail;
}

function actionDetailToFirestore(detail: RecordActionDetail | null): DocumentData | null {
  if (detail == null) return null;
  if (detail.kind === "create_emi" || detail.kind === "create_loan") {
    return { ...detail, startDate: Timestamp.fromDate(detail.startDate) };
  }
  return detail;
}

type StagedRecordFieldSerializers = { [K in keyof StagedRecord]?: (value: StagedRecord[K]) => unknown };

const stagedRecordFieldSerializers: StagedRecordFieldSerializers = {
  date: (v) => Timestamp.fromDate(v),
  lastEditedAt: (v) => (v == null ? null : Timestamp.fromDate(v)),
  accountingMonth: (v) => (v == null ? null : Timestamp.fromDate(v)),
  actionDetail: (v) => actionDetailToFirestore(v),
};

/**
 * Serializes a partial edit (Transaction Studio's inline cell edits, bulk
 * actions) to the exact Firestore shape `updateDoc` needs — only the
 * provided keys, each converted the same way `stagedRecordToFirestore`
 * converts the full record. Never round-trips fields the caller didn't
 * touch, so concurrent edits to different fields on the same row don't
 * clobber each other.
 */
export function stagedRecordPatchToFirestore(patch: Partial<Omit<StagedRecord, "id">>): DocumentData {
  const result: DocumentData = {};
  for (const [key, value] of Object.entries(patch)) {
    const serialize = stagedRecordFieldSerializers[key as keyof StagedRecord] as ((v: unknown) => unknown) | undefined;
    result[key] = serialize ? serialize(value) : value;
  }
  return result;
}

export function stagedRecordFromFirestore(
  snapshot: QueryDocumentSnapshot<DocumentData>,
  _options?: SnapshotOptions,
): StagedRecord {
  const data = snapshot.data();
  return {
    id: snapshot.id,
    recordType: data.recordType as RecordType,
    rawText: data.rawText as string,
    date: (data.date as Timestamp).toDate(),
    counterpartyRaw: data.counterpartyRaw as string,
    counterpartyNormalized: (data.counterpartyNormalized as string | undefined) ?? null,
    amount: data.amount as number,
    direction: data.direction as RecordDirection,
    referenceNumber: (data.referenceNumber as string | undefined) ?? null,
    currency: (data.currency as string) ?? "INR",
    category: (data.category as string | undefined) ?? null,
    subcategory: (data.subcategory as string | undefined) ?? null,
    confidenceScores: (data.confidenceScores as Record<string, number>) ?? {},
    sourcePage: (data.sourcePage as number) ?? 0,
    sourceLineIndex: (data.sourceLineIndex as number) ?? 0,
    splitParentId: (data.splitParentId as string | undefined) ?? null,
    mergedInto: (data.mergedInto as string | undefined) ?? null,
    userEdited: (data.userEdited as boolean) ?? false,
    lastEditedAt: (data.lastEditedAt as Timestamp | undefined)?.toDate() ?? null,
    lastEditedBy: (data.lastEditedBy as string | undefined) ?? null,
    tags: (data.tags as string[]) ?? [],
    notes: (data.notes as string) ?? "",
    duplicateOfTransactionId: (data.duplicateOfTransactionId as string | undefined) ?? null,
    include: (data.include as boolean | undefined) ?? true,
    flowType: (data.flowType as RecordFlowType | undefined) ?? null,
    ownership: (data.ownership as RecordOwnership | undefined) ?? null,
    modifiers: (data.modifiers as RecordModifiers | undefined) ?? DEFAULT_RECORD_MODIFIERS,
    actionDetail: actionDetailFromFirestore(data.actionDetail),
    committedTransactionId: (data.committedTransactionId as string | undefined) ?? null,
    excludeFromCalculations: (data.excludeFromCalculations as boolean | undefined) ?? false,
    accountingMonth: (data.accountingMonth as Timestamp | undefined)?.toDate() ?? null,
    suggestedCategory: (data.suggestedCategory as StagedSuggestion<string> | undefined) ?? null,
    suggestedAccount: (data.suggestedAccount as StagedSuggestion<string> | undefined) ?? null,
    suggestedPerson: (data.suggestedPerson as StagedSuggestion<string> | undefined) ?? null,
    suggestedTags: (data.suggestedTags as StagedSuggestion<string>[] | undefined) ?? [],
    expenseType: (data.expenseType as StagedExpenseType | undefined) ?? null,
    transferDetected: (data.transferDetected as boolean) ?? false,
    recurringDetected: (data.recurringDetected as boolean) ?? false,
    subscriptionDetected: (data.subscriptionDetected as boolean) ?? false,
    duplicateCandidateOf: (data.duplicateCandidateOf as string | undefined) ?? null,
    needsReview: (data.needsReview as boolean) ?? false,
  };
}

export function stagedRecordToFirestore(record: StagedRecord): DocumentData {
  return {
    recordType: record.recordType,
    rawText: record.rawText,
    date: Timestamp.fromDate(record.date),
    counterpartyRaw: record.counterpartyRaw,
    counterpartyNormalized: record.counterpartyNormalized,
    amount: record.amount,
    direction: record.direction,
    referenceNumber: record.referenceNumber,
    currency: record.currency,
    category: record.category,
    subcategory: record.subcategory,
    confidenceScores: record.confidenceScores,
    sourcePage: record.sourcePage,
    sourceLineIndex: record.sourceLineIndex,
    splitParentId: record.splitParentId,
    mergedInto: record.mergedInto,
    userEdited: record.userEdited,
    lastEditedAt: record.lastEditedAt == null ? null : Timestamp.fromDate(record.lastEditedAt),
    lastEditedBy: record.lastEditedBy,
    tags: record.tags,
    notes: record.notes,
    duplicateOfTransactionId: record.duplicateOfTransactionId,
    include: record.include,
    flowType: record.flowType,
    ownership: record.ownership,
    modifiers: record.modifiers,
    actionDetail: actionDetailToFirestore(record.actionDetail),
    committedTransactionId: record.committedTransactionId,
    excludeFromCalculations: record.excludeFromCalculations,
    accountingMonth: record.accountingMonth == null ? null : Timestamp.fromDate(record.accountingMonth),
    suggestedCategory: record.suggestedCategory,
    suggestedAccount: record.suggestedAccount,
    suggestedPerson: record.suggestedPerson,
    suggestedTags: record.suggestedTags,
    expenseType: record.expenseType,
    transferDetected: record.transferDetected,
    recurringDetected: record.recurringDetected,
    subscriptionDetected: record.subscriptionDetected,
    duplicateCandidateOf: record.duplicateCandidateOf,
    needsReview: record.needsReview,
  };
}
