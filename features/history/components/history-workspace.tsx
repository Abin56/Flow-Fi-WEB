"use client";

/**
 * The unified History feed — direct UI port of Finance_App's History screen
 * (`lib/features/transactions/presentation/screens` + its `historyEntriesProvider`
 * data), built from `useHistoryEntries` (`features/history/hooks/use-history-data.ts`).
 * Filter chips mirror `HistoryCategory`'s filter set exactly: All / Transactions /
 * Shared expenses / Loans / Bills / EMI / Money received (statement generated/paid
 * rows have no dedicated chip in the Flutter source either — they only ever show
 * under "All").
 */

import { ArrowDownToLine, CreditCard, History as HistoryIcon, Landmark, ReceiptText, Wallet } from "lucide-react";
import { useMemo, useState } from "react";
import { ChipRow } from "@/components/finance/chip-row";
import { EmptyState } from "@/components/finance/empty-state";
import { StatusChip } from "@/components/finance/status-chip";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency } from "@/lib/format";
import { historyCategoryLabel, splitExpenseHistoryStatusLabel, type HistoryCategory } from "@/lib/models/history";
import { useHistoryEntries } from "@/features/history/hooks/use-history-data";
import { cn } from "@/lib/utils";

type FilterValue = "all" | HistoryCategory;

const FILTERS: { value: FilterValue; label: string }[] = [
  { value: "all", label: "All" },
  { value: "transaction", label: "Transactions" },
  { value: "splitExpense", label: "Shared expenses" },
  { value: "loan", label: "Loans" },
  { value: "bill", label: "Bills" },
  { value: "emi", label: "EMI" },
  { value: "moneyReceived", label: "Money received" },
];

const CATEGORY_ICON: Record<HistoryCategory, typeof HistoryIcon> = {
  transaction: Wallet,
  splitExpense: Wallet,
  loan: Landmark,
  bill: ReceiptText,
  emi: Wallet,
  moneyReceived: ArrowDownToLine,
  statementGenerated: CreditCard,
  statementPaid: CreditCard,
};

const SPLIT_STATUS_TONE: Record<string, "success" | "neutral" | "expense" | "warning"> = {
  pending: "neutral",
  partial: "warning",
  overdue: "expense",
  completed: "success",
};

function formatEntryDate(date: Date, now: Date): string {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.round((today.getTime() - target.getTime()) / (24 * 60 * 60 * 1000));
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return date.toLocaleDateString("en-IN", { weekday: "long", month: "short", day: "numeric" });
}

export function HistoryWorkspace() {
  const { entries, isLoading } = useHistoryEntries();
  const [filter, setFilter] = useState<FilterValue>("all");

  const filtered = useMemo(
    () => (filter === "all" ? entries : entries.filter((e) => e.category === filter)),
    [entries, filter],
  );

  const groups = useMemo(() => {
    const now = new Date();
    const byLabel = new Map<string, typeof filtered>();
    for (const entry of filtered) {
      const label = formatEntryDate(entry.date, now);
      byLabel.set(label, [...(byLabel.get(label) ?? []), entry]);
    }
    return Array.from(byLabel.entries());
  }, [filtered]);

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="font-heading text-2xl font-semibold tracking-tight">History</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every transaction, shared expense settlement, loan/bill/EMI payment, and statement event — in one feed.
        </p>
      </div>

      <ChipRow options={FILTERS} value={filter} onChange={setFilter} />

      {isLoading ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full rounded-2xl" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState icon={HistoryIcon} title="Nothing here yet" description="Entries will show up as money moves." />
      ) : (
        <div className="flex flex-col gap-5">
          {groups.map(([label, rows]) => (
            <div key={label}>
              <p className="mb-2 px-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{label}</p>
              <div className="surface-flat flex flex-col divide-y divide-border/50 rounded-2xl border border-border/50">
                {rows.map((entry) => {
                  const Icon = CATEGORY_ICON[entry.category];
                  return (
                    <div key={entry.id} className="flex items-start gap-3 p-4">
                      <span
                        className={cn(
                          "mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full",
                          entry.isCredit ? "bg-success/16 text-success" : "bg-expense/12 text-expense",
                        )}
                      >
                        <Icon className="size-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <p className="truncate text-sm font-medium text-foreground">{entry.title}</p>
                          <p className={cn("shrink-0 text-sm font-semibold tabular-nums", entry.isCredit ? "text-success" : "text-expense")}>
                            {entry.isCredit ? "+" : "-"}
                            {formatCurrency(entry.amount)}
                          </p>
                        </div>
                        {entry.subtitle && <p className="truncate text-xs text-muted-foreground">{entry.subtitle}</p>}
                        <div className="mt-1 flex flex-wrap items-center gap-2">
                          <span className="text-[11px] text-muted-foreground">{historyCategoryLabel(entry.category)}</span>
                          {entry.excludeFromCalculations && (
                            <StatusChip label="Excluded" tone="neutral" />
                          )}
                          {entry.splitExpenseDetail && (
                            <StatusChip
                              label={splitExpenseHistoryStatusLabel(entry.splitExpenseDetail.status)}
                              tone={SPLIT_STATUS_TONE[entry.splitExpenseDetail.status]}
                            />
                          )}
                        </div>
                        {entry.splitExpenseDetail && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            You {formatCurrency(entry.splitExpenseDetail.myShare)} ·{" "}
                            {entry.splitExpenseDetail.participantCount - 1} other
                            {entry.splitExpenseDetail.participantCount - 1 === 1 ? "" : "s"}{" "}
                            {entry.splitExpenseDetail.amountToCollect > 0
                              ? `· ${formatCurrency(entry.splitExpenseDetail.amountToCollect)} to collect`
                              : "· settled"}
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
