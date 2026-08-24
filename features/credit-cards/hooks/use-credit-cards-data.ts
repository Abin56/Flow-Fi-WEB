"use client";

/**
 * Composes the Credit Cards page's real data from the already-ported
 * `lib/engines/credit-utilization.ts` engine plus the live Firestore-backed
 * hooks in `hooks/use-credit-cards.ts` — replaces `lib/mock/credit-cards-data.ts`
 * as the page's data source. This file never recomputes outstanding/available/
 * utilization itself; every one of those figures comes straight out of
 * `creditCardStanding`/`sharedCreditLimitStanding`/`creditUtilizationPercent`.
 * The only work done here is projection (Firestore documents ->
 * `UtilizationStatement`/`UtilizationCard`/`UtilizationEmi` engine inputs) and
 * grouping (which cards share a `SharedCreditLimit`).
 *
 * Known, accepted gaps for this pass (documented, not silently faked):
 *  - `MockCreditCard.rewardPoints`/`cashbackEarned`/`loungeVisitsLeft` have no
 *    equivalent field anywhere in the ported `CreditCardProfile` model — this
 *    app has no rewards-ledger feature to source them from. Rather than
 *    invent numbers, every card's view model reports these as 0.
 *  - `recentTransactions`/"Recent Card Transactions" are sourced from real
 *    `Transaction`s on the card's linked `Account` (`CreditCardProfile.accountId`),
 *    labeled the same "Income"/"Expense" way `use-accounts-data.ts` does
 *    (`Transaction.categoryId` isn't resolved to a category name here for the
 *    same reason documented there), not the mock's fixed merchant/category set.
 *  - "This Month Spent" (workspace totals) sums each card's live in-progress
 *    cycle (`currentCycleSpend` from `creditCardStanding`), which is exactly
 *    what the engine defines as this month's spend — not a separate
 *    recomputation.
 *  - `network`/`issuer` on `MockCreditCard` map to `CreditCardProfile.cardNetwork`
 *    (nullable) / a plain "this card's issuer" placeholder, since the model has
 *    no separate bank/issuer-name field distinct from `SharedCreditLimit.name`
 *    or the linked `Account.bankId` — issuer is read from the linked account's
 *    `bankId` when present, else left as an em dash, never fabricated.
 *  - `CreditCardProfile` has no `isPrimary`/"default card" flag anywhere in
 *    the ported model (unlike `Account.isDefault`) — `CreditCardViewItem.isPrimary`
 *    is simply "first in list order" (a purely cosmetic, stable choice, same
 *    posture as `useAccountsOverview`'s `cardStyle` index cycling), not a
 *    real per-card setting read back from Firestore.
 */

import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  creditCardStanding,
  creditUtilizationPercent,
  sharedCreditLimitStanding,
  statementCycleView,
  type UtilizationCard,
  type UtilizationEmi,
  type UtilizationStatement,
} from "@/lib/engines/credit-utilization";
import {
  statementRemainingAmount,
  statementStatus,
  type CreditCardProfile,
  type SharedCreditLimit,
  type Statement,
} from "@/lib/models/credit-card";
import type { Emi, EmiPaymentBreakdown } from "@/lib/models/emi";
import type { Account } from "@/lib/models/account";
import type { Transaction } from "@/lib/models/transaction";
import { accountsQueryKey, useAccounts } from "@/hooks/use-accounts";
import { useTransactions } from "@/hooks/use-transactions";
import {
  creditCardsQueryKey,
  useAllCreditCardStatements,
  useAllEmiPaymentBreakdowns,
  useCreditCards,
  useEmis,
  useSharedCreditLimits,
} from "@/hooks/use-credit-cards";
import { createAccountRepository, createCreditCardRepository, createTransactionRepository } from "@/lib/repositories/repository-factory";
import { AccountHasTransactionsError } from "@/lib/repositories/account-repository";
import type { CreateCardParams, EditCardParams } from "@/lib/repositories/credit-card-repository";
import { useAuthStore } from "@/store/auth-store";
import { toast } from "@/store/toast-store";

/** Mirrors `Statement.remainingAmount`/`Statement.status` -> the engine's `UtilizationStatement` view projection. */
function toUtilizationStatement(statement: Statement): UtilizationStatement {
  return {
    id: statement.id,
    periodStart: statement.periodStart,
    periodEnd: statement.periodEnd,
    dueDate: statement.dueDate,
    totalAmount: statement.totalAmount,
    amountPaid: statement.amountPaid,
    remainingAmount: statementRemainingAmount(statement),
    isPaid: statementStatus(statement) === "paid",
  };
}

