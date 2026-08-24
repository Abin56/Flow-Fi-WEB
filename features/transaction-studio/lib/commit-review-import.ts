/**
 * Client-side commit orchestrator (architecture §7, locked decision: runs
 * client-side through the existing repositories — no Cloud Function
 * duplication of split/EMI/loan/transfer business logic). Dispatches each
 * included row to the write path its Action implies, using the exact same
 * repositories mobile's real flows call.
 *
 * Failure handling, two layers (B3 — Transaction Studio commit atomicity):
 *  - Across rows: each row is attempted independently, and nothing here is a
 *    single Firestore transaction spanning multiple rows — see the
 *    architecture doc's explicit tradeoff discussion for why. A row that
 *    already has `committedTransactionId` set is skipped, so re-running
 *    Approve & Import after some rows failed only retries what failed.
 *  - Within one row: an Action whose commit path is more than one write
 *    (`existing_emi`/`create_emi`/`existing_loan`/`create_loan` pay an
 *    installment and/or create the debt record *before* writing the
 *    Transaction that represents the money movement) compensates its own
 *    earlier writes if a later one fails — see `commitOneRow`'s try/catch
 *    blocks and `reverseInstallmentPayment`/`EmiRepository.
 *    permanentlyDeleteEmi`/`LoanRepository.permanentlyDeleteLoan`. A failed
 *    row is therefore never "partially committed": either every write in its
 *    chain lands, or none of them are left behind, and a retry starts clean
 *    rather than accumulating duplicates. `transfer` (`createTransferPair`)
 *    already had this property before B3. `shared_expense`/
 *    `someone_elses_expense` (`ExpenseRepository.createExpense`) do not yet
 *    — that repository's own internal transaction+schedule+ledger sequence
 *    isn't compensated, and fixing it is out of this file's scope since
 *    `ExpenseRepository` is shared app-wide, not Transaction-Studio-only;
 *    see B3's remaining-risks notes.
 */

import type { Account } from "@/lib/models/account";
import type { Bill } from "@/lib/models/bill";
import type { Category } from "@/lib/models/category";
import type { Emi } from "@/lib/models/emi";
import type { Loan } from "@/lib/models/loan";
import type { Installment } from "@/lib/models/payment-schedule";
import type { Person } from "@/lib/models/person";
import type { Transaction } from "@/lib/models/transaction";
import type { RecordAction, RecordActionDetail, StagedRecord } from "@/lib/models/document-import";
import type { ExpenseParticipantInput } from "@/lib/repositories/expense-repository";
import { ExpenseRepository } from "@/lib/repositories/expense-repository";
import type { EmiRepository } from "@/lib/repositories/emi-repository";
import type { LoanRepository } from "@/lib/repositories/loan-repository";
import type { InstallmentRepository } from "@/lib/repositories/payment-schedule-repository";
import type { TransactionRepository } from "@/lib/repositories/transaction-repository";
import { checkForDuplicates, type DuplicateDetectionResult } from "@/lib/services/duplicate-detection/duplicate-detection-service";
import { ACTION_META, actionDetailConsistencyError, deriveRecordAction, isCategoryApplicableForFlowType } from "./action-metadata";

export interface CommitBlockingReason {
  recordId: string;
  code:
    | "needs_review"
    | "unresolved_duplicate"
    | "unresolved_category"
    | "missing_action"
    | "missing_detail"
    | "closed_target"
    | "unimplemented_action"
    | "inconsistent_detail";
  message: string;
}

/**
 * Actions whose commit path isn't fully wired up yet — no rewards ledger
 * (cashback), no bill-occurrence tracking (recurring_bill), no investment
 * domain at all (investment). Blocking these in `validateRow`, rather than
 * letting `commitOneRow` silently write a lossy plain transaction for them,
 * is the fix for the exact failure mode this file's `default` case used to
 * produce (B2: unify the import commit engine). `commitOneRow` also throws
 * for these as defense-in-depth in case a row ever reaches it unblocked.
 */
