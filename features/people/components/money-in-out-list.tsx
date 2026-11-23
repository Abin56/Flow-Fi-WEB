"use client";

import { ArrowDownLeft, ArrowUpRight, Pencil, Trash2, Undo2 } from "lucide-react";
import { money } from "@/lib/engines/person-cycle-statement-share";
import { cn } from "@/lib/utils";

/**
 * The simple People history: only money that actually moved, one line each — "Received from ABIN" / "Paid to ABIN"
 * with the date, where it went, and the description the user wrote (if any). No schedules, no EMI wording, no
 * future obligations. Display only: every item is a cash movement the statement already holds.
 */
export interface MoneyItem {
  key: string;
  date: Date;
  createdAt: Date;
  dir: "in" | "out";
  amount: number;
  /** What the user wrote (note / own title) — optional. */
  description: string | null;
  /** Account or payment method it moved through. */
  account: string | null;
  /** Recorded as already received before FlowFi tracked it — no account change. */
  earlier: boolean;
  /** Existing handlers only (edit / revert a payment, delete a manual entry) — absent when the line can't be changed here. */
  actions?: { id: "edit" | "revert" | "delete"; onClick: () => void }[];
}

const ACTION = {
  edit: { label: "Edit", Icon: Pencil },
  revert: { label: "Revert this payment", Icon: Undo2 },
  delete: { label: "Delete", Icon: Trash2 },
} as const;

const dateLabel = (d: Date) => d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

export function MoneyInOutList({ items, firstName, isLoading, empty }: { items: readonly MoneyItem[]; firstName: string; isLoading?: boolean; empty: React.ReactNode }) {
  if (isLoading) return <div className="rounded-[10px] border border-border bg-card p-4 text-sm text-muted-foreground shadow-e1">Loading…</div>;
  if (items.length === 0) return <div className="rounded-[10px] border border-border bg-card shadow-e1">{empty}</div>;
  const sorted = [...items].sort((a, b) => b.date.getTime() - a.date.getTime() || b.createdAt.getTime() - a.createdAt.getTime());
  return (
    <ul data-testid="money-in-out-list" className="divide-y divide-border-subtle overflow-hidden rounded-[10px] border border-border bg-card shadow-e1 sm:max-h-[calc(100dvh-16rem)] sm:overflow-y-auto">
      {sorted.map((it) => {
        const incoming = it.dir === "in";
        return (
          <li key={it.key} className="flex items-center gap-3 px-3 py-2">
            <span aria-hidden className={cn("flex size-8 shrink-0 items-center justify-center rounded-full", incoming ? "bg-success/10 text-success" : "bg-expense/10 text-expense")}>
              {incoming ? <ArrowDownLeft className="size-4" strokeWidth={2.5} /> : <ArrowUpRight className="size-4" strokeWidth={2.5} />}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-foreground">{incoming ? `Received from ${firstName}` : `Paid to ${firstName}`}</p>
              <p className="truncate text-xs text-muted-foreground">
                {dateLabel(it.date)}
                {it.account && ` · ${it.account}`}
                {it.earlier && " · already in balance"}
                {it.description && <span className="text-foreground/70"> · {it.description}</span>}
              </p>
            </div>
            {it.actions && it.actions.length > 0 && (
              <span className="flex shrink-0 items-center gap-0.5">
                {it.actions.map((a) => (
                  <button key={a.id} type="button" onClick={a.onClick} title={ACTION[a.id].label} aria-label={ACTION[a.id].label} data-testid={`money-${a.id}`} className="flex size-7 items-center justify-center rounded-[6px] text-foreground/55 outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
                    {(() => { const I = ACTION[a.id].Icon; return <I className="size-3.5" strokeWidth={1.75} aria-hidden />; })()}
                  </button>
                ))}
              </span>
            )}
            <p className={cn("shrink-0 font-heading text-sm font-bold tabular-nums", incoming ? "text-success" : "text-expense")}>
              {incoming ? "+" : "−"}
              {money(it.amount)}
            </p>
          </li>
        );
      })}
    </ul>
  );
}
