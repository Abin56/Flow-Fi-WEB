"use client";

import { CalendarClock, ChevronDown, CircleCheck, CreditCard, Landmark, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { ClayBadge } from "@/components/clay/clay-badge";
import { CurrencyCell } from "@/components/finance";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency } from "@/lib/format";
import type { DueItem, DueSource } from "@/lib/engines/upcoming-dues";
import { UPCOMING_DUES_HORIZON_DAYS, useUpcomingDues } from "@/features/bills/hooks/use-upcoming-dues";
import { cn } from "@/lib/utils";

type SourceFilter = "all" | DueSource;

const SOURCE_META: Record<
  DueSource,
  { label: string; totalLabel: string; icon: LucideIcon; tone: "primary" | "purple" | "warning"; iconClass: string }
> = {
  creditCard: { label: "Credit Card", totalLabel: "Credit Card Due", icon: CreditCard, tone: "purple", iconClass: "bg-purple/12 text-purple" },
  loan: { label: "Loan", totalLabel: "Loan Installments", icon: Landmark, tone: "primary", iconClass: "bg-primary/12 text-primary-accent-text" },
  emi: { label: "EMI", totalLabel: "EMI Installments", icon: CalendarClock, tone: "warning", iconClass: "bg-warning/15 text-warning" },
};

const SOURCES: DueSource[] = ["creditCard", "loan", "emi"];

/** Rows shown before "Show all" — keeps a long month scannable. */
const COLLAPSED_ROW_LIMIT = 8;

const DAY_MS = 24 * 60 * 60 * 1000;

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

