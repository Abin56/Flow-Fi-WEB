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

describe("acquireSharedSubscription — a listener built from changing inputs is never reused stale", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  // Regression: `useAllLoanInstallments` opens one listener per loan schedule. On a cold load it first runs with no
  // schedules (nothing to watch), then again once the Loans list arrives. The shared registry used to hand the second
  // run the first run's (empty) listener and drop its `subscribe`, so no installment was ever read: every loan showed
  // "Fully paid · ₹0".
  it("reopens the listener when the inputs it was built from change (hook re-runs: release, then acquire)", () => {
    const key = freshKey();
    const unsubEmpty = vi.fn();
    const unsubLoaded = vi.fn();
    const subscribeLoaded = vi.fn(() => unsubLoaded);

    const first = acquireSharedSubscription(key, () => unsubEmpty, "uid|");
    first(); // effect cleanup (deps changed)…
    const second = acquireSharedSubscription(key, subscribeLoaded, "uid|schedule-1,schedule-2"); // …then re-run

    expect(subscribeLoaded).toHaveBeenCalledTimes(1);
    expect(unsubEmpty).toHaveBeenCalledTimes(1);
    expect(_debugSharedSubscriptionRefCount(key)).toBe(1);
    second();
    vi.advanceTimersByTime(IDLE_RELEASE_MS);
    expect(unsubLoaded).toHaveBeenCalledTimes(1);
  });

  it("still shares one listener between consumers whose inputs are identical", () => {
    const key = freshKey();
    const subscribe = vi.fn(() => vi.fn());
    const a = acquireSharedSubscription(key, subscribe, "uid|s1");
    const b = acquireSharedSubscription(key, subscribe, "uid|s1");
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(_debugSharedSubscriptionRefCount(key)).toBe(2);
    a();
    b();
  });

  it("keeps every consumer's count when another consumer's inputs differ", () => {
    const key = freshKey();
    const a = acquireSharedSubscription(key, () => vi.fn(), "uid|s1");
    const b = acquireSharedSubscription(key, () => vi.fn(), "uid|s1,s2");
    expect(_debugSharedSubscriptionRefCount(key)).toBe(2);
    a();
    b();
    expect(_debugSharedSubscriptionRefCount(key)).toBe(0);
  });

  it("a keep-alive reuse with unchanged inputs (page navigation) still does not reopen", () => {
    const key = freshKey();
    const unsub = vi.fn();
    const subscribe = vi.fn(() => unsub);
    acquireSharedSubscription(key, subscribe, "uid|s1")();
    acquireSharedSubscription(key, subscribe, "uid|s1");
    vi.advanceTimersByTime(IDLE_RELEASE_MS * 2);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(unsub).not.toHaveBeenCalled();
  });
});

