"use client";

/**
 * Shared pre-create duplicate gate — the one hook every UI flow that creates
 * a new expense/income `Transaction` should call before writing it, so the
 * "warn on same date/amount as an existing transaction" behavior lives in
 * exactly one place instead of being re-implemented (or forgotten) per
 * feature. Wraps `checkForDuplicates` (the matching rule) together with the
 * interrupt-and-confirm UX `DuplicateWarningDialog` already established by
 * manual entry, SMS import, and PDF Transaction Studio.
 *
 * This is a convention, not a compiler-enforced gate: `TransactionRepository
 * .createTransaction` is a plain Firestore write shared by transfers, EMI/
 * loan creation, and reconciliation, none of which have (or want) a "wait
 * for the user to dismiss a dialog" step, so the gate can't live there. Every
 * *user-initiated* single-transaction creation flow should route through
 * `guard()` first; batch flows should use `guardBatch()` instead so one
 * dialog can list every flagged row rather than popping once per row.
 *
 * Usage:
 *   const { guard, dialog } = useDuplicateGuardedCreate(existingTransactions);
 *   async function handleSave() {
 *     const proceed = await guard({ description, amount, date, direction, accountId, referenceNumber, requireDescriptionMatch: false });
 *     if (!proceed) return;
 *     await actions.createTransaction(...);
 *   }
 *   return <>{form}{dialog}</>;
 */

import { useCallback, useRef, useState } from "react";
import { DuplicateWarningDialog } from "./duplicate-warning-dialog";
import {
  checkForDuplicates,
  type DuplicateCandidateInput,
  type DuplicateDetectionResult,
  type ExistingTransactionForDuplicateCheck,
} from "./duplicate-detection-service";

export type DuplicateCheckInput = Omit<DuplicateCandidateInput, "source"> & { source?: DuplicateCandidateInput["source"] };

export function useDuplicateGuardedCreate(existingTransactions: ExistingTransactionForDuplicateCheck[]) {
  const [warning, setWarning] = useState<DuplicateDetectionResult | null>(null);
  const [additionalCount, setAdditionalCount] = useState(0);
  const [busy, setBusy] = useState(false);
  // Resolves the in-flight `guard()`/`guardBatch()` call once the user answers the dialog.
  const resolverRef = useRef<((proceed: boolean) => void) | null>(null);

  const resolve = useCallback((proceed: boolean) => {
    setWarning(null);
    setAdditionalCount(0);
    resolverRef.current?.(proceed);
    resolverRef.current = null;
  }, []);

  /**
   * Checks one candidate transaction and, if it looks like a duplicate,
   * shows the warning dialog and waits for the user's choice. Resolves
   * `true` when it's safe to proceed with the write (unique, or the user
   * chose "Save anyway"), `false` when the caller should not write
   * (dialog cancelled).
   */
  const guard = useCallback(
    (candidate: DuplicateCheckInput): Promise<boolean> => {
      const result = checkForDuplicates({ source: "manual", ...candidate }, existingTransactions);
      if (result.status === "unique") return Promise.resolve(true);

      return new Promise<boolean>((resolvePromise) => {
        resolverRef.current = resolvePromise;
        setAdditionalCount(0);
        setWarning(result);
      });
    },
    [existingTransactions],
  );

  /**
   * Batch variant for multi-row imports (bulk SMS import, PDF Studio
   * commit): checks every candidate, and if any are flagged, shows one
   * dialog for the strongest match with "...and N more" for the rest.
   * Resolves `true` to proceed with the whole batch, `false` to cancel it
   * entirely — callers that want per-row exclusion instead of an all-or-
   * nothing batch should filter candidates against `checkForDuplicates`
   * themselves before calling `guardBatch`.
   */
  const guardBatch = useCallback(
    (candidates: DuplicateCheckInput[]): Promise<boolean> => {
      const results = candidates
        .map((c) => checkForDuplicates({ source: "manual", ...c }, existingTransactions))
        .filter((r) => r.status === "duplicate_candidate");
      if (results.length === 0) return Promise.resolve(true);

      const strongest = results.reduce((best, r) => ((r.bestMatch?.confidence ?? 0) > (best.bestMatch?.confidence ?? 0) ? r : best));

      return new Promise<boolean>((resolvePromise) => {
        resolverRef.current = resolvePromise;
        setAdditionalCount(results.length - 1);
        setWarning(strongest);
      });
    },
    [existingTransactions],
  );

  const dialog = (
    <DuplicateWarningDialog
      open={warning != null}
      onOpenChange={(open) => {
        if (!open) resolve(false);
      }}
      result={warning}
      busy={busy}
      additionalCount={additionalCount}
      onConfirm={() => resolve(true)}
    />
  );

  return { guard, guardBatch, dialog, setBusy };
}
