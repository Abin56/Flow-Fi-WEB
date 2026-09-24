import { ArrowDownToLine, ArrowUpFromLine } from "lucide-react";
import { formatCurrency } from "@/lib/format";
import type { PersonActivityItem } from "@/features/people/hooks/use-people-data";
import { cn } from "@/lib/utils";

/**
 * Shared row markup for the person transaction-history surface — used inside both the desktop
 * dialog and the mobile sheet (no separate mobile/desktop row markup, per the "don't duplicate row
 * markup" guidance). Same fields the old panel's Timeline tab rendered (`type`, `description`,
 * `date`, `amount`); no new data.
 */
export function PersonTransactionRow({ item }: { item: PersonActivityItem }) {
  const received = item.type === "received";
  return (
    <div className="flex items-center gap-3 px-1 py-3.5">
      <span
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-full",
          received ? "bg-success/16 text-success" : "bg-expense/12 text-expense",
        )}
        aria-hidden
      >
        {received ? <ArrowDownToLine className="size-4" /> : <ArrowUpFromLine className="size-4" />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{item.description}</p>
        {/* Color is never the only signal — the label spells out received/paid alongside the tint. */}
        <p className="truncate text-xs text-muted-foreground">
          {received ? "Received" : "Paid"} · {item.date}
        </p>
      </div>
      <p className={cn("shrink-0 text-right text-sm font-semibold tabular-nums", received ? "text-success" : "text-expense")}>
        {received ? "+" : "-"}
        {formatCurrency(item.amount)}
      </p>
    </div>
  );
}
