"use client";

/**
 * Determines which financial product groups the signed-in user actually has
 * data for, so nav/dashboard UI can hide sections that would otherwise show
 * empty. Reuses the same cached `useFirestoreWatch` queries the Accounts,
 * Credit Cards, Loans, and EMI features already subscribe to (`staleTime:
 * Infinity`), so calling this from the nav — which renders on every route —
 * doesn't trigger any extra Firestore reads.
 */

import { useAccounts } from "./use-accounts";
import { useCreditCards, useEmis } from "./use-credit-cards";
import { useLoans } from "./use-loans";

export interface FinancialProductAvailability {
  hasAccounts: boolean;
  hasCreditCards: boolean;
  hasLoans: boolean;
  hasEmis: boolean;
  hasLoanOrEmi: boolean;
  isLoading: boolean;
}

/** Live-derives which of Accounts / Credit Cards / Loans / EMI the user has at least one record for. */
export function useFinancialProductAvailability(): FinancialProductAvailability {
  const { data: accounts, isLoading: accountsLoading } = useAccounts();
  const { data: creditCards, isLoading: creditCardsLoading } = useCreditCards();
  const { data: loans, isLoading: loansLoading } = useLoans();
  const { data: emis, isLoading: emisLoading } = useEmis();

  const hasAccounts = (accounts?.length ?? 0) > 0;
  const hasCreditCards = (creditCards?.length ?? 0) > 0;
  const hasLoans = (loans?.length ?? 0) > 0;
  const hasEmis = (emis?.length ?? 0) > 0;

  return {
    hasAccounts,
    hasCreditCards,
    hasLoans,
    hasEmis,
    hasLoanOrEmi: hasLoans || hasEmis,
    isLoading: accountsLoading || creditCardsLoading || loansLoading || emisLoading,
  };
}
