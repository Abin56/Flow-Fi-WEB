/**
 * Draft decisions and the gates around them. Pure — a decision is only the user's recorded intent in this tab.
 * A decision is never a write: only the Phase 4 final approval (approval-commit.ts) writes, and only rows whose
 * decision is a valid "Import as new". Link, Ignore and Handle-in-Inbox write nothing, ever.
 *
 * Rules (Stage 6 + product decisions):
 *  - Every included row needs an explicit decision; Investigate keeps the review open.
 *  - Link: only to a current candidate on the statement account, one-to-one (D7: the link is never persisted).
 *  - Import as new on a row that has ANY candidate (or a pending SMS) needs the per-row "different transaction"
 *    confirmation; bulk can't give it.
 *  - Import as new is blocked for: unverified/edited-unconfirmed values (D6), an already-imported row, a card
 *    payment (D8), an EMI line, and a date in a closed or already-paid card bill (D10).
 *  - Bulk Link only for unique exact candidates, with confirmation and Undo (D5).
 */

import { applyRowPatch, confirmField, isComplete, openIssues, type RowPatch } from "@/features/smart-capture/lib/capture-review";
import type { CaptureField } from "@/features/smart-capture/lib/parse-pasted-statement";
import type { CaptureAction } from "@/features/smart-capture/lib/capture-review";
import type { CycleInfo, DecisionKind, ReconRow, RowDecision, RowMatch } from "./types";

export const EMPTY_DECISION: RowDecision = { kind: null, linkedRecordId: null, notSameAck: false, rejectedRecordIds: [], category: null, notes: "", bulkId: null, creditAs: null };

export function decisionFor(decisions: Record<string, RowDecision>, rowId: string): RowDecision {
  return decisions[rowId] ?? EMPTY_DECISION;
}

export interface RowGateContext {
  /** True when the statement account is a card account. */
  isCardAccount: boolean;
  cycle: CycleInfo | null;
}

/** Rows whose captured values still need attention before they may be imported (D6 + Smart Capture's gates). */
export function valueIssues(row: ReconRow): string[] {
  const out: string[] = [];
  if (!isComplete(row)) out.push("Date, amount and Charge/Credit are all needed.");
  else if (openIssues(row).length > 0) out.push("Resolve the flagged values first.");
  if (row.needsReconfirm) out.push("You changed this row — confirm the values are correct.");
  return out;
}

/** Why "Import as new" isn't available for this row (empty = eligible). */
export function importBlockReasons(row: ReconRow, match: RowMatch, ctx: RowGateContext): string[] {
  const reasons = valueIssues(row);
  if (match.state === "already_imported") reasons.push("This row is already imported — link it to that transaction instead.");
  if (ctx.isCardAccount && row.kind === "payment" && row.direction === "credit") reasons.push("Card payments can't be imported here. Link it to the payment already recorded, or record it from Pay bill.");
  if (row.kind === "emi") reasons.push("EMI lines can't be imported here — record them in Loan & EMI, or link to the recorded payment.");
  if (ctx.cycle && ctx.cycle.status !== "open") {
    reasons.push(
      ctx.cycle.status === "paid"
        ? "This date is in a card bill that is already paid. Import is blocked until it's reviewed separately."
        : "This date is in a card bill that has already closed. Import is blocked until it's reviewed separately.",
    );
  }
  return reasons;
}

/**
 * The commit action an Import-as-new row maps to — never guessed. A Charge is a normal expense; a Credit is a refund
 * or income only when the user said which (null until they do).
 */
export function importActionFor(row: ReconRow, decision: RowDecision): Extract<CaptureAction, "normal_expense" | "refund" | "income"> | null {
  if (row.direction === "debit") return "normal_expense";
  if (row.direction === "credit") return decision.creditAs ?? null;
  return null;
}

/** Problems with the row's current decision. Empty = a complete, valid draft decision (Investigate excepted). */
export function decisionErrors(row: ReconRow, match: RowMatch, decision: RowDecision, ctx: RowGateContext): string[] {
  if (!row.include || match.state === "excluded") return [];
  switch (decision.kind) {
    case null:
      return ["Choose what to do with this row."];
    case "link": {
      if (!decision.linkedRecordId) return ["Choose the transaction to link."];
      if (!match.candidates.some((c) => c.recordId === decision.linkedRecordId) && match.alreadyImportedId !== decision.linkedRecordId) {
        return ["The linked transaction is no longer a possible match (it may have been deleted or changed)."];
      }
      if (match.claimedBy[decision.linkedRecordId]) return ["That transaction is already linked to another row."];
      return [];
    }
    case "import_new": {
      // Imported earlier (this row's own deterministic key is already a live transaction): nothing left to write.
      if (match.state === "already_imported") return [];
      const errors = importBlockReasons(row, match, ctx);
      if (row.direction === "credit" && !decision.creditAs) errors.push("Say whether this credit is a refund or income.");
      if ((match.candidates.length > 0 || match.pendingSms.length > 0) && !decision.notSameAck) errors.push("Confirm this is a different transaction from the possible matches.");
      if (!decision.category) errors.push("Choose a category.");
      return errors;
    }
    case "inbox":
      return match.pendingSms.length > 0 ? [] : ["No SMS for this row is waiting in the Inbox."];
    case "ignore":
    case "investigate":
      return [];
  }
}

