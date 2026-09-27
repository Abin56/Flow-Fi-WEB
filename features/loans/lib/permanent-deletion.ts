import {
  AgreementCleanupIncompleteError,
  AgreementDeletionBlockedError,
  type AgreementDeletionStage,
} from "@/lib/repositories/agreement-deletion";
import { startOperation } from "@/store/operation-progress-store";

/**
 * Runs a permanent deletion under the shared progress UI — stages are the deletion's real steps:
 *   Checking linked records → Reversing payments & account effects → Removing installments → Refreshing.
 * Returns true only when the whole deletion succeeded; every failure is shown, never reported as done.
 */
export async function runPermanentDeletion(opts: {
  kind: "loan" | "emi";
  run: (onStage: (stage: AgreementDeletionStage) => void) => Promise<unknown>;
  refresh: () => Promise<unknown>;
  retry: () => void;
}): Promise<boolean> {
  const label = opts.kind === "loan" ? "Loan" : "EMI";
  const op = startOperation({
    label: `Deleting ${label === "Loan" ? "loan" : "EMI"}`,
    successLabel: `${label} deleted successfully`,
    errorLabel: `Couldn't delete ${label === "Loan" ? "loan" : "EMI"}`,
    detail: "Checking linked records",
  });
  try {
    await opts.run((stage) => {
      if (stage === "reversing") op.stage("submit", "Reversing payments & account effects");
      else if (stage === "removing") op.stage("related", "Removing installments & schedule");
    });
    op.stage("refresh", "Refreshing financial state");
    // The deletion is committed; a failed re-read can't make it a failure (live listeners still update).
    await opts.refresh().catch(() => undefined);
    op.succeed({ toast: { title: `${label} deleted successfully` } });
    return true;
  } catch (e) {
    if (e instanceof AgreementDeletionBlockedError) op.fail({ detail: e.message });
    else if (e instanceof AgreementCleanupIncompleteError) op.fail({ label: `${label} removed — cleanup not finished`, detail: e.message, retry: opts.retry });
    else op.fail({ detail: e instanceof Error ? `Nothing was changed. ${e.message}` : "Nothing was changed.", retry: opts.retry });
    return false;
  }
}
