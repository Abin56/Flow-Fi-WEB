"use client";

/**
 * Mirrors the live-subscription pattern established by
 * `hooks/use-accounts.ts` — a live Firestore `watchAll` subscription feeding
 * a React Query cache, `staleTime: Infinity`.
 *
 * Only `Bill` templates (not `BillOccurrence`s) are wired here — see the doc
 * comment on `createBillRepository` in `lib/repositories/repository-factory.ts`
 * for why occurrences aren't part of this uid-scoped factory pattern.
 */

import { useQueryClient } from "@tanstack/react-query";
import type { Bill } from "@/lib/models/bill";
import { createBillRepository } from "@/lib/repositories/repository-factory";
import { useAuthStore } from "@/store/auth-store";
import { useFirestoreWatch } from "./use-firestore-watch";

export function billsQueryKey(uid: string | undefined) {
  return ["bills", uid] as const;
}

/** Live-subscribes to the signed-in user's active bill templates. */
export function useBills() {
  const uid = useAuthStore((s) => s.user?.uid);
  const queryClient = useQueryClient();

  return useFirestoreWatch<Bill[]>({
    queryKey: billsQueryKey(uid),
    enabled: !!uid,
    hookName: "useBills",
    emptyValue: [],
    deps: [uid, queryClient],
    subscribe: (onData, onError) => {
      if (!uid) return () => {};
      return createBillRepository(uid).watchAll(onData, onError);
    },
  });
}
