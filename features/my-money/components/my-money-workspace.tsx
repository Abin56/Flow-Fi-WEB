"use client";

import Link from "next/link";
import { useState } from "react";
import {
  ArrowRight,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CreditCard,
  Info,
  Landmark,
  type LucideIcon,
  HandCoins,
  Receipt,
  RotateCcw,
  ShoppingBag,
  Smartphone,
  Users,
  Wallet,
} from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatCurrency } from "@/lib/format";
import { ordinalDay } from "@/lib/engines/month-cycle-range";
import { cn } from "@/lib/utils";
import { useCompactHeader } from "@/components/layout/compact-header";
import { ScrollNav } from "@/components/layout/scroll-nav";
import { MyMoneyCompactBar } from "@/features/my-money/components/my-money-compact-bar";
import { categoryIconFor, categoryToneFor, type ToneName } from "@/features/transactions/hooks/use-transactions-data";
import { useMyMoneyData, type CollectItem, type MyMoneyData } from "@/features/my-money/hooks/use-my-money-data";
import { daysUntil, type CompletedGroup, type ObligationItem, type ObligationKind, type ObligationStatus, type SharedPerson } from "@/features/my-money/lib/my-money";

const PANEL = "overflow-hidden rounded-[14px] border border-border-strong/60 bg-card shadow-e1";
const LABEL = "text-[11px] font-semibold tracking-[0.06em] text-foreground/70 uppercase";
const ACTION =
  "inline-flex h-8 shrink-0 items-center gap-1 rounded-[7px] border border-border-strong bg-card px-2.5 text-xs font-semibold text-foreground transition-colors hover:border-primary-accent-text/60 hover:bg-primary/10 focus-visible:ring-2 focus-visible:ring-primary-accent-text focus-visible:outline-none";
const ICON_BUTTON =
  "flex size-8 items-center justify-center rounded-[6px] text-foreground/70 transition-colors hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary-accent-text focus-visible:outline-none";
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const KIND_ICON: Record<ObligationKind, LucideIcon> = { card: CreditCard, loan: Landmark, emi: Smartphone, bill: Receipt };
const KIND_LABEL: Record<ObligationKind, string> = { card: "Card bill", loan: "Loan", emi: "EMI", bill: "Bill" };

const STATUS_LABEL: Record<ObligationStatus, string> = {
  overdue: "Overdue",
  dueToday: "Due today",
  dueSoon: "Due soon",
  upcoming: "Upcoming",
  paid: "Paid",
};
const STATUS_CHIP: Record<ObligationStatus, string> = {
  overdue: "bg-expense/12 text-expense ring-1 ring-expense/25",
  dueToday: "bg-warning/20 text-warning-foreground ring-1 ring-warning/40",
  dueSoon: "bg-warning/12 text-warning-foreground ring-1 ring-warning/30",
  upcoming: "bg-secondary text-foreground/80 ring-1 ring-border-strong/60",
  paid: "bg-success/12 text-success ring-1 ring-success/25",
};
const TONE_BADGE: Record<ToneName, string> = {
  primary: "bg-primary/10 text-primary-accent-text",
  expense: "bg-expense/10 text-expense",
  warning: "bg-warning/15 text-warning-foreground",
  success: "bg-success/12 text-success",
  purple: "bg-purple/12 text-purple",
  neutral: "bg-muted text-foreground/70",
};

const AVATAR_TONES: ToneName[] = ["primary", "success", "purple", "warning", "expense"];
/** Stable per-name colour so people are recognisable at a glance. */
function avatarTone(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return TONE_BADGE[AVATAR_TONES[h % AVATAR_TONES.length]];
}

function shortDate(d: Date): string {
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

/** "Due 17 Oct" · "Due today" · "Due tomorrow" · "Overdue since 5 Oct". */
function dueText(item: ObligationItem, now: Date): string {
  const days = daysUntil(item.dueDate, now);
  if (days < 0) return `Overdue since ${shortDate(item.dueDate)}`;
  if (days === 0) return "Due today";
  if (days === 1) return "Due tomorrow";
  return `Due ${shortDate(item.dueDate)}`;
}

/** Row-level due text — relative, since the date tile already shows the date. */
function relativeDue(item: ObligationItem, now: Date): string {
  const days = daysUntil(item.dueDate, now);
  if (days < 0) return `${-days} day${days === -1 ? "" : "s"} overdue`;
  if (days === 0) return "Due today";
  if (days === 1) return "Due tomorrow";
  return `Due in ${days} days`;
}

const TILE_TONE: Record<ObligationStatus, string> = {
  overdue: "bg-expense/10 text-expense ring-expense/30",
  dueToday: "bg-warning/18 text-warning-foreground ring-warning/45",
  dueSoon: "bg-warning/12 text-warning-foreground ring-warning/35",
  upcoming: "bg-secondary/70 text-foreground ring-border-strong/60",
  paid: "bg-success/10 text-success ring-success/30",
};

function DateTile({ date, status, muted }: { date: Date; status: ObligationStatus; muted: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex w-11 shrink-0 flex-col items-center justify-center rounded-[9px] py-1 ring-1",
        muted ? "bg-muted text-foreground/60 ring-border-strong/50" : TILE_TONE[status],
      )}
    >
      <span className="text-[10px] leading-none font-semibold tracking-[0.06em] uppercase opacity-85">{date.toLocaleDateString("en-IN", { month: "short" })}</span>
      <span className="font-heading text-lg leading-tight font-bold tabular-nums">{date.getDate()}</span>
    </span>
  );
}