function toUtilizationCard(card: CreditCardProfile): UtilizationCard {
  return {
    id: card.id,
    statementDay: card.statementDay,
    creditLimit: card.creditLimit,
    sharedLimitId: card.sharedLimitId,
  };
}

function toUtilizationEmi(emi: Emi, principalPaidByEmiId: Map<string, number>): UtilizationEmi {
  return {
    linkedCreditCardId: emi.linkedCreditCardId,
    isClosed: emi.isClosed,
    principalAmount: emi.principalAmount,
    principalPaid: principalPaidByEmiId.get(emi.id) ?? 0,
  };
}

export interface CreditCardStandingView {
  card: CreditCardProfile;
  outstanding: number;
  available: number;
  currentCycleSpend: number;
  statements: Statement[];
  /** `creditUtilizationPercent(outstanding, effectiveLimit)` — a shared-limit card's effective
   *  limit is the pooled `SharedCreditLimit.creditLimit`, not its own (often nominal) `creditLimit`. */
  utilizationPercent: number;
}

/**
 * Every active card's engine-computed standing — shared-limit cards are
 * pooled via `sharedCreditLimitStanding` (each sibling gets the *same*
 * pooled `outstanding`/`available`, matching what `creditCardStandingProvider`
 * does for a shared-limit card in the Dart source), standalone cards via
 * plain `creditCardStanding`. This is the one function every other hook/view
 * in this file builds on — never call the engine functions again elsewhere.
 */
export function useCreditCardStandings(): { standings: CreditCardStandingView[]; isLoading: boolean } {
  const { data: cards = [], isLoading: cardsLoading } = useCreditCards();
  const { data: sharedLimits = [], isLoading: sharedLimitsLoading } = useSharedCreditLimits();
  const { data: statements = [], isLoading: statementsLoading } = useAllCreditCardStatements();
  const { data: emis = [], isLoading: emisLoading } = useEmis();
  const { data: breakdowns = [], isLoading: breakdownsLoading } = useAllEmiPaymentBreakdowns();

  const standings = useMemo(() => {
    const cardList = cards as CreditCardProfile[];
    const statementList = statements as Statement[];
    const emiList = emis as Emi[];
    const breakdownList = breakdowns as EmiPaymentBreakdown[];

    const principalPaidByEmiId = new Map<string, number>();
    // Group EmiPaymentBreakdown.principalPaid by the owning Emi. Breakdowns
    // don't carry emiId directly (only scheduleId/installmentId — see
    // lib/models/emi.ts), so this joins through Emi.scheduleId first.
    const emiIdByScheduleId = new Map(emiList.map((e) => [e.scheduleId, e.id]));
    for (const b of breakdownList) {
      const emiId = emiIdByScheduleId.get(b.scheduleId);
      if (emiId == null) continue;
      principalPaidByEmiId.set(emiId, (principalPaidByEmiId.get(emiId) ?? 0) + b.principalPaid);
    }

    const utilizationEmis = emiList.map((e) => toUtilizationEmi(e, principalPaidByEmiId));

    const statementsByCardId = new Map<string, Statement[]>();
    for (const s of statementList) {
      const list = statementsByCardId.get(s.cardId) ?? [];
      list.push(s);
      statementsByCardId.set(s.cardId, list);
    }

    const cardsBySharedLimitId = new Map<string, CreditCardProfile[]>();
    for (const c of cardList) {
      if (c.sharedLimitId == null) continue;
      const list = cardsBySharedLimitId.get(c.sharedLimitId) ?? [];
      list.push(c);
      cardsBySharedLimitId.set(c.sharedLimitId, list);
    }

    // No live "current cycle" total is computed here — that requires each
    // card's own account transactions filtered to the in-progress billing
    // window (StatementRepository.currentCycleFor). This pass only has the
    // cross-card statement list wired, so `currentCycleStatement` is passed
    // as null (matching the engine's own documented behavior for "no live
    // total available yet": currentCycleSpend from the live cycle is simply
    // 0, while every already-materialized Statement still counts in full).
    const currentCycleStatement = null;

    const sharedLimitById = new Map((sharedLimits as SharedCreditLimit[]).map((s) => [s.id, s]));
    const results: CreditCardStandingView[] = [];

    for (const card of cardList) {
      const cardStatements = (statementsByCardId.get(card.id) ?? []).map(toUtilizationStatement);
      const rawStatements = statementsByCardId.get(card.id) ?? [];

      if (card.sharedLimitId != null && sharedLimitById.has(card.sharedLimitId)) {
        const sharedLimit = sharedLimitById.get(card.sharedLimitId)!;
        const siblings = cardsBySharedLimitId.get(card.sharedLimitId) ?? [card];
        const perCard = siblings.map((sibling) => ({
          card: toUtilizationCard(sibling),
          statements: (statementsByCardId.get(sibling.id) ?? []).map(toUtilizationStatement),
          currentCycleStatement,
          emis: utilizationEmis,
        }));
        const standing = sharedCreditLimitStanding({
          sharedLimit: { id: sharedLimit.id, creditLimit: sharedLimit.creditLimit },
          perCard,
        });
        results.push({
          card,
          ...standing,
          statements: rawStatements,
          utilizationPercent: creditUtilizationPercent(standing.outstanding, sharedLimit.creditLimit),
        });
        continue;
      }

      const standing = creditCardStanding({
        card: toUtilizationCard(card),
        statements: cardStatements,
        currentCycleStatement,
        emis: utilizationEmis,
      });
      results.push({
        card,
        ...standing,
        statements: rawStatements,
        utilizationPercent: creditUtilizationPercent(standing.outstanding, card.creditLimit),
      });
    }

    return results;
  }, [cards, sharedLimits, statements, emis, breakdowns]);

  return {
    standings,
    isLoading: cardsLoading || sharedLimitsLoading || statementsLoading || emisLoading || breakdownsLoading,
  };
}

