"use client";

/**
 * The `UtilizationEmi[]` every credit-card standing on Web is computed from — built ONCE here so the
 * Credit Cards page, the Dashboard, Reports and Net Worth can never disagree about which card-linked
 * EMI principal is locked. Two rules, both identical to Flutter:
 *  - ownership: an EMI whose `purchaseTransactionId` purchase is still represented on its card
 *    (`emiPurchaseRepresentedOnCard`) does not lock credit (Case A); otherwise it does (B/C);
 *  - principal restored: per payment, its breakdown's `principalPaid`, else its principal share
 *    (`emiPrincipalRestored`) — reads payments only for open card-linked EMIs' paid installments.
 * Borrowed Loans financed on a card (`cardFundedLoanCardId`) are the same obligation and join this list
 * (`cardFundedLoanUtilization`): they lock their outstanding principal on the card (Cases B/C) or not at
 * all while their linked purchase is represented (Case A) — again identical to Flutter.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  cardFundedLoanCardId,
  cardFundedLoanUtilization,
  emiPrincipalRestored,
  emiPurchaseRepresentedOnCard,
  type UtilizationEmi,
} from "@/lib/engines/credit-utilization";
import type { CreditCardProfile } from "@/lib/models/credit-card";
import type { Emi, EmiPaymentBreakdown } from "@/lib/models/emi";
import type { Installment, InstallmentPayment } from "@/lib/models/payment-schedule";
import type { Transaction } from "@/lib/models/transaction";
import { createInstallmentPaymentRepositoryFor, createInstallmentRepositoryFor } from "@/lib/repositories/repository-factory";
import { useAuthStore } from "@/store/auth-store";
import { useLoanRows } from "@/features/loans/hooks/use-loans-data";
import { useAllEmiPaymentBreakdowns, useCreditCards, useEmis } from "./use-credit-cards";
import { useAllEmiInstallments } from "./use-emis";
import { useTransactions } from "./use-transactions";

export function useCardUtilizationEmis(): { utilizationEmis: UtilizationEmi[]; isLoading: boolean } {
  const uid = useAuthStore((s) => s.user?.uid);
  const { data: emis = [], isLoading: emisLoading } = useEmis();
  const { data: cards = [], isLoading: cardsLoading } = useCreditCards();
  const { data: breakdowns = [], isLoading: breakdownsLoading } = useAllEmiPaymentBreakdowns();
  const { data: installments = [], isLoading: installmentsLoading } = useAllEmiInstallments();
  const { data: transactions = [], isLoading: transactionsLoading } = useTransactions();
  const { rows: loanRows, isLoading: loansLoading } = useLoanRows();

  const linkedOpen = useMemo(() => (emis as Emi[]).filter((e) => e.linkedCreditCardId != null && !e.isClosed), [emis]);
  const paidLinkedInstallments = useMemo(() => {
    const schedules = new Set(linkedOpen.map((e) => e.scheduleId));
    return (installments as Installment[]).filter((i) => schedules.has(i.scheduleId) && i.amountPaid > 0);
  }, [linkedOpen, installments]);
  const fingerprint = paidLinkedInstallments.map((i) => `${i.scheduleId}:${i.id}:${i.amountPaid}`).sort().join(",");

  const paymentsQuery = useQuery({
    queryKey: ["cardLinkedEmiPayments", uid, fingerprint],
    enabled: !!uid && paidLinkedInstallments.length > 0,
    staleTime: Infinity,
    placeholderData: (previous) => previous,
    queryFn: async (): Promise<InstallmentPayment[]> => {
      if (!uid) return [];
      const perInstallment = await Promise.all(
        paidLinkedInstallments.map((i) =>
          createInstallmentPaymentRepositoryFor(uid, i.scheduleId, i.id, createInstallmentRepositoryFor(uid, i.scheduleId)).getAll(),
        ),
      );
      return perInstallment.flat();
    },
  });
  const payments = useMemo(() => (paidLinkedInstallments.length === 0 ? [] : (paymentsQuery.data ?? [])), [paidLinkedInstallments, paymentsQuery.data]);

  const utilizationEmis = useMemo(() => {
    const cardById = new Map((cards as CreditCardProfile[]).map((c) => [c.id, c]));
    const activeTransactionById = new Map((transactions as Transaction[]).filter((t) => t.deletedAt == null).map((t) => [t.id, t]));
    const breakdownPrincipalByPaymentId = new Map((breakdowns as EmiPaymentBreakdown[]).map((b) => [b.paymentId, b.principalPaid]));
    const emiEntries = (emis as Emi[]).map((emi): UtilizationEmi => {
      const card = emi.linkedCreditCardId != null ? cardById.get(emi.linkedCreditCardId) : undefined;
      const emiInstallments = (installments as Installment[]).filter((i) => i.scheduleId === emi.scheduleId);
      const installmentIds = new Set(emiInstallments.map((i) => i.id));
      return {
        linkedCreditCardId: emi.linkedCreditCardId,
        isClosed: emi.isClosed,
        principalAmount: emi.principalAmount,
        principalPaid:
          card == null || emi.isClosed
            ? 0
            : emiPrincipalRestored(emiInstallments, payments.filter((p) => p.scheduleId === emi.scheduleId && installmentIds.has(p.installmentId)), breakdownPrincipalByPaymentId),
        purchaseRepresented:
          card != null &&
          emiPurchaseRepresentedOnCard(emi.purchaseTransactionId, activeTransactionById.get(emi.purchaseTransactionId ?? ""), card.accountId),
      };
    });
    const loanEntries: UtilizationEmi[] = [];
    for (const row of loanRows) {
      const cardId = cardFundedLoanCardId(row.loan);
      const card = cardId != null ? cardById.get(cardId) : undefined;
      if (cardId == null || card == null) continue;
      loanEntries.push(
        cardFundedLoanUtilization({
          linkedCreditCardId: cardId,
          isClosed: row.loan.isClosed,
          loanAmount: row.loan.loanAmount,
          outstandingPrincipal: row.outstandingPrincipal,
          purchaseRepresented: emiPurchaseRepresentedOnCard(
            row.loan.purchaseTransactionId ?? null,
            activeTransactionById.get(row.loan.purchaseTransactionId ?? ""),
            card.accountId,
          ),
        }),
      );
    }
    return [...emiEntries, ...loanEntries];
  }, [emis, cards, transactions, breakdowns, installments, payments, loanRows]);

  return {
    utilizationEmis,
    isLoading: emisLoading || cardsLoading || loansLoading || breakdownsLoading || installmentsLoading || transactionsLoading || (paidLinkedInstallments.length > 0 && paymentsQuery.isLoading),
  };
}
