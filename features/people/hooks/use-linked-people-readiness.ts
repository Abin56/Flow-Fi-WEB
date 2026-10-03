"use client";

/**
 * Live Linked People readiness for a lender-payment screen (card bill / Loan / EMI installment). Reads
 * the same per-person statements the People Ledger list builds (`usePeopleCycleStatements`) over the
 * whole history, so every share / received / remaining figure matches the ledger exactly. Feeds the
 * People settlement gate (`peopleSettlementGate`) that holds the lender payment until People is settled.
 */

import { useMemo } from "react";
import { usePeopleCycleStatements } from "@/features/people/hooks/use-person-cycle-statement";
import { usePeopleLedgerEntries } from "@/features/people/hooks/use-people-data";
import { useTransactions } from "@/hooks/use-transactions";
import { useAccounts } from "@/hooks/use-accounts";
import { linkedPeopleForCard, linkedPeopleForInstallments, type LinkedPeopleReadiness } from "@/lib/engines/linked-people-readiness";
import type { StatementCycle } from "@/lib/engines/person-cycle-statement";
import type { Account } from "@/lib/models/account";
import type { Transaction } from "@/lib/models/transaction";

const ALL_TIME: StatementCycle = { start: new Date(1970, 0, 1), end: new Date(2200, 0, 1) };

export type LinkedPeopleTarget =
  | { kind: "card"; cardAccountId: string; lenderDue: number }
  /** `installmentIds`: every installment the payment settles that the gate covers (`gatedInstallmentIds`). */
  | { kind: "emi" | "loan"; installmentId: string; installmentIds?: readonly string[]; lenderDue: number };

export function useLinkedPeopleReadiness(target: LinkedPeopleTarget | null): { readiness: LinkedPeopleReadiness | null; isLoading: boolean } {
  const { statementsByPersonId, isLoading } = usePeopleCycleStatements(ALL_TIME);
  const { entriesByPersonId, isLoading: entriesLoading } = usePeopleLedgerEntries();
  const { data: transactions = [], isLoading: transactionsLoading } = useTransactions();
  const { data: accounts = [] } = useAccounts();

  const key = target == null ? null : target.kind === "card" ? `card:${target.cardAccountId}:${target.lenderDue}` : `${target.kind}:${(target.installmentIds ?? [target.installmentId]).join(",")}:${target.lenderDue}`;
  const readiness = useMemo(() => {
    if (target == null) return null;
    const statements = Object.values(statementsByPersonId);
    if (target.kind === "card") {
      return linkedPeopleForCard({
        statements,
        ledgerEntries: Object.values(entriesByPersonId).flat(),
        transactions: transactions as Transaction[],
        cardAccountId: target.cardAccountId,
        cardOpeningBalance: (accounts as Account[]).find((a) => a.id === target.cardAccountId)?.openingBalance ?? 0,
        lenderDue: target.lenderDue,
      });
    }
    return linkedPeopleForInstallments({
      statements,
      installmentIds: target.installmentIds ?? [target.installmentId],
      sourceKind: target.kind,
      lenderDue: target.lenderDue,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` captures `target`
  }, [key, statementsByPersonId, entriesByPersonId, transactions, accounts]);

  // Unknown until every source has loaded — a lender-payment gate must not read "nothing linked" early.
  return { readiness, isLoading: isLoading || entriesLoading || transactionsLoading };
}
