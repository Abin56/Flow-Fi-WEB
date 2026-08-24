/**
 * Duplicate Detection engine — Statement Intelligence Layer, module 2
 * (post-HDFC-parser task; ADR-007). Pure, deterministic, Firestore-free —
 * takes already-fetched existing records as plain data so it is testable
 * without any database. Detects and marks; never merges, deletes, or
 * modifies a transaction's own fields (only the two duplicate-result
 * fields are ever set). No AI, no fuzzy-matching libraries — every match
 * is one of the four explicit rules below, each producing a human-readable
 * `reason`.
 *
 * Four duplicate types, in the order they are checked (once one type
 * fires for a transaction, no lower-priority type overrides it):
 *
 *  1. STATEMENT DUPLICATE — the whole statement (not a single row) is
 *     already imported: same document hash, OR same card + billing period
 *     + closing balance. If this fires, EVERY transaction in the batch is
 *     marked — checked and applied once for the whole statement, not
 *     per-row (`checkStatementDuplicate`, separate from the per-row API).
 *  2. INTERNAL DUPLICATE — two rows inside the SAME statement share an
 *     identical fingerprint (merchant + amount + calendar day). Both are
 *     marked, referencing each other's `originalRowNumber`.
 *  3. TRANSACTION DUPLICATE — matches an existing, already-imported
 *     transaction on merchant + amount + exact calendar date. Reference
 *     number, when present on the new row, is checked against the
 *     existing record's free-text `description` (the real `Transaction`
 *     model has no structured reference-number field — ADR-007) as a
 *     confidence adjustment, not a hard requirement.
 *  4. NEAR DUPLICATE — merchant + amount match an existing transaction,
 *     but the date differs by up to 1 day (not exact) — a weaker,
 *     lower-confidence signal, exactly for statements where a bank posts
 *     a transaction a day later/earlier than a duplicate submission.
 *
 * Merchant comparison always prefers `normalizedMerchant` (Statement
 * Intelligence Layer module 1) when present, falling back to the raw
 * `merchantRaw` text — both compared case-insensitively.
 */

import { occursAsWholeWord } from "../merchant/merchant-normalizer";
import type { DuplicateCheckResult, WorkspaceTransaction } from "../workspace/statement-workspace-model";
import type { ExistingStatementRecord, ExistingTransactionRecord, StatementMetaForDuplicateCheck } from "./duplicate-types";

const NEAR_DUPLICATE_MAX_DAY_GAP = 1;
const AMOUNT_EPSILON = 0.01;

function normalizeText(str: string): string {
  return str.trim().toUpperCase();
}

function merchantTextOf(transaction: WorkspaceTransaction): string {
  return transaction.normalizedMerchant?.value ?? transaction.merchantRaw.value;
}

