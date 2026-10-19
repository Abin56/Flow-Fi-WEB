"use client";

/**
 * Resolves, for a list of Transactions, which Loan payments were recorded as "already paid earlier" — from the
 * structured `recordedEarlier` flag on each payment's own document (see `historical-payment.ts`).
 *
 * Only candidate transactions (Loan payments excluded from calculations) trigger a read: one `getDoc` of
 * `paymentSchedules/{scheduleId}/installments/{installmentId}/payments/{paymentId}` under the signed-in user.
 * No collection-group query, so no new index, schema or repository method. A payment document never changes its
 * `recordedEarlier` once written (an edit writes a new one that carries it over), so results are cached for good.
 */

import { useQueries } from "@tanstack/react-query";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { isHistoricalPaymentCandidate, resolveHistoricalPayment } from "@/features/loans/lib/historical-payment";
import type { Loan } from "@/lib/models/loan";
import type { Transaction } from "@/lib/models/transaction";
import { createInstallmentPaymentRepositoryFor, createInstallmentRepositoryFor } from "@/lib/repositories/repository-factory";
import { useAuthStore } from "@/store/auth-store";

export type HistoricalPaymentPredicate = (t: Transaction) => boolean;

/** Without a provider (or before any read returns) the answer falls back to the provisional description hint. */
const FALLBACK: HistoricalPaymentPredicate = (t) => resolveHistoricalPayment(t, undefined);

export function useHistoricalPaymentFlags(transactions: readonly Transaction[], loans: readonly Pick<Loan, "id" | "scheduleId">[]): HistoricalPaymentPredicate {
  const uid = useAuthStore((s) => s.user?.uid);
  const scheduleByLoan = useMemo(() => new Map(loans.map((l) => [l.id, l.scheduleId])), [loans]);

  const candidates = useMemo(() => {
    const byPayment = new Map<string, { scheduleId: string; installmentId: string; paymentId: string }>();
    for (const t of transactions) {
      if (!isHistoricalPaymentCandidate(t)) continue;
      const scheduleId = scheduleByLoan.get(t.loanId!);
      if (scheduleId) byPayment.set(t.installmentPaymentId!, { scheduleId, installmentId: t.installmentId!, paymentId: t.installmentPaymentId! });
    }
    return [...byPayment.values()];
  }, [transactions, scheduleByLoan]);

  const results = useQueries({
    queries: candidates.map((c) => ({
      queryKey: ["historicalLoanPayment", uid, c.scheduleId, c.installmentId, c.paymentId] as const,
      enabled: !!uid,
      staleTime: Infinity,
      gcTime: 30 * 60 * 1000,
      retry: 1,
      queryFn: async (): Promise<boolean> => {
        const payments = createInstallmentPaymentRepositoryFor(uid!, c.scheduleId, c.installmentId, createInstallmentRepositoryFor(uid!, c.scheduleId));
        const payment = await payments.getByKey(c.paymentId);
        // A legacy payment carries no flag → not historical. (Never inferred from the date.)
        return payment?.recordedEarlier != null;
      },
    })),
  });

  // A fixed-size dependency: one signature string of every payment's answer so far (the number of candidates varies).
  const signature = candidates.map((c, i) => `${c.paymentId}=${results[i]?.data === undefined ? "?" : results[i].data ? "1" : "0"}`).join("|");
  const flagByPayment = useMemo(() => {
    const m = new Map<string, boolean>();
    for (const part of signature.split("|")) {
      const [paymentId, answer] = part.split("=");
      if (paymentId && (answer === "1" || answer === "0")) m.set(paymentId, answer === "1");
    }
    return m;
  }, [signature]);

  return useMemo(() => (t: Transaction) => resolveHistoricalPayment(t, t.installmentPaymentId ? flagByPayment.get(t.installmentPaymentId) : undefined), [flagByPayment]);
}

const Context = createContext<HistoricalPaymentPredicate>(FALLBACK);

export function HistoricalPaymentFlagsProvider({ value, children }: { value: HistoricalPaymentPredicate; children: ReactNode }) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** The predicate for the surrounding list: structured answer where resolved, provisional hint otherwise. */
export function useIsHistoricalPayment(): HistoricalPaymentPredicate {
  return useContext(Context);
}
