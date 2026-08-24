import { toast } from "@/store/toast-store";
import { TransferEditRestrictedError } from "@/lib/repositories/transaction-repository";

/**
 * Error types whose own `.message` is already a safe, specific, actionable
 * explanation — shown to the user as-is instead of the generic fallback
 * below. Everything else (including raw Firebase/FirestoreError messages,
 * which can be technical or expose internals) still falls back to a plain
 * "Please try again." Add a class here only when its `.message` was
 * deliberately written to be user-facing (see `TransferEditRestrictedError`'s
 * own doc comment).
 */
const USER_FACING_ERROR_TYPES = [TransferEditRestrictedError] as const;

export function userFacingMessage(error: unknown): string | null {
  for (const ErrorType of USER_FACING_ERROR_TYPES) {
    if (error instanceof ErrorType) return error.message;
  }
  return null;
}

/** Runs a mutation, surfacing any failure as a toast (never a raw FirebaseError) before rethrowing
 *  so callers (forms, dialogs) can still react to the rejection if they need to. A recognized,
 *  user-facing error type (see `USER_FACING_ERROR_TYPES`) shows its own specific message instead
 *  of the generic fallback. */
export async function withErrorToast<T>(action: () => Promise<T>, failureTitle: string): Promise<T> {
  try {
    return await action();
  } catch (error) {
    toast.error(failureTitle, userFacingMessage(error) ?? "Please try again.");
    throw error;
  }
}
