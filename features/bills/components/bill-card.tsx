"use client";

import { Landmark, Repeat, type LucideIcon } from "lucide-react";
import { StaggerItem } from "@/components/foundation/animated-container";
import { ClayBadge } from "@/components/clay/clay-badge";
import { CurrencyCell, DateCell } from "@/components/finance";
import { billOccurrenceStatus, type BillStatus } from "@/lib/models/bill";
import type { BillRow } from "@/features/bills/hooks/use-bills-data";

const STATUS_TONE: Record<BillStatus, "success" | "warning" | "expense" | "neutral" | "primary"> = {
  paid: "success",
  partiallyPaid: "warning",
  skipped: "neutral",
  overdue: "expense",
  dueToday: "warning",
  upcoming: "primary",
};

const STATUS_LABEL: Record<BillStatus, string> = {
  paid: "Paid",
  partiallyPaid: "Partially Paid",
  skipped: "Skipped",
  overdue: "Overdue",
  dueToday: "Due Today",
  upcoming: "Upcoming",
};

const RECURRENCE_LABEL: Record<string, string> = {
  oneTime: "One-time",
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
  yearly: "Yearly",
  custom: "Custom",
};

export function BillCard({ row, onClick }: { row: BillRow; onClick: () => void }) {
  const { bill, occurrence, account, category } = row;
  const status = occurrence ? billOccurrenceStatus(occurrence) : "upcoming";
  const Icon: LucideIcon = Repeat;

  return (
    <StaggerItem>
      <button
        type="button"
        onClick={onClick}
        className="flex w-full flex-col gap-3 rounded-3xl border border-border/60 bg-card p-4 text-left transition-shadow hover:shadow-e1"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary">
              <Icon className="size-4" />
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-foreground">{bill.name}</p>
              <p className="truncate text-xs text-muted-foreground">{category?.name ?? RECURRENCE_LABEL[bill.recurrence]}</p>
            </div>
          </div>
          <ClayBadge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</ClayBadge>
        </div>

        <div className="flex items-center justify-between text-sm">
          <CurrencyCell amount={-(occurrence?.amount ?? bill.amount)} className="text-base font-semibold" />
          <DateCell date={occurrence?.dueDate ?? bill.nextDueDate} />
        </div>

        {account && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Landmark className="size-3.5" />
            {account.name}
          </div>
        )}
      </button>
    </StaggerItem>
  );
}

export { RECURRENCE_LABEL };
