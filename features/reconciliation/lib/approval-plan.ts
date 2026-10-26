/**
 * Phase 4 — what an approval would do, row by row. Pure: it classifies every captured row from the matcher's evidence
 * and the user's decisions, totals the money, and fingerprints the evidence the user reviewed. Nothing here reads or
 * writes FlowFi data.
 *
 * Gates (Stage 6 + Phase 4):
 *  - Every included row needs an explicit decision; Investigate (or no decision, or an invalid one) BLOCKS approval.
 *  - Link, Ignore and Handle-in-Inbox are never writes.
 *  - Only a valid "Import as new" — a normal expense, income or refund — is ever written. Card payments, EMI lines,
 *    transfers, loans, person assignments and splits cannot reach this far (decisions.ts blocks them), and nothing
 *    here converts one of them into an expense.
 *  - A row whose own deterministic import key is already a live transaction is "already imported" — resolved, never
 *    written again.
 */

import type { StagedRecord } from "@/lib/models/document-import";
import { toStagedRecords, type CaptureAction } from "@/features/smart-capture/lib/capture-review";
import { toPaise } from "./amounts-and-days";
import { decisionErrors, decisionFor, importActionFor, type RowGateContext } from "./decisions";
import type { ReconRow, RowDecision, RowMatch } from "./types";

export type ImportAction = Extract<CaptureAction, "normal_expense" | "refund" | "income">;

export type PlanStatus = "import" | "already_imported" | "link" | "ignore" | "inbox" | "excluded" | "blocked";

export interface PlanRow {
  rowId: string;
  /** 1-based position in the capture, as the table numbers it. */
  number: number;
  status: PlanStatus;
  description: string;
  date: Date | null;
  amount: number | null;
  direction: ReconRow["direction"];
  /** The commit action for a row that will be imported. */
  action: ImportAction | null;
  category: string | null;
  /** The existing transaction a Link points at, or the transaction an already-imported row became. */
  recordId: string | null;
  /** Why a blocked row can't be approved (Investigate included). */
  reasons: string[];
  investigate: boolean;
}

export interface PlanCounts {
  /** Every row in the capture. */
  captured: number;
  /** Rows left out of the review (excluded in Smart Capture) — they are never compared or imported. */
  excluded: number;
  linked: number;
  /** Rows that WILL be written. */
  newImports: number;
  alreadyImported: number;
  ignored: number;
  inbox: number;
  /** Included rows with no valid final decision (Investigate counts here too). */
  unresolved: number;
  investigate: number;
}

export interface ApprovalPlan {
  rows: PlanRow[];
  counts: PlanCounts;
  /** New charges / credits to be written, in integer paise (no float drift). */
  chargesPaise: number;
  creditsPaise: number;
  refundsPaise: number;
  incomePaise: number;
  /** What the import does to the account's own balance: credits − charges. */
  balanceDeltaPaise: number;
  /** Nothing blocks: every included row has a valid decision and nothing is under investigation. */
  complete: boolean;
  /** Per included row, a fingerprint of the evidence the decision rests on (see `rowEvidence`). */
  evidence: Record<string, string>;
  /** Per included row, the ids of every possible match (transactions and waiting SMS) the user could see — what an "I checked, it's different" confirmation covered. */
  candidateIds: Record<string, string[]>;
}

/**
 * The evidence a row's decision rests on: the matcher's state, every possible match (id, amount gap, day gap, tier),
 * waiting SMS, the exact-import id and the linked record. If any of it differs at commit time the user decided
 * against a picture that no longer holds — and a "No match" shown earlier can't authorize an import by itself.
 */
export function rowEvidence(match: RowMatch, decision: RowDecision): string {
  const candidate = (c: RowMatch["candidates"][number]) => `${c.recordId}~${c.amountDeltaPaise}~${c.dayGap}~${c.tier}`;
  return JSON.stringify({
    s: match.state,
    c: match.candidates.map(candidate).sort(),
    p: match.pendingSms.map(candidate).sort(),
    i: match.alreadyImportedId,
    l: decision.kind === "link" ? decision.linkedRecordId : null,
  });
}

