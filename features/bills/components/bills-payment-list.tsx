"use client";

import { ArrowRight, CalendarClock, ChevronDown, CircleCheck, CreditCard, Landmark, Receipt, Smartphone, Wallet, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { ClayButton } from "@/components/clay/clay-button";
import type { BillsOverviewData } from "@/features/bills/hooks/use-bills-overview";
import { DEFAULT_FILTERS, filterObligations, filterPaid, kindCounts, type BillsFilters, type KindFilter, type StatusFilter } from "@/features/bills/lib/bills-overview";
import { daysUntil, type CompletedGroup, type ObligationItem, type ObligationKind, type ObligationStatus } from "@/features/my-money/lib/my-money";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";

const KIND_ICON: Record<ObligationKind, LucideIcon> = { card: CreditCard, loan: Landmark, emi: Smartphone, bill: Receipt };
/** Source module, in the words the rest of the app uses. */
const KIND_LABEL: Record<ObligationKind, string> = { card: "Credit card", loan: "Loan", emi: "EMI", bill: "Bill" };

const KIND_FILTERS: { value: KindFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "bill", label: "Bills" },
  { value: "loan", label: "Loans" },
  { value: "emi", label: "EMIs" },
  { value: "card", label: "Credit cards" },
];
const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "Any status" },
  { value: "overdue", label: "Overdue" },
  { value: "dueSoon", label: "Due soon" },
  { value: "upcoming", label: "Upcoming" },
  { value: "partial", label: "Partially paid" },
  { value: "paid", label: "Paid" },
];

const STATUS_LABEL: Record<ObligationStatus, string> = { overdue: "Overdue", dueToday: "Due today", dueSoon: "Due soon", upcoming: "Upcoming", paid: "Paid" };
const STATUS_CHIP: Record<ObligationStatus, string> = {
  overdue: "bg-expense/12 text-expense ring-1 ring-expense/25",
  dueToday: "bg-warning/20 text-warning-foreground ring-1 ring-warning/40",
  dueSoon: "bg-warning/12 text-warning-foreground ring-1 ring-warning/30",
  upcoming: "bg-secondary text-foreground/80 ring-1 ring-border-strong/60",
  paid: "bg-success/12 text-success ring-1 ring-success/25",
};
const TILE_TONE: Record<ObligationStatus, string> = {
  overdue: "bg-expense/10 text-expense ring-expense/30",
  dueToday: "bg-warning/18 text-warning-foreground ring-warning/45",
  dueSoon: "bg-warning/12 text-warning-foreground ring-warning/35",
  upcoming: "bg-secondary/70 text-foreground ring-border-strong/60",
  paid: "bg-success/10 text-success ring-success/30",
};

const ACTION =
  "inline-flex h-8 shrink-0 items-center gap-1 rounded-[7px] border border-border-strong bg-card px-2.5 text-xs font-semibold text-foreground transition-colors hover:border-primary-accent-text/60 hover:bg-primary/10 focus-visible:ring-2 focus-visible:ring-primary-accent-text focus-visible:outline-none";
const GROUP_HEADING =
  "flex w-full items-center gap-2 border-t border-border-strong/40 bg-secondary/50 px-4 py-1.5 text-[11px] font-bold tracking-[0.06em] text-foreground/75 uppercase first:border-t-0 sm:px-5";
const CHIP_BASE = "inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-xs font-semibold whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:ring-primary-accent-text focus-visible:outline-none";