function dayStart(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function daysFromToday(d: Date, today: number): number {
  return Math.round((dayStart(d) - today) / DAY_MS);
}

function relativeLabel(days: number): string {
  if (days < -1) return `${-days} days overdue`;
  if (days === -1) return "Yesterday";
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  return `In ${days} days`;
}

function shortDate(d: Date): string {
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

interface DueGroup {
  dayKey: number;
  days: number;
  date: Date;
  items: DueItem[];
  /** Sum of the rows that count toward the total (card-statement-included rows are excluded). */
  subtotal: number;
}

function groupByDay(items: DueItem[], today: number): DueGroup[] {
  const groups = new Map<number, DueGroup>();
  for (const item of items) {
    const dayKey = dayStart(item.dueDate);
    let group = groups.get(dayKey);
    if (!group) {
      group = { dayKey, days: daysFromToday(item.dueDate, today), date: item.dueDate, items: [], subtotal: 0 };
      groups.set(dayKey, group);
    }
    group.items.push(item);
    if (item.countsTowardTotal) group.subtotal += item.amount;
  }
  return [...groups.values()].sort((a, b) => a.dayKey - b.dayKey);
}

/**
 * Credit Card, Loan and EMI dues on the Bills page — each row names its source, and the totals
 * count every obligation once (see `lib/engines/upcoming-dues.ts`). Read-only: paying still happens
 * on the card/Loan/EMI itself, so nothing here can create a second record of the same money.
 *
 * Presentation only: the source tiles filter the list, rows are grouped by due date, and a long
 * month collapses behind "Show all". Totals always come from the engine, never from the filter.
 */
export function UpcomingDuesSection() {
  const { items, totals, isLoading } = useUpcomingDues();
  const [filter, setFilter] = useState<SourceFilter>("all");
  const [expanded, setExpanded] = useState(false);

  const countBySource = useMemo(() => {
    const counts: Record<DueSource, number> = { creditCard: 0, loan: 0, emi: 0 };
    for (const item of items) counts[item.source] += 1;
    return counts;
  }, [items]);

  const visibleItems = useMemo(() => (filter === "all" ? items : items.filter((i) => i.source === filter)), [items, filter]);
  const shownItems = expanded ? visibleItems : visibleItems.slice(0, COLLAPSED_ROW_LIMIT);
  const hiddenCount = visibleItems.length - shownItems.length;

  const today = dayStart(new Date());
  const groups = useMemo(() => groupByDay(shownItems, today), [shownItems, today]);

  if (isLoading) {
    return <Skeleton className="h-40 rounded-3xl" />;
  }

  return (
    <section className="flex flex-col gap-4 rounded-3xl border border-border/60 bg-card p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 className="font-heading text-base font-semibold text-foreground">Card, Loan &amp; EMI Dues</h2>
          <p className="text-xs text-muted-foreground">
            Overdue and due in the next {UPCOMING_DUES_HORIZON_DAYS} days
            {items.length > 0 && ` · ${items.length} ${items.length === 1 ? "payment" : "payments"}`}
          </p>
        </div>
        <div className="flex flex-col items-end gap-0.5">
          <span className="font-mono text-2xl font-semibold tabular-nums leading-none text-foreground">{formatCurrency(totals.total)}</span>
          {totals.overdue > 0 ? (
            <span className="text-xs font-medium text-expense">{formatCurrency(totals.overdue)} overdue</span>
          ) : (
            <span className="text-xs text-muted-foreground">total to pay</span>
          )}
        </div>
      </div>

      <div role="group" aria-label="Filter dues by type" className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {SOURCES.map((source) => {
          const meta = SOURCE_META[source];
          const Icon = meta.icon;
          const active = filter === source;
          return (
            <button
              key={source}
              type="button"
              aria-pressed={active}
              onClick={() => {
                setFilter(active ? "all" : source);
                setExpanded(false);
              }}
              className={cn(
                "flex items-center gap-3 rounded-2xl border px-3 py-2.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                active ? "border-primary/50 bg-primary/10" : "border-transparent bg-muted/40 hover:bg-muted/60",
              )}
            >
              <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-xl", meta.iconClass)}>
                <Icon className="size-4" />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-xs font-medium text-muted-foreground">{meta.totalLabel}</span>
                <span className="font-mono text-sm font-semibold tabular-nums text-foreground">{formatCurrency(totals[source])}</span>
              </span>
              <span className="shrink-0 rounded-full bg-background/70 px-2 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground">
                {countBySource[source]}
              </span>
            </button>
          );
        })}
      </div>

      {totals.includedInCardBills > 0 && (
        <p className="rounded-xl bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          {formatCurrency(totals.includedInCardBills)}{" "}
          of card-linked installments is already part of a card statement, so it&apos;s shown below but not added again.
        </p>
      )}

      {items.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-2xl bg-muted/30 px-3 py-8 text-center">
          <CircleCheck className="size-6 text-success" />
          <p className="text-sm font-medium text-foreground">You&apos;re all clear</p>
          <p className="text-xs text-muted-foreground">No card, loan or EMI payments due in the next {UPCOMING_DUES_HORIZON_DAYS} days.</p>
        </div>
      ) : visibleItems.length === 0 ? (
        <p className="rounded-2xl bg-muted/30 px-3 py-6 text-center text-sm text-muted-foreground">
          No {SOURCE_META[filter as DueSource].label} payments due in the next {UPCOMING_DUES_HORIZON_DAYS} days.
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map((group) => {
            const overdue = group.days < 0;
            return (
              <div key={group.dayKey} className="flex flex-col gap-1">
                <div className="flex items-center justify-between gap-2 px-1">
                  <div className="flex items-center gap-2">
                    <span className={cn("text-xs font-semibold tracking-wide uppercase", overdue ? "text-expense" : "text-foreground")}>
                      {shortDate(group.date)}
                    </span>
                    <span className={cn("text-xs", overdue ? "font-medium text-expense" : "text-muted-foreground")}>
                      {relativeLabel(group.days)}
                    </span>
                  </div>
                  <span className="font-mono text-xs font-medium tabular-nums text-muted-foreground">
                    {group.items.length > 1 && `${group.items.length} payments · `}
                    {group.subtotal > 0 || group.items.some((i) => i.countsTowardTotal) ? formatCurrency(group.subtotal) : "In card bill"}
                  </span>
                </div>
                <ul className="flex flex-col divide-y divide-border/50 rounded-2xl border border-border/50 bg-background/40">
                  {group.items.map((item) => {
                    const meta = SOURCE_META[item.source];
                    const Icon = meta.icon;
                    const detail = detailLine(item);
                    return (
                      <li key={item.key}>
                        <Link
                          href={hrefFor(item)}
                          className="flex items-center gap-3 rounded-2xl px-3 py-2.5 outline-none transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-xl", meta.iconClass)}>
                            <Icon className="size-4" />
                          </span>
                          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                              <span className="truncate text-sm font-semibold text-foreground">{item.title}</span>
                              <ClayBadge tone={meta.tone}>{meta.label}</ClayBadge>
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
                            {!item.countsTowardTotal && <span className="text-[11px] text-muted-foreground">In card bill</span>}
                          </div>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}

          {(hiddenCount > 0 || expanded) && visibleItems.length > COLLAPSED_ROW_LIMIT && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              className="mx-auto flex items-center gap-1.5 rounded-full bg-muted/50 px-4 py-1.5 text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
            >
              {expanded ? "Show fewer" : `Show all ${visibleItems.length} (${hiddenCount} more)`}
              <ChevronDown className={cn("size-3.5 transition-transform", expanded && "rotate-180")} />
            </button>
          )}
        </div>
      )}
    </section>
  );
}
