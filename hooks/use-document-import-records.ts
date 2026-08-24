"use client";

/**
 * Live-subscribes to the extracted transaction records staged for one
 * uploaded statement — `users/{uid}/documentImports/{documentId}/records`.
 * `importId === documentId` by construction (see
 * `functions/src/staging/staging-writer.ts`'s module comment: one
 * financial document produces at most one staging import). Read-only —
 * mirrors `useFinancialDocuments`'s live-listener pattern. No edit/split/
 * merge/commit here; that's the separate, larger Review Workspace
 * (backlog Milestone 8/9).
 */

import { useQueryClient } from "@tanstack/react-query";
import { collection, onSnapshot, orderBy, query } from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import { FirestoreCollections } from "@/lib/firestore/collections";
import { stagedRecordFromFirestore, type StagedRecord } from "@/lib/models/document-import";
import { useAuthStore } from "@/store/auth-store";
import { useFirestoreWatch } from "./use-firestore-watch";

export function documentImportRecordsQueryKey(uid: string | undefined, documentId: string) {
  return ["documentImportRecords", uid, documentId] as const;
}

/** Live-subscribes to one statement's staged transaction records, ordered by date. */
export function useDocumentImportRecords(documentId: string) {
  const uid = useAuthStore((s) => s.user?.uid);
  const queryClient = useQueryClient();

  return useFirestoreWatch<StagedRecord[]>({
    queryKey: documentImportRecordsQueryKey(uid, documentId),
    enabled: !!uid && !!documentId,
    hookName: "useDocumentImportRecords",
    emptyValue: [],
    deps: [uid, documentId, queryClient],
    subscribe: (onData, onError) => {
      if (!uid || !documentId) return () => {};
      const ref = collection(
        db,
        FirestoreCollections.users,
        uid,
        FirestoreCollections.documentImports,
        documentId,
        FirestoreCollections.documentImportRecords,
      );
      const q = query(ref, orderBy("date", "asc"));
      return onSnapshot(q, (snapshot) => onData(snapshot.docs.map((d) => stagedRecordFromFirestore(d))), onError);
    },
  });
}
