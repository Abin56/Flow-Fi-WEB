"use client";

/**
 * Compact "Columns" control for the review list: Auto (source order) · Customize columns · Reset to source.
 *
 * Purely presentational. The order lives in this tab only (sessionStorage holds column names, never statement
 * content), is applied to the same rows by the same ids, and changes where values are *drawn* — nothing else.
 */

import { useCallback, useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Columns3, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { CaptureParseResult } from "../lib/parse-pasted-statement";
import { baseColumns, COLUMN_LABEL, detectSourceLayout, loadColumnPreference, moveColumn, saveColumnPreference, validCustomOrder, type DisplayColumn, type SourceLayout } from "../lib/source-layout";

export interface ColumnLayoutState {
  layout: SourceLayout;
  /** Columns to draw; null = the standard layout (the source order couldn't be confirmed and the user hasn't customized). */
  columns: DisplayColumn[] | null;
  custom: boolean;
  /** The columns a customization may reorder. */
  available: DisplayColumn[];
  customize: () => void;
  reset: () => void;
  move: (column: DisplayColumn, delta: -1 | 1) => void;
}

export function useColumnLayout(parse: Pick<CaptureParseResult, "rows" | "headerOrder">): ColumnLayoutState {
  const layout = useMemo(() => detectSourceLayout(parse), [parse]);
  const available = useMemo(() => baseColumns(layout), [layout]);
  const [saved, setSaved] = useState<DisplayColumn[] | null>(() => loadColumnPreference(available));
  const custom = saved != null && validCustomOrder(saved, available) ? saved : null;

  const update = useCallback((order: DisplayColumn[] | null) => {
    setSaved(order);
    saveColumnPreference(order);
  }, []);

  return {
    layout,
    columns: custom ?? layout.order,
    custom: custom != null,
    available,
    customize: () => update(custom ?? [...available]),
    reset: () => update(null),
    move: (column, delta) => update(moveColumn(custom ?? available, column, delta)),
  };
}

export function ColumnLayoutControl({ state }: { state: ColumnLayoutState }) {
  const { layout, custom, available, columns } = state;
  const label = custom ? "Custom" : layout.order ? "Auto (Source order)" : "Auto (Standard)";
  const order = columns ?? available;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="column-layout-trigger"
          aria-label={`Column layout: ${label}`}
          className="inline-flex h-11 min-w-11 items-center justify-center gap-1 rounded-full px-2.5 text-xs text-muted-foreground hover:bg-muted sm:h-7 sm:min-w-0 hover:text-foreground data-[state=open]:bg-muted data-[state=open]:text-foreground"
        >
          <Columns3 className="size-3.5" />
          <span className="sm:hidden">Columns</span>
          <span className="hidden sm:inline">{label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" collisionPadding={16} className="flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-3" data-testid="column-layout-panel">
        <p className="text-sm font-medium text-foreground">Column layout</p>

        <div className="flex flex-col gap-1.5" role="group" aria-label="Column layout mode">
          <ModeButton active={!custom} onClick={state.reset} title="Auto (Source order)" detail={layout.order ? layout.reason : `Source order couldn't be confirmed — showing the standard layout. ${layout.reason}`} />
          <ModeButton active={custom} onClick={state.customize} title="Customize columns" detail="Choose the display order. Only where values are drawn changes — never the values." />
        </div>

        {custom && (
          <ol className="flex flex-col gap-1" aria-label="Column order" data-testid="column-order">
            {order.map((column, i) => (
              <li key={column} className="flex items-center gap-2 rounded-xl border border-border px-2.5 py-1.5 text-sm">
                <span className="w-4 text-xs text-muted-foreground tabular-nums">{i + 1}</span>
                <span className="min-w-0 flex-1 truncate">{COLUMN_LABEL[column]}</span>
                <button type="button" aria-label={`Move ${COLUMN_LABEL[column]} left`} disabled={i === 0} onClick={() => state.move(column, -1)} className="grid size-7 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30">
                  <ArrowLeft className="size-3.5" />
                </button>
                <button type="button" aria-label={`Move ${COLUMN_LABEL[column]} right`} disabled={i === order.length - 1} onClick={() => state.move(column, 1)} className="grid size-7 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30">
                  <ArrowRight className="size-3.5" />
                </button>
              </li>
            ))}
          </ol>
        )}

        <button
          type="button"
          disabled={!custom}
          onClick={state.reset}
          className="inline-flex h-8 items-center justify-center gap-1.5 self-start rounded-full border border-border px-3 text-xs font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
        >
          <RotateCcw className="size-3.5" /> Reset to source
        </button>
      </PopoverContent>
    </Popover>
  );
}

function ModeButton({ active, onClick, title, detail }: { active: boolean; onClick: () => void; title: string; detail: string }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn("flex items-start gap-2 rounded-xl border px-3 py-2 text-left transition-colors", active ? "border-primary/60 bg-primary/10" : "border-border hover:bg-muted")}
    >
      <Check className={cn("mt-0.5 size-3.5 shrink-0", active ? "text-primary" : "opacity-0")} />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-foreground">{title}</span>
        <span className="block text-xs text-muted-foreground">{detail}</span>
      </span>
    </button>
  );
}
