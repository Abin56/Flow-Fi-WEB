"use client";

/**
 * State machine of the final approval. Opening it writes nothing; only `approve()` — behind an explicit confirmation —
 * runs `runApproval` (live server revalidation, then the existing commit engine). Never started by an effect.
 *
 *   closed → review → checking → importing → result            (complete or partial — partial offers a safe retry)
 *                   ↘ stale        (the review is out of date or ambiguous: nothing was written)
 *                   ↘ unavailable  (FlowFi's records couldn't be re-read from the server: nothing was written)
 *
 * A second click, a repeated approval or a second tab can't write twice: the click is ignored while one approval is
 * running here (`busyRef`, plus `runApproval`'s own per-review lock), and every write is keyed (see approval-commit.ts).
 */

import { useCallback, useMemo, useRef, useState } from "react";
import type { Account } from "@/lib/models/account";
import type { ReconciliationData } from "../lib/analyze";
import { runApproval, takeSnapshot, classifyDuplicateWarnings, type ApprovalDeps, type ApprovalRunResult, type ApprovalSnapshot, type RowOutcome, type StaleReason } from "../lib/approval-commit";
import { changedEvidence, stagedRecordsForImport, type ApprovalPlan, type PlanRow } from "../lib/approval-plan";
import type { DraftState } from "../lib/reconciliation-draft";

export type ApprovalStage = "closed" | "review" | "checking" | "importing" | "result" | "stale" | "unavailable";

export interface ApprovalInputs {
  uid: string | null | undefined;
  session: DraftState | null;
  plan: ApprovalPlan | null;
  account: Account | null;
  /** The screen's live data — used only to preview the review; the commit re-reads the server itself. */
  liveData: ReconciliationData;
  /** Every live source has loaded successfully (no "No match" from an empty, not-yet-loaded list). */
  dataReady: boolean;
  /** Test seam; the app builds its own from the signed-in user. */
  deps?: ApprovalDeps;
  /**
   * A one-click import (row Import / global Import N) that finished with every chosen row imported: the screen shows a
   * compact summary instead of the result dialog. Not called for a partial run, a stale review or an unavailable server
   * - those keep the dialog, with the reasons and Retry.
   */
  onComplete?: (outcomes: RowOutcome[]) => void;
}

