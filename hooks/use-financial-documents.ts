"use client";

/**
 * Mirrors the live-subscription pattern established by `hooks/use-bills.ts`
 * (a live Firestore `watchAll`-equivalent subscription feeding a React
 * Query cache, `staleTime: Infinity`) — but `financialDocuments` has no
 * client-write path at all (`firestore.rules`: `allow write: if false`), so
 * there is no matching repository/converter pair to build here. This hook
 * reads directly via `onSnapshot`, the same shape
 * `useAllCreditCardStatements` already uses for a read-only cross-document
 * live query.
 *
 * Ordered by `uploadedAt` descending (`FieldValue.serverTimestamp()` at
 * creation, per `check-document-exists.ts`) so the most recent upload is
 * always first.
 */

import { useQueryClient } from "@tanstack/react-query";
import { collection, onSnapshot, orderBy, query } from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import { FirestoreCollections } from "@/lib/firestore/collections";
import { financialDocumentFromFirestore, type FinancialDocument } from "@/lib/models/financial-document";
import { useAuthStore } from "@/store/auth-store";
import { useFirestoreWatch } from "./use-firestore-watch";

export function financialDocumentsQueryKey(uid: string | undefined) {
  return ["financialDocuments", uid] as const;
}

/** Live-subscribes to the signed-in user's `financialDocuments`, newest upload first. */
export function useFinancialDocuments() {
  const uid = useAuthStore((s) => s.user?.uid);
  const queryClient = useQueryClient();

  return useFirestoreWatch<FinancialDocument[]>({
    queryKey: financialDocumentsQueryKey(uid),
    enabled: !!uid,
    hookName: "useFinancialDocuments",
    emptyValue: [],
    deps: [uid, queryClient],
    subscribe: (onData, onError) => {
      if (!uid) return () => {};
      const ref = collection(db, FirestoreCollections.users, uid, FirestoreCollections.financialDocuments);
      const q = query(ref, orderBy("uploadedAt", "desc"));
      return onSnapshot(q, (snapshot) => onData(snapshot.docs.map((d) => financialDocumentFromFirestore(d))), onError);
    },
  });
}
