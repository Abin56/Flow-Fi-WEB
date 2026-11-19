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
 * The Undo toast must show exactly this window: fire it with `UNDO_TOAST_OPTIONS` (its countdown then
 * never pauses on hover, so the seconds it shows are the seconds Undo really has) and `undoToastAction`
 * (a late click — the delete already started — says so instead of pretending to restore).
 */

import type { ToastAction, ToastOptions } from "@/store/toast-store";
import { toast } from "@/store/toast-store";

/** 8s: the Undo toast's countdown no longer pauses on hover, so it gets a little longer than the 6s action-toast default. */
export const DISMISS_UNDO_WINDOW_MS = 8000;

/**
 * Options for every dismiss-Undo toast: lasts exactly the undo window, never pauses (hover would
 * otherwise keep Undo on screen after the delete ran) and never merges with an identical toast (a
 * merge swaps in the newer Undo, silently dropping the earlier candidate's).
 */
export const UNDO_TOAST_OPTIONS: ToastOptions = { duration: DISMISS_UNDO_WINDOW_MS, pausable: false, dedupe: false };

export interface PendingDismissal {
  candidateId: string;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Hides `candidateId` immediately (via `hide`) and schedules `commitDelete` after the undo window.
 * Returns a `cancel` function — call it from the toast's "Undo" button. It clears the timer and
 * restores visibility (`unhide`) and returns `true`, or returns `false` (changing nothing) once the
 * delete has already started — the candidate can't be brought back then.
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
}): { cancel: () => boolean } {
  hide(candidateId);
  let state: "pending" | "committing" | "cancelled" = "pending";

  const timer = setTimeout(() => {
    if (state !== "pending") return;
    state = "committing";
    void commitDelete().catch((error) => {
      unhide(candidateId);
      onDeleteFailed(error);
    });
  }, DISMISS_UNDO_WINDOW_MS);

  return {
    cancel: () => {
      if (state === "committing") return false;
      if (state === "pending") {
        state = "cancelled";
        clearTimeout(timer);
        unhide(candidateId);
      }
      return true;
    },
  };
}

/** The toast's Undo: restores via `cancel`, or tells the user plainly when it came too late. */
export function undoToastAction(cancel: () => boolean): ToastAction {
  return {
    label: "Undo",
    onClick: () => {
      if (!cancel()) toast.info("Too late to undo", "The undo time had run out, so it was already removed from your inbox.");
    },
  };
}