export function buildApprovalPlan(params: {
  rows: ReconRow[];
  matches: Map<string, RowMatch>;
  decisions: Record<string, RowDecision>;
  gate: (row: ReconRow) => RowGateContext;
}): ApprovalPlan {
  const { rows, matches, decisions, gate } = params;
  const counts: PlanCounts = { captured: rows.length, excluded: 0, linked: 0, newImports: 0, alreadyImported: 0, ignored: 0, inbox: 0, unresolved: 0, investigate: 0 };
  let chargesPaise = 0;
  let refundsPaise = 0;
  let incomePaise = 0;
  const evidence: Record<string, string> = {};
  const candidateIds: Record<string, string[]> = {};
  const out: PlanRow[] = [];

  rows.forEach((row, index) => {
    const base = { rowId: row.id, number: index + 1, description: row.description, date: row.date, amount: row.amount, direction: row.direction, action: null, category: null, recordId: null, reasons: [] as string[], investigate: false };
    const match = matches.get(row.id);
    if (!row.include || match?.state === "excluded") {
      counts.excluded++;
      out.push({ ...base, status: "excluded" });
      return;
    }
    if (!match) {
      counts.unresolved++;
      out.push({ ...base, status: "blocked", reasons: ["This row hasn't been compared with FlowFi yet."] });
      return;
    }
    const decision = decisionFor(decisions, row.id);
    evidence[row.id] = rowEvidence(match, decision);
    candidateIds[row.id] = [...match.candidates, ...match.pendingSms].map((c) => c.recordId);

    if (decision.kind === "investigate") {
      counts.unresolved++;
      counts.investigate++;
      out.push({ ...base, status: "blocked", investigate: true, reasons: ["Marked Investigate — decide what to do with it first."] });
      return;
    }
    // A row imported earlier is finished whatever else is true of it today (its own key is a live transaction).
    if (decision.kind === "import_new" && match.state === "already_imported" && match.alreadyImportedId) {
      counts.alreadyImported++;
      out.push({ ...base, status: "already_imported", recordId: match.alreadyImportedId });
      return;
    }
    const errors = decisionErrors(row, match, decision, gate(row));
    if (errors.length > 0) {
      counts.unresolved++;
      out.push({ ...base, status: "blocked", reasons: errors });
      return;
    }
    switch (decision.kind) {
      case "link":
        counts.linked++;
        out.push({ ...base, status: "link", recordId: decision.linkedRecordId });
        return;
      case "ignore":
        counts.ignored++;
        out.push({ ...base, status: "ignore" });
        return;
      case "inbox":
        counts.inbox++;
        out.push({ ...base, status: "inbox" });
        return;
      case "import_new": {
        const action = importActionFor(row, decision);
        if (!action || !row.amount || !row.direction) {
          // decisionErrors already refuses this; kept as a second, independent guard so nothing unsupported is written.
          counts.unresolved++;
          out.push({ ...base, status: "blocked", reasons: ["This row isn't a supported expense, income or refund."] });
          return;
        }
        const paise = toPaise(row.amount);
        if (row.direction === "debit") chargesPaise += paise;
        else if (action === "refund") refundsPaise += paise;
        else incomePaise += paise;
        counts.newImports++;
        out.push({ ...base, status: "import", action, category: decision.category });
        return;
      }
      default:
        counts.unresolved++;
        out.push({ ...base, status: "blocked", reasons: ["Choose what to do with this row."] });
    }
  });

  const creditsPaise = refundsPaise + incomePaise;
  return {
    rows: out,
    counts,
    chargesPaise,
    creditsPaise,
    refundsPaise,
    incomePaise,
    balanceDeltaPaise: creditsPaise - chargesPaise,
    complete: counts.unresolved === 0 && counts.captured - counts.excluded > 0,
    evidence,
    candidateIds,
  };
}

/** Rows whose evidence differs between what the user reviewed and what is true now. */
export function changedEvidence(reviewed: Record<string, string>, fresh: Record<string, string>): string[] {
  const ids = new Set([...Object.keys(reviewed), ...Object.keys(fresh)]);
  return [...ids].filter((id) => reviewed[id] !== fresh[id]);
}

/** The note every Reconciliation import carries; "Smart Capture" keeps `transactionOrigin` classifying it as such. */
export const RECONCILIATION_IMPORT_NOTE = "Imported via Reconciliation (Smart Capture)";

/**
 * The exact `StagedRecord`s the existing commit engine takes, for the rows that will be imported — built with Smart
 * Capture's own `toStagedRecords`, so there is no second row→transaction mapping. Only expense/income/refund actions
 * are ever set, so the engine's single-write path is the only one these can reach.
 */
export function stagedRecordsForImport(rows: ReconRow[], decisions: Record<string, RowDecision>, importRowIds: ReadonlySet<string>): StagedRecord[] {
  const reviewRows = rows
    .filter((r) => importRowIds.has(r.id))
    .map((r) => {
      const d = decisionFor(decisions, r.id);
      return { ...r, include: true, action: importActionFor(r, d), category: d.category, committedTransactionId: null };
    });
  return toStagedRecords(reviewRows).map((record) => {
    const userNote = decisionFor(decisions, record.id).notes.trim();
    return { ...record, notes: userNote ? `${userNote} · ${RECONCILIATION_IMPORT_NOTE}` : RECONCILIATION_IMPORT_NOTE };
  });
}
