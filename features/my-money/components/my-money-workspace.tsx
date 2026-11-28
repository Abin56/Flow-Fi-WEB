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
import { formatCurrency, formatCurrencyExact } from "@/lib/format";
import { ordinalDay } from "@/lib/engines/month-cycle-range";
import { cn } from "@/lib/utils";
import { useCompactHeader } from "@/components/layout/compact-header";
import { ScrollNav } from "@/components/layout/scroll-nav";
import { MyMoneyCompactBar } from "@/features/my-money/components/my-money-compact-bar";
import { categoryIconFor, categoryToneFor, type ToneName } from "@/features/transactions/hooks/use-transactions-data";
import { useMyMoneyData, type CollectItem, type MyMoneyData, type SpendCategory } from "@/features/my-money/hooks/use-my-money-data";
import { daysUntil, type CompletedGroup, type ObligationItem, type ObligationKind, type ObligationStatus, type SharedPerson } from "@/features/my-money/lib/my-money";

const PANEL =
  "min-w-0 overflow-hidden rounded-xl border border-border-strong/60 bg-card shadow-e1";
const ACTION =
  "inline-flex h-8 shrink-0 items-center gap-1 rounded-[7px] border border-border-strong bg-card px-2.5 text-xs font-semibold text-foreground transition-colors hover:border-primary-accent-text/60 hover:bg-primary/10 focus-visible:ring-2 focus-visible:ring-primary-accent-text focus-visible:outline-none";
const ICON_BUTTON =
  "flex size-8 items-center justify-center rounded-[6px] text-foreground/70 transition-colors hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary-accent-text focus-visible:outline-none";
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const KIND_ICON: Record<ObligationKind, LucideIcon> = { card: CreditCard, loan: Landmark, emi: Smartphone, bill: Receipt };
const KIND_LABEL: Record<ObligationKind, string> = { card: "Card bill", loan: "Loan", emi: "EMI", bill: "Bill" };

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
        "flex w-9 shrink-0 flex-col items-center justify-center rounded-lg py-1 ring-1 sm:w-10 md:w-7",
        muted ? "bg-muted text-foreground/60 ring-border-strong/50" : TILE_TONE[status],
      )}
    >
      <span className="text-[10px] leading-none font-semibold">{date.toLocaleDateString("en-IN", { month: "short" })}</span>
      <span className="font-heading text-base leading-tight font-bold tabular-nums">{date.getDate()}</span>
    </span>
  );
}

function Chip({ className, children }: { className: string; children: React.ReactNode }) {
  return <span className={cn("inline-flex min-h-5 items-center rounded-full px-2 py-0.5 text-[11px] leading-tight font-semibold", className)}>{children}</span>;
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
  subtitle?: React.ReactNode;
  action?: { href: string; label: string; labelClassName?: string };
}) {
  return (
    <div className="flex items-center gap-2.5 border-b border-border-strong/50 px-3 py-2.5 sm:px-4 md:gap-2 md:px-3 md:py-2">
      <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-primary/10 text-primary-accent-text md:size-6 md:rounded-md">
        <Icon className="size-4" strokeWidth={1.9} />
      </span>
      <div className="min-w-0 flex-1">
        <h2 id={id} className="font-heading text-[15px] leading-tight font-semibold text-foreground">
          {title}
        </h2>
        {subtitle && <div className="mt-0.5 space-y-0.5 text-xs leading-snug text-foreground/70">{subtitle}</div>}
      </div>
      {action && (
        <Link href={action.href} title={action.labelClassName ? action.label : undefined} className="group inline-flex shrink-0 items-center gap-1 rounded-[6px] py-1 text-xs font-semibold text-primary-accent-text hover:underline focus-visible:ring-2 focus-visible:ring-primary-accent-text focus-visible:outline-none">
          <span className={action.labelClassName}>{action.label}</span>
          <ArrowRight aria-hidden className="size-3 transition-transform group-hover:translate-x-0.5" strokeWidth={2.2} />
        </Link>
      )}
    </div>
  );
}

