"use client";

/**
 * Live-subscribes to the signed-in user's SMS transaction candidate review
 * queue — `users/{uid}/smsTransactionCandidates`, written entirely by
 * Android. Flat (no parent document). Read-only; mirrors
 * `use-document-import-records.ts`'s onSnapshot + React Query cache pattern.
 *
 * Ordered by `transactionDate desc` — this collection has no `smsTimestamp`
 * field (unlike the earlier, incorrect web-only model this replaces); Android
 * only ever syncs currently-pending candidates, so `createdAt` and
 * `transactionDate` order very similarly in practice, and `transactionDate`
 * is the more useful sort for a reviewer (most recent transaction first).
 */

import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { collection, onSnapshot, orderBy, query } from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import { FirestoreCollections } from "@/lib/firestore/collections";
import { smsTransactionCandidateFromFirestore, type SmsTransactionCandidate } from "@/lib/models/sms-transaction-candidate";
import { useAuthStore } from "@/store/auth-store";
import { retryFirestoreWatch, useFirestoreWatch } from "./use-firestore-watch";

export function smsTransactionCandidatesQueryKey(uid: string | undefined) {
  return ["smsTransactionCandidates", uid] as const;
}

/** Cache entry that flips to `true` when the first snapshot has arrived — `useFirestoreWatch` resolves `[]` before that, so it can't be told apart from "really empty" by the candidates query alone. */
export function smsTransactionCandidatesSyncedQueryKey(uid: string | undefined) {
  return ["smsTransactionCandidates", "synced", uid] as const;
}

/** Cache entry holding how many documents in the latest snapshot could not be read (malformed) and were left out of the list. */
export function smsTransactionCandidatesUnreadableQueryKey(uid: string | undefined) {
  return ["smsTransactionCandidates", "unreadable", uid] as const;
}

/**
 * Retry after a listener error: clears the error state (so the UI goes back to loading, and shows the
 * error again only if the listener fails again), then forces the shared watcher to resubscribe.
 */
export function retrySmsTransactionCandidates(queryClient: QueryClient, uid: string | undefined) {
  const queryKey = smsTransactionCandidatesQueryKey(uid);
  queryClient.getQueryCache().find({ queryKey })?.setState({ status: "success", error: null, fetchStatus: "idle" });
  retryFirestoreWatch(queryKey);
}

/** Live-subscribes to the signed-in user's SMS candidates, most recent transaction first. `hasSnapshot` is true once the first Firestore snapshot has arrived. */
export function useSmsTransactionCandidates() {
  const uid = useAuthStore((s) => s.user?.uid);
  const queryClient = useQueryClient();

  const { data: hasSnapshot = false } = useQuery<boolean>({
    queryKey: smsTransactionCandidatesSyncedQueryKey(uid),
    queryFn: () => Promise.resolve(false),
    enabled: !!uid,
    staleTime: Infinity,
    initialData: false,
  });

  const { data: unreadableCount = 0 } = useQuery<number>({
    queryKey: smsTransactionCandidatesUnreadableQueryKey(uid),
    queryFn: () => Promise.resolve(0),
    enabled: !!uid,
    staleTime: Infinity,
    initialData: 0,
  });

  const result = useFirestoreWatch<SmsTransactionCandidate[]>({
    queryKey: smsTransactionCandidatesQueryKey(uid),
    enabled: !!uid,
    hookName: "useSmsTransactionCandidates",
    emptyValue: [],
    deps: [uid, queryClient],
    subscribe: (onData, onError) => {
      if (!uid) return () => {};
      const ref = collection(db, FirestoreCollections.users, uid, FirestoreCollections.smsTransactionCandidates);
      const q = query(ref, orderBy("transactionDate", "desc"));
      return onSnapshot(
        q,
        (snapshot) => {
          // One malformed document (e.g. missing/invalid `direction` — see
          // smsTransactionCandidateFromFirestore's guard) must not blank out
          // every other, valid candidate in the list. Skipped and logged
          // rather than thrown past this callback, which `onSnapshot` has no
          // built-in recovery for.
          const candidates: SmsTransactionCandidate[] = [];
          let unreadable = 0;
          for (const d of snapshot.docs) {
            try {
              candidates.push(smsTransactionCandidateFromFirestore(d));
            } catch (error) {
              unreadable += 1;
              console.error(`useSmsTransactionCandidates: skipping malformed candidate ${d.id}:`, error);
            }
          }
          onData(candidates);
          queryClient.setQueryData(smsTransactionCandidatesUnreadableQueryKey(uid), unreadable);
          queryClient.setQueryData(smsTransactionCandidatesSyncedQueryKey(uid), true);
        },
        onError,
      );
    },
  });

  return { ...result, hasSnapshot, unreadableCount, retry: () => retrySmsTransactionCandidates(queryClient, uid) };
}
