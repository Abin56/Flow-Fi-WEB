"use client";

import { useMemo } from "react";
import { useAccounts } from "@/hooks/use-accounts";
import { useTransactions } from "@/hooks/use-transactions";
import type { SettlementLookups } from "@/features/people/lib/settlement-presentation";
import type { PendingSplitParticipant } from "@/lib/engines/person-pending-split-participants";
import type { Expense } from "@/lib/models/expense";
import type { LedgerEntry } from "@/lib/models/person";
import { useLinkedFunds } from "@/features/people/hooks/use-linked-funds";
import { linkedFundsByObligation, type LinkedFund } from "@/lib/engines/linked-funds";

export interface SettlementLookupsWithAccounts extends SettlementLookups {
  /** The account a ledger entry's cash leg moved through ("SBI Savings"), when it has one. */
  accountForEntry: (entryId: string | null) => string | null;
  /** The part of a Record Payment recorded as separate income (its Income transaction), for the entry's payment. */
  incomeForEntry: (entryId: string | null) => number;
  /** Money received for this obligation (statement row key) that funds a card bill / EMI — pending or paid onward. */
  linkedFundsFor: (rowKey: string) => LinkedFund[];
  accountNameOf: (accountId: string) => string | undefined;
}

/**
 * Read-only lookups for the settlement presentation: each ledger entry (for its `sourceKind`), the
 * Expense behind a split/assigned share, and the account a payment's cash leg moved through. No
 * balance or allocation is derived here.
 */
export function useSettlementLookups(ledgerEntries: readonly LedgerEntry[], pending: readonly PendingSplitParticipant[]): SettlementLookupsWithAccounts {
  const { data: transactions = [] } = useTransactions();
  const { data: accounts = [] } = useAccounts();
  const { funds } = useLinkedFunds();
  return useMemo(() => {
    const entriesById = new Map(ledgerEntries.map((e) => [e.id, e]));
    const expenseByTransactionId = new Map<string, Expense>();
    for (const p of pending) expenseByTransactionId.set(p.expense.transactionId, p.expense);
    const accountName = new Map(accounts.map((a) => [a.id, a.name]));
    const accountByTransaction = new Map(transactions.map((t) => [t.id, t.accountId]));
    const liveAmount = new Map(transactions.filter((t) => t.deletedAt == null).map((t) => [t.id, t.amount]));
    const incomeForEntry = (entryId: string | null) => {
      const ref = entryId ? entriesById.get(entryId)?.incomeTransactionRef : null;
      return ref ? (liveAmount.get(ref) ?? 0) : 0;
    };
    const accountForEntry = (entryId: string | null) => {
      const ref = entryId ? entriesById.get(entryId)?.transactionRef : null;
      const accountId = ref ? accountByTransaction.get(ref) : undefined;
      return accountId ? (accountName.get(accountId) ?? null) : null;
    };
    const byObligation = linkedFundsByObligation(funds);
    const linkedFundsFor = (rowKey: string) => byObligation.get(rowKey) ?? [];
    const accountNameOf = (accountId: string) => accountName.get(accountId);
    return { entriesById, expenseByTransactionId, accountForEntry, incomeForEntry, linkedFundsFor, accountNameOf };
  }, [ledgerEntries, pending, transactions, accounts, funds]);
}
