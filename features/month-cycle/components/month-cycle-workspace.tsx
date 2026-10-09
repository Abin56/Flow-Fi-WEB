"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  Banknote,
  CalendarClock,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  CreditCard,
  Info,
  Landmark,
  ListChecks,
  type LucideIcon,
  PiggyBank,
  Plus,
  Receipt,
  RotateCcw,
  ShoppingBag,
  Sparkles,
  TrendingUp,
  Users,
  Wallet,
  Wallet2,
  X,
} from "lucide-react";
import { motion, useReducedMotion } from "framer-motion";
import { AnimatedNumber } from "@/components/foundation/animated-number";
import { BankLogo } from "@/components/finance/bank-logo";
import { useAccounts } from "@/hooks/use-accounts";
import { ProgressRing } from "@/components/foundation/progress-ring";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatCurrency } from "@/lib/format";
import { ordinalDay } from "@/lib/engines/month-cycle-range";
import { cn } from "@/lib/utils";
import { MonthCyclePurposePanel } from "@/features/people/components/purpose-money-signals";
import { categoryIconFor, categoryToneFor, type ToneName } from "@/features/transactions/hooks/use-transactions-data";
import {
  useMonthCycleData,
  type MonthCycleAccountSpend,
  type MonthCycleExpenseRow,
  type MonthCyclePersonItem,
  type MonthCycleUpcomingItem,
} from "@/features/month-cycle/hooks/use-month-cycle-data";

type Accent = "primary" | "expense" | "warning" | "success" | "purple";

const ACCENT_BG: Record<Accent, string> = {
  primary: "bg-primary/10 text-primary-accent-text",
  expense: "bg-expense/10 text-expense",
  warning: "bg-warning/15 text-warning-foreground",
  success: "bg-success/12 text-success",
  purple: "bg-purple/12 text-purple",
};

const ACCENT_BAR: Record<Accent, string> = {
  primary: "bg-primary",
  expense: "bg-expense",
  warning: "bg-warning",
  success: "bg-success",
  purple: "bg-purple",
};

/** Faint section tint behind a panel header, in the section's own colour. */
const ACCENT_TINT: Record<Accent, string> = {
  primary: "from-primary/12",
  expense: "from-expense/8",
  warning: "from-warning/14",
  success: "from-success/10",
  purple: "from-purple/10",
};

const ACCOUNT_BAR_CYCLE: Accent[] = ["success", "primary", "warning", "purple", "expense"];

const TONE_BADGE: Record<ToneName, string> = {
  primary: "bg-primary/10 text-primary-accent-text",
  expense: "bg-expense/10 text-expense",
  warning: "bg-warning/15 text-warning-foreground",
  success: "bg-success/12 text-success",
  purple: "bg-purple/12 text-purple",
  neutral: "bg-muted text-muted-foreground",
};

const LABEL = "text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase";
const PANEL =
  "overflow-hidden rounded-[16px] border border-border-strong/60 bg-card shadow-e1 transition-[box-shadow,border-color] duration-200 hover:border-border-strong hover:shadow-[0_14px_34px_-18px_rgba(0,0,0,0.3)]";
const LINK = "flex h-7 shrink-0 items-center gap-1 rounded-[6px] px-2 text-xs font-semibold text-primary-accent-text transition-colors hover:bg-primary/15";

/** Section panel header — title (with icon), an optional figure, and View all. */
function PanelHeader({
  icon: Icon,
  title,
  figure,
  figureLabel = "Total",
  figureTone,
  href,
  accent = "primary",
  subtitle,
}: {
  icon: LucideIcon;
  title: string;
  figure?: number;
  figureLabel?: string;
  figureTone?: string;
  href?: string;
  accent?: Accent;
  subtitle?: string;
}) {
  return (
    <div className={cn("flex items-center justify-between gap-3 border-b border-border-strong/50 bg-gradient-to-r to-transparent px-4 py-3", ACCENT_TINT[accent])}>
      <div className="flex min-w-0 items-center gap-2.5">
        <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-full", ACCENT_BG[accent])}>
          <Icon className="size-4" strokeWidth={1.9} />
        </span>
        <div className="min-w-0">
          <h2 className="truncate font-heading text-[15px] leading-tight font-semibold text-foreground">{title}</h2>
          {subtitle && <p className="truncate text-xs text-foreground/65">{subtitle}</p>}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {figure != null && (
          <div className="text-right">
            <p className="text-[10px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">{figureLabel}</p>
            <p className={cn("text-sm leading-tight font-bold text-foreground tabular-nums", figureTone)}>{formatCurrency(figure)}</p>
          </div>
        )}
        {href && (
          <Link href={href} className={LINK}>
            View all
            <ArrowRight className="size-3" strokeWidth={2} />
          </Link>
        )}
      </div>
    </div>
  );
}

function PanelEmpty({ title, description, icon: Icon = Sparkles }: { title: string; description: string; icon?: LucideIcon }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 py-6 text-center">
      <span className="flex size-10 items-center justify-center rounded-full bg-secondary text-foreground/55 ring-4 ring-secondary/40">
        <Icon className="size-4.5" strokeWidth={1.75} />
      </span>
      <div>
        <p className="text-sm font-semibold text-foreground">{title}</p>
        <p className="mt-0.5 text-xs text-foreground/65">{description}</p>
      </div>
    </div>
  );
}

function StatCell({
  icon: Icon,
  label,
  amount,
  meta,
  accent,
  href,
}: {
  icon: LucideIcon;
  label: string;
  amount: number;
  meta?: string;
  accent: Accent;
  href: string;
}) {
  return (
    <Link
      href={href}
      className="group relative flex min-w-0 flex-col justify-center overflow-hidden rounded-[12px] border border-border-strong/60 bg-card px-3.5 py-3.5 shadow-e1 transition-[transform,box-shadow,border-color] duration-200 hover:-translate-y-0.5 hover:border-border-strong hover:shadow-[0_12px_28px_-14px_rgba(0,0,0,0.3)]"
    >
      <span aria-hidden className={cn("absolute inset-x-0 top-0 h-[3px]", ACCENT_BAR[accent])} />
      <ArrowRight className="absolute top-3 right-3 size-3.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" strokeWidth={2} />
      <span className="flex min-w-0 items-center gap-3">
      <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-full", ACCENT_BG[accent])}>
        <Icon className="size-4.5" strokeWidth={1.9} />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-xs font-medium text-foreground/70">{label}</span>
        <span className="block text-lg leading-tight font-bold text-foreground tabular-nums">
          <AnimatedNumber value={amount} format={formatCurrency} />
        </span>
        {meta && <span className="block truncate text-[11px] text-foreground/60">{meta}</span>}
      </span>
      </span>
    </Link>
  );
}

