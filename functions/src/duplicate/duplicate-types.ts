/**
 * Shared input types for the Duplicate Detection engine (Statement
 * Intelligence Layer, module 2). Kept separate from the engine itself so
 * the Firestore lookup module and the engine can both depend on these
 * without depending on each other.
 *
 * `ExistingTransactionRecord.description` is free text, not a normalized
 * merchant field — the real Flutter-canonical `Transaction` model
 * (lib/models/transaction.ts) has no `merchant`/`referenceNumber` field,
 * only `description` (ADR-007). Every comparison against already-imported
 * transactions in this module is built around that real constraint, not
 * around an idealized shape the actual data doesn't have.
 */

export interface ExistingTransactionRecord {
  id: string;
  description: string;
  amount: number;
  dateTime: Date;
}

export interface ExistingStatementRecord {
  id: string;
  documentHash: string | null;
  billingPeriodStart: Date | null;
  billingPeriodEnd: Date | null;
  cardId: string | null;
  closingBalance: number | null;
}

export interface StatementMetaForDuplicateCheck {
  documentHash: string | null;
  billingPeriodStart: Date | null;
  billingPeriodEnd: Date | null;
  cardId: string | null;
  closingBalance: number | null;
}
