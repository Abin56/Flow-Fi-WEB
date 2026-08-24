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

import { useEffect, useState } from "react";
import { useQueryClient, type Query } from "@tanstack/react-query";

export interface WatcherErrorInfo {
  queryKey: readonly unknown[];
  message: string;
}

function computeErrors(cache: ReturnType<ReturnType<typeof useQueryClient>["getQueryCache"]>): WatcherErrorInfo[] {
  return cache.findAll({ predicate: (q: Query) => q.state.status === "error" }).map((q) => ({
    queryKey: q.queryKey,
    message: q.state.error instanceof Error ? q.state.error.message : "Something went wrong.",
  }));
}

function sameErrors(a: WatcherErrorInfo[], b: WatcherErrorInfo[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((e, i) => e.message === b[i].message && JSON.stringify(e.queryKey) === JSON.stringify(b[i].queryKey));
}

export function useWatcherErrors(): WatcherErrorInfo[] {
  const queryClient = useQueryClient();
  const [errors, setErrors] = useState<WatcherErrorInfo[]>([]);

  useEffect(() => {
    const cache = queryClient.getQueryCache();

    function sync() {
      setErrors((prev) => {
        const next = computeErrors(cache);
        return sameErrors(prev, next) ? prev : next;
      });
    }

    sync();
    return cache.subscribe(sync);
  }, [queryClient]);

  return errors;
}
