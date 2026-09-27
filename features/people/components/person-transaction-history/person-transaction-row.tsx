import { ArrowDownToLine, ArrowUpFromLine } from "lucide-react";
import { formatCurrency } from "@/lib/format";
import type { PersonActivityItem } from "@/features/people/hooks/use-people-data";
import { cn } from "@/lib/utils";

/**
 * Shared row markup for the person transaction-history surface — used inside both the desktop
 * dialog and the mobile sheet (no separate mobile/desktop row markup, per the "don't duplicate row
 * markup" guidance). Same fields the old panel's Timeline tab rendered (`type`, `description`,
 * `date`, `amount`); no new data.
 *
 * A "gave"/"borrowed" entry with a remaining balance is clickable — it opens the settle-this-
 * transaction flow (`onSettle`), scoped to that one entry via `parentEntryId`. A fully-settled
 * "gave"/"borrowed" entry, and every "repaid"/"receivedBack" settlement entry itself, render inert.
 */
export function PersonTransactionRow({ item, onSettle }: { item: PersonActivityItem; onSettle?: (item: PersonActivityItem) => void }) {
  const received = item.type === "received";
  const settleable = item.remainingAmount != null && item.remainingAmount > 0 && !!onSettle;

  const content = (
    <>
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
        <p className="truncate text-xs text-muted-foreground">
          {received ? "Received" : "Paid"} · {item.date}
          {item.remainingAmount != null && item.remainingAmount > 0 && ` · ${formatCurrency(item.remainingAmount)} remaining`}
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <p className={cn("text-right text-sm font-semibold tabular-nums", received ? "text-success" : "text-expense")}>
          {received ? "+" : "-"}
          {formatCurrency(item.amount)}
        </p>
      </div>
    </>
  );

  if (settleable) {
    return (
      <button
        type="button"
        onClick={() => onSettle?.(item)}
        className="flex w-full items-center gap-3 rounded-lg px-1 py-3.5 text-left transition-colors hover:bg-muted/50"
      >
        {content}
      </button>
    );
  }

  return <div className="flex items-center gap-3 px-1 py-3.5">{content}</div>;
}
