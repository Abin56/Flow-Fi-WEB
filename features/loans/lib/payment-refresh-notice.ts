/**
 * What the Loan & EMI payment dialogs tell the user about the balance refresh that follows a committed
 * write. The payment is already saved by then, so none of this can fail or repeat it — it only keeps the
 * user informed while dependent views catch up.
 */

import { toast } from "@/store/toast-store";
import type { PaymentSubmissionHandlers, RefreshState, RefreshWaitOutcome } from "./payment-submission";

/** The longest a confirmed dialog waits for the refresh before closing anyway. */
export const REFRESH_MAX_WAIT_MS = 8000;

export const REFRESH_FAILED_TITLE = "Saved — balances couldn't refresh";
export const REFRESH_FAILED_DESCRIPTION = "Your change is saved and won't be repeated. Reload the page if the figures look out of date.";
export const REFRESH_SLOW_TITLE = "Updating balances…";
export const REFRESH_SLOW_DESCRIPTION = "Your change is saved. Figures on screen may take a moment to catch up.";

/** Mirrors the refresh into dialog state ("Updating balances…") and surfaces a failed refresh as a warning. */
export function refreshHandler(setRefreshing: (refreshing: boolean) => void): NonNullable<PaymentSubmissionHandlers<unknown>["onRefresh"]> {
  return (state: RefreshState) => {
    setRefreshing(state === "refreshing");
    if (state === "failed") toast.warning(REFRESH_FAILED_TITLE, REFRESH_FAILED_DESCRIPTION);
  };
}

/** Closes a confirmed dialog once the refresh has settled — or after `maxMs`, telling the user it's still updating. */
export async function closeAfterRefresh(
  submission: { refreshSettled: (maxMs: number) => Promise<RefreshWaitOutcome> },
  close: () => void,
  maxMs: number = REFRESH_MAX_WAIT_MS,
): Promise<RefreshWaitOutcome> {
  const outcome = await submission.refreshSettled(maxMs);
  if (outcome === "timeout") toast.info(REFRESH_SLOW_TITLE, REFRESH_SLOW_DESCRIPTION);
  close();
  return outcome;
}
