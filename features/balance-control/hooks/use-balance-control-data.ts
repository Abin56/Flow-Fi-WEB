"use client";

/**
 * READ-ONLY data for Balance Control and the Financial Audit's definition checks. Composes hooks that already
 * exist (live Firestore reads through the app's normal repositories); it adds no query, no write and no engine.
 */

import { useMemo } from "react";
import { useAccounts } from "@/hooks/use-accounts";
import { useCardUtilizationEmis } from "@/hooks/use-card-utilization-emis";
import { useCreditCards } from "@/hooks/use-credit-cards";
import { useLoanBalanceSheet } from "@/hooks/use-loan-balance-sheet";
import { useTransactions } from "@/hooks/use-transactions";
import { runBalanceChecks, type BalanceCheckReport } from "@/lib/engines/balance-control-checks";
import type { Account } from "@/lib/models/account";
import type { CreditCardProfile } from "@/lib/models/credit-card";
import type { Transaction } from "@/lib/models/transaction";
import { creditCardTotalsFrom, useCreditCardStandings } from "@/features/credit-cards/hooks/use-credit-cards-data";
import { useEmiRows } from "@/features/emi/hooks/use-emi-data";
import { useLoanRows } from "@/features/loans/hooks/use-loans-data";
import { buildCheckAgreements, buildCheckCards, buildVarianceProducts, type VarianceProduct } from "../lib/build-balance-control";

export function useBalanceControlData(): {
  products: VarianceProduct[];
  report: BalanceCheckReport;
  isLoading: boolean;
  /** A live read failed (permissions / listener error) — the figures may be incomplete. */
  isError: boolean;
  /** For the outstanding reconciliation sheet's "existing relevant transactions" list — read-only. */
  transactions: Transaction[];
} {
  const { data: accounts = [], isLoading: accountsLoading, isError: accountsError } = useAccounts();
  const { data: transactions = [], isLoading: transactionsLoading, isError: transactionsError } = useTransactions();
  const { data: cards = [], isLoading: cardsLoading, isError: cardsError } = useCreditCards();
  const { standings, isLoading: standingsLoading } = useCreditCardStandings();
  const { rows: loanRows, isLoading: loansLoading } = useLoanRows();
  const { rows: emiRows, isLoading: emisLoading } = useEmiRows();
  const { sheet, isLoading: sheetLoading } = useLoanBalanceSheet();
  const { utilizationEmis, isLoading: utilizationLoading } = useCardUtilizationEmis();

  const isLoading =
    accountsLoading || transactionsLoading || cardsLoading || standingsLoading || loansLoading || emisLoading || sheetLoading || utilizationLoading;

  const products = useMemo(
    () => buildVarianceProducts({ standings, accounts: accounts as Account[], loanRows, emiRows }),
    [standings, accounts, loanRows, emiRows],
  );

  const report = useMemo(() => {
    const trackedCardIds = new Set((cards as CreditCardProfile[]).map((c) => c.id));
    return runBalanceChecks({
      cards: buildCheckCards(standings, accounts as Account[], transactions as Transaction[]),
      reportsCardUtilized: creditCardTotalsFrom(standings).utilized,
      sheet,
      utilizationEmis,
      agreements: buildCheckAgreements(loanRows, emiRows, trackedCardIds),
    });
  }, [standings, accounts, transactions, cards, sheet, utilizationEmis, loanRows, emiRows]);

  return { products, report, isLoading, isError: accountsError || transactionsError || cardsError, transactions: transactions as Transaction[] };
}
