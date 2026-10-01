/** Query param that pre-selects the Transactions workspace's existing account filter (an account or a card's account). */
export const ACCOUNT_FILTER_PARAM = "account";

/** `/transactions?account=<id>` — the one link Accounts and Credit Cards use for "View transactions". */
export function transactionsHrefForAccount(accountId: string): string {
  return `/transactions?${ACCOUNT_FILTER_PARAM}=${encodeURIComponent(accountId)}`;
}

/**
 * The account filter to keep once accounts have loaded: the id if it still exists, else `null` so a stale or
 * deleted id falls back to the unfiltered list instead of an empty page. While loading, keep it as-is.
 */
export function resolveAccountFilter(
  accountId: string | null,
  accounts: readonly { id: string }[],
  isLoading: boolean,
): string | null {
  if (!accountId || isLoading) return accountId;
  return accounts.some((a) => a.id === accountId) ? accountId : null;
}