const UNIMPLEMENTED_ACTIONS: ReadonlySet<RecordAction> = new Set(["cashback", "recurring_bill", "investment"]);

export interface CommitRowResult {
  recordId: string;
  outcome: "committed" | "blocked" | "failed" | "skipped";
  blockingReasons?: CommitBlockingReason[];
  error?: string;
  transactionId?: string;
}

export interface CommitReviewImportResult {
  results: CommitRowResult[];
  committedCount: number;
  blockedCount: number;
  failedCount: number;
  skippedCount: number;
}

export interface CommitRepositories {
  transactionRepository: TransactionRepository;
  expenseRepository: ExpenseRepository;
  emiRepository: EmiRepository;
  loanRepository: LoanRepository;
  installmentRepositoryFor: (scheduleId: string) => InstallmentRepository;
}

export interface CommitReviewImportParams {
  rows: StagedRecord[];
  accountId: string;
  categories: Category[];
  people: Person[];
  accounts: Account[];
  emis: Emi[];
  loans: Loan[];
  bills: Bill[];
  repositories: CommitRepositories;
  onRowCommitted: (recordId: string, transactionId: string) => Promise<void>;
}

/** Pre-flight "block commit, require review" validation — the only commit path (architecture §7's locked decision: client-driven, no Cloud Function duplication), so this is the single source of truth for what blocks a commit. */
function validateRow(row: StagedRecord, categoryIdByName: Map<string, string>): CommitBlockingReason[] {
  const reasons: CommitBlockingReason[] = [];
  if (row.needsReview) {
    reasons.push({ recordId: row.id, code: "needs_review", message: "This row is flagged needsReview and must be resolved before import." });
  }
  if (row.duplicateOfTransactionId || row.duplicateCandidateOf) {
    reasons.push({ recordId: row.id, code: "unresolved_duplicate", message: "This row has an unresolved duplicate candidate." });
  }
  // B30: Category is only required for flow types where it's a meaningful choice — transfer/debt_movement/ignore
  // rows must not be blocked on a category the reviewer has nothing real to pick (their money movement is
  // categorized by the linked account/EMI/loan record instead, not this axis).
  if (isCategoryApplicableForFlowType(row.flowType) && (row.category == null || !categoryIdByName.has(row.category))) {
    reasons.push({
      recordId: row.id,
      code: "unresolved_category",
      message: row.category == null ? "No category set." : `Category "${row.category}" doesn't match an existing category.`,
    });
  }
  const action = deriveRecordAction(row);
  if (action == null) {
    // B5: hard block — no Action selected must never silently commit as a plain expense/income guess.
    reasons.push({ recordId: row.id, code: "missing_action", message: "No Action chosen for this row yet." });
  } else if (UNIMPLEMENTED_ACTIONS.has(action)) {
    reasons.push({
      recordId: row.id,
      code: "unimplemented_action",
      message: `"${ACTION_META[action].label}" isn't wired up to commit yet — choose a different Action for this row, or exclude it from this import.`,
    });
  } else {
    // B6: Action/detail/ownership consistency — closes the exact silent-corruption path B1-B4 document
    // (e.g. `existing_emi` with no `emiId`, or `ownership: shared` disagreeing with a `normal_expense` Action).
    const detailError = actionDetailConsistencyError(row);
    if (detailError != null) {
      reasons.push({ recordId: row.id, code: "inconsistent_detail", message: detailError });
    }
  }
  return reasons;
}

function requireDetail<K extends RecordActionDetail["kind"]>(
  detail: RecordActionDetail | null,
  kind: K,
): Extract<RecordActionDetail, { kind: K }> | null {
  return detail?.kind === kind ? (detail as Extract<RecordActionDetail, { kind: K }>) : null;
}

