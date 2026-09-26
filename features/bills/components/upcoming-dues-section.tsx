"use client";

import { CalendarClock, CreditCard, Landmark, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { ClayBadge } from "@/components/clay/clay-badge";
import { CurrencyCell, DateCell } from "@/components/finance";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency } from "@/lib/format";
import type { DueItem, DueSource } from "@/lib/engines/upcoming-dues";
import { UPCOMING_DUES_HORIZON_DAYS, useUpcomingDues } from "@/features/bills/hooks/use-upcoming-dues";
import { cn } from "@/lib/utils";

const SOURCE_META: Record<DueSource, { label: string; totalLabel: string; icon: LucideIcon; tone: "primary" | "purple" | "warning" }> = {
  creditCard: { label: "Credit Card", totalLabel: "Credit Card Due", icon: CreditCard, tone: "purple" },
  loan: { label: "Loan", totalLabel: "Loan Installments", icon: Landmark, tone: "primary" },
  emi: { label: "EMI", totalLabel: "EMI Installments", icon: CalendarClock, tone: "warning" },
};

function hrefFor(item: DueItem): string {
  if (item.source === "creditCard") return "/credit-cards";
  // Same deep links the Loans & Installments workspace uses (`agreementDetailHref`).
  return `/${item.source === "loan" ? "loans" : "emi"}?agreement=${encodeURIComponent(item.sourceId)}`;
}

function detailLine(item: DueItem): string {
  return [
    item.installmentNumber != null ? `Installment ${item.installmentNumber} of ${item.installmentCount}` : null,
    item.subtitle,
    item.cardLabel ? `On ${item.cardLabel}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Credit Card, Loan and EMI dues on the Bills page — each row names its source, and the totals
 * count every obligation once (see `lib/engines/upcoming-dues.ts`). Read-only: paying still happens
 * on the card/Loan/EMI itself, so nothing here can create a second record of the same money.
 */
export function UpcomingDuesSection() {
  const { items, totals, isLoading } = useUpcomingDues();

  if (isLoading) {
    return <Skeleton className="h-40 rounded-3xl" />;
  }

  return (
    <section className="flex flex-col gap-4 rounded-3xl border border-border/60 bg-card p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <h2 className="font-heading text-base font-semibold text-foreground">Card, Loan &amp; EMI Dues</h2>
          <p className="text-xs text-muted-foreground">Overdue and due in the next {UPCOMING_DUES_HORIZON_DAYS} days</p>
        </div>
        <div className="flex flex-col items-end gap-0.5">
          <span className="font-mono text-xl font-semibold tabular-nums text-foreground">{formatCurrency(totals.total)}</span>
          {totals.overdue > 0 && <span className="text-xs font-medium text-expense">{formatCurrency(totals.overdue)} overdue</span>}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {(["creditCard", "loan", "emi"] as DueSource[]).map((source) => {
          const meta = SOURCE_META[source];
          const Icon = meta.icon;
          return (
            <div key={source} className="flex items-center justify-between gap-2 rounded-2xl bg-muted/40 px-3 py-2.5">
              <span className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <Icon className="size-3.5" />
                {meta.totalLabel}
              </span>
              <span className="font-mono text-sm font-semibold tabular-nums text-foreground">{formatCurrency(totals[source])}</span>
            </div>
          );
        })}
      </div>

      {totals.includedInCardBills > 0 && (
        <p className="text-xs text-muted-foreground">
          {formatCurrency(totals.includedInCardBills)} of card-linked installments is already part of a card statement, so it&apos;s
          shown below but not added again.
        </p>
      )}

      {items.length === 0 ? (
        <p className="rounded-2xl bg-muted/30 px-3 py-4 text-center text-sm text-muted-foreground">
          No card, loan or EMI payments due in the next {UPCOMING_DUES_HORIZON_DAYS} days.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border/60">
          {items.map((item) => {
            const meta = SOURCE_META[item.source];
            const Icon = meta.icon;
            const detail = detailLine(item);
            return (
              <li key={item.key}>
                <Link
                  href={hrefFor(item)}
                  className="flex items-center gap-3 rounded-xl px-1 py-3 outline-none transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary-accent-text">
                    <Icon className="size-4" />
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                      <ClayBadge tone={meta.tone}>{meta.label}</ClayBadge>
                      <span className="truncate text-sm font-semibold text-foreground">{item.title}</span>
                      {item.forPersonName && <ClayBadge tone="neutral">For {item.forPersonName}</ClayBadge>}
                      {item.overdue && <ClayBadge tone="expense">Overdue</ClayBadge>}
                    </div>
                    {detail && <p className="truncate text-xs text-muted-foreground">{detail}</p>}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-0.5">
                    <CurrencyCell
                      amount={item.amount}
                      signed={false}
                      className={cn("text-sm font-semibold", !item.countsTowardTotal && "text-muted-foreground")}
                    />
                    <DateCell date={item.dueDate} className="text-xs" />
                    {!item.countsTowardTotal && <span className="text-[11px] text-muted-foreground">In card bill</span>}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
