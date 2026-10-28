/**
 * Read-only reconciliation matcher. Pure: takes the captured rows, the already-loaded existing records and the
 * user's draft decisions, and returns evidence per row. It never merges, rounds, edits, deletes or imports — the
 * output is advisory, and every final decision is the user's (Stage 3 / Stage 6).
 *
 * Hard boundaries — a record failing any of these is NEVER a candidate:
 *  - Same account/card as the statement (`accountId`). Same amount + date on another account is a note, not a match
 *    (D9: a shared-credit-limit sibling card is called out, but still only informational).
 *  - Same direction (Charge ↔ expense, Credit ↔ income).
 *  - Not soft-deleted (a deleted look-alike is a note).
 *  - Amount within ₹1.00 and date within ±3 IST calendar days (D4).
 *
 * One-to-one: an existing transaction backs at most one statement row. A user's Link claims its record first;
 * suggestions are only made for unique, mutual best matches (the same fixed-point rule as
 * `reconcileTransfers` in lib/engines/transfer-reconciliation-engine.ts) — ties stay "multiple". So two genuine
 * same-day, same-amount purchases are never both pinned to one existing transaction.
 */

import { isComplete } from "@/features/smart-capture/lib/capture-review";
import { amountBand, calendarDayIndex, DATE_WINDOW_DAYS, toPaise } from "./amounts-and-days";
import { containsReference, merchantKey, merchantSimilarity, merchantStrength } from "./merchant-normalize";
import type { ExistingRecord, MatchCandidate, MatchState, MatchTier, ReconRow, RowDecision, RowMatch, RowNote } from "./types";

export interface MatchContext {
  /** The statement's account (a card's own account id for a card). */
  accountId: string;
  records: ExistingRecord[];
  decisions: Record<string, RowDecision>;
  /** Accounts of cards sharing this card's credit limit (D9) — informational only. */
  siblingAccountIds?: string[];
  /** Ids that mean "this row was already imported" (see session-key.ts). */
  importedIdsForRow?: (rowId: string) => string[];
  accountLabel?: (accountId: string) => string;
  windowDays?: number;
}

/** How far "Find another transaction" searches (and how far an explicit manual Link may reach). */
export const MANUAL_LINK_WINDOW_DAYS = 31;

const BAND_SCORE = { exact: 60, paise: 45, rounding: 35 } as const;
const MERCHANT_SCORE = { same: 20, similar: 10, unknown: 0, different: -10 } as const;

function tierFor(band: MatchCandidate["amountBand"], dayGap: number, strength: MatchCandidate["merchantStrength"]): MatchTier {
  if (band === "exact" && dayGap === 0) return "exact";
  if (dayGap === 0 && (strength === "same" || strength === "similar")) return "same_merchant_date";
  return "near";
}

function evaluate(row: ReconRow, rowDay: number, rowPaise: number, record: ExistingRecord, windowDays: number): MatchCandidate | null {
  if (record.direction !== row.direction) return null;
  const band = amountBand(record.amountPaise, rowPaise);
  if (band == null) return null;
  const dayGap = record.day - rowDay;
  if (Math.abs(dayGap) > windowDays) return null;
  const merchantScore = merchantSimilarity(row.description, record.description);
  const strength = merchantStrength(merchantScore);
  const referenceMatch = containsReference(row.referenceNumber, record.description, record.notes);
  const score = BAND_SCORE[band] - 8 * Math.abs(dayGap) + MERCHANT_SCORE[strength] + (referenceMatch ? 25 : 0);
  return {
    recordId: record.id,
    kind: record.kind,
    amountBand: band,
    amountDeltaPaise: record.amountPaise - rowPaise,
    dayGap,
    merchantScore,
    merchantStrength: strength,
    referenceMatch,
    tier: tierFor(band, dayGap, strength),
    score,
  };
}

const byScore = (a: MatchCandidate, b: MatchCandidate) => b.score - a.score || Math.abs(a.dayGap) - Math.abs(b.dayGap) || a.recordId.localeCompare(b.recordId);