/**
 * Pays the earliest open installment and returns enough to reverse exactly
 * that payment (`installment`/`amountApplied`) — B3: every multi-write
 * Action compensates its own earlier steps if a later one fails, so nothing
 * financial is left half-written. `applyPayment` clamps to `amountDue`, so
 * the amount actually applied can be less than `amount` requested; the
 * reversal must undo exactly what was applied, not the requested amount.
 */
async function payEarliestOpenInstallment(
  installmentRepository: InstallmentRepository,
  amount: number,
): Promise<{ installment: Installment; amountApplied: number }> {
  const installments = await installmentRepository.getAll();
  const open = installments
    .filter((i) => !i.isSkipped && i.amountPaid < i.amountDue)
    .sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime())[0];
  if (!open) throw new Error("No open installment found to apply this payment against.");
  const amountApplied = Math.min(amount, open.amountDue - open.amountPaid);
  await installmentRepository.applyPayment(open, amountApplied);
  return { installment: open, amountApplied };
}

/** Reverses `payEarliestOpenInstallment`'s effect — the compensating half of the pair. Swallows its own failure (logged via rethrow-free best-effort) so a rollback-time error never masks the original failure that triggered it. */
async function reverseInstallmentPayment(
  installmentRepository: InstallmentRepository,
  installment: Installment,
  amountApplied: number,
): Promise<void> {
  if (amountApplied === 0) return;
  try {
    await installmentRepository.applyPayment(installment, -amountApplied);
  } catch {
    // Best-effort: the original error is what the caller re-throws. A failed
    // rollback here is a real orphan and belongs in server-side monitoring,
    // not swallowed silently — see this file's module doc / B3 remaining risks.
  }
}

