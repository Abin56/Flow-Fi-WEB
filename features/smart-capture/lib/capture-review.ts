/**
 * Smart Capture review state → Transaction Studio's `StagedRecord`.
 *
 * Smart Capture never writes anything itself: once the user has reviewed the
 * extracted rows, they're converted to the exact `StagedRecord` shape
 * Transaction Studio stages, and committed through Studio's own
 * `getPreflightBlockers` / `detectFreshDuplicatesForCommit` /
 * `commitReviewImport` — one approval engine, one set of safeguards.
 *
 * Only the plain single-write Actions are offered here (expense, income,
 * refund, ignore). EMI/loan/transfer/shared Actions are multi-write and stay
 * unavailable until their crash safety is proven — use Transaction Studio
 * proper (statement upload) or the EMI/Loan pages for those.
 */

import { DEFAULT_RECORD_MODIFIERS, type RecordAction, type StagedRecord } from "@/lib/models/document-import";
import { actionToAxesPatch } from "@/features/transaction-studio/lib/action-metadata";
import type { CaptureDirection, CaptureField, CaptureIssue, CaptureIssueCode, CaptureRow } from "./parse-pasted-statement";

export type CaptureAction = Extract<RecordAction, "normal_expense" | "income" | "refund" | "ignore">;

export const CAPTURE_ACTIONS_BY_DIRECTION: Record<CaptureDirection, CaptureAction[]> = {
  debit: ["normal_expense", "ignore"],
  credit: ["refund", "income", "ignore"],
};

/** A row as the user is reviewing it — the parse result plus their edits/decisions. */
export interface ReviewRow extends CaptureRow {
  include: boolean;
  /** Where the row came from — OCR rows get stricter review (see ocr-review.ts). */
  source: "text" | "ocr";
  /** Set once the user has explicitly accepted the row's flagged values (row-level "Values are correct"). */
  confirmed: boolean;
  edited: boolean;
  /** Fields the user changed by hand — clears that field's strict (low-confidence) issue. */
  editedFields: CaptureField[];
  /** Fields the user individually confirmed as read — the other way to clear a strict issue. */
  confirmedFields: CaptureField[];
  /** Set when `confirmed` came from "Confirm all reviewed rows" — so that bulk action can be undone on its own. */
  bulkConfirmed: boolean;
  action: CaptureAction | null;
  category: string | null;
  /** Set by Studio's commit engine once this row became a real transaction. */
  committedTransactionId: string | null;
}

export function toReviewRows(rows: CaptureRow[], source: ReviewRow["source"] = "text"): ReviewRow[] {
  return rows.map((row) => ({
    ...row,
    source,
    include: row.suggestedInclude,
    confirmed: false,
    edited: false,
    editedFields: [],
    confirmedFields: [],
    bulkConfirmed: false,
    action: row.direction ? defaultCaptureAction(row) : null,
    category: null,
    committedTransactionId: null,
  }));
}

function defaultCaptureAction(row: CaptureRow): CaptureAction {
  if (row.direction === "credit") return row.kind === "refund" ? "refund" : "income";
  return "normal_expense";
}

/**
 * Blocking issues that the user hasn't yet resolved — edits re-validate, an explicit row confirm clears the
 * ordinary ones, but a strict (low-confidence OCR) issue survives it and needs its own field edit/confirm.
 */
export function openIssues(row: ReviewRow): CaptureIssue[] {
  const blocking = currentIssues(row).filter((i) => i.blocking);
  return row.confirmed ? blocking.filter((i) => i.strict) : blocking;
}

/** Recomputes issues against the row's *current* values, so an edit that fixes a problem clears its flag. */
export function currentIssues(row: ReviewRow): CaptureIssue[] {
  const issues: CaptureIssue[] = [];
  for (const issue of row.issues) {
    // A confirm-only issue (e.g. a dropped decimal point) is cleared only by confirming the field — choosing or typing
    // a value is not enough on its own, so no amount ever becomes "accepted" by a single click.
    if (issue.strict && issue.field && (row.confirmedFields.includes(issue.field) || (!issue.confirmOnly && row.editedFields.includes(issue.field)))) continue;
    if (issue.code === "no_amount" && row.amount != null && row.amount > 0) continue;
    if (issue.code === "direction_unclear" && row.edited && row.direction != null) continue;
    if (issue.code === "no_date" && row.date != null) continue;
    if (issue.code === "multiple_amounts" && row.edited) continue;
    issues.push(issue);
  }
  if (row.amount == null || !(row.amount > 0)) {
    if (!issues.some((i) => i.code === "no_amount")) issues.push({ code: "no_amount", message: "Enter a positive amount.", blocking: true });
  }
  if (row.direction == null && !issues.some((i) => i.code === "direction_unclear")) {
    issues.push({ code: "direction_unclear", message: "Choose charge or credit.", blocking: true });
  }
  if (row.date == null && !issues.some((i) => i.code === "no_date")) {
    issues.push({ code: "no_date", message: "Enter a date.", blocking: true });
  }
  return issues;
}