export interface ReviewSummary {
  total: number;
  included: number;
  /** Included rows with a valid, final decision (not Investigate). */
  decided: number;
  investigate: number;
  /** Included rows still needing a decision or with an invalid one. */
  open: number;
  byDecision: Record<DecisionKind, number>;
  /** Every included row is decided and nothing is under investigation. */
  complete: boolean;
}

export function reviewSummary(rows: ReconRow[], matches: Map<string, RowMatch>, decisions: Record<string, RowDecision>, gate: (row: ReconRow) => RowGateContext): ReviewSummary {
  const byDecision: Record<DecisionKind, number> = { link: 0, import_new: 0, ignore: 0, investigate: 0, inbox: 0 };
  let included = 0;
  let decided = 0;
  let investigate = 0;
  for (const row of rows) {
    const match = matches.get(row.id);
    if (!row.include || !match || match.state === "excluded") continue;
    included++;
    const decision = decisionFor(decisions, row.id);
    if (decision.kind) byDecision[decision.kind]++;
    if (decision.kind === "investigate") investigate++;
    else if (decisionErrors(row, match, decision, gate(row)).length === 0) decided++;
  }
  return { total: rows.length, included, decided, investigate, open: included - decided - investigate, byDecision, complete: included > 0 && decided === included };
}

/** D5 — rows a bulk Link may decide: undecided, unique exact candidate, suggestion still free. */
export function bulkLinkEligible(rows: ReconRow[], matches: Map<string, RowMatch>, decisions: Record<string, RowDecision>): { rowId: string; recordId: string }[] {
  const out: { rowId: string; recordId: string }[] = [];
  for (const row of rows) {
    const match = matches.get(row.id);
    if (!row.include || !match || match.state !== "exact_candidate" || !match.suggestedRecordId) continue;
    if (decisionFor(decisions, row.id).kind != null) continue;
    out.push({ rowId: row.id, recordId: match.suggestedRecordId });
  }
  return out;
}

export function applyBulkLink(decisions: Record<string, RowDecision>, pairs: { rowId: string; recordId: string }[], bulkId: string): Record<string, RowDecision> {
  const next = { ...decisions };
  for (const { rowId, recordId } of pairs) next[rowId] = { ...decisionFor(decisions, rowId), kind: "link", linkedRecordId: recordId, notSameAck: false, bulkId };
  return next;
}

/** Undo reverts only the decisions that bulk made and the user hasn't changed since. */
export function undoBulk(decisions: Record<string, RowDecision>, bulkId: string): Record<string, RowDecision> {
  const next: Record<string, RowDecision> = {};
  for (const [rowId, d] of Object.entries(decisions)) next[rowId] = d.bulkId === bulkId ? { ...d, kind: null, linkedRecordId: null, bulkId: null } : d;
  return next;
}

/** Sets a decision by hand — always clears the bulk marker (so Undo never reverts a manual choice). */
export function setDecision(decisions: Record<string, RowDecision>, rowId: string, patch: Partial<RowDecision>): Record<string, RowDecision> {
  const current = decisionFor(decisions, rowId);
  const next: RowDecision = { ...current, ...patch, bulkId: null };
  if (patch.kind != null && patch.kind !== "link") next.linkedRecordId = null;
  if (patch.kind != null && patch.kind !== "import_new") {
    next.notSameAck = false;
    next.creditAs = null;
  }
  return { ...decisions, [rowId]: next };
}

/** "Not this one" — the matcher drops the record for this row; a Link to it is withdrawn. */
export function rejectCandidate(decisions: Record<string, RowDecision>, rowId: string, recordId: string): Record<string, RowDecision> {
  const current = decisionFor(decisions, rowId);
  const unlink = current.kind === "link" && current.linkedRecordId === recordId;
  return {
    ...decisions,
    [rowId]: { ...current, rejectedRecordIds: [...new Set([...current.rejectedRecordIds, recordId])], ...(unlink ? { kind: null, linkedRecordId: null } : {}), bulkId: null },
  };
}

/**
 * D6 — editing a captured value goes through Smart Capture's own `applyRowPatch` (an edit withdraws that field's
 * confirmation) and additionally requires an explicit re-confirmation here. A non-value patch (include) doesn't.
 */
export function editRow(row: ReconRow, patch: RowPatch): ReconRow {
  const valueEdit = "date" in patch || "description" in patch || "amount" in patch || "direction" in patch;
  const next = applyRowPatch(row, patch) as ReconRow;
  return valueEdit ? { ...next, confirmed: false, bulkConfirmed: false, needsReconfirm: true } : next;
}

/** "Values are correct" — the row-level confirmation (clears ordinary flags, as in Smart Capture) and D6's re-confirm. */
export function confirmRowValues(row: ReconRow): ReconRow {
  return { ...row, confirmed: true, needsReconfirm: false };
}

export function confirmRowField(row: ReconRow, field: CaptureField): ReconRow {
  return confirmField(row, field) as ReconRow;
}

/** A row's decision after its values changed: a Link or an Import confirmation was made against the old values. */
export function invalidateAfterEdit(decisions: Record<string, RowDecision>, rowId: string): Record<string, RowDecision> {
  const current = decisions[rowId];
  if (!current) return decisions;
  return { ...decisions, [rowId]: { ...current, kind: current.kind === "link" || current.kind === "import_new" ? null : current.kind, linkedRecordId: null, notSameAck: false, creditAs: null, rejectedRecordIds: [], bulkId: null } };
}