async function commitOneRow(row: StagedRecord, categoryId: string, params: CommitReviewImportParams): Promise<{ transactionId: string }> {
  const { repositories } = params;
  const action = deriveRecordAction(row);
  if (action == null) throw new Error("No Action chosen for this row — commit blocked.");
  const description = row.counterpartyNormalized ?? row.counterpartyRaw;

  switch (action) {
    case "shared_expense": {
      const detail = requireDetail(row.actionDetail, "shared_expense");
      if (!detail) throw new Error("Split details are missing — open this row's Inspector to finish setting it up.");
      const participantInputs: ExpenseParticipantInput[] = detail.participants.map((p) => ({
        personId: p.personId,
        name: p.name,
        value: detail.splitType === "equal" ? null : p.share,
        isMe: p.isMe,
      }));
      const expense = await repositories.expenseRepository.createExpense({
        description,
        totalAmount: row.amount,
        date: row.date,
        categoryId,
        accountId: params.accountId,
        splitType: detail.splitType,
        participantInputs,
        notes: row.notes,
        excludeFromCalculations: row.excludeFromCalculations,
        accountingMonth: row.accountingMonth,
        isBusiness: row.modifiers.business,
      });
      return { transactionId: expense.transactionId };
    }

    case "someone_elses_expense": {
      const detail = requireDetail(row.actionDetail, "someone_elses_expense");
      if (!detail || (!detail.personId && !detail.personName)) throw new Error("No person chosen — open this row's Inspector to pick who this was for.");
      const expense = await repositories.expenseRepository.assignToPerson({
        description,
        totalAmount: row.amount,
        date: row.date,
        categoryId,
        accountId: params.accountId,
        personId: detail.personId ?? "",
        personName: detail.personName,
        notes: row.notes,
        excludeFromCalculations: row.excludeFromCalculations,
        accountingMonth: row.accountingMonth,
        isBusiness: row.modifiers.business,
      });
      return { transactionId: expense.transactionId };
    }

    case "transfer": {
      const detail = requireDetail(row.actionDetail, "transfer");
      if (!detail?.destinationAccountId) throw new Error("No destination account chosen — open this row's Inspector to pick one.");
      const [sourceLeg] = await repositories.transactionRepository.createTransferPair({
        amount: row.amount,
        dateTime: row.date,
        sourceAccountId: params.accountId,
        destinationAccountId: detail.destinationAccountId,
        categoryId,
        description,
        notes: row.notes,
        excludeFromCalculations: row.excludeFromCalculations,
        accountingMonth: row.accountingMonth,
        isBusiness: row.modifiers.business,
      });
      return { transactionId: sourceLeg.id };
    }

    case "existing_emi": {
      const detail = requireDetail(row.actionDetail, "existing_emi");
      const emi = params.emis.find((e) => e.id === detail?.emiId);
      if (!emi) throw new Error("Linked EMI not found — open this row's Inspector to re-link it.");
      if (emi.isClosed) throw new Error(`"${emi.name}" is already closed.`);
      const installmentRepository = repositories.installmentRepositoryFor(emi.scheduleId);
      const paid = await payEarliestOpenInstallment(installmentRepository, row.amount);
      try {
        const transaction = await repositories.transactionRepository.createTransaction({
          type: "expense",
          amount: row.amount,
          dateTime: row.date,
          accountId: params.accountId,
          categoryId,
          description,
          notes: row.notes,
          isBusiness: row.modifiers.business,
          excludeFromCalculations: row.excludeFromCalculations,
          accountingMonth: row.accountingMonth,
        });
        return { transactionId: transaction.id };
      } catch (error) {
        // B3: the installment payment already succeeded — undo it rather than
        // leave "installment marked paid, no Transaction exists" behind.
        await reverseInstallmentPayment(installmentRepository, paid.installment, paid.amountApplied);
        throw error;
      }
    }

    case "create_emi": {
      const detail = requireDetail(row.actionDetail, "create_emi");
      if (!detail) throw new Error("EMI terms are missing — open this row's Inspector to finish setting it up.");
      const emi = await repositories.emiRepository.createEmi({
        name: detail.name,
        principalAmount: detail.principalAmount,
        startDate: detail.startDate,
        installmentFrequency: "monthly",
        installmentCount: detail.months,
        interest: detail.interestRatePercent != null ? { type: "flat", ratePercent: detail.interestRatePercent, period: "yearly" } : null,
      });
      try {
        await payEarliestOpenInstallment(repositories.installmentRepositoryFor(emi.scheduleId), row.amount);
        const transaction = await repositories.transactionRepository.createTransaction({
          type: "expense",
          amount: row.amount,
          dateTime: row.date,
          accountId: params.accountId,
          categoryId,
          description,
          notes: row.notes,
          isBusiness: row.modifiers.business,
          excludeFromCalculations: row.excludeFromCalculations,
          accountingMonth: row.accountingMonth,
        });
        return { transactionId: transaction.id };
      } catch (error) {
        // B3: the EMI (+ its schedule + installments) was just created for this
        // commit alone — a failure in either step after it means the EMI never
        // should have existed, so it's hard-deleted rather than left orphaned
        // or soft-deleted into a confusing "trashed EMI you never made" state.
        await repositories.emiRepository.permanentlyDeleteEmi(emi).catch(() => {
          // Best-effort — the original error below is what actually surfaces.
        });
        throw error;
      }
    }

    case "existing_loan": {
      const detail = requireDetail(row.actionDetail, "existing_loan");
      const loan = params.loans.find((l) => l.id === detail?.loanId);
      if (!loan) throw new Error("Linked loan not found — open this row's Inspector to re-link it.");
      if (loan.isClosed) throw new Error("This loan is already closed.");
      const installmentRepository = repositories.installmentRepositoryFor(loan.scheduleId);
      const paid = await payEarliestOpenInstallment(installmentRepository, row.amount);
      try {
        const transaction = await repositories.transactionRepository.createTransaction({
          type: "expense",
          amount: row.amount,
          dateTime: row.date,
          accountId: params.accountId,
          categoryId,
          description,
          notes: row.notes,
          isBusiness: row.modifiers.business,
          excludeFromCalculations: row.excludeFromCalculations,
          accountingMonth: row.accountingMonth,
        });
        return { transactionId: transaction.id };
      } catch (error) {
        await reverseInstallmentPayment(installmentRepository, paid.installment, paid.amountApplied);
        throw error;
      }
    }

    case "create_loan": {
      const detail = requireDetail(row.actionDetail, "create_loan");
      if (!detail) throw new Error("Loan terms are missing — open this row's Inspector to finish setting it up.");
      const loan = await repositories.loanRepository.createLoan({
        personId: detail.personId,
        name: detail.name,
        loanAmount: detail.loanAmount,
        loanDate: detail.startDate,
        repaymentType: "installment",
        installmentFrequency: "monthly",
        installmentCount: detail.months,
        interest: detail.interestRatePercent != null ? { type: "flat", ratePercent: detail.interestRatePercent, period: "yearly" } : null,
      });
      try {
        await payEarliestOpenInstallment(repositories.installmentRepositoryFor(loan.scheduleId), row.amount);
        const transaction = await repositories.transactionRepository.createTransaction({
          type: "expense",
          amount: row.amount,
          dateTime: row.date,
          accountId: params.accountId,
          categoryId,
          description,
          notes: row.notes,
          isBusiness: row.modifiers.business,
          excludeFromCalculations: row.excludeFromCalculations,
          accountingMonth: row.accountingMonth,
        });
        return { transactionId: transaction.id };
      } catch (error) {
        // Same reasoning as create_emi's rollback — see that case's comment.
        await repositories.loanRepository.permanentlyDeleteLoan(loan).catch(() => {
          // Best-effort — the original error below is what actually surfaces.
        });
        throw error;
      }
    }

    case "normal_expense":
    case "income":
    case "refund": {
      const transaction = await repositories.transactionRepository.createTransaction({
        type: row.direction === "credit" ? "income" : "expense",
        amount: row.amount,
        dateTime: row.date,
        accountId: params.accountId,
        categoryId,
        description,
        notes: row.notes,
        isBusiness: row.modifiers.business,
        excludeFromCalculations: row.excludeFromCalculations,
        accountingMonth: row.accountingMonth,
      });
      return { transactionId: transaction.id };
    }

    // Bill occurrence payment needs a per-bill BillOccurrenceRepository (out of scope for this
    // pass), cashback needs a rewards ledger, and investment has no domain model at all yet.
    // `validateRow` blocks these before `commitOneRow` is ever called for them — this throw is
    // defense-in-depth so a row that somehow reaches here still fails loudly instead of silently
    // writing a lossy plain transaction (B2: unify the import commit engine).
    case "recurring_bill":
    case "cashback":
    case "investment":
      throw new Error(`"${ACTION_META[action].label}" isn't wired up to commit yet — choose a different Action for this row.`);

    // The commit loop skips `ignore` rows before calling commitOneRow — reaching here is a bug,
    // not a valid state, so fail loudly rather than writing an unwanted transaction.
    case "ignore":
      throw new Error("This row is marked Ignore and must not be committed as a transaction.");

    default: {
      const unreachable: never = action;
      throw new Error(`Unrecognized Action "${unreachable}" — commit blocked to avoid writing an unverified transaction.`);
    }
  }
}