export interface CreditCardTotals {
  creditLimit: number;
  utilized: number;
  available: number;
  spentThisMonth: number;
  utilizationPercent: number;
}

/**
 * Workspace-level totals — dedupes a shared limit's creditLimit/outstanding
 * to count it exactly once (per `creditUtilizationPercent`'s own contract),
 * by summing over distinct shared-limit ids plus every standalone card,
 * rather than summing every card's `available`/`outstanding` naively (which
 * would double count a shared limit across its member cards).
 */
export function useCreditCardTotals(): { totals: CreditCardTotals; isLoading: boolean } {
  const { standings, isLoading } = useCreditCardStandings();

  const totals = useMemo(() => {
    const seenSharedLimitIds = new Set<string>();
    let creditLimit = 0;
    let utilized = 0;
    let available = 0;
    let spentThisMonth = 0;

    for (const s of standings) {
      spentThisMonth += s.currentCycleSpend;

      if (s.card.sharedLimitId != null) {
        if (seenSharedLimitIds.has(s.card.sharedLimitId)) continue;
        seenSharedLimitIds.add(s.card.sharedLimitId);
      }
      creditLimit += s.card.creditLimit;
      utilized += s.outstanding;
      available += s.available;
    }

    return {
      creditLimit,
      utilized,
      available,
      spentThisMonth,
      utilizationPercent: creditUtilizationPercent(utilized, creditLimit),
    };
  }, [standings]);

  return { totals, isLoading };
}

export interface CreditCardTransactionRow {
  id: string;
  merchant: string;
  category: string;
  amount: number;
  date: Date;
  card: CreditCardProfile;
}

/**
 * Recent transactions across every card's linked account, most-recent-first
 * — replaces the mock's per-card `recentTransactions`. See the module doc
 * comment for why `merchant`/`category` fall back to the transaction's
 * `description`/`type` rather than an invented fixed category set.
 */
export function useRecentCreditCardTransactions(limit = 6): { rows: CreditCardTransactionRow[]; isLoading: boolean } {
  const { data: cards = [], isLoading: cardsLoading } = useCreditCards();
  const { data: transactions = [], isLoading: transactionsLoading } = useTransactions();

  const rows = useMemo(() => {
    const cardList = cards as CreditCardProfile[];
    const cardByAccountId = new Map(cardList.map((c) => [c.accountId, c]));

    return (transactions as Transaction[])
      .filter((t) => t.deletedAt == null && cardByAccountId.has(t.accountId))
      .slice()
      .sort((a, b) => b.dateTime.getTime() - a.dateTime.getTime())
      .slice(0, limit)
      .map((t) => {
        const card = cardByAccountId.get(t.accountId)!;
        return {
          id: t.id,
          merchant: t.description || (t.type === "income" ? "Income" : "Expense"),
          category: t.type === "income" ? "Income" : "Expense",
          amount: t.amount,
          date: t.dateTime,
          card,
        };
      });
  }, [cards, transactions, limit]);

  return { rows, isLoading: cardsLoading || transactionsLoading };
}

