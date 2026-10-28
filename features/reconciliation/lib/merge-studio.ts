/**
 * The dual-sheet merge studio's view model — pure, read-only. It never matches anything itself: every candidate,
 * band, day gap and merchant verdict comes from the Phase 1–4 matcher (`RowMatch`) or from `manualLinkOptions` (the
 * matcher's own manual-link search, same account / direction / ₹1.00 / ±31-day boundaries). This file only arranges
 * that evidence for the two sheets, says which Git-style resolution maps to which existing draft decision, and
 * previews what can't be done.
 *
 * Resolution → decision (all draft-only, written only by the separate Phase 4 approval):
 *  - Keep existing   → `link` to the selected FlowFi transaction (nothing written, ever)
 *  - Keep both       → `import_new` + the explicit "different transaction" acknowledgement (a match exists)
 *  - Import new      → `import_new` (no possible match at all)
 *  - Review later    → `investigate`
 *  - Replace existing, Merge details → NO decision: preview only. Reconciliation never edits or deletes an
 *    existing transaction, so neither can ever be recorded or committed.
 */

import { isComplete } from "@/features/smart-capture/lib/capture-review";
import { formatCurrencyPrecise } from "@/lib/format";
import { calendarDayIndex, describeAmountDelta, describeDayGap, toPaise, DATE_WINDOW_DAYS } from "./amounts-and-days";
import { importBlockReasons, type RowGateContext } from "./decisions";
import { manualLinkOptions, MANUAL_LINK_WINDOW_DAYS } from "./match-engine";
import { merchantSimilarity, merchantStrength } from "./merchant-normalize";
import type { DecisionKind, ExistingRecord, MatchCandidate, ReconRow, RowDecision, RowMatch } from "./types";

// ---------------------------------------------------------------------------------------------------------------
// The right sheet: existing FlowFi transactions for the selected statement row
// ---------------------------------------------------------------------------------------------------------------

export type ExistingSheetMode = "matches" | "ledger";

/** Why an existing record can't be the target of "Keep existing" for the selected row. */
export type ViewOnlyCode = "sms" | "direction" | "amount" | "window" | "claimed" | "rejected" | "incomplete" | "no_row";

export interface ExistingEntry {
  record: ExistingRecord;
  /** The matcher's evidence against the selected row (null when the record is outside the matcher's boundaries). */
  candidate: MatchCandidate | null;
  /**
   * - `imported`: this exact statement row was imported earlier as this transaction (deterministic key).
   * - `suggested`: the matcher's unique, mutual best candidate (still only a suggestion).
   * - `candidate`: any other possible match the matcher found.
   * - `sms`: an SMS for the same event, still waiting in the Inbox.
   * - `linkable`: outside the automatic ±3-day window but inside the manual-link search (±31 days, ₹1.00).
   * - `context`: on the account, but not something this row could be.
   */
  role: "imported" | "suggested" | "candidate" | "sms" | "linkable" | "context";
  /** The statement row whose "Keep existing" decision claims this record (one-to-one), if any. */
  linkedRowId: string | null;
  viewOnly: { code: ViewOnlyCode; message: string } | null;
}

export interface ExistingEntriesInput {
  row: ReconRow | null;
  match: RowMatch | undefined;
  records: ExistingRecord[];
  accountId: string;
  mode: ExistingSheetMode;
  query?: string;
  /** IST calendar-day range the account ledger shows (the statement period); null = around the selected row only. */
  period?: { fromDay: number; toDay: number } | null;
  /** record id → statement row id, from every row's Link decision (see `linkedRowsByRecord`). */
  linkedRows: Map<string, string>;
  rejectedRecordIds?: string[];
  rowNumberOf?: (rowId: string) => number;
}