function InfoTip({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" aria-label={label} className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-foreground/55 hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary-accent-text focus-visible:outline-none">
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
  const mobileLabel = data.isCustomCycle
    ? data.periodLabel
    : selected.toLocaleDateString("en-IN", { month: "short", year: "numeric" });
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
        <button type="button" aria-label={`Choose period, ${data.periodLabel}${data.isCustomCycle ? ` ${selected.getFullYear()}` : ""}`} title={data.isCustomCycle ? undefined : data.rangeLabel} className="min-h-8 rounded-md px-1.5 text-center transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-primary-accent-text focus-visible:outline-none max-[359px]:px-0.5 sm:px-2">
          <span className="flex items-center justify-center gap-1.5 text-sm leading-tight font-semibold text-foreground" aria-live="polite">
            <span className="min-[360px]:hidden">{mobileLabel}</span>
            <span className="hidden min-[360px]:inline">{data.periodLabel}{data.isCustomCycle && ` ${selected.getFullYear()}`}</span>
            <CalendarDays aria-hidden className="hidden size-3.5 shrink-0 text-foreground/60 sm:block" />
          </span>
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
    <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
      <div ref={titleRef} className="min-w-0">
        <h1 className="font-heading text-[22px] leading-tight font-bold tracking-tight text-foreground max-[359px]:text-xl sm:text-2xl">My Money</h1>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <div className="flex items-center rounded-[8px] border border-border-strong bg-card p-0.5">
          <button type="button" onClick={data.nav.previous} aria-label="Previous period" className={cn(ICON_BUTTON, "max-[359px]:size-7")}>
            <ChevronLeft className="size-4" strokeWidth={1.9} />
          </button>
          <PeriodPicker data={data} />
          <button type="button" onClick={data.nav.next} aria-label="Next period" className={cn(ICON_BUTTON, "max-[359px]:size-7")}>
            <ChevronRight className="size-4" strokeWidth={1.9} />
          </button>
        </div>
        <InfoTip label="About this period">
          {data.isCustomCycle
            ? `Your month starts on the ${ordinalDay(data.startDay)}. Card bills follow their own dates.`
            : "This period follows the calendar month. Card bills follow their own dates."}
        </InfoTip>
        {!data.isCurrent && (
          <button type="button" onClick={data.nav.current} className={ACTION}>
            <RotateCcw aria-hidden className="size-3" />
            This month
          </button>
        )}
        {!data.nav.isFollowingGlobalCycle && (
          <button
            type="button"
            onClick={data.nav.followGlobal}
            className="inline-flex h-7 items-center gap-1 rounded-[6px] border border-dashed border-border-strong px-2 text-xs font-semibold text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            Follow top bar
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
}: {
  className?: string;
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
    <div className={cn("min-w-0 border-border-strong/45 px-3 py-2 max-[359px]:px-2 max-[359px]:py-1 sm:px-4 sm:py-2.5 md:px-3 md:py-1.5", className)}>
      <div className="mb-1 flex items-center gap-1.5 max-[359px]:mb-0.5 max-[359px]:gap-1">
        <span aria-hidden className={cn("flex size-6 shrink-0 items-center justify-center rounded-md max-[359px]:size-5 md:size-5", accent)}>
          <Icon className="size-3.5" strokeWidth={2} />
        </span>
        <span className="text-xs font-semibold leading-tight text-foreground/80 sm:text-sm md:text-xs lg:text-sm">{label}</span>
        <InfoTip label={`What ${label} means`}>{tip}</InfoTip>
      </div>
      <p className={cn("font-heading text-xl leading-tight font-bold tracking-tight wrap-anywhere tabular-nums sm:text-2xl", tone ?? "text-foreground")}>{formatCurrency(amount)}</p>
      <div className="mt-0.5 text-xs leading-snug text-foreground/70 max-[359px]:text-[11px]">{meta}</div>
    </div>
  );
}

function Summary({ data }: { data: MyMoneyData }) {
  const { toPay, collect, spending, completed } = data;
  const next = toPay.next;
  const comparison = spending.comparison;
  return (
    <section id="mm-summary" aria-label="Period summary" className={cn(PANEL, "@container/summary")}>
      <div className="grid grid-cols-2 md:@min-[34rem]/summary:grid-cols-4">
        <SummaryCell
          label="To pay"
          icon={Wallet}
          className="border-r border-b md:@min-[34rem]/summary:border-b-0"
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
          tip="Unpaid bills, card bills, loans and EMIs for this period, including older overdue payments."
        />
        <SummaryCell
          label="To collect"
          icon={HandCoins}
          className="border-b md:@min-[34rem]/summary:border-r md:@min-[34rem]/summary:border-b-0"
          amount={collect.total}
          tone={collect.total > 0 ? "text-success" : undefined}
          accent="bg-success/12 text-success"
          meta={collect.items.length === 0 ? "No money to collect" : `Owed today by ${collect.items.length} ${collect.items.length === 1 ? "person" : "people"}`}
          tip="What people still owe you today, across all periods. Advances are shown separately."
        />
        <SummaryCell
          label="My spending"
          icon={ShoppingBag}
          className="border-r"
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
              `Last period ${formatCurrency(comparison.previous)}`
            ) : (
              `${spending.purchaseCount} purchase${spending.purchaseCount === 1 ? "" : "s"}`
            )
          }
          tip="What you spent on yourself this period, including your part of shared expenses. Moving money and paying back debt are excluded."
        />
        <SummaryCell
          label="Paid"
          icon={CheckCircle2}
          accent="bg-success/12 text-success"
          amount={completed.total}
          meta={completed.groups.length === 0 ? "No payments yet" : "This period"}
          tip="Payments recorded this period. If a bill payment has no date, it appears in the bill’s due period."
        />
      </div>
      <NextUp data={data} next={next} />
    </section>
  );
}

