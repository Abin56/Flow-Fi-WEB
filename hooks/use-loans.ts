"use client";

/**
 * Mirrors the live-subscription pattern established by `hooks/use-accounts.ts`
 * / `hooks/use-credit-cards.ts` — a live Firestore `watchAll` subscription
 * feeding a React Query cache, `staleTime: Infinity` — extended to the Loans
 * domain's collections: `Loan`, `Person` (the lender each loan's `personId`
 * points at — see the doc comment on `createPersonRepository` for why Loans
 * reuses the Lending feature's People collection instead of a second entity
 * type), and every loan's installments (via one `watchAll` per loan's
 * `scheduleId`, fanned out over `useLoans()`'s live loan list, same pattern
 * as `useAllCreditCardStatements` — see that hook's doc comment for why a
 * single cross-schedule `collectionGroup` query can't be used here instead).
 */

import { useQueryClient } from "@tanstack/react-query";
import type { Loan } from "@/lib/models/loan";
import type { Person } from "@/lib/models/person";
import type { Installment } from "@/lib/models/payment-schedule";
import {
  createInstallmentRepositoryFor,
  createLoanRepository,
  createPersonRepository,
} from "@/lib/repositories/repository-factory";
import { useAuthStore } from "@/store/auth-store";
import { useFirestoreWatch } from "./use-firestore-watch";

export function loansQueryKey(uid: string | undefined) {
  return ["loans", uid] as const;
}

export function loanPersonsQueryKey(uid: string | undefined) {
  return ["loanPersons", uid] as const;
}

export function loanInstallmentsQueryKey(uid: string | undefined) {
  return ["loanInstallments", uid] as const;
}

export function loansTrashQueryKey(uid: string | undefined) {
  return ["loansTrash", uid] as const;
}

/** Live-subscribes to the signed-in user's active loans. */
export function useLoans() {
  const uid = useAuthStore((s) => s.user?.uid);
  const queryClient = useQueryClient();

  return useFirestoreWatch<Loan[]>({
    queryKey: loansQueryKey(uid),
    enabled: !!uid,
    hookName: "useLoans",
    emptyValue: [],
    deps: [uid, queryClient],
    subscribe: (onData, onError) => {
      if (!uid) return () => {};
      return createLoanRepository(uid).watchAll(onData, onError);
    },
  });
}

/** Live-subscribes to the signed-in user's active people (lenders included). */
export function useLoanPersons() {
  const uid = useAuthStore((s) => s.user?.uid);
  const queryClient = useQueryClient();

  return useFirestoreWatch<Person[]>({
    queryKey: loanPersonsQueryKey(uid),
    enabled: !!uid,
    hookName: "useLoanPersons",
    emptyValue: [],
    deps: [uid, queryClient],
    subscribe: (onData, onError) => {
      if (!uid) return () => {};
      return createPersonRepository(uid).watchAll(onData, onError);
    },
  });
}

/** Live-subscribes to the signed-in user's soft-deleted loans, awaiting restore or permanent deletion. */
export function useTrashedLoans() {
  const uid = useAuthStore((s) => s.user?.uid);
  const queryClient = useQueryClient();

  return useFirestoreWatch<Loan[]>({
    queryKey: loansTrashQueryKey(uid),
    enabled: !!uid,
    hookName: "useTrashedLoans",
    emptyValue: [],
    deps: [uid, queryClient],
    subscribe: (onData, onError) => {
      if (!uid) return () => {};
      return createLoanRepository(uid).watchTrash(onData, onError);
    },
  });
}

/**
 * Live-subscribes to every active `Installment` across every one of the
 * signed-in user's loans, via one `watchAll` per loan's `scheduleId` (see
 * the module doc comment on `useAllCreditCardStatements` in
 * `hooks/use-credit-cards.ts` for why this fans out instead of using a
 * single cross-schedule `collectionGroup` query).
 */
export function useAllLoanInstallments() {
  const uid = useAuthStore((s) => s.user?.uid);
  const queryClient = useQueryClient();
  const { data: loans = [] } = useLoans();
  const scheduleIds = loans.map((l) => l.scheduleId).join(",");

  return useFirestoreWatch<Installment[]>({
    queryKey: loanInstallmentsQueryKey(uid),
    enabled: !!uid && !!scheduleIds,
    hookName: "useAllLoanInstallments",
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
