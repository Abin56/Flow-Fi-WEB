"use client";

/**
 * Shared "live Firestore listener feeding a React Query cache" pattern —
 * every `watchAll`/`onSnapshot`-based hook in this app follows this exact
 * shape: subscribe on mount, push snapshots into the query cache, unsubscribe
 * on cleanup. Before this hook existed, listener *errors* were handled
 * inconsistently: `hooks/use-accounts.ts` correctly surfaced them as real
 * query error state, but the other 13 watch hooks in this directory only
 * `console.error`'d them, leaving the UI stuck on stale/empty/loading state
 * forever with nothing telling the user something actually failed (a
 * permission-denied or offline error looks identical to "still loading").
 * Every hook in this directory should build on this rather than
 * hand-rolling the subscribe/error/cleanup wiring again.
 *
 * Production-hardening pass: `isError`/`error` were captured on this hook's
 * own *return value*, but the underlying React Query cache entry never
 * actually transitioned to an error state (the `queryFn` below always
 * resolves — it's just a placeholder the snapshot listener writes over), so
 * nothing that scans the query cache (e.g. `useWatcherErrors`, backing the
 * app-wide `WatcherErrorBanner`) could ever see one of these failures. Every
 * watcher error now also calls the matching `Query`'s `setState` directly,
 * so the cache entry itself genuinely reports `status: "error"` — the one
 * piece of plumbing a shared, cache-driven banner needs to work for every
 * watcher automatically, with no per-screen wiring. A Firestore `onSnapshot`
 * listener does not auto-resubscribe after an error the way it retries a
 * transient network blip on its own — the callback fires once and the
 * subscription ends — so `retryFirestoreWatch`/`registerRetry` below let the
 * banner's "Retry" button force a teardown+resubscribe.
 */

import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { acquireSharedSubscription, keyFor, registerRetry } from "@/lib/services/firestore-watch-registry";

export { retryFirestoreWatch } from "@/lib/services/firestore-watch-registry";

export interface UseFirestoreWatchOptions<T> {
  queryKey: readonly unknown[];
  enabled: boolean;
  /** Opens the live subscription; must return its own unsubscribe function. */
  subscribe: (onData: (data: T) => void, onError: (error: unknown) => void) => () => void;
  /** Effect dependency array — pass whatever the `subscribe` closure actually captures (uid, queryClient, and any other identifiers it reads). */
  deps: readonly unknown[];
  /** Used only in the console.error line, so a failure in the network tab can be traced back to which hook opened the listener. */
  hookName: string;
  /** What `data` reads as before the first snapshot arrives (or while `enabled` is false) — e.g. `[]` for every list hook in this app. */
  emptyValue: T;
}

export function useFirestoreWatch<T>(options: UseFirestoreWatchOptions<T>): UseQueryResult<T, Error> {
  const { queryKey, enabled, subscribe, deps, hookName, emptyValue } = options;
  const queryClient = useQueryClient();
  const [retryToken, setRetryToken] = useState(0);

  useEffect(
    () => registerRetry(queryKey, () => setRetryToken((n) => n + 1)),
    // Registration is keyed on the queryKey's identity, not remounted every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [keyFor(queryKey)],
  );

  useEffect(() => {
    if (!enabled) return;
    // Reference-counted — see acquireSharedSubscription's doc comment. Only the first
    // concurrently-mounted consumer for this queryKey actually opens the Firestore listener;
    // every other one (another component watching the same data, or this same page being
    // revisited while something else kept it alive) rides the shared React Query cache instead
    // of tearing down and re-fetching the whole collection on every mount.
    return acquireSharedSubscription(queryKey, () =>
      subscribe(
        (data) => queryClient.setQueryData(queryKey, data),
        (error) => {
          console.error(`${hookName} watchAll failed:`, error);
          const err = error instanceof Error ? error : new Error(String(error));
          // Marks the underlying cache entry itself as errored — every useQuery(queryKey)
          // observer (including WatcherErrorBanner/useWatcherErrors, which scan the cache)
          // re-renders off this automatically, with no per-screen wiring needed.
          queryClient.getQueryCache().find({ queryKey })?.setState({ status: "error", error: err, fetchStatus: "idle" });
        },
      ),
    );
    // `deps` is intentionally the effect's real dependency list, supplied by the caller —
    // this hook's own body has nothing else that would need to trigger a re-subscribe,
    // besides `retryToken` bumping to force a teardown+resubscribe on retry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, retryToken]);

  return useQuery<T>({
    queryKey,
    queryFn: () => Promise.resolve(emptyValue), // populated by the snapshot listener above
    enabled,
    staleTime: Infinity,
    initialData: enabled ? undefined : emptyValue,
  });
}
