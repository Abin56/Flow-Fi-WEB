import { beforeEach, describe, expect, it, vi } from "vitest";
import { TransferEditRestrictedError } from "@/lib/repositories/transaction-repository";
import { userFacingMessage, withErrorToast } from "@/features/transactions/lib/error-toast";

/**
 * Regression coverage for the production-hardening fix: `TransferEditRestrictedError`'s
 * specific, actionable message ("delete the transfer and create a new one instead")
 * used to be discarded by `withErrorToast`, which always showed the generic
 * "Please try again." — this proves the recognized error type's own message now
 * survives to the toast, while an unrecognized error still falls back to generic
 * (so no raw FirebaseError/internal message ever leaks to the user).
 */
vi.mock("@/store/toast-store", () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

import { toast } from "@/store/toast-store";

describe("userFacingMessage", () => {
  it("returns TransferEditRestrictedError's own message", () => {
    const error = new TransferEditRestrictedError();
    expect(userFacingMessage(error)).toBe(error.message);
    expect(userFacingMessage(error)).toContain("delete the transfer and create a new one instead");
  });

  it("returns null for a plain/unrecognized Error (falls back to generic elsewhere)", () => {
    expect(userFacingMessage(new Error("Missing or insufficient permissions."))).toBeNull();
  });

  it("returns null for a non-Error thrown value", () => {
    expect(userFacingMessage("some string")).toBeNull();
  });
});

describe("withErrorToast", () => {
  beforeEach(() => {
    vi.mocked(toast.error).mockClear();
  });

  it("shows TransferEditRestrictedError's specific message, not the generic fallback", async () => {
    const action = () => Promise.reject(new TransferEditRestrictedError());

    await expect(withErrorToast(action, "Couldn't save changes")).rejects.toBeInstanceOf(TransferEditRestrictedError);

    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't save changes",
      expect.stringContaining("delete the transfer and create a new one instead"),
    );
  });

  it("falls back to the generic message for an unrecognized error", async () => {
    const action = () => Promise.reject(new Error("Missing or insufficient permissions."));

    await expect(withErrorToast(action, "Couldn't save changes")).rejects.toThrow("Missing or insufficient permissions.");

    expect(toast.error).toHaveBeenCalledWith("Couldn't save changes", "Please try again.");
  });

  it("resolves normally and never toasts when the action succeeds", async () => {
    const result = await withErrorToast(() => Promise.resolve(42), "Couldn't save changes");
    expect(result).toBe(42);
    expect(toast.error).not.toHaveBeenCalled();
  });
});
