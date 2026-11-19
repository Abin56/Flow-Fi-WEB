import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_VISIBLE_TOASTS, toast, useToastStore } from "./toast-store";

beforeEach(() => useToastStore.setState({ toasts: [] }));
const list = () => useToastStore.getState().toasts;

describe("toast store", () => {
  it("gives each tone its default lifetime; errors stay until dismissed", () => {
    toast.success("Transaction added");
    toast.info("Syncing");
    toast.warning("Check the date");
    toast.error("Unable to save changes");
    expect(list().map((t) => t.duration)).toEqual([4000, 5000, 6000, null]);
  });

  it("keeps Undo reachable: a toast with an action lasts at least 6s", () => {
    toast.success("Transaction deleted", undefined, { label: "Undo", onClick: () => {} });
    expect(list()[0].duration).toBe(6000);
  });

  it("honours an explicit duration, including null", () => {
    toast.success("Saved", undefined, undefined, { duration: 9000 });
    toast.info("Pinned", undefined, undefined, { duration: null });
    expect(list().map((t) => t.duration)).toEqual([9000, null]);
  });

  it("refreshes an identical visible toast instead of stacking a duplicate, keeping the newest action", () => {
    const first = vi.fn();
    const second = vi.fn();
    toast.success("Payment recorded", undefined, { label: "Undo", onClick: first });
    toast.success("Payment recorded", undefined, { label: "Undo", onClick: second });
    expect(list()).toHaveLength(1);
    expect(list()[0].revision).toBe(1);
    list()[0].action!.onClick();
    expect(second).toHaveBeenCalled();
    expect(first).not.toHaveBeenCalled();
    // Different description or tone is a different message.
    toast.success("Payment recorded", "₹500 from Asha");
    toast.error("Payment recorded");
    expect(list()).toHaveLength(3);
  });

  it("caps the stack, dropping the oldest timed toast before any persistent error", () => {
    toast.error("Unable to save changes");
    for (let i = 0; i < MAX_VISIBLE_TOASTS; i++) toast.success(`Saved ${i}`);
    expect(list()).toHaveLength(MAX_VISIBLE_TOASTS);
    expect(list()[0].title).toBe("Unable to save changes");
    expect(list().map((t) => t.title)).not.toContain("Saved 0");
  });

  it("dedupe: false stacks an identical toast, so each keeps its own action", () => {
    const first = vi.fn();
    const second = vi.fn();
    toast.success("Candidate dismissed", "Bank of India", { label: "Undo", onClick: first }, { dedupe: false });
    toast.success("Candidate dismissed", "Bank of India", { label: "Undo", onClick: second }, { dedupe: false });
    expect(list()).toHaveLength(2);
    list()[0].action!.onClick();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it("pausable: false is carried on the toast; a pausable toast never merges into it", () => {
    toast.success("Candidate dismissed", "x", { label: "Undo", onClick: () => {} }, { duration: 6000, pausable: false });
    toast.success("Candidate dismissed", "x");
    expect(list().map((t) => t.pausable)).toEqual([false, undefined]);
  });
});