function shortDate(d: Date): string {
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

/** Row-level due text — relative, since the date tile already shows the date. */
function relativeDue(item: ObligationItem, now: Date): string {
  const days = daysUntil(item.dueDate, now);
  if (days < 0) return `${-days} day${days === -1 ? "" : "s"} overdue`;
  if (days === 0) return "Due today";
  if (days === 1) return "Due tomorrow";
  return `Due in ${days} days`;
}

function Chip({ className, children }: { className: string; children: React.ReactNode }) {
  return <span className={cn("inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[11px] font-semibold whitespace-nowrap", className)}>{children}</span>;
}

function DateTile({ date, status, muted }: { date: Date; status: ObligationStatus; muted: boolean }) {
  return (
    <span
      aria-hidden
      className={cn("flex w-11 shrink-0 flex-col items-center justify-center rounded-[9px] py-1 ring-1", muted ? "bg-muted text-foreground/60 ring-border-strong/50" : TILE_TONE[status])}
    >
      <span className="text-[10px] leading-none font-semibold tracking-[0.06em] uppercase opacity-85">{date.toLocaleDateString("en-IN", { month: "short" })}</span>
      <span className="font-heading text-lg leading-tight font-bold tabular-nums">{date.getDate()}</span>
    </span>
  );
}

// ───────────────────────────── rows ─────────────────────────────

interface RowHandlers {
  /** Open a regular bill's detail panel (its Skip / Edit / Delete / payment history). */
  onOpenBill: (billId: string) => void;
  /** Pay a regular bill's exact cycle in place — the existing Pay dialog. */
  onPayBill: (item: ObligationItem) => void;
}

function ObligationRow({ item, now, handlers, covered = false }: { item: ObligationItem; now: Date; handlers: RowHandlers; covered?: boolean }) {
  const Icon = KIND_ICON[item.kind];
  const partial = item.amountPaid > 0 && item.remaining > 0;
  const paidPercent = item.amountDue > 0 ? Math.min(100, Math.round((item.amountPaid / item.amountDue) * 100)) : 0;
  const muted = covered || !item.countsTowardTotal;
  const urgent = item.status === "overdue" || item.status === "dueToday" || item.status === "dueSoon";

  const body = (
    <>
      <DateTile date={item.dueDate} status={item.status} muted={muted} />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="truncate text-sm font-semibold text-foreground">{item.title}</span>
          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-foreground/65">
            <Icon className="size-3 shrink-0" strokeWidth={2} aria-hidden />
            {KIND_LABEL[item.kind]}
          </span>
        </span>
        <span className="truncate text-xs text-foreground/70">{item.detail}</span>
        <span className="flex flex-wrap items-center gap-1.5">
          {urgent && <Chip className={STATUS_CHIP[item.status]}>{STATUS_LABEL[item.status]}</Chip>}
          {!urgent && !muted && <Chip className={STATUS_CHIP.upcoming}>{STATUS_LABEL.upcoming}</Chip>}
          {partial && <Chip className="bg-warning/12 text-warning-foreground ring-1 ring-warning/30">Partially paid</Chip>}
          {item.carriedForward && <Chip className="bg-secondary text-foreground/80 ring-1 ring-border-strong/60">From an earlier cycle</Chip>}
          {item.billStillOpen && <Chip className="bg-secondary text-foreground/80 ring-1 ring-border-strong/60">Bill still open</Chip>}
          {muted && <Chip className="bg-muted text-foreground/75 ring-1 ring-border-strong/60">Not added to totals</Chip>}
          <span className={cn("text-xs", item.status === "overdue" ? "font-semibold text-expense" : "text-foreground/75")}>{relativeDue(item, now)}</span>
          {item.related && !muted && (
            <span className="inline-flex min-w-0 items-center gap-1 text-xs text-foreground/70">
              <Wallet className="size-3 shrink-0" aria-hidden />
              <span className="truncate">{item.related}</span>
            </span>
          )}
        </span>
        {partial && (
          <span className="mt-0.5 flex items-center gap-2">
            <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-secondary" role="progressbar" aria-valuenow={paidPercent} aria-valuemin={0} aria-valuemax={100} aria-label="Paid so far">
              <span className="block h-full rounded-full bg-success" style={{ width: `${paidPercent}%` }} />
            </span>
            <span className="shrink-0 text-[11px] text-foreground/75 tabular-nums">{formatCurrency(item.amountPaid)} paid</span>
          </span>
        )}
        {item.note && <span className="text-xs text-foreground/70">{item.note}</span>}
        {item.kind === "card" && item.minimumDue != null && item.minimumDue > 0 && item.amountPaid === 0 && (
          <span className="text-xs text-foreground/70">Minimum due {formatCurrency(item.minimumDue)}</span>
        )}
        {item.agreementRemaining && item.agreementRemaining.amount > 0 && !muted && (
          <span className="text-xs text-foreground/70">
            {item.agreementRemaining.label} {formatCurrency(item.agreementRemaining.amount)}
          </span>
        )}
        {item.billStillOpen && <span className="text-xs text-foreground/70">Amount so far — new purchases until the statement closes are added.</span>}
      </span>
    </>
  );

  const bodyClass = "flex min-w-0 flex-1 items-start gap-3 rounded-[10px] text-left outline-none focus-visible:ring-2 focus-visible:ring-primary-accent-text";

  return (
    <li
      data-testid="bills-row"
      data-kind={item.kind}
      className={cn(
        "flex items-start gap-3 border-l-[3px] px-4 py-3 transition-colors hover:bg-secondary/40 sm:px-5",
        muted ? "border-l-transparent" : item.status === "overdue" ? "border-l-expense" : item.status === "dueToday" || item.status === "dueSoon" ? "border-l-warning" : "border-l-transparent",
      )}
    >
      {item.kind === "bill" ? (
        <button type="button" onClick={() => handlers.onOpenBill(item.sourceId)} className={bodyClass}>
          {body}
        </button>
      ) : (
        <Link href={item.href} className={bodyClass}>
          {body}
        </Link>
      )}
      <div className="flex shrink-0 flex-col items-end gap-1.5">
        <div className="text-right">
          <p className={cn("text-[15px] leading-tight font-bold tabular-nums", muted ? "text-foreground/60" : "text-foreground")}>{formatCurrency(item.remaining)}</p>
          {partial && <p className="text-[11px] text-foreground/65 tabular-nums">of {formatCurrency(item.amountDue)}</p>}
        </div>
        {covered ? (
          <Link href={item.href} className={ACTION} aria-label={`View ${item.title}`}>
            View
            <ArrowRight className="size-3" strokeWidth={2.2} />
          </Link>
        ) : item.kind === "bill" ? (
          <ClayButton size="sm" onClick={() => handlers.onPayBill(item)} aria-label={`Pay now: ${item.title}`}>
            {partial ? "Pay rest" : "Pay now"}
          </ClayButton>
        ) : item.payHref ? (
          <Link href={item.payHref} className={cn(ACTION, "border-primary/40 bg-primary/10 text-primary-accent-text")} aria-label={`${item.actionLabel}: ${item.title}`}>
            {item.actionLabel}
            <ArrowRight className="size-3" strokeWidth={2.2} />
          </Link>
        ) : (
          <Link href={item.href} className={ACTION} aria-label={`${item.actionLabel}: ${item.title}`}>
            {item.actionLabel}
            <ArrowRight className="size-3" strokeWidth={2.2} />
          </Link>
        )}
        {!covered && item.kind !== "bill" && item.payHref && (
          <Link href={item.href} className="text-[11px] font-semibold text-foreground/70 hover:text-foreground hover:underline" aria-label={`View ${item.title}`}>
            View {item.kind === "card" ? "card" : "agreement"}
          </Link>
        )}
      </div>
    </li>
  );
}

function PaidRow({ group, handlers }: { group: CompletedGroup; handlers: RowHandlers }) {
  const Icon = KIND_ICON[group.kind];
  const detail =
    group.payments > 0
      ? `${group.payments} payment${group.payments === 1 ? "" : "s"}${group.lastDate ? ` · last ${shortDate(group.lastDate)}` : ""}${group.undatedAmount > 0 ? ` · ${formatCurrency(group.undatedAmount)} paid earlier, date not recorded` : ""}`
      : "Paid earlier — payment date not recorded";
  const body = (
    <>
      <span aria-hidden className="flex size-11 shrink-0 items-center justify-center rounded-[9px] bg-success/10 text-success ring-1 ring-success/30">
        <CircleCheck className="size-5" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 flex-wrap items-center gap-x-2">
          <span className="truncate text-sm font-semibold text-foreground">{group.title}</span>
          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-foreground/65">
            <Icon className="size-3 shrink-0" strokeWidth={2} aria-hidden />
            {KIND_LABEL[group.kind]}
          </span>
        </span>
        <span className="text-xs text-foreground/70">{detail}</span>
      </span>
    </>
  );
  const bodyClass = "flex min-w-0 flex-1 items-center gap-3 rounded-[10px] text-left outline-none focus-visible:ring-2 focus-visible:ring-primary-accent-text";
  return (
    <li data-testid="bills-paid-row" className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-secondary/40 sm:px-5">
      {group.kind === "bill" ? (
        <button type="button" onClick={() => handlers.onOpenBill(group.sourceId)} className={bodyClass}>
          {body}
        </button>
      ) : (
        <Link href={group.href} className={bodyClass}>
          {body}
        </Link>
      )}
      <div className="shrink-0 text-right">
        <p className="text-[15px] leading-tight font-bold text-success tabular-nums">{formatCurrency(group.amount)}</p>
        <p className="text-[11px] text-foreground/65">paid</p>
      </div>
    </li>
  );
}

// ───────────────────────────── sections ─────────────────────────────

function Section({ title, hint, count, total, tone, children }: { title: string; hint?: string; count: number; total?: number; tone?: "attention"; children: React.ReactNode }) {
  if (count === 0) return null;
  return (
    <section aria-label={title}>
      <h3 className={GROUP_HEADING}>
        {tone === "attention" && <span aria-hidden className="size-1.5 rounded-full bg-expense" />}
        <span>{title}</span>
        <span className="text-foreground/60 tabular-nums">· {count}</span>
        {hint && <span className="hidden font-medium tracking-normal normal-case text-foreground/60 sm:inline">{hint}</span>}
        {total != null && <span className="ml-auto tracking-normal text-foreground normal-case tabular-nums">{formatCurrency(total)}</span>}
      </h3>
      <ul className="divide-y divide-border-strong/40">{children}</ul>
    </section>
  );
}

const sum = (items: readonly ObligationItem[]) => Math.round(items.reduce((s, i) => s + i.remaining, 0) * 100) / 100;

/**
 * Filters + the cycle's payments in sections: overdue, due this cycle, upcoming (next cycle), paid, and the
 * installments already inside a card statement. Presentation only — what each section holds is decided by
 * `buildBillsOverview`; filtering never changes a headline total.
 */
export function BillsPaymentList({ data, handlers }: { data: BillsOverviewData; handlers: RowHandlers }) {
  const [filters, setFilters] = useState<BillsFilters>(DEFAULT_FILTERS);
  const [coveredOpen, setCoveredOpen] = useState(false);
  const { now } = data;

  const counts = useMemo(() => kindCounts(data), [data]);
  const overdue = useMemo(() => filterObligations(data.overdue, filters), [data.overdue, filters]);
  const dueThisCycle = useMemo(() => filterObligations(data.dueThisCycle, filters), [data.dueThisCycle, filters]);
  const upcoming = useMemo(() => filterObligations(data.upcoming, filters), [data.upcoming, filters]);
  const covered = useMemo(() => filterObligations(data.coveredElsewhere, filters), [data.coveredElsewhere, filters]);
  const paid = useMemo(() => filterPaid(data.paid, filters), [data.paid, filters]);

  const filtered = filters.kind !== "all" || filters.status !== "all";
  const shown = overdue.length + dueThisCycle.length + upcoming.length + covered.length + paid.length;
  const nothingAtAll = data.overdue.length + data.dueThisCycle.length + data.upcoming.length + data.coveredElsewhere.length + data.paid.length === 0;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2" data-testid="bills-filters">
        <div role="group" aria-label="Filter by type" className="flex flex-wrap items-center gap-1.5">
          {KIND_FILTERS.map(({ value, label }) => {
            const active = filters.kind === value;
            return (
              <button
                key={value}
                type="button"
                aria-pressed={active}
                onClick={() => setFilters((f) => ({ ...f, kind: value }))}
                className={cn(CHIP_BASE, active ? "bg-primary text-primary-foreground" : "bg-secondary/60 text-foreground/80 hover:bg-secondary")}
              >
                {label}
                <span className={cn("tabular-nums", active ? "opacity-80" : "text-foreground/55")}>{counts[value]}</span>
              </button>
            );
          })}
        </div>
        <div role="group" aria-label="Filter by status" className="flex flex-wrap items-center gap-1.5">
          {STATUS_FILTERS.map(({ value, label }) => {
            const active = filters.status === value;
            return (
              <button
                key={value}
                type="button"
                aria-pressed={active}
                onClick={() => setFilters((f) => ({ ...f, status: value }))}
                className={cn(CHIP_BASE, "h-6 px-2.5", active ? "bg-foreground text-background" : "text-foreground/70 ring-1 ring-border-strong/60 hover:bg-secondary/60")}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="overflow-hidden rounded-[14px] border border-border-strong/60 bg-card shadow-e1">
        {nothingAtAll ? (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
            <CircleCheck className="size-7 text-success" />
            <p className="text-sm font-semibold text-foreground">You&apos;re all clear</p>
            <p className="max-w-sm text-xs text-foreground/70">
              Nothing is owed in {data.periodLabel} or the next cycle, and no payments were recorded in it. Add a bill to start tracking due dates.
            </p>
          </div>
        ) : shown === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
            <CalendarClock className="size-6 text-foreground/50" />
            <p className="text-sm font-semibold text-foreground">No payments match these filters</p>
            {filtered && (
              <button type="button" onClick={() => setFilters(DEFAULT_FILTERS)} className={ACTION}>
                Clear filters
              </button>
            )}
          </div>
        ) : (
          <>
            <Section title="Overdue" hint="Past due — stays until paid" count={overdue.length} total={sum(overdue)} tone="attention">
              {overdue.map((item) => (
                <ObligationRow key={item.key} item={item} now={now} handlers={handlers} />
              ))}
            </Section>
            <Section title="Rest of this cycle" hint={`Not yet due · ${data.periodLabel}`} count={dueThisCycle.length} total={sum(dueThisCycle)}>
              {dueThisCycle.map((item) => (
                <ObligationRow key={item.key} item={item} now={now} handlers={handlers} />
              ))}
            </Section>
            <Section title="Upcoming" hint={`Next cycle · ${data.nextPeriodLabel}`} count={upcoming.length} total={sum(upcoming)}>
              {upcoming.map((item) => (
                <ObligationRow key={item.key} item={item} now={now} handlers={handlers} />
              ))}
            </Section>
            <Section title="Paid this cycle" hint={data.periodLabel} count={paid.length} total={Math.round(paid.reduce((s, g) => s + g.amount, 0) * 100) / 100}>
              {paid.map((group) => (
                <PaidRow key={group.key} group={group} handlers={handlers} />
              ))}
            </Section>
            {covered.length > 0 && (
              <section aria-label="Included in card bills">
                <button
                  type="button"
                  aria-expanded={coveredOpen}
                  onClick={() => setCoveredOpen((o) => !o)}
                  className={cn(GROUP_HEADING, "text-left transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-primary-accent-text focus-visible:outline-none focus-visible:ring-inset")}
                >
                  <span>Included in a card bill or paid by someone else</span>
                  <span className="text-foreground/60 tabular-nums">· {covered.length}</span>
                  <span className="ml-auto flex items-center gap-1 tracking-normal normal-case">
                    Not added to totals
                    <ChevronDown className={cn("size-3.5 transition-transform", coveredOpen && "rotate-180")} />
                  </span>
                </button>
                {coveredOpen && (
                  <ul className="divide-y divide-border-strong/40 bg-secondary/20">
                    {covered.map((item) => (
                      <ObligationRow key={item.key} item={item} now={now} handlers={handlers} covered />
                    ))}
                  </ul>
                )}
              </section>
            )}
          </>
        )}
      </div>

      <p className="px-1 text-xs text-foreground/65">
        Each payment is counted once. A card EMI&apos;s installment is already inside the card statement, so it is listed but never added on top of the card bill.
        Paying a loan, EMI or card bill opens that screen&apos;s own payment form, so a payment is recorded once, where the money is tracked.
      </p>
    </div>
  );
}
