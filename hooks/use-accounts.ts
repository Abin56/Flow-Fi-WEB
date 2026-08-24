"use client";

/**
 * Mirrors `accountsStreamProvider`/`netWorthProvider` in
 * `lib/features/accounts/presentation/providers/account_providers.dart` —
 * a live Firestore subscription (not a one-shot fetch) exposed through
 * React Query's cache, matching the "always up to date" semantics of the
 * Flutter app's Riverpod StreamProvider.
 */

import { useQueryClient } from "@tanstack/react-query";
import { calculateNetWorth } from "@/lib/engines/net-worth";
import type { Account } from "@/lib/models/account";
import { createAccountRepository } from "@/lib/repositories/repository-factory";
import { useAuthStore } from "@/store/auth-store";
import { useFirestoreWatch } from "./use-firestore-watch";

export function accountsQueryKey(uid: string | undefined) {
  return ["accounts", uid] as const;
}

/** Live-subscribes to the signed-in user's active accounts. */
export function useAccounts() {
  const uid = useAuthStore((s) => s.user?.uid);
  const queryClient = useQueryClient();

  return useFirestoreWatch<Account[]>({
    queryKey: accountsQueryKey(uid),
    enabled: !!uid,
    hookName: "useAccounts",
    emptyValue: [],
    deps: [uid, queryClient],
    subscribe: (onData, onError) => {
      if (!uid) return () => {};
      const repository = createAccountRepository(uid);
      return repository.watchAll(onData, onError);
    },
  });
}

/** Net Worth — sum of every active account's currentBalance. Mirrors `netWorthProvider`. */
export function useNetWorth(): number {
  const { data: accounts } = useAccounts();
  return calculateNetWorth(accounts ?? []);
}
