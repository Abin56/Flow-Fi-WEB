/**
 * Import/dismiss orchestrator — turns one reviewed `SmsTransactionCandidate`
 * into a real `Transaction` via the existing `TransactionRepository`, never
 * the other way around: `TransactionRepository.createTransaction` must
 * succeed FIRST; only then is the cloud candidate document deleted.
 *
 * Unlike the earlier, incorrect model this replaces, there is no `status`
 * field to write on the candidate itself — this collection has no
 * web-writable state machine at all (see `sms-transaction-candidate.ts`'s
 * module doc: Android's `SmsCandidateCloudSync` does a full-document
 * overwrite on every sync, so anything the web app wrote in place would be
 * silently clobbered the next time the source SMS is still locally pending
 * on Android). "No longer needs review" can only be expressed by deleting
 * the document, exactly mirroring what Android's own sync already does once
 * an SMS is no longer pending on-device.
 *
 * KNOWN CROSS-PLATFORM LIFECYCLE GAP (see docs/sms-candidate-contract.md):
 * deleting a candidate here only removes it from Firestore. It does not,
 * and cannot, update the on-device Android `SmsInboxItem.status` that
 * `SmsCandidateCloudSync.sync()` reads to decide what to re-upload. If the
 * user later opens the Android app's SMS Inbox screen before separately
 * resolving that SMS there too, Android will re-sync the *same* candidate
 * (same document id) because its local record still reads `pending`. This
 * is a real, inherent gap in the current two-repo design that cannot be
 * closed from the web side alone without an Android-side change (out of
 * scope here). The mitigation implemented on the web side is
 * `evaluateCandidateDuplicate`: a resurrected candidate whose fields match
 * an already-created `Transaction` (`source: "sms"`) is flagged "Possible
 * Duplicate" and blocked from one-click import, turning a silent double
 * import into a visible, user-confirmed decision.
 *
 * DUPLICATE GATE (the actual write-path check, not just a UI-level hint):
 * unless `params.skipDuplicateCheck` is set, this function itself runs the
 * candidate through the same shared `checkForDuplicates` core every other
 * creation path (manual entry, PDF Transaction Studio commit) uses, against
 * whatever `params.existingTransactions` the caller passes in — the source
 * of that existing transaction (manual, PDF, or a prior SMS import) makes no
 * difference, since `checkForDuplicates` has no notion of where an existing
 * `Transaction` came from. A flagged candidate returns `duplicate_detected`
 * with the full `DuplicateDetectionResult` and performs NO writes — the
 * caller is expected to show `DuplicateWarningDialog` and, if the user
 * chooses "Import anyway", call this function again with
 * `skipDuplicateCheck: true`. Putting the check inside the write path itself
 * (rather than only in the surrounding UI, as before) closes the gap where a
 * stale or missing pre-check could let a duplicate slip through silently —
 * every caller of `importCandidate`/`bulkImportCandidates`, present or
 * future, gets this protection for free.
 */

import type { ExpenseParticipantInput, ExpenseRepository } from "@/lib/repositories/expense-repository";
import type { SmsTransactionCandidateRepository } from "@/lib/repositories/sms-transaction-candidate-repository";
import type { TransactionRepository } from "@/lib/repositories/transaction-repository";
import type { SplitType } from "@/lib/models/expense";
import type { SmsTransactionCandidate } from "@/lib/models/sms-transaction-candidate";
import type { CreditCardProfile } from "@/lib/models/credit-card";
import type { Transaction } from "@/lib/models/transaction";
import {
  checkForDuplicates,
  type DuplicateDetectionResult,
  type ExistingTransactionForDuplicateCheck,
} from "@/lib/services/duplicate-detection/duplicate-detection-service";

/**
 * Assigns the brand-new transaction to a person, or splits it across several, in the same single
 * import step — the SMS-candidate equivalent of `TransactionDetailsModal`'s post-save
 * `applyOwesPersonChange`/`convertToSplit` calls. Only ever meaningful for a debit candidate (an
 * "expense" transaction); the caller is responsible for not building this on a credit candidate,
 * same as every other person/split UI in the app.
 */
export type CandidatePersonAssignment =
  | { kind: "assign"; personId: string; personName: string; owesPersonToggle: boolean }
  | { kind: "split"; splitType: SplitType; participantInputs: ExpenseParticipantInput[] };