/**
 * Unique, mutual best pairs among rows that have no Link decision yet. Iterates to a fixed point: pairing one row
 * can make another row's best unique. Records in `taken` (already linked by the user) are never suggested.
 */
function suggestPairs(candidatesByRow: Map<string, MatchCandidate[]>, taken: Set<string>): Map<string, string> {
  const pairs = new Map<string, string>();
  const used = new Set(taken);
  for (;;) {
    const open = [...candidatesByRow.entries()].filter(([rowId]) => !pairs.has(rowId));
    const bestForRow = new Map<string, { ids: string[]; score: number }>();
    const bestForRecord = new Map<string, { rows: string[]; score: number }>();
    for (const [rowId, list] of open) {
      const available = list.filter((c) => !used.has(c.recordId));
      if (available.length === 0) continue;
      const top = Math.max(...available.map((c) => c.score));
      bestForRow.set(rowId, { ids: available.filter((c) => c.score === top).map((c) => c.recordId), score: top });
      for (const c of available) {
        const current = bestForRecord.get(c.recordId);
        if (!current || c.score > current.score) bestForRecord.set(c.recordId, { rows: [rowId], score: c.score });
        else if (c.score === current.score) current.rows.push(rowId);
      }
    }
    let progressed = false;
    for (const [rowId, best] of bestForRow) {
      if (best.ids.length !== 1) continue; // tied — not unique
      const recordId = best.ids[0]!;
      const reverse = bestForRecord.get(recordId);
      if (!reverse || reverse.rows.length !== 1 || reverse.rows[0] !== rowId) continue; // not mutual
      pairs.set(rowId, recordId);
      used.add(recordId);
      progressed = true;
    }
    if (!progressed) return pairs;
  }
}

function formatDay(record: ExistingRecord): string {
  return record.dateTime.toLocaleDateString("en-IN", { day: "2-digit", month: "short", timeZone: "Asia/Kolkata" });
}

/**
 * "Find another transaction" for one row: committed, live transactions on the statement account with the same
 * direction, within ₹1.00 and ±31 IST days, optionally narrowed by a search over description/amount. The same
 * account/direction/amount boundaries as automatic matching — a manual Link can't cross accounts either.
 */
export function manualLinkOptions(row: ReconRow, records: ExistingRecord[], accountId: string, query = ""): { record: ExistingRecord; candidate: MatchCandidate }[] {
  if (!isComplete(row)) return [];
  const rowDay = calendarDayIndex(row.date!);
  const rowPaise = toPaise(row.amount!);
  const q = query.trim().toLowerCase();
  const out: { record: ExistingRecord; candidate: MatchCandidate }[] = [];
  for (const record of records) {
    if (record.kind !== "transaction" || record.deleted || record.accountId !== accountId) continue;
    const candidate = evaluate(row, rowDay, rowPaise, record, MANUAL_LINK_WINDOW_DAYS);
    if (!candidate) continue;
    if (q && !record.description.toLowerCase().includes(q) && !record.amount.toFixed(2).includes(q)) continue;
    out.push({ record, candidate });
  }
  return out.sort((a, b) => byScore(a.candidate, b.candidate));
}

