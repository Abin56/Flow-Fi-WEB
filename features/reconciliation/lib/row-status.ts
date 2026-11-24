/**
 * ONE user-facing status per captured row (2026-11-24) — the four a person needs:
 *
 *   ready      valid, nothing unresolved: it will be imported
 *   duplicate  FlowFi may already have it — the user decides (keep existing / import / keep both)
 *   fix        something is missing, unreliable or blocked — it can't be imported as it is
 *   skipped    not imported: skipped, kept existing, left for the Inbox, imported earlier or excluded
 *
 * A pure view over the existing gates (valueIssues, importBlockReasons, decisionErrors) — it decides nothing and adds
 * no rule, so a row can never read "Ready" while the final approval would stop it, nor two statuses at once.
 */

import { decisionErrors, decisionFor, importBlockReasons, rowCheckLabel, valueIssues, type RowGateContext } from "./decisions";
import type { ReconRow, RowDecision, RowMatch } from "./types";

export type RowStatusKind = "ready" | "duplicate" | "fix" | "skipped";

export interface RowStatus {
  kind: RowStatusKind;
  /** Short chip text. */
  label: string;
  /** One line saying why (tooltip / inline). */
  reason: string;
}

const hasPossible = (m: RowMatch) => m.candidates.length > 0 || m.pendingSms.length > 0;

export function rowStatus(row: ReconRow, match: RowMatch | undefined, decisions: Record<string, RowDecision>, gate: RowGateContext): RowStatus | null {
  if (!match) return null; // matching hasn't run — never claim a status before it has
  if (row.removedFromReview) return { kind: "skipped", label: "Removed", reason: "Removed from this review." };
  if (!row.include || row.captureExcluded || match.state === "excluded") return { kind: "skipped", label: "Skipped", reason: "Excluded from this review." };
  if (match.state === "already_imported") return { kind: "skipped", label: "Imported", reason: "This exact row was imported earlier." };

  const decision = decisionFor(decisions, row.id);
  const errors = decisionErrors(row, match, decision, gate);
  if (decision.kind === "ignore") return { kind: "skipped", label: "Skipped", reason: "You chose not to import this row." };
  if (decision.kind === "link" && errors.length === 0) return { kind: "skipped", label: "Keep existing", reason: "Already in FlowFi — this row won't be imported." };
  if (decision.kind === "inbox" && errors.length === 0) return { kind: "skipped", label: "In Inbox", reason: "Left for the Transaction Inbox." };

  // Values first: a row that can't be trusted is "Fix required" whatever else is true of it.
  const values = valueIssues(row);
  if (values.length > 0) return { kind: "fix", label: "Fix required", reason: rowCheckLabel(row) ?? values[0]! };

  if (decision.kind === "investigate") return { kind: "duplicate", label: "Review later", reason: "Left open — decide before importing." };
  if (decision.kind === "link") return { kind: "duplicate", label: "Possible duplicate", reason: errors[0] ?? "Choose what to do." };

  if (decision.kind === "import_new") {
    if (errors.length === 0) return { kind: "ready", label: hasPossible(match) ? "Keep both" : "Ready", reason: hasPossible(match) ? "Both are kept — this row will be imported too." : "Will be imported." };
    if (hasPossible(match) && !decision.notSameAck) return { kind: "duplicate", label: "Possible duplicate", reason: "Decide whether it is the same as the match." };
    return { kind: "fix", label: "Fix required", reason: errors[0]! };
  }

  // No decision yet.
  if (hasPossible(match)) return { kind: "duplicate", label: "Possible duplicate", reason: match.state === "in_inbox" ? "An SMS for this is waiting in the Inbox." : "FlowFi may already have this — decide." };
  const blocked = importBlockReasons(row, match, gate);
  if (blocked.length > 0) return { kind: "fix", label: "Fix required", reason: blocked[0]! };
  if (row.direction === "credit") return { kind: "fix", label: "Fix required", reason: "Say whether this credit is a refund or income." };
  if (match.state === "conflict") return { kind: "fix", label: "Fix required", reason: match.conflicts[0] ?? "Something doesn't add up — check it." };
  return { kind: "fix", label: "Fix required", reason: "Choose a category." };
}

export interface StatusCounts {
  captured: number;
  ready: number;
  duplicate: number;
  fix: number;
  skipped: number;
}

export function statusCounts(rows: ReconRow[], matches: Map<string, RowMatch>, decisions: Record<string, RowDecision>, gate: (row: ReconRow) => RowGateContext): StatusCounts {
  const c: StatusCounts = { captured: rows.length, ready: 0, duplicate: 0, fix: 0, skipped: 0 };
  for (const row of rows) {
    const s = rowStatus(row, matches.get(row.id), decisions, gate(row));
    if (s) c[s.kind]++;
  }
  return c;
}
