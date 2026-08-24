/**
 * Validation Engine — Statement Intelligence Layer, docs/architecture.md
 * §7's "Cross-field validation" (opening + debits − credits ≈ closing),
 * now promoted from the Workspace Builder's "no separate Validation Engine
 * yet" placeholder (workspace-builder.ts's own module comment) to a real
 * stage. Pure: takes the already-extracted statement sections and
 * transactions, returns `{ errors, warnings }` — never mutates its input,
 * never decides `needsReview` (that's the Confidence Engine's job).
 *
 * Rules, in order:
 *  1. Cross-field balance check — architecture.md §7's own invariant, with
 *     interest/late-fee folded in since those are billed on the statement
 *     but don't appear as their own transaction rows on a real HDFC-style
 *     layout: opening + totalDebit − totalCredit + interest + lateFee ≈
 *     closing, within a ₹1 rounding tolerance. GST is deliberately NOT
 *     added here even though `billingSummary.gst` exists — on HDFC's real
 *     layout, IGST is *also* itemized as its own debit rows in the
 *     transaction table (e.g. "IGST-VPS...-RATE 18.0"), so adding
 *     `billingSummary.gst` on top double-counts it (proved against the real
 *     HDFC Freedom fixture: a ₹36.90 GST double-count was the entire
 *     ₹37.19 mismatch that caused every real statement to fail this check).
 *     Skipped (not flagged) when any required field is unavailable — an
 *     honest "we don't have enough to check this," not a fabricated pass or
 *     fail.
 *     A failure here is an ERROR (architecture.md §7: "a hard stop, not a
 *     soft nudge, because it usually means a missing page or misparse").
 *  2. Statement date ordering — `paymentDueDate` must not fall before
 *     `statementDate` when both are known. A WARNING (plausibly a genuine
 *     same-day-due statement, but unusual enough to flag).
 *  3. Per-row sanity — a transaction with a non-positive amount is an
 *     ERROR (never a valid statement line); a transaction missing its date
 *     is a WARNING (the row is still usable, just can't be timeline-placed
 *     with confidence).
 */

import type { BillingSummary, StatementInfo, ValidationIssue, WorkspaceTransaction } from "../workspace/statement-workspace-model";

const BALANCE_TOLERANCE = 1.0;

export interface ValidationEngineInput {
  statementInfo: StatementInfo;
  billingSummary: BillingSummary;
  transactions: WorkspaceTransaction[];
}

export interface ValidationEngineResult {
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

function checkCrossFieldBalance(billingSummary: BillingSummary, transactions: WorkspaceTransaction[]): ValidationIssue | null {
  const opening = billingSummary.openingBalance.value;
  const closing = billingSummary.closingBalance.value;
  if (opening == null || closing == null) return null;

  const totalDebit = transactions.filter((t) => t.direction.value === "debit").reduce((sum, t) => sum + t.amount.value, 0);
  const totalCredit = transactions.filter((t) => t.direction.value === "credit").reduce((sum, t) => sum + t.amount.value, 0);
  const interest = billingSummary.interestCharged.value ?? 0;
  const lateFee = billingSummary.lateFee.value ?? 0;

  // GST is intentionally excluded — see the module comment: on HDFC's real
  // layout it's already itemized as its own debit rows, so adding
  // `billingSummary.gst` here would double-count it.
  const expectedClosing = opening + totalDebit - totalCredit + interest + lateFee;
  const diff = Math.abs(expectedClosing - closing);
  if (diff <= BALANCE_TOLERANCE) return null;

  return {
    code: "cross_field_balance_mismatch",
    message: `Opening balance + charges − payments (₹${expectedClosing.toFixed(2)}) does not match the statement's closing balance (₹${closing.toFixed(2)}) — off by ₹${diff.toFixed(2)}. This usually means a missing page or a misparsed row.`,
    field: "billingSummary.closingBalance",
  };
}

function checkDateOrdering(statementInfo: StatementInfo): ValidationIssue | null {
  const statementDate = statementInfo.statementDate.value;
  const dueDate = statementInfo.paymentDueDate.value;
  if (!statementDate || !dueDate) return null;
  if (dueDate.getTime() >= statementDate.getTime()) return null;

  return {
    code: "payment_due_before_statement_date",
    message: `Payment due date (${dueDate.toISOString().slice(0, 10)}) falls before the statement date (${statementDate.toISOString().slice(0, 10)}).`,
    field: "statementInfo.paymentDueDate",
  };
}

function checkTransactionRows(transactions: WorkspaceTransaction[]): { errors: ValidationIssue[]; warnings: ValidationIssue[] } {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  transactions.forEach((t, index) => {
    if (t.amount.value <= 0) {
      errors.push({
        code: "non_positive_transaction_amount",
        message: `Transaction row ${index} has a non-positive amount (₹${t.amount.value}) — not a valid statement line.`,
        field: `transactions[${index}].amount`,
      });
    }
    if (t.date.value == null) {
      warnings.push({
        code: "missing_transaction_date",
        message: `Transaction row ${index} has no extracted date — it will be excluded from timeline placement.`,
        field: `transactions[${index}].date`,
      });
    }
  });

  return { errors, warnings };
}

export function runValidationEngine(input: ValidationEngineInput): ValidationEngineResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  const balanceIssue = checkCrossFieldBalance(input.billingSummary, input.transactions);
  if (balanceIssue) errors.push(balanceIssue);

  const dateOrderingIssue = checkDateOrdering(input.statementInfo);
  if (dateOrderingIssue) warnings.push(dateOrderingIssue);

  const rowIssues = checkTransactionRows(input.transactions);
  errors.push(...rowIssues.errors);
  warnings.push(...rowIssues.warnings);

  return { errors, warnings };
}
