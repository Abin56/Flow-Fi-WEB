"use client";

/**
 * Live `LoanBalanceSheet` (see `lib/engines/loan-balance-sheet.ts`) plus the Net Worth that includes
 * it — the one source every "Net Worth" / liabilities / receivables figure on Web reads from.
 */

import { useMemo } from "react";
import { useNetWorth } from "@/hooks/use-accounts";
import { useCreditCards, useEmis } from "@/hooks/use-credit-cards";
import { cardFundedLoanCardId } from "@/lib/engines/credit-utilization";
import { assignedOutstandingPrincipal, loanBalanceSheet, netWorthWithLoans, type LoanBalanceSheet } from "@/lib/engines/loan-balance-sheet";
import { assignedFuturePrincipal, personEmiObligations } from "@/lib/engines/person-emi-obligations";
import { cycleContaining } from "@/lib/engines/person-cycle-statement";
import { useMonthCycleStartDay } from "@/features/settings/hooks/use-user-preferences";
import type { Emi } from "@/lib/models/emi";
import type { Installment } from "@/lib/models/payment-schedule";
import { netWorthWithLenderCharges, unpaidLenderChargeTotal } from "@/lib/engines/lender-charge-accounting";
import { useLenderCharges } from "@/hooks/use-lender-charges";
import { outstandingPrincipalFor } from "@/lib/engines/loan-outstanding";
import { useLoanRows } from "@/features/loans/hooks/use-loans-data";
import { useEmiRows } from "@/features/emi/hooks/use-emi-data";
import { useCreditCardTotals } from "@/features/credit-cards/hooks/use-credit-cards-data";
import { usePeopleAdvanceApplications, usePeopleLedgerEntries, usePersonPositions } from "@/features/people/hooks/use-people-data";
import { breakdownEntryOf, peopleNetWorthPosition, personDirectGross, personShareRefund } from "@/lib/engines/person-position";

