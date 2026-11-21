"use client";

import {
  ArrowRight,
  CalendarClock,
  ChevronDown,
  CircleCheck,
  CreditCard,
  Info,
  Landmark,
  LayoutGrid,
  List,
  Receipt,
  Smartphone,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
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
  dueToday: "bg-warning/20 text-warning-foreground dark:text-warning ring-1 ring-warning/40",
  dueSoon: "bg-warning/12 text-warning-foreground dark:text-warning ring-1 ring-warning/30",
  upcoming: "bg-secondary text-foreground/80 ring-1 ring-border-strong/60",
  paid: "bg-success/12 text-success ring-1 ring-success/25",
};
const TILE_TONE: Record<ObligationStatus, string> = {
  overdue: "bg-expense/10 text-expense ring-expense/30",
  dueToday: "bg-warning/18 text-warning-foreground dark:text-warning ring-warning/45",
  dueSoon: "bg-warning/12 text-warning-foreground dark:text-warning ring-warning/35",
  upcoming: "bg-secondary/70 text-foreground ring-border-strong/60",
  paid: "bg-success/10 text-success ring-success/30",
};

const ACTION =
  "inline-flex h-8 shrink-0 items-center gap-1 rounded-[7px] border border-border-strong bg-card px-2.5 text-xs font-semibold text-foreground transition-colors hover:border-primary-accent-text/60 hover:bg-primary/10 focus-visible:ring-2 focus-visible:ring-primary-accent-text focus-visible:outline-none";
const GROUP_HEADING =
  "flex w-full items-center gap-2 border-t border-border-strong/40 bg-secondary/50 px-4 py-1.5 text-[11px] font-bold tracking-[0.06em] text-foreground/75 uppercase first:border-t-0 sm:px-5";
const CHIP_BASE = "inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-xs font-semibold whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:ring-primary-accent-text focus-visible:outline-none";
/** Card grid: as many columns as the width allows, so a long month fits on one screen instead of a long scroll. */
const GRID_UL = "grid grid-cols-[repeat(auto-fill,minmax(15.5rem,1fr))] gap-2 p-2.5";

type ViewMode = "list" | "grid";
const VIEW_KEY = "flowfi.bills.view";

function readView(): ViewMode {
  try {
    return window.localStorage.getItem(VIEW_KEY) === "grid" ? "grid" : "list";
  } catch {
    return "list";
  }
}

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

function Chip({ className, children }: { className: string; children: ReactNode }) {
  return <span className={cn("inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[11px] font-semibold whitespace-nowrap", className)}>{children}</span>;
}

function DateTile({ date, status, muted, small }: { date: Date; status: ObligationStatus; muted: boolean; small?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn("flex shrink-0 flex-col items-center justify-center rounded-[9px] py-1 ring-1", small ? "w-9" : "w-11", muted ? "bg-muted text-foreground/60 ring-border-strong/50" : TILE_TONE[status])}
    >
      <span className="text-[10px] leading-none font-semibold tracking-[0.06em] uppercase opacity-85">{date.toLocaleDateString("en-IN", { month: "short" })}</span>
      <span className={cn("font-heading leading-tight font-bold tabular-nums", small ? "text-base" : "text-lg")}>{date.getDate()}</span>
    </span>
  );
}

// ───────────────────────────── shared row pieces ─────────────────────────────

interface RowHandlers {
  /** Open a regular bill's detail panel (its Skip / Edit / Delete / payment history). */
  onOpenBill: (billId: string) => void;
  /** Pay a regular bill's exact cycle in place — the existing Pay dialog. */
  onPayBill: (item: ObligationItem) => void;
}

function rowFlags(item: ObligationItem, covered: boolean) {
  return {
    partial: item.amountPaid > 0 && item.remaining > 0,
    paidPercent: item.amountDue > 0 ? Math.min(100, Math.round((item.amountPaid / item.amountDue) * 100)) : 0,
    muted: covered || !item.countsTowardTotal,
    urgent: item.status === "overdue" || item.status === "dueToday" || item.status === "dueSoon",
  };
}

