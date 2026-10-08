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
import {
  cardOwnStanding,
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
  statementWithLiveTotal,
  type CreditCardProfile,
  type SharedCreditLimit,
  type Statement,
} from "@/lib/models/credit-card";
import type { Account } from "@/lib/models/account";
import { compareTransactionsNewestFirst, type Transaction } from "@/lib/models/transaction";
import {
  cardPaymentTotal,
  settleCardPayments,
  statementPeriodTotal,
  statementWindowForDate,
  unbilledSpendForCard,
  uncoveredClosedSpendForCard,
} from "@/lib/repositories/credit-card-repository";
import { cardBillsForCard, cardStatementPaymentScope, type CardStatementPaymentScope } from "@/lib/engines/card-cycle-bills";
import { useCardUtilizationEmis } from "@/hooks/use-card-utilization-emis";
import { useAccounts } from "@/hooks/use-accounts";
import { useTransactions } from "@/hooks/use-transactions";
import {
  useAllCreditCardStatements,
  useCreditCards,
  useSharedCreditLimits,
} from "@/hooks/use-credit-cards";
import {
  createAccountRepository,
  createBillRepository,
  createCreditCardRepository,
  createEmiRepository,
  createExpenseRepository,
  createInstallmentRepositoryFor,
  createLedgerRepositoryFor,
  createPaymentScheduleRepository,
  createPersonRepository,
  createSharedCreditLimitRepository,
  createTransactionRepository,
} from "@/lib/repositories/repository-factory";
import type { CreateCardParams, EditCardParams } from "@/lib/repositories/credit-card-repository";
import {
  permanentlyDeleteCreditCardAndHistory,
  previewCreditCardDeletionImpact,
  type CreditCardDeletionImpact,
  type CreditCardDeletionRepos,
} from "@/lib/repositories/credit-card-deletion";
import { useAuthStore } from "@/store/auth-store";
import { toast } from "@/store/toast-store";

export type { CreditCardDeletionImpact };

/**
 * The engine's `UtilizationStatement` view of `statement`, with its total recomputed LIVE from the
 * card account's current transactions (`statementPeriodTotal`) — the materialized `totalAmount` is a
 * snapshot that goes stale when a transaction inside the period is later deleted/edited/restored.
 * Mirrors Flutter's `statementsWithLiveTotalsProvider`. This is also what makes a deleted linked
 * purchase (card-EMI Case C) actually leave the card's liability.
 */
/** Stored-snapshot projection — only for picking which statement is due next (display), never for
 *  exposure or available-credit totals, which must use `toLiveUtilizationStatement`. */
