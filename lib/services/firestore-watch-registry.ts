/**
 * Pure (no React, no Firestore) registry backing `useFirestoreWatch`'s retry
 * mechanism — separated out from the hook itself so this logic is
 * unit-testable in this project's Node-only test environment (no jsdom/
 * `@testing-library/react` is installed here, so a hook that calls
 * `useState`/`useEffect` can't be rendered directly in a test).
 *
 * Each currently-mounted `useFirestoreWatch` instance registers its own
 * retry callback here, keyed by a stable serialization of its `queryKey`.
 * A Set per key, not a single function, since the same query key (e.g.
 * `["accounts", uid]`) can legitimately be watched by more than one mounted
 * component at once (e.g. a sidebar summary and the page itself both
 * calling `useAccounts()`) — retrying must reach every live listener for
 * that key, not just whichever mounted most recently.
 */

const registry = new Map<string, Set<() => void>>();

export function keyFor(queryKey: readonly unknown[]): string {
  return JSON.stringify(queryKey);
}

/** Called on mount; returns the matching unregister function to call on unmount. */
export function registerRetry(queryKey: readonly unknown[], retry: () => void): () => void {
  const key = keyFor(queryKey);
  let set = registry.get(key);
  if (!set) {
    set = new Set();
    registry.set(key, set);
  }
  set.add(retry);
  return () => {
    set!.delete(retry);
    if (set!.size === 0) registry.delete(key);
  };
}

/** Invokes every currently-registered retry callback for this exact `queryKey`. No-op if none are mounted. */
export function retryFirestoreWatch(queryKey: readonly unknown[]): void {
  const set = registry.get(keyFor(queryKey));
  if (!set) return;
  for (const fn of set) fn();
}

/** Test-only escape hatch — production code should never need to inspect registry size directly. */
export function _debugRegistrySize(queryKey: readonly unknown[]): number {
  return registry.get(keyFor(queryKey))?.size ?? 0;
}

interface SharedSubscription {
  refCount: number;
  unsubscribe: () => void;
  /** Pending teardown after the last consumer released (cancelled if someone re-acquires within the grace period). */
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** The listener reported an error — Firestore ends a listener after an error, so it must be reopened, never reused. */
  failed: boolean;
}

const subscriptions = new Map<string, SharedSubscription>();

/**
 * How long a listener stays open after its last consumer unmounts. Navigating from one page to another unmounts the
 * old page BEFORE the new one mounts, so without this every listener the two pages share (accounts, transactions, …)
 * was closed and reopened on each navigation — a full collection re-read plus a fresh array (and re-render of every
 * consumer) per switch. Within this window the next page simply rides the still-open listener. Data stays live either
 * way; only the teardown is deferred. Performance only — what the listener reads and writes is unchanged.
 */
export const IDLE_RELEASE_MS = 60_000;

function teardown(key: string, entry: SharedSubscription) {
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = null;
  entry.unsubscribe();
  if (subscriptions.get(key) === entry) subscriptions.delete(key);
}

/**
 * Reference-counted ownership of the *actual* Firestore listener behind a `useFirestoreWatch`
 * query key. The first caller for a given key really does open it (`subscribe()` is invoked);
 * every other concurrently-mounted caller for that same key just increments the ref count and rides
 * the one listener's writes into the shared React Query cache. Once the last caller releases, the
 * listener is kept open for `IDLE_RELEASE_MS` (see above) and torn down only if nobody re-acquires it.
 *
 * A listener marked failed (`markSharedSubscriptionFailed`) is reopened by the next acquire — this is
 * what the watcher banner's Retry relies on — while keeping the key's consumer count intact.
 *
 * `subscribe` is only ever invoked for the caller that actually creates (or reopens) the entry — later
 * callers' `subscribe` closures are discarded, which is safe because two callers sharing the same
 * `queryKey` are, by construction, watching the same uid-scoped Firestore query.
 */
export function acquireSharedSubscription(queryKey: readonly unknown[], subscribe: () => () => void): () => void {
  const key = keyFor(queryKey);
  let entry = subscriptions.get(key);
  if (entry && entry.failed) {
    const refCount = entry.refCount;
    teardown(key, entry);
    entry = { refCount, unsubscribe: subscribe(), idleTimer: null, failed: false };
    subscriptions.set(key, entry);
  } else if (!entry) {
    entry = { refCount: 0, unsubscribe: subscribe(), idleTimer: null, failed: false };
    subscriptions.set(key, entry);
  }
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }
  entry.refCount += 1;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    // Always the key's CURRENT entry: a failed listener may have been reopened (replaced) since this caller acquired.
    const current = subscriptions.get(key);
    if (!current) return;
    current.refCount -= 1;
    if (current.refCount > 0) return;
    current.refCount = 0;
    if (current.failed) {
      teardown(key, current);
      return;
    }
    if (current.idleTimer) clearTimeout(current.idleTimer);
    current.idleTimer = setTimeout(() => {
      if (current.refCount <= 0) teardown(key, current);
    }, IDLE_RELEASE_MS);
  };
}

/** The listener behind this key errored (Firestore has already ended it): the next acquire opens a fresh one. */
export function markSharedSubscriptionFailed(queryKey: readonly unknown[]): void {
  const key = keyFor(queryKey);
  const entry = subscriptions.get(key);
  if (!entry) return;
  entry.failed = true;
  if (entry.refCount <= 0) teardown(key, entry);
}

/** Closes every listener that is only being kept open for the grace period (no mounted consumer). Called on sign-out. */
export function closeIdleSharedSubscriptions(): void {
  for (const [key, entry] of [...subscriptions]) if (entry.refCount <= 0) teardown(key, entry);
}

/** Test-only escape hatch. */
export function _debugSharedSubscriptionRefCount(queryKey: readonly unknown[]): number {
  return subscriptions.get(keyFor(queryKey))?.refCount ?? 0;
}
