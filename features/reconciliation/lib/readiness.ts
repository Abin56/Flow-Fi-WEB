/**
 * The draft-only readiness summary shown in the Reconciliation action bar. Pure — it reads the same gates as
 * `reviewSummary` / `buildApprovalPlan` (decisions.ts) and never decides anything itself.
 *
 * Every number answers one question, and none of them claims "everything will be imported": only rows the user
 * decided "Add as new" with a valid decision are proposed for a new import; already-recorded, skipped and Inbox rows
 * are never written.
 */

import { decisionErrors, decisionFor, importBlockReasons, valueIssues, type RowGateContext } from "./decisions";
import type { ReconRow, RowDecision, RowMatch } from "./types";

export interface ReadinessCounts {
  /** Rows in this review (Smart Capture exclusions not counted). */
  included: number;
  /** Excluded in Smart Capture — traceable here, never compared or imported. */
  excluded: number;
  /** Valid "Already recorded — skip import" decisions. */
  alreadyRecorded: number;
  /** Valid "Add as new transaction" decisions that would actually be written. */
  proposedNew: number;
  /** "Add as new" on a row whose own import key is already a live transaction — resolved, not written again. */
  alreadyImported: number;
  /** "Skip this transaction". */
  skipped: number;
  /** "Handle in Inbox" — left for the Transaction Inbox. */
  inbox: number;
  /** "Review later". */
  reviewLater: number;
  /** No decision yet, or a decision that isn't valid (e.g. Add as new without a category). Review later not included. */
  unresolved: number;
  /** Undecided / Add-as-new rows that financial rules stop from being added (closed bill, card payment, EMI…). */
  blocked: number;
}

export function readinessCounts(rows: ReconRow[], matches: Map<string, RowMatch>, decisions: Record<string, RowDecision>, gate: (row: ReconRow) => RowGateContext): ReadinessCounts {
  const c: ReadinessCounts = { included: 0, excluded: 0, alreadyRecorded: 0, proposedNew: 0, alreadyImported: 0, skipped: 0, inbox: 0, reviewLater: 0, unresolved: 0, blocked: 0 };
  for (const row of rows) {
    const match = matches.get(row.id);
    if (!row.include || row.captureExcluded || match?.state === "excluded") {
      c.excluded++;
      continue;
    }
    c.included++;
    if (!match) {
      c.unresolved++;
      continue;
    }
    const decision = decisionFor(decisions, row.id);
    const ctx = gate(row);
    // importBlockReasons starts with the row's value issues (fixable by editing/confirming) — only the rest are rules.
    const ruleReasons = importBlockReasons(row, match, ctx).length - valueIssues(row).length;
    if ((decision.kind == null || decision.kind === "import_new") && match.state !== "already_imported" && ruleReasons > 0) c.blocked++;
    if (decision.kind === "investigate") {
      c.reviewLater++;
      continue;
    }
    if (decision.kind == null || decisionErrors(row, match, decision, ctx).length > 0) {
      c.unresolved++;
      continue;
    }
    if (decision.kind === "link") c.alreadyRecorded++;
    else if (decision.kind === "import_new") {
      if (match.state === "already_imported") c.alreadyImported++;
      else c.proposedNew++;
    } else if (decision.kind === "ignore") c.skipped++;
    else if (decision.kind === "inbox") c.inbox++;
  }
  return c;
}
