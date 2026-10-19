"use client";

/**
 * The Transactions page's account filter, driven by the URL (`?account=<id>`).
 *
 * - The URL is the source of truth, so a direct link, refresh and browser back/forward all behave: the filter is
 *   read from the URL on every render rather than copied into state once.
 * - The id is validated with a direct read of the signed-in user's OWN account document (never trusting the live
 *   list while it may still be empty). A missing, deleted or someone else's id gives no filter — and a visible
 *   notice, not a silent swap to another account.
 * - Only a validated id is handed to Add Transaction as explicit account context.
 */

import { useQuery } from "@tanstack/react-query";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { ACCOUNT_FILTER_PARAM, accountIdFromParams, deriveAccountFilter, type AccountFilterState, type AccountLookup } from "@/features/transactions/lib/account-filter-param";
import type { Account } from "@/lib/models/account";
import { createAccountRepository } from "@/lib/repositories/repository-factory";
import { useAuthStore } from "@/store/auth-store";

export interface UseAccountFilter extends AccountFilterState {
  /** Sets (or, with null, clears) the filter by updating the URL. */
  setAccountId: (id: string | null) => void;
  /** The account document from the direct lookup — lets the chip show a name before the live list has loaded. */
  lookedUp: Account | null;
  /** The id from the URL that was confirmed invalid and not yet dismissed — for the "account not found" notice. */
  invalidId: string | null;
  dismissInvalid: () => void;
}

export function useAccountFilter(knownAccounts: readonly Pick<Account, "id">[]): UseAccountFilter {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const uid = useAuthStore((s) => s.user?.uid);
  const urlId = accountIdFromParams(searchParams);
  const [dismissed, setDismissed] = useState<string | null>(null);

  const lookupQuery = useQuery({
    queryKey: ["accountFilterLookup", uid, urlId],
    enabled: !!uid && urlId != null,
    // Fresh on every visit/refresh: an account deleted elsewhere must not stay "valid" from a stale cache entry.
    staleTime: 0,
    gcTime: 0,
    retry: false,
    queryFn: async (): Promise<{ account: Account | null }> => {
      const account = await createAccountRepository(uid!).getByKey(urlId!);
      return { account: account && account.deletedAt == null ? account : null };
    },
  });
  const lookup: AccountLookup = lookupQuery.isError ? "unavailable" : lookupQuery.data ? (lookupQuery.data.account ? "valid" : "invalid") : "pending";

  const knownIds = useMemo(() => new Set(knownAccounts.map((a) => a.id)), [knownAccounts]);
  const state = deriveAccountFilter({ urlId, signedIn: !!uid, knownIds, lookup });

  const setAccountId = useCallback(
    (id: string | null) => {
      const next = new URLSearchParams(searchParams.toString());
      if (id) next.set(ACCOUNT_FILTER_PARAM, id);
      else next.delete(ACCOUNT_FILTER_PARAM);
      const qs = next.toString();
      // replace, not push: picking/clearing a filter shouldn't add history entries (Back still leaves the page).
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [searchParams, router, pathname],
  );

  const invalidId = state.status === "invalid" && urlId !== dismissed ? urlId : null;
  return {
    ...state,
    setAccountId,
    lookedUp: lookupQuery.data?.account ?? null,
    invalidId,
    dismissInvalid: () => {
      setDismissed(urlId);
      setAccountId(null);
    },
  };
}
