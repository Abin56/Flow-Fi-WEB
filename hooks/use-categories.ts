"use client";

/**
 * Mirrors the live-subscription pattern established by
 * `hooks/use-accounts.ts` — a live Firestore `watchAll` subscription feeding
 * a React Query cache, `staleTime: Infinity`.
 */

import { useQueryClient } from "@tanstack/react-query";
import type { Category } from "@/lib/models/category";
import { createCategoryRepository } from "@/lib/repositories/repository-factory";
import { useAuthStore } from "@/store/auth-store";
import { useFirestoreWatch } from "./use-firestore-watch";

export function categoriesQueryKey(uid: string | undefined) {
  return ["categories", uid] as const;
}

/** Live-subscribes to the signed-in user's active categories. */
export function useCategories() {
  const uid = useAuthStore((s) => s.user?.uid);
  const queryClient = useQueryClient();

  return useFirestoreWatch<Category[]>({
    queryKey: categoriesQueryKey(uid),
    enabled: !!uid,
    hookName: "useCategories",
    emptyValue: [],
    deps: [uid, queryClient],
    subscribe: (onData, onError) => {
      if (!uid) return () => {};
      return createCategoryRepository(uid).watchAll(onData, onError);
    },
  });
}
