"use client";

import { flexRender, type Row } from "@tanstack/react-table";
import { cn } from "@/lib/utils";
import { cellKey, type GridColumnId, type GridRow, type StudioTableMeta } from "../../lib/grid-types";
import { deriveRowStatus } from "../../lib/row-status";

/**
 * Opaque background for a pinned (sticky) cell — pinned cells can't just
 * inherit the row's translucent Tailwind bg-* class, since they sit above
 * the scrolling columns and need a solid fill or the scrolled-past content
 * would show through. `color-mix` approximates the same tint at roughly the
 * same strength as the row's own class so pinned and unpinned cells read as
 * one continuous row color.
 */
function pinnedBackground(isSelected: boolean, isFlaggedForReview: boolean, isResolved: boolean, isOdd: boolean): string {
  if (isSelected) return "color-mix(in oklch, var(--primary) 10%, var(--surface))";
  if (isFlaggedForReview) return "color-mix(in oklch, var(--warning) 6%, var(--surface))";
  if (isResolved) return "color-mix(in oklch, var(--success) 6%, var(--surface))";
  if (isOdd) return "color-mix(in oklch, var(--muted) 45%, var(--surface))";
  return "var(--surface)";
}

export function TransactionRow({
  row,
  meta,
  isSelected,
  isOdd,
  rowHeight,
  style,
}: {
  row: Row<GridRow>;
  meta: StudioTableMeta;
  isSelected: boolean;
  /** Zebra striping — every other row gets a subtle tint, the classic "table" read on top of the grid lines. */
  isOdd: boolean;
  /** Studio-local row-density preference (`transaction-studio-ui-store.ts`) — cell wrappers size to this rather than a fixed Tailwind height so "comfortable" density actually changes cell content, not just the row's outer box. */
  rowHeight: number;
  style: React.CSSProperties;
}) {
  const record = row.original;
  const isFlaggedForReview = record.needsReview && record.include && !isSelected;
  const isDuplicate = record.duplicateCandidateOf != null && record.include && !isSelected && !isFlaggedForReview;
  // A row that's already been committed to a real `transactions/{id}` doc — see `deriveRowStatus`
  // (shared with the Status badge, so the badge and this row tint can never disagree). In practice
  // this never coexists with `isFlaggedForReview`/`isDuplicate` (both are commit-blocking states,
  // verified against `getPreflightBlockers`), so no extra mutual-exclusion guard is needed here —
  // array order below still lets either override it defensively if that ever changes.
  const isSettled = record.committedTransactionId != null && !isSelected;
  // Same `deriveRowStatus` the Status badge itself uses (see that function's doc comment) — a row
  // that's fully reviewed and clear to commit ("Ready") gets the same full-row green treatment as
  // an already-Settled one, so finishing a row's edits (e.g. via the Manage modal's Save changes)
  // reads as an obvious, whole-row confirmation instead of a small badge color change easy to miss.
  const isReady = !isSelected && deriveRowStatus(record, meta.blockingReasonsByRowId.get(record.id) ?? []).label === "Ready";
  const isResolved = isSettled || isReady;
  // A27 — a row "has an error" if any of its cells carry a stale failed-save entry in `cellErrors`
  // (keyed `${rowId}:${columnId}`); this is the row-level echo of that per-cell state, surfaced
  // here only as a faint background tint — the grid lines stay the primary visual language, per-cell
  // error rings (below) are the precise signal, this is just enough to catch the eye while scanning.
  const hasError = Array.from(meta.cellErrors.keys()).some((key) => key.startsWith(`${row.id}:`));

  return (
    <div
      role="row"
      aria-selected={isSelected}
      style={{ ...style, borderBottomColor: "var(--grid-line-strong)" }}
      className={cn(
        "group flex border-b transition-colors duration-fast ease-spring",
        !isSelected && "hover:bg-muted/40",
        !record.include && "opacity-45",
        isResolved && "bg-success/5",
        isSelected && "bg-primary/10",
        isFlaggedForReview && "bg-warning/5",
        isDuplicate && "bg-purple/5",
        hasError && "bg-danger/5",
        !isSelected && !isResolved && !isFlaggedForReview && !isDuplicate && !hasError && isOdd && "bg-muted/25",
      )}
      onMouseDown={(e) => {
        if (e.shiftKey || e.ctrlKey || e.metaKey) {
          meta.toggleRowSelection(row.id, { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey });
        }
      }}
    >
      {row.getVisibleCells().map((cell) => {
        const pinned = cell.column.getIsPinned();
        // Matches the same frozen-column boundary marker in `SpreadsheetHeader` — a slightly
        // stronger vertical line where the sticky Include/Action/Date columns end.
        const isFrozenBoundary = cell.column.getIsLastColumn("left");
        // Merchant is the one flex-fill column (spreadsheet.tsx) — grows to absorb extra width on wide
        // screens, shrinks toward its own minSize before the row resorts to horizontal scroll.
        const isFlexFill = cell.column.id === "merchant";
        // A27 — failed-save signal lives on the outer cell wrapper, not inside each cell renderer,
        // so every editable cell type gets red-ring + flash for free without threading error state
        // through six different components.
        const key = cellKey({ rowId: row.id, columnId: cell.column.id as GridColumnId });
        const error = meta.cellErrors.get(key);
        const isFlashing = meta.cellFlashKeys.has(key);
        return (
          <div
            key={cell.id}
            role="gridcell"
            title={error}
            style={{
              height: rowHeight,
              borderRightColor: isFrozenBoundary ? "var(--border)" : "var(--grid-line)",
              ...(isFlexFill
                ? { flex: "1 1 auto", flexBasis: cell.column.getSize(), minWidth: (cell.column.columnDef.minSize as number | undefined) ?? cell.column.getSize() }
                : { width: cell.column.getSize(), flexShrink: 0 }),
              ...(pinned
                ? { position: "sticky", left: cell.column.getStart("left"), zIndex: 1, background: pinnedBackground(isSelected, isFlaggedForReview, isResolved, isOdd) }
                : {}),
            }}
            className={cn(
              "relative border-r last:border-r-0",
              isFrozenBoundary && "border-r-2",
              error && "ring-1 ring-inset ring-danger/60",
              isFlashing && "animate-cell-error-flash",
            )}
          >
            {flexRender(cell.column.columnDef.cell, cell.getContext())}
            {error && <span className="pointer-events-none absolute top-0.5 right-0.5 size-1.5 rounded-full bg-danger" aria-hidden />}
          </div>
        );
      })}
    </div>
  );
}