function UpcomingRow({ item, icon: Icon, accent }: { item: MonthCycleUpcomingItem; icon: LucideIcon; accent: Accent }) {
  const overdue = item.daysLeft < 0;
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-2.5 transition-colors hover:bg-secondary/50">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-[8px]", ACCENT_BG[accent])}>
          <Icon className="size-4" strokeWidth={1.75} />
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-foreground">{item.title}</p>
          <p className="truncate text-xs text-muted-foreground">{item.subtitle}</p>
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end">
        <span className={cn("text-[15px] font-bold tabular-nums", overdue ? "text-expense" : "text-foreground")}>{formatCurrency(item.amount)}</span>
        <span className={cn("text-[11px]", overdue ? "font-semibold text-expense" : "text-muted-foreground")}>{item.metaLabel}</span>
      </div>
    </div>
  );
}

function PersonRow({ item, tone }: { item: MonthCyclePersonItem; tone: "expense" | "success" }) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-2.5 transition-colors hover:bg-secondary/50">
      <div className="flex min-w-0 items-center gap-2.5">
        <span
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-bold",
            tone === "success" ? "bg-success/12 text-success" : "bg-expense/10 text-expense",
          )}
        >
          {item.name.slice(0, 1).toUpperCase()}
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-foreground">{item.name}</p>
          {item.note && <p className="truncate text-xs text-muted-foreground">{item.note}</p>}
          {item.toGive > 0 && item.toReceive > 0 && (
            // Both directions open: this person is on both sides (gross). The other side is settled on its
            // own — never offset against this one.
            <p className="truncate text-xs font-medium text-foreground/80 tabular-nums">
              {tone === "success" ? (
                <span className="text-expense">Also you need to give {formatCurrency(item.toGive)}</span>
              ) : (
                <span className="text-success">Also you need to receive {formatCurrency(item.toReceive)}</span>
              )}
              {" · tracked separately"}
            </p>
          )}
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end">
        <span className={cn("text-[15px] font-bold tabular-nums", tone === "success" ? "text-success" : "text-expense")}>
          {formatCurrency(item.amount)}
        </span>
        {item.daysSince != null && <span className="text-[11px] text-muted-foreground">{item.daysSince === 0 ? "Today" : `Since ${item.daysSince}d`}</span>}
      </div>
    </div>
  );
}

function AccountSpendRow({ item, accent, bankId }: { item: MonthCycleAccountSpend; accent: Accent; bankId: string | null }) {
  const reduceMotion = useReducedMotion();
  return (
    <div className="flex flex-col gap-1.5 px-4 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          {bankId ? (
            <BankLogo bankId={bankId} size={28} />
          ) : (
            <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-full", ACCENT_BG[accent])}>
              <Wallet2 className="size-3.5" strokeWidth={1.75} />
            </span>
          )}
          <p className="truncate text-sm font-semibold text-foreground">
            {item.name}
            {item.mask && <span className="ml-1.5 text-xs font-normal text-muted-foreground tabular-nums">•••• {item.mask}</span>}
          </p>
        </div>
        <span className="shrink-0 text-[15px] font-bold text-foreground tabular-nums">{formatCurrency(item.amount)}</span>
      </div>
      <div className="flex items-center gap-2 pl-9.5">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-secondary">
          <motion.div
            className={cn("h-full rounded-full", ACCENT_BAR[accent])}
            initial={reduceMotion ? false : { width: 0 }}
            animate={{ width: `${item.percentOfTotal}%` }}
            transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
          />
        </div>
        <span className="w-10 shrink-0 text-right text-[11px] font-semibold text-foreground/75 tabular-nums">{item.percentOfTotal}%</span>
      </div>
    </div>
  );
}

function GlanceCell({ icon: Icon, label, value, meta, accent }: { icon: LucideIcon; label: string; value: string; meta: string; accent: Accent }) {
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-[12px] border border-border-strong/50 bg-secondary/30 px-3 py-3 transition-colors hover:bg-secondary/60">
      <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-full", ACCENT_BG[accent])}>
        <Icon className="size-4" strokeWidth={1.75} />
      </span>
      <div className="min-w-0">
        <p className="truncate text-[11px] font-medium text-muted-foreground">{label}</p>
        <p className="truncate text-sm font-bold text-foreground">{value}</p>
        <p className="truncate text-[11px] text-muted-foreground">{meta}</p>
      </div>
    </div>
  );
}

const TH =
  "sticky top-0 z-[1] border-r border-b border-r-border-strong/40 border-b-border-strong bg-secondary px-3 py-2 text-left text-[11px] font-semibold tracking-[0.06em] whitespace-nowrap text-muted-foreground uppercase last:border-r-0";
const TD = "border-r border-b border-r-border-strong/30 border-b-border-strong/40 px-3 py-2.5 align-middle last:border-r-0";

