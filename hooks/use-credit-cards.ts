"use client";

/**
 * Mirrors the live-subscription pattern established by `hooks/use-accounts.ts`
 * — a live Firestore `watchAll` subscription feeding a React Query cache,
 * `staleTime: Infinity` — extended to the Credit Cards domain's four
 * collections: `CreditCardProfile`, `SharedCreditLimit`, `Emi`, and
 * `Statement` (the last via a cross-card `collectionGroup` query, since
 * statements live in a per-card `creditCards/{cardId}/statements`
 * subcollection rather than one flat uid-scoped collection).
 */

import { useQueryClient } from "@tanstack/react-query";
import type { CreditCardProfile, SharedCreditLimit, Statement } from "@/lib/models/credit-card";
import type { Emi, EmiPaymentBreakdown } from "@/lib/models/emi";
import {
  createCreditCardRepository,
  createEmiPaymentBreakdownRepository,
  createEmiRepository,
  createSharedCreditLimitRepository,
  createStatementRepository,
} from "@/lib/repositories/repository-factory";
import { useAuthStore } from "@/store/auth-store";
import { useFirestoreWatch } from "./use-firestore-watch";

export function creditCardsQueryKey(uid: string | undefined) {
  return ["creditCards", uid] as const;
}

export function sharedCreditLimitsQueryKey(uid: string | undefined) {
  return ["sharedCreditLimits", uid] as const;
}

export function emisQueryKey(uid: string | undefined) {
  return ["emis", uid] as const;
}

export function creditCardStatementsQueryKey(uid: string | undefined) {
  return ["creditCardStatements", uid] as const;
}

export function emiPaymentBreakdownsQueryKey(uid: string | undefined) {
  return ["emiPaymentBreakdowns", uid] as const;
}

/** Live-subscribes to the signed-in user's active credit card profiles. */
export function useCreditCards() {
  const uid = useAuthStore((s) => s.user?.uid);
  const queryClient = useQueryClient();

  return useFirestoreWatch<CreditCardProfile[]>({
    queryKey: creditCardsQueryKey(uid),
    enabled: !!uid,
    hookName: "useCreditCards",
    emptyValue: [],
    deps: [uid, queryClient],
    subscribe: (onData, onError) => {
      if (!uid) return () => {};
      return createCreditCardRepository(uid).watchAll(onData, onError);
    },
  });
}

/** Live-subscribes to the signed-in user's active shared credit limits. */
export function useSharedCreditLimits() {
  const uid = useAuthStore((s) => s.user?.uid);
  const queryClient = useQueryClient();

  return useFirestoreWatch<SharedCreditLimit[]>({
    queryKey: sharedCreditLimitsQueryKey(uid),
    enabled: !!uid,
    hookName: "useSharedCreditLimits",
    emptyValue: [],
    deps: [uid, queryClient],
    subscribe: (onData, onError) => {
      if (!uid) return () => {};
      return createSharedCreditLimitRepository(uid).watchAll(onData, onError);
    },
  });
}

/** Live-subscribes to the signed-in user's active EMIs (needed for credit-utilization's linked-EMI lookups). */
export function useEmis() {
  const uid = useAuthStore((s) => s.user?.uid);
  const queryClient = useQueryClient();

  return useFirestoreWatch<Emi[]>({
    queryKey: emisQueryKey(uid),
    enabled: !!uid,
    hookName: "useEmis",
    emptyValue: [],
    deps: [uid, queryClient],
    subscribe: (onData, onError) => {
      if (!uid) return () => {};
      return createEmiRepository(uid).watchAll(onData, onError);
    },
  });
}

/**
 * Live-subscribes to every active `Statement` across every one of the
 * signed-in user's credit cards, via one `watchAll` per card (fanned out
 * over `useCreditCards()`'s live card list) rather than a single
 * `collectionGroup` query. A `collectionGroup` `list` query cannot be scoped
 * to the signed-in user's own documents by Firestore security rules —
 * `statements`/`paymentBreakdowns` documents carry no `uid` field of their
 * own, and path-based rules (`{path=**}/statements/{id}`) are only usable
 * for single-document `get` reads, not `list` queries, confirmed against the
 * Firestore Rules emulator (`FirebaseError: Variable is not bound in path
 * template. for 'list'`). Per-card `watchAll` (via `StatementRepository`,
 * same as every other per-user collection here) stays within the existing
 * `users/{uid}/creditCards/{document=**}` rule, which already covers this
 * subcollection for normal (non-collection-group) reads.
 */
export function useAllCreditCardStatements() {
  const uid = useAuthStore((s) => s.user?.uid);
  const queryClient = useQueryClient();
  const { data: cards = [] } = useCreditCards();
  const cardIds = cards.map((c) => c.id).join(",");

  return useFirestoreWatch<Statement[]>({
    queryKey: creditCardStatementsQueryKey(uid),
    enabled: !!uid && !!cardIds,
    hookName: "useAllCreditCardStatements",
    emptyValue: [],
    deps: [uid, cardIds, queryClient],
    subscribe: (onData, onError) => {
      if (!uid || !cardIds) return () => {};
      const ids = cardIds.split(",");
      const statementsByCard = new Map<string, Statement[]>();
      let erroredOnce = false;

      const publish = () => onData(Array.from(statementsByCard.values()).flat());

      const unsubscribes = ids.map((cardId) => {
        const repository = createStatementRepository(uid, cardId);
        return repository.watchAll(
          (statements) => {
            statementsByCard.set(cardId, statements);
            publish();
          },
          (error) => {
            // One card's listener failing shouldn't be reported N times if
            // several fail together — surfaced once, same as a single-listener hook.
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

/**
 * Live-subscribes to every active `EmiPaymentBreakdown` across every EMI —
 * feeds `UtilizationEmi.principalPaid` (see the module doc comment on
 * `useAllCreditCardStatements` for why this fans out one `watchAll` per EMI
 * instead of a single `collectionGroup` query).
 */
export function useAllEmiPaymentBreakdowns() {
  const uid = useAuthStore((s) => s.user?.uid);
  const queryClient = useQueryClient();
  const { data: emis = [] } = useEmis();
  const emiIds = emis.map((e) => e.id).join(",");

  return useFirestoreWatch<EmiPaymentBreakdown[]>({
    queryKey: emiPaymentBreakdownsQueryKey(uid),
    enabled: !!uid && !!emiIds,
    hookName: "useAllEmiPaymentBreakdowns",
    emptyValue: [],
    deps: [uid, emiIds, queryClient],
    subscribe: (onData, onError) => {
      if (!uid || !emiIds) return () => {};
      const ids = emiIds.split(",");
      const breakdownsByEmi = new Map<string, EmiPaymentBreakdown[]>();
      let erroredOnce = false;

      const publish = () => onData(Array.from(breakdownsByEmi.values()).flat());

      const unsubscribes = ids.map((emiId) => {
        const repository = createEmiPaymentBreakdownRepository(uid, emiId);
        return repository.watchAll(
          (breakdowns) => {
            breakdownsByEmi.set(emiId, breakdowns);
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
