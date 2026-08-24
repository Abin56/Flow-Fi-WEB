"use client";

/**
 * The grid itself (architecture §3) — react-table for the column/sort model,
 * react-virtual for row virtualization, sticky header + sticky No/Date
 * columns via react-table's native column pinning. Owns focus,
 * edit-mode, row selection, clipboard, and keyboard navigation; every data
 * write goes through `commit`, which applies the optimistic mutation and
 * records the before/after pair on the undo stack in one place.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { getCoreRowModel, getSortedRowModel, useReactTable, type SortingState } from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { StagedRecordPatch, TransactionStudioMutations } from "@/hooks/use-transaction-studio-mutations";
import type { CommitBlockingReason } from "../../lib/commit-review-import";
import type { Transaction } from "@/lib/models/transaction";
import type { TransactionRepository } from "@/lib/repositories/transaction-repository";
import { toast } from "@/store/toast-store";
import { ROW_HEIGHT_BY_DENSITY, useTransactionStudioUiStore } from "@/store/transaction-studio-ui-store";
import { buildStudioColumns } from "../../lib/columns";
import { cellValueToText, textToPatch } from "../../lib/clipboard";
import { saveGridFieldCommittedAware, type GridEditableColumnId } from "../../lib/committed-transaction-sync";
import { cellKey, STICKY_COLUMN_IDS, isEditableColumn, type GridColumnId, type GridRow, type StudioTableMeta } from "../../lib/grid-types";
import { useGridNavigation } from "../../hooks/use-grid-navigation";
import { useUndoRedo } from "../../hooks/use-undo-redo";
import { SpreadsheetHeader } from "./spreadsheet-header";
import { SpreadsheetFooter } from "./spreadsheet-footer";
import { TransactionRow } from "./transaction-row";
import { computeStudioSummary } from "../../lib/summary";

function isTransactionColumn(columnId: string): columnId is GridEditableColumnId {
  return columnId === "date" || columnId === "merchant" || columnId === "amount";
}

export interface SpreadsheetProps {
  documentId: string;
  rows: GridRow[];
  mutations: TransactionStudioMutations;
  onOpenInspector: (rowId: string) => void;
  /** Controlled row selection — lifted to the parent (`TransactionStudio`) so `BulkActionBar` can share and act on the same set. */
  selectedRowIds: Set<string>;
  setSelectedRowIds: (next: Set<string> | ((prev: Set<string>) => Set<string>)) => void;
  /** Already-committed rows' real transactions — `Spreadsheet.commit` routes Amount/Date/Merchant edits through `transactionRepository.editTransaction` for these instead of writing only to staging. */
  liveTransactions: Transaction[];
  /** `null` only while signed-out/loading — committed-row cell edits are rejected (with a toast, cell reverts) until this is ready. */
  transactionRepository: TransactionRepository | null;
  /** `getPreflightBlockers`'s output, keyed by row id — computed once in `TransactionStudio` (the same computation the Validation Bar already uses) and passed through to the Status column instead of a second validation pass. */
  blockingReasonsByRowId: Map<string, CommitBlockingReason[]>;
}

