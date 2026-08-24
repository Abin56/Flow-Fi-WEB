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
}

const subscriptions = new Map<string, SharedSubscription>();

/**
 * Reference-counted ownership of the *actual* Firestore listener behind a `useFirestoreWatch`
 * query key. The first caller for a given key really does open it (`subscribe()` is invoked);
 * every other concurrently-mounted caller for that same key (e.g. a sidebar summary and the page
 * itself both calling `useAccounts()`, or simply navigating back to a page whose data is still
 * referenced elsewhere) just increments the ref count and rides the one listener's writes into
 * the shared React Query cache — every `useQuery({queryKey})` observer already re-renders off
 * that shared cache regardless of which mounted instance owns the underlying subscription. The
 * real listener is only torn down once the last caller releases, so navigating away from and back
 * to a page no longer means a fresh full-collection re-fetch each time as long as *something*
 * elsewhere kept the subscription alive in between — and once nothing does, it tears down exactly
 * like before.
 *
 * `subscribe` is only ever invoked for the caller that actually creates the entry — later callers'
 * `subscribe` closures are discarded, which is safe because two callers sharing the same `queryKey`
 * are, by construction, watching the same uid-scoped Firestore query.
 */
export function acquireSharedSubscription(queryKey: readonly unknown[], subscribe: () => () => void): () => void {
  const key = keyFor(queryKey);
  let entry = subscriptions.get(key);
  if (!entry) {
    entry = { refCount: 0, unsubscribe: subscribe() };
    subscriptions.set(key, entry);
  }
  entry.refCount += 1;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    entry!.refCount -= 1;
    if (entry!.refCount <= 0) {
      entry!.unsubscribe();
      subscriptions.delete(key);
    }
  };
}

/** Test-only escape hatch. */
export function _debugSharedSubscriptionRefCount(queryKey: readonly unknown[]): number {
  return subscriptions.get(keyFor(queryKey))?.refCount ?? 0;
}
