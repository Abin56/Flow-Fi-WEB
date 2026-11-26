"use client";

/**
 * Credit usage breakdown (Loan / EMI vs Purchases) for every card, every shared facility and the total —
 * presentation only. Reads the view items the page already renders (their bills, outstanding, locked
 * principal, available and limit come straight from the existing engines) and the same live transactions /
 * EMIs / Loans the standings were built from; see `features/credit-cards/lib/card-usage-breakdown.ts`.
 */

import { useMemo } from "react";
import { useEmis } from "@/hooks/use-credit-cards";
import { useLoans } from "@/hooks/use-loans";
import { useTransactions } from "@/hooks/use-transactions";
import type { Emi } from "@/lib/models/emi";
import type { Loan } from "@/lib/models/loan";
import type { Transaction } from "@/lib/models/transaction";
import {
  addSplits,
  cardBillBreakdowns,
  cardOutstandingSplit,
  financedPurchasesFrom,
  financedTransferTargetsFrom,
  type CardBillBreakdown,
  usageBreakdown,
  type CardUsageSplit,
  type CreditUsageBreakdown,
  type FinancedPurchases,
} from "@/features/credit-cards/lib/card-usage-breakdown";
import type { CreditCardViewItem } from "./use-credit-cards-data";

export interface CreditUsageBreakdowns {
  /** Per card id — facility-wide for a shared-limit card (same as its `usedCredit`). */
  byCardId: ReadonlyMap<string, CreditUsageBreakdown>;
  /** This physical card's own outstanding split (before pooling) — for shared-limit "this card" detail. */
  ownSplitByCardId: ReadonlyMap<string, CardUsageSplit>;
  /** All cards, each shared facility counted once — adds up to the summary's Credit used. */
  total: CreditUsageBreakdown;
  financed: FinancedPurchases;
  financedTransferTargets: ReadonlyMap<string, string>;
  billBreakdownsByCardId: ReadonlyMap<string, ReadonlyMap<string, CardBillBreakdown>>;
  /** Card-account transactions by account id (live, not deleted), for the activity views. */
  transactionsByAccountId: ReadonlyMap<string, Transaction[]>;
}

export function computeCreditUsageBreakdowns(items: readonly CreditCardViewItem[], transactions: readonly Transaction[], emis: readonly Emi[], loans: readonly Loan[]): CreditUsageBreakdowns {
  const accountIds = new Set(items.map((i) => i.card.accountId));
  const transactionsByAccountId = new Map<string, Transaction[]>();
  for (const t of transactions) {
    if (t.deletedAt != null || !accountIds.has(t.accountId)) continue;
    const list = transactionsByAccountId.get(t.accountId) ?? [];
    list.push(t);
    transactionsByAccountId.set(t.accountId, list);
  }
  const financed = financedPurchasesFrom(emis, loans, items.map((i) => ({ id: i.card.id, accountId: i.card.accountId })));
  const financedTransferTargets = financedTransferTargetsFrom(emis, loans, financed);
  const billBreakdownsByCardId = new Map(items.map((i) => [i.id, cardBillBreakdowns({
    bills: i.bills,
    cardTransactions: transactionsByAccountId.get(i.card.accountId) ?? [],
    financed,
    transferTargets: financedTransferTargets,
  })]));

  const ownSplitByCardId = new Map<string, CardUsageSplit>(
    items.map((i) => [
      i.id,
      cardOutstandingSplit({ bills: i.bills, cardTransactions: transactionsByAccountId.get(i.card.accountId) ?? [], financed, ownOutstanding: i.ownUsage, breakdowns: billBreakdownsByCardId.get(i.id) }),
    ]),
  );

  const facilitySplit = (i: CreditCardViewItem) =>
    i.sharedLimit ? addSplits(i.sharedLimit.memberCardIds.map((id) => ownSplitByCardId.get(id)).filter((s): s is CardUsageSplit => s != null)) : ownSplitByCardId.get(i.id)!;

  const byCardId = new Map<string, CreditUsageBreakdown>(
    items.map((i) => [
      i.id,
      usageBreakdown({ split: facilitySplit(i), outstanding: i.currentBalance, lockedEmiPrincipal: i.lockedEmiPrincipal, available: i.available, creditLimit: i.creditLimit }),
    ]),
  );

  // Same dedupe as `creditCardTotalsFrom`: one entry per resolved facility, every standalone card individually.
  const seen = new Set<string>();
  const parts: CreditCardViewItem[] = [];
  for (const i of items) {
    if (i.sharedLimit) {
      if (seen.has(i.sharedLimit.id)) continue;
      seen.add(i.sharedLimit.id);
    }
    parts.push(i);
  }
  const total = usageBreakdown({
    split: addSplits(parts.map(facilitySplit)),
    outstanding: parts.reduce((s, i) => s + i.currentBalance, 0),
    lockedEmiPrincipal: parts.reduce((s, i) => s + i.lockedEmiPrincipal, 0),
    available: parts.reduce((s, i) => s + i.available, 0),
    creditLimit: parts.reduce((s, i) => s + i.creditLimit, 0),
  });

  return { byCardId, ownSplitByCardId, total, financed, financedTransferTargets, billBreakdownsByCardId, transactionsByAccountId };
}

export function useCreditUsageBreakdowns(items: readonly CreditCardViewItem[]): CreditUsageBreakdowns & { isLoading: boolean } {
  const { data: transactions = [], isLoading: txLoading } = useTransactions();
  const { data: emis = [], isLoading: emisLoading } = useEmis();
  const { data: loans = [], isLoading: loansLoading } = useLoans();
  const result = useMemo(
    () => computeCreditUsageBreakdowns(items, transactions as Transaction[], emis as Emi[], loans as Loan[]),
    [items, transactions, emis, loans],
  );
  return { ...result, isLoading: txLoading || emisLoading || loansLoading };
}