function Chip({ className, children }: { className: string; children: React.ReactNode }) {
  return <span className={cn("inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[11px] font-semibold whitespace-nowrap", className)}>{children}</span>;
}

/** One header for every panel so titles, icons and "go to" links line up. */
function PanelHeader({
  id,
  icon: Icon,
  title,
  subtitle,
  action,
}: {
  id: string;
  icon: LucideIcon;
  title: string;
  subtitle: React.ReactNode;
  action?: { href: string; label: string };
}) {
  return (
    <div className="flex items-start gap-3 border-b border-border-strong/50 px-4 py-3.5 sm:px-5">
      <span aria-hidden className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-[9px] bg-primary/10 text-primary-accent-text">
        <Icon className="size-4" strokeWidth={1.9} />
      </span>
      <div className="min-w-0 flex-1">
        <h2 id={id} className="font-heading text-base leading-tight font-semibold text-foreground">
          {title}
        </h2>
        <div className="mt-0.5 space-y-0.5 text-xs text-foreground/70">{subtitle}</div>
      </div>
      {action && (
        <Link href={action.href} className="group inline-flex shrink-0 items-center gap-1 rounded-[6px] py-1 text-xs font-semibold text-primary-accent-text hover:underline focus-visible:ring-2 focus-visible:ring-primary-accent-text focus-visible:outline-none">
          {action.label}
          <ArrowRight className="size-3 transition-transform group-hover:translate-x-0.5" strokeWidth={2.2} />
        </Link>
      )}
    </div>
  );
}

function InfoTip({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" aria-label={label} className="inline-flex size-5 items-center justify-center rounded-full text-foreground/55 hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary-accent-text focus-visible:outline-none">
          <Info className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-[18rem]">{children}</TooltipContent>
    </Tooltip>
  );
}

// ─────────────────────────── header ───────────────────────────