/** Hard requirements that even "confirm" can't waive — a row can't continue without these values. */
export function isComplete(row: ReviewRow): boolean {
  return row.date != null && row.amount != null && row.amount > 0 && row.direction != null;
}

export interface ReviewProgress {
  included: number;
  /** Included rows whose row-level check is done (confirmed against the image / values confirmed, or none needed). */
  verified: number;
  /** Included rows with nothing left to do. */
  ready: number;
  /** Included rows whose values are all there and need one look (unclear read, possible repeat, image check). */
  toCheck: number;
  /** Included rows that need a value corrected or chosen (missing, several amounts, dropped decimal point…). */
  fieldIssues: number;
  /** Included rows not ready — the number that has to reach 0. */
  pending: number;
}

/** One source of truth for every count the review screen shows; derived from the same gates `canContinue` uses. */
/** Row-level checks a bulk confirmation may clear: only "I compared this row with the image". */
const BULK_CLEARABLE: ReadonlySet<string> = new Set(["ocr_unverified"]);
/** Signals that something about the row's money is uncertain — such a row always needs its own look. */
const NEEDS_INDIVIDUAL_LOOK: ReadonlySet<string> = new Set(["direction_inferred", "possible_repeat", "partial_line", "merged_lines", "year_assumed"]);

/**
 * Rows "Confirm all reviewed rows" may confirm: included, not yet confirmed, every value present, and the ONLY thing
 * open is the row-level image check. Anything else — a missing/ambiguous amount, an unclear or inferred C/D, a
 * date problem, a cut-off or repeated row, two joined lines — keeps the row out, so bulk never clears financial
 * ambiguity. Excluded rows are never touched (and never re-included).
 */
export function bulkConfirmEligible(rows: ReviewRow[]): ReviewRow[] {
  return rows.filter((row) => {
    if (!row.include || row.confirmed || row.committedTransactionId || !isComplete(row)) return false;
    const open = openIssues(row);
    if (open.length === 0 || open.some((i) => !BULK_CLEARABLE.has(i.code))) return false;
    return !currentIssues(row).some((i) => NEEDS_INDIVIDUAL_LOOK.has(i.code));
  });
}

export function bulkConfirm(rows: ReviewRow[], ids: ReadonlySet<string>): ReviewRow[] {
  return rows.map((row) => (ids.has(row.id) ? { ...row, confirmed: true, bulkConfirmed: true } : row));
}

/** Undoes only what the bulk action confirmed; individual confirmations stay. */
export function undoBulkConfirm(rows: ReviewRow[]): ReviewRow[] {
  return rows.map((row) => (row.bulkConfirmed ? { ...row, confirmed: false, bulkConfirmed: false } : row));
}

/**
 * "Fix" vs "Check": a row needs a CORRECTION when a value is missing or has to be chosen (a dropped decimal point,
 * several amounts, an unknown Charge/Credit); it needs a CHECK when every value is there and one look settles it
 * (an unclear read, a possible repeat, the image comparison). One rule for the badges, the counts and the summary.
 */
export function needsCorrection(row: ReviewRow): boolean {
  return !isComplete(row) || openIssues(row).some((i) => NEEDS_A_VALUE.has(i.code));
}

export function reviewProgress(rows: ReviewRow[]): ReviewProgress {
  const included = rows.filter((r) => r.include);
  let ready = 0;
  let toCheck = 0;
  let fieldIssues = 0;
  let verified = 0;
  for (const row of included) {
    const open = openIssues(row);
    if (needsCorrection(row)) fieldIssues++;
    else if (open.length > 0) toCheck++;
    else ready++;
    if (!open.some((i) => !i.strict && !NEEDS_A_VALUE.has(i.code))) verified++;
  }
  return { included: included.length, verified, ready, toCheck, fieldIssues, pending: included.length - ready };
}

/**
 * Whether the user has done review work that replacing or clearing the capture would throw away: a confirmation
 * (row or field), a hand edit, or an include/exclude choice that differs from the parser's suggestion.
 */
