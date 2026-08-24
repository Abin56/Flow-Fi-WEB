/**
 * Transaction Studio's undo/redo command stack (architecture §4b) — scoped
 * per `documentId` so switching statements in the left panel doesn't let
 * Ctrl+Z leak across imports. Stores only the *data* of each edit (before/
 * after patches per touched record); actually replaying an undo/redo as a
 * real Firestore write happens in `useUndoRedo`, not here — this store is
 * just the stack.
 */

import { create } from "zustand";
import type { StagedRecordPatch } from "@/hooks/use-transaction-studio-mutations";

export interface UndoableEditEntry {
  recordId: string;
  before: StagedRecordPatch;
  after: StagedRecordPatch;
}

export interface UndoableEdit {
  id: string;
  description: string;
  entries: UndoableEditEntry[];
}

interface DocumentStack {
  undo: UndoableEdit[];
  redo: UndoableEdit[];
}

const EMPTY_STACK: DocumentStack = { undo: [], redo: [] };

interface TransactionStudioUndoState {
  stacks: Record<string, DocumentStack>;
  /** Records a new edit, clearing the redo stack (a fresh edit invalidates whatever was undone before it). */
  push: (documentId: string, edit: UndoableEdit) => void;
  /** Pops the most recent undoable edit and moves it to the redo stack. Returns it so the caller can replay the `before` values. */
  popUndo: (documentId: string) => UndoableEdit | null;
  /** Pops the most recent redoable edit and moves it back to the undo stack. Returns it so the caller can replay the `after` values. */
  popRedo: (documentId: string) => UndoableEdit | null;
  clear: (documentId: string) => void;
}

export const useTransactionStudioUndoStore = create<TransactionStudioUndoState>((set, get) => ({
  stacks: {},
  push: (documentId, edit) =>
    set((state) => {
      const current = state.stacks[documentId] ?? EMPTY_STACK;
      return { stacks: { ...state.stacks, [documentId]: { undo: [...current.undo, edit], redo: [] } } };
    }),
  popUndo: (documentId) => {
    const current = get().stacks[documentId] ?? EMPTY_STACK;
    const edit = current.undo[current.undo.length - 1];
    if (!edit) return null;
    set((state) => ({
      stacks: {
        ...state.stacks,
        [documentId]: { undo: current.undo.slice(0, -1), redo: [...current.redo, edit] },
      },
    }));
    return edit;
  },
  popRedo: (documentId) => {
    const current = get().stacks[documentId] ?? EMPTY_STACK;
    const edit = current.redo[current.redo.length - 1];
    if (!edit) return null;
    set((state) => ({
      stacks: {
        ...state.stacks,
        [documentId]: { undo: [...current.undo, edit], redo: current.redo.slice(0, -1) },
      },
    }));
    return edit;
  },
  clear: (documentId) =>
    set((state) => ({ stacks: { ...state.stacks, [documentId]: EMPTY_STACK } })),
}));
