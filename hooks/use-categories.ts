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
      const repository = createCategoryRepository(uid);
      // First launch (or everything purged): populate the starter set so pickers aren't empty.
      void repository.seedDefaultsIfEmpty().catch((err) => onError(err));
      // Hide copies left behind by earlier racing seeds: same default name + type shown once.
      return repository.watchAll((categories) => {
        const seen = new Set<string>();
        onData(
          categories.filter((c) => {
            if (!c.isDefault) return true;
            const key = `${c.type}:${c.name.toLowerCase()}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          }),
        );
      }, onError);
    },
  });
}
