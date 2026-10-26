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
import { runApproval, takeSnapshot, classifyDuplicateWarnings, type ApprovalDeps, type ApprovalRunResult, type ApprovalSnapshot, type StaleReason } from "../lib/approval-commit";
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
}

export function useReconciliationApproval({ uid, session, plan, account, liveData, dataReady, deps }: ApprovalInputs) {
  const [stage, setStage] = useState<ApprovalStage>("closed");
  const [snapshot, setSnapshot] = useState<ApprovalSnapshot | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [repeatsAck, setRepeatsAck] = useState(false);
  const [result, setResult] = useState<Extract<ApprovalRunResult, { status: "complete" | "partial" }> | null>(null);
  /** The rows as they were when approval was pressed — the result lists them even after the live data moves on (imported rows become "already imported"). */
  const [rowsAtApproval, setRowsAtApproval] = useState<PlanRow[]>([]);
  const [staleReasons, setStaleReasons] = useState<StaleReason[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const busyRef = useRef(false);

  const canOpen = dataReady && !!uid && !!session && !!plan && !!account && plan.complete;

  const take = useCallback(() => {
    if (!session || !plan || !account) return null;
    return takeSnapshot(session, plan, account);
  }, [session, plan, account]);

  const open = useCallback(() => {
    if (!canOpen || busyRef.current) return;
    const next = take();
    if (!next) return;
    setSnapshot(next);
    setConfirmed(false);
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
    setConfirmed(false);
  }, []);

  /** Re-take what the user is shown (live data moved while the review was open, or after a partial run). */
  const refresh = useCallback(() => {
    if (busyRef.current || !canOpen) return;
    const next = take();
    if (!next) return;
    setSnapshot(next);
    setConfirmed(false);
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
    const importIds = new Set(plan.rows.filter((r) => r.status === "import").map((r) => r.rowId));
    const staged = stagedRecordsForImport(session.rows, session.decisions, importIds);
    const rowNumber = (rowId: string) => session.rows.findIndex((r) => r.id === rowId) + 1;
    return classifyDuplicateWarnings(staged, liveData, session.accountId, snapshot.sessionId, snapshot, session, rowNumber).repeatRowIds;
  }, [stage, snapshot, session, plan, liveData]);

  const canApprove = stage === "review" && !!plan && plan.complete && plan.counts.newImports > 0 && !liveChanged && confirmed && (repeatRowIds.length === 0 || repeatsAck);

  const approve = useCallback(async () => {
    if (busyRef.current || !canApprove || !session || !snapshot || !uid) return;
    busyRef.current = true;
    setRowsAtApproval(plan?.rows ?? []);
    setStage("checking");
    try {
      const approvalDeps = deps ?? (await import("../lib/approval-app-deps")).createApprovalDeps(uid);
      const outcome = await runApproval({ session, reviewed: snapshot, repeatsAcknowledged: repeatsAck, deps: approvalDeps, onStage: setStage });
      switch (outcome.status) {
        case "complete":
        case "partial":
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
    }
  }, [canApprove, session, snapshot, uid, deps, repeatsAck, plan]);

  return { stage, open, close, refresh, approve, canOpen, canApprove, confirmed, setConfirmed, repeatsAck, setRepeatsAck, repeatRowIds, liveChanged, result, rowsAtApproval, staleReasons, message, isBusy: stage === "checking" || stage === "importing" };
}

export type ReconciliationApproval = ReturnType<typeof useReconciliationApproval>;
