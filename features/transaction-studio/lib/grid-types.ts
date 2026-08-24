import type { StagedRecord } from "@/lib/models/document-import";
import type { StagedRecordPatch } from "@/hooks/use-transaction-studio-mutations";
import type { CommitBlockingReason } from "./commit-review-import";

export interface AiSuggestion {
  label: string;
  onAccept: () => void;
}

/** One row of the spreadsheet — a staged record plus its live derived state (duplicate/needsReview badges read straight off the record, so no extra wrapper fields are needed yet). */
export type GridRow = StagedRecord;

/**
 * Stable column ids, left to right — used by keyboard nav, sticky-column CSS,
 * and column-width persistence. The grid was simplified down to the six
 * columns a user needs to scan at a glance (No/Date/Merchant/Amount/Action/
 * Status); everything else (Include, the old Action-axis dropdown, Category,
 * Notes, row menu) now lives in the Inspector, opened via the Action column's
 * button — see `RightSidebar`.
 */
export const GRID_COLUMN_IDS = ["no", "date", "merchant", "amount", "action", "status"] as const;

export type GridColumnId = (typeof GRID_COLUMN_IDS)[number];

/** Columns pinned to the left edge during horizontal scroll. */
export const STICKY_COLUMN_IDS: readonly GridColumnId[] = ["no", "date"];

/** A single addressable cell — the unit keyboard navigation, range selection, and clipboard all operate on. */
export interface CellAddress {
  rowId: string;
  columnId: GridColumnId;
}

export function cellKey(address: CellAddress): string {
  return `${address.rowId}:${address.columnId}`;
}

/** Which columns support single-cell keyboard editing (Enter/F2/typing-to-start, copy/paste) — the rest (no, action, status) are display-only or click-driven. */
export const EDITABLE_COLUMN_IDS: readonly GridColumnId[] = ["date", "merchant", "amount"];

export function isEditableColumn(columnId: GridColumnId): boolean {
  return EDITABLE_COLUMN_IDS.includes(columnId);
}

/**
 * Cross-cutting handlers every cell renderer needs but that don't belong on
 * `StagedRecord` itself — injected via react-table's `meta` so column defs
 * stay declarative (architecture §3/§4c). `commit` is the one path every
 * edit goes through: it applies the optimistic mutation, records the
 * before/after pair on the undo stack, and (for editable columns) advances
 * focus to the next row, matching Excel's Enter-to-commit-and-move-down.
 */
export interface StudioTableMeta {
  focusedCell: CellAddress | null;
  editingCell: CellAddress | null;
  focusCell: (address: CellAddress) => void;
  startEdit: (address: CellAddress) => void;
  cancelEdit: () => void;
  /** `columnId` is normally a `GridColumnId` (drives the cell's error-ring/undo label); `"include"` is also accepted for the keyboard-only exclude-from-totals shortcut (Delete/Backspace), which has no grid cell of its own anymore. */
  commit: (row: GridRow, columnId: GridColumnId | "include", patch: StagedRecordPatch, opts?: { moveDown?: boolean }) => void;
  /** A27 — cells whose last write rolled back, keyed by `cellKey`, with the error message to show. Persists until the cell is edited again (successfully or not). */
  cellErrors: Map<string, string>;
  /** A27 — cells that *just* failed, keyed by `cellKey` — true only for the brief red-flash window, then self-clears. */
  cellFlashKeys: Set<string>;
  selectedRowIds: Set<string>;
  toggleRowSelection: (rowId: string, opts: { shift?: boolean; ctrl?: boolean }) => void;
  /** Opens the Inspector (`RightSidebar`) for this row — the grid's only entry point into it now, via the Action column's button. */
  openInspector: (rowId: string) => void;
  /** This row's own slice of `getPreflightBlockers`'s output — the Status column's source for "something's actually wrong with this row" beyond needsReview/duplicate. */
  blockingReasonsByRowId: Map<string, CommitBlockingReason[]>;
}

