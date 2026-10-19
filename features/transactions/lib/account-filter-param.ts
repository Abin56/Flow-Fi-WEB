/** Query param that pre-selects the Transactions workspace's existing account filter (an account or a card's account). */
export const ACCOUNT_FILTER_PARAM = "account";

/** `/transactions?account=<id>` — the one link Accounts and Credit Cards use for "View transactions". */
export function transactionsHrefForAccount(accountId: string): string {
  return `/transactions?${ACCOUNT_FILTER_PARAM}=${encodeURIComponent(accountId)}`;
}

/** The account id carried by the URL, or null when absent/blank. (Not validated — see `deriveAccountFilter`.) */
export function accountIdFromParams(params: { get(name: string): string | null }): string | null {
  const raw = params.get(ACCOUNT_FILTER_PARAM)?.trim();
  return raw ? raw : null;
}

/** The result of looking the URL's account up directly (Firestore, under the signed-in user's own accounts). */
export type AccountLookup = "pending" | "valid" | "invalid" | "unavailable";

export type AccountFilterStatus =
  /** No account in the URL. */
  | "none"
  /** An account id is in the URL but not confirmed yet (signing in, or the lookup is running / couldn't complete). */
  | "checking"
  /** The account exists, is active and belongs to the signed-in user. */
  | "valid"
  /** The URL's id is not one of the signed-in user's active accounts. */
  | "invalid";

export interface AccountFilterState {
  status: AccountFilterStatus;
  /** The account id the list is filtered by: kept while `checking` (so a refresh / direct link never flashes the unfiltered list). Never a substitute id. */
  appliedId: string | null;
  /** The account id Add Transaction may treat as explicit context: only once `valid`. */
  contextId: string | null;
}

/**
 * Single rule for the Transactions account filter. The URL is the source of truth (so refresh and back/forward just
 * work); the id is validated, never silently swapped: a confirmed-invalid id yields NO filter (the caller says so),
 * and nothing is ever chosen from another account's data. `knownIds` is the live account list — useful to confirm
 * quickly — but an EMPTY or not-yet-loaded list is never evidence that an id is invalid; only `lookup` can say that.
 */
export function deriveAccountFilter(opts: { urlId: string | null; signedIn: boolean; knownIds: ReadonlySet<string>; lookup: AccountLookup }): AccountFilterState {
  const { urlId, signedIn, knownIds, lookup } = opts;
  if (!urlId) return { status: "none", appliedId: null, contextId: null };
  if (knownIds.has(urlId)) return { status: "valid", appliedId: urlId, contextId: urlId };
  if (!signedIn) return { status: "checking", appliedId: urlId, contextId: null };
  if (lookup === "valid") return { status: "valid", appliedId: urlId, contextId: urlId };
  if (lookup === "invalid") return { status: "invalid", appliedId: null, contextId: null };
  return { status: "checking", appliedId: urlId, contextId: null };
}