/** record id → the statement row that keeps it (Link decisions on included rows only — the first row wins, as in the matcher). */
export function linkedRowsByRecord(rows: ReconRow[], decisions: Record<string, RowDecision>): Map<string, string> {
  const out = new Map<string, string>();
  for (const row of rows) {
    const d = decisions[row.id];
    if (row.include && d?.kind === "link" && d.linkedRecordId && !out.has(d.linkedRecordId)) out.set(d.linkedRecordId, row.id);
  }
  return out;
}

function matchesQuery(record: ExistingRecord, q: string): boolean {
  if (!q) return true;
  const norm = (s: string) => s.toLowerCase().replace(/[,₹\s]/g, "");
  return norm(record.description).includes(q) || record.amount.toFixed(2).includes(q) || norm(record.notes).includes(q);
}

/** Why a record on the statement account still can't be this row's "Keep existing" target. */
function viewOnlyFor(row: ReconRow | null, record: ExistingRecord): { code: ViewOnlyCode; message: string } | null {
  if (!row) return { code: "no_row", message: "Select a statement row first." };
  if (record.kind === "sms_pending") return { code: "sms", message: "Still an SMS in the Transaction Inbox — handle it there." };
  if (!isComplete(row)) return { code: "incomplete", message: "The statement row needs a date, amount and Charge/Credit first." };
  if (record.direction !== row.direction) return { code: "direction", message: row.direction === "credit" ? "This is a charge; the statement row is a credit." : "This is a credit; the statement row is a charge." };
  if (Math.abs(record.amountPaise - toPaise(row.amount!)) > 100) return { code: "amount", message: "Amounts differ by more than ₹1.00." };
  if (Math.abs(record.day - calendarDayIndex(row.date!)) > MANUAL_LINK_WINDOW_DAYS) return { code: "window", message: `More than ${MANUAL_LINK_WINDOW_DAYS} days apart.` };
  return null;
}

/**
 * The right sheet's rows. "matches" = the matcher's view of the selected row (imported-earlier record, candidates in
 * the matcher's order, waiting SMS). "ledger" = everything live on the statement account in the statement period,
 * each annotated with the matcher's evidence where it has any. Hard boundaries are never relaxed: a record on another
 * account never appears, and one outside the manual-link boundaries is view-only.
 */
export function existingEntries(input: ExistingEntriesInput): ExistingEntry[] {
  const { row, match, records, accountId, mode, linkedRows } = input;
  const q = (input.query ?? "").trim().toLowerCase().replace(/[,₹\s]/g, "");
  const rejected = new Set(input.rejectedRecordIds ?? []);
  const byId = new Map(records.map((r) => [r.id, r]));
  const candidateById = new Map<string, MatchCandidate>();
  for (const c of match?.candidates ?? []) candidateById.set(c.recordId, c);
  const smsById = new Map<string, MatchCandidate>();
  for (const c of match?.pendingSms ?? []) smsById.set(c.recordId, c);
  const manual = new Map<string, MatchCandidate>();
  if (row && isComplete(row)) for (const o of manualLinkOptions(row, records, accountId)) manual.set(o.record.id, o.candidate);

  const entryFor = (record: ExistingRecord): ExistingEntry => {
    const linkedRowId = linkedRows.get(record.id) ?? null;
    const isImported = match?.alreadyImportedId === record.id;
    const candidate = candidateById.get(record.id) ?? smsById.get(record.id) ?? manual.get(record.id) ?? null;
    const role: ExistingEntry["role"] = isImported
      ? "imported"
      : smsById.has(record.id)
        ? "sms"
        : candidateById.has(record.id)
          ? match?.suggestedRecordId === record.id
            ? "suggested"
            : "candidate"
          : manual.has(record.id)
            ? "linkable"
            : "context";
    let viewOnly: ExistingEntry["viewOnly"] = isImported ? null : viewOnlyFor(row, record);
    if (!viewOnly && row && linkedRowId && linkedRowId !== row.id) {
      viewOnly = { code: "claimed", message: `Already kept by row ${input.rowNumberOf?.(linkedRowId) ?? "?"} — one FlowFi transaction backs one statement row.` };
    }
    if (!viewOnly && rejected.has(record.id)) viewOnly = { code: "rejected", message: "You marked this as “not this one” for this row." };
    return { record, candidate: isImported ? null : candidate, role, linkedRowId, viewOnly };
  };

  if (mode === "matches") {
    const ids = [match?.alreadyImportedId, ...(match?.candidates ?? []).map((c) => c.recordId), ...(match?.pendingSms ?? []).map((c) => c.recordId)].filter((id): id is string => !!id);
    return [...new Set(ids)]
      .map((id) => byId.get(id))
      .filter((r): r is ExistingRecord => !!r && matchesQuery(r, q))
      .map(entryFor);
  }

  const rowDay = row?.date ? calendarDayIndex(row.date) : null;
  const range = input.period ?? (rowDay != null ? { fromDay: rowDay, toDay: rowDay } : null);
  const inRange = (r: ExistingRecord) => {
    // Always show what the matcher found for the selected row, even outside the statement period.
    if (candidateById.has(r.id) || smsById.has(r.id) || manual.has(r.id) || match?.alreadyImportedId === r.id) return true;
    return range == null || (r.day >= range.fromDay - DATE_WINDOW_DAYS && r.day <= range.toDay + DATE_WINDOW_DAYS);
  };
  return records
    .filter((r) => r.accountId === accountId && !r.deleted && inRange(r) && matchesQuery(r, q))
    .sort((a, b) => a.dateTime.getTime() - b.dateTime.getTime() || a.id.localeCompare(b.id))
    .map(entryFor);
}

