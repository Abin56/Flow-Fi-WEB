"use client";

/**
 * Debt Planner data — REAL DATA → the normalized current-debt snapshot, built once per data change from
 * the same live hooks every other screen reads (Loan & EMI rows, card standings, People positions, Month
 * Cycle). Every figure is an existing engine's output; this hook only projects records into
 * `buildDebtSnapshot`'s inputs (`lib/engines/debt-position.ts`). It never writes.
 *
 * SIMULATION is separate (`useDebtPlan`): pure in-memory runs of `lib/engines/debt-payoff.ts` over the
 * snapshot, so changing the budget / strategy / extra amount re-plans immediately with no Firestore reads
 * or writes and can never change a real balance.
 */

import { useDeferredValue, useMemo } from "react";
import { useCreditCards, useSharedCreditLimits } from "@/hooks/use-credit-cards";
import { useAccounts } from "@/hooks/use-accounts";
import { useLoanBalanceSheet } from "@/hooks/use-loan-balance-sheet";
import { usePeople } from "@/hooks/use-people";
import { useTransactions } from "@/hooks/use-transactions";
import { useExpenseInstallmentsBySchedule, useExpenses } from "@/hooks/use-expenses";
import { resolveOwnership } from "@/lib/engines/debt-ownership";
import { remainingAmount, type Installment } from "@/lib/models/payment-schedule";
import type { Expense } from "@/lib/models/expense";
import { useCreditCardStandings, useCreditCardTotals, type CreditCardStandingView } from "@/features/credit-cards/hooks/use-credit-cards-data";
import { useEmiRows } from "@/features/emi/hooks/use-emi-data";
import { useLoanRows } from "@/features/loans/hooks/use-loans-data";
import { useMonthCycleData } from "@/features/month-cycle/hooks/use-month-cycle-data";
import { usePersonPositions } from "@/features/people/hooks/use-people-data";
import { cardFundedLoanCardId, emiPurchaseRepresentedOnCard } from "@/lib/engines/credit-utilization";
import {
  budgetScenarios,
  extraPaymentImpact,
  requiredThisPeriod,
  simulatePayoff,
  type PayoffInput,
  type PayoffStrategy,
} from "@/lib/engines/debt-payoff";
import {
  buildDebtSnapshot,
  cardPurchaseShares,
  personDirectPayable,
  type CardPurchaseShare,
  type CardFacilityInput,
  type DebtSnapshot,
  type EmiDebtInput,
  type LoanDebtInput,
  type PersonDebtInput,
} from "@/lib/engines/debt-position";
import { liabilityTotals } from "@/lib/engines/loan-balance-sheet";
import { outstandingPrincipalFor } from "@/lib/engines/loan-outstanding";
import type { Account } from "@/lib/models/account";
import type { CreditCardProfile, SharedCreditLimit } from "@/lib/models/credit-card";
import type { Person } from "@/lib/models/person";
import type { Transaction } from "@/lib/models/transaction";

function cardName(card: CreditCardProfile, account: Account | undefined): string {
  return account?.name?.trim() || `Card •••• ${card.lastFourDigits ?? ""}`.trim();
}

