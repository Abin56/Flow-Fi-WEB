"use client";

/**
 * Mirrors the live-subscription pattern established by `hooks/use-bills.ts`
 * — a live Firestore `watchAll` subscription feeding a React Query cache,
 * `staleTime: Infinity`. Powers the People (Ledger) page's `Person` list.
 */

import { useQueryClient } from "@tanstack/react-query";
import type { Person } from "@/lib/models/person";
import { createPersonRepository } from "@/lib/repositories/repository-factory";
import { useAuthStore } from "@/store/auth-store";
import { useFirestoreWatch } from "./use-firestore-watch";

export function peopleQueryKey(uid: string | undefined) {
  return ["people", uid] as const;
}

/** Live-subscribes to the signed-in user's active people (creditors/debtors). */
export function usePeople() {
  const uid = useAuthStore((s) => s.user?.uid);
  const queryClient = useQueryClient();

  return useFirestoreWatch<Person[]>({
    queryKey: peopleQueryKey(uid),
    enabled: !!uid,
    hookName: "usePeople",
    emptyValue: [],
    deps: [uid, queryClient],
    subscribe: (onData, onError) => {
      if (!uid) return () => {};
      return createPersonRepository(uid).watchAll(onData, onError);
    },
  });
}