export function useLoanBalanceSheet(): {
  sheet: LoanBalanceSheet;
  accountBalances: number;
  /** Net Worth after unpaid lender charges (`unpaidLenderCharges`); equals the principal-only figure while none exist. */
  netWorth: number;
  /** Billed, still-unpaid lender charges across all loans and EMIs — its own liability, never part of `sheet` (principal only). */
  unpaidLenderCharges: number;
  /**
   * What I owe people directly (borrowed, unpaid shares), GROSS per person — never reduced by what the same
   * person owes me. Already inside `netWorth` via the People direct balance (receivable − payable).
   */
  peoplePayable: number;
  /** What people owe me, GROSS per person — direct ledger + open Person-linked installment shares. */
  peopleReceivable: number;
  /** Unapplied advances people paid me — cash I hold for them, inside `netWorth` but neither payable nor receivable. */
  peopleAdvanceHeld: number;
  /**
   * Principal people owe me through installments NOT yet due on a Loan/EMI I legally carry (card-funded or not) —
   * a receivable that offsets the liability in `netWorth`. Not part of `peopleReceivable` (that is what People shows
   * as owed now); it is inside `netWorth` and therefore inside the Dashboard's Assets.
   */
  assignedReceivable: number;
  /** Person-linked installment shares already due and still unpaid (inside `peopleReceivable`) — the "due now" EMI part. */
  emiDueReceivable: number;
  /** The part of the outstanding Loan/EMI principal (inside Debt) that belongs to other people, by ownership shares. */
  assignedDebt: number;
  isLoading: boolean;
  lenderChargesLoading: boolean;
} {
  const accountBalances = useNetWorth();
  const { charges: lenderCharges, isLoading: lenderChargesLoading } = useLenderCharges();
  const unpaidLenderCharges = useMemo(() => unpaidLenderChargeTotal(lenderCharges), [lenderCharges]);
  const { rows: loanRows, isLoading: loansLoading } = useLoanRows();
  const { rows: emiRows, isLoading: emisLoading } = useEmiRows();
  const { data: cards = [], isLoading: cardListLoading } = useCreditCards();
  // Card-owned EMI / card-funded Loan exposure no recorded purchase represents (Case B/C) — the same
  // figure the cards' available credit and the Reports "Credit Cards" line use.
  const { totals: cardTotals, isLoading: cardsLoading } = useCreditCardTotals();
  const { positionsByPersonId, loanIds, isLoading: peopleLoading } = usePersonPositions();
  const { entriesByPersonId } = usePeopleLedgerEntries();
  const { applicationsByPersonId } = usePeopleAdvanceApplications();
  // People part of Net Worth: direct ledger + due Person-linked installment shares, gross components
  // (F1 — a reimbursed share is cash in / receivable out, never a phantom payable; an unapplied advance
  // is held money, never a payable).
  const people = useMemo(
    () =>
      peopleNetWorthPosition(
        Object.entries(positionsByPersonId).map(([personId, position]) => ({
          position,
          entries: (entriesByPersonId[personId] ?? []).map(breakdownEntryOf),
          advanceApplications: applicationsByPersonId[personId],
        })),
        loanIds,
      ),
    [positionsByPersonId, entriesByPersonId, applicationsByPersonId, loanIds],
  );

  const cycleStartDay = useMonthCycleStartDay();
  const { data: emiList = [] } = useEmis();
  const assigned = useMemo(() => {
    const now = new Date();
    const cutoff = cycleContaining(now, cycleStartDay).end;
    const installments = [...emiRows.flatMap((r) => r.installments), ...loanRows.flatMap((r) => r.installments)] as Installment[];
    const loans = loanRows.map((r) => r.loan);
    let receivable = 0;
    let netted = 0;
    let dueOpen = 0;
    let full = 0;
    for (const personId of Object.keys(positionsByPersonId)) {
      const future = assignedFuturePrincipal(personEmiObligations({ personId, emis: emiList as Emi[], loans, installments, now }), cutoff);
      full += future;
      // A share the person already paid ahead sits in the People ledger as money I hold (counted as "to give"); its
      // upcoming principal is therefore already settled. Net Worth keeps both (they cancel); the gross figures show neither.
      const entries = (entriesByPersonId[personId] ?? []).map(breakdownEntryOf);
      const gross = personDirectGross(positionsByPersonId[personId], entries, loanIds, applicationsByPersonId[personId]);
      dueOpen += gross.emiReceivableOpen;
      const take = Math.min(future, personShareRefund(positionsByPersonId[personId], entries, loanIds, applicationsByPersonId[personId]), gross.payable);
      netted += take;
      receivable += future - take;
    }
    const debt = assignedOutstandingPrincipal([
      ...loanRows.filter((r) => r.direction === "taken").map((r) => ({ outstandingPrincipal: r.outstandingPrincipal, source: r.loan })),
      ...emiRows.map((r) => ({ outstandingPrincipal: outstandingPrincipalFor(r.emi.principalAmount, r.installments), source: r.emi })),
    ]);
    const r2 = (v: number) => Math.round(v * 100) / 100;
    return { receivable: r2(receivable), fullReceivable: r2(full), netted: r2(netted), dueOpen: r2(dueOpen), debt };
  }, [emiRows, loanRows, emiList, positionsByPersonId, entriesByPersonId, applicationsByPersonId, loanIds, cycleStartDay]);

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
    netWorth: netWorthWithLenderCharges(netWorthWithLoans(accountBalances, sheet, people.balance, assigned.fullReceivable), unpaidLenderCharges),
    unpaidLenderCharges,
    peoplePayable: Math.round((people.payable - assigned.netted) * 100) / 100,
    peopleReceivable: people.receivable,
    peopleAdvanceHeld: people.advanceHeld,
    assignedReceivable: assigned.receivable,
    emiDueReceivable: assigned.dueOpen,
    assignedDebt: assigned.debt,
    isLoading: loansLoading || emisLoading || cardsLoading || cardListLoading || peopleLoading,
    lenderChargesLoading,
  };
}
