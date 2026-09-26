"use client";

import { useMemo } from "react";
import { useAllEmiInstallments } from "@/hooks/use-emis";
import { useAllLoanInstallments, useLoans } from "@/hooks/use-loans";
import { useCreditCards, useEmis } from "@/hooks/use-credit-cards";
import { useTransactions } from "@/hooks/use-transactions";
import { emiToUnifiedAgreement, loanToUnifiedAgreement, sortUnifiedAgreements } from "@/lib/models/unified-finance-agreement";

/** Additive, read-only live view over Loans + EMIs. It never calls a write repository. */
export function useUnifiedFinanceAgreements() {
  const loans = useLoans();
  const emis = useEmis();
  const loanInstallments = useAllLoanInstallments();
  const emiInstallments = useAllEmiInstallments();
  const cards = useCreditCards();
  const transactions = useTransactions();

  const agreements = useMemo(() => {
    const cardById = new Map((cards.data ?? []).map((card) => [card.id, card]));
    const transactionById = new Map((transactions.data ?? []).map((transaction) => [transaction.id, transaction]));
    return sortUnifiedAgreements([
      ...(loans.data ?? []).map((loan) => {
        const card = loan.linkedCreditCardId ? cardById.get(loan.linkedCreditCardId) : undefined;
        return loanToUnifiedAgreement(
          loan,
          (loanInstallments.data ?? []).filter((item) => item.scheduleId === loan.scheduleId),
          card == null ? null : { cardAccountId: card.accountId, purchase: transactionById.get(loan.purchaseTransactionId ?? "") },
        );
      }),
      ...(emis.data ?? []).map((emi) => {
        const card = emi.linkedCreditCardId ? cardById.get(emi.linkedCreditCardId) : undefined;
        return emiToUnifiedAgreement(
          emi,
          (emiInstallments.data ?? []).filter((item) => item.scheduleId === emi.scheduleId),
          card == null ? null : { cardAccountId: card.accountId, purchase: transactionById.get(emi.purchaseTransactionId ?? "") },
        );
      }),
    ]);
  }, [loans.data, emis.data, loanInstallments.data, emiInstallments.data, cards.data, transactions.data]);

  return {
    data: agreements,
    isLoading: loans.isLoading || emis.isLoading || loanInstallments.isLoading || emiInstallments.isLoading || cards.isLoading || transactions.isLoading,
    error: loans.error ?? emis.error ?? loanInstallments.error ?? emiInstallments.error ?? cards.error ?? transactions.error,
  };
}
