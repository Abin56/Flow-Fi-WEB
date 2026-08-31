"use client";

/**
 * Reactively lists every currently-erroring query in the React Query cache
 * — in practice, every live Firestore watcher hook (`useFirestoreWatch`)
 * whose listener is currently failing, since those are the only queries in
 * this app that ever enter an error state (mutations aren't queries, and
 * every `queryFn` here is a no-op that can't itself throw). Driven by the
 * cache's own `subscribe`, not a hardcoded list of hooks to check — a new
 * watcher hook added later is covered automatically, with no extra wiring.
 */

import { useSyncExternalStore } from "react";
import { useQueryClient, type Query, type QueryCache } from "@tanstack/react-query";

export interface WatcherErrorInfo {
  queryKey: readonly unknown[];
  message: string;
}

function computeErrors(cache: QueryCache): WatcherErrorInfo[] {
  return cache.findAll({ predicate: (q: Query) => q.state.status === "error" }).map((q) => ({
    queryKey: q.queryKey,
    message: q.state.error instanceof Error ? q.state.error.message : "Something went wrong.",
  }));
}

function sameErrors(a: WatcherErrorInfo[], b: WatcherErrorInfo[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((e, i) => e.message === b[i].message && JSON.stringify(e.queryKey) === JSON.stringify(b[i].queryKey));
}

// Keyed on the QueryCache instance (there's only one in this app, via the single QueryClient
// provider, but this avoids assuming that) — `useSyncExternalStore` requires `getSnapshot` to
// return a referentially stable value when nothing actually changed, or it can loop/warn.
const lastSnapshot = new WeakMap<QueryCache, WatcherErrorInfo[]>();

function getSnapshot(cache: QueryCache): WatcherErrorInfo[] {
  const next = computeErrors(cache);
  const prev = lastSnapshot.get(cache);
  if (prev && sameErrors(prev, next)) return prev;
  lastSnapshot.set(cache, next);
  return next;
}

/**
 * Built on `useSyncExternalStore` rather than a hand-rolled `useState`+`useEffect` subscription —
 * the query cache can now legitimately change while a *different* component is still rendering
 * (e.g. one watcher's error is set while another page is mounting a fresh observer for the same
 * queryKey, per `useFirestoreWatch`'s shared-subscription design), and `useSyncExternalStore` is
 * the React-sanctioned primitive for exactly that case — a manual subscription here previously hit
 * React's "Cannot update a component while rendering a different component" error.
 */
export function useWatcherErrors(): WatcherErrorInfo[] {
  const queryClient = useQueryClient();
  const cache = queryClient.getQueryCache();

  return useSyncExternalStore(
    (onStoreChange) => cache.subscribe(onStoreChange),
    () => getSnapshot(cache),
    () => getSnapshot(cache),
  );
}