/** Status chips for one obligation — identical in the list and the grid. */
function StatusChips({ item, muted, urgent, partial }: { item: ObligationItem; muted: boolean; urgent: boolean; partial: boolean }) {
  return (
    <>
      {urgent && <Chip className={STATUS_CHIP[item.status]}>{STATUS_LABEL[item.status]}</Chip>}
      {!urgent && !muted && <Chip className={STATUS_CHIP.upcoming}>{STATUS_LABEL.upcoming}</Chip>}
      {partial && <Chip className="bg-warning/12 text-warning-foreground dark:text-warning ring-1 ring-warning/30">Partially paid</Chip>}
      {item.carriedForward && <Chip className="bg-secondary text-foreground/80 ring-1 ring-border-strong/60">From an earlier cycle</Chip>}
      {item.billStillOpen && <Chip className="bg-secondary text-foreground/80 ring-1 ring-border-strong/60">Bill still open</Chip>}
      {muted && <Chip className="bg-muted text-foreground/75 ring-1 ring-border-strong/60">Not added to totals</Chip>}
    </>
  );
}

function DueText({ item, now }: { item: ObligationItem; now: Date }) {
  // "Due today" is already the status chip — don't say it twice.
  if (item.status === "dueToday") return null;
  return <span className={cn("text-xs", item.status === "overdue" ? "font-semibold text-expense" : "text-foreground/75")}>{relativeDue(item, now)}</span>;
}

function Related({ item, muted }: { item: ObligationItem; muted: boolean }) {
  if (!item.related || muted) return null;
  return (
    <span className="inline-flex min-w-0 items-center gap-1 text-xs text-foreground/70">
      <Wallet className="size-3 shrink-0" aria-hidden />
      <span className="truncate">{item.related}</span>
    </span>
  );
}