export interface ImportCandidateParams {
  candidate: SmsTransactionCandidate;
  /** Resolved by the import dialog — pre-filled from `accountId`/`cardId`, editable if unmatched or deleted-since-sync. */
  accountId: string | null;
  /** Present only when `accountId` was resolved from a credit card, so the repository call composes the underlying account the same way `transaction-studio.tsx` already does. */
  matchedCard: CreditCardProfile | null;
  /** Required — Android's Phase 1 deliberately never resolves a FlowFi category at candidate-build time (see the Dart model's module doc), so this always comes from the user. */
  categoryId: string | null;
  notes?: string;
  personAssignment?: CandidatePersonAssignment | null;
  /**
   * Already-loaded existing transactions to check the candidate against before writing — source-
   * agnostic (manual entry, PDF import, and prior SMS imports are all just `Transaction` records to
   * this check, exactly like `checkForDuplicates` itself has no opinion on where they came from).
   * Defaults to `[]` (no check possible) so callers that genuinely have nothing loaded yet — or
   * existing tests exercising unrelated behavior — aren't forced to pass it.
   */
  existingTransactions?: ExistingTransactionForDuplicateCheck[];
  /** Set after the user has already seen `DuplicateWarningDialog` for this exact attempt and chosen "Import anyway" — skips the duplicate gate below and proceeds straight to the write. */
  skipDuplicateCheck?: boolean;
}

export type ImportOutcome =
  | { status: "success"; transactionId: string }
  | { status: "validation_failed"; reason: string }
  /** The candidate matched an existing transaction closely enough to warrant a warning — no writes have happened yet. Re-call with `skipDuplicateCheck: true` to proceed anyway. */
  | { status: "duplicate_detected"; result: DuplicateDetectionResult }
  | { status: "transaction_create_failed"; error: unknown }
  | { status: "imported_not_deleted"; transactionId: string; error: unknown };

/**
 * Adapts one SMS candidate + its resolved destination account into the shared `checkForDuplicates`
 * shape — the same core matching rule (amount epsilon, date window, direction, reference-number
 * confidence boost, cross-account weakening) manual entry and PDF import already run through.
 *
 * When the candidate has neither a `merchant` nor a `bankName` (Android couldn't parse either out of
 * the SMS text — the transaction ends up titled the literal fallback "SMS transaction" on import,
 * see `importCandidate` below), there is no description text to anchor a substring match against, so
 * `requireDescriptionMatch` is set `false` here exactly like manual entry: match on direction/amount
 * and an EXACT same-day date instead of requiring description text to be found in the existing
 * transaction. Skipping the check entirely in this case (as before) let same-amount, same-day
 * candidates with no parsed merchant text import as silent duplicates undetected.
 */
function checkCandidateForDuplicates(
  candidate: SmsTransactionCandidate,
  accountId: string,
  existingTransactions: ExistingTransactionForDuplicateCheck[],
): DuplicateDetectionResult | null {
  if (existingTransactions.length === 0) return null;
  const description = candidate.merchant ?? candidate.bankName ?? "";
  const requireDescriptionMatch = description.trim().length > 0;

  const result = checkForDuplicates(
    {
      description,
      amount: candidate.amount,
      date: candidate.transactionDate,
      direction: candidate.direction,
      accountId,
      referenceNumber: candidate.referenceNumber,
      source: "sms",
      requireDescriptionMatch,
    },
    existingTransactions,
  );
  return result.status === "duplicate_candidate" ? result : null;
}

function resolveAccountId(params: ImportCandidateParams): string | null {
  if (params.matchedCard) return params.matchedCard.accountId;
  return params.accountId;
}

/**
 * Applies a resolved `CandidatePersonAssignment` to a just-created transaction — mirrors the
 * "not owed -> owed" / plain-assign branches of `applyOwesPersonChange` (`owes-person-transition.ts`),
 * simplified because there's never an existing `Expense` to reconcile here: the transaction was
 * created moments ago by this same import. A plain assign with `owesPersonToggle: false` only needs
 * `linkedPersonId` written onto the transaction (no ledger effect); an "owes me" assign or a split
 * both go through `ExpenseRepository`, which writes the schedule/ledger AND the transaction's
 * `linkedPersonId`/`owesPersonToggle` (assign) fields itself.
 */
