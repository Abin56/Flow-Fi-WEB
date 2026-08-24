/**
 * users/{uid}/financialDocuments/{documentId} — Architecture v1.0 §14, §19
 * (as amended by §14.1/§28.6's array-to-subcollection fix), reconciled onto
 * this app's per-user collection convention by docs/adr/ADR-002.
 *
 * A financialDocuments doc tracks the *upload/parse provenance* of a source
 * PDF — it is not the business record itself. For credit_card_statement,
 * the resulting business record lives at
 * users/{uid}/creditCards/{cardId}/statements/{statementId} (existing
 * collection, ADR-002) and is referenced here via `statementId` once the
 * Import Engine (backlog Milestone 9) commits.
 */

import type { DocumentData, QueryDocumentSnapshot, SnapshotOptions } from "firebase/firestore";
import { Timestamp } from "firebase/firestore";
import type { DocumentType } from "./document-type-registry";

/** docs/state-machine.md is the authoritative reference for every legal transition between these values. */
export type FinancialDocumentStatus =
  | "uploaded"
  | "decrypting"
  | "parsing"
  | "awaiting_password"
  | "parsed"
  | "needs_review"
  | "imported"
  | "failed";

/** docs/state-machine.md §3 — sub-classification of status:"failed", written by the Document Analyzer worker (backlog M2-T2). */
export type FailureReason = "parsing_failed" | "password_required" | "unsupported_document" | "cancelled";

export interface DocumentPeriod {
  start: Date;
  end: Date;
}

export interface ComparisonWithPrevious {
  previousDocumentId: string;
  totalDelta: number;
  categoryDeltas: Record<string, number>;
  newMerchants: string[];
  missingMerchants: string[];
}

export interface AiSummary {
  text: string;
  generatedAt: Date;
  keyFacts: string[];
}

export interface FinancialDocument {
  id: string;
  userId: string;
  documentType: DocumentType;
  /** For credit_card_statement: the users/{uid}/creditCards/{cardId} doc this was uploaded against. */
  accountId: string;
  fileHash: string;
  storagePath: string;
  uploadedAt: Date;
  period: DocumentPeriod | null;
  documentDate: Date | null;
  dueDate: Date | null;
  /** Issuer-printed statement/invoice number, when present — strongest duplicate signal (§13.1). */
  documentNumber: string | null;
  status: FinancialDocumentStatus;
  detectedSource: string | null;
  /** Document-level confidence (§7) — distinct from per-field/per-record scores. */
  parserConfidence: number | null;
  /** documentTypeRegistry entry `version` pinned at parse time (Architecture §30 item 1). */
  registryVersion: number | null;
  /** users/{uid}/documentImports/{importId} of the latest committed import, if any. */
  currentImportId: string | null;
  /** users/{uid}/creditCards/{cardId}/statements/{statementId} once committed (ADR-002). */
  statementId: string | null;
  comparisonWithPrevious: ComparisonWithPrevious | null;
  aiSummary: AiSummary | null;
  /** Written by the Document Analyzer worker on a successful "parsed" transition (docs/state-machine.md T6, backlog M2-T2). */
  pageCount: number | null;
  /** Written on a "failed" transition (docs/state-machine.md T8). */
  failureReason: FailureReason | null;
  failureMessage: string | null;
  /** Written on a "needs_review" transition (docs/state-machine.md T7). */
  needsReviewReason: string | null;
  /** Only set when `needsReviewReason === "unrecognized_statement_template"` — a cheap, best-effort "which bank does this probably belong to" keyword guess (`bank-name-guesser.ts`), for prioritizing which bank to build dedicated parser support for next. Not a real detection — never used for anything beyond that. */
  detectedBankGuess: string | null;
  /** Written on an "awaiting_password" transition (docs/state-machine.md T3a) — true whenever the document is waiting on a password to unlock. */
  requiresPassword: boolean;
  /** Detected/known issuer at parse time, for password-format hints — independent of whatever `pdfAnalyzerConfig` currently says for this card. */
  bank: string | null;
}

export interface ImportHistoryEntry {
  id: string;
  importId: string;
  importedAt: Date;
  importedBy: string;
  status: "committed" | "failed";
  recordsAdded: number;
  recordsSkipped: number;
  recordsMerged: number;
}

