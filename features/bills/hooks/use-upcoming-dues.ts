"use client";

/**
 * Live inputs for `computeUpcomingDues` (see `lib/engines/upcoming-dues.ts` for the counting rules).
 * Read-only composition of existing watchers — it never writes, and never creates a Bill,
 * Transaction or Person to represent a due:
 *  - Credit Card dues: each card's Statements with live totals (`toLiveUtilizationStatement`, the
 *    exact view the card's available credit is computed from).
 *  - Loan dues: `useLoanRows` installments (borrowed Loans only — enforced in the engine).
 *  - EMI dues: `useEmiRows` installments.
 *  - Card ownership: `emiPurchaseRepresentedOnCard`, the same predicate card utilization, Net Worth
 *    and the unified agreements adapter use.
 */

import { useMemo } from "react";
import { useAccounts } from "@/hooks/use-accounts";
import { useAllCreditCardStatements, useCreditCards } from "@/hooks/use-credit-cards";
import { useTransactions } from "@/hooks/use-transactions";
import { emiPurchaseRepresentedOnCard } from "@/lib/engines/credit-utilization";
import { computeUpcomingDues, type DueAgreementInput, type DueStatementInput, type UpcomingDues } from "@/lib/engines/upcoming-dues";
import type { Account } from "@/lib/models/account";
import type { CreditCardProfile, Statement } from "@/lib/models/credit-card";
import type { Transaction } from "@/lib/models/transaction";
import { toLiveUtilizationStatement } from "@/features/credit-cards/hooks/use-credit-cards-data";
import { useEmiRows } from "@/features/emi/hooks/use-emi-data";
import { useLoanRows } from "@/features/loans/hooks/use-loans-data";

export const UPCOMING_DUES_HORIZON_DAYS = 30;

export function useUpcomingDues(): UpcomingDues & { isLoading: boolean } {
  const { rows: loanRows, isLoading: loansLoading } = useLoanRows();
  const { rows: emiRows, isLoading: emisLoading } = useEmiRows();
  const { data: cards = [], isLoading: cardsLoading } = useCreditCards();
  const { data: statements = [], isLoading: statementsLoading } = useAllCreditCardStatements();
  const { data: transactions = [], isLoading: transactionsLoading } = useTransactions();
  const { data: accounts = [], isLoading: accountsLoading } = useAccounts();

  const dues = useMemo(() => {
    const accountById = new Map((accounts as Account[]).map((a) => [a.id, a]));
    const cardList = cards as CreditCardProfile[];
    const cardById = new Map(cardList.map((c) => [c.id, c]));
    const cardLabel = (card: CreditCardProfile) => {
      const name = accountById.get(card.accountId)?.name ?? "Credit Card";
      return card.lastFourDigits ? `${name} ••${card.lastFourDigits}` : name;
    };

    const activeTransactions = (transactions as Transaction[]).filter((t) => t.deletedAt == null);
    const transactionById = new Map(activeTransactions.map((t) => [t.id, t]));
    const transactionsByAccountId = new Map<string, Transaction[]>();
    for (const t of activeTransactions) {
      const list = transactionsByAccountId.get(t.accountId) ?? [];
      list.push(t);
      transactionsByAccountId.set(t.accountId, list);
    }

    const statementInputs: DueStatementInput[] = [];
    for (const statement of statements as Statement[]) {
      const card = cardById.get(statement.cardId);
      if (!card) continue;
      const live = toLiveUtilizationStatement(statement, transactionsByAccountId.get(card.accountId) ?? []);
      statementInputs.push({
        cardId: card.id,
        cardLabel: cardLabel(card),
        statementId: statement.id,
        dueDate: live.dueDate,
        remainingAmount: live.remainingAmount,
        isPaid: live.isPaid,
      });
    }

    /** Label + Case A flag for a Loan/EMI's linked card — only when that card is tracked in FlowFi. */
    const cardLink = (linkedCreditCardId: string | null | undefined, purchaseTransactionId: string | null | undefined) => {
      const card = linkedCreditCardId ? cardById.get(linkedCreditCardId) : undefined;
      if (!card) return { linkedCardLabel: null, purchaseRepresentedOnCard: false };
      return {
        linkedCardLabel: cardLabel(card),
        purchaseRepresentedOnCard: emiPurchaseRepresentedOnCard(
          purchaseTransactionId ?? null,
          transactionById.get(purchaseTransactionId ?? ""),
          card.accountId,
        ),
      };
    };

    const agreementInputs: DueAgreementInput[] = [
      ...loanRows.map(
        (row): DueAgreementInput => ({
          source: "loan",
          id: row.loan.id,
          title: row.loan.name?.trim() || row.lenderName,
          providerName: row.lenderName,
          borrowed: row.direction === "taken",
          isClosed: row.loan.isClosed,
          installments: row.installments,
          ...cardLink(row.loan.linkedCreditCardId, row.loan.purchaseTransactionId),
          forPersonName: row.beneficiaryPersonId ? (row.beneficiaryName ?? "someone else") : null,
        }),
      ),
      ...emiRows.map(
        (row): DueAgreementInput => ({
          source: "emi",
          id: row.emi.id,
          title: row.emi.name,
          providerName: row.emi.lenderName,
          borrowed: true,
          isClosed: row.emi.isClosed,
          installments: row.installments,
          ...cardLink(row.emi.linkedCreditCardId, row.emi.purchaseTransactionId),
          forPersonName: row.emi.beneficiaryPersonId ? (row.beneficiaryName ?? "someone else") : null,
        }),
      ),
    ];

    return computeUpcomingDues({ statements: statementInputs, agreements: agreementInputs, horizonDays: UPCOMING_DUES_HORIZON_DAYS });
  }, [loanRows, emiRows, cards, statements, transactions, accounts]);

  return {
    ...dues,
    isLoading: loansLoading || emisLoading || cardsLoading || statementsLoading || transactionsLoading || accountsLoading,
  };
}
