import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _debugSharedSubscriptionRefCount,
  acquireSharedSubscription,
  closeIdleSharedSubscriptions,
  IDLE_RELEASE_MS,
  markSharedSubscriptionFailed,
} from "@/lib/services/firestore-watch-registry";

let n = 0;
const freshKey = () => ["shared-test", `uid-${++n}`] as const;

describe("acquireSharedSubscription — keep-alive between pages", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("opens one listener for several consumers", () => {
    const key = freshKey();
    const unsub = vi.fn();
    const subscribe = vi.fn(() => unsub);
    const a = acquireSharedSubscription(key, subscribe);
    const b = acquireSharedSubscription(key, subscribe);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(_debugSharedSubscriptionRefCount(key)).toBe(2);
    a();
    b();
  });

  it("keeps the listener open when the next page re-acquires right after the old one released (navigation)", () => {
    const key = freshKey();
    const unsub = vi.fn();
    const subscribe = vi.fn(() => unsub);
    const oldPage = acquireSharedSubscription(key, subscribe);
    oldPage(); // old page unmounts first…
    const newPage = acquireSharedSubscription(key, subscribe); // …then the new page mounts
    vi.advanceTimersByTime(IDLE_RELEASE_MS * 2);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(unsub).not.toHaveBeenCalled();
    newPage();
  });

  it("tears the listener down once nobody re-acquires it within the grace period", () => {
    const key = freshKey();
    const unsub = vi.fn();
    const release = acquireSharedSubscription(key, () => unsub);
    release();
    vi.advanceTimersByTime(IDLE_RELEASE_MS - 1);
    expect(unsub).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(unsub).toHaveBeenCalledTimes(1);
    expect(_debugSharedSubscriptionRefCount(key)).toBe(0);
  });

  it("a release called twice only counts once", () => {
    const key = freshKey();
    const a = acquireSharedSubscription(key, () => vi.fn());
    const b = acquireSharedSubscription(key, () => vi.fn());
    a();
    a();
    expect(_debugSharedSubscriptionRefCount(key)).toBe(1);
    b();
  });

  it("reopens a failed listener on the next acquire (Retry) and keeps the other consumers counted", () => {
    const key = freshKey();
    const firstUnsub = vi.fn();
    const secondUnsub = vi.fn();
    const subscribe = vi.fn().mockReturnValueOnce(firstUnsub).mockReturnValueOnce(secondUnsub);
    const a = acquireSharedSubscription(key, subscribe);
    const b = acquireSharedSubscription(key, subscribe);
    markSharedSubscriptionFailed(key);
    // Consumer a retries: release + acquire.
    a();
    const a2 = acquireSharedSubscription(key, subscribe);
    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(firstUnsub).toHaveBeenCalledTimes(1);
    expect(_debugSharedSubscriptionRefCount(key)).toBe(2);
    // b (acquired against the old listener) releasing must not close the new one.
    b();
    expect(secondUnsub).not.toHaveBeenCalled();
    a2();
    vi.advanceTimersByTime(IDLE_RELEASE_MS);
    expect(secondUnsub).toHaveBeenCalledTimes(1);
  });

  it("a failed listener with no consumers is closed at once, not kept warm", () => {
    const key = freshKey();
    const unsub = vi.fn();
    acquireSharedSubscription(key, () => unsub)();
    markSharedSubscriptionFailed(key);
    expect(unsub).toHaveBeenCalledTimes(1);
  });

  it("sign-out closes listeners kept only for the grace period, but not ones still in use", () => {
    const idleKey = freshKey();
    const liveKey = freshKey();
    const idleUnsub = vi.fn();
    const liveUnsub = vi.fn();
    acquireSharedSubscription(idleKey, () => idleUnsub)();
    const live = acquireSharedSubscription(liveKey, () => liveUnsub);
    closeIdleSharedSubscriptions();
    expect(idleUnsub).toHaveBeenCalledTimes(1);
    expect(liveUnsub).not.toHaveBeenCalled();
    live();
    vi.advanceTimersByTime(IDLE_RELEASE_MS);
    expect(liveUnsub).toHaveBeenCalledTimes(1);
  });
});