async function applyPersonAssignment(
  assignment: CandidatePersonAssignment,
  transaction: Transaction,
  candidate: SmsTransactionCandidate,
  categoryId: string,
  accountId: string,
  notes: string,
  transactionRepository: TransactionRepository,
  expenseRepository: ExpenseRepository,
): Promise<void> {
  const description = candidate.merchant ?? candidate.bankName ?? "SMS transaction";

  if (assignment.kind === "assign" && !assignment.owesPersonToggle) {
    await transactionRepository.editTransaction(transaction, { linkedPersonId: assignment.personId, owesPersonToggle: false });
    return;
  }

  if (assignment.kind === "assign") {
    await expenseRepository.convertToAssigned({
      existingExpense: null,
      transactionId: transaction.id,
      description,
      totalAmount: candidate.amount,
      date: candidate.transactionDate,
      categoryId,
      accountId,
      notes,
      personId: assignment.personId,
      personName: assignment.personName,
    });
    return;
  }

  await expenseRepository.convertToSplit({
    existingExpense: null,
    transactionId: transaction.id,
    description,
    totalAmount: candidate.amount,
    date: candidate.transactionDate,
    categoryId,
    accountId,
    notes,
    splitType: assignment.splitType,
    participantInputs: assignment.participantInputs,
  });
}

/**
 * Validates required fields with NO writes, then writes the real
 * Transaction, then applies any person/split assignment, then (only once the
 * transaction fully reflects the user's choices) deletes the cloud candidate.
 */
export async function importCandidate(
  params: ImportCandidateParams,
  transactionRepository: TransactionRepository,
  candidateRepository: SmsTransactionCandidateRepository,
  expenseRepository: ExpenseRepository,
): Promise<ImportOutcome> {
  const accountId = resolveAccountId(params);
  if (accountId == null) return { status: "validation_failed", reason: "Select an account or card before importing." };
  if (params.categoryId == null) return { status: "validation_failed", reason: "Select a category before importing." };

  const { candidate } = params;

  if (!params.skipDuplicateCheck) {
    const duplicateResult = checkCandidateForDuplicates(candidate, accountId, params.existingTransactions ?? []);
    if (duplicateResult) return { status: "duplicate_detected", result: duplicateResult };
  }

  let transaction: Transaction;
  try {
    transaction = await transactionRepository.createTransaction({
      type: candidate.direction === "credit" ? "income" : "expense",
      amount: candidate.amount,
      dateTime: candidate.transactionDate,
      accountId,
      categoryId: params.categoryId,
      description: candidate.merchant ?? candidate.bankName ?? "SMS transaction",
      notes: params.notes ?? "",
      source: "sms",
    });
  } catch (error) {
    // Candidate document is untouched — still present, still safely retryable.
    return { status: "transaction_create_failed", error };
  }
  const transactionId = transaction.id;

  if (params.personAssignment) {
    try {
      await applyPersonAssignment(
        params.personAssignment,
        transaction,
        candidate,
        params.categoryId,
        accountId,
        params.notes ?? "",
        transactionRepository,
        expenseRepository,
      );
    } catch (error) {
      // The transaction exists but without the requested person/split — surfaced as a distinct,
      // non-retryable-via-reimport outcome so the caller can point the user at editing it directly
      // instead of risking a second Transaction from re-running import on the (already-deleted-on-
      // success-only) candidate. Candidate is deliberately left alone: it still hasn't been imported
      // "successfully" from the user's point of view.
      console.error("importCandidate: transaction created but person/split assignment failed", {
        candidateId: candidate.id,
        transactionId,
        error,
      });
      return { status: "imported_not_deleted", transactionId, error };
    }
  }

  try {
    await candidateRepository.deleteById(candidate.id);
    return { status: "success", transactionId };
  } catch (error) {
    // The transaction now exists, but the candidate doc wasn't deleted — it will
    // still show up on next load. `evaluateCandidateDuplicate` is the safety net
    // that prevents this from becoming a second Transaction on retry.
    console.error("importCandidate: transaction created but candidate delete failed", {
      candidateId: candidate.id,
      transactionId,
      error,
    });
    return { status: "imported_not_deleted", transactionId, error };
  }
}

/**
 * Dismisses a candidate without creating a Transaction — deletes the cloud
 * document only. Never calls `createTransaction`. Subject to the same
 * cross-platform resurrection gap documented above, but harmless here since
 * no Transaction is ever created by this path: at worst the SMS reappears
 * for review again after Android's next sync.
 */
export async function ignoreCandidate(
  candidate: SmsTransactionCandidate,
  candidateRepository: SmsTransactionCandidateRepository,
): Promise<void> {
  await candidateRepository.deleteById(candidate.id);
}

export interface BulkIgnoreResult {
  candidateId: string;
  ok: boolean;
  error?: unknown;
}

