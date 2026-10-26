/**
 * Applying a Smart Capture handoff to the reconciliation session. Pure.
 *
 *  - No review yet → a new session from the handoff, exactly as handed over.
 *  - Same capture (same source fingerprint) handed over again (after "Back to Smart Capture") → merge by row id:
 *    rows Smart Capture didn't change keep everything done in Reconciliation; rows it changed are replaced and lose
 *    their decision; rows it no longer has are dropped. The caller reports the counts — nothing is silent.
 *  - A different capture never reaches here without the user choosing to replace their current review.
 */

import type { ReviewRow } from "@/features/smart-capture/lib/capture-review";
import type { PendingHandoff } from "./capture-handoff";
import type { DraftState } from "./reconciliation-draft";
import type { ReconRow } from "./types";

/** The values a handoff carries for a row — what "Smart Capture changed it" is measured against. */
export function captureSignature(row: Pick<ReviewRow, "date" | "amount" | "direction" | "description" | "include">): string {
  return [row.date ? row.date.getTime() : "", row.amount ?? "", row.direction ?? "", row.description, row.include ? 1 : 0].join("|");
}

function withBaseline(row: ReconRow): ReconRow {
  return { ...row, captureBaseline: captureSignature(row) };
}

/**
 * A new review never starts with an account chosen: duplicates are checked against exactly one account, and the
 * user picks it here, explicitly — even if the handoff carried one (an old capture draft could), it is not applied.
 */
export function sessionFromHandoff(pending: PendingHandoff, now = Date.now()): DraftState {
  return {
    fingerprint: pending.fingerprint,
    source: pending.source,
    accountId: null,
    priorSessionIds: pending.priorSessionIds,
    rows: pending.rows.map(withBaseline),
    decisions: {},
    createdAt: now,
  };
}

export interface MergeOutcome {
  state: DraftState;
  kept: number;
  changed: number;
  added: number;
  removed: number;
}

export function mergeHandoff(session: DraftState, pending: PendingHandoff): MergeOutcome {
  const existing = new Map(session.rows.map((r) => [r.id, r]));
  const decisions: DraftState["decisions"] = {};
  let kept = 0;
  let changed = 0;
  let added = 0;
  const rows = pending.rows.map((incoming) => {
    const current = existing.get(incoming.id);
    const signature = captureSignature(incoming);
    if (!current) {
      added++;
      return withBaseline(incoming);
    }
    const baseline = current.captureBaseline ?? captureSignature(current);
    if (baseline === signature) {
      kept++;
      if (session.decisions[incoming.id]) decisions[incoming.id] = session.decisions[incoming.id]!;
      // Same values as before: keep this review's row (and any edits made here); refresh the in-memory OCR geometry.
      return { ...current, ocr: incoming.ocr ?? current.ocr, captureExcluded: incoming.captureExcluded, captureBaseline: signature };
    }
    changed++;
    return withBaseline(incoming);
  });
  const ids = new Set(pending.rows.map((r) => r.id));
  const removed = session.rows.filter((r) => !ids.has(r.id)).length;
  return {
    state: { ...session, source: pending.source, priorSessionIds: { ...session.priorSessionIds, ...pending.priorSessionIds }, accountId: session.accountId ?? pending.accountId, rows, decisions },
    kept,
    changed,
    added,
    removed,
  };
}
