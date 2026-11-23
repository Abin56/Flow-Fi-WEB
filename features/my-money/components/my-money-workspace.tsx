"use client";

import Link from "next/link";
import { useState } from "react";
import {
  ArrowRight,
  BarChart3,
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
import { useMyMoneyData, type CollectItem, type MyMoneyData, type SpendCategory } from "@/features/my-money/hooks/use-my-money-data";
import { daysUntil, type CompletedGroup, type ObligationItem, type ObligationKind, type ObligationStatus, type SharedPerson } from "@/features/my-money/lib/my-money";

const PANEL =
  "overflow-hidden rounded-[12px] border border-border-strong/60 bg-card shadow-e1 transition-[box-shadow,border-color] duration-300 hover:border-border-strong hover:shadow-e2";
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
  dueToday: "bg-warning/20 text-warning-foreground dark:text-warning ring-1 ring-warning/40",
  dueSoon: "bg-warning/12 text-warning-foreground dark:text-warning ring-1 ring-warning/30",
  upcoming: "bg-secondary text-foreground/80 ring-1 ring-border-strong/60",
  paid: "bg-success/12 text-success ring-1 ring-success/25",
};
const TONE_BADGE: Record<ToneName, string> = {
  primary: "bg-primary/10 text-primary-accent-text",
  expense: "bg-expense/10 text-expense",
  warning: "bg-warning/15 text-warning-foreground dark:text-warning",
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
  dueToday: "bg-warning/18 text-warning-foreground dark:text-warning ring-warning/45",
  dueSoon: "bg-warning/12 text-warning-foreground dark:text-warning ring-warning/35",
  upcoming: "bg-secondary/70 text-foreground ring-border-strong/60",
  paid: "bg-success/10 text-success ring-success/30",
};

