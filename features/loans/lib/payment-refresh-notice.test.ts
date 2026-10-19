import { beforeEach, describe, expect, it, vi } from "vitest";
import { useToastStore } from "@/store/toast-store";
import { closeAfterRefresh, refreshHandler, REFRESH_FAILED_TITLE, REFRESH_SLOW_TITLE } from "./payment-refresh-notice";

beforeEach(() => useToastStore.setState({ toasts: [] }));
const titles = () => useToastStore.getState().toasts.map((t) => t.title);

describe("payment refresh notice", () => {
  it("shows 'updating' while refreshing, clears it when done, and warns visibly when the refresh fails", () => {
    const set = vi.fn();
    const handler = refreshHandler(set);
    handler("refreshing");
    expect(set).toHaveBeenLastCalledWith(true);
    handler("done");
    expect(set).toHaveBeenLastCalledWith(false);
    expect(titles()).toEqual([]);
    handler("failed", new Error("offline"));
    expect(set).toHaveBeenLastCalledWith(false);
    expect(titles()).toEqual([REFRESH_FAILED_TITLE]);
  });

  it("closes right after a settled refresh, without a notice", async () => {
    const close = vi.fn();
    await closeAfterRefresh({ refreshSettled: async () => "done" }, close);
    expect(close).toHaveBeenCalledTimes(1);
    expect(titles()).toEqual([]);
  });

  it("closes after the cap with an 'Updating balances…' notice when the refresh is still running", async () => {
    const close = vi.fn();
    expect(await closeAfterRefresh({ refreshSettled: async () => "timeout" }, close)).toBe("timeout");
    expect(close).toHaveBeenCalledTimes(1);
    expect(titles()).toEqual([REFRESH_SLOW_TITLE]);
  });
});