/** A single card's own transactions (for the active-card spend-by-category breakdown), most-recent-first. */
export function useCardTransactions(card: CreditCardProfile | undefined): { transactions: Transaction[]; isLoading: boolean } {
  const { data: transactions = [], isLoading } = useTransactions();

  const rows = useMemo(() => {
    if (!card) return [];
    return (transactions as Transaction[])
      .filter((t) => t.deletedAt == null && t.accountId === card.accountId)
      .slice()
      .sort((a, b) => b.dateTime.getTime() - a.dateTime.getTime());
  }, [transactions, card]);

  return { transactions: rows, isLoading };
}

/** Resolves a card's linked `Account` (e.g. for `bankId`-derived issuer display). */
export function useAccountForCard(card: CreditCardProfile | undefined): Account | undefined {
  const { data: accounts = [] } = useAccounts();
  return useMemo(() => (accounts as Account[]).find((a) => a.id === card?.accountId), [accounts, card]);
}

/**
 * The Credit Cards workspace's per-card display shape — deliberately mirrors
 * `MockCreditCard` (`lib/mock/credit-cards-data.ts`) field-for-field so the
 * existing `CreditCardTile`/table/list markup keeps rendering unchanged; only
 * the source of each field moves from hardcoded mock data to a real
 * `CreditCardProfile` + its engine-computed standing. `network`/`accent` are
 * the two purely-cosmetic exceptions the module doc comment calls out.
 */
export interface CreditCardViewItem {
  id: string;
  name: string;
  issuer: string;
  network: string;
  last4: string;
  creditLimit: number;
  currentBalance: number;
  /** Engine-computed via `availableCredit()` — accounts for EMI-locked principal, unlike creditLimit - currentBalance. */
  available: number;
  /** Engine-computed via `creditUtilizationPercent()` — the shared source of truth every screen should read instead of hand-rolling outstanding/creditLimit. */
  utilizationPercent: number;
  statementDate: Date | null;
  dueDate: Date | null;
  minimumDue: number;
  isPrimary: boolean;
  accent: "primary" | "success" | "warning" | "purple" | "expense";
  rewardPoints: number;
  cashbackEarned: number;
  loungeVisitsLeft: number;
  card: CreditCardProfile;
}

/** Exported so the Add/Edit Card dialog can preview the accent a new card will actually be assigned. */
export const ACCENT_CYCLE: CreditCardViewItem["accent"][] = ["primary", "success", "warning", "purple", "expense"];

function toViewItem(
  standing: CreditCardStandingView,
  index: number,
  accountsByAccountId: Map<string, Account>,
): CreditCardViewItem {
  const { card, statements } = standing;
  const account = accountsByAccountId.get(card.accountId);

  // The two-section carry-forward view gives us the statement that's
  // actually due next — mirrors `statementCycleViewProvider`'s own
  // "previous cycle pending, else current" precedence. `currentCycleStatement`
  // is null here (see `useCreditCardStandings`'s doc comment on that same
  // gap), so "current" is never populated by this call; the nearest unpaid
  // statement is read from `previousCyclePending` instead, falling back to
  // the most recently generated statement overall when nothing is pending.
  const cycleView = statementCycleView({
    card: { id: card.id, statementDay: card.statementDay, creditLimit: card.creditLimit, sharedLimitId: card.sharedLimitId },
    statements: statements.map(toUtilizationStatement),
    currentCycleStatement: null,
  });

  // `cycleView.previousCyclePending` is engine-typed (`UtilizationStatement`,
  // no `minimumDue`) — resolve back to the raw `Statement` by id so
  // `minimumDue` (a real, not-engine-owned field) stays available for display.
  const statementsById = new Map(statements.map((s) => [s.id, s]));
  const mostRecentByDueDate = [...statements].sort((a, b) => b.dueDate.getTime() - a.dueDate.getTime())[0] ?? null;
  const pendingId = cycleView.previousCyclePending[0]?.id;
  const nextDueStatement = pendingId != null ? (statementsById.get(pendingId) ?? mostRecentByDueDate) : mostRecentByDueDate;

  return {
    id: card.id,
    name: account?.name ?? "Credit Card",
    issuer: account?.bankId ?? "—",
    network: card.cardNetwork ?? "—",
    last4: card.lastFourDigits ?? "----",
    creditLimit: card.creditLimit,
    currentBalance: standing.outstanding,
    available: standing.available,
    utilizationPercent: standing.utilizationPercent,
    statementDate: nextDueStatement ? nextDueStatement.periodEnd : null,
    dueDate: nextDueStatement ? nextDueStatement.dueDate : null,
    minimumDue: nextDueStatement?.minimumDue ?? 0,
    isPrimary: index === 0,
    accent: ACCENT_CYCLE[index % ACCENT_CYCLE.length],
    // No rewards-ledger feature exists to source these from — see module doc comment.
    rewardPoints: 0,
    cashbackEarned: 0,
    loungeVisitsLeft: 0,
    card,
  };
}

