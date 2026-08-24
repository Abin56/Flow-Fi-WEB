"use client";

/**
 * Owns the grid's single focused/editing cell and the keyboard-navigation
 * math (arrow keys, Tab/Shift+Tab, Enter, Escape, F2) — architecture §4c,
 * local component state, not global (it doesn't need to survive a remount
 * or leave the Spreadsheet).
 */

import { useCallback, useState } from "react";
import { EDITABLE_COLUMN_IDS, GRID_COLUMN_IDS, type CellAddress, type GridColumnId } from "../lib/grid-types";

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

export interface UseGridNavigationResult {
  focusedCell: CellAddress | null;
  editingCell: CellAddress | null;
  focusCell: (address: CellAddress) => void;
  startEdit: (address: CellAddress) => void;
  cancelEdit: () => void;
  stopEditAndMoveDown: () => void;
  moveFocus: (rowDelta: number, colDelta: number) => void;
  moveFocusTab: (forward: boolean) => void;
  focusFirstCellOfRow: (rowId: string) => void;
}

/** `rowIds` must be in the grid's current visual (sorted/filtered) order — navigation walks that order, not insertion order. */
export function useGridNavigation(rowIds: string[]): UseGridNavigationResult {
  const [focusedCell, setFocusedCell] = useState<CellAddress | null>(null);
  const [editingCell, setEditingCell] = useState<CellAddress | null>(null);

  const focusCell = useCallback((address: CellAddress) => {
    setFocusedCell(address);
    setEditingCell(null);
  }, []);

  const startEdit = useCallback((address: CellAddress) => {
    setFocusedCell(address);
    setEditingCell(address);
  }, []);

  const cancelEdit = useCallback(() => setEditingCell(null), []);

  const stopEditAndMoveDown = useCallback(() => {
    setEditingCell(null);
    setFocusedCell((current) => {
      if (!current) return current;
      const rowIndex = rowIds.indexOf(current.rowId);
      if (rowIndex === -1) return current;
      const nextRowId = rowIds[clamp(rowIndex + 1, 0, rowIds.length - 1)];
      return { rowId: nextRowId, columnId: current.columnId };
    });
  }, [rowIds]);

  const moveFocus = useCallback(
    (rowDelta: number, colDelta: number) => {
      setFocusedCell((current) => {
        const base = current ?? { rowId: rowIds[0], columnId: GRID_COLUMN_IDS[0] };
        const rowIndex = Math.max(0, rowIds.indexOf(base.rowId));
        const colIndex = Math.max(0, GRID_COLUMN_IDS.indexOf(base.columnId));
        const nextRowId = rowIds[clamp(rowIndex + rowDelta, 0, rowIds.length - 1)];
        const nextColId = GRID_COLUMN_IDS[clamp(colIndex + colDelta, 0, GRID_COLUMN_IDS.length - 1)];
        return { rowId: nextRowId, columnId: nextColId };
      });
      setEditingCell(null);
    },
    [rowIds],
  );

  const moveFocusTab = useCallback(
    (forward: boolean) => {
      setFocusedCell((current) => {
        const base = current ?? { rowId: rowIds[0], columnId: GRID_COLUMN_IDS[0] };
        const rowIndex = Math.max(0, rowIds.indexOf(base.rowId));
        const colIndex = Math.max(0, GRID_COLUMN_IDS.indexOf(base.columnId));
        const flatIndex = rowIndex * GRID_COLUMN_IDS.length + colIndex;
        const nextFlatIndex = clamp(flatIndex + (forward ? 1 : -1), 0, rowIds.length * GRID_COLUMN_IDS.length - 1);
        const nextRowIndex = Math.floor(nextFlatIndex / GRID_COLUMN_IDS.length);
        const nextColIndex = nextFlatIndex % GRID_COLUMN_IDS.length;
        return { rowId: rowIds[nextRowIndex], columnId: GRID_COLUMN_IDS[nextColIndex] };
      });
      setEditingCell(null);
    },
    [rowIds],
  );

  const focusFirstCellOfRow = useCallback((rowId: string) => {
    setFocusedCell({ rowId, columnId: GRID_COLUMN_IDS[0] as GridColumnId });
    setEditingCell(null);
  }, []);

  return { focusedCell, editingCell, focusCell, startEdit, cancelEdit, stopEditAndMoveDown, moveFocus, moveFocusTab, focusFirstCellOfRow };
}

export { EDITABLE_COLUMN_IDS };