function DateTile({ date, status, muted }: { date: Date; status: ObligationStatus; muted: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex w-10 shrink-0 flex-col items-center justify-center rounded-[8px] py-1 ring-1 transition-transform duration-200 group-hover/row:scale-105",
        muted ? "bg-muted text-foreground/60 ring-border-strong/50" : TILE_TONE[status],
      )}
    >
      <span className="text-[9.5px] leading-none font-semibold tracking-[0.06em] uppercase opacity-85">{date.toLocaleDateString("en-IN", { month: "short" })}</span>
      <span className="font-heading text-base leading-tight font-bold tabular-nums">{date.getDate()}</span>
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
    <div className="flex items-center gap-3 border-b border-border-strong/50 bg-secondary/25 px-4 py-3 sm:px-5">
      <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-primary/10 text-primary-accent-text">
        <Icon className="size-4" strokeWidth={1.9} />
      </span>
      <div className="min-w-0 flex-1">
        <h2 id={id} className="font-heading text-[15px] leading-tight font-semibold text-foreground">
          {title}
        </h2>
        <div className="space-y-0.5 text-xs leading-snug text-foreground/70">{subtitle}</div>
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
          <span className="block text-[11px] leading-tight text-foreground/65 tabular-nums">{data.rangeLabel}</span>
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
        <h1 className="font-heading text-[22px] leading-tight font-bold tracking-tight text-foreground sm:text-2xl">My Money</h1>
        <p className="mt-0.5 text-[13px] text-foreground/70">Your spending, upcoming payments, and money to collect — all in one place.</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {!data.isCurrent && (
          <button
            type="button"
            onClick={data.nav.current}
            className="inline-flex h-9 items-center gap-1.5 rounded-full border border-primary-accent-text/40 bg-primary/10 px-3 text-xs font-semibold text-foreground transition-colors hover:bg-primary/20 focus-visible:ring-2 focus-visible:ring-primary-accent-text focus-visible:outline-none"
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
        {!data.nav.isFollowingGlobalCycle && (
          <button
            type="button"
            onClick={data.nav.followGlobal}
            className="inline-flex h-7 items-center gap-1 rounded-[6px] border border-dashed border-border-strong px-2 text-xs font-semibold text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            Sync with top-bar cycle
          </button>
        )}
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
  accent = "bg-secondary text-foreground/60",
  bar = "bg-border-strong",
}: {
  className?: string;
  /** Thin status stripe along the cell's top edge — the figure's state at a glance. */
  bar?: string;
  icon: LucideIcon;
  /** The icon chip's tint — signals the figure's state (overdue, due soon, clear, neutral). */
  accent?: string;
  label: string;
  amount: number;
  tone?: string;
  meta: React.ReactNode;
  tip: string;
}) {
  return (
    <div className={cn("group/cell relative flex min-w-0 items-start gap-3 border-border-strong/50 px-4 py-3 transition-colors duration-200 hover:bg-secondary/30 sm:px-5", className)}>
      <span aria-hidden className={cn("absolute inset-x-0 top-0 h-[2px] opacity-60 transition-opacity duration-200 group-hover/cell:opacity-100", bar)} />
      <span aria-hidden className={cn("mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-[11px] ring-1 ring-inset ring-current/10 transition-transform duration-200 group-hover/cell:scale-105", accent)}>
        <Icon className="size-4" strokeWidth={2} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-1">
          <span className={LABEL}>{label}</span>
          <InfoTip label={`What ${label} means`}>{tip}</InfoTip>
        </div>
        <span className={cn("font-heading text-[1.3rem] leading-tight font-bold tracking-tight break-words text-foreground tabular-nums sm:text-[1.5rem]", tone)}>{formatCurrency(amount)}</span>
        <span className="min-h-[1rem] line-clamp-2 text-xs leading-snug text-foreground/65">{meta}</span>
      </div>
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
          bar={toPay.overdue > 0 ? "bg-expense" : toPay.dueSoon > 0 ? "bg-warning" : toPay.count === 0 ? "bg-success" : "bg-primary-accent-text"}
          amount={toPay.total}
          tone={toPay.count === 0 ? "text-success" : toPay.overdue > 0 ? "text-expense" : undefined}
          accent={toPay.overdue > 0 ? "bg-expense/10 text-expense" : toPay.dueSoon > 0 ? "bg-warning/15 text-warning-foreground dark:text-warning" : toPay.count === 0 ? "bg-success/12 text-success" : "bg-primary/10 text-primary-accent-text"}
          meta={
            toPay.count === 0 ? (
              "Nothing due"
            ) : toPay.overdue > 0 || toPay.dueSoon > 0 ? (
              <span>
                {toPay.overdue > 0 && <span className="font-semibold text-expense">{formatCurrency(toPay.overdue)} overdue</span>}
                {toPay.overdue > 0 && toPay.dueSoon > 0 && " · "}
                {toPay.dueSoon > 0 && <span className="font-semibold text-warning-foreground dark:text-warning">{formatCurrency(toPay.dueSoon)} due soon</span>}
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
          bar={collect.total > 0 ? "bg-success" : "bg-border-strong"}
          amount={collect.total}
          tone={collect.total > 0 ? "text-success" : undefined}
          accent="bg-success/12 text-success"
          meta={collect.items.length === 0 ? "No one owes you today" : `Outstanding today · ${collect.items.length} ${collect.items.length === 1 ? "person" : "people"}`}
          tip="The total other people owe you as of today, from the People Ledger — everything still outstanding, not only this period. Money you hold as an advance is not counted here."
        />
        <SummaryCell
          label="My spending"
          icon={ShoppingBag}
          className="border-r"
          bar="bg-primary-accent-text"
          accent="bg-primary/10 text-primary-accent-text"
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
          bar={completed.total > 0 ? "bg-success" : "bg-border-strong"}
          accent="bg-success/12 text-success"
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
      <div className="flex items-center gap-2 border-t border-border-strong/50 bg-success/[0.05] px-4 py-1.5 text-xs font-medium text-foreground/75 sm:px-5">
        <CheckCircle2 className="size-3.5 shrink-0 text-success" />
        <span>{data.isPast ? "Nothing from this period is still unpaid." : "You're all caught up for this period."}</span>
      </div>
    );
  }
  const urgent = next.status === "overdue";
  return (
    <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border-strong/50 px-4 py-1.5 sm:px-5", urgent ? "bg-expense/[0.06]" : "bg-warning/[0.07]")}>
      <span className={cn("inline-flex items-center gap-1.5 text-[11px] font-bold tracking-[0.06em] uppercase", urgent ? "text-expense" : "text-warning-foreground dark:text-warning")}>
        <span aria-hidden className="relative flex size-1.5">
          <span className={cn("absolute inline-flex size-full animate-ping rounded-full opacity-60 motion-reduce:animate-none", urgent ? "bg-expense" : "bg-warning")} />
          <span className={cn("relative inline-flex size-1.5 rounded-full", urgent ? "bg-expense" : "bg-warning")} />
        </span>
        Next
      </span>
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
  partial: { label: "Partly received", className: "text-warning-foreground dark:text-warning" },
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
        "group/row border-l-[3px] px-4 py-2.5 transition-colors duration-150 hover:bg-secondary/40 sm:px-5",
        muted ? "border-l-transparent" : item.status === "overdue" ? "border-l-expense" : item.status === "dueToday" || item.status === "dueSoon" ? "border-l-warning" : "border-l-transparent",
      )}
    >
      <div className="flex items-center gap-3">
        <DateTile date={item.dueDate} status={item.status} muted={muted} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm leading-snug font-semibold text-foreground">{item.title}</p>
          <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="flex min-w-0 items-center gap-1 text-xs text-foreground/70">
              <Icon className="size-3 shrink-0" strokeWidth={2} aria-hidden />
              <span className="truncate">
                {KIND_LABEL[item.kind]} · {item.detail}
              </span>
            </span>
            {urgentChip && <Chip className={STATUS_CHIP[item.status]}>{STATUS_LABEL[item.status]}</Chip>}
            {partial && <Chip className="bg-warning/12 text-warning-foreground dark:text-warning ring-1 ring-warning/30">Partially paid</Chip>}
            {item.billStillOpen && <Chip className="bg-secondary text-foreground/80 ring-1 ring-border-strong/60">Bill still open</Chip>}
            {muted && <Chip className="bg-muted text-foreground/75 ring-1 ring-border-strong/60">Not in total</Chip>}
            <span className={cn("text-xs whitespace-nowrap", item.status === "overdue" ? "font-semibold text-expense" : "text-foreground/75")}>{relativeDue(item, now)}</span>
          </div>
        </div>
        <div className="shrink-0 text-right">
          <p className={cn("text-[15px] leading-tight font-bold tabular-nums", muted ? "text-foreground/60" : "text-foreground")}>{formatCurrency(item.remaining)}</p>
          {partial && <p className="text-[11px] text-foreground/65 tabular-nums">of {formatCurrency(item.amountDue)}</p>}
        </div>
        <Link href={item.href} className={cn(ACTION, "group/act")} aria-label={`${muted ? "View" : item.actionLabel}: ${item.title}`}>
          {muted ? "View" : item.actionLabel}
          <ArrowRight className="size-3 transition-transform duration-200 group-hover/act:translate-x-0.5" strokeWidth={2.2} />
        </Link>
      </div>

      <div className="pl-[52px]">
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

/** Paid vs still-to-pay for the period — a derived, display-only meter over figures the page already shows. */
function PeriodProgress({ data }: { data: MyMoneyData }) {
  const paid = data.completed.total;
  const left = data.toPay.total;
  const sum = paid + left;
  if (sum <= 0) return null;
  const percent = Math.min(100, Math.round((paid / sum) * 100));
  const overdue = data.toPay.overdue > 0;
  return (
    <div className="border-b border-border-strong/50 px-4 py-3 sm:px-5">
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className={LABEL}>Period progress</span>
        <span className="font-semibold text-foreground tabular-nums">{percent}% paid</span>
      </div>
      <div
        className="mt-1.5 flex h-2 overflow-hidden rounded-full bg-secondary"
        role="progressbar"
        aria-label="Share of this period's payments already paid"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className="h-full rounded-full bg-success transition-[width] duration-500 motion-reduce:transition-none" style={{ width: `${percent}%` }} />
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-3 text-[11px] text-foreground/70">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="size-1.5 rounded-full bg-success" />
          Paid <span className="font-semibold text-foreground tabular-nums">{formatCurrency(paid)}</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className={cn("size-1.5 rounded-full", overdue ? "bg-expense" : left > 0 ? "bg-warning" : "bg-border-strong")} />
          Left <span className={cn("font-semibold tabular-nums", overdue ? "text-expense" : "text-foreground")}>{formatCurrency(left)}</span>
        </span>
      </div>
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
            {toPay.count === 0 ? "All clear" : `${formatCurrency(toPay.total)} across ${toPay.count} payment${toPay.count === 1 ? "" : "s"}`}
            {toPay.othersStillOwe > 0 && <> · {formatCurrency(toPay.othersStillOwe)} of it is others&apos; share to collect</>}
          </p>
        }
      />
      <PeriodProgress data={data} />
      {collect.totalToGive > 0 && (
        <Link
          href="/people"
          className="group flex items-center gap-2 border-b border-border-strong/50 bg-warning/[0.08] px-4 py-2 text-xs transition-colors hover:bg-warning/[0.14] focus-visible:ring-2 focus-visible:ring-primary-accent-text focus-visible:outline-none focus-visible:ring-inset sm:px-5"
        >
          <Users aria-hidden className="size-3.5 shrink-0 text-warning-foreground dark:text-warning" />
          <span className="font-semibold text-foreground">You also owe people {formatCurrency(collect.totalToGive)}</span>
          <span className="ml-auto flex items-center gap-1 font-semibold text-primary-accent-text">
            Review
            <ArrowRight className="size-3 transition-transform group-hover:translate-x-0.5" strokeWidth={2.2} />
          </span>
        </Link>
      )}

      {data.obligations.length === 0 ? (
        <div className="flex items-center gap-3 bg-success/[0.04] px-4 py-5 sm:px-5">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-success/12 text-success ring-4 ring-success/[0.07]">
            <CheckCircle2 className="size-5" strokeWidth={1.9} />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-foreground">No card bills, installments or bills due</p>
            <p className="text-xs text-foreground/65">Nothing is scheduled or overdue for this period.</p>
          </div>
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
        className={cn(
          "flex w-full items-center justify-between gap-3 bg-secondary/25 px-4 py-3 text-left transition-colors hover:bg-secondary/50 focus-visible:ring-2 focus-visible:ring-primary-accent-text focus-visible:outline-none focus-visible:ring-inset sm:px-5",
          open && "border-b border-border-strong/50",
        )}
      >
        <span className="flex items-center gap-3">
          <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-success/12 text-success">
            <CheckCircle2 className="size-4" strokeWidth={1.9} />
          </span>
          <span>
            <span className="block font-heading text-[15px] leading-tight font-semibold text-foreground">Completed</span>
            <span className="block text-xs text-foreground/70">
              {groups.length} paid · {formatCurrency(total)}
            </span>
          </span>
        </span>
        <span aria-hidden className="flex size-7 items-center justify-center rounded-full text-foreground/65">
          <ChevronDown className={cn("size-4 transition-transform duration-200", open && "rotate-180")} />
        </span>
      </button>
      {open && (
        <ul className="divide-y divide-border-strong/40 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-200">
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
      <Link href={group.href} className="group/row flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-secondary/40 focus-visible:bg-secondary/60 focus-visible:outline-none sm:px-5">
        {group.lastDate ? (
          <DateTile date={group.lastDate} status="paid" muted={false} />
        ) : (
          <span className="flex w-10 shrink-0 items-center justify-center self-stretch rounded-[8px] bg-success/10 py-1 text-success ring-1 ring-success/30" aria-hidden>
            <Icon className="size-4" strokeWidth={1.9} />
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm leading-snug font-semibold text-foreground">{group.title}</span>
          <span className="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-foreground/70">
            <Icon className="size-3 shrink-0" strokeWidth={2} aria-hidden />
            <span className="truncate">{completedWhen(group)}</span>
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1">
          <span className="text-[15px] font-bold text-foreground tabular-nums">{formatCurrency(group.amount)}</span>
          <ChevronRight aria-hidden className="-mr-1 size-3.5 text-foreground/30 transition-all group-hover/row:translate-x-0.5 group-hover/row:text-foreground/70" />
        </span>
      </Link>
    </li>
  );
}

// ─────────────────────────── to collect ───────────────────────────

const COLLECT_PREVIEW = 5;

function expectedText(expected: NonNullable<CollectItem["expected"]>): { text: string; className: string } {
  if (expected.status === "overdue") return { text: `Follow up · expected ${shortDate(expected.date)}`, className: "font-semibold text-expense" };
  if (expected.status === "dueToday") return { text: "Expected today", className: "font-semibold text-warning-foreground dark:text-warning" };
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
            <p title={data.isCurrent ? undefined : "Everything still outstanding today — not limited to this period"}>
              <span className="font-semibold text-foreground tabular-nums">{formatCurrency(collect.total)}</span> outstanding today{data.isCurrent ? "" : " · all periods"}
            </p>
            {collect.collectedInPeriod > 0 && (
              <p className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-px text-[11px] font-semibold text-success tabular-nums">
                <CheckCircle2 aria-hidden className="size-3" />
                {formatCurrency(collect.collectedInPeriod)} received in this period
              </p>
            )}
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
                <Link href={p.href} className="group flex items-start gap-3 px-4 py-2.5 transition-colors hover:bg-secondary/40 focus-visible:bg-secondary/60 focus-visible:outline-none">
                  <span className={cn("mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full text-sm font-bold ring-2 ring-card transition-transform duration-200 group-hover:scale-105", avatarTone(p.name))} aria-hidden>
                    {p.name.trim().charAt(0).toUpperCase() || "?"}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-foreground">{p.name}</span>
                    <span className="block truncate text-xs text-foreground/70">{p.reasons.length > 0 ? p.reasons.slice(0, 2).join(" · ") : "Waiting to receive"}</span>
                    {(expected || p.partlyReceived > 0 || p.alsoOwe > 0) && (
                      <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]">
                        {expected && (
                          <span className={cn("inline-flex items-center gap-1", expected.className)}>
                            <CalendarDays aria-hidden className="size-3 shrink-0" strokeWidth={2} />
                            {expected.text}
                          </span>
                        )}
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

function CategoryBars({ categories }: { categories: SpendCategory[] }) {
  return (
    <ul className="flex flex-col gap-3 px-4 py-3.5">
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
  );
}

const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Extra to the per-period view above: the same "my spending" figures, folded across the whole year. */
function YearSpendingPanel({ data }: { data: MyMoneyData }) {
  const [showAll, setShowAll] = useState(false);
  const ys = data.yearSpending;
  const categories = showAll ? ys.topCategories : ys.topCategories.slice(0, CATEGORY_PREVIEW);
  const [hovered, setHovered] = useState<number | null>(null);
  const maxMonth = Math.max(...ys.months.map((m) => m.amount), 0);
  // The dashed average line shares the bars' scale, so it can never sit above the chart.
  const scaleMax = Math.max(maxMonth, ys.monthlyAverage ?? 0);
  const avgPercent = ys.monthlyAverage != null && ys.monthlyAverage > 0 && scaleMax > 0 ? Math.min(100, (ys.monthlyAverage / scaleMax) * 100) : null;
  const selectedMonth = data.cycleRange.end.getFullYear() === ys.year ? data.cycleRange.end.getMonth() : -1;
  const readout = ys.months[hovered ?? selectedMonth] ?? null;
  const { comparison } = ys;
  return (
    <section id="mm-year-spending" aria-labelledby="mm-year" className={PANEL}>
      <div className="flex items-center gap-3 border-b border-border-strong/50 bg-secondary/25 px-4 py-3 sm:px-5">
        <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-primary/10 text-primary-accent-text">
          <BarChart3 className="size-4" strokeWidth={1.9} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="mm-year" className="font-heading text-[15px] leading-tight font-semibold text-foreground">
            Spending this year
          </h2>
          <p className="text-xs leading-snug text-foreground/70 tabular-nums">{ys.rangeLabel}</p>
        </div>
        <div className="flex items-center rounded-[8px] border border-border-strong bg-card p-0.5">
          <button type="button" onClick={ys.nav.previous} aria-label="Previous year" className={cn(ICON_BUTTON, "size-7")}>
            <ChevronLeft className="size-4" strokeWidth={1.9} />
          </button>
          <span className="min-w-[2.75rem] text-center text-sm font-semibold text-foreground tabular-nums" aria-live="polite">
            {ys.year}
          </span>
          <button type="button" onClick={ys.nav.next} aria-label="Next year" className={cn(ICON_BUTTON, "size-7")}>
            <ChevronRight className="size-4" strokeWidth={1.9} />
          </button>
        </div>
      </div>

      <div className="px-4 pt-3 pb-1 sm:px-5">
        <div className="flex items-center gap-1">
          <span className={LABEL}>My spending in {ys.year}</span>
          <InfoTip label="What this year total means">
            The same own-spending figure as the period view — your share of split purchases, no transfers, card bill payments, loan principal, reimbursements or advances — added up across every Month Cycle of the year.
          </InfoTip>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <p className="font-heading text-[1.65rem] leading-tight font-bold tracking-tight text-foreground tabular-nums">{formatCurrency(ys.total)}</p>
          {comparison.kind === "change" ? (
            <Chip className={cn("h-6 gap-1 ring-1", comparison.percent > 0 ? "bg-expense/10 text-expense ring-expense/25" : "bg-success/12 text-success ring-success/25")}>
              {comparison.percent > 0 ? "▲ +" : comparison.percent < 0 ? "▼ " : ""}
              {comparison.percent}% vs {ys.year - 1}
            </Chip>
          ) : comparison.kind === "inProgress" ? (
            <Chip className="h-6 bg-secondary text-foreground/80 ring-1 ring-border-strong/60">{ys.year - 1}: {formatCurrency(comparison.previous)}</Chip>
          ) : null}
        </div>
        <p className="text-xs leading-snug text-foreground/65">
          {ys.activeMonths === 0
            ? `Nothing recorded yet in ${ys.year}`
            : `Across ${ys.activeMonths} month${ys.activeMonths === 1 ? "" : "s"} with spending${comparison.kind === "change" ? ` · ${ys.year - 1}: ${formatCurrency(comparison.previous)}` : ""}`}
        </p>
      </div>

      <dl className="grid grid-cols-2 gap-px border-y border-border-strong/50 bg-border-strong/40 text-xs">
        <div className="bg-card px-4 py-2.5 sm:px-5">
          <dt className="text-foreground/70">Monthly average</dt>
          <dd className="text-sm font-semibold text-foreground tabular-nums">{ys.monthlyAverage == null ? "—" : formatCurrency(ys.monthlyAverage)}</dd>
        </div>
        <div className="bg-card px-4 py-2.5 sm:px-5">
          <dt className="text-foreground/70">Highest month</dt>
          <dd className="text-sm font-semibold text-foreground tabular-nums">
            {ys.peak ? (
              <>
                {MONTHS_SHORT[ys.peak.month]} <span className="font-medium text-foreground/70">· {formatCurrency(ys.peak.amount)}</span>
              </>
            ) : (
              "—"
            )}
          </dd>
        </div>
      </dl>

      <div className="px-4 pt-3 pb-3 sm:px-5">
        <div className="mb-2 flex min-h-[1.25rem] items-center justify-between gap-2 text-xs" aria-live="polite">
          {readout ? (
            <>
              <span className="font-semibold text-foreground">
                {MONTHS_LONG[readout.month]} {ys.year}
              </span>
              <span className="text-foreground/75 tabular-nums">
                {readout.started ? (
                  <>
                    <span className="font-semibold text-foreground">{formatCurrency(readout.amount)}</span>
                    {ys.monthlyAverage != null && ys.monthlyAverage > 0 && readout.amount > 0 && (
                      <span className="ml-1.5">
                        {readout.amount >= ys.monthlyAverage ? "▲" : "▼"} {Math.abs(Math.round(((readout.amount - ys.monthlyAverage) / ys.monthlyAverage) * 100))}% vs avg
                      </span>
                    )}
                  </>
                ) : (
                  "Not started yet"
                )}
              </span>
            </>
          ) : (
            <span className="text-foreground/65">Tap a month to open it above</span>
          )}
        </div>
        <div className="relative">
          {avgPercent != null && (
            <div aria-hidden className="pointer-events-none absolute inset-x-0 z-10 border-t border-dashed border-foreground/35" style={{ bottom: `${avgPercent}%` }}>
              <span className="absolute -top-4 right-0 rounded bg-card/90 px-1 text-[9.5px] leading-4 font-semibold text-foreground/70">avg</span>
            </div>
          )}
          <div className="flex h-28 items-end gap-[3px] border-b border-border-strong/60" role="group" aria-label={`Spending by month in ${ys.year}`} onMouseLeave={() => setHovered(null)}>
            {ys.months.map((m) => {
              const height = scaleMax > 0 ? Math.max(m.amount > 0 ? 4 : 0, Math.round((m.amount / scaleMax) * 100)) : 0;
              const isSelected = m.month === selectedMonth;
              const isPeak = ys.peak?.month === m.month && m.amount > 0;
              return (
                <button
                  key={m.month}
                  type="button"
                  aria-label={`${MONTHS_LONG[m.month]} ${ys.year}: ${m.started ? formatCurrency(m.amount) : "not started yet"}. Open this period`}
                  aria-pressed={isSelected}
                  onClick={() => data.nav.pickMonth(ys.year, m.month)}
                  onMouseEnter={() => setHovered(m.month)}
                  onFocus={() => setHovered(m.month)}
                  onBlur={() => setHovered(null)}
                  className="group/bar flex h-full min-w-0 flex-1 flex-col justify-end rounded-t-[4px] focus-visible:ring-2 focus-visible:ring-primary-accent-text focus-visible:outline-none"
                >
                  <span
                    className={cn(
                      "block w-full rounded-t-[4px] transition-[background-color,height] duration-300 motion-reduce:transition-none",
                      isSelected
                        ? "bg-primary-accent-text"
                        : m.started
                          ? isPeak
                            ? "bg-primary-accent-text/70 group-hover/bar:bg-primary-accent-text"
                            : "bg-primary-accent-text/40 group-hover/bar:bg-primary-accent-text/75"
                          : "bg-border-strong/30",
                    )}
                    style={{ height: m.started ? `${height}%` : "2px" }}
                  />
                </button>
              );
            })}
          </div>
        </div>
        <div className="mt-1 flex gap-[3px]" aria-hidden>
          {ys.months.map((m) => (
            <span
              key={m.month}
              className={cn(
                "min-w-0 flex-1 text-center text-[10px] leading-none",
                m.month === selectedMonth ? "font-bold text-foreground" : m.isCurrent ? "font-semibold text-foreground/80" : "text-foreground/55",
              )}
            >
              {MONTHS_SHORT[m.month]}
            </span>
          ))}
        </div>
      </div>

      {categories.length === 0 ? (
        <p className="border-t border-border-strong/50 px-4 py-4 text-xs text-foreground/70 sm:px-5">No spending of your own recorded for {ys.year}.</p>
      ) : (
        <div className="border-t border-border-strong/50">
          <h3 className={cn(GROUP_HEADING, "border-t-0")}>
            <span>By category</span>
            <span className="text-foreground/60 tabular-nums">· {ys.topCategories.length}</span>
          </h3>
          <CategoryBars categories={categories} />
        </div>
      )}
      {ys.topCategories.length > CATEGORY_PREVIEW && (
        <button
          type="button"
          onClick={() => setShowAll((s) => !s)}
          className="w-full border-t border-border-strong/50 px-4 py-2 text-xs font-semibold text-primary-accent-text transition-colors hover:bg-primary/10 focus-visible:ring-2 focus-visible:ring-primary-accent-text focus-visible:outline-none focus-visible:ring-inset"
        >
          <span className="inline-flex items-center justify-center gap-1">
            {showAll ? "Show fewer" : `All ${ys.topCategories.length} categories`}
            <ChevronDown className={cn("size-3.5 transition-transform", showAll && "rotate-180")} />
          </span>
        </button>
      )}
      {ys.nav.isOverridden && (
        <button
          type="button"
          onClick={ys.nav.reset}
          className="w-full border-t border-border-strong/50 px-4 py-2 text-xs font-semibold text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary-accent-text focus-visible:outline-none focus-visible:ring-inset"
        >
          Back to the selected period&apos;s year
        </button>
      )}
    </section>
  );
}

function SpendingPanel({ data }: { data: MyMoneyData }) {
  const [showAll, setShowAll] = useState(false);
  const { spending } = data;
  if (spending.mySpend <= 0 && spending.othersShare <= 0) return null;
  const categories = showAll ? spending.topCategories : spending.topCategories.slice(0, CATEGORY_PREVIEW);
  return (
    <section aria-labelledby="mm-spending" className={PANEL}>
      <PanelHeader id="mm-spending" icon={ShoppingBag} title="Where your money went" subtitle={<p>Your own spending, by category</p>} action={{ href: "/transactions", label: "Transactions" }} />

      {categories.length === 0 && (
        <p className="px-4 py-4 text-xs text-foreground/70 sm:px-5">No spending of your own recorded for this period yet.</p>
      )}
      {categories.length > 0 && <CategoryBars categories={categories} />}
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
        <dl className="grid gap-1.5 border-t border-border-strong/50 bg-secondary/40 px-4 py-3 text-xs">
          {spending.sharedMine > 0 && (
            <div className="flex items-center justify-between gap-2">
              <dt className="flex items-center gap-1.5 text-foreground/75">
                <Users aria-hidden className="size-3.5 shrink-0 text-foreground/55" />
                Your part of shared expenses
              </dt>
              <dd className="font-semibold text-foreground tabular-nums">{formatCurrency(spending.sharedMine)}</dd>
            </div>
          )}
          {spending.othersShare > 0 && (
            <div className="flex items-center justify-between gap-2">
              <dt className="flex items-center gap-1.5 text-foreground/75">
                <HandCoins aria-hidden className="size-3.5 shrink-0 text-foreground/55" />
                Paid for others (not your spending)</dt>
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
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] xl:grid-cols-[minmax(0,1fr)_minmax(0,24rem)] 2xl:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
        <div className="flex min-w-0 flex-col gap-4">
          <ToPayPanel data={data} />
          <CompletedPanel data={data} />
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <CollectPanel data={data} />
          <SpendingPanel data={data} />
          <YearSpendingPanel data={data} />
        </div>
      </div>
      <ScrollNav />
    </div>
  );
}
