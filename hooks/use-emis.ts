"use client";

/**
 * Mirrors the live-subscription pattern established by `hooks/use-accounts.ts`
 * — a live Firestore `watchAll` subscription feeding a React Query cache,
 * `staleTime: Infinity`.
 *
 * `Emi` documents themselves are already live-subscribed by `useEmis` in
 * `hooks/use-credit-cards.ts` (needed there for credit-utilization's
 * linked-EMI lookups) — reused as-is by the EMI page rather than duplicated
 * here. What's missing for a real EMI page is each EMI's own installments
 * (for remaining balance / next due date), which live in the shared
 * `paymentSchedules/{scheduleId}/installments` subcollection — this file
 * adds that one hook, via one `watchAll` per EMI's `scheduleId` fanned out
 * over `useEmis()`'s live EMI list (see the module doc comment on
 * `useAllCreditCardStatements` in `hooks/use-credit-cards.ts` for why a
 * single cross-schedule `collectionGroup` query can't be used here instead).
 */

import { useQueryClient } from "@tanstack/react-query";
import type { Installment } from "@/lib/models/payment-schedule";
import { createInstallmentRepositoryFor } from "@/lib/repositories/repository-factory";
import { useAuthStore } from "@/store/auth-store";
import { useEmis } from "./use-credit-cards";
import { useFirestoreWatch } from "./use-firestore-watch";

export function emiInstallmentsQueryKey(uid: string | undefined) {
  return ["emiInstallments", uid] as const;
}

/** Live-subscribes to every active installment across every one of the signed-in user's EMIs at once. */
export function useAllEmiInstallments() {
  const uid = useAuthStore((s) => s.user?.uid);
  const queryClient = useQueryClient();
  const { data: emis = [] } = useEmis();
  const scheduleIds = emis.map((e) => e.scheduleId).join(",");

  return useFirestoreWatch<Installment[]>({
    queryKey: emiInstallmentsQueryKey(uid),
    enabled: !!uid && !!scheduleIds,
    hookName: "useAllEmiInstallments",
    emptyValue: [],
    deps: [uid, scheduleIds, queryClient],
    subscribe: (onData, onError) => {
      if (!uid || !scheduleIds) return () => {};
      const ids = scheduleIds.split(",");
      const installmentsBySchedule = new Map<string, Installment[]>();
      let erroredOnce = false;

      const publish = () => onData(Array.from(installmentsBySchedule.values()).flat());

      const unsubscribes = ids.map((scheduleId) => {
        const repository = createInstallmentRepositoryFor(uid, scheduleId);
        return repository.watchAll(
          (installments) => {
            installmentsBySchedule.set(scheduleId, installments);
            publish();
          },
          (error) => {
            if (erroredOnce) return;
            erroredOnce = true;
            onError(error);
          },
        );
      });

      return () => unsubscribes.forEach((unsub) => unsub());
    },
  });
}
