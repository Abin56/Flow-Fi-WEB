/**
 * Business-consistency checks for Statement Workspace Model fixtures
 * (docs/parser-pipeline-design.md v3 Task 2, requirement 6). These are
 * test-time fixture-authoring checks — NOT the production Validation
 * Engine (a later task) — their job is to keep the golden fixtures
 * themselves internally honest (e.g. catch a hand-authoring mistake or a
 * generator bug), not to be the shipped business logic.
 *
 * Every function returns a list of violation messages; an empty array
 * means the check passed. Amounts are compared with a small epsilon
 * (paisa-level rounding), never with `===` on floats.
 */

import type { DuplicateCandidate, StatementWorkspaceModel, WorkspaceTransaction } from "../../../src/workspace/statement-workspace-model";

const AMOUNT_EPSILON = 0.01;

function approxEqual(a: number, b: number, epsilon = AMOUNT_EPSILON): boolean {
  return Math.abs(a - b) <= epsilon;
}

/** openingBalance + sum(debits) - sum(credits) ≈ closingBalance (Architecture §7.1's cross-field invariant). */
export function checkBalanceArithmetic(model: StatementWorkspaceModel): string[] {
  const violations: string[] = [];
  const opening = model.billingSummary.openingBalance.value;
  const closing = model.billingSummary.closingBalance.value;
  if (opening == null || closing == null) return violations; // nothing to check if either is genuinely unavailable

  const totalDebits = model.transactions
    .filter((t) => t.direction.value === "debit")
    .reduce((sum, t) => sum + t.amount.value, 0);
  const totalCredits = model.transactions
    .filter((t) => t.direction.value === "credit")
    .reduce((sum, t) => sum + t.amount.value, 0);

  const expectedClosing = opening + totalDebits - totalCredits;
  if (!approxEqual(expectedClosing, closing, 1)) {
    violations.push(
      `Balance arithmetic mismatch: opening(${opening}) + debits(${totalDebits}) - credits(${totalCredits}) = ${expectedClosing}, but closingBalance is ${closing}`,
    );
  }
  return violations;
}

/** All statement/billing dates must form a sane, non-impossible sequence. */
export function checkDateRanges(model: StatementWorkspaceModel): string[] {
  const violations: string[] = [];
  const { billingPeriodStart, billingPeriodEnd, statementDate, paymentDueDate } = model.statementInfo;

  const start = billingPeriodStart.value;
  const end = billingPeriodEnd.value;
  const stmtDate = statementDate.value;
  const due = paymentDueDate.value;

  if (start && end && start.getTime() > end.getTime()) {
    violations.push(`billingPeriodStart (${start.toISOString()}) is after billingPeriodEnd (${end.toISOString()})`);
  }
  if (end && stmtDate && end.getTime() > stmtDate.getTime()) {
    violations.push(`billingPeriodEnd (${end.toISOString()}) is after statementDate (${stmtDate.toISOString()})`);
  }
  if (stmtDate && due && stmtDate.getTime() >= due.getTime()) {
    violations.push(`paymentDueDate (${due.toISOString()}) is not after statementDate (${stmtDate.toISOString()})`);
  }

  const MIN_SANE_YEAR = 2000;
  const MAX_SANE_YEAR = 2100;
  for (const d of [start, end, stmtDate, due]) {
    if (d && (d.getUTCFullYear() < MIN_SANE_YEAR || d.getUTCFullYear() > MAX_SANE_YEAR)) {
      violations.push(`Impossible date encountered: ${d.toISOString()}`);
    }
  }

  for (const [index, txn] of model.transactions.entries()) {
    const txnDate = txn.date.value;
    if (txnDate && (txnDate.getUTCFullYear() < MIN_SANE_YEAR || txnDate.getUTCFullYear() > MAX_SANE_YEAR)) {
      violations.push(`transactions[${index}] has an impossible date: ${txnDate.toISOString()}`);
    }
  }

  return violations;
}

/** Due date must be strictly after the statement date (duplicated intent from checkDateRanges, kept separate per requirement 6's explicit listing). */
export function checkDueDateAfterStatementDate(model: StatementWorkspaceModel): string[] {
  const { statementDate, paymentDueDate } = model.statementInfo;
  if (statementDate.value && paymentDueDate.value && paymentDueDate.value.getTime() <= statementDate.value.getTime()) {
    return [`paymentDueDate must be strictly after statementDate`];
  }
  return [];
}

/** Outstanding (totalDue) should never exceed the credit limit for a well-formed, non-overlimit fixture. */
export function checkCreditLimitNotExceeded(model: StatementWorkspaceModel): string[] {
  const limit = model.billingSummary.creditLimit.value;
  const totalDue = model.billingSummary.totalDue.value;
  if (limit != null && totalDue != null && totalDue > limit) {
    return [`totalDue (${totalDue}) exceeds creditLimit (${limit})`];
  }
  return [];
}

function transactionFingerprint(t: WorkspaceTransaction): string {
  const dateKey = t.date.value ? t.date.value.toISOString().slice(0, 10) : "no-date";
  return `${dateKey}|${t.amount.value}|${t.merchantRaw.value.trim().toUpperCase()}|${t.referenceNumber.value ?? ""}`;
}

/**
 * Every transaction's fingerprint must be unique EXCEPT for pairs the
 * fixture deliberately lists in `duplicateCandidates` — this catches a
 * generator/authoring accident producing two identical rows by chance,
 * while still allowing intentional near-duplicates in the Complex fixture.
 */
export function checkDuplicateFingerprintsUnique(model: StatementWorkspaceModel): string[] {
  const violations: string[] = [];
  const seen = new Map<string, number>(); // fingerprint -> first index seen
  const intentionalIndices = new Set<number>(model.duplicatePanel.candidates.map((d: DuplicateCandidate) => d.transactionIndex));

  model.transactions.forEach((t, index) => {
    const fp = transactionFingerprint(t);
    const firstIndex = seen.get(fp);
    if (firstIndex !== undefined) {
      const bothIntentional = intentionalIndices.has(index) && intentionalIndices.has(firstIndex);
      if (!bothIntentional) {
        violations.push(
          `Unintentional duplicate fingerprint between transactions[${firstIndex}] and transactions[${index}] (neither is listed in duplicateCandidates)`,
        );
      }
    } else {
      seen.set(fp, index);
    }
  });

  return violations;
}

/** Runs every check and returns the combined violation list — empty means the fixture is fully internally consistent. */
export function runAllBusinessValidation(model: StatementWorkspaceModel): string[] {
  return [
    ...checkBalanceArithmetic(model),
    ...checkDateRanges(model),
    ...checkDueDateAfterStatementDate(model),
    ...checkCreditLimitNotExceeded(model),
    ...checkDuplicateFingerprintsUnique(model),
  ];
}
