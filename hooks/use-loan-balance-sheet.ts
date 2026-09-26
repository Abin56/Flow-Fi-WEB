"use client";

/**
 * Live `LoanBalanceSheet` (see `lib/engines/loan-balance-sheet.ts`) plus the Net Worth that includes
 * it — the one source every "Net Worth" / liabilities / receivables figure on Web reads from.
 */

import { useMemo } from "react";
import { useNetWorth } from "@/hooks/use-accounts";
import { useCreditCards } from "@/hooks/use-credit-cards";
import { cardFundedLoanCardId } from "@/lib/engines/credit-utilization";
import { loanBalanceSheet, netWorthWithLoans, type LoanBalanceSheet } from "@/lib/engines/loan-balance-sheet";
import { outstandingPrincipalFor } from "@/lib/engines/loan-outstanding";
import { useLoanRows } from "@/features/loans/hooks/use-loans-data";
import { useEmiRows } from "@/features/emi/hooks/use-emi-data";
import { useCreditCardTotals } from "@/features/credit-cards/hooks/use-credit-cards-data";

export function useLoanBalanceSheet(): { sheet: LoanBalanceSheet; accountBalances: number; netWorth: number; isLoading: boolean } {
  const accountBalances = useNetWorth();
  const { rows: loanRows, isLoading: loansLoading } = useLoanRows();
  const { rows: emiRows, isLoading: emisLoading } = useEmiRows();
  const { data: cards = [], isLoading: cardListLoading } = useCreditCards();
  // Card-owned EMI / card-funded Loan exposure no recorded purchase represents (Case B/C) — the same
  // figure the cards' available credit and the Reports "Credit Cards" line use.
  const { totals: cardTotals, isLoading: cardsLoading } = useCreditCardTotals();

  const sheet = useMemo(() => {
    const trackedCardIds = new Set(cards.map((c) => c.id));
    return loanBalanceSheet(
      loanRows.map((r) => {
        // A Loan financed on a tracked card is that card's liability (its lock, or the represented
        // purchase) — counting it as "borrowed" too subtracted the same money twice from Net Worth.
        const cardId = cardFundedLoanCardId(r.loan);
        return {
          direction: r.direction,
          outstandingPrincipal: r.outstandingPrincipal,
          ownedByTrackedCard: cardId != null && trackedCardIds.has(cardId),
        };
      }),
      emiRows.map((r) => ({
        // Principal only — never the remaining installment total, which includes future interest.
        outstandingPrincipal: outstandingPrincipalFor(r.emi.principalAmount, r.installments),
        // `linkedCard` is only set when `linkedCreditCardId` resolves to a card tracked in FlowFi.
        ownedByTrackedCard: r.linkedCard != null,
      })),
      cardTotals.lockedEmiPrincipal,
    );
  }, [loanRows, emiRows, cards, cardTotals.lockedEmiPrincipal]);

  return {
    sheet,
    accountBalances,
    netWorth: netWorthWithLoans(accountBalances, sheet),
    isLoading: loansLoading || emisLoading || cardsLoading || cardListLoading,
  };
}
