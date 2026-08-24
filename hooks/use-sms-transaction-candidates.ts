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

import { useQueryClient } from "@tanstack/react-query";
import { collection, onSnapshot, orderBy, query } from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import { FirestoreCollections } from "@/lib/firestore/collections";
import { smsTransactionCandidateFromFirestore, type SmsTransactionCandidate } from "@/lib/models/sms-transaction-candidate";
import { useAuthStore } from "@/store/auth-store";
import { useFirestoreWatch } from "./use-firestore-watch";

export function smsTransactionCandidatesQueryKey(uid: string | undefined) {
  return ["smsTransactionCandidates", uid] as const;
}

/** Live-subscribes to the signed-in user's SMS candidates, most recent transaction first. */
export function useSmsTransactionCandidates() {
  const uid = useAuthStore((s) => s.user?.uid);
  const queryClient = useQueryClient();

  return useFirestoreWatch<SmsTransactionCandidate[]>({
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
          for (const d of snapshot.docs) {
            try {
              candidates.push(smsTransactionCandidateFromFirestore(d));
            } catch (error) {
              console.error(`useSmsTransactionCandidates: skipping malformed candidate ${d.id}:`, error);
            }
          }
          onData(candidates);
        },
        onError,
      );
    },
  });
}