/**
 * Dismisses each candidate one at a time — never `Promise.all` — so one
 * failure can't abort the rest of the batch. Every candidate gets its own
 * outcome; callers report a "N dismissed, M failed" summary rather than an
 * all-or-nothing result.
 */
export async function bulkIgnoreCandidates(
  candidates: SmsTransactionCandidate[],
  candidateRepository: SmsTransactionCandidateRepository,
): Promise<BulkIgnoreResult[]> {
  const results: BulkIgnoreResult[] = [];
  for (const candidate of candidates) {
    try {
      await ignoreCandidate(candidate, candidateRepository);
      results.push({ candidateId: candidate.id, ok: true });
    } catch (error) {
      results.push({ candidateId: candidate.id, ok: false, error });
    }
  }
  return results;
}

export interface BulkImportResult {
  candidateId: string;
  outcome: ImportOutcome;
}

/**
 * Imports each already-resolved candidate one at a time — never
 * `Promise.all` — using its own `accountId`/`cardId` (no dialog, no user
 * input): only candidates that already carry a resolved account/card and a
 * caller-supplied category are meant to be passed in. A candidate missing
 * either still gets a `validation_failed` outcome with no writes, exactly
 * like the single-row `importCandidate` path, so a caller can safely pass
 * an unfiltered batch and rely on per-row outcomes rather than
 * pre-validating itself. One row's `transaction_create_failed` never stops
 * the rest of the batch, and that row's candidate is left untouched (still
 * present, retryable).
 *
 * `existingTransactions`/`skipDuplicateCheck` pass straight through to each
 * `importCandidate` call — a row flagged as `duplicate_detected` performs no
 * writes and doesn't stop the rest of the batch, exactly like
 * `transaction_create_failed`. Callers implementing a "some rows were
 * flagged" confirmation (see `TransactionCandidatesWorkspace`'s bulk import)
 * re-invoke this function with only the flagged candidates and
 * `skipDuplicateCheck: true` once the user confirms past
 * `DuplicateWarningDialog`, rather than this function silently retrying.
 */
export async function bulkImportCandidates(
  candidates: SmsTransactionCandidate[],
  categoryId: string,
  creditCards: CreditCardProfile[],
  transactionRepository: TransactionRepository,
  candidateRepository: SmsTransactionCandidateRepository,
  expenseRepository: ExpenseRepository,
  existingTransactions: ExistingTransactionForDuplicateCheck[] = [],
  skipDuplicateCheck = false,
  /**
   * When set, every candidate is imported into this single destination (picked once by the user in
   * the bulk-import popup) instead of each candidate's own `accountId`/`cardId` — this is what lets
   * a batch of candidates whose destination Android couldn't resolve still import in one action,
   * rather than each falling through to `validation_failed` and forcing a one-by-one retry.
   */
  forcedDestination?: { accountId: string | null; matchedCard: CreditCardProfile | null },
  /**
   * When set, applied to every debit candidate in the batch — the bulk-import popup's own
   * Person/Split section, same shape `CandidateDetailsModal` builds for a single candidate. Never
   * applied to a credit candidate (income), same rule `resolvePersonAssignment` enforces there.
   */
  personAssignment?: CandidatePersonAssignment | null,
): Promise<BulkImportResult[]> {
  const results: BulkImportResult[] = [];
  for (const candidate of candidates) {
    const resolvedPersonAssignment = candidate.direction === "debit" ? (personAssignment ?? null) : null;
    let outcome: ImportOutcome;
    if (forcedDestination) {
      outcome = await importCandidate(
        {
          candidate,
          accountId: forcedDestination.accountId,
          matchedCard: forcedDestination.matchedCard,
          categoryId,
          personAssignment: resolvedPersonAssignment,
          existingTransactions,
          skipDuplicateCheck,
        },
        transactionRepository,
        candidateRepository,
        expenseRepository,
      );
    } else {
      const matchedCard = candidate.cardId ? (creditCards.find((c) => c.id === candidate.cardId) ?? null) : null;
      outcome =
        candidate.cardId != null && matchedCard == null
          ? ({ status: "validation_failed", reason: "Matched card could not be resolved." } as ImportOutcome)
          : await importCandidate(
              {
                candidate,
                accountId: matchedCard ? null : candidate.accountId,
                matchedCard,
                categoryId,
                personAssignment: resolvedPersonAssignment,
                existingTransactions,
                skipDuplicateCheck,
              },
              transactionRepository,
              candidateRepository,
              expenseRepository,
            );
    }
    results.push({ candidateId: candidate.id, outcome });
  }
  return results;
}