/** Progress bar + the small supporting facts (note, minimum due, what's left on the agreement). */
function Extras({ item, muted, partial, paidPercent }: { item: ObligationItem; muted: boolean; partial: boolean; paidPercent: number }) {
  const facts: ReactNode[] = [];
  if (item.note) facts.push(<span key="note">{item.note}</span>);
  if (item.kind === "card" && item.minimumDue != null && item.minimumDue > 0 && item.amountPaid === 0) facts.push(<span key="min">Minimum due {formatCurrency(item.minimumDue)}</span>);
  if (item.agreementRemaining && item.agreementRemaining.amount > 0 && !muted) {
    facts.push(
      <span key="agr">
        {item.agreementRemaining.label} {formatCurrency(item.agreementRemaining.amount)}
      </span>,
    );
  }
  if (item.billStillOpen) facts.push(<span key="open">Amount so far — new purchases until the statement closes are added.</span>);
  if (!partial && facts.length === 0) return null;
  return (
    <>
      {partial && (
        <span className="flex items-center gap-2">
          <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-secondary" role="progressbar" aria-valuenow={paidPercent} aria-valuemin={0} aria-valuemax={100} aria-label="Paid so far">
            <span className="block h-full rounded-full bg-success" style={{ width: `${paidPercent}%` }} />
          </span>
          <span className="shrink-0 text-[11px] text-foreground/75 tabular-nums">{formatCurrency(item.amountPaid)} paid</span>
        </span>
      )}
      {facts.length > 0 && <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-foreground/70">{facts}</span>}
    </>
  );
}

/** The one action an obligation offers, plus a quiet "View" link — same behaviour wherever it is drawn. */
function RowActions({
  item,
  covered,
  partial,
  handlers,
  inline,
  compact,
}: {
  item: ObligationItem;
  covered: boolean;
  partial: boolean;
  handlers: RowHandlers;
  inline?: boolean;
  /** Grid card: smaller button, and no separate "View" link (the card's own header already opens the item). */
  compact?: boolean;
}) {
  const viewLabel = item.kind === "card" ? "card" : "agreement";
  const main = covered ? (
    <Link href={item.href} className={cn(ACTION, compact && "h-7")} aria-label={`View ${item.title}`}>
      View
      <ArrowRight className="size-3" strokeWidth={2.2} />
    </Link>
  ) : item.kind === "bill" ? (
    <ClayButton size="sm" className={cn(compact && "h-7")} onClick={() => handlers.onPayBill(item)} aria-label={`Pay now: ${item.title}`}>
      {partial ? "Pay rest" : "Pay now"}
    </ClayButton>
  ) : item.payHref ? (
    <Link href={item.payHref} className={cn(ACTION, compact && "h-7", "border-primary/40 bg-primary/10 text-primary-accent-text")} aria-label={`${item.actionLabel}: ${item.title}`}>
      {item.actionLabel}
      <ArrowRight className="size-3" strokeWidth={2.2} />
    </Link>
  ) : (
    <Link href={item.href} className={cn(ACTION, compact && "h-7")} aria-label={`${item.actionLabel}: ${item.title}`}>
      {item.actionLabel}
      <ArrowRight className="size-3" strokeWidth={2.2} />
    </Link>
  );
  const view =
    !compact && !covered && item.kind !== "bill" && item.payHref ? (
      <Link href={item.href} className="text-[11px] font-semibold whitespace-nowrap text-foreground/70 hover:text-foreground hover:underline" aria-label={`View ${item.title}`}>
        View {viewLabel}
      </Link>
    ) : null;
  return (
    <div className={cn("flex shrink-0 gap-1.5", inline ? "flex-row-reverse items-center gap-3" : "flex-col items-end")}>
      {main}
      {view}
    </div>
  );
}

const rowStripe = (item: ObligationItem, muted: boolean) =>
  muted ? "border-l-transparent" : item.status === "overdue" ? "border-l-expense" : item.status === "dueToday" || item.status === "dueSoon" ? "border-l-warning" : "border-l-transparent";
const cardStripe = (item: ObligationItem, muted: boolean) =>
  muted ? "border-t-border-strong/40" : item.status === "overdue" ? "border-t-expense" : item.status === "dueToday" || item.status === "dueSoon" ? "border-t-warning" : "border-t-border-strong/60";

// ───────────────────────────── rows (list) ─────────────────────────────

function ObligationRow({ item, now, handlers, covered = false }: { item: ObligationItem; now: Date; handlers: RowHandlers; covered?: boolean }) {
  const Icon = KIND_ICON[item.kind];
  const { partial, paidPercent, muted, urgent } = rowFlags(item, covered);

  const body = (
    <>
      <DateTile date={item.dueDate} status={item.status} muted={muted} />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate text-sm font-semibold text-foreground">{item.title}</span>
          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-foreground/65">
            <Icon className="size-3 shrink-0" strokeWidth={2} aria-hidden />
            {KIND_LABEL[item.kind]}
          </span>
          <StatusChips item={item} muted={muted} urgent={urgent} partial={partial} />
        </span>
        <span className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs text-foreground/70">
          <span className="truncate">{item.detail}</span>
          <DueText item={item} now={now} />
          <Related item={item} muted={muted} />
        </span>
        <Extras item={item} muted={muted} partial={partial} paidPercent={paidPercent} />
      </span>
    </>
  );

  const bodyClass = "flex min-w-0 flex-1 items-center gap-3 rounded-[10px] text-left outline-none focus-visible:ring-2 focus-visible:ring-primary-accent-text";

  return (
    <li data-testid="bills-row" data-kind={item.kind} className={cn("flex items-center gap-3 border-l-[3px] px-4 py-2.5 transition-colors hover:bg-secondary/40 sm:px-5", rowStripe(item, muted))}>
      {item.kind === "bill" ? (
        <button type="button" onClick={() => handlers.onOpenBill(item.sourceId)} className={bodyClass}>
          {body}
        </button>
      ) : (
        <Link href={item.href} className={bodyClass}>
          {body}
        </Link>
      )}
      <div className="flex shrink-0 flex-col items-end gap-1.5 sm:flex-row sm:items-center sm:gap-4">
        <div className="text-right">
          <p className={cn("text-[15px] leading-tight font-bold tabular-nums", muted ? "text-foreground/60" : "text-foreground")}>{formatCurrency(item.remaining)}</p>
          {partial && <p className="text-[11px] text-foreground/65 tabular-nums">of {formatCurrency(item.amountDue)}</p>}
        </div>
        <RowActions item={item} covered={covered} partial={partial} handlers={handlers} />
      </div>
    </li>
  );
}

function PaidRow({ group, handlers }: { group: CompletedGroup; handlers: RowHandlers }) {
  const Icon = KIND_ICON[group.kind];
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
        <span className="text-xs text-foreground/70">{paidDetail(group)}</span>
      </span>
    </>
  );
  const bodyClass = "flex min-w-0 flex-1 items-center gap-3 rounded-[10px] text-left outline-none focus-visible:ring-2 focus-visible:ring-primary-accent-text";
  return (
    <li data-testid="bills-paid-row" className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-secondary/40 sm:px-5">
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

function paidDetail(group: CompletedGroup): string {
  return group.payments > 0
    ? `${group.payments} payment${group.payments === 1 ? "" : "s"}${group.lastDate ? ` · last ${shortDate(group.lastDate)}` : ""}${group.undatedAmount > 0 ? ` · ${formatCurrency(group.undatedAmount)} paid earlier, date not recorded` : ""}`
    : "Paid earlier — payment date not recorded";
}

// ───────────────────────────── cards (grid) ─────────────────────────────

function ObligationCard({ item, now, handlers, covered = false }: { item: ObligationItem; now: Date; handlers: RowHandlers; covered?: boolean }) {
  const Icon = KIND_ICON[item.kind];
  const { partial, paidPercent, muted, urgent } = rowFlags(item, covered);

  // Two tight rows: [date · title / kind · detail · amount] then [status · due … action]. Extras only when there are any.
  const body = (
    <>
      <DateTile date={item.dueDate} status={item.status} muted={muted} small />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className="truncate text-sm leading-tight font-semibold text-foreground" title={item.title}>
            {item.title}
          </span>
          <span className={cn("shrink-0 text-sm leading-tight font-bold tabular-nums", muted ? "text-foreground/60" : "text-foreground")}>{formatCurrency(item.remaining)}</span>
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-foreground/70">
          <span className="inline-flex shrink-0 items-center gap-1 font-semibold text-foreground/65">
            <Icon className="size-3 shrink-0" strokeWidth={2} aria-hidden />
            {KIND_LABEL[item.kind]}
          </span>
          <span className="truncate" title={item.detail}>
            {item.detail}
          </span>
          {partial && <span className="ml-auto shrink-0 tabular-nums">of {formatCurrency(item.amountDue)}</span>}
        </span>
        <Extras item={item} muted={muted} partial={partial} paidPercent={paidPercent} />
        <Related item={item} muted={muted} />
      </span>
    </>
  );
  const bodyClass = "flex min-w-0 items-start gap-2.5 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-primary-accent-text";

  return (
    <li
      data-testid="bills-row"
      data-kind={item.kind}
      className={cn("flex min-w-0 flex-col gap-1.5 rounded-xl border border-t-[3px] border-border-strong/50 bg-background p-2.5 transition-colors hover:border-border-strong", cardStripe(item, muted))}
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
      <div className="flex min-h-7 flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
          <StatusChips item={item} muted={muted} urgent={urgent} partial={partial} />
          <DueText item={item} now={now} />
        </span>
        <RowActions item={item} covered={covered} partial={partial} handlers={handlers} inline compact />
      </div>
    </li>
  );
}

function PaidCard({ group, handlers }: { group: CompletedGroup; handlers: RowHandlers }) {
  const Icon = KIND_ICON[group.kind];
  const body = (
    <>
      <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-[9px] bg-success/10 text-success ring-1 ring-success/30">
        <CircleCheck className="size-[18px]" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-baseline justify-between gap-2">
          <span className="truncate text-sm leading-tight font-semibold text-foreground" title={group.title}>
            {group.title}
          </span>
          <span className="shrink-0 text-sm leading-tight font-bold text-success tabular-nums">{formatCurrency(group.amount)}</span>
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-foreground/70">
          <span className="inline-flex shrink-0 items-center gap-1 font-semibold text-foreground/65">
            <Icon className="size-3 shrink-0" strokeWidth={2} aria-hidden />
            {KIND_LABEL[group.kind]}
          </span>
          <span className="truncate" title={paidDetail(group)}>
            {paidDetail(group)}
          </span>
        </span>
      </span>
    </>
  );
  const bodyClass = "flex min-w-0 flex-1 items-center gap-2.5 rounded-xl p-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-accent-text";
  return (
    <li data-testid="bills-paid-row" className="flex min-w-0 rounded-xl border border-t-[3px] border-border-strong/50 border-t-success/60 bg-background transition-colors hover:border-border-strong">
      {group.kind === "bill" ? (
        <button type="button" onClick={() => handlers.onOpenBill(group.sourceId)} className={bodyClass}>
          {body}
        </button>
      ) : (
        <Link href={group.href} className={bodyClass}>
          {body}
        </Link>
      )}
    </li>
  );
}

// ───────────────────────────── sections ─────────────────────────────

/** One payment, drawn as a list row or a grid card — the same data and actions either way. */
function Obligation({ view, ...props }: { view: ViewMode; item: ObligationItem; now: Date; handlers: RowHandlers; covered?: boolean }) {
  return view === "grid" ? <ObligationCard {...props} /> : <ObligationRow {...props} />;
}

function PaidEntry({ view, ...props }: { view: ViewMode; group: CompletedGroup; handlers: RowHandlers }) {
  return view === "grid" ? <PaidCard {...props} /> : <PaidRow {...props} />;
}

function Section({ title, hint, count, total, tone, view, children }: { title: string; hint?: string; count: number; total?: number; tone?: "attention"; view: ViewMode; children: ReactNode }) {
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
      <ul className={view === "grid" ? GRID_UL : "divide-y divide-border-strong/40"}>{children}</ul>
    </section>
  );
}

const sum = (items: readonly ObligationItem[]) => Math.round(items.reduce((s, i) => s + i.remaining, 0) * 100) / 100;

/**
 * Filters + the cycle's payments in sections: overdue, due this cycle, upcoming (next cycle), paid, and the
 * installments already inside a card statement. Presentation only — what each section holds is decided by
 * `buildBillsOverview`; filtering and the List/Grid choice never change a headline total.
 */
export function BillsPaymentList({ data, handlers }: { data: BillsOverviewData; handlers: RowHandlers }) {
  const [filters, setFilters] = useState<BillsFilters>(DEFAULT_FILTERS);
  const [coveredOpen, setCoveredOpen] = useState(false);
  // Remembered per browser; this list only mounts after the data has loaded on the client, so reading it here is safe.
  const [view, setViewState] = useState<ViewMode>(readView);
  const setView = (next: ViewMode) => {
    setViewState(next);
    try {
      window.localStorage.setItem(VIEW_KEY, next);
    } catch {
      /* storage unavailable — the choice just isn't remembered */
    }
  };
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
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2" data-testid="bills-filters">
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
        <span aria-hidden className="hidden h-5 w-px bg-border-strong/60 lg:block" />
        <div role="group" aria-label="Filter by status" className="flex flex-wrap items-center gap-1.5">
          {STATUS_FILTERS.map(({ value, label }) => {
            const active = filters.status === value;
            return (
              <button
                key={value}
                type="button"
                aria-pressed={active}
                onClick={() => setFilters((f) => ({ ...f, status: value }))}
                className={cn(
                  CHIP_BASE,
                  "h-6 px-2.5",
                  active ? "bg-primary/15 text-foreground ring-1 ring-primary-accent-text/60" : "text-foreground/70 ring-1 ring-border-strong/60 hover:bg-secondary/60",
                )}
              >
                {label}
              </button>
            );
          })}
        </div>
        <div role="group" aria-label="View as" className="ml-auto inline-flex rounded-[9px] border border-border-strong/60 bg-card p-0.5">
          {(
            [
              ["list", "List view", List],
              ["grid", "Grid view", LayoutGrid],
            ] as const
          ).map(([value, label, ViewIcon]) => (
            <button
              key={value}
              type="button"
              aria-pressed={view === value}
              aria-label={label}
              title={label}
              onClick={() => setView(value)}
              className={cn(
                "flex h-7 items-center gap-1.5 rounded-[7px] px-2.5 text-xs font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-primary-accent-text focus-visible:outline-none",
                view === value ? "bg-primary text-primary-foreground" : "text-foreground/70 hover:bg-secondary",
              )}
            >
              <ViewIcon className="size-3.5" aria-hidden />
              <span className="hidden sm:inline">{value === "list" ? "List" : "Grid"}</span>
            </button>
          ))}
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
            <Section title="Overdue" hint="Past due — stays until paid" count={overdue.length} total={sum(overdue)} tone="attention" view={view}>
              {overdue.map((item) => (
                <Obligation key={item.key} view={view} item={item} now={now} handlers={handlers} />
              ))}
            </Section>
            <Section title="Rest of this cycle" hint={`Not yet due · ${data.periodLabel}`} count={dueThisCycle.length} total={sum(dueThisCycle)} view={view}>
              {dueThisCycle.map((item) => (
                <Obligation key={item.key} view={view} item={item} now={now} handlers={handlers} />
              ))}
            </Section>
            <Section title="Upcoming" hint={`Next cycle · ${data.nextPeriodLabel}`} count={upcoming.length} total={sum(upcoming)} view={view}>
              {upcoming.map((item) => (
                <Obligation key={item.key} view={view} item={item} now={now} handlers={handlers} />
              ))}
            </Section>
            <Section title="Paid this cycle" hint={data.periodLabel} count={paid.length} total={Math.round(paid.reduce((s, g) => s + g.amount, 0) * 100) / 100} view={view}>
              {paid.map((group) => (
                <PaidEntry key={group.key} view={view} group={group} handlers={handlers} />
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
                  <ul className={view === "grid" ? GRID_UL : "divide-y divide-border-strong/40 bg-secondary/20"}>
                    {covered.map((item) => (
                      <Obligation key={item.key} view={view} item={item} now={now} handlers={handlers} covered />
                    ))}
                  </ul>
                )}
              </section>
            )}
          </>
        )}
      </div>

      <details className="group px-1 text-xs text-foreground/65">
        <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 font-semibold text-foreground/70 hover:text-foreground [&::-webkit-details-marker]:hidden">
          <Info className="size-3.5" aria-hidden />
          How payments are counted
          <ChevronDown className="size-3 transition-transform group-open:rotate-180" aria-hidden />
        </summary>
        <p className="mt-1.5 max-w-3xl leading-relaxed">
          Each payment is counted once. A card EMI&apos;s installment is already inside the card statement, so it is listed but never added on top of the card bill. Paying a loan, EMI or card bill opens that
          screen&apos;s own payment form, so a payment is recorded once, where the money is tracked.
        </p>
      </details>
    </div>
  );
}