function ExpenseTable({ rows, isMine }: { rows: MonthCycleExpenseRow[]; isMine: boolean }) {
  return (
    <table className="w-full border-separate border-spacing-0 text-sm">
      <thead>
        <tr>
          <th className={cn(TH, "w-[4.5rem]")}>Date</th>
          <th className={TH}>Description</th>
          <th className={cn(TH, "hidden w-44 sm:table-cell")}>Account</th>
          <th className={cn(TH, "w-36 text-right")}>Amount</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const amount = isMine ? row.myAmount : row.fullAmount;
          const Icon = categoryIconFor(row.categoryIconKey);
          const tone = categoryToneFor(row.categoryIconKey);
          const AccountIcon = row.accountType === "card" ? CreditCard : row.accountType === "bank" ? Landmark : Wallet2;
          return (
            <tr key={row.id} className="transition-colors hover:bg-secondary/40 [&:last-child>td]:border-b-0">
              <td className={cn(TD, "whitespace-nowrap tabular-nums")}>
                <p className="text-sm leading-tight font-semibold text-foreground">{row.date.toLocaleDateString("en-IN", { day: "2-digit", month: "short" })}</p>
                <p className="text-[11px] leading-tight text-muted-foreground">{row.date.getFullYear()}</p>
              </td>
              <td className={cn(TD, "max-w-0")}>
                <div className="flex min-w-0 items-center gap-2.5">
                  <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-[8px]", TONE_BADGE[tone])}>
                    <Icon className="size-4" />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-foreground">{row.description}</p>
                    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                      <span className="truncate text-xs text-muted-foreground">{row.category}</span>
                      {row.isSplit && (
                        <span className="inline-flex h-[18px] items-center gap-1 rounded-[4px] border border-purple/35 bg-purple/12 px-1.5 text-[10.5px] font-semibold text-purple">
                          <Users className="size-2.5" />
                          Split{isMine ? " · your share" : ""}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </td>
              <td className={cn(TD, "hidden sm:table-cell")}>
                <span className="inline-flex min-w-0 items-center gap-1.5 text-xs font-medium text-foreground/85">
                  <AccountIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{row.account}</span>
                </span>
              </td>
              <td className={cn(TD, "text-right")}>
                <span className="text-[17px] font-bold whitespace-nowrap text-foreground tabular-nums">−{formatCurrency(amount)}</span>
                {row.isSplit && isMine && <p className="text-[11px] text-muted-foreground tabular-nums">of {formatCurrency(row.fullAmount)}</p>}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * What "Total outflow" is made of — the same `breakdownFor("combinedExpenses")` lines the headline sums,
 * so they add back to it exactly. The purchase list below covers only the expense part (full amounts).
 */
export function OutflowBreakdown({ breakdown, total }: { breakdown: Record<string, number>; total: number }) {
  const lines = Object.entries(breakdown);
  return (
    <section aria-label="Total outflow breakdown" className="border-b border-border-strong/60 px-5 py-3">
      <dl className="flex flex-col gap-1 text-sm">
        {lines.map(([label, amount]) => (
          <div key={label} className="flex items-center justify-between gap-3">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="font-semibold text-foreground tabular-nums">{formatCurrency(amount)}</dd>
          </div>
        ))}
        <div className="mt-1 flex items-center justify-between gap-3 border-t border-border-strong/50 pt-1.5">
          <dt className="font-semibold text-foreground">Total outflow</dt>
          <dd className="font-bold text-foreground tabular-nums" data-testid="outflow-breakdown-total">{formatCurrency(total)}</dd>
        </div>
      </dl>
      <p className="mt-2 text-[11px] text-muted-foreground">
        Card purchases count when made; card-bill payments are transfers and aren&apos;t added again. Money moved to or from people is not
        included. The list below shows the purchases this cycle at their full amount.
      </p>
    </section>
  );
}

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The cycle label doubles as a month picker — picking a month jumps to the cycle named after it. */
function CyclePicker({
  label,
  rangeLabel,
  selected,
  onPick,
  onToday,
}: {
  label: string;
  rangeLabel: string;
  /** Any day in the shown cycle's named month (its end). */
  selected: Date;
  onPick: (year: number, month: number) => void;
  onToday: () => void;
}) {
  const [open, setOpen] = useState(false);
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
        <button
          type="button"
          aria-label="Choose cycle"
          className="min-w-[10rem] rounded-[6px] px-2 py-0.5 text-center transition-colors hover:bg-secondary"
          aria-live="polite"
        >
          <span className="flex items-center justify-center gap-1.5 text-sm leading-tight font-semibold text-foreground">
            {label} cycle
            <CalendarDays className="size-3.5 text-muted-foreground" />
          </span>
          <span className="block text-[11px] leading-tight text-muted-foreground tabular-nums">{rangeLabel}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-3">
        <div className="mb-2 flex items-center justify-between">
          <button type="button" aria-label="Previous year" onClick={() => setYear((y) => y - 1)} className="flex size-7 items-center justify-center rounded-[6px] text-muted-foreground hover:bg-secondary hover:text-foreground">
            <ChevronLeft className="size-4" />
          </button>
          <span className="text-sm font-semibold text-foreground tabular-nums">{year}</span>
          <button type="button" aria-label="Next year" onClick={() => setYear((y) => y + 1)} className="flex size-7 items-center justify-center rounded-[6px] text-muted-foreground hover:bg-secondary hover:text-foreground">
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
                  onPick(year, i);
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
        <button
          type="button"
          onClick={() => {
            onToday();
            setOpen(false);
          }}
          className="mt-2 h-7 w-full rounded-[6px] border border-border-strong text-xs font-semibold text-foreground hover:bg-secondary"
        >
          Current cycle
        </button>
      </PopoverContent>
    </Popover>
  );
}

function ViewToggle({ isMine, onChange, onDark }: { isMine: boolean; onChange: (v: "combined" | "mine") => void; onDark?: boolean }) {
  return (
    <div
      role="radiogroup"
      aria-label="Expense view"
      className={cn("inline-flex items-center rounded-full p-0.5", onDark ? "bg-black/25 ring-1 ring-white/15" : "rounded-[6px] border border-border-strong bg-card")}
    >
      {(
        [
          { value: "combined", label: "Combined" },
          { value: "mine", label: "Mine only" },
        ] as const
      ).map((o) => {
        const active = (o.value === "mine") === isMine;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value)}
            className={cn(
              "h-6 px-2.5 text-xs font-semibold transition-colors",
              onDark ? "rounded-full" : "rounded-[4px]",
              active
                ? onDark
                  ? "bg-white text-neutral-900"
                  : "bg-primary text-primary-foreground"
                : onDark
                  ? "text-white/75 hover:text-white"
                  : "text-muted-foreground hover:bg-secondary hover:text-foreground",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** "Day X of Y" through the shown cycle with a thin bar — presentation only, from the cycle's start/end. */
function CycleProgress({ start, end, daysLeft }: { start: Date; end: Date; daysLeft: number }) {
  const reduceMotion = useReducedMotion();
  const day = 86_400_000;
  const total = Math.max(1, Math.round((end.getTime() - start.getTime()) / day) + 1);
  // Uses the page's own "days left" (computed from its clock) rather than reading the time during render.
  const elapsed = Math.min(total, Math.max(0, total - Math.max(0, daysLeft)));
  const pct = (elapsed / total) * 100;
  const label = daysLeft < 0 ? "Cycle complete" : elapsed <= 0 ? "Not started" : `Day ${elapsed} of ${total}`;
  return (
    <div className="relative mt-1 flex flex-col gap-1.5">
      <div className="flex items-center justify-between text-[11px] text-white/70">
        <span>Cycle progress</span>
        <span className="font-semibold text-white tabular-nums">{label}</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/15">
        <motion.div
          className="h-full rounded-full bg-primary"
          initial={reduceMotion ? false : { width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
        />
      </div>
    </div>
  );
}

function SummaryTile({ label, icon: Icon, tone, chip, children }: { label: string; icon: LucideIcon; tone: string; chip: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-[12px] border border-border-strong/50 bg-secondary/40 px-3 py-3">
      <span className={cn("flex size-[50px] shrink-0 items-center justify-center rounded-full", chip)}>
        <Icon className="size-5" strokeWidth={1.9} />
      </span>
      <span className="min-w-0">
        <span className={cn(LABEL, "block")}>{label}</span>
        <span className={cn("block text-xl leading-tight font-bold tabular-nums", tone)}>{children}</span>
      </span>
    </div>
  );
}

type UpcomingKey = "emi" | "loans" | "cards" | "bills";

/** The four "due this cycle" lists as one tabbed panel — same items, totals and links as the old four panels. */
function UpcomingTabs({
  panels,
}: {
  panels: {
    key: UpcomingKey;
    icon: LucideIcon;
    accent: Accent;
    title: string;
    total: number;
    href: string;
    addLabel: string;
    items: MonthCycleUpcomingItem[];
    emptyTitle: string;
    emptyDescription: string;
  }[];
}) {
  const [tab, setTab] = useState<UpcomingKey>(() => panels.find((p) => p.items.length > 0)?.key ?? panels[0].key);
  const reduceMotion = useReducedMotion();
  const active = panels.find((p) => p.key === tab) ?? panels[0];
  return (
    <section aria-label="Upcoming this cycle" className={cn(PANEL, "flex flex-col")}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border-strong/50 bg-gradient-to-r from-expense/8 to-transparent px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-expense/10 text-expense">
            <CalendarClock className="size-4" strokeWidth={1.9} />
          </span>
          <div className="min-w-0">
            <h2 className="font-heading text-[15px] leading-tight font-semibold text-foreground">Due this cycle</h2>
            <p className="text-xs text-foreground/65">EMIs, loans, card bills and bills to pay</p>
          </div>
        </div>
        <span className="rounded-full bg-secondary px-2.5 py-1 text-xs font-semibold text-foreground tabular-nums">
          {panels.reduce((n, p) => n + p.items.length, 0)} items · {formatCurrency(panels.reduce((s, p) => s + p.total, 0))}
        </span>
      </div>
      <div role="tablist" aria-label="Due this cycle" className="grid grid-cols-2 gap-1 border-b border-border-strong/40 p-2 sm:grid-cols-4">
        {panels.map((p) => {
          const selected = p.key === tab;
          const Icon = p.icon;
          return (
            <button
              key={p.key}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => setTab(p.key)}
              className={cn(
                "relative flex min-w-0 items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                selected ? "text-foreground" : "text-foreground/70 hover:bg-secondary/60 hover:text-foreground",
              )}
            >
              {selected && (
                <motion.span
                  layoutId="mc-upcoming-tab"
                  aria-hidden
                  className="absolute inset-0 rounded-[10px] bg-secondary ring-1 ring-border-strong/60"
                  transition={{ type: "spring", stiffness: 500, damping: 40 }}
                />
              )}
              <span className={cn("relative flex size-8 shrink-0 items-center justify-center rounded-[8px]", ACCENT_BG[p.accent])}>
                <Icon className="size-4" strokeWidth={1.75} />
              </span>
              <span className="relative min-w-0">
                <span className="block truncate text-xs font-semibold">
                  {p.title}
                  <span className="ml-1 text-foreground/55 tabular-nums">{p.items.length}</span>
                </span>
                <span className="block truncate text-sm font-bold text-foreground tabular-nums">{formatCurrency(p.total)}</span>
              </span>
            </button>
          );
        })}
      </div>
      <motion.div
        key={active.key}
        initial={reduceMotion ? false : { opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18 }}
        className="flex-1 divide-y divide-border-strong/40"
      >
        {active.items.length === 0 ? (
          <PanelEmpty icon={active.icon} title={active.emptyTitle} description={active.emptyDescription} />
        ) : (
          active.items.map((item) => <UpcomingRow key={item.id} item={item} icon={active.icon} accent={active.accent} />)
        )}
      </motion.div>
      <div className="flex items-center justify-between border-t border-border-strong/40 px-4 py-2">
        <Link href={active.href} className="flex items-center gap-1.5 text-xs font-semibold text-primary-accent-text hover:underline">
          <Plus className="size-3.5" strokeWidth={2} />
          {active.addLabel}
        </Link>
        <Link href={active.href} className={LINK}>
          Open {active.title.toLowerCase()}
          <ArrowRight className="size-3" strokeWidth={2} />
        </Link>
      </div>
    </section>
  );
}

/** Fades a page section up as it scrolls into view; its id is a SectionNav target. */
function Reveal({ id, children }: { id: string; children: React.ReactNode }) {
  const reduceMotion = useReducedMotion();
  // No IntersectionObserver (old browsers, test DOM) → just show it; nothing to reveal on.
  if (reduceMotion || typeof IntersectionObserver === "undefined") {
    return (
      <div id={id} className="scroll-mt-16">
        {children}
      </div>
    );
  }
  return (
    <motion.div
      id={id}
      className="scroll-mt-16"
      initial={reduceMotion ? false : { opacity: 0, y: 14 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-40px" }}
      transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  );
}

const SECTIONS = [
  { id: "mc-overview", label: "Overview", icon: Sparkles },
  { id: "mc-obligations", label: "Obligations", icon: Banknote },
  { id: "mc-due", label: "Due", icon: CalendarClock },
  { id: "mc-people", label: "People & accounts", icon: Users },
  { id: "mc-glance", label: "At a glance", icon: ListChecks },
  { id: "mc-budget", label: "Budget", icon: PiggyBank },
] as const;

/** Pill bar that jumps to a section and highlights the one in view — pinned under the top bar. */
function SectionNav() {
  const [current, setCurrent] = useState<string>(SECTIONS[0].id);
  useEffect(() => {
    const els = SECTIONS.map((s) => document.getElementById(s.id)).filter((e): e is HTMLElement => e != null);
    if (els.length === 0 || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setCurrent(visible[0].target.id);
      },
      { rootMargin: "-20% 0px -60% 0px" },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);
  return (
    <nav
      aria-label="Month cycle sections"
      className="sticky top-0 z-attached -mx-1 flex gap-1 overflow-x-auto rounded-full border border-border-strong/60 bg-card/90 p-1 shadow-e1 backdrop-blur [scrollbar-width:none] supports-[backdrop-filter]:bg-card/75"
    >
      {SECTIONS.map(({ id, label, icon: Icon }) => {
        const active = current === id;
        return (
          <button
            key={id}
            type="button"
            onClick={() => {
              setCurrent(id);
              document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
            }}
            className={cn(
              "relative flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
              active ? "font-semibold text-primary-foreground" : "font-medium text-foreground/70 hover:bg-secondary hover:text-foreground",
            )}
          >
            {active && (
              <motion.span
                layoutId="mc-section-nav"
                aria-hidden
                className="absolute inset-0 rounded-full bg-primary ring-1 ring-primary-accent-text/40"
                transition={{ type: "spring", stiffness: 500, damping: 40 }}
              />
            )}
            <Icon className="relative size-3.5" strokeWidth={2} />
            <span className="relative">{label}</span>
          </button>
        );
      })}
    </nav>
  );
}

export function MonthCycleWorkspace() {
  const data = useMonthCycleData();
  // Bank logos for the account outflow rows — presentation only.
  const { data: allAccounts = [] } = useAccounts();
  const bankIdByAccount = new Map((allAccounts as { id: string; bankId: string | null }[]).map((a) => [a.id, a.bankId]));
  const [expenseView, setExpenseView] = useState<"combined" | "mine">("mine");
  const [showExpenseList, setShowExpenseList] = useState(false);

  if (data.isLoading) {
    return (
      <div className="flex min-w-0 flex-col gap-5 px-1">
        <Skeleton className="h-14 w-full rounded-[10px]" />
        <Skeleton className="h-32 w-full rounded-[10px]" />
        <Skeleton className="h-28 w-full rounded-[10px]" />
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-56 rounded-[10px]" />
          ))}
        </div>
      </div>
    );
  }

  const { financialView } = data;
  const isMine = expenseView === "mine";
  const spent = isMine ? financialView.mySpent : financialView.spent;
  const net = isMine ? financialView.myNet : financialView.net;
  const changePercent = isMine ? financialView.mySpentChangePercent : financialView.spentChangePercent;
  const changeIsLess = changePercent != null && changePercent <= 0;
  const budgetPercent = data.budgetOverview ? Math.round(data.budgetOverview.usageRatio * 100) : null;

  return (
    <div className="flex min-w-0 flex-col gap-5 px-1">
      {/* ── Header: title · cycle navigator · primary action ── */}
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-2">
          <div>
            <h1 className="font-heading text-2xl font-bold tracking-tight text-foreground">Month Cycle</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">Everything that moves your money this cycle.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center rounded-[8px] border border-border-strong bg-card p-0.5">
              <button
                type="button"
                onClick={data.goToPreviousCycle}
                aria-label="Previous cycle"
                className="flex size-8 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              >
                <ChevronLeft className="size-4" strokeWidth={1.75} />
              </button>
              <CyclePicker
                label={data.monthLabel}
                rangeLabel={data.monthRangeLabel}
                selected={data.cycleRange.end}
                onPick={data.goToCycleForMonth}
                onToday={data.goToCurrentCycle}
              />
              <button
                type="button"
                onClick={data.goToNextCycle}
                aria-label="Next cycle"
                className="flex size-8 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              >
                <ChevronRight className="size-4" strokeWidth={1.75} />
              </button>
            </div>
            {data.isCurrentCycle ? (
              <span className="inline-flex h-7 items-center gap-1.5 rounded-[6px] bg-primary/20 px-2 text-xs font-semibold text-foreground dark:text-primary-accent-text">
                <span className="size-1.5 rounded-full bg-primary-accent-text" aria-hidden />
                {data.daysLeftInMonth} day{data.daysLeftInMonth === 1 ? "" : "s"} left
              </span>
            ) : (
              <>
                <span className="inline-flex h-7 items-center rounded-[6px] bg-secondary px-2 text-xs font-semibold text-foreground">
                  {data.daysLeftInMonth < 0 ? "Cycle ended" : "Upcoming cycle"}
                </span>
                <button
                  type="button"
                  onClick={data.goToCurrentCycle}
                  className="inline-flex h-7 items-center gap-1 rounded-[6px] border border-border-strong bg-card px-2 text-xs font-semibold text-foreground transition-colors hover:bg-secondary"
                >
                  <RotateCcw className="size-3" strokeWidth={2} />
                  Back to current
                </button>
              </>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <button type="button" aria-label="About this cycle" className="flex size-7 items-center justify-center rounded-[6px] text-muted-foreground hover:bg-secondary hover:text-foreground">
                  <Info className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent>
                {data.isCustomCycle
                  ? `Cycle totals cover the ${ordinalDay(data.monthCycleStartDay)} of each month through the ${ordinalDay(data.monthCycleStartDay - 1)} of the next — change this in Settings.`
                  : "Cycle totals cover the current calendar month."}
              </TooltipContent>
            </Tooltip>
          </div>
        </div>

        <Link
          href="/transactions"
          className="flex h-9 items-center gap-1.5 rounded-[6px] border border-primary-accent-text bg-primary px-3.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
        >
          <Plus className="size-4" strokeWidth={2.25} />
          New transaction
        </Link>
      </header>

      <SectionNav />

      <Reveal id="mc-overview">
      {/* ── Cycle summary: spend leads; income, net, budget and savings support it ── */}
      <section aria-label="Cycle summary" className="@container overflow-hidden rounded-[16px] border border-border-strong/60 bg-card shadow-e1">
        <div className="flex flex-col @5xl:flex-row @5xl:items-stretch">
          {/* Hero */}
          <div className="relative flex flex-col gap-3 overflow-hidden bg-gradient-to-br from-[#1d2330] via-[#262e3d] to-[#323b4d] px-5 py-5 text-white sm:px-6 @5xl:min-w-[24rem] @5xl:max-w-[30rem]">
            <span aria-hidden className="pointer-events-none absolute -top-20 -right-16 size-56 rounded-full bg-primary/25 blur-3xl" />
            <span aria-hidden className="pointer-events-none absolute -bottom-24 -left-16 size-52 rounded-full border border-white/10" />
            <div className="relative flex flex-wrap items-center justify-between gap-2">
              <span className="text-[11px] font-semibold tracking-[0.08em] text-white/75 uppercase">{isMine ? "My spend" : "Total outflow"}</span>
              <ViewToggle isMine={isMine} onChange={setExpenseView} onDark />
            </div>
            <button
              type="button"
              onClick={() => setShowExpenseList(true)}
              className="relative w-fit text-left text-[38px] leading-none font-bold tracking-tight tabular-nums transition-opacity hover:opacity-85 sm:text-[42px]"
            >
              <AnimatedNumber value={spent} format={formatCurrency} />
            </button>
            <div className="relative flex flex-wrap items-center gap-x-3 gap-y-1.5">
              {changePercent != null && (
                <span
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold",
                    changeIsLess ? "bg-success/25 text-green-200" : "bg-expense/30 text-red-200",
                  )}
                >
                  {changeIsLess ? <ArrowDownRight className="size-3.5" /> : <ArrowUpRight className="size-3.5" />}
                  {Math.abs(Math.round(changePercent * 10) / 10)}% {changeIsLess ? "less" : "more"} than last month
                </span>
              )}
              <button
                type="button"
                onClick={() => setShowExpenseList(true)}
                className="inline-flex h-7 items-center gap-1 rounded-full bg-white/12 px-2.5 text-xs font-semibold ring-1 ring-white/20 transition-colors hover:bg-white/20"
              >
                <ListChecks className="size-3.5" strokeWidth={2} />
                View list
              </button>
            </div>
            {/* How far through the cycle — display only, from the cycle's own start/end. */}
            <CycleProgress start={data.cycleRange.start} end={data.cycleRange.end} daysLeft={data.daysLeftInMonth} />
          </div>

          {/* Supporting figures */}
          <div className="grid min-w-0 flex-1 grid-cols-2 gap-2.5 p-3 @xl:grid-cols-4 @5xl:grid-cols-2 @5xl:p-4">
            <SummaryTile label="Income" icon={Wallet} tone="text-success" chip="bg-success/12 text-success">
              <AnimatedNumber value={financialView.income} format={formatCurrency} />
            </SummaryTile>
            <SummaryTile label="Net balance" icon={TrendingUp} tone={net < 0 ? "text-expense" : "text-foreground"} chip={net < 0 ? "bg-expense/10 text-expense" : "bg-primary/20 text-foreground dark:text-primary-accent-text"}>
              <AnimatedNumber value={net} format={formatCurrency} />
            </SummaryTile>
            <div className="flex min-w-0 items-center gap-3 rounded-[12px] border border-border-strong/50 bg-secondary/40 px-3 py-3">
              <ProgressRing value={budgetPercent ?? 0} size={50} strokeWidth={5}>
                <span className="text-[11px] font-bold tabular-nums">{budgetPercent != null ? `${budgetPercent}%` : "—"}</span>
              </ProgressRing>
              <div className="min-w-0">
                <p className={LABEL}>Budget</p>
                <p className="truncate text-xs font-medium text-foreground">
                  {data.budgetOverview ? `of ${formatCurrency(data.budgetOverview.limit)} used` : "No budget set"}
                </p>
              </div>
            </div>
            <div className="flex min-w-0 items-center gap-3 rounded-[12px] border border-border-strong/50 bg-secondary/40 px-3 py-3">
              <span className="flex size-[50px] shrink-0 items-center justify-center rounded-full bg-success/12 text-success">
                <PiggyBank className="size-5" strokeWidth={1.75} />
              </span>
              <div className="min-w-0">
                <p className={LABEL}>Saved</p>
                <p className="text-lg leading-tight font-bold text-foreground tabular-nums">{data.savingsRatePercent}%</p>
                <p className="truncate text-[11px] text-foreground/65">of {formatCurrency(financialView.income)} income</p>
              </div>
            </div>
          </div>
        </div>
      </section>
      </Reveal>

      <Reveal id="mc-obligations">
      {/* ── Obligations this cycle — every figure opens its workspace ── */}
      <section aria-label="Obligations" className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-6">
        <StatCell icon={Banknote} label="EMI (total)" amount={data.emi.total} meta={`${data.emi.count} due this month`} accent="primary" href="/emi" />
        <StatCell icon={Landmark} label="Loans (payable)" amount={data.loans.total} meta={
            data.loans.carriedOverdue > 0
              ? `${formatCurrency(data.loans.dueThisCycle)} this cycle · ${formatCurrency(data.loans.carriedOverdue)} overdue`
              : `${data.loans.count} installment${data.loans.count === 1 ? "" : "s"} due`
          } accent="purple" href="/loans" />
        <StatCell icon={CreditCard} label="Credit card bills" amount={data.cards.total} meta={`${data.cards.count} bills due`} accent="expense" href="/credit-cards" />
        <StatCell icon={Users} label="You need to give" amount={data.peopleSides.totalToGive} meta={`${data.peopleSides.giveCount} people`} accent="warning" href="/people" />
        <StatCell icon={Users} label="You need to receive" amount={data.peopleSides.totalToReceive} meta={`${data.peopleSides.receiveCount} people`} accent="success" href="/people" />
        <StatCell icon={Receipt} label="Bills (utility & others)" amount={data.bills.total} meta={`${data.bills.count} bills due`} accent="success" href="/bills" />
      </section>
      </Reveal>

      <Reveal id="mc-due">
      {/* ── Upcoming this cycle — one tabbed panel ── */}
      <UpcomingTabs
        panels={[
          { key: "emi", icon: Banknote, accent: "primary", title: "EMI", total: data.emi.total, href: "/emi", addLabel: "Add EMI", items: data.emi.items, emptyTitle: "No EMIs due", emptyDescription: "Active EMI installments due this cycle appear here." },
          { key: "loans", icon: Landmark, accent: "purple", title: "Loans", total: data.loans.total, href: "/loans", addLabel: "Add loan", items: data.loans.items, emptyTitle: "No loan EMIs due", emptyDescription: "Active loan installments due this cycle appear here." },
          { key: "cards", icon: CreditCard, accent: "expense", title: "Card bills", total: data.cards.total, href: "/credit-cards", addLabel: "Add card bill", items: data.cards.items, emptyTitle: "No card bills due", emptyDescription: "Unpaid statements due this cycle appear here." },
          { key: "bills", icon: Receipt, accent: "success", title: "Bills", total: data.bills.total, href: "/bills", addLabel: "Add bill", items: data.bills.items, emptyTitle: "No bills due", emptyDescription: "Utility and other recurring bills due this cycle appear here." },
        ]}
      />
      </Reveal>

      <Reveal id="mc-people">
      {/* ── People + account spend ── */}
      <div className="grid gap-4 lg:grid-cols-2">
        <section aria-label="People ledger" className={cn(PANEL, "@container flex flex-col")}>
          <PanelHeader icon={Users} accent="warning" title="People ledger" subtitle="Money between you and others" href="/people" />
          {/* Gross sides + held advance — never one net figure that hides an advance inside "to receive". */}
          <dl className="grid grid-cols-3 gap-2 border-b border-border-strong/40 p-3">
            {[
              { label: "To receive", value: data.peopleSides.totalToReceive, tone: data.peopleSides.totalToReceive > 0 ? "text-success" : "text-foreground", tile: "bg-success/8 ring-success/20" },
              { label: "To give", value: data.peopleSides.totalToGive, tone: data.peopleSides.totalToGive > 0 ? "text-expense" : "text-foreground", tile: "bg-expense/6 ring-expense/20" },
              { label: "Advance held", value: data.peopleSides.advanceHeld, tone: "text-foreground", tile: "bg-secondary/60 ring-border-strong/50" },
            ].map((f) => (
              <div key={f.label} className={cn("rounded-[10px] px-3 py-2 text-center ring-1", f.tile)}>
                <dt className="text-[10px] font-semibold tracking-[0.06em] text-foreground/65 uppercase">{f.label}</dt>
                <dd className={cn("text-base leading-tight font-bold tabular-nums", f.tone)}>{formatCurrency(f.value)}</dd>
              </div>
            ))}
          </dl>
          {data.peopleYouNeedToGive.length === 0 && data.peopleHandoverPending.length === 0 ? (
            <PanelEmpty icon={Users} title="No pending balances" description="Money you're owed or owe will show up here." />
          ) : (
            <div className="grid min-w-0 flex-1 @xl:grid-cols-2 @xl:divide-x @xl:divide-border-strong/40">
              <div className="min-w-0">
                <div className="flex items-center justify-between border-b border-border-strong/40 bg-warning/8 px-4 py-2">
                  <p className="text-[11px] font-semibold tracking-[0.06em] text-warning-foreground uppercase dark:text-warning">You need to give</p>
                  <p className="text-xs font-bold text-warning-foreground tabular-nums dark:text-warning">{formatCurrency(data.peopleSides.totalToGive)}</p>
                </div>
                <div className="divide-y divide-border-strong/40">
                  {data.peopleYouNeedToGive.length === 0 ? (
                    <p className="px-4 py-3 text-xs text-muted-foreground">Nothing to give right now.</p>
                  ) : (
                    data.peopleYouNeedToGive.map((p) => <PersonRow key={p.id} item={p} tone="expense" />)
                  )}
                </div>
              </div>
              <div className="min-w-0 border-t border-border-strong/40 @xl:border-t-0">
                <div className="flex items-center justify-between border-b border-border-strong/40 bg-success/8 px-4 py-2">
                  <p className="text-[11px] font-semibold tracking-[0.06em] text-success uppercase">You need to receive</p>
                  <p className="text-xs font-bold text-success tabular-nums">{formatCurrency(data.peopleSides.totalToReceive)}</p>
                </div>
                <div className="divide-y divide-border-strong/40">
                  {data.peopleHandoverPending.length === 0 ? (
                    <p className="px-4 py-3 text-xs text-muted-foreground">Nothing to receive right now.</p>
                  ) : (
                    data.peopleHandoverPending.map((p) => <PersonRow key={p.id} item={p} tone="success" />)
                  )}
                </div>
              </div>
            </div>
          )}
          <Link href="/people" className="flex items-center gap-1.5 border-t border-border-strong/40 px-4 py-2.5 text-xs font-semibold text-primary-accent-text transition-colors hover:bg-primary/10">
            <Plus className="size-3.5" strokeWidth={2} />
            Add person
          </Link>
        </section>

        <section aria-label="Account spend" className={cn(PANEL, "flex flex-col")}>
          <PanelHeader icon={Wallet} accent="primary" title="Account outflow" subtitle="Where this cycle's money left from" figure={financialView.spent} href="/accounts" />
          {data.accountSpends.length === 0 ? (
            <PanelEmpty icon={Wallet} title="No spending yet this month" description="Expenses posted this cycle will be grouped by account here." />
          ) : (
            <div className="divide-y divide-border-strong/40">
              {data.accountSpends.map((account, index) => (
                <AccountSpendRow
                  key={account.id}
                  item={account}
                  accent={ACCOUNT_BAR_CYCLE[index % ACCOUNT_BAR_CYCLE.length]}
                  bankId={bankIdByAccount.get(account.id) ?? null}
                />
              ))}
            </div>
          )}
        </section>
      </div>
      </Reveal>

      {/* ── Money to use — purposes due this cycle (informational; never Bills) ── */}
      <MonthCyclePurposePanel cycle={data.cycleRange} />

      <Reveal id="mc-glance">
      {/* ── Month at a glance ── */}
      <section aria-label="Month at a glance" className={PANEL}>
        <PanelHeader icon={Sparkles} accent="purple" title="Month at a glance" subtitle="Quick facts about this cycle" />
        <div className="grid grid-cols-1 gap-2 p-3 sm:grid-cols-2 lg:grid-cols-5">
          <GlanceCell
            icon={ShoppingBag}
            label="Highest spend"
            value={data.monthSummary.highestSpendCategory ? data.monthSummary.highestSpendCategory.name : "—"}
            meta={
              data.monthSummary.highestSpendCategory
                ? `${formatCurrency(data.monthSummary.highestSpendCategory.amount)} · ${data.monthSummary.highestSpendCategory.percentOfTotal}% of total`
                : "No expenses yet"
            }
            accent="expense"
          />
          <GlanceCell
            icon={Wallet2}
            label="Most used account"
            value={data.monthSummary.mostUsedAccount ? data.monthSummary.mostUsedAccount.name : "—"}
            meta={
              data.monthSummary.mostUsedAccount
                ? `${data.monthSummary.mostUsedAccount.transactionCount} transactions · ${formatCurrency(data.monthSummary.mostUsedAccount.amount)}`
                : "No activity yet"
            }
            accent="primary"
          />
          <GlanceCell icon={ListChecks} label="Total transactions" value={String(data.monthSummary.totalTransactions)} meta="This month" accent="purple" />
          <GlanceCell icon={TrendingUp} label="Avg. daily spend" value={formatCurrency(data.monthSummary.avgDailySpend)} meta="Per day" accent="warning" />
          <GlanceCell icon={CalendarClock} label="Pending actions" value={String(data.monthSummary.pendingActionsCount)} meta="EMI, bills & settlements" accent="success" />
        </div>
      </section>
      </Reveal>

      <Reveal id="mc-budget">
      {/* ── Budget ── */}
      <section aria-label="Budget overview" className={PANEL}>
        <PanelHeader icon={PiggyBank} accent="success" title="Budget overview" subtitle="Your monthly limit and how much is used" figure={data.budgetOverview?.limit} figureLabel="Total budget" />
        {data.budgetOverview ? (
          <div className="flex flex-col gap-3 px-4 py-4">
            <div className="h-2.5 w-full overflow-hidden rounded-full bg-secondary">
              <motion.div
                className={cn("h-full rounded-full", data.budgetOverview.isOverBudget ? "bg-expense" : "bg-primary-accent-text")}
                initial={{ width: 0 }}
                animate={{ width: `${Math.min(100, Math.round(data.budgetOverview.usageRatio * 100))}%` }}
                transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
              />
            </div>
            <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-2">
              <div>
                <p className={LABEL}>Used</p>
                <p className="text-lg leading-tight font-bold text-foreground tabular-nums">{formatCurrency(data.budgetOverview.spent)}</p>
              </div>
              <Link href="/budgets" className={LINK}>
                Manage budget
                <ArrowRight className="size-3" strokeWidth={2} />
              </Link>
              <div className="text-right">
                <p className={LABEL}>Remaining</p>
                <p className={cn("text-lg leading-tight font-bold tabular-nums", data.budgetOverview.isOverBudget ? "text-expense" : "text-foreground")}>
                  {formatCurrency(Math.max(data.budgetOverview.remaining, 0))}
                </p>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3 px-4 py-4">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/20 text-foreground dark:text-primary-accent-text">
              <PiggyBank className="size-4.5" strokeWidth={1.9} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-foreground">No monthly budget set</p>
              <p className="text-xs text-foreground/65">Set an overall monthly budget to see how much of it this cycle uses.</p>
            </div>
            <Link
              href="/budgets"
              className="flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-primary-accent-text bg-primary px-4 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
            >
              <Plus className="size-4" strokeWidth={2.25} />
              Set a budget
            </Link>
          </div>
        )}
      </section>
      </Reveal>

      <p className="flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground">
        <CalendarClock className="size-3.5" />
        {data.isCustomCycle
          ? `Cycle totals reflect your ${ordinalDay(data.monthCycleStartDay)} → ${ordinalDay(data.monthCycleStartDay - 1)} monthly cycle and update live as you record payments and transactions.`
          : "Cycle totals reflect the current calendar month and update live as you record payments and transactions."}
      </p>

      {/* ── Expense list — the cycle's expenses as a ledger ── */}
      <Dialog open={showExpenseList} onOpenChange={setShowExpenseList}>
        <DialogContent
          showCloseButton={false}
          className="flex max-h-[88vh] w-full flex-col gap-0 overflow-hidden rounded-[10px] border border-border-strong/60 p-0 shadow-[var(--shadow-e4)] sm:max-w-3xl lg:max-w-5xl"
        >
          <DialogTitle className="sr-only">{isMine ? "My spend this cycle" : "Total outflow this cycle"}</DialogTitle>
          <div className="flex shrink-0 flex-wrap items-end justify-between gap-3 border-b border-border-strong/60 bg-gradient-to-br from-expense/[0.08] to-transparent px-5 py-4 dark:from-expense/[0.14]">
            <div>
              <p className={LABEL}>
                {isMine ? "My spend" : "Total outflow"} · {data.monthRangeLabel}
              </p>
              <p className="mt-1 text-[30px] leading-none font-bold tracking-tight text-foreground tabular-nums">
                <AnimatedNumber value={spent} format={formatCurrency} />
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {data.expenseRows.length} transaction{data.expenseRows.length === 1 ? "" : "s"} this cycle
              </p>
            </div>
            <div className="flex items-center gap-2">
              <ViewToggle isMine={isMine} onChange={setExpenseView} />
              <button
                type="button"
                onClick={() => setShowExpenseList(false)}
                aria-label="Close"
                className="flex size-8 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-auto overscroll-contain">
            {!isMine && <OutflowBreakdown breakdown={financialView.spentBreakdown} total={financialView.spent} />}
            {data.expenseRows.length === 0 ? (
              <PanelEmpty title="No expenses this cycle" description="Transactions in this cycle will appear here." />
            ) : (
              <ExpenseTable rows={data.expenseRows} isMine={isMine} />
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