function PeriodPicker({ data }: { data: MyMoneyData }) {
  const [open, setOpen] = useState(false);
  const selected = data.cycleRange.end;
  const [year, setYear] = useState(selected.getFullYear());
  const today = new Date();
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setYear(selected.getFullYear());
      }}
    >
      <PopoverTrigger asChild>
        <button type="button" aria-label="Choose period" className="min-w-[9.5rem] rounded-[6px] px-2 py-0.5 text-center transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-primary-accent-text focus-visible:outline-none">
          <span className="flex items-center justify-center gap-1.5 text-sm leading-tight font-semibold text-foreground" aria-live="polite">
            {data.periodLabel}
            <CalendarDays className="size-3.5 text-foreground/60" />
          </span>
          {!data.isCustomCycle ? null : <span className="block text-[11px] leading-tight text-foreground/65 tabular-nums">{data.rangeLabel}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-3">
        <div className="mb-2 flex items-center justify-between">
          <button type="button" aria-label="Previous year" onClick={() => setYear((y) => y - 1)} className={cn(ICON_BUTTON, "size-7")}>
            <ChevronLeft className="size-4" />
          </button>
          <span className="text-sm font-semibold text-foreground tabular-nums">{year}</span>
          <button type="button" aria-label="Next year" onClick={() => setYear((y) => y + 1)} className={cn(ICON_BUTTON, "size-7")}>
            <ChevronRight className="size-4" />
          </button>
        </div>
        <div className="grid grid-cols-3 gap-1">
          {MONTHS_SHORT.map((m, i) => {
            const isSelected = selected.getFullYear() === year && selected.getMonth() === i;
            const isThisMonth = today.getFullYear() === year && today.getMonth() === i;
            return (
              <button
                key={m}
                type="button"
                aria-pressed={isSelected}
                onClick={() => {
                  data.nav.pickMonth(year, i);
                  setOpen(false);
                }}
                className={cn(
                  "h-8 rounded-[6px] text-xs font-semibold transition-colors",
                  isSelected ? "bg-primary text-primary-foreground" : "text-foreground hover:bg-secondary",
                  !isSelected && isThisMonth && "ring-1 ring-primary-accent-text/60",
                )}
              >
                {m}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function Header({ data, titleRef }: { data: MyMoneyData; /** Callback ref on the title block — what the compact bar watches. */ titleRef?: (el: HTMLDivElement | null) => void }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div ref={titleRef} className="min-w-0">
        <h1 className="font-heading text-2xl font-bold tracking-tight text-foreground sm:text-[1.75rem]">My Money</h1>
        <p className="mt-0.5 text-sm text-foreground/70">Your spending, upcoming payments, and money to collect — all in one place.</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {!data.isCurrent && (
          <button
            type="button"
            onClick={data.nav.current}
            className="inline-flex h-8 items-center gap-1 rounded-[7px] border border-border-strong bg-card px-2.5 text-xs font-semibold text-foreground transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-primary-accent-text focus-visible:outline-none"
          >
            <RotateCcw className="size-3" strokeWidth={2} />
            This month
          </button>
        )}
        <div className="flex items-center rounded-[8px] border border-border-strong bg-card p-0.5">
          <button type="button" onClick={data.nav.previous} aria-label="Previous period" className={ICON_BUTTON}>
            <ChevronLeft className="size-4" strokeWidth={1.9} />
          </button>
          <PeriodPicker data={data} />
          <button type="button" onClick={data.nav.next} aria-label="Next period" className={ICON_BUTTON}>
            <ChevronRight className="size-4" strokeWidth={1.9} />
          </button>
        </div>
        <InfoTip label="About this period">
          {data.isCustomCycle
            ? `Periods follow your Month Cycle: the ${ordinalDay(data.startDay)} of each month to the day before the next. Card bills keep their own statement and due dates.`
            : "Periods follow your Month Cycle (calendar month). Card bills keep their own statement and due dates."}
        </InfoTip>
      </div>
    </header>
  );
}

// ─────────────────────────── summary ───────────────────────────

function SummaryCell({
  label,
  icon: Icon,
  amount,
  tone,
  meta,
  tip,
  className,
  accent = "bg-border-strong/70",
}: {
  className?: string;
  icon: LucideIcon;
  /** Thin top bar signalling the figure's state. */
  accent?: string;
  label: string;
  amount: number;
  tone?: string;
  meta: React.ReactNode;
  tip: string;
}) {
  return (
    <div className={cn("relative flex min-w-0 flex-col gap-1.5 border-border-strong/50 px-4 pt-4 pb-3.5 transition-colors hover:bg-secondary/25 sm:px-5", className)}>
      <span aria-hidden className={cn("absolute inset-x-0 top-0 h-[3px]", accent)} />
      <div className="flex items-center gap-1.5">
        <Icon aria-hidden className="size-3.5 shrink-0 text-foreground/55" strokeWidth={2} />
        <span className={LABEL}>{label}</span>
        <InfoTip label={`What ${label} means`}>{tip}</InfoTip>
      </div>
      <span className={cn("font-heading text-[1.4rem] leading-none font-bold tracking-tight break-words text-foreground tabular-nums sm:text-[1.75rem]", tone)}>{formatCurrency(amount)}</span>
      <span className="min-h-[1rem] text-xs leading-snug text-foreground/70">{meta}</span>
    </div>
  );
}

function Summary({ data }: { data: MyMoneyData }) {
  const { toPay, collect, spending, completed } = data;
  const next = toPay.next;
  const comparison = spending.comparison;
  return (
    <section id="mm-summary" aria-label="Period summary" className={PANEL}>
      <div className="grid grid-cols-2 lg:grid-cols-4">
        <SummaryCell
          label="To pay"
          icon={Wallet}
          className="border-r border-b lg:border-b-0"
          amount={toPay.total}
          tone={toPay.count === 0 ? "text-success" : toPay.overdue > 0 ? "text-expense" : undefined}
          accent={toPay.overdue > 0 ? "bg-expense" : toPay.dueSoon > 0 ? "bg-warning" : toPay.count === 0 ? "bg-success" : "bg-primary"}
          meta={
            toPay.count === 0 ? (
              "Nothing due"
            ) : toPay.overdue > 0 || toPay.dueSoon > 0 ? (
              <span>
                {toPay.overdue > 0 && <span className="font-semibold text-expense">{formatCurrency(toPay.overdue)} overdue</span>}
                {toPay.overdue > 0 && toPay.dueSoon > 0 && " · "}
                {toPay.dueSoon > 0 && <span className="font-semibold text-warning-foreground">{formatCurrency(toPay.dueSoon)} due soon</span>}
              </span>
            ) : (
              `${toPay.count} payment${toPay.count === 1 ? "" : "s"} · next ${shortDate(toPay.next!.dueDate)}`
            )
          }
          tip="What your lenders, card issuers and billers expect from you this period — including anything overdue from earlier — at what is still unpaid. It is cash to arrange, not new spending."
        />
        <SummaryCell
          label="To collect"
          icon={HandCoins}
          className="border-b lg:border-r lg:border-b-0"
          amount={collect.total}
          tone={collect.total > 0 ? "text-success" : undefined}
          accent="bg-success"
          meta={collect.items.length === 0 ? "No one owes you today" : `Outstanding today · ${collect.items.length} ${collect.items.length === 1 ? "person" : "people"}`}
          tip="The total other people owe you as of today, from the People Ledger — everything still outstanding, not only this period. Money you hold as an advance is not counted here."
        />
        <SummaryCell
          label="My spending"
          icon={ShoppingBag}
          className="border-r"
          accent="bg-primary"
          amount={spending.mySpend}
          meta={
            comparison.kind === "change" ? (
              <span>
                <span className={cn("font-semibold", comparison.percent > 0 ? "text-expense" : "text-success")}>
                  {comparison.percent > 0 ? "+" : ""}
                  {comparison.percent}%
                </span>{" "}
                vs previous period
              </span>
            ) : comparison.kind === "inProgress" ? (
              `Previous period: ${formatCurrency(comparison.previous)}`
            ) : (
              `${spending.purchaseCount} purchase${spending.purchaseCount === 1 ? "" : "s"}`
            )
          }
          tip="Your own consumption this period: your share of split purchases, no transfers, card bill payments, loan principal, reimbursements or advances."
        />
        <SummaryCell
          label="Completed"
          icon={CheckCircle2}
          accent="bg-success/60"
          amount={completed.total}
          meta={completed.groups.length === 0 ? "No payments yet" : `${completed.groups.length} obligation${completed.groups.length === 1 ? "" : "s"} paid`}
          tip="Card bills, loan and EMI installments, and bills you paid during this period, by payment date. A bill payment with no recorded date is listed under the bill it paid and marked as such."
        />
      </div>
      <NextUp data={data} next={next} />
    </section>
  );
}

function NextUp({ data, next }: { data: MyMoneyData; next: ObligationItem | null }) {
  if (next == null) {
    return (
      <div className="flex items-center gap-2 border-t border-border-strong/50 bg-success/[0.06] px-4 py-2.5 text-sm text-foreground sm:px-5">
        <CheckCircle2 className="size-4 shrink-0 text-success" />
        <span>{data.isPast ? "Nothing from this period is still unpaid." : "You're all caught up for this period."}</span>
      </div>
    );
  }
  const urgent = next.status === "overdue";
  return (
    <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border-strong/50 px-4 py-2.5 sm:px-5", urgent ? "bg-expense/[0.06]" : "bg-warning/[0.07]")}>
      <span className={cn("text-[11px] font-bold tracking-[0.06em] uppercase", urgent ? "text-expense" : "text-warning-foreground")}>Next</span>
      <span className="min-w-0 flex-1 text-sm text-foreground">
        <span className="font-semibold">{next.title}</span>
        <span className="text-foreground/70"> · </span>
        <span className="font-semibold tabular-nums">{formatCurrency(next.remaining)}</span>
        <span className="text-foreground/70"> · {dueText(next, data.now)}</span>
      </span>
      <Link href={next.href} className={ACTION}>
        {next.actionLabel}
        <ArrowRight className="size-3" strokeWidth={2.2} />
      </Link>
    </div>
  );
}

// ─────────────────────────── to pay ───────────────────────────

const PERSON_STATE: Record<SharedPerson["state"], { label: string; className: string }> = {
  received: { label: "Received", className: "text-success" },
  partial: { label: "Partly received", className: "text-warning-foreground" },
  pending: { label: "Waiting", className: "text-foreground/70" },
};

function SharedBreakdown({ item }: { item: ObligationItem }) {
  const [open, setOpen] = useState(false);
  const shared = item.shared!;
  const isCard = item.kind === "card";
  return (
    <div className="mt-2 rounded-[8px] border border-border-strong/50 bg-secondary/40">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full flex-wrap items-center gap-x-3 gap-y-0.5 px-2.5 py-1.5 text-left text-xs text-foreground/80 focus-visible:ring-2 focus-visible:ring-primary-accent-text focus-visible:outline-none"
      >
        <Users className="size-3.5 shrink-0 text-foreground/60" />
        <span>
          {isCard ? "Includes others' share" : "Your share"}{" "}
          <span className="font-semibold text-foreground tabular-nums">{formatCurrency(isCard ? shared.othersShare : shared.myShare)}</span>
        </span>
        {!isCard && (
          <span>
            Others <span className="font-semibold text-foreground tabular-nums">{formatCurrency(shared.othersShare)}</span>
          </span>
        )}
        {shared.toCollect > 0 ? (
          <span>
            To collect <span className="font-semibold text-foreground tabular-nums">{formatCurrency(shared.toCollect)}</span>
          </span>
        ) : (
          <span className="font-semibold text-success">All shares collected</span>
        )}
        <ChevronDown className={cn("ml-auto size-3.5 shrink-0 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <ul className="border-t border-border-strong/50 px-2.5 py-1.5">
          {!isCard && (
            <li className="flex items-center justify-between gap-2 py-1 text-xs">
              <span className="font-medium text-foreground">You</span>
              <span className="tabular-nums text-foreground">{formatCurrency(shared.myShare)}</span>
            </li>
          )}
          {shared.people.map((p) => (
            <li key={p.personId} className="flex items-center justify-between gap-2 py-1 text-xs">
              <span className="min-w-0 truncate font-medium text-foreground">{p.name}</span>
              <span className="flex shrink-0 items-center gap-2 tabular-nums">
                <span className={cn("font-semibold", PERSON_STATE[p.state].className)}>
                  {p.state === "partial" ? `${formatCurrency(p.received)} received` : PERSON_STATE[p.state].label}
                </span>
                <span className="text-foreground">{formatCurrency(p.share)}</span>
              </span>
            </li>
          ))}
          {!isCard && item.amountPaid > 0 && (
            <li className="mt-1 border-t border-border-strong/40 pt-1.5 text-[11px] text-foreground/70">
              Paid to lender so far: <span className="font-semibold text-foreground tabular-nums">{formatCurrency(item.amountPaid)}</span> of {formatCurrency(item.amountDue)}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

function ObligationRow({ item, now }: { item: ObligationItem; now: Date }) {
  const Icon = KIND_ICON[item.kind];
  const partial = item.amountPaid > 0 && item.remaining > 0;
  const paidPercent = item.amountDue > 0 ? Math.min(100, Math.round((item.amountPaid / item.amountDue) * 100)) : 0;
  const muted = !item.countsTowardTotal;
  const urgentChip = item.status === "overdue" || item.status === "dueToday" || item.status === "dueSoon";
  return (
    <li
      className={cn(
        "border-l-[3px] px-4 py-3 transition-colors hover:bg-secondary/40 sm:px-5",
        muted ? "border-l-transparent" : item.status === "overdue" ? "border-l-expense" : item.status === "dueToday" || item.status === "dueSoon" ? "border-l-warning" : "border-l-transparent",
      )}
    >
      <div className="flex items-start gap-3">
        <DateTile date={item.dueDate} status={item.status} muted={muted} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-foreground">{item.title}</p>
              <p className="flex min-w-0 items-center gap-1 text-xs text-foreground/70">
                <Icon className="size-3 shrink-0" strokeWidth={2} aria-hidden />
                <span className="truncate">
                  {KIND_LABEL[item.kind]} · {item.detail}
                </span>
              </p>
            </div>
            <div className="shrink-0 text-right">
              <p className={cn("text-[15px] leading-tight font-bold tabular-nums", muted ? "text-foreground/60" : "text-foreground")}>{formatCurrency(item.remaining)}</p>
              {partial && <p className="text-[11px] text-foreground/65 tabular-nums">of {formatCurrency(item.amountDue)}</p>}
            </div>
          </div>

          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {urgentChip && <Chip className={STATUS_CHIP[item.status]}>{STATUS_LABEL[item.status]}</Chip>}
            {partial && <Chip className="bg-warning/12 text-warning-foreground ring-1 ring-warning/30">Partially paid</Chip>}
            {item.billStillOpen && <Chip className="bg-secondary text-foreground/80 ring-1 ring-border-strong/60">Bill still open</Chip>}
            {muted && <Chip className="bg-muted text-foreground/75 ring-1 ring-border-strong/60">Not in total</Chip>}
            <span className={cn("text-xs", item.status === "overdue" ? "font-semibold text-expense" : "text-foreground/75")}>{relativeDue(item, now)}</span>
            <Link href={item.href} className={cn(ACTION, "ml-auto")} aria-label={`${muted ? "View" : item.actionLabel}: ${item.title}`}>
              {muted ? "View" : item.actionLabel}
              <ArrowRight className="size-3" strokeWidth={2.2} />
            </Link>
          </div>

          {partial && (
            <div className="mt-2 flex items-center gap-2">
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-secondary" role="progressbar" aria-valuenow={paidPercent} aria-valuemin={0} aria-valuemax={100} aria-label="Paid so far">
                <div className="h-full rounded-full bg-success" style={{ width: `${paidPercent}%` }} />
              </div>
              <span className="shrink-0 text-[11px] text-foreground/75 tabular-nums">{formatCurrency(item.amountPaid)} paid</span>
            </div>
          )}

          {item.note && <p className="mt-1.5 text-xs text-foreground/70">{item.note}</p>}
          {item.billStillOpen && <p className="mt-1 text-xs text-foreground/70">Amount so far — new purchases until the statement closes are added.</p>}
          {item.shared && <SharedBreakdown item={item} />}
        </div>
      </div>
    </li>
  );
}

const GROUP_HEADING =
  "flex w-full items-center gap-2 border-t border-border-strong/40 bg-secondary/50 px-4 py-1.5 text-[11px] font-bold tracking-[0.06em] text-foreground/75 uppercase sm:px-5";

function ObligationGroup({ title, items, now, attention = false }: { title: string; items: ObligationItem[]; now: Date; attention?: boolean }) {
  if (items.length === 0) return null;
  const total = items.reduce((s, i) => s + i.remaining, 0);
  return (
    <div>
      <h3 className={GROUP_HEADING}>
        {attention && <span aria-hidden className="size-1.5 rounded-full bg-warning" />}
        <span>{title}</span>
        <span className="text-foreground/60 tabular-nums">· {items.length}</span>
        <span className="ml-auto tracking-normal text-foreground normal-case tabular-nums">{formatCurrency(total)}</span>
      </h3>
      <ul className="divide-y divide-border-strong/40">
        {items.map((item) => (
          <ObligationRow key={item.key} item={item} now={now} />
        ))}
      </ul>
    </div>
  );
}

/** Listed for completeness but never part of To pay — collapsed so it doesn't compete with what must be paid. */
function CoveredElsewhere({ items, now }: { items: ObligationItem[]; now: Date }) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn(GROUP_HEADING, "text-left transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-primary-accent-text focus-visible:outline-none focus-visible:ring-inset")}
      >
        <span>Covered elsewhere</span>
        <span className="text-foreground/60 tabular-nums">· {items.length}</span>
        <span className="ml-auto flex items-center gap-1 tracking-normal normal-case">
          Not in total
          <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
        </span>
      </button>
      {open && (
        <ul className="divide-y divide-border-strong/40 bg-secondary/20">
          {items.map((item) => (
            <ObligationRow key={item.key} item={item} now={now} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ToPayPanel({ data }: { data: MyMoneyData }) {
  const counted = data.obligations.filter((i) => i.countsTowardTotal);
  const attention = counted.filter((i) => i.status === "overdue" || i.status === "dueToday" || i.status === "dueSoon");
  const later = counted.filter((i) => i.status === "upcoming");
  const elsewhere = data.obligations.filter((i) => !i.countsTowardTotal);
  const { toPay, collect } = data;
  return (
    <section id="mm-to-pay-section" aria-labelledby="mm-to-pay" className={PANEL}>
      <PanelHeader
        id="mm-to-pay"
        icon={CalendarDays}
        title="Payments this period"
        subtitle={
          <p>
            {toPay.count === 0 ? "Nothing to pay" : `${formatCurrency(toPay.total)} across ${toPay.count} payment${toPay.count === 1 ? "" : "s"}`}
            {toPay.othersStillOwe > 0 && <> · {formatCurrency(toPay.othersStillOwe)} of it is others&apos; share to collect</>}
          </p>
        }
      />
      {collect.totalToGive > 0 && (
        <Link
          href="/people"
          className="group flex items-center gap-2 border-b border-border-strong/50 bg-warning/[0.08] px-4 py-2 text-xs transition-colors hover:bg-warning/[0.14] focus-visible:ring-2 focus-visible:ring-primary-accent-text focus-visible:outline-none focus-visible:ring-inset sm:px-5"
        >
          <Users aria-hidden className="size-3.5 shrink-0 text-warning-foreground" />
          <span className="font-semibold text-foreground">You also owe people {formatCurrency(collect.totalToGive)}</span>
          <span className="ml-auto flex items-center gap-1 font-semibold text-primary-accent-text">
            Review
            <ArrowRight className="size-3 transition-transform group-hover:translate-x-0.5" strokeWidth={2.2} />
          </span>
        </Link>
      )}

      {data.obligations.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-5 py-9 text-center">
          <span className="flex size-11 items-center justify-center rounded-full bg-success/12 text-success">
            <CheckCircle2 className="size-5" />
          </span>
          <p className="text-sm font-semibold text-foreground">No card bills, installments or bills due</p>
          <p className="max-w-xs text-xs text-foreground/70">Nothing is scheduled or overdue for this period.</p>
        </div>
      ) : (
        <div className="[&>*:first-child>h3]:border-t-0 [&>*:first-child>button]:border-t-0">
          <ObligationGroup title="Needs attention" items={attention} now={data.now} attention />
          <ObligationGroup title="Later this period" items={later} now={data.now} />
          <CoveredElsewhere items={elsewhere} now={data.now} />
        </div>
      )}
    </section>
  );
}

// ─────────────────────────── completed ───────────────────────────

function CompletedPanel({ data }: { data: MyMoneyData }) {
  // Collapsed while there are payments to act on; open when nothing is pending so the page isn't mostly empty.
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const { groups, total } = data.completed;
  if (groups.length === 0) return null;
  const open = userOpen ?? data.obligations.length === 0;
  const setOpen = (fn: (o: boolean) => boolean) => setUserOpen(fn(open));
  return (
    <section id="mm-completed" aria-label="Completed payments" className={PANEL}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-secondary/40 focus-visible:ring-2 focus-visible:ring-primary-accent-text focus-visible:outline-none focus-visible:ring-inset sm:px-5"
      >
        <span className="flex items-center gap-2.5">
          <span className="flex size-8 items-center justify-center rounded-full bg-success/12 text-success">
            <CheckCircle2 className="size-4" />
          </span>
          <span>
            <span className="block font-heading text-base font-semibold text-foreground">Completed</span>
            <span className="block text-xs text-foreground/70">
              {groups.length} paid · {formatCurrency(total)}
            </span>
          </span>
        </span>
        <ChevronDown className={cn("size-4 text-foreground/70 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <ul className="divide-y divide-border-strong/40 border-t border-border-strong/50">
          {groups.map((g) => (
            <CompletedRow key={g.key} group={g} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** Real payment dates only — an undated part is said to be undated, never given the bill's due date. */
function completedWhen(group: CompletedGroup): string {
  const kind = KIND_LABEL[group.kind];
  const dated =
    group.lastDate == null ? null : group.payments > 1 ? `${group.payments} payments · last ${shortDate(group.lastDate)}` : `Paid ${shortDate(group.lastDate)}`;
  if (group.undatedAmount <= 0) return `${kind} · ${dated}`;
  const undated = group.undatedDueDate ? `Bill due ${shortDate(group.undatedDueDate)} · payment date not recorded` : "Payment date not recorded";
  return dated ? `${kind} · ${dated} · ${formatCurrency(group.undatedAmount)} undated` : `${kind} · ${undated}`;
}

function CompletedRow({ group }: { group: CompletedGroup }) {
  const Icon = KIND_ICON[group.kind];
  return (
    <li>
      <Link href={group.href} className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-secondary/40 focus-visible:bg-secondary/60 focus-visible:outline-none sm:px-5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-success/10 text-success" aria-hidden>
          <Icon className="size-3.5" strokeWidth={1.9} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-foreground">{group.title}</span>
          <span className="block truncate text-xs text-foreground/70">{completedWhen(group)}</span>
        </span>
        <span className="shrink-0 text-sm font-bold text-foreground tabular-nums">{formatCurrency(group.amount)}</span>
      </Link>
    </li>
  );
}

// ─────────────────────────── to collect ───────────────────────────

const COLLECT_PREVIEW = 5;

function expectedText(expected: NonNullable<CollectItem["expected"]>): { text: string; className: string } {
  if (expected.status === "overdue") return { text: `Follow up · expected ${shortDate(expected.date)}`, className: "font-semibold text-expense" };
  if (expected.status === "dueToday") return { text: "Expected today", className: "font-semibold text-warning-foreground" };
  return { text: `Expected ${shortDate(expected.date)}`, className: "text-foreground/75" };
}

function CollectPanel({ data }: { data: MyMoneyData }) {
  const [showAll, setShowAll] = useState(false);
  const { collect } = data;
  const shown = showAll ? collect.items : collect.items.slice(0, COLLECT_PREVIEW);
  return (
    <section id="mm-collect-section" aria-labelledby="mm-collect" className={PANEL}>
      <PanelHeader
        id="mm-collect"
        icon={HandCoins}
        title="Money to collect"
        action={{ href: "/people", label: "People Ledger" }}
        subtitle={
          <>
            <p>
              {formatCurrency(collect.total)} outstanding today{data.isCurrent ? "" : " — not limited to this period"}
            </p>
            {collect.collectedInPeriod > 0 && <p className="font-medium text-success">{formatCurrency(collect.collectedInPeriod)} received in this period</p>}
          </>
        }
      />

      {collect.items.length === 0 ? (
        <p className="px-4 py-5 text-sm text-foreground/75">No one owes you money right now.</p>
      ) : (
        <ul className="divide-y divide-border-strong/40">
          {shown.map((p) => {
            const expected = p.expected ? expectedText(p.expected) : null;
            return (
              <li key={p.personId}>
                <Link href={p.href} className="group flex items-start gap-3 px-4 py-3 transition-colors hover:bg-secondary/40 focus-visible:bg-secondary/60 focus-visible:outline-none">
                  <span className={cn("mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-bold", avatarTone(p.name))} aria-hidden>
                    {p.name.trim().charAt(0).toUpperCase() || "?"}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-foreground">{p.name}</span>
                    <span className="block truncate text-xs text-foreground/70">{p.reasons.length > 0 ? p.reasons.slice(0, 2).join(" · ") : "Waiting to receive"}</span>
                    {(expected || p.partlyReceived > 0 || p.alsoOwe > 0) && (
                      <span className="mt-0.5 flex flex-wrap gap-x-2 text-[11px]">
                        {expected && <span className={expected.className}>{expected.text}</span>}
                        {p.partlyReceived > 0 && <span className="text-foreground/75">{formatCurrency(p.partlyReceived)} already received</span>}
                        {p.alsoOwe > 0 && <span className="text-foreground/75">You owe them {formatCurrency(p.alsoOwe)}</span>}
                      </span>
                    )}
                  </span>
                  <span className="flex shrink-0 items-center gap-1">
                    <span className="text-sm font-bold text-success tabular-nums">{formatCurrency(p.amount)}</span>
                    <ChevronRight aria-hidden className="size-3.5 -mr-1 text-foreground/30 transition-all group-hover:translate-x-0.5 group-hover:text-foreground/70" />
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      {collect.items.length > COLLECT_PREVIEW && (
        <button
          type="button"
          onClick={() => setShowAll((s) => !s)}
          className="w-full border-t border-border-strong/50 px-4 py-2 text-xs font-semibold text-primary-accent-text transition-colors hover:bg-primary/10 focus-visible:ring-2 focus-visible:ring-primary-accent-text focus-visible:outline-none focus-visible:ring-inset"
        >
          <span className="inline-flex items-center justify-center gap-1">
            {showAll ? "Show fewer" : `Show all ${collect.items.length}`}
            <ChevronDown className={cn("size-3.5 transition-transform", showAll && "rotate-180")} />
          </span>
        </button>
      )}
      {collect.advanceHeld > 0 && (
        <p className="flex items-start gap-2 border-t border-border-strong/50 bg-secondary/40 px-4 py-2.5 text-xs text-foreground/75">
          <Info aria-hidden className="mt-0.5 size-3.5 shrink-0 text-foreground/55" />
          <span>You&apos;re holding <span className="font-semibold text-foreground tabular-nums">{formatCurrency(collect.advanceHeld)}</span> in advances that haven&apos;t been applied yet.</span>
        </p>
      )}
    </section>
  );
}

// ─────────────────────────── spending ───────────────────────────

const CATEGORY_PREVIEW = 4;

function SpendingPanel({ data }: { data: MyMoneyData }) {
  const [showAll, setShowAll] = useState(false);
  const { spending } = data;
  if (spending.mySpend <= 0 && spending.othersShare <= 0) return null;
  const categories = showAll ? spending.topCategories : spending.topCategories.slice(0, CATEGORY_PREVIEW);
  return (
    <section aria-labelledby="mm-spending" className={PANEL}>
      <PanelHeader id="mm-spending" icon={ShoppingBag} title="Where your money went" subtitle={<p>Your own spending, by category</p>} action={{ href: "/transactions", label: "Transactions" }} />

      {categories.length > 0 && (
        <ul className="flex flex-col gap-2.5 px-4 py-3">
          {categories.map((c) => {
            const Icon = categoryIconFor(c.iconKey);
            return (
              <li key={c.categoryId} className="flex items-center gap-2.5">
                <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-full", TONE_BADGE[categoryToneFor(c.iconKey)])} aria-hidden>
                  <Icon className="size-3.5" strokeWidth={1.9} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-sm font-medium text-foreground">{c.name}</span>
                    <span className="shrink-0 text-sm font-semibold text-foreground tabular-nums">
                      {formatCurrency(c.amount)}
                      <span className="ml-1.5 text-[11px] font-medium text-foreground/60">{c.percent}%</span>
                    </span>
                  </span>
                  <span className="mt-1 block h-1 overflow-hidden rounded-full bg-secondary">
                    <span className="block h-full rounded-full bg-primary-accent-text/70" style={{ width: `${Math.max(2, c.percent)}%` }} />
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {spending.topCategories.length > CATEGORY_PREVIEW && (
        <button
          type="button"
          onClick={() => setShowAll((s) => !s)}
          className="w-full border-t border-border-strong/50 px-4 py-2 text-xs font-semibold text-primary-accent-text transition-colors hover:bg-primary/10 focus-visible:ring-2 focus-visible:ring-primary-accent-text focus-visible:outline-none focus-visible:ring-inset"
        >
          <span className="inline-flex items-center justify-center gap-1">
            {showAll ? "Show fewer" : `All ${spending.topCategories.length} categories`}
            <ChevronDown className={cn("size-3.5 transition-transform", showAll && "rotate-180")} />
          </span>
        </button>
      )}

      {(spending.sharedMine > 0 || spending.othersShare > 0) && (
        <dl className="grid gap-1 border-t border-border-strong/50 bg-secondary/40 px-4 py-2.5 text-xs">
          {spending.sharedMine > 0 && (
            <div className="flex justify-between gap-2">
              <dt className="text-foreground/75">Your part of shared expenses</dt>
              <dd className="font-semibold text-foreground tabular-nums">{formatCurrency(spending.sharedMine)}</dd>
            </div>
          )}
          {spending.othersShare > 0 && (
            <div className="flex justify-between gap-2">
              <dt className="text-foreground/75">Paid for others (not your spending)</dt>
              <dd className="font-semibold text-foreground tabular-nums">{formatCurrency(spending.othersShare)}</dd>
            </div>
          )}
        </dl>
      )}
    </section>
  );
}

// ─────────────────────────── page ───────────────────────────

function LoadingState() {
  return (
    <div className="flex min-w-0 flex-col gap-4 px-1">
      <Skeleton className="h-12 w-full max-w-md rounded-[10px]" />
      <Skeleton className="h-40 w-full rounded-[14px]" />
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <div className="flex flex-col gap-4">
          <Skeleton className="h-64 rounded-[14px]" />
          <Skeleton className="h-16 rounded-[14px]" />
        </div>
        <div className="flex flex-col gap-4">
          <Skeleton className="h-72 rounded-[14px]" />
          <Skeleton className="h-48 rounded-[14px]" />
        </div>
      </div>
    </div>
  );
}

export function MyMoneyWorkspace() {
  const data = useMyMoneyData();
  const { watch: watchTitle, progress: barProgress, reduceMotion: barReduceMotion, barTop } = useCompactHeader();
  if (data.isLoading) return <LoadingState />;
  return (
    <div className="flex min-w-0 flex-col gap-4 px-1">
      <MyMoneyCompactBar progress={barProgress} reduceMotion={barReduceMotion} top={barTop} data={data} next={data.toPay.next} />
      <Header data={data} titleRef={watchTitle} />
      <Summary data={data} />
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <div className="flex min-w-0 flex-col gap-4">
          <ToPayPanel data={data} />
          <CompletedPanel data={data} />
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <CollectPanel data={data} />
          <SpendingPanel data={data} />
        </div>
      </div>
      <ScrollNav />
    </div>
  );
}
