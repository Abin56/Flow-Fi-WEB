/**
 * ONE user-facing status per captured row (2026-11-25):
 *
 *   ready      valid, nothing unresolved: it can be imported now (row Import, or the global Import N)
 *   duplicate  "Possible match" — FlowFi may already have it: Already recorded / Import as new / Keep both / Review later
 *   fix        "Fix required" — something genuinely missing, unreliable or blocked; `next` says exactly what
 *   imported   this exact row is already a FlowFi transaction (its own import key)
 *   skipped    not imported by choice: skipped, already recorded, left for the Inbox, recorded in People / as a transfer,
 *              removed or excluded
 *
 * A pure view over the existing gates (valueIssues, importBlockReasons, decisionErrors) — it decides nothing and adds
 * no rule, so a row can never read "Ready" while the final approval would stop it, nor two statuses at once.
 */

import { canConfirmRowValues, decisionErrors, decisionFor, importBlockReasons, ownTransferConfirmFor, rowCheckLabel, valueIssues, type RowGateContext } from "./decisions";
import type { ReconRow, RowDecision, RowMatch } from "./types";

export type RowStatusKind = "ready" | "duplicate" | "fix" | "imported" | "skipped";

/** The one thing the row needs next — so the table can offer it right there, instead of a generic "Fix". */
export type RowNext =
  /** Ready: the row's own Import. */
  | "import"
  /** Compare with the possible match and decide. */
  | "review"
  /** The values are all there; one look settles an unclear OCR read ("Looks right"). */
  | "confirm_values"
  /** A value must be entered or picked (missing amount, dropped decimal…) — the editor. */
  | "fix_values"
  | "category"
  /** Refund / Income / from a person / own-account transfer. */
  | "credit_type"
  /** "Paid to (received from) someone else — not my own account". */
  | "own_transfer"
  /** A financial rule stops the import (card payment, closed bill, internal transfer…) — say why; nothing to click. */
  | "blocked"
  | null;

export interface RowStatus {
  kind: RowStatusKind;
  /** Short chip text. */
  label: string;
  /** One line saying why (shown beside the row, and as the tooltip). */
  reason: string;
  next: RowNext;
}

const hasPossible = (m: RowMatch) => m.candidates.length > 0 || m.pendingSms.length > 0;
const SKIP_LABEL = { people: "Record in People", transfer: "Own-account transfer" } as const;

export function rowStatus(row: ReconRow, match: RowMatch | undefined, decisions: Record<string, RowDecision>, gate: RowGateContext): RowStatus | null {
  if (!match) return null; // matching hasn't run — never claim a status before it has
  if (row.removedFromReview) return { kind: "skipped", label: "Removed", reason: "Removed from this review.", next: null };
  if (!row.include || row.captureExcluded || match.state === "excluded") return { kind: "skipped", label: "Skipped", reason: "Excluded from this review.", next: null };
  if (match.state === "already_imported") return { kind: "imported", label: "Imported", reason: "This row is already a FlowFi transaction.", next: null };

  const decision = decisionFor(decisions, row.id);
  const errors = decisionErrors(row, match, decision, gate);
  if (decision.kind === "ignore") {
    const why = decision.skipReason ? SKIP_LABEL[decision.skipReason] : null;
    return {
      kind: "skipped",
      label: why ?? "Skipped",
      reason: decision.skipReason === "people" ? "Money from a person — record it in People, so it is counted once." : decision.skipReason === "transfer" ? "Money between your own accounts — record it as a Transfer." : "You chose not to import this row.",
      next: null,
    };
  }
  if (decision.kind === "link" && errors.length === 0) return { kind: "skipped", label: "Already recorded", reason: "Already in FlowFi — this row won't be imported.", next: null };
  if (decision.kind === "inbox" && errors.length === 0) return { kind: "skipped", label: "In Inbox", reason: "Left for the Transaction Inbox.", next: null };

  // Values first: a row that can't be trusted is "Fix required" whatever else is true of it.
  if (valueIssues(row).length > 0) {
    const label = rowCheckLabel(row) ?? "Check values";
    return { kind: "fix", label: "Fix required", reason: label, next: canConfirmRowValues(row) ? "confirm_values" : "fix_values" };
  }
  // A financial rule (card payment, closed bill, internal transfer, an earlier deleted import…) blocks import outright.
  const rule = importBlockReasons(row, match, gate)[0];
  if (rule && decision.kind !== "link") return { kind: "fix", label: "Fix required", reason: rule, next: hasPossible(match) ? "review" : "blocked" };

  if (decision.kind === "investigate") return { kind: "duplicate", label: "Review later", reason: "Left open — decide before importing.", next: "review" };
  if (decision.kind === "link") return { kind: "duplicate", label: "Possible match", reason: errors[0] ?? "Choose what to do.", next: "review" };

  if (decision.kind === "import_new") {
    if (errors.length === 0) return { kind: "ready", label: "Ready", reason: hasPossible(match) ? "Both kept — this row is imported as a separate transaction." : "Will be imported.", next: "import" };
    if (hasPossible(match) && !decision.notSameAck) return { kind: "duplicate", label: "Possible match", reason: "Decide whether it is the same as the match.", next: "review" };
    return missing(row, decision, gate) ?? { kind: "fix", label: "Fix required", reason: errors[0]!, next: "fix_values" };
  }

  // No decision yet.
  if (hasPossible(match)) return { kind: "duplicate", label: "Possible match", reason: match.state === "in_inbox" ? "An SMS for this is waiting in the Inbox." : "FlowFi may already have this — compare and decide.", next: "review" };
  if (match.state === "conflict") return { kind: "fix", label: "Fix required", reason: match.conflicts[0] ?? "Something doesn't add up — check it.", next: "fix_values" };
  return missing(row, decision, gate) ?? { kind: "fix", label: "Fix required", reason: "Choose what to do with this row.", next: "fix_values" };
}

/** What an otherwise clean, unmatched row still needs, in the order it is asked. */
function missing(row: ReconRow, decision: RowDecision, gate: RowGateContext): RowStatus | null {
  if (row.direction === "credit" && !decision.creditAs) return { kind: "fix", label: "Fix required", reason: "Choose what this credit is.", next: "credit_type" };
  if (ownTransferConfirmFor(row, gate) && !decision.notOwnTransferAck) {
    return { kind: "fix", label: "Fix required", reason: row.direction === "credit" ? "Confirm it came from someone else (not your own account)." : "Confirm it went to someone else (not your own account).", next: "own_transfer" };
  }
  if (!decision.category) return { kind: "fix", label: "Fix required", reason: "Choose a category.", next: "category" };
  return null;
}

export interface StatusCounts {
  captured: number;
  ready: number;
  duplicate: number;
  fix: number;
  imported: number;
  skipped: number;
}

export function statusCounts(rows: ReconRow[], matches: Map<string, RowMatch>, decisions: Record<string, RowDecision>, gate: (row: ReconRow) => RowGateContext): StatusCounts {
  const c: StatusCounts = { captured: rows.length, ready: 0, duplicate: 0, fix: 0, imported: 0, skipped: 0 };
  for (const row of rows) {
    const s = rowStatus(row, matches.get(row.id), decisions, gate(row));
    if (s) c[s.kind]++;
  }
  return c;
}