export function matchRows(rows: ReconRow[], ctx: MatchContext): RowMatch[] {
  const windowDays = ctx.windowDays ?? DATE_WINDOW_DAYS;
  const label = ctx.accountLabel ?? ((_id: string) => "another account");
  const siblings = new Set(ctx.siblingAccountIds ?? []);
  const live = ctx.records.filter((r) => r.kind === "transaction" && !r.deleted);
  const liveById = new Map(live.map((r) => [r.id, r]));

  // Keyed import ids per row; a record that IS another row's own import is never a candidate for this row.
  const importedIds = new Map(rows.map((row) => [row.id, ctx.importedIdsForRow?.(row.id) ?? []]));
  const ownerOfImportedId = new Map<string, string>();
  for (const [rowId, ids] of importedIds) for (const id of ids) ownerOfImportedId.set(id, rowId);

  // User Links claim their record first (one-to-one).
  const claimedBy: Record<string, string> = {};
  for (const row of rows) {
    const d = ctx.decisions[row.id];
    if (row.include && d?.kind === "link" && d.linkedRecordId) claimedBy[d.linkedRecordId] ??= row.id;
  }

  const candidatesByRow = new Map<string, MatchCandidate[]>();
  const smsByRow = new Map<string, MatchCandidate[]>();
  const notesByRow = new Map<string, RowNote[]>();
  const conflictsByRow = new Map<string, string[]>();
  const alreadyImported = new Map<string, string | null>();
  const deletedImports = new Map<string, string | null>();
  const deletedIds = new Set(ctx.records.filter((r) => r.kind === "transaction" && r.deleted).map((r) => r.id));

  for (const row of rows) {
    const notes: RowNote[] = [];
    const conflicts: string[] = [];
    notesByRow.set(row.id, notes);
    conflictsByRow.set(row.id, conflicts);
    const importedId = (importedIds.get(row.id) ?? []).find((id) => liveById.get(id)?.accountId === ctx.accountId) ?? null;
    alreadyImported.set(row.id, importedId);
    // P0: the row's own key belongs to a soft-deleted transaction — reported, never matched, never re-imported.
    if (!importedId) deletedImports.set(row.id, (importedIds.get(row.id) ?? []).find((id) => deletedIds.has(id)) ?? null);
    if (!row.include || !isComplete(row)) continue;

    const rowDay = calendarDayIndex(row.date!);
    const rowPaise = toPaise(row.amount!);
    const rejected = new Set(ctx.decisions[row.id]?.rejectedRecordIds ?? []);
    const txnCandidates: MatchCandidate[] = [];
    const smsCandidates: MatchCandidate[] = [];

    const linkedId = ctx.decisions[row.id]?.kind === "link" ? ctx.decisions[row.id]!.linkedRecordId : null;
    for (const record of ctx.records) {
      if (record.id === importedId) continue;
      const otherRowsImport = ownerOfImportedId.get(record.id);
      if (otherRowsImport != null && otherRowsImport !== row.id) continue;
      // A record the user linked by hand ("Find another transaction") may sit further out in time — same account,
      // same direction and the ₹1.00 band still apply.
      const candidate = evaluate(row, rowDay, rowPaise, record, record.id === linkedId ? MANUAL_LINK_WINDOW_DAYS : windowDays);

      if (record.accountId === ctx.accountId) {
        if (!candidate) continue;
        if (record.deleted) {
          if (candidate.amountBand === "exact") notes.push({ kind: "deleted_similar", recordId: record.id, message: `A transaction with this amount on ${formatDay(record)} was deleted — it is not a match.` });
          continue;
        }
        if (rejected.has(record.id)) continue;
        (record.kind === "sms_pending" ? smsCandidates : txnCandidates).push(candidate);
        continue;
      }

      // Outside the statement account: evidence only — never a candidate.
      if (record.deleted) continue;
      if (row.referenceNumber && containsReference(row.referenceNumber, record.description, record.notes) && record.kind === "transaction") {
        notes.push({ kind: "reference_elsewhere", recordId: record.id, message: `This row's reference number appears on a transaction in ${record.accountId ? label(record.accountId) : "another account"}.` });
        conflicts.push("The reference number matches a transaction on a different account — check which account this really belongs to.");
        continue;
      }
      if (!candidate || candidate.amountBand !== "exact" || Math.abs(candidate.dayGap) > (record.kind === "sms_pending" ? 1 : 0)) continue;
      if (record.kind === "sms_pending" && record.accountId == null) {
        notes.push({ kind: "unassigned_sms", recordId: record.id, message: `An SMS in the Inbox with this amount${record.rawLastFour ? ` (card/account ending ${record.rawLastFour})` : ""} has no matched account — it isn't compared here.` });
      } else if (record.kind === "transaction" && record.accountId && siblings.has(record.accountId)) {
        notes.push({ kind: "shared_limit_sibling", recordId: record.id, message: `Same amount and day on ${label(record.accountId)}, which shares this card's credit limit. Shown for reference only — it is not matched across cards.` });
      } else if (record.kind === "transaction" && record.accountId) {
        notes.push({ kind: "other_account", recordId: record.id, message: `Same amount and day on ${label(record.accountId)} — a different account, so it is not a match.` });
      }
    }

    txnCandidates.sort(byScore);
    smsCandidates.sort(byScore);
    candidatesByRow.set(row.id, txnCandidates);
    smsByRow.set(row.id, smsCandidates);
  }

  // Genuine repeats: identical statement rows (same date, merchant, amount, direction) are each decided separately.
  const groups = new Map<string, ReconRow[]>();
  for (const row of rows) {
    if (!row.include || !isComplete(row)) continue;
    const key = `${calendarDayIndex(row.date!)}|${toPaise(row.amount!)}|${row.direction}|${merchantKey(row.description)}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const existing = new Set(group.flatMap((r) => (candidatesByRow.get(r.id) ?? []).filter((c) => c.tier === "exact").map((c) => c.recordId)));
    for (const row of group) {
      notesByRow.get(row.id)!.push({
        kind: "possible_repeat",
        message: `${group.length} identical rows on this statement (same date, merchant and amount); FlowFi has ${existing.size} exact match${existing.size === 1 ? "" : "es"}. They may be genuine repeat purchases — decide each row separately.`,
      });
    }
  }

  const unlinked = new Map([...candidatesByRow].filter(([rowId]) => ctx.decisions[rowId]?.kind !== "link"));
  const suggestions = suggestPairs(unlinked, new Set(Object.keys(claimedBy)));

  return rows.map((row) => {
    const candidates = candidatesByRow.get(row.id) ?? [];
    const pendingSms = smsByRow.get(row.id) ?? [];
    const conflicts = [...(conflictsByRow.get(row.id) ?? [])];
    const decision = ctx.decisions[row.id];
    const linkedId = decision?.kind === "link" ? decision.linkedRecordId : null;
    const rowClaims: Record<string, string> = {};
    for (const c of candidates) if (claimedBy[c.recordId] && claimedBy[c.recordId] !== row.id) rowClaims[c.recordId] = claimedBy[c.recordId]!;
    const suggestedRecordId = linkedId ?? suggestions.get(row.id) ?? null;
    const base = {
      rowId: row.id,
      candidates,
      pendingSms,
      suggestedRecordId,
      alreadyImportedId: alreadyImported.get(row.id) ?? null,
      deletedImportId: deletedImports.get(row.id) ?? null,
      claimedBy: rowClaims,
      notes: notesByRow.get(row.id) ?? [],
    };
    const result = (state: MatchState, extra: string[] = []): RowMatch => ({ ...base, state, conflicts: [...conflicts, ...extra] });

    if (!row.include) return result("excluded");
    if (base.alreadyImportedId) return result("already_imported");
    if (!isComplete(row)) return result("conflict", ["Date, amount or Charge/Credit is missing — fill it in to compare."]);
    if (linkedId && claimedBy[linkedId] !== row.id) return result("conflict", ["The linked transaction is already linked to another row."]);
    if (conflicts.length > 0) return result("conflict");

    const available = candidates.filter((c) => !rowClaims[c.recordId]);
    if (candidates.length > 0 && available.length === 0) return result("conflict", ["Every possible match is already linked to another row."]);
    if (available.length === 0) return result(pendingSms.length > 0 ? "in_inbox" : "no_match");

    const suggested = available.find((c) => c.recordId === suggestedRecordId) ?? (linkedId ? candidates.find((c) => c.recordId === linkedId) : undefined);
    if (!suggested) return result("multiple");
    if (suggested.tier === "exact") {
      const otherExact = available.some((c) => c.recordId !== suggested.recordId && c.tier === "exact");
      return result(otherExact ? "multiple" : "exact_candidate");
    }
    return result(suggested.tier === "same_merchant_date" ? "same_merchant_date" : "near_amount");
  });
}
