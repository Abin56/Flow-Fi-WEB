"use client";

import { flexRender, type Table } from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import type { GridRow } from "../../lib/grid-types";

export function SpreadsheetHeader({ table }: { table: Table<GridRow> }) {
  return (
    <div role="row" className="sticky top-0 z-20 flex border-b-2 bg-muted" style={{ borderBottomColor: "var(--grid-line)" }}>
      {table.getHeaderGroups().map((group) =>
        group.headers.map((header) => {
          const pinned = header.column.getIsPinned();
          // Marks the boundary between the frozen (Include/Action/Date) columns and the
          // scrolling body — a slightly stronger vertical line than the regular grid so the
          // user can tell at a glance where the sticky area ends, Excel/Sheets-style.
          const isFrozenBoundary = header.column.getIsLastColumn("left");
          const canSort = header.column.getCanSort();
          const sorted = header.column.getIsSorted();
          const isFlexFill = header.column.id === "merchant";
          return (
            <div
              key={header.id}
              role="columnheader"
              style={{
                borderRightColor: isFrozenBoundary ? "var(--border)" : "var(--grid-line)",
                ...(isFlexFill
                  ? { flex: "1 1 auto", flexBasis: header.getSize(), minWidth: (header.column.columnDef.minSize as number | undefined) ?? header.getSize() }
                  : { width: header.getSize(), flexShrink: 0 }),
                ...(pinned ? { position: "sticky", left: header.column.getStart("left"), zIndex: 21 } : {}),
              }}
              className={cn("group relative flex h-9 items-center gap-1 border-r bg-muted px-2.5 last:border-r-0", isFrozenBoundary && "border-r-2", pinned && "bg-muted")}
            >
              {header.isPlaceholder ? null : (
                <button
                  type="button"
                  className={cn(
                    "flex min-w-0 flex-1 items-center gap-1 truncate text-left text-[11px] font-bold tracking-wide text-foreground uppercase",
                    canSort && "cursor-pointer hover:text-primary",
                  )}
                  onClick={canSort ? header.column.getToggleSortingHandler() : undefined}
                  disabled={!canSort}
                >
                  <span className="truncate">{flexRender(header.column.columnDef.header, header.getContext())}</span>
                  {canSort &&
                    (sorted === "asc" ? (
                      <ArrowUp className="size-3 shrink-0" />
                    ) : sorted === "desc" ? (
                      <ArrowDown className="size-3 shrink-0" />
                    ) : (
                      <ChevronsUpDown className="size-3 shrink-0 opacity-0 group-hover:opacity-40" />
                    ))}
                </button>
              )}
              {header.column.getCanResize() && (
                <div
                  onMouseDown={header.getResizeHandler()}
                  onTouchStart={header.getResizeHandler()}
                  className={cn(
                    "absolute top-0 right-0 h-full w-1.5 cursor-col-resize touch-none select-none",
                    header.column.getIsResizing() ? "bg-primary" : "hover:bg-primary/40",
                  )}
                />
              )}
            </div>
          );
        }),
      )}
    </div>
  );
}
