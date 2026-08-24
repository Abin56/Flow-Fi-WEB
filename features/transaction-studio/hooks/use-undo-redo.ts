"use client";

/**
 * Replays undo/redo stack entries as real Firestore writes (architecture
 * §4b: "undo is a real Firestore write... matching mobile's AuditableMixin/
 * editHistory philosophy"). The stack itself (`transaction-studio-undo-store`)
 * only holds data; this hook is what turns a stack pop into an actual
 * `updateFields` call per touched record.
 */

import { useCallback } from "react";
import { useTransactionStudioUndoStore, type UndoableEdit } from "@/store/transaction-studio-undo-store";
import type { TransactionStudioMutations } from "@/hooks/use-transaction-studio-mutations";

export interface UseUndoRedoResult {
  record: (edit: Omit<UndoableEdit, "id">) => void;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  canUndo: boolean;
  canRedo: boolean;
}

let editCounter = 0;

export function useUndoRedo(documentId: string, mutations: TransactionStudioMutations): UseUndoRedoResult {
  const stack = useTransactionStudioUndoStore((s) => s.stacks[documentId]);
  const push = useTransactionStudioUndoStore((s) => s.push);
  const popUndo = useTransactionStudioUndoStore((s) => s.popUndo);
  const popRedo = useTransactionStudioUndoStore((s) => s.popRedo);

  const record = useCallback(
    (edit: Omit<UndoableEdit, "id">) => {
      if (edit.entries.length === 0) return;
      push(documentId, { ...edit, id: `edit-${++editCounter}` });
    },
    [documentId, push],
  );

  const undo = useCallback(async () => {
    const edit = popUndo(documentId);
    if (!edit) return;
    await Promise.all(edit.entries.map((entry) => mutations.updateFields(entry.recordId, entry.before)));
  }, [documentId, popUndo, mutations]);

  const redo = useCallback(async () => {
    const edit = popRedo(documentId);
    if (!edit) return;
    await Promise.all(edit.entries.map((entry) => mutations.updateFields(entry.recordId, entry.after)));
  }, [documentId, popRedo, mutations]);

  return {
    record,
    undo,
    redo,
    canUndo: (stack?.undo.length ?? 0) > 0,
    canRedo: (stack?.redo.length ?? 0) > 0,
  };
}
