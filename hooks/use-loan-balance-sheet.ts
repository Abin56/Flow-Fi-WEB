"use client";

/**
 * Live `LoanBalanceSheet` (see `lib/engines/loan-balance-sheet.ts`) plus the Net Worth that includes
 * it — the one source every "Net Worth" / liabilities / receivables figure on Web reads from.
 */

import { useMemo } from "react";
import { useNetWorth } from "@/hooks/use-accounts";
import { loanBalanceSheet, netWorthWithLoans, type LoanBalanceSheet } from "@/lib/engines/loan-balance-sheet";
import { outstandingPrincipalFor } from "@/lib/engines/loan-outstanding";
import { useLoanRows } from "@/features/loans/hooks/use-loans-data";
import { useEmiRows } from "@/features/emi/hooks/use-emi-data";
import { useCreditCardTotals } from "@/features/credit-cards/hooks/use-credit-cards-data";

export function useLoanBalanceSheet(): { sheet: LoanBalanceSheet; accountBalances: number; netWorth: number; isLoading: boolean } {
  const accountBalances = useNetWorth();
  const { rows: loanRows, isLoading: loansLoading } = useLoanRows();
  const { rows: emiRows, isLoading: emisLoading } = useEmiRows();
  // Card-owned EMI exposure no recorded purchase represents (Case B/C) — the same figure the
  // cards' available credit and the Reports "Credit Cards" line use.
  const { totals: cardTotals, isLoading: cardsLoading } = useCreditCardTotals();

  const sheet = useMemo(
    () =>
      loanBalanceSheet(
        loanRows.map((r) => ({ direction: r.direction, outstandingPrincipal: r.outstandingPrincipal })),
        emiRows.map((r) => ({
          // Principal only — never the remaining installment total, which includes future interest.
          outstandingPrincipal: outstandingPrincipalFor(r.emi.principalAmount, r.installments),
          // `linkedCard` is only set when `linkedCreditCardId` resolves to a card tracked in FlowFi.
          ownedByTrackedCard: r.linkedCard != null,
        })),
        cardTotals.lockedEmiPrincipal,
      ),
    [loanRows, emiRows, cardTotals.lockedEmiPrincipal],
  );

  return {
    sheet,
    accountBalances,
    netWorth: netWorthWithLoans(accountBalances, sheet),
    isLoading: loansLoading || emisLoading || cardsLoading,
  };
}