/**
 * The record the comparison starts on for a row: its own decision's target, then the imported-earlier record, then
 * the matcher's suggestion, then its best candidate. Never a record outside the row's evidence.
 */
export function defaultTargetId(match: RowMatch | undefined, decision: RowDecision | undefined): string | null {
  if (!match) return null;
  if (decision?.kind === "link" && decision.linkedRecordId) return decision.linkedRecordId;
  return match.alreadyImportedId ?? match.suggestedRecordId ?? match.candidates[0]?.recordId ?? match.pendingSms[0]?.recordId ?? null;
}

/** Statement rows for which `recordId` is a possible match — the left sheet's reverse highlight. */
export function rowsCandidateFor(recordId: string | null, matches: Map<string, RowMatch>): Set<string> {
  const out = new Set<string>();
  if (!recordId) return out;
  for (const [rowId, m] of matches) {
    if (m.alreadyImportedId === recordId || m.candidates.some((c) => c.recordId === recordId) || m.pendingSms.some((c) => c.recordId === recordId)) out.add(rowId);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Field-by-field differences
// ---------------------------------------------------------------------------------------------------------------

export type FieldVerdict = "same" | "diff" | "info";

export interface FieldDiff {
  key: "merchant" | "date" | "amount" | "account" | "type" | "origin" | "reference";
  label: string;
  statement: string;
  existing: string;
  verdict: FieldVerdict;
  /** The difference in plain words ("₹0.50 more in FlowFi", "1 day later in FlowFi", "Similar merchant"). */
  detail: string;
}

const MERCHANT_DETAIL = { same: "Same merchant", similar: "Different spelling", different: "Different merchant", unknown: "No merchant to compare" } as const;
const ORIGIN_TEXT: Record<ExistingRecord["origin"], string> = { sms: "SMS", statement_import: "Statement import", smart_capture: "Smart Capture", manual: "Added by hand", unknown: "Unknown" };

function statementDate(date: Date | null): string {
  return date ? date.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "No date";
}

function existingDate(date: Date): string {
  return date.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
}

export function originText(record: ExistingRecord): string {
  return record.kind === "sms_pending" ? "SMS · waiting in Inbox" : ORIGIN_TEXT[record.origin];
}

/**
 * The statement row vs one existing record, field by field. Uses the matcher's candidate evidence when the record is
 * one; otherwise computes the same plain differences (no new matching rule — this is display only).
 */
export function fieldDiffs(params: { row: ReconRow; record: ExistingRecord; candidate: MatchCandidate | null; statementAccount: string; existingAccount: string; captureSource: "text" | "ocr" }): FieldDiff[] {
  const { row, record, candidate } = params;
  const strength = candidate?.merchantStrength ?? merchantStrength(merchantSimilarity(row.description, record.description));
  const deltaPaise = candidate?.amountDeltaPaise ?? (row.amount != null ? record.amountPaise - toPaise(row.amount) : null);
  const dayGap = candidate?.dayGap ?? (row.date ? record.day - calendarDayIndex(row.date) : null);
  const sameAccount = record.accountId != null && params.statementAccount === params.existingAccount;
  const sameType = row.direction != null && row.direction === record.direction;
  const reference = row.referenceNumber?.trim() || "";
  return [
    { key: "merchant", label: "Merchant", statement: row.description || "—", existing: record.description || "—", verdict: strength === "same" ? "same" : strength === "unknown" ? "info" : "diff", detail: MERCHANT_DETAIL[strength] },
    {
      key: "date",
      label: "Date",
      statement: statementDate(row.date),
      existing: existingDate(record.dateTime),
      verdict: dayGap == null ? "info" : dayGap === 0 ? "same" : "diff",
      detail: dayGap == null ? "—" : describeDayGap(dayGap),
    },
    {
      key: "amount",
      label: "Amount",
      statement: row.amount != null ? formatCurrencyPrecise(row.amount) : "No amount",
      existing: formatCurrencyPrecise(record.amount),
      verdict: deltaPaise == null ? "info" : deltaPaise === 0 ? "same" : "diff",
      detail: deltaPaise == null ? "—" : describeAmountDelta(deltaPaise),
    },
    { key: "account", label: "Account", statement: params.statementAccount, existing: params.existingAccount, verdict: sameAccount ? "same" : "diff", detail: sameAccount ? "Same account" : "Different account" },
    {
      key: "type",
      label: "Type",
      statement: row.direction === "credit" ? "Credit" : row.direction === "debit" ? "Charge" : "Unknown",
      existing: record.direction === "credit" ? "Credit" : "Charge",
      verdict: sameType ? "same" : "diff",
      detail: sameType ? "Same direction" : "Opposite direction",
    },
    { key: "origin", label: "Origin", statement: params.captureSource === "ocr" ? "Screenshot" : "Pasted statement", existing: originText(record), verdict: "info", detail: "" },
    {
      key: "reference",
      label: "Ref / notes",
      statement: reference || "—",
      existing: record.notes.trim() || "—",
      verdict: candidate?.referenceMatch ? "same" : "info",
      detail: candidate?.referenceMatch ? "Reference matches" : "",
    },
  ];
}

/** Other transactions with the same (or similar) merchant on the same account — read-only context, newest first. */
export function merchantHistory(record: ExistingRecord, records: ExistingRecord[], limit = 5): ExistingRecord[] {
  if (!record.description.trim()) return [];
  return records
    .filter((r) => r.id !== record.id && r.kind === "transaction" && !r.deleted && r.accountId === record.accountId && r.accountId != null)
    .filter((r) => {
      const s = merchantStrength(merchantSimilarity(record.description, r.description));
      return s === "same" || s === "similar";
    })
    .sort((a, b) => b.dateTime.getTime() - a.dateTime.getTime())
    .slice(0, limit);
}

// ---------------------------------------------------------------------------------------------------------------
// Git-style resolutions
// ---------------------------------------------------------------------------------------------------------------

export type ResolutionId = "keep_existing" | "keep_both" | "import_new" | "replace_existing" | "merge_details" | "review_later";

export interface ResolutionOption {
  id: ResolutionId;
  label: string;
  /** The existing draft decision it records — null for the preview-only resolutions. */
  decision: DecisionKind | null;
  enabled: boolean;
  /** Why it's unavailable (or, for previews, why it can never be committed). */
  reason: string | null;
  previewOnly: boolean;
  selected: boolean;
  /** Recording it needs an explicit acknowledgement first (Keep both with a possible match). */
  needsAck: boolean;
}

export const REPLACE_UNSUPPORTED = "Reconciliation never edits or deletes an existing FlowFi transaction. Keep the existing one, then correct it from Transactions if its details are wrong.";
export const MERGE_UNSUPPORTED = "Merging would edit an existing FlowFi transaction, which this review can't do. The preview isn't saved and nothing is written.";

export function hasPossibleMatch(match: RowMatch): boolean {
  return match.candidates.length > 0 || match.pendingSms.length > 0;
}

export function resolutionOptions(params: { row: ReconRow; match: RowMatch; decision: RowDecision; gate: RowGateContext; target: ExistingEntry | null }): ResolutionOption[] {
  const { row, match, decision, gate, target } = params;
  const excluded = !row.include || match.state === "excluded";
  const possible = hasPossibleMatch(match);
  const blocked = importBlockReasons(row, match, gate);
  const transactionTarget = target && target.record.kind === "transaction" ? target : null;

  const keepExistingReason = excluded
    ? "Excluded in Smart Capture."
    : !target
      ? "Select the FlowFi transaction to keep."
      : target.viewOnly
        ? target.viewOnly.message
        : null;
  const importReason = excluded ? "Excluded in Smart Capture." : (blocked[0] ?? null);

  return [
    {
      id: "keep_existing",
      label: "Keep existing",
      decision: "link",
      enabled: keepExistingReason == null,
      reason: keepExistingReason,
      previewOnly: false,
      selected: decision.kind === "link" && (!target || decision.linkedRecordId === target.record.id),
      needsAck: false,
    },
    {
      id: "keep_both",
      label: "Keep both",
      decision: "import_new",
      enabled: !excluded && possible && importReason == null,
      reason: importReason ?? (possible ? null : "No possible match — use Import new."),
      previewOnly: false,
      selected: decision.kind === "import_new" && possible,
      needsAck: true,
    },
    {
      id: "import_new",
      label: "Import new",
      decision: "import_new",
      enabled: !excluded && !possible && importReason == null,
      reason: importReason ?? (possible ? "A possible match exists — compare it, then choose Keep existing or Keep both." : null),
      previewOnly: false,
      selected: decision.kind === "import_new" && !possible,
      needsAck: false,
    },
    {
      id: "replace_existing",
      label: "Replace existing",
      decision: null,
      enabled: !excluded && transactionTarget != null,
      reason: REPLACE_UNSUPPORTED,
      previewOnly: true,
      selected: false,
      needsAck: false,
    },
    {
      id: "merge_details",
      label: "Merge details",
      decision: null,
      enabled: !excluded && transactionTarget != null,
      reason: MERGE_UNSUPPORTED,
      previewOnly: true,
      selected: false,
      needsAck: false,
    },
    { id: "review_later", label: "Review later", decision: "investigate", enabled: !excluded, reason: excluded ? "Excluded in Smart Capture." : null, previewOnly: false, selected: decision.kind === "investigate", needsAck: false },
  ];
}

// ---------------------------------------------------------------------------------------------------------------
// Previews (never committed) and the financial effect line
// ---------------------------------------------------------------------------------------------------------------

export type MergeField = "merchant" | "date" | "amount" | "notes";
export type MergePicks = Record<MergeField, "statement" | "existing">;

/** Default picks: FlowFi's own description/date/notes, the statement's amount (what the bank actually charged). */
export const DEFAULT_MERGE_PICKS: MergePicks = { merchant: "existing", date: "existing", amount: "statement", notes: "existing" };

export interface PreviewChange {
  field: MergeField;
  label: string;
  from: string;
  to: string;
  changed: boolean;
}

function valuesOf(row: ReconRow, record: ExistingRecord): Record<MergeField, { statement: string; existing: string }> {
  return {
    merchant: { statement: row.description || "—", existing: record.description || "—" },
    date: { statement: statementDate(row.date), existing: existingDate(record.dateTime) },
    amount: { statement: row.amount != null ? formatCurrencyPrecise(row.amount) : "No amount", existing: formatCurrencyPrecise(record.amount) },
    notes: { statement: row.referenceNumber?.trim() ? `Ref ${row.referenceNumber.trim()}` : "—", existing: record.notes.trim() || "—" },
  };
}

const PREVIEW_LABEL: Record<MergeField, string> = { merchant: "Merchant", date: "Date", amount: "Amount", notes: "Notes" };

/** What "Replace existing" WOULD change on the FlowFi transaction. Display only — it can't be recorded or committed. */
export function replacePreview(row: ReconRow, record: ExistingRecord): PreviewChange[] {
  const v = valuesOf(row, record);
  return (Object.keys(v) as MergeField[]).map((field) => ({ field, label: PREVIEW_LABEL[field], from: v[field].existing, to: v[field].statement, changed: v[field].existing !== v[field].statement }));
}

/** The merged transaction a "Merge details" WOULD produce from the picks. Display only — never saved, never committed. */
export function mergePreview(row: ReconRow, record: ExistingRecord, picks: MergePicks): PreviewChange[] {
  const v = valuesOf(row, record);
  return (Object.keys(v) as MergeField[]).map((field) => {
    const to = picks[field] === "statement" ? v[field].statement : v[field].existing;
    return { field, label: PREVIEW_LABEL[field], from: v[field].existing, to, changed: to !== v[field].existing };
  });
}

export interface FinancialEffect {
  tone: "none" | "write" | "pending" | "blocked";
  text: string;
}

/** What final approval would do for this row under its current draft decision — in one plain line. */
export function financialEffect(params: { row: ReconRow; match: RowMatch; decision: RowDecision; errors: string[]; linked: ExistingRecord | null; accountLabel: string }): FinancialEffect {
  const { row, match, decision, errors, linked } = params;
  if (!row.include || match.state === "excluded") return { tone: "none", text: "Excluded — never compared or imported." };
  const money = row.amount != null ? formatCurrencyPrecise(row.amount) : "no amount";
  switch (decision.kind) {
    case null:
      return { tone: "pending", text: "Undecided — final approval waits for this row. Nothing is written yet." };
    case "link":
      // An invalid link (stale, claimed, or not on this account) never reads as "FlowFi keeps …".
      if (errors.length > 0) return { tone: "blocked", text: `Not ready: ${errors[0]}` };
      return linked
        ? { tone: "none", text: `No write. FlowFi keeps “${linked.description || "this transaction"}” (${existingDate(linked.dateTime)}, ${formatCurrencyPrecise(linked.amount)}); this statement row is skipped.` }
        : { tone: "blocked", text: errors[0] ?? "Choose the FlowFi transaction to keep." };
    case "import_new": {
      if (match.state === "already_imported") return { tone: "none", text: "Imported earlier from this exact row — nothing more is written." };
      if (errors.length > 0) return { tone: "blocked", text: `Not ready: ${errors[0]}` };
      const what = row.direction === "credit" ? (decision.creditAs === "income" ? "income credit" : "refund credit") : "charge";
      const keeps = hasPossibleMatch(match) ? " Existing FlowFi transactions stay unchanged." : "";
      return { tone: "write", text: `On final approval: adds 1 ${what} of ${money} (${statementDate(row.date)}) to ${params.accountLabel}.${keeps}` };
    }
    case "ignore":
      return { tone: "none", text: "Skipped — nothing is written for this row." };
    case "investigate":
      return { tone: "pending", text: "Review later — nothing is written, and final approval waits until you decide." };
    case "inbox":
      return { tone: "none", text: "Left for the Transaction Inbox — nothing is written here." };
  }
}