function amountsMatch(a: number, b: number): boolean {
  return Math.abs(a - b) <= AMOUNT_EPSILON;
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function daysBetween(a: Date, b: Date): number {
  return Math.abs(Math.round((a.getTime() - b.getTime()) / (24 * 60 * 60 * 1000)));
}

function uniqueResult(overrides: Partial<DuplicateCheckResult> = {}): DuplicateCheckResult {
  return { status: "unique", type: null, matchedTransactionId: null, confidence: 0, reason: "No duplicate found.", ...overrides };
}

/**
 * Statement-level check — run ONCE per statement (not per transaction).
 * Returns non-null when this whole statement appears to already be
 * imported; the caller then marks every transaction with this same result.
 */
export function checkStatementDuplicate(
  statementMeta: StatementMetaForDuplicateCheck,
  existingStatements: ExistingStatementRecord[],
): DuplicateCheckResult | null {
  if (statementMeta.documentHash) {
    const hashMatch = existingStatements.find((s) => s.documentHash != null && s.documentHash === statementMeta.documentHash);
    if (hashMatch) {
      return {
        status: "duplicate_candidate",
        type: "statement_duplicate",
        matchedTransactionId: hashMatch.id,
        confidence: 1,
        reason: `This document's hash matches an already-imported statement (${hashMatch.id}) exactly — this is the same PDF uploaded again.`,
      };
    }
  }

  if (statementMeta.cardId && statementMeta.billingPeriodStart && statementMeta.billingPeriodEnd && statementMeta.closingBalance != null) {
    const periodMatch = existingStatements.find(
      (s) =>
        s.cardId === statementMeta.cardId &&
        s.billingPeriodStart &&
        s.billingPeriodEnd &&
        dayKey(s.billingPeriodStart) === dayKey(statementMeta.billingPeriodStart!) &&
        dayKey(s.billingPeriodEnd) === dayKey(statementMeta.billingPeriodEnd!) &&
        s.closingBalance != null &&
        amountsMatch(s.closingBalance, statementMeta.closingBalance!),
    );
    if (periodMatch) {
      return {
        status: "duplicate_candidate",
        type: "statement_duplicate",
        matchedTransactionId: periodMatch.id,
        confidence: 0.95,
        reason: `Same card, billing period (${dayKey(statementMeta.billingPeriodStart)} to ${dayKey(statementMeta.billingPeriodEnd)}), and closing balance as an already-imported statement (${periodMatch.id}).`,
      };
    }
  }

  return null;
}

/** Marks internal duplicates: two rows inside the SAME statement sharing an identical merchant+amount+day fingerprint. Pure, in-memory — no existing records needed. */
export function detectInternalDuplicates(transactions: WorkspaceTransaction[]): DuplicateCheckResult[] {
  const fingerprintOf = (t: WorkspaceTransaction) => `${normalizeText(merchantTextOf(t))}|${t.amount.value.toFixed(2)}|${dayKey(t.date.value ?? new Date(0))}`;

  const groups = new Map<string, number[]>();
  transactions.forEach((t, index) => {
    const key = fingerprintOf(t);
    const group = groups.get(key) ?? [];
    group.push(index);
    groups.set(key, group);
  });

  const results: DuplicateCheckResult[] = transactions.map(() => uniqueResult());

  for (const indices of groups.values()) {
    if (indices.length < 2) continue;
    for (const index of indices) {
      const otherIndex = indices.find((i) => i !== index)!;
      const other = transactions[otherIndex]!;
      results[index] = {
        status: "duplicate_candidate",
        type: "internal_duplicate",
        matchedTransactionId: `row-${other.originalRowNumber}`,
        confidence: 1,
        reason: `Identical merchant ("${merchantTextOf(transactions[index]!)}"), amount (${transactions[index]!.amount.value}), and date as row ${other.originalRowNumber} in this same statement.`,
      };
    }
  }

  return results;
}

/** Checks one transaction against already-imported transactions for Transaction Duplicate / Near Duplicate. */
export function checkTransactionDuplicate(
  transaction: WorkspaceTransaction,
  existingTransactions: ExistingTransactionRecord[],
): DuplicateCheckResult {
  const merchantText = normalizeText(merchantTextOf(transaction));
  const transactionDate = transaction.date.value;
  const referenceNumber = transaction.referenceNumber.value;

  if (merchantText.length === 0 || transactionDate == null) return uniqueResult();

  const merchantAndAmountMatches = existingTransactions.filter(
    (existing) => occursAsWholeWord(normalizeText(existing.description), merchantText) && amountsMatch(existing.amount, transaction.amount.value),
  );

  const exactDateMatch = merchantAndAmountMatches.find((existing) => dayKey(existing.dateTime) === dayKey(transactionDate));
  if (exactDateMatch) {
    if (referenceNumber == null) {
      return {
        status: "duplicate_candidate",
        type: "transaction_duplicate",
        matchedTransactionId: exactDateMatch.id,
        confidence: 0.9,
        reason: `Same merchant ("${merchantText}"), amount (${transaction.amount.value}), and date (${dayKey(transactionDate)}) as an already-imported transaction (${exactDateMatch.id}). No reference number to further confirm.`,
      };
    }
    const referenceConfirmed = occursAsWholeWord(normalizeText(exactDateMatch.description), normalizeText(referenceNumber));
    return {
      status: "duplicate_candidate",
      type: "transaction_duplicate",
      matchedTransactionId: exactDateMatch.id,
      confidence: referenceConfirmed ? 0.98 : 0.75,
      reason: referenceConfirmed
        ? `Same merchant, amount, and date as an already-imported transaction (${exactDateMatch.id}), and its reference number ("${referenceNumber}") was found in that record's description — strong match.`
        : `Same merchant, amount, and date as an already-imported transaction (${exactDateMatch.id}), but its reference number ("${referenceNumber}") could not be confirmed against that record's description (the existing Transaction model has no structured reference-number field to check directly — ADR-007).`,
    };
  }

  const nearDateMatch = merchantAndAmountMatches
    .map((existing) => ({ existing, dayGap: daysBetween(existing.dateTime, transactionDate) }))
    .filter(({ dayGap }) => dayGap > 0 && dayGap <= NEAR_DUPLICATE_MAX_DAY_GAP)
    .sort((a, b) => a.dayGap - b.dayGap)[0];
  if (nearDateMatch) {
    return {
      status: "duplicate_candidate",
      type: "near_duplicate",
      matchedTransactionId: nearDateMatch.existing.id,
      confidence: 0.6,
      reason: `Same merchant ("${merchantText}") and amount (${transaction.amount.value}) as an already-imported transaction (${nearDateMatch.existing.id}), but the date differs by ${nearDateMatch.dayGap} day(s) — a near match, not confirmed as identical.`,
    };
  }

  return uniqueResult();
}