function NextUp({ data, next }: { data: MyMoneyData; next: ObligationItem | null }) {
  if (next == null) return null;
  const urgent = next.status === "overdue";
  return (
    <div className={cn("flex items-center gap-2 border-t border-border-strong/50 px-3 py-1.5 max-[359px]:px-2 max-[359px]:py-1 sm:gap-3 sm:px-4", urgent ? "bg-expense/[0.07]" : "bg-warning/[0.08]")}>
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", urgent ? "bg-expense" : "bg-warning")} />
      <div className="min-w-0 flex-1 md:flex md:flex-wrap md:items-baseline md:gap-x-2">
        <span className="sr-only">Next payment </span>
        <p className="text-sm leading-snug font-semibold text-foreground wrap-anywhere">{next.title}</p>
        <p className={cn("text-xs leading-snug", urgent ? "text-expense" : "text-foreground/70")}>
          {dueText(next, data.now)} <span aria-hidden>·</span> <span className="font-semibold text-foreground tabular-nums">{formatCurrency(next.remaining)}</span>
        </p>
      </div>
      <Link href={next.href} className={cn(ACTION, "border-primary-accent-text/50 bg-primary/12 px-2 sm:px-2.5 md:h-7")} aria-label={`${next.actionLabel}: ${next.title}`}>
        {next.actionLabel === "Continue payment" ? "Continue" : next.actionLabel}
        <ArrowRight aria-hidden className="size-3" strokeWidth={2.2} />
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
  const collectionLabel = shared.toCollect > 0 ? `To collect ${formatCurrency(shared.toCollect)}` : "All shares collected";
  const shareLabel = isCard ? "Includes others' share" : "Your share";
  const shareAmount = formatCurrency(isCard ? shared.othersShare : shared.myShare);
  return (
    <div className="rounded-b-[7px] border-t border-border-strong/25 bg-secondary/40">
      <button
        type="button"
        aria-label={`${collectionLabel}. ${shareLabel} ${shareAmount}`}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-7 w-full items-center gap-1.5 rounded-b-[7px] px-2.5 py-1 text-left text-[11px]/4 text-foreground/75 transition-colors hover:bg-primary/10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-accent-text focus-visible:outline-none"
      >
        <Users aria-hidden className="size-3 shrink-0 text-primary-accent-text" />
        <span className="min-w-0 flex-1">
          {shared.toCollect > 0 ? (
            <>To collect <span className="font-semibold text-success tabular-nums">{formatCurrency(shared.toCollect)}</span></>
          ) : (
            <span className="font-semibold text-success">{collectionLabel}</span>
          )}
        </span>
        <ChevronDown aria-hidden className={cn("size-3 shrink-0 text-foreground/65 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <ul className="divide-y divide-border-strong/20 border-t border-border-strong/25 px-2.5 py-1">
          {!isCard && (
            <li className="flex items-center justify-between gap-2 py-1 text-xs">
              <span className="font-medium text-foreground">You</span>
              <span className="tabular-nums text-foreground">{formatCurrency(shared.myShare)}</span>
            </li>
          )}
          <li className="flex items-center justify-between gap-2 py-1 text-xs font-medium text-foreground">
            <span>Others’ share</span>
            <span className="tabular-nums">{formatCurrency(shared.othersShare)}</span>
          </li>
          {shared.people.map((p) => (
            <li key={p.personId} className="flex items-center justify-between gap-2 py-1 text-xs">
              <span className="min-w-0 truncate font-medium text-foreground">{p.name}</span>
              <span className="flex min-w-0 flex-wrap items-center justify-end gap-x-2 tabular-nums">
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

function ObligationTile({ item, now, className }: { item: ObligationItem; now: Date; className?: string }) {
  const Icon = KIND_ICON[item.kind];
  const partial = item.amountPaid > 0 && item.remaining > 0;
  const paidPercent = item.amountDue > 0 ? Math.min(100, Math.round((item.amountPaid / item.amountDue) * 100)) : 0;
  const muted = !item.countsTowardTotal;
  const urgent = item.status === "overdue" || item.status === "dueToday" || item.status === "dueSoon";
  const kind = KIND_LABEL[item.kind];
  const lenderPrefix = `${item.title} · `;
  const description = item.detail.startsWith(lenderPrefix) ? item.detail.slice(lenderPrefix.length) : item.detail;
  const detail = item.installmentId ? description.replace(/(?:Installment |EMI )(\d+ of \d+)$/, "$1") : description;
  const action = muted ? "View" : item.actionLabel;
  return (
    <li
      className={cn(
        "group/row flex min-w-0 flex-col rounded-[10px] border border-border-strong/40 bg-card shadow-e1 transition-colors hover:border-border-strong/65",
        className,
      )}
    >
      <div className="grid min-w-0 gap-0.5 px-2.5 pt-2">
        <p className="truncate text-[13px]/4 font-semibold text-foreground" title={item.title}>{item.title}</p>
        <div className="flex min-w-0 items-center justify-between gap-1.5">
          <span className="flex min-w-0 items-center gap-1 text-[11px]/4 text-foreground/70">
            <Icon className="size-3 shrink-0" strokeWidth={2} aria-hidden />
            <span className="truncate" title={item.detail || undefined}>{kind}{detail && detail !== kind && ` · ${detail}`}</span>
          </span>
          <span
            className="shrink-0 rounded bg-secondary px-1.5 text-[10px]/4 font-medium whitespace-nowrap text-foreground/75"
            title={item.dueDate.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })}
          >
            {shortDate(item.dueDate)}
          </span>
        </div>
      </div>
      <div className="mt-auto flex flex-wrap items-center justify-between gap-x-1.5 gap-y-1 px-2.5 pt-1.5">
        <div className="min-w-0">
          <p className={cn("font-heading text-[17px]/5 font-bold wrap-anywhere tabular-nums", muted ? "text-foreground/70" : "text-foreground")}>{formatCurrency(item.remaining)}</p>
          {partial && <p className="text-[11px]/4 text-foreground/65 tabular-nums">of {formatCurrency(item.amountDue)}</p>}
        </div>
        <Link href={item.href} className={cn(
          ACTION,
          "ml-auto h-7 justify-center px-2",
          (action.startsWith("Pay") || action === "Continue payment") && "border-primary-accent-text/35 bg-primary/16 text-primary-accent-text hover:bg-primary/22",
        )} aria-label={`${action}: ${item.title}`}>
          {action === "Continue payment" ? "Continue" : action}
          <ArrowRight aria-hidden className="size-3" strokeWidth={2.2} />
        </Link>
      </div>
      <p className={cn(
        "flex items-center gap-1 px-2.5 pb-1.5 text-[11px]/4",
        item.status === "overdue" ? "font-medium text-expense" : urgent ? "font-medium text-warning-foreground dark:text-warning" : "text-foreground/75",
      )}>
        {urgent && <span aria-hidden className="size-1 shrink-0 rounded-full bg-current" />}
        {relativeDue(item, now)}
      </p>
      <div className="grid gap-1 px-2.5 pb-1.5 empty:hidden">
        {partial && (
          <div className="grid gap-1 text-[11px]">
            <div className="flex flex-wrap items-baseline justify-between gap-x-1.5">
              <span className="font-medium text-warning-foreground dark:text-warning">Partially paid</span>
              <span className="text-foreground/75 tabular-nums">{formatCurrency(item.amountPaid)} paid</span>
            </div>
            <div className="h-1 overflow-hidden rounded-full bg-secondary" role="progressbar" aria-valuenow={paidPercent} aria-valuemin={0} aria-valuemax={100} aria-label="Paid so far">
              <div className="h-full rounded-full bg-success" style={{ width: `${paidPercent}%` }} />
            </div>
          </div>
        )}
        {item.note && <p className="text-xs text-foreground/70">{item.note}</p>}
        {item.billStillOpen && <p className="text-xs text-foreground/70">This bill is still open, so the amount can change.</p>}
      </div>
      {item.shared && <SharedBreakdown item={item} />}
    </li>
  );
}

const GROUP_HEADING =
  "flex w-full items-center gap-1.5 border-t border-border-strong/35 px-3 py-1.5 text-xs font-semibold text-foreground sm:px-4 md:px-3";
const PAYMENT_TILES = "grid grid-cols-1 items-start gap-2 px-2.5 pb-2 pt-0.5 @min-[21rem]/payments:grid-cols-2";

function PaymentListToggle({ label, open, remaining, onClick }: { label: string; open: boolean; remaining: number; onClick: () => void }) {
  const text = open ? "Show fewer" : `Show ${remaining} more`;
  return (
    <button type="button" aria-label={`${text} in ${label}`} aria-expanded={open} onClick={onClick} className="hidden min-h-7 w-full items-center gap-1 border-t border-border-strong/40 px-3 text-xs font-semibold text-primary-accent-text hover:bg-primary/10 focus-visible:ring-2 focus-visible:ring-primary-accent-text focus-visible:outline-none focus-visible:ring-inset md:flex">
      {text}
      <ChevronDown aria-hidden className={cn("size-3.5 transition-transform", open && "rotate-180")} />
    </button>
  );
}

function ObligationGroup({ title, items, now, attention = false }: { title: string; items: ObligationItem[]; now: Date; attention?: boolean }) {
  const [showAll, setShowAll] = useState(false);
  const previewCount = attention ? 2 : 1;
  if (items.length === 0) return null;
  const total = items.reduce((s, i) => s + i.remaining, 0);
  return (
    <div>
      <h3 className={GROUP_HEADING}>
        {attention && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warning" />}
        <span>{title}</span>
        <span className="text-foreground/60 tabular-nums">· {items.length}</span>
        <span className="ml-auto font-bold text-foreground tabular-nums">{formatCurrency(total)}</span>
      </h3>
      <ul className={PAYMENT_TILES}>
        {items.map((item, index) => (
          <ObligationTile key={item.key} item={item} now={now} className={!showAll && index >= previewCount ? "md:hidden" : undefined} />
        ))}
      </ul>
      {items.length > previewCount && (
        <PaymentListToggle label={title} open={showAll} remaining={items.length - previewCount} onClick={() => setShowAll((value) => !value)} />
      )}
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
        <ul className={PAYMENT_TILES}>
          {items.map((item) => (
            <ObligationTile key={item.key} item={item} now={now} />
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
    <div className="border-b border-border-strong/35 bg-secondary/25 px-3 py-2 sm:px-4 md:px-3">
      <dl className="grid grid-cols-2 gap-x-3 text-xs/4 text-foreground/75">
        <div>
          <dt>Paid <span className="tabular-nums">({percent}%)</span></dt>
          <dd className="font-heading text-[15px]/5 font-bold wrap-anywhere text-success tabular-nums">{formatCurrency(paid)}</dd>
        </div>
        <div className="text-right">
          <dt>Left to pay</dt>
          <dd className={cn("font-heading text-[15px]/5 font-bold wrap-anywhere tabular-nums", overdue ? "text-expense" : "text-foreground")}>{formatCurrency(left)}</dd>
        </div>
      </dl>
      <div
        className="mt-1 flex h-1.5 overflow-hidden rounded-full bg-border-strong/20"
        role="progressbar"
        aria-label="Share of this period's payments already paid"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className="h-full rounded-full bg-success transition-[width] duration-500 motion-reduce:transition-none" style={{ width: `${percent}%` }} />
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
    <section id="mm-to-pay-section" aria-labelledby="mm-to-pay" className="@container/payments flex min-w-0 flex-col gap-3 md:gap-0 md:overflow-hidden md:rounded-xl md:border md:border-border-strong/60 md:bg-card md:shadow-e1">
      <div className={cn(PANEL, "md:contents")}>
        <PanelHeader
          id="mm-to-pay"
          icon={CalendarDays}
          title="Payments this period"
          subtitle={toPay.othersStillOwe > 0 && <p>{formatCurrency(toPay.othersStillOwe)} of this is owed to you</p>}
        />
        <PeriodProgress data={data} />
        {collect.totalToGive > 0 && (
          <Link
            href="/people"
            className="group flex items-center gap-2 border-b border-border-strong/50 bg-warning/[0.08] px-3 py-2 text-xs transition-colors hover:bg-warning/[0.14] focus-visible:ring-2 focus-visible:ring-primary-accent-text focus-visible:outline-none focus-visible:ring-inset sm:px-4 md:px-3 md:py-1.5"
          >
            <Users aria-hidden className="size-3.5 shrink-0 text-warning-foreground dark:text-warning" />
            <span className="font-semibold text-foreground">You owe people {formatCurrency(collect.totalToGive)}</span>
            <span className="ml-auto flex items-center gap-1 font-semibold text-primary-accent-text">
              Review
              <ArrowRight className="size-3 transition-transform group-hover:translate-x-0.5" strokeWidth={2.2} />
            </span>
          </Link>
        )}

        {data.obligations.length === 0 ? (
          <div className="flex items-center gap-2 px-3 py-3 text-sm text-foreground/75 sm:px-4 md:order-2 md:py-2">
            <CheckCircle2 aria-hidden className="size-4 shrink-0 text-success" />
            <p>No payments due this period.</p>
          </div>
        ) : (
          <div className="md:order-2 [&>*:first-child>h3]:border-t-0 [&>*:first-child>button]:border-t-0">
            <ObligationGroup title="Needs attention" items={attention} now={data.now} attention />
            <ObligationGroup title="Later this period" items={later} now={data.now} />
            <CoveredElsewhere items={elsewhere} now={data.now} />
          </div>
        )}
      </div>
      <CompletedPanel data={data} />
    </section>
  );
}

// ─────────────────────────── completed ───────────────────────────

function CompletedPanel({ data }: { data: MyMoneyData }) {
  // Collapsed while there are payments to act on; open when nothing is pending so the page isn't mostly empty.
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const [showAll, setShowAll] = useState(false);
  const { groups, total } = data.completed;
  const previewCount = 4;
  if (groups.length === 0) return null;
  const open = userOpen ?? data.obligations.length === 0;
  const setOpen = (fn: (o: boolean) => boolean) => setUserOpen(fn(open));
  return (
    <section id="mm-completed" aria-label="Completed payments" className={cn(PANEL, "md:order-1 md:rounded-none md:border-0 md:border-b md:bg-secondary/20 md:shadow-none")}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left transition-colors hover:bg-secondary/50 focus-visible:ring-2 focus-visible:ring-primary-accent-text focus-visible:outline-none focus-visible:ring-inset sm:px-4 md:gap-2 md:px-3 md:py-1.5",
          open && "border-b border-border-strong/50",
        )}
      >
        <span className="flex min-w-0 items-center gap-3 md:gap-2">
          <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-success/12 text-success md:size-6 md:rounded-md">
            <CheckCircle2 className="size-4" strokeWidth={1.9} />
          </span>
          <span className="md:flex md:flex-wrap md:items-baseline md:gap-x-3">
            <span className="block font-heading text-[15px] leading-tight font-semibold text-foreground">Payments made</span>
            <span className="block text-xs text-foreground/70">
              {groups.length} {groups.length === 1 ? "item" : "items"} · {formatCurrency(total)}
            </span>
          </span>
        </span>
        <span aria-hidden className="flex size-7 items-center justify-center rounded-full text-foreground/65">
          <ChevronDown className={cn("size-4 transition-transform duration-200", open && "rotate-180")} />
        </span>
      </button>
      {open && (
        <>
          <ul className="divide-y divide-border-strong/40 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-200">
            {groups.map((g, index) => (
              <CompletedRow key={g.key} group={g} className={!showAll && index >= previewCount ? "md:hidden" : undefined} />
            ))}
          </ul>
          {groups.length > previewCount && (
            <PaymentListToggle label="Payments made" open={showAll} remaining={groups.length - previewCount} onClick={() => setShowAll((value) => !value)} />
          )}
        </>
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

function CompletedRow({ group, className }: { group: CompletedGroup; className?: string }) {
  const Icon = KIND_ICON[group.kind];
  return (
    <li className={className}>
      <Link href={group.href} className="group/row flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-secondary/40 focus-visible:bg-secondary/60 focus-visible:outline-none sm:px-5 md:gap-2 md:px-3 md:py-1.5">
        {group.lastDate ? (
          <DateTile date={group.lastDate} status="paid" muted={false} />
        ) : (
          <span className="flex w-10 shrink-0 items-center justify-center self-stretch rounded-[8px] bg-success/10 py-1 text-success ring-1 ring-success/30" aria-hidden>
            <Icon className="size-4" strokeWidth={1.9} />
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block text-sm leading-snug font-semibold wrap-anywhere text-foreground">{group.title}</span>
          <span className="mt-0.5 flex min-w-0 items-center gap-1 text-xs leading-tight text-foreground/70">
            <Icon className="size-3 shrink-0" strokeWidth={2} aria-hidden />
            <span>{completedWhen(group)}</span>
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
const COLLECT_DESKTOP_PREVIEW = 3;
const COLLECT_NARROW_PREVIEW = 1;

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
    <section id="mm-collect-section" aria-labelledby="mm-collect" className={cn(PANEL, "@container/collect")}>
      <PanelHeader
        id="mm-collect"
        icon={HandCoins}
        title="Money to collect"
        action={{ href: "/people", label: "People" }}
        subtitle={
          <>
            <p>
              <span className="font-semibold text-foreground tabular-nums">{formatCurrency(collect.total)}</span> owed <span className="md:hidden">to you </span>today
            </p>
            {collect.collectedInPeriod > 0 && (
              <p className="inline-flex items-center gap-1 text-xs font-medium text-success tabular-nums">
                <CheckCircle2 aria-hidden className="size-3" />
                {formatCurrency(collect.collectedInPeriod)} received this period
              </p>
            )}
          </>
        }
      />

      {collect.items.length === 0 ? (
        <p className="px-3 py-3 text-sm text-foreground/75 sm:px-4">No one owes you money right now.</p>
      ) : (
        <ul className="divide-y divide-border-strong/40">
          {shown.map((p, index) => {
            const expected = p.expected ? expectedText(p.expected) : null;
            return (
              <li
                key={p.personId}
                className={cn(
                  !showAll && index >= COLLECT_DESKTOP_PREVIEW && "md:hidden",
                  !showAll && index >= COLLECT_NARROW_PREVIEW && "md:@max-[18rem]/collect:hidden",
                )}
              >
                <Link href={p.href} className="group flex items-start gap-2.5 px-3 py-2 transition-colors hover:bg-secondary/40 focus-visible:bg-secondary/60 focus-visible:outline-none sm:px-4 md:gap-2 md:px-3 md:py-1.5">
                  <span className={cn("mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-bold md:size-6 md:@max-[19rem]/collect:hidden", avatarTone(p.name))} aria-hidden>
                    {p.name.trim().charAt(0).toUpperCase() || "?"}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold wrap-anywhere text-foreground md:leading-tight">{p.name}</span>
                    {p.reasons.length > 0 && <span className="block text-xs text-foreground/70 md:leading-tight">{p.reasons.slice(0, 2).join(" · ")}</span>}
                    {(expected || p.partlyReceived > 0 || p.alsoOwe > 0 || p.postponed > 0) && (
                      <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]">
                        {expected && (
                          <span className={cn("inline-flex items-center gap-1", expected.className)}>
                            <CalendarDays aria-hidden className="size-3 shrink-0" strokeWidth={2} />
                            {expected.text}
                          </span>
                        )}
                        {p.postponed > 0 && (
                          <span className="font-medium text-foreground" data-testid="collect-due-split">
                            Due now {formatCurrency(Math.max(0, p.amount - p.postponed))} · {formatCurrency(p.postponed)} postponed
                          </span>
                        )}
                        {p.partlyReceived > 0 && <span className="text-foreground/75">{formatCurrency(p.partlyReceived)} received</span>}
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

      {collect.items.length > COLLECT_NARROW_PREVIEW && (
        <button
          type="button"
          aria-expanded={showAll}
          onClick={() => setShowAll((s) => !s)}
          className={cn(
            "w-full border-t border-border-strong/50 px-4 py-2 text-xs font-semibold text-primary-accent-text transition-colors hover:bg-primary/10 focus-visible:ring-2 focus-visible:ring-primary-accent-text focus-visible:outline-none focus-visible:ring-inset md:py-1.5",
            collect.items.length <= COLLECT_PREVIEW && "hidden",
            collect.items.length > COLLECT_DESKTOP_PREVIEW ? "md:block" : "md:@max-[18rem]/collect:block",
          )}
        >
          <span className="inline-flex items-center justify-center gap-1">
            {showAll ? "Show fewer" : `Show all ${collect.items.length}`}
            <ChevronDown className={cn("size-3.5 transition-transform", showAll && "rotate-180")} />
          </span>
        </button>
      )}
      {collect.advanceHeld > 0 && (
        <p className="flex items-start gap-2 border-t border-border-strong/50 bg-secondary/40 px-4 py-2.5 text-xs text-foreground/75 md:px-3 md:py-1.5">
          <Info aria-hidden className="mt-0.5 size-3.5 shrink-0 text-foreground/55" />
          <span>Unused advances <span className="font-semibold text-foreground tabular-nums">{formatCurrency(collect.advanceHeld)}</span></span>
        </p>
      )}
    </section>
  );
}

// ─────────────────────────── spending ───────────────────────────

const CATEGORY_PREVIEW = 4;

function CategoryBars({ categories }: { categories: SpendCategory[] }) {
  return (
    <ul className="flex flex-col gap-2.5 px-3 py-3 sm:px-4 md:gap-2 md:px-3 md:py-2">
      {categories.map((c) => {
        const Icon = categoryIconFor(c.iconKey);
        return (
          <li key={c.categoryId} className="flex items-center gap-2.5">
            <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-full", TONE_BADGE[categoryToneFor(c.iconKey)])} aria-hidden>
              <Icon className="size-3.5" strokeWidth={1.9} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline justify-between gap-2">
                <span className="min-w-0 text-sm font-medium wrap-anywhere text-foreground">{c.name}</span>
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

function YearSpendingPanel({ data }: { data: MyMoneyData }) {
  const [showAll, setShowAll] = useState(false);
  const ys = data.yearSpending;
  const categories = showAll ? ys.topCategories : ys.topCategories.slice(0, CATEGORY_PREVIEW);
  const { comparison } = ys;
  return (
    <section id="mm-year-spending" aria-labelledby="mm-year" className={cn(PANEL, "@container/year border-primary-accent-text/42")}>
      <div className="flex items-center gap-2.5 border-b border-primary-accent-text/20 bg-linear-to-r from-primary/22 to-primary/7 px-3 py-2 max-[359px]:gap-1.5 max-[359px]:px-2 max-[359px]:py-1 sm:px-4 md:gap-2 md:px-3 md:py-1.5">
        <span aria-hidden className="hidden size-7 shrink-0 items-center justify-center rounded-md bg-primary/35 text-primary-accent-text @min-[21rem]/year:flex">
          <BarChart3 className="size-4" strokeWidth={1.9} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="mm-year" className="font-heading text-[15px] leading-tight font-bold text-foreground">
            Spending this year
          </h2>
          {data.isCustomCycle && <p className="mt-0.5 text-xs leading-snug text-foreground/75 tabular-nums">{ys.rangeLabel}</p>}
        </div>
        {ys.nav.isOverridden && (
          <button type="button" onClick={ys.nav.reset} aria-label="Back to selected period’s year" title="Back to selected period’s year" className={cn(ICON_BUTTON, "shrink-0")}>
            <RotateCcw aria-hidden className="size-3.5" />
          </button>
        )}
        <div className="flex shrink-0 items-center rounded-lg border border-border-strong/70 bg-card">
          <button type="button" onClick={ys.nav.previous} aria-label="Previous year" className={cn(ICON_BUTTON, "max-[359px]:size-7 md:size-7")}>
            <ChevronLeft className="size-4" strokeWidth={1.9} />
          </button>
          <span className="min-w-9 text-center text-sm font-semibold text-foreground tabular-nums" aria-live="polite">
            {ys.year}
          </span>
          <button type="button" onClick={ys.nav.next} aria-label="Next year" className={cn(ICON_BUTTON, "max-[359px]:size-7 md:size-7")}>
            <ChevronRight className="size-4" strokeWidth={1.9} />
          </button>
        </div>
      </div>

      <div className="grid gap-3 bg-linear-to-b from-primary/9 to-transparent to-55% p-3 max-[359px]:gap-2 max-[359px]:p-2 sm:px-4 md:gap-2 md:p-2.5">
        <div className="min-w-0">
          <div className="max-[359px]:flex max-[359px]:flex-wrap max-[359px]:items-baseline max-[359px]:gap-x-2 md:flex md:flex-wrap md:items-baseline md:gap-x-2">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <p className="font-heading text-3xl leading-none font-bold tracking-tight wrap-anywhere text-primary-accent-text tabular-nums max-[359px]:text-2xl md:text-[1.75rem]">
                {formatCurrency(ys.total)}
              </p>
              <InfoTip label="What this year total means">Your own spending for the year, including your part of shared expenses.</InfoTip>
              {comparison.kind === "change" && (
                <Chip className={cn(comparison.percent > 0 ? "bg-expense/10 text-expense" : "bg-success/12 text-success")}>
                  {comparison.percent > 0 ? "+" : ""}{comparison.percent}% vs {ys.year - 1}
                </Chip>
              )}
            </div>
            <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-foreground/75">
              {ys.activeMonths === 0 ? "No spending recorded" : `Spent in ${ys.activeMonths} ${ys.activeMonths === 1 ? "month" : "months"}`}
              {comparison.kind !== "none" && <span>{ys.year - 1} total <strong className="text-foreground tabular-nums">{formatCurrency(comparison.previous)}</strong></span>}
            </div>
          </div>
          <dl className="mt-2 grid grid-cols-2 gap-2 border-t border-primary-accent-text/15 pt-1.5 text-xs max-[359px]:mt-1 md:mt-1.5">
            <div>
              <dt className="text-foreground/70">Monthly average</dt>
              <dd className="mt-0.5 font-semibold wrap-anywhere text-foreground tabular-nums">{ys.monthlyAverage == null ? "—" : formatCurrency(ys.monthlyAverage)}</dd>
            </div>
            <div>
              <dt className="text-foreground/70">Highest month</dt>
              <dd className="mt-0.5 font-semibold wrap-anywhere text-foreground tabular-nums">
                {ys.peak ? `${MONTHS_SHORT[ys.peak.month]} · ${formatCurrency(ys.peak.amount)}` : "—"}
              </dd>
            </div>
          </dl>
        </div>
        <YearSpendingChart key={ys.year} data={data} />
      </div>

      {categories.length > 0 && (
        <details className="group/year-categories border-t border-border-strong/50">
          <summary className="flex min-h-9 cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-xs font-semibold text-foreground/85 transition-colors hover:bg-secondary/60 focus-visible:ring-2 focus-visible:ring-primary-accent-text focus-visible:outline-none focus-visible:ring-inset sm:px-4 md:min-h-7 md:px-3 md:py-1 [&::-webkit-details-marker]:hidden">
            Spending by category
            <ChevronDown aria-hidden className="size-4 shrink-0 text-foreground/70 group-open/year-categories:rotate-180" />
          </summary>
          <CategoryBars categories={categories} />
          {ys.topCategories.length > CATEGORY_PREVIEW && (
            <button
              type="button"
              aria-expanded={showAll}
              onClick={() => setShowAll((s) => !s)}
              className="min-h-9 w-full border-t border-border-strong/50 px-3 py-2 text-xs font-semibold text-primary-accent-text transition-colors hover:bg-primary/10 focus-visible:ring-2 focus-visible:ring-primary-accent-text focus-visible:outline-none focus-visible:ring-inset"
            >
              {showAll ? "Show fewer" : `All ${ys.topCategories.length} categories`}
            </button>
          )}
        </details>
      )}
    </section>
  );
}

function YearSpendingChart({ data }: { data: MyMoneyData }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const [focused, setFocused] = useState<number | null>(null);
  const ys = data.yearSpending;
  const scaleMax = Math.max(...ys.months.map((m) => m.amount), ys.monthlyAverage ?? 0, 0);
  const average = ys.monthlyAverage ?? 0;
  const avgPercent = average > 0 && scaleMax > 0 ? (average / scaleMax) * 100 : null;
  const columnHeight = scaleMax === 0 ? "@min-[40rem]:h-9" : "@min-[40rem]:h-[4.5rem]";
  const selectedMonth = data.cycleRange.end.getFullYear() === ys.year ? data.cycleRange.end.getMonth() : -1;
  const readout = ys.months[hovered ?? focused ?? selectedMonth] ?? null;
  const monthChanges = ys.months.map((month) =>
    month.started && month.amount > 0 && average > 0 ? Math.round(((month.amount - average) / average) * 100) : null,
  );
  const changeFromAverage = readout ? monthChanges[readout.month] : null;
  return (
    <div className="@container flex min-w-0 flex-col rounded-lg bg-secondary/45 px-1.5 py-2 ring-1 ring-border-strong/20 ring-inset max-[359px]:py-1.5 sm:px-3 md:px-2 md:py-1.5">
      <div className="order-last mt-1.5 flex min-h-4 flex-wrap items-baseline justify-between gap-x-2 px-0.5 text-xs @min-[40rem]:order-first @min-[40rem]:mt-0 @min-[40rem]:mb-1.5 md:sr-only md:@min-[40rem]:not-sr-only" aria-live="polite">
        {readout ? (
          <>
            <span className="font-semibold text-foreground">{MONTHS_LONG[readout.month]}</span>
            <span className="text-foreground/75 tabular-nums">
              {readout.started ? (
                <>
                  <span className="font-semibold text-foreground">{formatCurrencyExact(readout.amount)}</span>
                  {changeFromAverage != null && <span className="ml-1.5">{changeFromAverage > 0 ? "+" : ""}{changeFromAverage}% vs avg</span>}
                </>
              ) : "Starts later"}
            </span>
          </>
        ) : (
          <span className="text-foreground/75">Choose a month to view that period</span>
        )}
      </div>
      <div className="relative grid grid-cols-4 gap-0.5 @min-[30rem]:grid-cols-6 @min-[40rem]:grid-cols-12 md:@min-[17rem]:grid-cols-6 md:@min-[40rem]:grid-cols-12" role="group" aria-label={`Spending by month in ${ys.year}`}>
        {avgPercent != null && (
          <div aria-hidden className={cn("pointer-events-none absolute inset-x-0 top-0 z-10 hidden @min-[40rem]:block", columnHeight)}>
            <div className="absolute inset-x-0 border-t border-dashed border-foreground/35" style={{ bottom: `${avgPercent}%` }} />
          </div>
        )}
        {ys.months.map((m) => {
          const fill = m.started && m.amount > 0 ? `${Math.max(4, (m.amount / scaleMax) * 100)}%` : "2px";
          const amount = m.started ? formatCurrencyExact(m.amount) : "—";
          const change = monthChanges[m.month];
          const isSelected = m.month === selectedMonth;
          const isPeak = ys.peak?.month === m.month && m.amount > 0;
          return (
            <button
              key={m.month}
              type="button"
              aria-label={`${MONTHS_LONG[m.month]} ${ys.year}: ${m.started ? amount : "not started yet"}. Open this period`}
              title={change == null ? undefined : `${amount} · ${change > 0 ? "+" : ""}${change}% vs average`}
              aria-pressed={isSelected}
              onClick={() => data.nav.pickMonth(ys.year, m.month)}
              onMouseEnter={() => setHovered(m.month)}
              onMouseLeave={() => setHovered(null)}
              onFocus={() => setFocused(m.month)}
              onBlur={() => setFocused(null)}
              className={cn(
                "group/bar flex min-w-0 flex-col items-stretch gap-px rounded-md px-1 py-0.5 text-foreground/75 hover:bg-primary/12 focus-visible:z-20 focus-visible:ring-2 focus-visible:ring-primary-accent-text focus-visible:outline-none @min-[40rem]:px-0 @min-[40rem]:pt-0 md:p-0",
                isPeak && !isSelected && "bg-primary/10",
                isSelected && "bg-primary/24 font-bold text-primary-accent-text ring-1 ring-primary-accent-text/30 ring-inset",
              )}
            >
              <span aria-hidden className={cn(
                "order-last mx-auto mt-px flex h-0.5 w-full max-w-14 overflow-hidden rounded-full bg-border-strong/25 @min-[40rem]:order-first @min-[40rem]:mt-0 @min-[40rem]:max-w-none @min-[40rem]:items-end @min-[40rem]:justify-center @min-[40rem]:rounded-none @min-[40rem]:border-b @min-[40rem]:border-border-strong/50 @min-[40rem]:bg-transparent",
                columnHeight,
              )}>
                <span
                  className={cn(
                    "block h-full w-(--bar-fill) rounded-t transition-colors motion-reduce:transition-none @min-[40rem]:h-(--bar-fill) @min-[40rem]:w-[68%]",
                    m.started ? "bg-primary-accent-text/55 group-hover/bar:bg-primary-accent-text" : "bg-border-strong/45",
                    (isSelected || isPeak) && "bg-primary-accent-text",
                  )}
                  style={{ "--bar-fill": fill } as React.CSSProperties}
                />
              </span>
              <span aria-hidden className={cn("text-center text-[11px] leading-3 @min-[40rem]:mt-1", m.isCurrent && "font-semibold")}>{MONTHS_SHORT[m.month]}</span>
              <span aria-hidden className={cn(
                "text-center text-[11px] leading-3.5 font-semibold wrap-anywhere tabular-nums md:@min-[40rem]:text-xs/4",
                m.amount !== 0 && m.started && "text-foreground",
                isSelected && "text-primary-accent-text",
              )}>{amount}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SpendingPanel({ data }: { data: MyMoneyData }) {
  const [showAll, setShowAll] = useState(false);
  const { spending } = data;
  if (spending.mySpend <= 0 && spending.othersShare <= 0) return null;
  const categories = showAll ? spending.topCategories : spending.topCategories.slice(0, CATEGORY_PREVIEW);
  return (
    <section aria-labelledby="mm-spending" className={cn(PANEL, "@container/period-spending")}>
      <PanelHeader id="mm-spending" icon={ShoppingBag} title="Spending this period" action={{ href: "/transactions", label: "Transactions", labelClassName: "md:@max-[18rem]/period-spending:sr-only" }} />

      {categories.length === 0 && (
        <p className="px-3 py-3 text-xs text-foreground/70 sm:px-4">No spending on yourself this period.</p>
      )}
      {categories.length > 0 && <CategoryBars categories={categories} />}
      {spending.topCategories.length > CATEGORY_PREVIEW && (
        <button
          type="button"
          aria-expanded={showAll}
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
        <dl className="grid gap-1.5 border-t border-border-strong/50 bg-secondary/40 px-4 py-3 text-xs md:px-3 md:py-2">
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
                Paid for others</dt>
              <dd className="font-semibold text-foreground tabular-nums">{formatCurrency(spending.othersShare)}</dd>
            </div>
          )}
        </dl>
      )}
    </section>
  );
}

// ─────────────────────────── page ───────────────────────────

function MoneyPanels({ payments, year, activity }: { payments: React.ReactNode; year: React.ReactNode; activity: React.ReactNode }) {
  return (
    <div className="@container">
      <div className="flex flex-col items-stretch gap-3 md:@min-[36rem]:grid md:@min-[36rem]:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] md:@min-[36rem]:items-start md:@min-[58rem]:grid-cols-[minmax(0,1.35fr)_minmax(17rem,1fr)_minmax(15rem,.95fr)]">
        <div className="order-2 flex min-w-0 flex-col gap-3 md:@min-[36rem]:order-1">
          {payments}
        </div>
        <div className="contents min-w-0 flex-col gap-3 md:gap-2 md:@min-[36rem]:order-2 md:@min-[36rem]:flex md:@min-[58rem]:contents">
          <div className="order-1 min-w-0 md:@min-[36rem]:order-2">{year}</div>
          <div className="order-3 flex min-w-0 flex-col gap-3 md:gap-2">{activity}</div>
        </div>
      </div>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="flex min-w-0 flex-col gap-3 px-1" role="status" aria-label="Loading My Money">
      <Skeleton className="h-9 w-36 rounded-lg" />
      <Skeleton className="h-44 rounded-xl lg:h-32" />
      <MoneyPanels
        payments={<Skeleton className="h-48 rounded-xl" />}
        year={<Skeleton className="h-56 rounded-xl md:h-48" />}
        activity={<Skeleton className="h-36 rounded-xl" />}
      />
    </div>
  );
}

export function MyMoneyWorkspace() {
  const data = useMyMoneyData();
  const { watch: watchTitle, progress: barProgress, reduceMotion: barReduceMotion, barTop } = useCompactHeader();
  if (data.isLoading) return <LoadingState />;
  return (
    <div className="flex min-w-0 flex-col gap-3 px-1 max-[359px]:gap-2">
      <MyMoneyCompactBar progress={barProgress} reduceMotion={barReduceMotion} top={barTop} data={data} next={data.toPay.next} />
      <Header data={data} titleRef={watchTitle} />
      <Summary data={data} />
      <MoneyPanels
        payments={<ToPayPanel data={data} />}
        year={<YearSpendingPanel data={data} />}
        activity={<><CollectPanel data={data} /><SpendingPanel data={data} /></>}
      />
      <ScrollNav />
    </div>
  );
}