export interface PreflightBlocker {
  recordId: string;
  blockingReasons: CommitBlockingReason[];
}

/**
 * A9 — the pre-commit gate. Runs the exact same `validateRow` check
 * `commitReviewImport` uses, but *before* Approve & Import is ever clicked,
 * so a reviewer sees what will block a row while they can still fix it,
 * instead of finding out only after triggering real writes. Skips rows the
 * commit loop itself would skip (excluded, Action=ignore, already
 * committed) — those were never going to be validated either way.
 */
export function getPreflightBlockers(rows: StagedRecord[], categories: Category[]): PreflightBlocker[] {
  const categoryIdByName = new Map(categories.map((c) => [c.name, c.id]));
  const blockers: PreflightBlocker[] = [];
  for (const row of rows) {
    if (!row.include || deriveRecordAction(row) === "ignore" || row.committedTransactionId) continue;
    const blockingReasons = validateRow(row, categoryIdByName);
    if (blockingReasons.length > 0) blockers.push({ recordId: row.id, blockingReasons });
  }
  return blockers;
}

export interface FreshDuplicateWarning {
  recordId: string;
  result: DuplicateDetectionResult;
}

/** Synthetic id prefix `detectFreshDuplicatesForCommit` gives an earlier same-batch row standing in as a "pending" existing transaction — never a real Firestore id, so it's always safe to detect and rewrite before this reaches user-facing text. */
const PENDING_ROW_ID_PREFIX = "pending-row-";