/** One facility per standalone card, one per shared limit (its standing is pooled across its cards). */
function cardFacilities(standings: CreditCardStandingView[], sharedLimits: SharedCreditLimit[], accounts: Account[]): CardFacilityInput[] {
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const sharedById = new Map(sharedLimits.map((s) => [s.id, s]));
  const groups = new Map<string, CreditCardStandingView[]>();
  for (const s of standings) {
    const key = s.card.sharedLimitId != null && sharedById.has(s.card.sharedLimitId) ? `shared:${s.card.sharedLimitId}` : s.card.id;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  return [...groups.entries()].map(([key, members]) => {
    const first = members[0];
    const shared = key.startsWith("shared:") ? sharedById.get(first.card.sharedLimitId!) : undefined;
    const pcts = new Set(members.map((m) => m.card.minimumDuePercent));
    return {
      id: shared ? shared.id : first.card.id,
      name: shared ? shared.name : cardName(first.card, accountById.get(first.card.accountId)),
      cardIds: members.map((m) => m.card.id),
      // A shared limit's standing is already pooled — every sibling carries the same figures.
      outstanding: first.outstanding,
      lockedEmiPrincipal: first.lockedEmiPrincipal,
      creditLimit: shared ? shared.creditLimit : first.card.creditLimit,
      available: first.available,
      utilizationPercent: first.utilizationPercent,
      statements: members.flatMap((m) =>
        m.statements.map((s) => ({ id: s.id, dueDate: s.dueDate, totalAmount: s.totalAmount, amountPaid: s.amountPaid, minimumDue: s.minimumDue })),
      ),
      minimumDuePercent: pcts.size === 1 ? first.card.minimumDuePercent : null,
      statedInterestRatePercent: members.find((m) => m.card.interestRatePercent != null)?.card.interestRatePercent ?? null,
    };
  });
}

/**
 * Every split/assigned share of a purchase charged to a tracked card, still not received back — linked
 * only by IDs: Expense.transactionId → Transaction.accountId === card.accountId, and each participant's
 * own settlement Installment (`participant.installmentId`). "Excluded" shares are the user's own intent
 * not to collect, so they stay mine.
 */
function purchaseSharesByFacility(
  facilities: readonly CardFacilityInput[],
  cardById: ReadonlyMap<string, CreditCardProfile>,
  activeTransactionById: ReadonlyMap<string, Transaction>,
  expenses: readonly Expense[],
  installmentsByScheduleId: Record<string, Installment[]>,
  personNames: Readonly<Record<string, string>>,
): CardPurchaseShare[] {
  const facilityByAccount = new Map<string, string>();
  for (const f of facilities) for (const cardId of f.cardIds) {
    const card = cardById.get(cardId);
    if (card) facilityByAccount.set(card.accountId, f.id);
  }
  const result: CardPurchaseShare[] = [];
  for (const e of expenses) {
    if (e.deletedAt != null || e.scheduleId == null) continue;
    const tx = activeTransactionById.get(e.transactionId);
    const facilityId = tx ? facilityByAccount.get(tx.accountId) : undefined;
    if (!tx || tx.excludeFromCalculations || facilityId == null) continue;
    const installments = installmentsByScheduleId[e.scheduleId] ?? [];
    for (const part of e.participants) {
      if (part.isMe || part.personId == null || part.installmentId == null || part.receivedStatus === "excluded") continue;
      const inst = installments.find((i) => i.id === part.installmentId && i.deletedAt == null);
      if (!inst) continue;
      const unrecovered = remainingAmount(inst);
      if (unrecovered <= 0) continue;
      result.push({ facilityId, personId: part.personId, name: personNames[part.personId] ?? part.name, unrecovered, dueDate: inst.dueDate });
    }
  }
  return result;
}

export interface DebtReconciliation {
  /** Net Worth's liability total (`liabilityTotals`, Reports' figure) — cards + Loan/EMI principal. */
  balanceSheetDebt: number;
  /** What I owe people directly (People ledger) — not part of `liabilityTotals`. */
  peopleDirect: number;
  expected: number;
  matches: boolean;
}

export interface CycleAffordability {
  label: string;
  income: number;
  /** Everything already paid this cycle, debt payments included (Month Cycle's "Total spent"). */
  spent: number;
  /** Bills still unpaid this cycle. */
  billsDue: number;
  /** Debt payments still required this cycle (the planner's own figure). */
  debtDue: number;
  remaining: number;
}

export function useDebtPlannerData(): {
  snapshot: DebtSnapshot;
  reconciliation: DebtReconciliation;
  affordability: CycleAffordability;
  required: ReturnType<typeof requiredThisPeriod>;
  monthCycleStartDay: number;
  now: Date;
  isLoading: boolean;
} {
  const { rows: loanRows, isLoading: loansLoading } = useLoanRows();
  const { rows: emiRows, isLoading: emisLoading } = useEmiRows();
  const { standings, isLoading: standingsLoading } = useCreditCardStandings();
  const { totals: cardTotals, isLoading: cardTotalsLoading } = useCreditCardTotals();
  const { data: cards = [], isLoading: cardsLoading } = useCreditCards();
  const { data: sharedLimits = [] } = useSharedCreditLimits();
  const { data: accounts = [] } = useAccounts();
  const { data: transactions = [], isLoading: transactionsLoading } = useTransactions();
  const { data: people = [], isLoading: peopleLoading } = usePeople();
  const { positionsByPersonId, isLoading: positionsLoading } = usePersonPositions();
  const { sheet, isLoading: sheetLoading } = useLoanBalanceSheet();
  const { data: expenses = [], isLoading: expensesLoading } = useExpenses();
  const { installmentsByScheduleId, isLoading: expenseInstallmentsLoading } = useExpenseInstallmentsBySchedule();
  const monthCycle = useMonthCycleData();
  const now = monthCycle.now;
  const monthCycleStartDay = monthCycle.monthCycleStartDay;

  const snapshot = useMemo(() => {
    const cardById = new Map((cards as CreditCardProfile[]).map((c) => [c.id, c]));
    const activeTransactionById = new Map((transactions as Transaction[]).filter((t) => t.deletedAt == null).map((t) => [t.id, t]));
    const represented = (purchaseTransactionId: string | null | undefined, card: CreditCardProfile | undefined) =>
      card != null && emiPurchaseRepresentedOnCard(purchaseTransactionId, activeTransactionById.get(purchaseTransactionId ?? ""), card.accountId);

    const loans: LoanDebtInput[] = loanRows.map((r) => {
      const cardId = cardFundedLoanCardId(r.loan);
      const card = cardId != null ? cardById.get(cardId) : undefined;
      return {
        id: r.loan.id,
        name: r.loan.name ?? null,
        lenderName: r.lenderName,
        direction: r.direction,
        category: r.category,
        personId: r.loan.personId,
        isClosed: r.loan.isClosed,
        loanAmount: r.loan.loanAmount,
        interest: r.loan.interest,
        repaymentType: r.loan.repaymentType,
        installmentFrequency: r.loan.installmentFrequency,
        loanType: r.loan.loanType,
        installments: r.installments,
        outstandingPrincipal: r.outstandingPrincipal,
        ownedByCardId: card ? card.id : null,
        purchaseRepresented: represented(r.loan.purchaseTransactionId, card),
        ownershipShares: r.direction === "taken" ? resolveOwnership(r.loan, r.loan.loanAmount) : undefined,
      };
    });
    const emis: EmiDebtInput[] = emiRows.map((r) => ({
      id: r.emi.id,
      name: r.emi.name,
      lenderName: r.emi.lenderName,
      isClosed: r.emi.isClosed,
      isDefaulted: r.emi.isDefaulted,
      principalAmount: r.emi.principalAmount,
      interest: r.emi.interest,
      installmentFrequency: r.emi.installmentFrequency,
      installments: r.installments,
      // Principal only — the same figure the balance sheet uses (`useLoanBalanceSheet`).
      outstandingPrincipal: outstandingPrincipalFor(r.emi.principalAmount, r.installments),
      ownedByCardId: r.linkedCard ? r.linkedCard.id : null,
      purchaseRepresented: represented(r.emi.purchaseTransactionId, r.linkedCard),
      ownershipShares: resolveOwnership(r.emi, r.emi.principalAmount),
    }));
    const peopleInputs: PersonDebtInput[] = (people as Person[])
      .filter((p) => positionsByPersonId[p.id] != null)
      .map((p) => {
        const pos = positionsByPersonId[p.id];
        return { personId: p.id, name: p.name, directBalance: pos.directBalance, emiReceivable: pos.emiReceivable, loanReceivable: pos.loanReceivable, loanPayable: pos.loanPayable };
      });
    const facilities = cardFacilities(standings, sharedLimits as SharedCreditLimit[], accounts as Account[]);
    const personNames = Object.fromEntries((people as Person[]).map((p) => [p.id, p.name]));
    const shares = purchaseSharesByFacility(facilities, cardById, activeTransactionById, expenses as Expense[], installmentsByScheduleId, personNames);
    // Per person, only what they still owe me directly (net) can be attributed to card purchases.
    const recoverable = Object.fromEntries(Object.entries(positionsByPersonId).map(([id, pos]) => [id, Math.max(pos.directBalance, 0)]));
    const byFacility = cardPurchaseShares(shares, recoverable);
    return buildDebtSnapshot({
      loans,
      emis,
      cards: facilities.map((f) => ({ ...f, purchaseShares: byFacility[f.id] ?? [] })),
      people: peopleInputs,
      personNames,
      now,
    });
  }, [loanRows, emiRows, standings, sharedLimits, accounts, cards, transactions, people, positionsByPersonId, expenses, installmentsByScheduleId, now]);

  const reconciliation = useMemo((): DebtReconciliation => {
    const balanceSheetDebt = liabilityTotals(sheet, cardTotals.utilized).total;
    const peopleDirect = Object.entries(positionsByPersonId).reduce(
      (s, [personId, p]) => s + personDirectPayable({ personId, name: "", ...p }),
      0,
    );
    const expected = Math.round((balanceSheetDebt + peopleDirect) * 100) / 100;
    return { balanceSheetDebt, peopleDirect, expected, matches: Math.abs(expected - snapshot.total) < 1 };
  }, [sheet, cardTotals.utilized, positionsByPersonId, snapshot.total]);

  const required = useMemo(() => requiredThisPeriod(snapshot.positions, monthCycleStartDay, now), [snapshot.positions, monthCycleStartDay, now]);

  const affordability = useMemo((): CycleAffordability => {
    // Month Cycle is browsed from its own current cycle here (the planner never shifts it).
    const income = monthCycle.financialView.income;
    const spent = monthCycle.financialView.spent;
    const billsDue = monthCycle.bills.total;
    return {
      label: monthCycle.monthLabel,
      income,
      spent,
      billsDue,
      debtDue: required.total,
      remaining: Math.round((income - spent - billsDue - required.total) * 100) / 100,
    };
  }, [monthCycle.financialView.income, monthCycle.financialView.spent, monthCycle.bills.total, monthCycle.monthLabel, required.total]);

  return {
    snapshot,
    reconciliation,
    affordability,
    required,
    monthCycleStartDay,
    now,
    isLoading:
      loansLoading || emisLoading || expensesLoading || expenseInstallmentsLoading || standingsLoading || cardTotalsLoading || cardsLoading || transactionsLoading || peopleLoading || positionsLoading || sheetLoading || monthCycle.isLoading,
  };
}

export interface DebtPlanSettings {
  monthlyBudget: number;
  strategy: PayoffStrategy;
  customOrder: string[];
  extraAmount: number;
  /** Null = follow the strategy. */
  extraTargetId: string | null;
}

/**
 * SIMULATION — every run is pure and in memory. Inputs are deferred so typing a budget never blocks the
 * page while a long schedule re-plans.
 */
export function useDebtPlan(snapshot: DebtSnapshot, settings: DebtPlanSettings, monthCycleStartDay: number, now: Date) {
  const deferred = useDeferredValue(settings);
  const base: PayoffInput = useMemo(
    () => ({
      positions: snapshot.positions,
      monthlyBudget: deferred.monthlyBudget,
      strategy: deferred.strategy,
      customOrder: deferred.customOrder,
      monthCycleStartDay,
      now,
    }),
    [snapshot.positions, deferred.monthlyBudget, deferred.strategy, deferred.customOrder, monthCycleStartDay, now],
  );

  const plan = useMemo(() => simulatePayoff(base), [base]);
  const impact = useMemo(
    () => (deferred.extraAmount > 0 ? extraPaymentImpact(base, deferred.extraAmount, deferred.extraTargetId) : null),
    [base, deferred.extraAmount, deferred.extraTargetId],
  );
  const scenarios = useMemo(() => {
    const req = requiredThisPeriod(snapshot.positions, monthCycleStartDay, now).total;
    const budget = deferred.monthlyBudget;
    const round500 = (v: number) => Math.round(v / 500) * 500;
    // Exactly required, a lower and two higher budgets around the chosen one, and the chosen one itself.
    const candidates = [round500(budget * 0.6), req, budget, round500(budget * 1.5), round500(budget * 2)];
    const unique = [...new Set(candidates.map((b) => Math.round(b * 100) / 100))].filter((b) => b > 0).sort((a, b) => a - b);
    return budgetScenarios(base, unique);
  }, [base, snapshot.positions, monthCycleStartDay, now, deferred.monthlyBudget]);

  return { plan, impact, scenarios, isStale: deferred !== settings };
}