export interface VersionHistoryEntry {
  id: string;
  createdAt: Date;
  reason: "reprocess" | "manual_edit" | "source_replaced";
  diffSummary: string;
}

export interface ChangeLogEntry {
  id: string;
  field: string;
  oldValue: string;
  newValue: string;
  changedBy: string;
  changedAt: Date;
}

export function financialDocumentFromFirestore(
  snapshot: QueryDocumentSnapshot<DocumentData>,
  _options?: SnapshotOptions,
): FinancialDocument {
  const data = snapshot.data();
  const period = data.period as { start: Timestamp; end: Timestamp } | undefined;
  return {
    id: snapshot.id,
    userId: data.userId as string,
    documentType: data.documentType as DocumentType,
    accountId: data.accountId as string,
    fileHash: data.fileHash as string,
    storagePath: data.storagePath as string,
    uploadedAt: (data.uploadedAt as Timestamp).toDate(),
    period: period ? { start: period.start.toDate(), end: period.end.toDate() } : null,
    documentDate: (data.documentDate as Timestamp | undefined)?.toDate() ?? null,
    dueDate: (data.dueDate as Timestamp | undefined)?.toDate() ?? null,
    documentNumber: (data.documentNumber as string | undefined) ?? null,
    status: data.status as FinancialDocumentStatus,
    detectedSource: (data.detectedSource as string | undefined) ?? null,
    parserConfidence: (data.parserConfidence as number | undefined) ?? null,
    registryVersion: (data.registryVersion as number | undefined) ?? null,
    currentImportId: (data.currentImportId as string | undefined) ?? null,
    statementId: (data.statementId as string | undefined) ?? null,
    comparisonWithPrevious: (data.comparisonWithPrevious as ComparisonWithPrevious | undefined) ?? null,
    aiSummary: data.aiSummary
      ? {
          text: (data.aiSummary as { text: string }).text,
          generatedAt: (data.aiSummary as { generatedAt: Timestamp }).generatedAt.toDate(),
          keyFacts: (data.aiSummary as { keyFacts: string[] }).keyFacts,
        }
      : null,
    pageCount: (data.pageCount as number | undefined) ?? null,
    failureReason: (data.failureReason as FailureReason | undefined) ?? null,
    failureMessage: (data.failureMessage as string | undefined) ?? null,
    needsReviewReason: (data.needsReviewReason as string | undefined) ?? null,
    detectedBankGuess: (data.detectedBankGuess as string | undefined) ?? null,
    requiresPassword: (data.requiresPassword as boolean | undefined) ?? false,
    bank: (data.bank as string | undefined) ?? null,
  };
}

export function financialDocumentToFirestore(doc: FinancialDocument): DocumentData {
  return {
    userId: doc.userId,
    documentType: doc.documentType,
    accountId: doc.accountId,
    fileHash: doc.fileHash,
    storagePath: doc.storagePath,
    uploadedAt: Timestamp.fromDate(doc.uploadedAt),
    period: doc.period
      ? { start: Timestamp.fromDate(doc.period.start), end: Timestamp.fromDate(doc.period.end) }
      : null,
    documentDate: doc.documentDate == null ? null : Timestamp.fromDate(doc.documentDate),
    dueDate: doc.dueDate == null ? null : Timestamp.fromDate(doc.dueDate),
    documentNumber: doc.documentNumber,
    status: doc.status,
    detectedSource: doc.detectedSource,
    parserConfidence: doc.parserConfidence,
    registryVersion: doc.registryVersion,
    currentImportId: doc.currentImportId,
    statementId: doc.statementId,
    comparisonWithPrevious: doc.comparisonWithPrevious,
    aiSummary: doc.aiSummary
      ? { text: doc.aiSummary.text, generatedAt: Timestamp.fromDate(doc.aiSummary.generatedAt), keyFacts: doc.aiSummary.keyFacts }
      : null,
    pageCount: doc.pageCount,
    failureReason: doc.failureReason,
    failureMessage: doc.failureMessage,
    needsReviewReason: doc.needsReviewReason,
    detectedBankGuess: doc.detectedBankGuess,
    requiresPassword: doc.requiresPassword,
    bank: doc.bank,
  };
}
