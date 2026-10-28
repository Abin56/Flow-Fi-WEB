"use client";

/**
 * The reconciliation session for this tab: captured rows, the statement account and the user's draft decisions,
 * mirrored into the tab-scoped draft (D1). In memory only — nothing is written anywhere else.
 */

import { useCallback, useEffect, useState } from "react";
import type { RowPatch } from "@/features/smart-capture/lib/capture-review";
import type { CaptureField } from "@/features/smart-capture/lib/parse-pasted-statement";
import type { Account } from "@/lib/models/account";
import { rowsFromPastedText } from "../lib/capture-intake";
import { applyBulkLink, confirmRowField, confirmRowValues, editRow, invalidateAfterEdit, rejectCandidate, setDecision, undoBulk } from "../lib/decisions";
import { buildReconciliationDraft, clearReconciliationDraft, loadReconciliationDraft, saveReconciliationDraft, type DraftState } from "../lib/reconciliation-draft";
import { priorCaptureSessionIds } from "../lib/session-key";
import type { PendingHandoff } from "../lib/capture-handoff";
import { mergeHandoff, sessionFromHandoff, type MergeOutcome } from "../lib/handoff-merge";
import type { RowDecision } from "../lib/types";

export type DraftNotice = "restored" | "expired" | "corrupt" | null;

export function useReconciliationSession(uid: string | null | undefined, accounts: Account[]) {
  const [session, setSession] = useState<DraftState | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [notice, setNotice] = useState<DraftNotice>(null);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [storageFailed, setStorageFailed] = useState(false);

  // sessionStorage exists only in the browser — read the draft once the user is known.
  useEffect(() => {
    if (!uid || loadedFor === uid) return;
    const result = loadReconciliationDraft(uid);
    /* eslint-disable react-hooks/set-state-in-effect -- one-time read of browser-only storage after hydration */
    setLoadedFor(uid);
    if (result.status === "restored") {
      setSession(result.state);
      setExpiresAt(result.expiresAt);
      setNotice("restored");
    } else {
      setSession(null);
      setNotice(result.status === "none" ? null : result.status);
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [uid, loadedFor]);

  useEffect(() => {
    if (!uid || loadedFor !== uid || !session) return;
    const draft = buildReconciliationDraft(uid, session);
    const ok = saveReconciliationDraft(draft);
    /* eslint-disable react-hooks/set-state-in-effect -- mirrors the storage outcome into the privacy notice */
    setStorageFailed(!ok);
    setExpiresAt(draft.expiresAt);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [uid, loadedFor, session]);

  const startFromText = useCallback(
    (text: string): { error: string | null } => {
      const intake = rowsFromPastedText(text);
      if (intake.rows.length === 0) {
        return { error: text.trim() ? "No transaction rows found. Each row should start with a date (e.g. 05/09/2026 or 05 Sep) and include an amount like 1,299.00." : "Paste some statement rows first." };
      }
      setNotice(null);
      setSession({
        fingerprint: intake.fingerprint,
        source: "text",
        accountId: null,
        priorSessionIds: priorCaptureSessionIds(text, accounts.filter((a) => a.deletedAt == null)),
        rows: intake.rows,
        decisions: {},
        createdAt: Date.now(),
      });
      return { error: null };
    },
    [accounts],
  );

  const update = useCallback((fn: (s: DraftState) => DraftState) => setSession((s) => (s ? fn(s) : s)), []);

  /** A verified Smart Capture handoff becomes the review — only when there is none, or when the user chose to replace it. */
  const startFromHandoff = useCallback((pending: PendingHandoff) => {
    setNotice(null);
    setSession(sessionFromHandoff(pending));
  }, []);

  /** The same capture handed over again: merge by row id (see handoff-merge.ts) and say what changed. */
  const applySameCaptureHandoff = useCallback(
    (pending: PendingHandoff): MergeOutcome | null => {
      if (!session) return null;
      const outcome = mergeHandoff(session, pending);
      setSession(outcome.state);
      return outcome;
    },
    [session],
  );

  return {
    session,
    expiresAt,
    notice,
    storageFailed,
    ready: !!uid && loadedFor === uid,
    dismissNotice: () => setNotice(null),
    startFromText,
    startFromHandoff,
    applySameCaptureHandoff,
    /** Changing the statement account withdraws every Link/Import decision — they were made against another account's records. */
    setAccount: (accountId: string) =>
      update((s) => ({
        ...s,
        accountId,
        decisions: Object.fromEntries(
          Object.entries(s.decisions).map(([id, d]) => [id, { ...d, kind: d.kind === "link" || d.kind === "import_new" || d.kind === "inbox" ? null : d.kind, linkedRecordId: null, notSameAck: false, creditAs: null, rejectedRecordIds: [], bulkId: null }]),
        ),
      })),
    patchRow: (rowId: string, patch: RowPatch) =>
      update((s) => {
        const valueEdit = "date" in patch || "description" in patch || "amount" in patch || "direction" in patch;
        return { ...s, rows: s.rows.map((r) => (r.id === rowId ? editRow(r, patch) : r)), decisions: valueEdit ? invalidateAfterEdit(s.decisions, rowId) : s.decisions };
      }),
    confirmRow: (rowId: string) => update((s) => ({ ...s, rows: s.rows.map((r) => (r.id === rowId ? confirmRowValues(r) : r)) })),
    confirmField: (rowId: string, field: CaptureField) => update((s) => ({ ...s, rows: s.rows.map((r) => (r.id === rowId ? confirmRowField(r, field) : r)) })),
    decide: (rowId: string, patch: Partial<RowDecision>) => update((s) => ({ ...s, decisions: setDecision(s.decisions, rowId, patch) })),
    reject: (rowId: string, recordId: string) => update((s) => ({ ...s, decisions: rejectCandidate(s.decisions, rowId, recordId) })),
    bulkLink: (pairs: { rowId: string; recordId: string }[], bulkId: string) => update((s) => ({ ...s, decisions: applyBulkLink(s.decisions, pairs, bulkId) })),
    undoBulk: (bulkId: string) => update((s) => ({ ...s, decisions: undoBulk(s.decisions, bulkId) })),
    /** Draft Undo (decision-history.ts) — replaces the decisions map with one `undoLast` computed. */
    replaceDecisions: (decisions: Record<string, RowDecision>) => update((s) => ({ ...s, decisions })),
    discard: () => {
      if (uid) clearReconciliationDraft(uid);
      setSession(null);
      setExpiresAt(null);
      setNotice(null);
    },
  };
}

export type ReconciliationSession = ReturnType<typeof useReconciliationSession>;