function toSnapshotUtilizationStatement(statement: Statement): UtilizationStatement {
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

/** An unsaved closed bill (see `uncoveredClosedSpendForCard`) in `Statement` shape — same id scheme as
 *  `cardBillsForCard`'s derived bills. Never written; exists only so payments settle it oldest first. */
function derivedStatement(card: CreditCardProfile, w: { periodStart: Date; periodEnd: Date; dueDate: Date; totalAmount: number }): Statement {
  return {
    id: `derived:${card.id}:${w.periodEnd.getTime()}`,
    cardId: card.id,
    periodStart: w.periodStart,
    periodEnd: w.periodEnd,
    generatedDate: w.periodEnd,
    dueDate: w.dueDate,
    totalAmount: w.totalAmount,
    minimumDue: card.minimumDuePercent == null ? null : (Math.max(w.totalAmount, 0) * card.minimumDuePercent) / 100,
    amountPaid: 0,
    interestCharged: null,
    lateFee: null,
    createdAt: w.periodEnd,
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
  } as Statement;
}

export function toLiveUtilizationStatement(statement: Statement, cardTransactions: Transaction[]): UtilizationStatement {
  const liveTotal = statementPeriodTotal(cardTransactions, statement);
  const live = statementWithLiveTotal(statement, liveTotal, statement.minimumDue);
  return {
    id: live.id,
    periodStart: live.periodStart,
    periodEnd: live.periodEnd,
    dueDate: live.dueDate,
    totalAmount: live.totalAmount,
    amountPaid: live.amountPaid,
    remainingAmount: statementRemainingAmount(live),
    isPaid: statementStatus(live) === "paid",
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

/** The facility a card draws from, resolved — `null` for a standalone card or unresolvable metadata. */
export interface SharedLimitView {
  id: string;
  name: string;
  /** `SharedCreditLimit.creditLimit` — the ONE limit every member card draws from. */
  creditLimit: number;
  /** Every card under this facility (this card included), in list order. */
  memberCardIds: string[];
}

export interface CreditCardStandingView {
  card: CreditCardProfile;
  /** Facility-wide for a shared-limit card (identical on every sibling); the card's own otherwise. */
  outstanding: number;
  available: number;
  currentCycleSpend: number;
  /** Card-linked EMI principal still locked against the limit — the card owns this liability. */
  lockedEmiPrincipal: number;
  statements: Statement[];
  /** `creditUtilizationPercent(outstanding + lockedEmiPrincipal, effectiveLimit)` — exposure, so
   *  utilization and `available` add up to the limit. A shared-limit card's effective limit is the
   *  pooled `SharedCreditLimit.creditLimit`, not its own (often nominal) `creditLimit`. */
  utilizationPercent: number;
  /** The limit this card actually draws from — `SharedCreditLimit.creditLimit` for a shared card. */
  effectiveCreditLimit: number;
  /** This physical card's own usage (its statements + unbilled spend) — equals `outstanding` when standalone. */
  ownOutstanding: number;
  /** What Pay bill settles for this PHYSICAL card: its closed statements' remaining (oldest first), with
   *  the open cycle's spend reported separately — never the card's or facility's whole outstanding. */
  statementPayment: CardStatementPaymentScope;
  sharedLimit: SharedLimitView | null;
}

/** A facility doc usable for pooling — anything else falls back to standalone so no debt is hidden. */
function isUsableSharedLimit(s: SharedCreditLimit | undefined): s is SharedCreditLimit {
  return s != null && s.deletedAt == null && Number.isFinite(s.creditLimit) && s.creditLimit > 0;
}

/**
 * Every card's engine-computed standing — the pure core of `useCreditCardStandings`. Shared-limit cards
 * are pooled via `sharedCreditLimitStanding` (every sibling gets the *same* facility `outstanding`/
 * `available`, matching Flutter's `creditCardStandingProvider` delegating to
 * `sharedCreditLimitStandingProvider`); standalone cards via plain `creditCardStanding`. A card whose
 * `sharedLimitId` points at a missing/trashed/malformed facility is treated as standalone — Flutter
 * would report ₹0 there, which hides real card debt, so Web keeps counting it.
 */
export function computeCreditCardStandings(input: {
  cards: CreditCardProfile[];
  sharedLimits: SharedCreditLimit[];
  statements: Statement[];
  transactions: Transaction[];
  utilizationEmis: UtilizationEmi[];
  now?: Date;
}): CreditCardStandingView[] {
  const { cards: cardList, statements: statementList, transactions: transactionList, utilizationEmis } = input;
  const now = input.now ?? new Date();

  const transactionsByAccountId = new Map<string, Transaction[]>();
  for (const t of transactionList) {
    if (t.deletedAt != null) continue;
    const list = transactionsByAccountId.get(t.accountId) ?? [];
    list.push(t);
    transactionsByAccountId.set(t.accountId, list);
  }

  const statementsByCardId = new Map<string, Statement[]>();
  for (const s of statementList) {
    // A trashed statement covers nothing — its spend falls back to uncovered/unbilled (same as `cardBillsForCard`).
    if (s.deletedAt != null) continue;
    const list = statementsByCardId.get(s.cardId) ?? [];
    list.push(s);
    statementsByCardId.set(s.cardId, list);
  }

  /**
   * Every card's statements (live totals) and not-yet-billed spend since its most recent statement
   * (or all-time, if it has none), with the card's bill payments (transfers into the card account)
   * reconciled against them — oldest statement first, then the unbilled spend. Always per PHYSICAL
   * card: a bill payment into one card's account settles that card's own statements only.
   */
  const settledByCardId = new Map(
    cardList.map((c) => {
      const cardTransactions = transactionsByAccountId.get(c.accountId) ?? [];
      const cardStatements = statementsByCardId.get(c.id) ?? [];
      const openCycleStart = statementWindowForDate(c, now).periodStart;
      const unbilled = unbilledSpendForCard(cardTransactions, cardStatements, openCycleStart);
      const live = cardStatements.map((s) =>
        statementWithLiveTotal(s, statementPeriodTotal(cardTransactions, s), s.minimumDue),
      );
      // Closed cycles no stored statement covers (before the first one / gaps) — unsaved bills, still owed.
      const derived = uncoveredClosedSpendForCard(c, cardTransactions, cardStatements, now).map((w) => derivedStatement(c, w));
      const settled = settleCardPayments([...live, ...derived], unbilled.totalAmount, cardPaymentTotal(cardTransactions));
      return [c.id, { statements: settled.statements, currentCycle: { ...unbilled, totalAmount: settled.unbilledTotal } }] as const;
    }),
  );
  const currentCycleByCardId = new Map([...settledByCardId].map(([id, s]) => [id, s.currentCycle]));
  const utilizationStatementsFor = (cardId: string) =>
    (settledByCardId.get(cardId)?.statements ?? []).map(toSnapshotUtilizationStatement);

  const sharedLimitById = new Map(input.sharedLimits.map((s) => [s.id, s]));
  const resolvedSharedLimit = (card: CreditCardProfile) => {
    if (card.sharedLimitId == null) return undefined;
    const s = sharedLimitById.get(card.sharedLimitId);
    return isUsableSharedLimit(s) ? s : undefined;
  };

  const cardsBySharedLimitId = new Map<string, CreditCardProfile[]>();
  for (const c of cardList) {
    const s = resolvedSharedLimit(c);
    if (s == null) continue;
    cardsBySharedLimitId.set(s.id, [...(cardsBySharedLimitId.get(s.id) ?? []), c]);
  }

  return cardList.map((card): CreditCardStandingView => {
    const cardStatements = utilizationStatementsFor(card.id);
    const rawStatements = settledByCardId.get(card.id)?.statements ?? [];
    const statementPayment = cardStatementPaymentScope(
      cardBillsForCard(card, transactionsByAccountId.get(card.accountId) ?? [], statementsByCardId.get(card.id) ?? [], now),
      now,
    );
    const own = cardOwnStanding(toUtilizationCard(card), cardStatements, currentCycleByCardId.get(card.id) ?? null);
    const sharedLimit = resolvedSharedLimit(card);

    if (sharedLimit != null) {
      const siblings = cardsBySharedLimitId.get(sharedLimit.id) ?? [card];
      const standing = sharedCreditLimitStanding({
        sharedLimit: { id: sharedLimit.id, creditLimit: sharedLimit.creditLimit },
        perCard: siblings.map((sibling) => ({
          card: toUtilizationCard(sibling),
          statements: utilizationStatementsFor(sibling.id),
          currentCycleStatement: currentCycleByCardId.get(sibling.id) ?? null,
          emis: utilizationEmis,
        })),
      });
      return {
        card,
        ...standing,
        statements: rawStatements,
        utilizationPercent: creditUtilizationPercent(standing.outstanding + standing.lockedEmiPrincipal, sharedLimit.creditLimit),
        effectiveCreditLimit: sharedLimit.creditLimit,
        ownOutstanding: own.outstanding,
        statementPayment,
        sharedLimit: {
          id: sharedLimit.id,
          name: sharedLimit.name,
          creditLimit: sharedLimit.creditLimit,
          memberCardIds: siblings.map((s) => s.id),
        },
      };
    }

    const standing = creditCardStanding({
      card: toUtilizationCard(card),
      statements: cardStatements,
      currentCycleStatement: currentCycleByCardId.get(card.id) ?? null,
      emis: utilizationEmis,
    });
    return {
      card,
      ...standing,
      statements: rawStatements,
      utilizationPercent: creditUtilizationPercent(standing.outstanding + standing.lockedEmiPrincipal, card.creditLimit),
      effectiveCreditLimit: card.creditLimit,
      ownOutstanding: own.outstanding,
      statementPayment,
      sharedLimit: null,
    };
  });
}

/**
 * Every active card's engine-computed standing — see `computeCreditCardStandings`. This is the one
 * function every other hook/view in this file builds on — never call the engine functions again elsewhere.
 */
export function useCreditCardStandings(): { standings: CreditCardStandingView[]; isLoading: boolean } {
  const { data: cards = [], isLoading: cardsLoading } = useCreditCards();
  const { data: sharedLimits = [], isLoading: sharedLimitsLoading } = useSharedCreditLimits();
  const { data: statements = [], isLoading: statementsLoading } = useAllCreditCardStatements();
  const { utilizationEmis, isLoading: emisLoading } = useCardUtilizationEmis();
  const { data: transactions = [], isLoading: transactionsLoading } = useTransactions();

  const standings = useMemo(
    () =>
      computeCreditCardStandings({
        cards: cards as CreditCardProfile[],
        sharedLimits: sharedLimits as SharedCreditLimit[],
        statements: statements as Statement[],
        transactions: transactions as Transaction[],
        utilizationEmis,
      }),
    [cards, sharedLimits, statements, utilizationEmis, transactions],
  );

  return {
    standings,
    isLoading:
      cardsLoading || sharedLimitsLoading || statementsLoading || emisLoading || transactionsLoading,
  };
}

export interface CreditCardTotals {
  creditLimit: number;
  /** Statement/card-account outstanding only (what gets billed). */
  utilized: number;
  /**
   * Credit in use = `utilized + lockedEmiPrincipal` — the same exposure `utilizationPercent` and
   * `available` already use, so Used + Available = Limit. A card-linked EMI with no recorded purchase
   * (Case B/C) is in here through its lock, never as a purchase transaction.
   */
  usedCredit: number;
  /** Card-linked EMI principal still locked (deduped for shared limits) — card-owned liability, Decision 3. */
  lockedEmiPrincipal: number;
  available: number;
  spentThisMonth: number;
  utilizationPercent: number;
}

/**
 * Totals across cards, counting a resolved shared facility exactly once — its `SharedCreditLimit.creditLimit`,
 * pooled outstanding, lock and available — and every standalone card individually. Mirrors Flutter's
 * `_sumStandingAcrossCards` + `totalCreditLimitProvider`. Dedupe keys on the RESOLVED facility only: cards
 * whose `sharedLimitId` dangles are standalone in `computeCreditCardStandings`, so each still counts.
 */
export function creditCardTotalsFrom(standings: readonly CreditCardStandingView[]): CreditCardTotals {
  const seenSharedLimitIds = new Set<string>();
  let creditLimit = 0;
  let utilized = 0;
  let lockedEmiPrincipal = 0;
  let available = 0;
  let spentThisMonth = 0;

  for (const s of standings) {
    if (s.sharedLimit != null) {
      if (seenSharedLimitIds.has(s.sharedLimit.id)) continue;
      seenSharedLimitIds.add(s.sharedLimit.id);
    }
    // currentCycleSpend is pooled on a shared card too — counted once per facility like the rest.
    spentThisMonth += s.currentCycleSpend;
    creditLimit += s.effectiveCreditLimit;
    utilized += s.outstanding;
    lockedEmiPrincipal += s.lockedEmiPrincipal;
    available += s.available;
  }

  return {
    creditLimit,
    utilized,
    usedCredit: utilized + lockedEmiPrincipal,
    lockedEmiPrincipal,
    available,
    spentThisMonth,
    // Exposure (statement outstanding + locked card-EMI principal), matching `available`.
    utilizationPercent: creditUtilizationPercent(utilized + lockedEmiPrincipal, creditLimit),
  };
}

/** Workspace-level totals — see `creditCardTotalsFrom`. */
export function useCreditCardTotals(): { totals: CreditCardTotals; isLoading: boolean } {
  const { standings, isLoading } = useCreditCardStandings();
  const totals = useMemo(() => creditCardTotalsFrom(standings), [standings]);
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
      .sort(compareTransactionsNewestFirst)
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
      .sort(compareTransactionsNewestFirst);
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
  /** The limit this card draws from — the facility's `SharedCreditLimit.creditLimit` for a shared card. */
  creditLimit: number;
  /** Card-account outstanding (statement liability) — what gets billed. Facility-wide for a shared card. */
  currentBalance: number;
  /** Card-linked EMI principal still locked against this card's limit (engine `lockedEmiPrincipal`). */
  lockedEmiPrincipal: number;
  /** Credit in use = `currentBalance + lockedEmiPrincipal` — pairs with `available` / `utilizationPercent`. */
  usedCredit: number;
  /** Engine-computed via `availableCredit()` — accounts for EMI-locked principal, unlike creditLimit - currentBalance. */
  available: number;
  /** Engine-computed via `creditUtilizationPercent()` — the shared source of truth every screen should read instead of hand-rolling outstanding/creditLimit. */
  utilizationPercent: number;
  statementDate: Date | null;
  dueDate: Date | null;
  /** The current bill's issuer minimum — only a stored statement carries one; null = not tracked. */
  minimumDue: number | null;
  isPrimary: boolean;
  accent: CardAccent;
  rewardPoints: number;
  cashbackEarned: number;
  loungeVisitsLeft: number;
  /** This physical card's own usage — differs from `currentBalance` only for a shared-limit card. */
  ownUsage: number;
  /** Pay bill's scope — closed statements due vs the open cycle's spend (see `CreditCardStandingView`). */
  statementPayment: CardStatementPaymentScope;
  /** The facility this card shares its limit with, plus its sibling cards' display identity. */
  sharedLimit: (SharedLimitView & { siblings: { id: string; name: string; last4: string; network: string }[] }) | null;
  card: CreditCardProfile;
}

export type CardAccent = "primary" | "success" | "warning" | "purple" | "expense" | "teal" | "orange" | "gold" | "rose" | "sky" | "emerald" | "violet" | "slate" | "bronze" | "magenta" | "navy";

/** Exported so the Add/Edit Card dialog can preview the accent a new card will actually be assigned. */
export const ACCENT_CYCLE: CardAccent[] = ["primary", "success", "warning", "purple", "expense"];

/** Every user-pickable card colour, in picker order. */
export const CARD_ACCENTS: CardAccent[] = ["primary", "purple", "teal", "success", "gold", "orange", "expense", "warning", "rose", "sky", "emerald", "violet", "slate", "bronze", "magenta", "navy"];

/** The card account's `colorValue` stores the picked colour as `CARD_ACCENTS` index + 1; 0 (legacy / never
 *  picked) keeps the old list-position colour so existing cards don't all change look. */
export function colorValueForCardAccent(accent: CardAccent | null): number {
  return accent == null ? 0 : CARD_ACCENTS.indexOf(accent) + 1;
}

export function pickedCardAccent(colorValue: number | undefined): CardAccent | null {
  return colorValue != null && colorValue > 0 ? (CARD_ACCENTS[colorValue - 1] ?? null) : null;
}

function toViewItem(
  standing: CreditCardStandingView,
  index: number,
  accountsByAccountId: Map<string, Account>,
  cardsById: Map<string, CreditCardProfile>,
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
    statements: statements.map(toSnapshotUtilizationStatement),
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
    creditLimit: standing.effectiveCreditLimit,
    currentBalance: standing.outstanding,
    lockedEmiPrincipal: standing.lockedEmiPrincipal,
    usedCredit: standing.outstanding + standing.lockedEmiPrincipal,
    available: standing.available,
    utilizationPercent: standing.utilizationPercent,
    // The bill Pay Now targets (stored OR derived — most cycles have no stored statement) wins; the
    // stored-statement fallback only applies when nothing closed is unpaid.
    statementDate: standing.statementPayment.current?.periodEnd ?? (nextDueStatement ? nextDueStatement.periodEnd : null),
    dueDate: standing.statementPayment.current?.dueDate ?? (nextDueStatement ? nextDueStatement.dueDate : null),
    minimumDue: standing.statementPayment.current ? standing.statementPayment.current.minimumDue : null,
    isPrimary: index === 0,
    accent: pickedCardAccent(account?.colorValue) ?? ACCENT_CYCLE[index % ACCENT_CYCLE.length],
    // No rewards-ledger feature exists to source these from — see module doc comment.
    rewardPoints: 0,
    cashbackEarned: 0,
    loungeVisitsLeft: 0,
    ownUsage: standing.ownOutstanding,
    statementPayment: standing.statementPayment,
    sharedLimit:
      standing.sharedLimit == null
        ? null
        : {
            ...standing.sharedLimit,
            siblings: standing.sharedLimit.memberCardIds
              .filter((id) => id !== card.id)
              .map((id) => cardsById.get(id))
              .filter((c): c is CreditCardProfile => c != null)
              .map((c) => ({
                id: c.id,
                name: accountsByAccountId.get(c.accountId)?.name ?? "Credit Card",
                last4: c.lastFourDigits ?? "----",
                network: c.cardNetwork ?? "—",
              })),
          },
    card,
  };
}

/** Every active card projected into `CreditCardViewItem` — the Credit Cards workspace's direct data source. */
export function useCreditCardViewItems(): { items: CreditCardViewItem[]; isLoading: boolean } {
  const { standings, isLoading: standingsLoading } = useCreditCardStandings();
  const { data: accounts = [], isLoading: accountsLoading } = useAccounts();

  const items = useMemo(() => {
    const accountsByAccountId = new Map((accounts as Account[]).map((a) => [a.id, a]));
    const cardsById = new Map(standings.map((s) => [s.card.id, s.card]));
    return standings.map((s, i) => toViewItem(s, i, accountsByAccountId, cardsById));
  }, [standings, accounts]);

  return { items, isLoading: standingsLoading || accountsLoading };
}

export interface CreateCreditCardFormParams {
  name: string;
  cardHolderName: string;
  creditLimit: number;
  lastFourDigits: string;
  cardNetwork?: CreditCardProfile["cardNetwork"];
  statementDay: number;
  paymentDueDay: number;
  bankId?: string | null;
  sharedLimitId?: string | null;
  colorValue?: number;
}

export interface EditCreditCardFormParams {
  colorValue?: number;
  name?: string;
  cardHolderName?: string | null;
  creditLimit?: number;
  lastFourDigits?: string | null;
  cardNetwork?: CreditCardProfile["cardNetwork"];
  statementDay?: number;
  paymentDueDay?: number;
  bankId?: string | null;
  sharedLimitId?: string | null;
  clearSharedLimitId?: boolean;
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

  return useMemo(() => {
    if (!uid) return null;
    const accountRepository = createAccountRepository(uid);
    const sharedCreditLimitRepository = createSharedCreditLimitRepository(uid);
    const cardRepository = createCreditCardRepository(uid, sharedCreditLimitRepository);
    const transactionRepository = createTransactionRepository(uid, accountRepository);
    const billRepository = createBillRepository(uid);
    const expenseRepository = createExpenseRepository(uid, accountRepository);
    const personRepository = createPersonRepository(uid);
    const paymentScheduleRepository = createPaymentScheduleRepository(uid);
    const emiRepository = createEmiRepository(uid);

    const deletionRepos: CreditCardDeletionRepos = {
      uid,
      transactionRepository,
      accountRepository,
      billRepository,
      expenseRepository,
      personRepository,
      ledgerRepositoryFor: (personId) => createLedgerRepositoryFor(uid, personId, personRepository),
      paymentScheduleRepository,
      installmentRepositoryFor: (scheduleId) => createInstallmentRepositoryFor(uid, scheduleId),
      creditCardRepository: cardRepository,
      sharedCreditLimitRepository,
      emiRepository,
    };

    return {
      createSharedLimit: async (params: { name: string; creditLimit: number }) => {
        return sharedCreditLimitRepository.createSharedLimit(params);
      },
      createCard: async (params: CreateCreditCardFormParams) => {
        const account = await accountRepository.createAccount({
          name: params.name,
          type: "card",
          openingBalance: 0,
          colorValue: params.colorValue ?? 0,
          accountHolderName: params.cardHolderName,
          accountNumberLast4: params.lastFourDigits,
          bankId: params.bankId ?? null,
          cardSubtype: "credit",
        });
        const card = await cardRepository.createCard({
          accountId: account.id,
          statementDay: params.statementDay,
          paymentDueDay: params.paymentDueDay,
          creditLimit: params.creditLimit,
          cardNetwork: params.cardNetwork ?? null,
          cardHolderName: params.cardHolderName,
          lastFourDigits: params.lastFourDigits,
          sharedLimitId: params.sharedLimitId ?? null,
        } satisfies CreateCardParams);
        return card;
      },
      editCard: async (card: CreditCardProfile, account: Account | undefined, params: EditCreditCardFormParams) => {
        const nameChanged = params.name != null && params.name !== account?.name;
        const bankChanged = params.bankId !== undefined && params.bankId !== (account?.bankId ?? null);
        const holderChanged = params.cardHolderName !== undefined && params.cardHolderName !== (account?.accountHolderName ?? null);
        // createCard writes last-4 on both documents — keep the account's copy in step on edit.
        const last4Changed = params.lastFourDigits != null && params.lastFourDigits !== (account?.accountNumberLast4 ?? null);
        const colorChanged = params.colorValue != null && params.colorValue !== account?.colorValue;
        if (account && (nameChanged || bankChanged || holderChanged || last4Changed || colorChanged)) {
          await accountRepository.editAccount(account, {
            ...(params.name != null ? { name: params.name } : {}),
            ...(bankChanged ? { bankId: params.bankId, clearBankId: params.bankId == null } : {}),
            ...(holderChanged ? { accountHolderName: params.cardHolderName } : {}),
            ...(last4Changed ? { accountNumberLast4: params.lastFourDigits } : {}),
            ...(colorChanged ? { colorValue: params.colorValue } : {}),
          });
        }
        const cardParams: EditCardParams = {};
        if (params.creditLimit != null) cardParams.creditLimit = params.creditLimit;
        if (params.lastFourDigits !== undefined) cardParams.lastFourDigits = params.lastFourDigits;
        // Mirrors Flutter's editCard: network and the card's own bill/due days are editable per physical card.
        if (params.cardNetwork != null) cardParams.cardNetwork = params.cardNetwork;
        if (params.statementDay != null) cardParams.statementDay = params.statementDay;
        if (params.paymentDueDay != null) cardParams.paymentDueDay = params.paymentDueDay;

        if (params.cardHolderName !== undefined) cardParams.cardHolderName = params.cardHolderName;
        if (params.clearSharedLimitId) cardParams.clearSharedLimitId = true;
        else if (params.sharedLimitId !== undefined) cardParams.sharedLimitId = params.sharedLimitId;
        await cardRepository.editCard(card, cardParams);
      },
      /** Read-only impact preview for the type-to-confirm delete dialog — call before `deleteCard`. */
      previewCardDeletion: (card: CreditCardProfile) => previewCreditCardDeletionImpact(card, deletionRepos),
      /** PERMANENTLY deletes `card`, its linked `Account`, and their entire history — linked EMIs,
       *  statements, an orphaned shared limit, transactions, bills, and split-expense ledger
       *  effects (see `lib/repositories/credit-card-deletion.ts`). Only ever reached after the
       *  destructive-delete dialog's type-to-confirm gate. */
      deleteCard: async (card: CreditCardProfile) => {
        try {
          await permanentlyDeleteCreditCardAndHistory(card, deletionRepos);
        } catch (error) {
          toast.error("Couldn't delete card", "Please try again.");
          throw error;
        }
      },
    };
  }, [uid]);
}

