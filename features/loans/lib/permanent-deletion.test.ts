import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgreementCleanupIncompleteError, AgreementDeletionBlockedError } from "@/lib/repositories/agreement-deletion";
import { useOperationProgressStore } from "@/store/operation-progress-store";
import { runPermanentDeletion } from "./permanent-deletion";

const current = () => useOperationProgressStore.getState().operations.at(-1)!;

beforeEach(() => useOperationProgressStore.setState({ operations: [] }));

describe("permanent deletion — what the user is told", () => {
  it("19. success: stages advance through the real steps, the UI data is refreshed, then — only then — 100% done", async () => {
    const seen: string[] = [];
    const refresh = vi.fn(async () => {
      seen.push(`refresh@${current().stage}`);
    });
    const ok = await runPermanentDeletion({
      kind: "loan",
      run: async (onStage) => {
        seen.push(current().status);
        onStage("reversing");
        seen.push(current().detail);
        onStage("removing");
        seen.push(current().detail);
      },
      refresh,
      retry: vi.fn(),
    });
    expect(ok).toBe(true);
    expect(refresh).toHaveBeenCalledOnce();
    expect(seen).toEqual(["running", "Reversing payments & account effects", "Removing installments & schedule", "refresh@refresh"]);
    expect(current()).toMatchObject({ status: "success", successLabel: "Loan deleted successfully" });
  });

  it("18. a failure before the money step commits is never success — 'Nothing was changed', with Try again", async () => {
    const retry = vi.fn();
    const ok = await runPermanentDeletion({ kind: "emi", run: async () => Promise.reject(new Error("offline")), refresh: vi.fn(), retry });
    expect(ok).toBe(false);
    expect(current()).toMatchObject({ status: "error", errorLabel: "Couldn't delete EMI", errorDetail: "Nothing was changed. offline", retry });
  });

  it("18. an interrupted cleanup after the money step is reported as unfinished — not success, not 'nothing changed'", async () => {
    const ok = await runPermanentDeletion({
      kind: "loan",
      run: async () => Promise.reject(new AgreementCleanupIncompleteError(new Error("network"))),
      refresh: vi.fn(),
      retry: vi.fn(),
    });
    expect(ok).toBe(false);
    expect(current().status).toBe("error");
    expect(current().errorLabel).toBe("Loan removed — cleanup not finished");
    expect(current().retry).not.toBeNull();
  });

  it("a blocked deletion explains why and offers no retry", async () => {
    await runPermanentDeletion({
      kind: "loan",
      run: async () => Promise.reject(new AgreementDeletionBlockedError("A shared expense was created from one of this loan's payments.")),
      refresh: vi.fn(),
      retry: vi.fn(),
    });
    expect(current()).toMatchObject({ status: "error", errorDetail: "A shared expense was created from one of this loan's payments.", retry: null });
  });
});