export function useReconciliationApproval({ uid, session, plan, account, liveData, dataReady, deps, onComplete }: ApprovalInputs) {
  const [stage, setStage] = useState<ApprovalStage>("closed");
  const [snapshot, setSnapshot] = useState<ApprovalSnapshot | null>(null);
  const [confirmed, setConfirmed] = useState(true);
  /** The approval was started straight from the Import button (no summary step) — the dialog stays compact. */
  const [direct, setDirect] = useState(false);
  const [repeatsAck, setRepeatsAck] = useState(false);
  const [result, setResult] = useState<Extract<ApprovalRunResult, { status: "complete" | "partial" }> | null>(null);
  /** The rows as they were when approval was pressed — the result lists them even after the live data moves on (imported rows become "already imported"). */
  const [rowsAtApproval, setRowsAtApproval] = useState<PlanRow[]>([]);
  const [staleReasons, setStaleReasons] = useState<StaleReason[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const busyRef = useRef(false);
  /** The rows the current / last one-click import covers - a retry or "Try again" re-runs exactly these (null = whole review). */
  const scopeRef = useRef<string[] | null>(null);
  /** The same scope, for rendering (the ref is what the click path reads synchronously). */
  const [scope, setScope] = useState<string[] | null>(null);
  /** Rows whose import is running right now (the row's own spinner; a second click is ignored). */
  const [running, setRunning] = useState<string[]>([]);
  /** Rows written so far in the current import (real counts from the engine). */
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  // 2026-11-25: importing no longer waits for EVERY row to be resolved - each import covers the rows that are Ready (or
  // one row), and the rest stay in the review. The whole-review summary (open) keeps its old rule.
  const canOpen = dataReady && !!uid && !!session && !!plan && !!account && plan.complete;
  const canImport = dataReady && !!uid && !!session && !!plan && !!account && plan.counts.newImports > 0;

  const take = useCallback(() => {
    if (!session || !plan || !account) return null;
    return takeSnapshot(session, plan, account);
  }, [session, plan, account]);

  const open = useCallback(() => {
    if (!canOpen || busyRef.current) return;
    scopeRef.current = null;
    setScope(null);
    const next = take();
    if (!next) return;
    setSnapshot(next);
    setConfirmed(true);
    setDirect(false);
    setRepeatsAck(false);
    setResult(null);
    setStaleReasons([]);
    setMessage(null);
    setStage("review");
  }, [canOpen, take]);

  /** Back to the review screen (Close / "Back to reconciliation"); not while a write may be in flight. */
  const close = useCallback(() => {
    if (busyRef.current) return;
    setStage("closed");
    setDirect(false);
  }, []);

  /** Re-take what the user is shown (live data moved while the review was open, or after a partial run). */
  const refresh = useCallback(() => {
    if (busyRef.current || !canOpen) return;
    const next = take();
    if (!next) return;
    setSnapshot(next);
    setConfirmed(true);
    setRepeatsAck(false);
    setResult(null);
    setStaleReasons([]);
    setMessage(null);
    setStage("review");
  }, [canOpen, take]);

  const liveChanged = stage === "review" && snapshot != null && plan != null && changedEvidence(snapshot.evidence, plan.evidence).length > 0;

  // Rows that look like repeats of each other in this very import — the user must say they're separate purchases.
  const repeatRowIds = useMemo(() => {
    if (stage !== "review" || !snapshot || !session || !plan || !session.accountId) return [] as string[];
    const importIds = new Set(plan.rows.filter((r) => r.status === "import" && (scope == null || scope.includes(r.rowId))).map((r) => r.rowId));
    const staged = stagedRecordsForImport(session.rows, session.decisions, importIds);
    const rowNumber = (rowId: string) => session.rows.findIndex((r) => r.id === rowId) + 1;
    return classifyDuplicateWarnings(staged, liveData, session.accountId, snapshot.sessionId, snapshot, session, rowNumber).repeatRowIds;
  }, [stage, snapshot, session, plan, liveData, scope]);

  // The Import button is the user's explicit confirmation (2026-11-24) — there is no separate "I confirm" tick any more.
  // What stays: the repeated-rows acknowledgement, and the server re-check inside `runApproval`.
  const scopedImports = plan ? plan.rows.filter((r) => r.status === "import" && (scope == null || scope.includes(r.rowId))).length : 0;
  const canApprove = stage === "review" && !!plan && (direct ? scopedImports > 0 : plan.complete && plan.counts.newImports > 0) && !liveChanged && (repeatRowIds.length === 0 || repeatsAck);

  /** Runs the approval for `reviewed` (the snapshot the user is importing). Ignored while one is already running. */
  const run = useCallback(
    async (reviewed: ApprovalSnapshot, acknowledged: boolean) => {
      if (busyRef.current || !session || !uid) return;
      busyRef.current = true;
      const scope = scopeRef.current;
      setRowsAtApproval(plan?.rows ?? []);
      setRunning(scope ?? plan?.rows.filter((r) => r.status === "import").map((r) => r.rowId) ?? []);
      setStage("checking");
      try {
        const approvalDeps = deps ?? (await import("../lib/approval-app-deps")).createApprovalDeps(uid);
        const outcome = await runApproval({ session, reviewed, repeatsAcknowledged: acknowledged, deps: approvalDeps, onStage: setStage, scope: scope ? new Set(scope) : null, onProgress: (done, total) => setProgress({ done, total }) });
        switch (outcome.status) {
          case "complete":
            setResult(outcome);
            if (scope && onComplete) {
              onComplete(outcome.outcomes);
              setStage("closed");
            } else setStage("result");
            break;
          case "partial":
            // Rows that DID land are done now — they must not be offered (or retried) as new work.
            if (scope && onComplete) onComplete(outcome.outcomes.filter((o) => o.kind === "imported" || o.kind === "already_imported"));
            setResult(outcome);
            setStage("result");
            break;
          case "stale":
            setStaleReasons(outcome.reasons);
            setStage("stale");
            break;
          case "unavailable":
            setMessage(outcome.message);
            setStage("unavailable");
            break;
          case "busy":
            setStage("review");
            break;
        }
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "The approval couldn't start.");
        setStage("unavailable");
      } finally {
        busyRef.current = false;
        setRunning([]);
        setProgress(null);
      }
    },
    [session, uid, deps, plan, onComplete],
  );

  /**
   * "Import N transactions": one click. Takes the snapshot of what is on screen and imports it straight away (the server
   * re-read, evidence diff, duplicate checks and keyed writes all still run inside `runApproval`). The summary dialog only
   * appears when the user's own acknowledgement is genuinely needed (identical rows in this import) or FlowFi moved.
   */
  const importNow = useCallback(async (rowIds?: string[]) => {
    if (busyRef.current || !session || !plan || !canImport) return;
    // A fresh click names its rows; "Try again" / "Retry" (no argument) re-runs the rows of the last one-click import -
    // rows that landed are "already imported" by then, so only the failed ones are written.
    if (rowIds) {
      scopeRef.current = rowIds;
      setScope(rowIds);
    }
    const scope = scopeRef.current;
    const ready = plan.rows.filter((r) => r.status === "import" && (scope == null || scope.includes(r.rowId)));
    if (ready.length === 0) return;
    const next = take();
    if (!next) return;
    setSnapshot(next);
    setConfirmed(true);
    setRepeatsAck(false);
    setResult(null);
    setStaleReasons([]);
    setMessage(null);
    setDirect(true);
    const importIds = new Set(ready.map((r) => r.rowId));
    const staged = stagedRecordsForImport(session.rows, session.decisions, importIds);
    const rowNumber = (rowId: string) => session.rows.findIndex((r) => r.id === rowId) + 1;
    const repeats = session.accountId ? classifyDuplicateWarnings(staged, liveData, session.accountId, next.sessionId, next, session, rowNumber).repeatRowIds : [];
    if (repeats.length > 0) {
      setStage("review"); // the user's own "these are separate purchases" is needed — shown compactly, then Import
      return;
    }
    await run(next, false);
  }, [canImport, session, plan, take, liveData, run]);

  const approve = useCallback(async () => {
    if (!canApprove || !snapshot) return;
    await run(snapshot, repeatsAck);
  }, [canApprove, snapshot, repeatsAck, run]);

  return { stage, open, close, refresh, approve, importNow, direct, canOpen, canImport, running, progress, canApprove, confirmed, setConfirmed, repeatsAck, setRepeatsAck, repeatRowIds, liveChanged, result, rowsAtApproval, staleReasons, message, isBusy: stage === "checking" || stage === "importing" };
}

export type ReconciliationApproval = ReturnType<typeof useReconciliationApproval>;