export function hasReviewWork(rows: ReviewRow[]): boolean {
  return rows.some((r) => r.confirmed || r.edited || r.confirmedFields.length > 0 || r.include !== r.suggestedInclude);
}

/** The Smart Capture selection counts, as three separate ideas: included, verified, ready to hand over. */
export function selectionCounts(rows: ReviewRow[]): { total: number; included: number; excluded: number } {
  const included = rows.filter((r) => r.include).length;
  return { total: rows.length, included, excluded: rows.length - included };
}

export function canContinue(rows: ReviewRow[]): boolean {
  const included = rows.filter((r) => r.include);
  return included.length > 0 && included.every((r) => isComplete(r) && openIssues(r).length === 0);
}

export type RowPatch = Partial<Pick<ReviewRow, "date" | "description" | "amount" | "direction" | "include" | "action" | "category" | "confirmed">>;

const EDITABLE_FIELDS: CaptureField[] = ["date", "amount", "direction"];

/** Confirms a field's current value. A field with no value can't be confirmed. */
export function confirmField(row: ReviewRow, field: CaptureField): ReviewRow {
  const hasValue = field === "amount" ? row.amount != null && row.amount > 0 : field === "date" ? row.date != null : row.direction != null;
  if (!hasValue || row.confirmedFields.includes(field)) return row;
  return { ...row, confirmedFields: [...row.confirmedFields, field] };
}

/** Open problems one confirmation can't settle: a value has to be chosen or entered first. */
const NEEDS_A_VALUE: ReadonlySet<CaptureIssueCode> = new Set(["no_amount", "no_date", "direction_unclear", "multiple_amounts", "decimal_missing"]);

export interface RowConfirmPlan {
  /** Unclearly read fields whose current values the confirmation accepts. */
  fields: CaptureField[];
  /** Whether it also settles the row-level check (compared with the image, a possible repeat, a joined line…). */
  rowCheck: boolean;
}

/**
 * What the row's ONE confirmation covers — every unclearly read field that has a value, plus the row-level check — so
 * a row never asks for the same look twice. null when there's nothing to confirm, or something open needs a value
 * chosen or entered first (a dropped decimal point, several amounts, a missing value): confirming can't settle those.
 */
export function rowConfirmPlan(row: ReviewRow): RowConfirmPlan | null {
  if (!isComplete(row)) return null;
  const open = openIssues(row);
  if (open.length === 0 || open.some((i) => NEEDS_A_VALUE.has(i.code))) return null;
  return { fields: [...new Set(open.filter((i) => i.strict && i.field).map((i) => i.field!))], rowCheck: open.some((i) => !i.strict) };
}

export function confirmRow(row: ReviewRow): ReviewRow {
  const plan = rowConfirmPlan(row);
  if (!plan) return row;
  const next = plan.fields.reduce(confirmField, row);
  return plan.rowCheck ? { ...next, confirmed: true, bulkConfirmed: false } : next;
}

/** Withdraws every confirmation on the row (row-level and per field) — the undo of `confirmRow`. */
export function unconfirmRow(row: ReviewRow): ReviewRow {
  return { ...row, confirmed: false, bulkConfirmed: false, confirmedFields: [] };
}

export interface ReviewTotals {
  /** Included rows counted (complete amount + direction). */
  counted: number;
  /** Included rows left out of the sums because their amount or Charge/Credit isn't known yet. */
  uncounted: number;
  /** Statement direction — what left / came into the account, whatever it will be imported as. */
  debits: number;
  credits: number;
  debitCount: number;
  creditCount: number;
  /** credits − debits: negative = net outflow. */
  net: number;
  /** By what the row will be imported as. */
  expenses: number;
  refunds: number;
  income: number;
  /** Card bill payments / EMIs — money movements, never called an expense or income here. */
  payments: number;
  /** Included but set to "Skip" at import. */
  skipped: number;
}

const PAYMENT_KINDS: ReadonlySet<CaptureRow["kind"]> = new Set(["payment", "emi"]);

/**
 * Totals of the included rows' CURRENT (edited) values — excluded rows never count. Summed in paise so 0.1 + 0.2
 * style float drift can't show up in a financial total.
 */
