"use client";

/**
 * Transaction Studio's write layer (architecture §4a) — wraps
 * `DocumentImportRecordRepository` with optimistic React Query cache
 * updates against the exact same query key `useDocumentImportRecords`
 * populates, so an edit shows instantly and the next Firestore snapshot
 * event (from that hook's live listener) just confirms it, a visual no-op.
 * A failed write rolls the optimistic change back and rethrows, so callers
 * (the grid's cell editors, bulk-action bar, undo/redo stack) can surface
 * the failure.
 *
 * Kept separate from `useDocumentImportRecords` on purpose — that hook
 * stays a pure live-listener, matching this codebase's existing split
 * between read hooks and repositories (`use-transactions.ts` vs
 * `TransactionRepository`).
 */

import { useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { createDocumentImportRecordRepository } from "@/lib/repositories/repository-factory";
import type { StagedRecord } from "@/lib/models/document-import";
import { useAuthStore } from "@/store/auth-store";
import { documentImportRecordsQueryKey } from "./use-document-import-records";

export type StagedRecordPatch = Partial<Omit<StagedRecord, "id">>;

export interface TransactionStudioMutations {
  /** Applies one row's edit. Throws (after rolling back the optimistic update) if the write fails. */
  updateFields: (recordId: string, patch: StagedRecordPatch) => Promise<void>;
  /** Same patch applied to many rows — bulk category/owner/action/include changes. */
  bulkUpdateFields: (recordIds: string[], patch: StagedRecordPatch) => Promise<void>;
  /** Deletes only the staged review record. Never touches a committed transaction/expense/EMI/etc. */
  deleteRecord: (recordId: string) => Promise<void>;
  bulkDeleteRecords: (recordIds: string[]) => Promise<void>;
  /** Copies a row as a brand-new staged record (fresh id, provenance fields reset). Returns the new record's id. */
  duplicateRecord: (recordId: string) => Promise<string>;
}

export function useTransactionStudioMutations(documentId: string): TransactionStudioMutations {
  const uid = useAuthStore((s) => s.user?.uid);
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => documentImportRecordsQueryKey(uid, documentId), [uid, documentId]);
  const repository = useMemo(() => (uid ? createDocumentImportRecordRepository(uid, documentId) : null), [uid, documentId]);

  /** Applies `transform` to the cached rows immediately, returning a rollback closure for the caller's catch block. */
  const applyOptimistic = useCallback(
    (transform: (records: StagedRecord[]) => StagedRecord[]): (() => void) => {
      const previous = queryClient.getQueryData<StagedRecord[]>(queryKey);
      if (previous) queryClient.setQueryData<StagedRecord[]>(queryKey, transform(previous));
      return () => {
        if (previous) queryClient.setQueryData<StagedRecord[]>(queryKey, previous);
      };
    },
    [queryClient, queryKey],
  );

  const updateFields = useCallback(
    async (recordId: string, patch: StagedRecordPatch) => {
      if (!repository || !uid) throw new Error("Not signed in");
      const editedAt = new Date();
      const rollback = applyOptimistic((records) =>
        records.map((r) => (r.id === recordId ? { ...r, ...patch, userEdited: true, lastEditedAt: editedAt, lastEditedBy: uid } : r)),
      );
      try {
        await repository.updateFields(recordId, patch, uid);
      } catch (error) {
        rollback();
        throw error;
      }
    },
    [repository, uid, applyOptimistic],
  );

  const bulkUpdateFields = useCallback(
    async (recordIds: string[], patch: StagedRecordPatch) => {
      if (!repository || !uid) throw new Error("Not signed in");
      const editedAt = new Date();
      const idSet = new Set(recordIds);
      const rollback = applyOptimistic((records) =>
        records.map((r) => (idSet.has(r.id) ? { ...r, ...patch, userEdited: true, lastEditedAt: editedAt, lastEditedBy: uid } : r)),
      );
      try {
        await repository.bulkUpdateFields(recordIds, patch, uid);
      } catch (error) {
        rollback();
        throw error;
      }
    },
    [repository, uid, applyOptimistic],
  );

  const deleteRecord = useCallback(
    async (recordId: string) => {
      if (!repository) throw new Error("Not signed in");
      const rollback = applyOptimistic((records) => records.filter((r) => r.id !== recordId));
      try {
        await repository.deleteRecord(recordId);
      } catch (error) {
        rollback();
        throw error;
      }
    },
    [repository, applyOptimistic],
  );

  const bulkDeleteRecords = useCallback(
    async (recordIds: string[]) => {
      if (!repository) throw new Error("Not signed in");
      const idSet = new Set(recordIds);
      const rollback = applyOptimistic((records) => records.filter((r) => !idSet.has(r.id)));
      try {
        await repository.bulkDeleteRecords(recordIds);
      } catch (error) {
        rollback();
        throw error;
      }
    },
    [repository, applyOptimistic],
  );

  const duplicateRecord = useCallback(
    async (recordId: string) => {
      if (!repository || !uid) throw new Error("Not signed in");
      const source = queryClient.getQueryData<StagedRecord[]>(queryKey)?.find((r) => r.id === recordId);
      if (!source) throw new Error("Record not found");
      const optimisticId = `duplicating-${recordId}`;
      const rollback = applyOptimistic((records) => [...records, { ...source, id: optimisticId }]);
      try {
        const duplicate = await repository.duplicateRecord(source, uid);
        // Replace the optimistic placeholder with the real id — the next Firestore
        // snapshot event will also deliver it, but this keeps the UI in sync immediately.
        queryClient.setQueryData<StagedRecord[]>(queryKey, (records) =>
          records?.map((r) => (r.id === optimisticId ? duplicate : r)),
        );
        return duplicate.id;
      } catch (error) {
        rollback();
        throw error;
      }
    },
    [repository, uid, applyOptimistic, queryClient, queryKey],
  );

  return { updateFields, bulkUpdateFields, deleteRecord, bulkDeleteRecords, duplicateRecord };
}
