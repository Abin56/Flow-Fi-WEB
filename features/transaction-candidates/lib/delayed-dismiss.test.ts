import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const info = vi.fn();
vi.mock("@/store/toast-store", () => ({ toast: { info: (...args: unknown[]) => info(...args) } }));

import { DISMISS_UNDO_WINDOW_MS, scheduleDelayedDismiss, UNDO_TOAST_OPTIONS, undoToastAction } from "./delayed-dismiss";

beforeEach(() => {
  vi.useFakeTimers();
  info.mockReset();
});
afterEach(() => vi.useRealTimers());

function setup(commitDelete = vi.fn(async () => {})) {
  const hidden = new Set<string>();
  const hide = vi.fn((id: string) => hidden.add(id));
  const unhide = vi.fn((id: string) => hidden.delete(id));
  const { cancel } = scheduleDelayedDismiss({ candidateId: "c1", hide, unhide, commitDelete, onDeleteFailed: vi.fn() });
  return { hidden, unhide, commitDelete, cancel };
}

describe("scheduleDelayedDismiss — Undo is honest", () => {
  it("Undo inside the window restores and returns true; the delete never runs", async () => {
    const ctx = setup();
    expect(ctx.hidden.has("c1")).toBe(true);
    expect(ctx.cancel()).toBe(true);
    expect(ctx.hidden.has("c1")).toBe(false);
    await vi.advanceTimersByTimeAsync(DISMISS_UNDO_WINDOW_MS * 2);
    expect(ctx.commitDelete).not.toHaveBeenCalled();
  });

  it("Undo after the delete started returns false and does NOT un-hide (nothing to bring back)", async () => {
    const ctx = setup();
    await vi.advanceTimersByTimeAsync(DISMISS_UNDO_WINDOW_MS);
    expect(ctx.commitDelete).toHaveBeenCalledTimes(1);
    expect(ctx.cancel()).toBe(false);
    expect(ctx.unhide).not.toHaveBeenCalled();
  });

  it("a second Undo is harmless", () => {
    const ctx = setup();
    expect(ctx.cancel()).toBe(true);
    expect(ctx.cancel()).toBe(true);
    expect(ctx.unhide).toHaveBeenCalledTimes(1);
  });

  it("the toast action says 'Too late to undo' when the delete already ran, and nothing otherwise", async () => {
    const early = setup();
    undoToastAction(early.cancel).onClick();
    expect(info).not.toHaveBeenCalled();

    const late = setup();
    await vi.advanceTimersByTimeAsync(DISMISS_UNDO_WINDOW_MS);
    undoToastAction(late.cancel).onClick();
    expect(info).toHaveBeenCalledWith("Too late to undo", expect.any(String));
  });

  it("the Undo toast lasts exactly the window, never pauses and never merges", () => {
    expect(UNDO_TOAST_OPTIONS).toEqual({ duration: DISMISS_UNDO_WINDOW_MS, pausable: false, dedupe: false });
  });
});
