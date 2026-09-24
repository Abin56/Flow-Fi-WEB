/**
 * "Dismiss with Undo" for SMS candidates — the row/modal/bulk Dismiss actions don't call
 * `ignoreCandidate` (a real Firestore delete) immediately. Instead they hide the candidate
 * optimistically and schedule the actual delete a few seconds out, giving the toast's "Undo" button
 * a real window to cancel before anything is written. This is deliberate given
 * `sms-transaction-candidate-repository.ts`'s documented contract — the web app may only ever
 * `deleteById`, never write a candidate back — so "undo" can't mean "recreate the doc." Delaying the
 * one write this collection allows, rather than reversing it after the fact, keeps that contract
 * intact while still giving the user a real undo.
 *
 * Matches the toaster's own `AUTO_DISMISS_MS` (`components/feedback/toaster.tsx`) so the Undo
 * button disappears at exactly the moment it stops working.
 */

export const DISMISS_UNDO_WINDOW_MS = 5000;

export interface PendingDismissal {
  candidateId: string;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Hides `candidateId` immediately (via `hide`) and schedules `commitDelete` after the undo window.
 * Returns a `cancel` function — call it from the toast's "Undo" button to clear the timer and
 * restore visibility (`unhide`) before the delete ever runs.
 */
export function scheduleDelayedDismiss({
  candidateId,
  hide,
  unhide,
  commitDelete,
  onDeleteFailed,
}: {
  candidateId: string;
  hide: (candidateId: string) => void;
  unhide: (candidateId: string) => void;
  commitDelete: () => Promise<void>;
  onDeleteFailed: (error: unknown) => void;
}): { cancel: () => void } {
  hide(candidateId);

  const timer = setTimeout(() => {
    void commitDelete().catch((error) => {
      unhide(candidateId);
      onDeleteFailed(error);
    });
  }, DISMISS_UNDO_WINDOW_MS);

  return {
    cancel: () => {
      clearTimeout(timer);
      unhide(candidateId);
    },
  };
}