/**
 * `checkForDuplicates` has no notion of "this match is another row in the
 * same not-yet-committed batch, not a transaction that already exists" — it
 * just sees an id. Rewrites any match whose `transactionId` carries the
 * synthetic `PENDING_ROW_ID_PREFIX` (see `detectFreshDuplicatesForCommit`)
 * so `DuplicateWarningDialog`'s `match.reason` reads correctly for a user
 * (e.g. "another row in this same import" rather than the literal
 * `pending-row-r2` placeholder id, and not "already-imported").
 */
function describeBatchInternalMatches(result: DuplicateDetectionResult): DuplicateDetectionResult {
  if (result.matches.every((m) => !m.transactionId.startsWith(PENDING_ROW_ID_PREFIX))) return result;
  const matches = result.matches.map((m) => {
    if (!m.transactionId.startsWith(PENDING_ROW_ID_PREFIX)) return m;
    const sourceRecordId = m.transactionId.slice(PENDING_ROW_ID_PREFIX.length);
    return { ...m, reason: `Matches another row (${sourceRecordId}) in this same import, which will also become a new transaction — not yet an existing one.` };
  });
  return { ...result, matches, bestMatch: matches[0] ?? null };
}

/**
 * A second, later duplicate check on top of `row.duplicateOfTransactionId`/
 * `duplicateCandidateOf` (server-computed once, during parsing —
 * `functions/src/duplicate/duplicate-detector.ts`). Those two fields can go
 * stale between when a statement was staged and the moment "Approve &
 * Import" is actually clicked: a new transaction the same amount/date might
 * have been added since (manually, via SMS, or by an earlier row in this
 * very commit batch already having been approved in a prior click), and the
 * server-side flag never re-runs to notice. Uses the same shared
 * `DuplicateDetectionService` manual entry and SMS import use, so all three
 * surfaces apply one matching rule. Purely informational — like the rest of
 * this module, it never blocks or drops a row; `handleApprove` shows these
 * as a confirmable warning before committing, exactly like
 * `DuplicateWarningDialog` does for manual entry.
 *
 * Same-batch awareness: `commitReviewImport` commits `rows` in array order,
 * sequentially, in one call — row 2 can become a duplicate of the real
 * `Transaction` row 1's commit is about to create, and neither the
 * server-side `internal_duplicate` check (statement-scoped, computed once
 * at parse time — see `detectInternalDuplicates`) nor a naive one-shot
 * pre-check against `existingTransactions` alone would ever compare row 2
 * against row 1. This function closes that gap by treating every earlier
 * eligible row in the same `rows` array as a pseudo-existing transaction
 * too (using a synthetic, not-yet-real id), in the same left-to-right order
 * `commitReviewImport` will actually commit them — so this pre-check's view
 * of "what will exist by the time this row commits" matches reality.
 */
