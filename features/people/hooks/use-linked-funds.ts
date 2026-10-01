"use client";

/**
 * Live source-linked People funds — money a person paid me that is waiting on (or has completed) my
 * onward card-bill / lender payment. A pure derivation (`lib/engines/linked-funds.ts`) over the live
 * ledger, transactions, cards and EMI / Loan installments: nothing is stored, so edit / revert / delete
 * of either side is reflected immediately.
 */

import { useMemo } from "react";
import { usePeopleLedgerEntries } from "@/features/people/hooks/use-people-data";
import { useCreditCards, useEmis } from "@/hooks/use-credit-cards";
import { useAllEmiInstallments } from "@/hooks/use-emis";
import { useAllLoanInstallments, useLoans } from "@/hooks/use-loans";
import { usePeople } from "@/hooks/use-people";
import { useTransactions } from "@/hooks/use-transactions";
import { useAccounts } from "@/hooks/use-accounts";
import { computeLinkedFunds, type LinkedFund, type LinkedFundsLoanSource, type LinkedFundsSource } from "@/lib/engines/linked-funds";
import type { Account } from "@/lib/models/account";
import type { Person } from "@/lib/models/person";
import type { Transaction } from "@/lib/models/transaction";

export function useLinkedFunds(): { funds: LinkedFund[]; isLoading: boolean } {
  const { entriesByPersonId, isLoading: entriesLoading } = usePeopleLedgerEntries();
  const { data: people = [] } = usePeople();
  const { data: transactions = [], isLoading: txLoading } = useTransactions();
  const { data: creditCards = [] } = useCreditCards();
  const { data: accounts = [] } = useAccounts();
  const { data: emis = [] } = useEmis();
  const { data: loans = [] } = useLoans();
  const { data: emiInstallments = [] } = useAllEmiInstallments();
  const { data: loanInstallments = [] } = useAllLoanInstallments();

  const funds = useMemo(() => {
    const cardAccountIds = new Set(creditCards.map((c) => c.accountId));
    const cardOpeningBalances = new Map(
      (accounts as Account[]).filter((a) => cardAccountIds.has(a.id)).map((a) => [a.id, a.openingBalance] as const),
    );
    return computeLinkedFunds({
      entries: Object.values(entriesByPersonId).flat(),
      persons: (people as Person[]).map((p) => ({ id: p.id, name: p.name })),
      transactions: transactions as Transaction[],
      creditCardAccountIds: cardAccountIds,
      cardOpeningBalances,
      emis: emis as unknown as LinkedFundsSource[],
      loans: loans as unknown as LinkedFundsLoanSource[],
      installments: [...emiInstallments, ...loanInstallments],
    });
  }, [entriesByPersonId, people, transactions, creditCards, accounts, emis, loans, emiInstallments, loanInstallments]);

  return { funds, isLoading: entriesLoading || txLoading };
}