export function reviewTotals(rows: ReviewRow[]): ReviewTotals {
  const p = { debits: 0, credits: 0, expenses: 0, refunds: 0, income: 0, payments: 0, skipped: 0 };
  let debitCount = 0;
  let creditCount = 0;
  let uncounted = 0;
  for (const r of rows) {
    if (!r.include) continue;
    if (r.amount == null || !(r.amount > 0) || r.direction == null) {
      uncounted++;
      continue;
    }
    const paise = Math.round(r.amount * 100);
    if (r.direction === "debit") {
      p.debits += paise;
      debitCount++;
    } else {
      p.credits += paise;
      creditCount++;
    }
    if (r.action === "ignore") p.skipped += paise;
    else if (PAYMENT_KINDS.has(r.kind)) p.payments += paise;
    else if (r.direction === "debit") p.expenses += paise;
    else if (r.action === "refund") p.refunds += paise;
    else p.income += paise;
  }
  const rupees = (n: number) => n / 100;
  return {
    counted: debitCount + creditCount,
    uncounted,
    debits: rupees(p.debits),
    credits: rupees(p.credits),
    debitCount,
    creditCount,
    net: rupees(p.credits - p.debits),
    expenses: rupees(p.expenses),
    refunds: rupees(p.refunds),
    income: rupees(p.income),
    payments: rupees(p.payments),
    skipped: rupees(p.skipped),
  };
}

export function applyRowPatch(row: ReviewRow, patch: RowPatch): ReviewRow {
  const valueEdit = "date" in patch || "description" in patch || "amount" in patch || "direction" in patch;
  const touched = EDITABLE_FIELDS.filter((f) => f in patch);
  const editedFields = touched.length ? [...new Set([...row.editedFields, ...touched])] : row.editedFields;
  // Changing a value withdraws any earlier confirmation of that field — the new value must be confirmed itself.
  const confirmedFields = touched.length ? row.confirmedFields.filter((f) => !touched.includes(f)) : row.confirmedFields;
  const bulkConfirmed = "confirmed" in patch ? false : row.bulkConfirmed;
  const next: ReviewRow = { ...row, ...patch, edited: row.edited || valueEdit, editedFields, confirmedFields, bulkConfirmed };
  // Changing direction invalidates an Action that only fits the other direction.
  if ("direction" in patch && next.direction && (next.action == null || !CAPTURE_ACTIONS_BY_DIRECTION[next.direction].includes(next.action))) {
    next.action = defaultCaptureAction(next);
  }
  return next;
}

/**
 * Stable, scoped id for the capture session — passed to `commitReviewImport` as its `documentId`, so every row's
 * idempotency key is unique to this exact paste + account: re-running the same import replays instead of writing
 * the money twice.
 */
export function captureSessionId(sourceText: string, accountId: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const input = `${accountId}\n${sourceText.replace(/\s+/g, " ").trim()}`;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 16777619);
    h2 = Math.imul(h2 ^ ch, 2246822519);
  }
  return `smartcapture_${(h1 >>> 0).toString(16)}${(h2 >>> 0).toString(16)}`;
}

/** Builds the `StagedRecord` Transaction Studio's commit engine expects. Only included, complete rows. */
export function toStagedRecords(rows: ReviewRow[]): StagedRecord[] {
  return rows
    .filter((r) => r.include && isComplete(r))
    .map((row, index) => {
      const axes = row.action ? actionToAxesPatch(row.action) : { flowType: null, ownership: null, modifiers: DEFAULT_RECORD_MODIFIERS, actionDetail: null };
      return {
        id: row.id,
        recordType: "transaction",
        rawText: row.sourceText,
        date: row.date!,
        counterpartyRaw: row.description,
        counterpartyNormalized: null,
        amount: row.amount!,
        direction: row.direction!,
        referenceNumber: row.referenceNumber,
        currency: "INR",
        category: row.category,
        subcategory: null,
        confidenceScores: { overall: row.confidence === "high" ? 0.9 : row.confidence === "medium" ? 0.6 : 0.3 },
        sourcePage: 0,
        sourceLineIndex: row.lineStart ?? index,
        splitParentId: null,
        mergedInto: null,
        userEdited: row.edited,
        lastEditedAt: null,
        lastEditedBy: null,
        tags: [],
        notes: "Imported via Smart Capture",
        duplicateOfTransactionId: null,
        include: true,
        ...axes,
        committedTransactionId: row.committedTransactionId,
        excludeFromCalculations: false,
        accountingMonth: null,
        suggestedCategory: null,
        suggestedAccount: null,
        suggestedPerson: null,
        suggestedTags: [],
        expenseType: null,
        transferDetected: false,
        recurringDetected: false,
        subscriptionDetected: false,
        duplicateCandidateOf: null,
        // Smart Capture's own review gate (openIssues/canContinue) already forced every flag to be resolved.
        needsReview: false,
      } satisfies StagedRecord;
    });
}