/** Every active card projected into `CreditCardViewItem` — the Credit Cards workspace's direct data source. */
export function useCreditCardViewItems(): { items: CreditCardViewItem[]; isLoading: boolean } {
  const { standings, isLoading: standingsLoading } = useCreditCardStandings();
  const { data: accounts = [], isLoading: accountsLoading } = useAccounts();

  const items = useMemo(() => {
    const accountsByAccountId = new Map((accounts as Account[]).map((a) => [a.id, a]));
    return standings.map((s, i) => toViewItem(s, i, accountsByAccountId));
  }, [standings, accounts]);

  return { items, isLoading: standingsLoading || accountsLoading };
}

export interface CreateCreditCardFormParams {
  name: string;
  creditLimit: number;
  lastFourDigits?: string | null;
  cardNetwork?: CreditCardProfile["cardNetwork"];
  statementDay: number;
  paymentDueDay: number;
}

export interface EditCreditCardFormParams {
  name?: string;
  creditLimit?: number;
  lastFourDigits?: string | null;
}

/**
 * Create/edit/delete actions wired to the real credit-card + account
 * repositories, scoped to the signed-in user. A `CreditCardProfile` is a
 * settings layer on top of an `Account` (see `lib/models/credit-card.ts`'s
 * doc comment) — one card IS one account of type `"card"` — so creating a
 * card creates both documents, and deleting a card soft-deletes both.
 */
export function useCreditCardActions() {
  const uid = useAuthStore((s) => s.user?.uid);
  const queryClient = useQueryClient();

  return useMemo(() => {
    if (!uid) return null;
    const accountRepository = createAccountRepository(uid);
    const cardRepository = createCreditCardRepository(uid);
    const transactionRepository = createTransactionRepository(uid, accountRepository);

    const invalidate = () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: creditCardsQueryKey(uid) }),
        queryClient.invalidateQueries({ queryKey: accountsQueryKey(uid) }),
      ]);

    return {
      createCard: async (params: CreateCreditCardFormParams) => {
        const account = await accountRepository.createAccount({
          name: params.name,
          type: "card",
          openingBalance: 0,
          colorValue: 0,
          accountNumberLast4: params.lastFourDigits ?? null,
        });
        const card = await cardRepository.createCard({
          accountId: account.id,
          statementDay: params.statementDay,
          paymentDueDay: params.paymentDueDay,
          creditLimit: params.creditLimit,
          cardNetwork: params.cardNetwork ?? null,
          lastFourDigits: params.lastFourDigits ?? null,
        } satisfies CreateCardParams);
        await invalidate();
        return card;
      },
      editCard: async (card: CreditCardProfile, account: Account | undefined, params: EditCreditCardFormParams) => {
        if (account && params.name != null && params.name !== account.name) {
          await accountRepository.editAccount(account, { name: params.name });
        }
        const cardParams: EditCardParams = {};
        if (params.creditLimit != null) cardParams.creditLimit = params.creditLimit;
        if (params.lastFourDigits !== undefined) cardParams.lastFourDigits = params.lastFourDigits;
        await cardRepository.editCard(card, cardParams);
        await invalidate();
      },
      deleteCard: async (card: CreditCardProfile, account: Account | undefined) => {
        try {
          if (account) {
            const count = await transactionRepository.countActiveTransactionsForAccount(account.id);
            if (count > 0) throw new AccountHasTransactionsError(count);
          }
          await cardRepository.softDelete(card);
          if (account) await accountRepository.softDelete(account);
          await invalidate();
        } catch (error) {
          if (error instanceof AccountHasTransactionsError) {
            toast.error(
              "Can't delete this card",
              `${error.count} transaction${error.count === 1 ? "" : "s"} still reference it. Move or delete ${error.count === 1 ? "it" : "them"} first.`,
            );
          } else {
            toast.error("Couldn't delete card", "Please try again.");
          }
          throw error;
        }
      },
    };
  }, [uid, queryClient]);
}