export function Spreadsheet({
  documentId,
  rows,
  mutations,
  onOpenInspector,
  selectedRowIds,
  setSelectedRowIds,
  liveTransactions,
  transactionRepository,
  blockingReasonsByRowId,
}: SpreadsheetProps) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const rowDensity = useTransactionStudioUiStore((s) => s.rowDensity);
  const ROW_HEIGHT = ROW_HEIGHT_BY_DENSITY[rowDensity];
  const selectionAnchorRef = useRef<string | null>(null);
  const clipboardRef = useRef<{ columnId: string; text: string } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const undoRedo = useUndoRedo(documentId, mutations);
  const [cellErrors, setCellErrors] = useState<Map<string, string>>(new Map());
  const [cellFlashKeys, setCellFlashKeys] = useState<Set<string>>(new Set());
  const committedTransactionsById = useMemo(() => new Map(liveTransactions.map((t) => [t.id, t])), [liveTransactions]);

  const columns = useMemo(() => buildStudioColumns(), []);

  const table = useReactTable({
    data: rows,
    columns,
    getRowId: (row) => row.id,
    state: { sorting, columnPinning: { left: [...STICKY_COLUMN_IDS] } },
    onSortingChange: setSorting,
    columnResizeMode: "onChange",
    enableColumnResizing: true,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    meta: {} as StudioTableMeta, // replaced below — table.options.meta is read fresh each render via the object built after `commit` exists
  });

  const tableRows = table.getRowModel().rows;
  const rowIds = useMemo(() => tableRows.map((r) => r.id), [tableRows]);
  const navigation = useGridNavigation(rowIds);
  const setSelection = setSelectedRowIds;

  const toggleRowSelection = useCallback(
    (rowId: string, opts: { shift?: boolean; ctrl?: boolean }) => {
      if (opts.shift && selectionAnchorRef.current) {
        const anchorIndex = rowIds.indexOf(selectionAnchorRef.current);
        const targetIndex = rowIds.indexOf(rowId);
        if (anchorIndex !== -1 && targetIndex !== -1) {
          const [from, to] = anchorIndex < targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
          setSelection(new Set(rowIds.slice(from, to + 1)));
          return;
        }
      }
      selectionAnchorRef.current = rowId;
      setSelection((prev) => {
        if (!opts.ctrl) return new Set([rowId]);
        const next = new Set(prev);
        if (next.has(rowId)) next.delete(rowId);
        else next.add(rowId);
        return next;
      });
    },
    [rowIds, setSelection],
  );

  const commit = useCallback(
    (row: GridRow, columnId: GridColumnId | "include", patch: StagedRecordPatch, opts?: { moveDown?: boolean }) => {
      const before: StagedRecordPatch = {};
      for (const key of Object.keys(patch) as (keyof StagedRecordPatch)[]) {
        (before as Record<string, unknown>)[key] = (row as unknown as Record<string, unknown>)[key];
      }
      // `columnId` may be "include" here (the keyboard-only exclude-from-totals shortcut, which has
      // no grid cell of its own) — `cellKey` just needs a stable string, so the cast is safe.
      const key = cellKey({ rowId: row.id, columnId: columnId as GridColumnId });
      // A27 — a fresh attempt on this cell clears whatever error it last carried; the optimistic
      // write already applied by the time the caller sees this, so any old red ring is stale.
      setCellErrors((prev) => (prev.has(key) ? new Map([...prev].filter(([k]) => k !== key)) : prev));

      // Amount/Date/Merchant on an already-committed row must reach the real `transactions/{id}`
      // doc (balance-safe, via `TransactionRepository.editTransaction`), not only the staging copy
      // — see `saveGridFieldCommittedAware`'s doc comment. Every not-yet-committed row keeps the
      // original staging-only write, unchanged.
      const write = isTransactionColumn(columnId)
        ? saveGridFieldCommittedAware({
            row,
            columnId,
            patch,
            committedTransaction: row.committedTransactionId ? (committedTransactionsById.get(row.committedTransactionId) ?? null) : null,
            transactionRepository,
            mutations,
          })
        : mutations.updateFields(row.id, patch);

      write.then(
        () => {
          // Only recorded on success — the mutation hook already rolls the optimistic value
          // back on failure, so an undo entry for a write that never actually landed would
          // just be a phantom no-op at best, or revert to a stale "before" at worst. Skipped
          // entirely for an already-committed row: undo/redo only ever replays through
          // `mutations.updateFields` (staging), which can't safely undo a real, possibly
          // balance-affecting edit — recording it would make Ctrl+Z look like it worked while
          // silently leaving the real transaction's new value in place.
          if (!row.committedTransactionId) {
            undoRedo.record({ description: columnId, entries: [{ recordId: row.id, before, after: patch }] });
          }
        },
        (error: unknown) => {
          const message = error instanceof Error ? error.message : "The change couldn't be saved.";
          setCellErrors((prev) => new Map(prev).set(key, message));
          setCellFlashKeys((prev) => new Set(prev).add(key));
          setTimeout(() => setCellFlashKeys((prev) => { const next = new Set(prev); next.delete(key); return next; }), 1400);
          toast.error("Couldn't save change", message);
        },
      );
      if (opts?.moveDown) navigation.stopEditAndMoveDown();
      else navigation.cancelEdit();
    },
    [mutations, undoRedo, navigation, transactionRepository, committedTransactionsById],
  );

  const meta = useMemo<StudioTableMeta>(
    () => ({
      focusedCell: navigation.focusedCell,
      editingCell: navigation.editingCell,
      focusCell: navigation.focusCell,
      startEdit: navigation.startEdit,
      cancelEdit: navigation.cancelEdit,
      commit,
      cellErrors,
      cellFlashKeys,
      selectedRowIds,
      toggleRowSelection,
      openInspector: onOpenInspector,
      blockingReasonsByRowId,
    }),
    [navigation, commit, cellErrors, cellFlashKeys, selectedRowIds, toggleRowSelection, onOpenInspector, blockingReasonsByRowId],
  );
  table.setOptions((prev) => ({ ...prev, meta }));

  const virtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  const totalWidth = table.getTotalSize();
  // Merchant is the one flex-fill column (Linear/Notion's "title column stretches" convention) — on an
  // ultrawide monitor it grows to absorb the leftover space instead of leaving a dead gap; on a narrow
  // laptop it shrinks toward its own minSize before the grid resorts to horizontal scroll. `wrapperMinWidth`
  // is `totalWidth` computed as if Merchant were already at its floor, so the scroll container never gets
  // forced wider than necessary and only actually scrolls once every other column is already at minimum.
  const merchantColumn = table.getColumn("merchant");
  const merchantSize = merchantColumn?.getSize() ?? 220;
  const merchantMinSize = typeof merchantColumn?.columnDef.minSize === "number" ? merchantColumn.columnDef.minSize : 140;
  const wrapperMinWidth = totalWidth - merchantSize + merchantMinSize;
  const summary = useMemo(() => computeStudioSummary(rows), [rows]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const focused = navigation.focusedCell;
      const isMac = typeof navigator !== "undefined" && navigator.platform.toLowerCase().includes("mac");
      const mod = isMac ? e.metaKey : e.ctrlKey;

      if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        void undoRedo.undo();
        return;
      }
      if (mod && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) {
        e.preventDefault();
        void undoRedo.redo();
        return;
      }
      if (mod && e.key.toLowerCase() === "a") {
        e.preventDefault();
        setSelection(new Set(rowIds));
        return;
      }
      if (!focused) return;
      const row = rows.find((r) => r.id === focused.rowId);
      if (!row) return;

      if (navigation.editingCell) {
        return; // let the active input handle its own keys (Enter/Escape are wired per-cell)
      }

      switch (e.key) {
        case "ArrowUp":
        case "ArrowDown": {
          e.preventDefault();
          // A35/§6 — Shift+Arrow range-selects rows the same way Shift+Click does, reusing
          // `toggleRowSelection`'s anchor logic rather than a second selection algorithm.
          if (e.shiftKey) {
            const delta = e.key === "ArrowUp" ? -1 : 1;
            const currentIndex = rowIds.indexOf(focused.rowId);
            const nextRowId = rowIds[Math.max(0, Math.min(rowIds.length - 1, currentIndex + delta))];
            if (!selectionAnchorRef.current) toggleRowSelection(focused.rowId, { shift: false });
            toggleRowSelection(nextRowId, { shift: true });
          }
          navigation.moveFocus(e.key === "ArrowUp" ? -1 : 1, 0);
          break;
        }
        case "ArrowLeft":
          e.preventDefault();
          navigation.moveFocus(0, -1);
          break;
        case "ArrowRight":
          e.preventDefault();
          navigation.moveFocus(0, 1);
          break;
        case "Tab":
          e.preventDefault();
          navigation.moveFocusTab(!e.shiftKey);
          break;
        case "Enter":
        case "F2":
          e.preventDefault();
          if (isEditableColumn(focused.columnId)) navigation.startEdit(focused);
          else navigation.moveFocus(1, 0);
          break;
        case "Escape":
          e.preventDefault();
          setSelection(new Set());
          break;
        case "Delete":
        case "Backspace": {
          const targets = selectedRowIds.size > 0 ? Array.from(selectedRowIds) : [row.id];
          e.preventDefault();
          for (const id of targets) {
            const target = rows.find((r) => r.id === id);
            // Include-in-totals is a staging-only concept — meaningless (and disabled elsewhere,
            // see `RowManagementPanel`/`TransactionManageModal`) once a row is committed, so this
            // shortcut skips committed rows rather than firing a no-op-for-the-real-transaction
            // staging write.
            if (target && target.include && !target.committedTransactionId) commit(target, "include", { include: false });
          }
          break;
        }
        case "c":
        case "C":
          if (mod && isEditableColumn(focused.columnId)) {
            const text = cellValueToText(row, focused.columnId);
            clipboardRef.current = { columnId: focused.columnId, text };
            void navigator.clipboard?.writeText(text).catch(() => {});
          }
          break;
        case "v":
        case "V":
          if (mod && isEditableColumn(focused.columnId) && clipboardRef.current?.columnId === focused.columnId) {
            const patch = textToPatch(focused.columnId, clipboardRef.current.text);
            if (patch) {
              const targets = selectedRowIds.size > 1 ? Array.from(selectedRowIds) : [row.id];
              for (const id of targets) {
                const target = rows.find((r) => r.id === id);
                if (target) commit(target, focused.columnId, patch);
              }
            }
          }
          break;
        default:
          break;
      }
    },
    [navigation, rows, rowIds, selectedRowIds, commit, undoRedo, setSelection, toggleRowSelection],
  );

  return (
    <div className="surface-flat flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border" style={{ borderColor: "var(--grid-line)" }}>
      <div ref={scrollRef} className="flex-1 overflow-auto outline-none" tabIndex={0} onKeyDown={handleKeyDown} role="grid" aria-rowcount={rows.length}>
        <div style={{ minWidth: wrapperMinWidth, width: "100%", position: "relative" }}>
          <SpreadsheetHeader table={table} />
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const row = tableRows[virtualRow.index];
              return (
                <TransactionRow
                  key={row.id}
                  row={row}
                  meta={meta}
                  isSelected={selectedRowIds.has(row.id)}
                  isOdd={virtualRow.index % 2 === 1}
                  rowHeight={ROW_HEIGHT}
                  style={{ position: "absolute", top: 0, left: 0, transform: `translateY(${virtualRow.start}px)`, width: "100%", height: ROW_HEIGHT }}
                />
              );
            })}
          </div>
        </div>
      </div>
      <SpreadsheetFooter summary={summary} />
    </div>
  );
}