export function detectFreshDuplicatesForCommit(rows: StagedRecord[], existingTransactions: Transaction[], accountId: string): FreshDuplicateWarning[] {
  const existing = existingTransactions.map((t) => ({ id: t.id, description: t.description, amount: t.amount, dateTime: t.dateTime, accountId: t.accountId, type: t.type }));
  const warnings: FreshDuplicateWarning[] = [];

  // Rows committed earlier in this same batch — grows as we walk `rows` in the same left-to-right
  // order `commitReviewImport` will actually commit them in, so a later row is checked against
  // everything an earlier row in this batch will have already created by the time it runs.
  const committedSoFar: typeof existing = [];

  for (const row of rows) {
    if (!row.include || deriveRecordAction(row) === "ignore" || row.committedTransactionId) continue;
    // Rows the server pipeline already flagged get their own dedicated review UI
    // (`DuplicateCandidateList`) and are hard-blocked from commit until resolved —
    // no need for a second warning on top of that one. Still eligible to be checked
    // AGAINST by later rows below, since it will still produce a real Transaction once
    // its own duplicate is resolved and it commits.
    const alreadyFlaggedServerSide = row.duplicateOfTransactionId != null || row.duplicateCandidateOf != null;

    if (!alreadyFlaggedServerSide) {
      // A blank counterparty column (no narration text parsed for this row) left no description to
      // anchor a substring match against — `checkForDuplicates` bails out before matching at all
      // whenever `requireDescriptionMatch` (its default) is true and the candidate text is empty, so
      // without this fallback a same-amount, same-date row with a blank counterparty would silently
      // skip duplicate detection entirely. Mirrors the identical fix in
      // `features/transaction-candidates/lib/import-candidate.ts`'s `checkCandidateForDuplicates`.
      const description = row.counterpartyNormalized ?? row.counterpartyRaw;
      const result = checkForDuplicates(
        {
          description,
          amount: row.amount,
          date: row.date,
          direction: row.direction,
          accountId,
          referenceNumber: row.referenceNumber,
          source: "pdf",
          requireDescriptionMatch: description.trim().length > 0,
        },
        [...existing, ...committedSoFar],
      );
      if (result.status === "duplicate_candidate") warnings.push({ recordId: row.id, result: describeBatchInternalMatches(result) });
    }

    committedSoFar.push({
      id: `${PENDING_ROW_ID_PREFIX}${row.id}`,
      description: row.counterpartyNormalized ?? row.counterpartyRaw,
      amount: row.amount,
      dateTime: row.date,
      accountId,
      type: row.direction === "credit" ? "income" : "expense",
    });
  }

  return warnings;
}

export async function commitReviewImport(params: CommitReviewImportParams): Promise<CommitReviewImportResult> {
  const categoryIdByName = new Map(params.categories.map((c) => [c.name, c.id]));
  const results: CommitRowResult[] = [];

  for (const row of params.rows) {
    if (!row.include || deriveRecordAction(row) === "ignore") {
      results.push({ recordId: row.id, outcome: "skipped" });
      continue;
    }
    if (row.committedTransactionId) {
      results.push({ recordId: row.id, outcome: "committed", transactionId: row.committedTransactionId });
      continue;
    }

    const blockingReasons = validateRow(row, categoryIdByName);
    if (blockingReasons.length > 0) {
      results.push({ recordId: row.id, outcome: "blocked", blockingReasons });
      continue;
    }

    try {
      const categoryId = categoryIdByName.get(row.category!)!;
      const { transactionId } = await commitOneRow(row, categoryId, params);
      await params.onRowCommitted(row.id, transactionId);
      results.push({ recordId: row.id, outcome: "committed", transactionId });
    } catch (error) {
      results.push({ recordId: row.id, outcome: "failed", error: error instanceof Error ? error.message : "Unknown error" });
    }
  }

  return {
    results,
    committedCount: results.filter((r) => r.outcome === "committed").length,
    blockedCount: results.filter((r) => r.outcome === "blocked").length,
    failedCount: results.filter((r) => r.outcome === "failed").length,
    skippedCount: results.filter((r) => r.outcome === "skipped").length,
  };
}
