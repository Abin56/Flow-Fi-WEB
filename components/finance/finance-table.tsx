"use client";

import { AnimatePresence, motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { TableSkeleton } from "@/components/finance/table-skeleton";

export interface FinanceTableColumn<T> {
  id: string;
  header: React.ReactNode;
  accessor: (row: T) => React.ReactNode;
  /** Fixed pixel width — column never grows/shrinks (icons, tick/delete affordances). */
  width?: string;
  /**
   * Fluid column: grows to fill available row width but never shrinks below
   * this floor. Use for Date/Merchant/Amount so the table adapts across
   * laptop screen sizes instead of always overflowing into horizontal
   * scroll once the sum of fixed widths exceeds the viewport.
   */
  minWidth?: string;
  /** Hides this column below the `md` breakpoint — for columns that aren't essential on narrow screens (e.g. row number). */
  hideOnMobile?: boolean;
  align?: "left" | "right" | "center";
  /** Numeric/amount columns should set this to get tabular-nums + right alignment defaults. */
  numeric?: boolean;
}

interface FinanceTableProps<T> {
  columns: FinanceTableColumn<T>[];
  data: T[];
  getRowId: (row: T) => string;
  onRowClick?: (row: T) => void;
  selectedId?: string | null;
  isRowSelected?: (row: T) => boolean;
  /** Optional extra classes per row (e.g. status-tone tinting) — merged onto the row's own classes, never replaces them. */
  rowClassName?: (row: T) => string | undefined;
  loading?: boolean;
  emptyState?: React.ReactNode;
  className?: string;
  /** Opt-in Excel-style cell borders (vertical between columns + a stronger row divider) using the same
   *  `--grid-line`/`--grid-line-strong` tokens Transaction Studio's own grid draws its lines with, instead
   *  of this table's normal borderless-column look. Off by default so existing callers are unaffected. */
  gridLines?: boolean;
}

const alignClass = { left: "text-left", right: "text-right", center: "text-center" } as const;

/** Div/flex based financial data table (not a semantic <table>) so each row can carry its own clay elevation
 *  on hover without fighting <table> layout algorithms. Sticky header, comfortable row height, tabular-nums. */
export function FinanceTable<T>({
  columns,
  data,
  getRowId,
  onRowClick,
  selectedId,
  isRowSelected,
  rowClassName,
  loading,
  emptyState,
  className,
  gridLines,
}: FinanceTableProps<T>) {
  if (loading) {
    return (
      <div className={cn("w-full overflow-hidden rounded-2xl border border-border/60 bg-card", className)}>
        <TableSkeleton columns={columns.length} />
      </div>
    );
  }

  if (data.length === 0 && emptyState) {
    return (
      <div className={cn("w-full overflow-hidden rounded-2xl border border-border/60 bg-card", className)}>
        {emptyState}
      </div>
    );
  }

  // Sum of every column's fixed/minimum width (plus the row's own gap-4 spacing) so the row never
  // shrinks below its intrinsic content width — without this floor, the flex row's `flex-1` columns
  // collapse to fit the viewport, leaving nothing for `overflow-x-auto` to actually scroll into.
  const columnGapPx = 16;
  const tableMinWidth = `calc(${columns.map((col) => col.width ?? col.minWidth ?? "0px").join(" + ")} + ${columnGapPx * (columns.length - 1)}px + 2rem)`;

  return (
    <div className={cn("w-full overflow-hidden rounded-2xl border border-border/60 bg-card", className)}>
      <div className="overflow-x-auto">
        <div style={{ minWidth: tableMinWidth }}>
          <div
            className={cn(
              "sticky top-0 z-10 flex items-center gap-4 border-b bg-card px-4 py-3",
              !gridLines && "border-border/60",
            )}
            style={gridLines ? { borderBottomColor: "var(--grid-line-strong)" } : undefined}
          >
            {columns.map((col, i) => (
              <div
                key={col.id}
                style={{
                  ...(col.width ? { width: col.width } : col.minWidth ? { minWidth: col.minWidth } : undefined),
                  ...(gridLines && i < columns.length - 1 ? { borderRightColor: "var(--grid-line)" } : undefined),
                }}
                className={cn(
                  "text-xs font-medium tracking-wide text-muted-foreground uppercase",
                  col.width ? "shrink-0" : "flex-1",
                  col.hideOnMobile && "hidden md:block",
                  gridLines && i < columns.length - 1 && "border-r pr-3",
                  alignClass[col.align ?? (col.numeric ? "right" : "left")],
                )}
              >
                {col.header}
              </div>
            ))}
          </div>

          <AnimatePresence mode="popLayout" initial={false}>
            {data.map((row) => {
              const id = getRowId(row);
              const selected = isRowSelected ? isRowSelected(row) : selectedId === id;
              return (
                <motion.div
                  key={id}
                  layout="position"
                  initial={false}
                  exit={{ opacity: 0, height: 0, marginTop: 0, marginBottom: 0, paddingTop: 0, paddingBottom: 0 }}
                  transition={{ duration: 0.18, ease: "easeOut" }}
                  whileTap={onRowClick ? { scale: 0.995 } : undefined}
                  role={onRowClick ? "button" : undefined}
                  tabIndex={onRowClick ? 0 : undefined}
                  onClick={() => onRowClick?.(row)}
                  style={gridLines ? { borderBottomColor: "var(--grid-line-strong)" } : undefined}
                  className={cn(
                    "flex items-center gap-4 overflow-hidden border-b px-4 py-3.5 text-sm transition-[transform,background-color] duration-150 last:border-b-0",
                    !gridLines && "border-border/60",
                    onRowClick && "cursor-pointer hover:-translate-y-px hover:bg-muted/40",
                    selected && "bg-primary/5",
                    rowClassName?.(row),
                  )}
                >
                  {columns.map((col, i) => (
                    <div
                      key={col.id}
                      style={{
                        ...(col.width ? { width: col.width } : col.minWidth ? { minWidth: col.minWidth } : undefined),
                        ...(gridLines && i < columns.length - 1 ? { borderRightColor: "var(--grid-line)" } : undefined),
                      }}
                      className={cn(
                        "truncate",
                        col.width ? "shrink-0" : "flex-1",
                        col.hideOnMobile && "hidden md:block",
                        col.numeric && "font-mono tabular-nums",
                        gridLines && i < columns.length - 1 && "border-r pr-3",
                        alignClass[col.align ?? (col.numeric ? "right" : "left")],
                      )}
                    >
                      {col.accessor(row)}
                    </div>
                  ))}
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
