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
  MoreHorizontal,
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
import { CompactHeaderBar, useCompactHeader } from "@/components/layout/compact-header";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatCurrency } from "@/lib/format";
import { ordinalDay } from "@/lib/engines/month-cycle-range";
import { cn } from "@/lib/utils";
import { MonthCyclePurposePanel } from "@/features/people/components/purpose-money-signals";
import { AccountSpendingBreakdown } from "@/features/my-money/components/account-spending-breakdown";
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
  warning: "bg-warning/15 text-warning-foreground dark:text-warning",
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
  warning: "bg-warning/15 text-warning-foreground dark:text-warning",
  success: "bg-success/12 text-success",
  purple: "bg-purple/12 text-purple",
  neutral: "bg-muted text-muted-foreground",
};

const LABEL = "text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase";
const PANEL =
  "overflow-hidden rounded-[12px] border border-border-strong/60 bg-card shadow-e1 transition-[box-shadow,border-color] duration-300 hover:border-border-strong hover:shadow-e2";
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
    <div className={cn("flex items-center justify-between gap-3 border-b border-border-strong/50 bg-gradient-to-r to-transparent px-4 py-2.5", ACCENT_TINT[accent])}>
      <div className="flex min-w-0 items-center gap-2.5">
        <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-full", ACCENT_BG[accent])}>
          <Icon className="size-3.5" strokeWidth={1.9} />
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

function PanelEmpty({ title, description, icon: Icon = Sparkles, compact = false }: { title: string; description: string; icon?: LucideIcon; compact?: boolean }) {
  if (compact) {
    // Single-row variant for panels that are usually empty — keeps the page from spending a tall block on "nothing here".
    return (
      <div className="flex items-center gap-3 px-4 py-4">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-secondary text-foreground/55 ring-4 ring-secondary/40">
          <Icon className="size-4" strokeWidth={1.75} />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground">{title}</p>
          <p className="text-xs text-foreground/65">{description}</p>
        </div>
      </div>
    );
  }
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

function UpcomingRow({ item, icon: Icon, accent }: { item: MonthCycleUpcomingItem; icon: LucideIcon; accent: Accent }) {
  const overdue = item.daysLeft < 0;
  return (
    <div className="group flex items-center justify-between gap-3 px-4 py-2 transition-colors duration-150 hover:bg-secondary/50">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-[8px] transition-transform duration-200 group-hover:scale-105", ACCENT_BG[accent])}>
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
    <div className="group flex items-center justify-between gap-3 px-4 py-2 transition-colors duration-150 hover:bg-secondary/50">
      <div className="flex min-w-0 items-center gap-2.5">
        <span
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-bold transition-transform duration-200 group-hover:scale-105",
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

/** One account's share of the cycle's outflow. The colour stripe on the left is the same colour as its segment in the share bar above. */
function AccountSpendRow({ item, accent, bankId }: { item: MonthCycleAccountSpend; accent: Accent; bankId: string | null }) {
  return (
    <div className="relative flex items-center justify-between gap-3 py-2.5 pr-4 pl-5 transition-colors duration-150 hover:bg-secondary/40">
      <span aria-hidden className={cn("absolute inset-y-2.5 left-0 w-[3px] rounded-r-full", ACCENT_BAR[accent])} />
      <div className="flex min-w-0 items-center gap-2.5">
        {bankId ? (
          <BankLogo bankId={bankId} size={30} />
        ) : (
          <span className={cn("flex size-[30px] shrink-0 items-center justify-center rounded-full", ACCENT_BG[accent])}>
            <Wallet2 className="size-3.5" strokeWidth={1.75} />
          </span>
        )}
        <p className="truncate text-sm font-semibold text-foreground">
          {item.name}
          {item.mask && <span className="ml-1.5 text-xs font-normal text-muted-foreground tabular-nums">•••• {item.mask}</span>}
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end">
        <span className="text-[15px] leading-tight font-bold text-foreground tabular-nums">{formatCurrency(item.amount)}</span>
        <span className="text-[11px] leading-tight font-semibold text-foreground/65 tabular-nums">{item.percentOfTotal}%</span>
      </div>
    </div>
  );
}

/** One fact in the glance strip — a hairline-separated cell, not a box of its own. Label stays before the value (read in that order). */
function GlanceCell({ icon: Icon, label, value, meta, accent, muted = false }: { icon: LucideIcon; label: string; value: string; meta: string; accent: Accent; muted?: boolean }) {
  return (
    <div className="group flex min-w-0 items-center gap-3 bg-card px-4 py-3 transition-colors duration-150 hover:bg-secondary/40">
      <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-[10px] transition-transform duration-200 group-hover:scale-105", ACCENT_BG[accent], muted && "opacity-60")}>
        <Icon className="size-4" strokeWidth={1.75} />
      </span>
      <div className="min-w-0">
        <p className="truncate text-[11px] font-medium text-muted-foreground">{label}</p>
        <p className={cn("truncate text-[17px] leading-snug font-bold tabular-nums", muted ? "text-foreground/45" : "text-foreground")}>{value}</p>
        <p className="truncate text-[11px] text-muted-foreground">{meta}</p>
      </div>
    </div>
  );
}

/** A people side (give / receive): the label and its amount are the column's header — there is no separate tile row repeating them. */
function PeopleSideColumn({
  label,
  total,
  count,
  shown,
  tone,
  emptyText,
  children,
}: {
  label: string;
  total: number;
  count: number;
  shown: number;
  tone: "expense" | "success";
  emptyText: string;
  children: React.ReactNode;
}) {
  const give = tone === "expense";
  const more = count - shown;
  return (
    <div className="flex min-w-0 flex-col">
      <div className={cn("flex items-center justify-between gap-3 border-b border-border-strong/40 px-4 py-2.5", give ? "bg-warning/8" : "bg-success/8")}>
        <div className="min-w-0">
          <p className={cn("text-[11px] font-semibold tracking-[0.06em] uppercase", give ? "text-warning-foreground dark:text-warning" : "text-success")}>{label}</p>
          <p className="text-[11px] text-foreground/60">{count === 0 ? "Nobody" : `${count} ${count === 1 ? "person" : "people"}`}</p>
        </div>
        <p className={cn("shrink-0 text-xl leading-none font-bold tabular-nums", total === 0 ? "text-foreground/45" : give ? "text-expense" : "text-success")}>{formatCurrency(total)}</p>
      </div>
      <div className="flex-1 divide-y divide-border-strong/40">
        {shown === 0 ? <p className="px-4 py-3 text-xs text-muted-foreground">{emptyText}</p> : children}
      </div>
      {more > 0 && (
        <Link href="/people" className="flex items-center justify-between border-t border-border-strong/40 px-4 py-2 text-xs font-semibold text-primary-accent-text transition-colors hover:bg-primary/10">
          +{more} more {more === 1 ? "person" : "people"}
          <ArrowRight className="size-3" strokeWidth={2} />
        </Link>
      )}
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
                      {row.paidFor && (
                        <span className="inline-flex h-[18px] items-center gap-1 rounded-[4px] border border-purple/35 bg-purple/12 px-1.5 text-[10.5px] font-semibold text-purple">
                          <Users className="size-2.5" />
                          For {row.paidFor}
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
  compact = false,
}: {
  label: string;
  rangeLabel: string;
  /** Any day in the shown cycle's named month (its end). */
  selected: Date;
  onPick: (year: number, month: number) => void;
  onToday: () => void;
  /** The compact bar's one-line trigger — same popover and handlers; no `aria-live` (the page header's picker announces changes). */
  compact?: boolean;
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
        {compact ? (
          <button
            type="button"
            aria-label="Choose cycle"
            className="flex h-10 min-w-0 items-center justify-center gap-1.5 rounded-[6px] px-2 text-sm font-semibold whitespace-nowrap text-foreground transition-colors hover:bg-secondary"
          >
            <span className="truncate">{label}</span>
            <CalendarDays className="size-3.5 shrink-0 text-muted-foreground" />
          </button>
        ) : (
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
        )}
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

/** One shape for all four supporting figures — same height, chip, label / value / meta rhythm. */
function SummaryTile({
  label,
  icon: Icon,
  tone,
  chip,
  meta,
  leading,
  href,
  children,
}: {
  label: string;
  icon?: LucideIcon;
  tone?: string;
  chip?: string;
  meta?: React.ReactNode;
  /** Replaces the icon chip (the budget ring). */
  leading?: React.ReactNode;
  href?: string;
  children: React.ReactNode;
}) {
  const body = (
    <>
      {leading ?? (
        <span aria-hidden className={cn("flex size-[46px] shrink-0 items-center justify-center rounded-full ring-4 ring-secondary/50 transition-transform duration-200 group-hover/tile:scale-105", chip)}>
          {Icon && <Icon className="size-5" strokeWidth={1.8} />}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className={cn(LABEL, "block")}>{label}</span>
        <span className={cn("block truncate text-[1.4rem] leading-tight font-bold tracking-tight tabular-nums", tone)}>{children}</span>
        <span className="block min-h-4 truncate text-[11px] text-foreground/65">{meta}</span>
      </span>
    </>
  );
  const cls =
    "group/tile flex min-h-[84px] min-w-0 items-center gap-3 rounded-[12px] border border-border-strong/50 bg-secondary/35 px-3.5 py-3 transition-colors duration-150 hover:bg-secondary/65";
  return href ? (
    <Link href={href} className={cn(cls, "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none")}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

type UpcomingKey = "emi" | "loans" | "cards" | "bills";

type CommitmentPanel = {
  key: UpcomingKey;
  icon: LucideIcon;
  accent: Accent;
  title: string;
  total: number;
  href: string;
  addLabel: string;
  items: MonthCycleUpcomingItem[];
  /** One line under the title in the rail — the figure's own breakdown (e.g. "₹x this cycle · ₹y overdue"). */
  meta: string;
  emptyTitle: string;
  emptyDescription: string;
};

type PeopleSide = { total: number; count: number };

const peopleCount = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;

/**
 * Everything the cycle asks of you, in one workspace: a rail that totals and splits what is due by type (and lists the
 * two people balances beside it), and the selected type's items next to it. Replaces the old six-tile strip plus the
 * four-tab panel, which showed the same totals twice. Same figures, items and links — presentation only.
 */
function CommitmentsPanel({ panels, give, receive }: { panels: CommitmentPanel[]; give: PeopleSide; receive: PeopleSide }) {
  const [tab, setTab] = useState<UpcomingKey>(() => panels.find((p) => p.items.length > 0)?.key ?? panels[0].key);
  const reduceMotion = useReducedMotion();
  const active = panels.find((p) => p.key === tab) ?? panels[0];
  const ActiveIcon = active.icon;
  const sum = panels.reduce((s, p) => s + p.total, 0);
  const itemCount = panels.reduce((n, p) => n + p.items.length, 0);
  return (
    <section aria-label="Upcoming this cycle" className={cn(PANEL, "@container")}>
      <div className="grid @3xl:grid-cols-[20rem_minmax(0,1fr)]">
        {/* ── Rail: the total, what it is made of, and the way to each part ── */}
        <div className="flex min-w-0 flex-col border-b border-border-strong/50 bg-secondary/20 @3xl:border-r @3xl:border-b-0">
          <div className="px-4 pt-3.5 pb-3">
            <h2 className="font-heading text-[15px] leading-tight font-semibold text-foreground">Due this cycle</h2>
            <p className="text-xs text-foreground/65">EMIs, loans, card bills and bills to pay</p>
            <p className="mt-2.5 flex items-baseline gap-2">
              <span className={cn("text-[1.6rem] leading-none font-bold tracking-tight tabular-nums", sum === 0 ? "text-foreground/50" : "text-foreground")}>{formatCurrency(sum)}</span>
              <span className="text-xs text-foreground/65 tabular-nums">
                {itemCount} item{itemCount === 1 ? "" : "s"}
              </span>
            </p>
            {/* Share of the total by type — a true proportion, drawn only when there is something due. */}
            <div role="img" aria-label="Share of the amount due, by type" className="mt-2.5 flex h-2 gap-0.5 overflow-hidden rounded-full bg-secondary">
              {sum > 0 &&
                panels
                  .filter((p) => p.total > 0)
                  .map((p) => <span key={p.key} title={`${p.title} ${formatCurrency(p.total)}`} className={cn("h-full rounded-full", ACCENT_BAR[p.accent])} style={{ width: `${(p.total / sum) * 100}%` }} />)}
            </div>
          </div>

          <div role="tablist" aria-label="Due this cycle" className="grid grid-cols-2 gap-1 px-2 pb-2 @3xl:grid-cols-1">
            {panels.map((p) => {
              const selected = p.key === tab;
              const Icon = p.icon;
              const hasOverdue = p.items.some((i) => i.daysLeft < 0);
              const share = sum > 0 && p.total > 0 ? Math.max(1, Math.round((p.total / sum) * 100)) : null;
              return (
                <button
                  key={p.key}
                  type="button"
                  role="tab"
                  id={`mc-due-tab-${p.key}`}
                  aria-selected={selected}
                  aria-controls="mc-due-list"
                  onClick={() => setTab(p.key)}
                  className={cn(
                    "relative flex min-w-0 items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                    selected ? "text-foreground" : "text-foreground/75 hover:bg-secondary/70 hover:text-foreground",
                  )}
                >
                  {selected && (
                    <motion.span
                      layoutId="mc-due-tab"
                      aria-hidden
                      className="absolute inset-0 rounded-[10px] bg-card shadow-e1 ring-1 ring-border-strong/70"
                      transition={reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 500, damping: 40 }}
                    />
                  )}
                  <span className={cn("relative flex size-9 shrink-0 items-center justify-center rounded-[9px]", ACCENT_BG[p.accent], p.total === 0 && !selected && "opacity-60")}>
                    <Icon className="size-4" strokeWidth={1.8} />
                    {hasOverdue && (
                      <span className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-expense ring-2 ring-card">
                        <span className="sr-only">Has overdue items</span>
                      </span>
                    )}
                  </span>
                  <span className="relative min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 text-xs font-semibold">
                      {p.title}
                      <span className="rounded-full bg-secondary px-1.5 text-[10.5px] font-semibold text-foreground/70 tabular-nums">{p.items.length}</span>
                    </span>
                    <span className="block truncate text-[11px] text-foreground/60">{p.meta}</span>
                  </span>
                  <span className="relative shrink-0 text-right">
                    <span className={cn("block text-sm leading-tight font-bold tabular-nums", p.total === 0 ? "text-foreground/45" : "text-foreground")}>{formatCurrency(p.total)}</span>
                    <span className="block text-[10.5px] leading-tight text-foreground/55 tabular-nums">{share != null ? `${share}%` : " "}</span>
                  </span>
                </button>
              );
            })}
          </div>

          {/* People balances sit with the commitments but go to the People Ledger, not to a list here. */}
          <div className="mt-auto border-t border-border-strong/50 px-2 py-2">
            <p className={cn(LABEL, "px-2 pb-1")}>With people</p>
            <div className="grid grid-cols-2 gap-1 @3xl:grid-cols-1">
              {(
                [
                  { label: "You need to give", side: give, accent: "warning" as const },
                  { label: "You need to receive", side: receive, accent: "success" as const },
                ] as const
              ).map(({ label, side, accent }) => (
                <Link
                  key={label}
                  href="/people"
                  className="group/ppl flex min-w-0 items-center gap-2.5 rounded-[10px] px-2.5 py-1.5 transition-colors hover:bg-secondary/70 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <span aria-hidden className={cn("flex size-9 shrink-0 items-center justify-center rounded-[9px]", ACCENT_BG[accent], side.total === 0 && "opacity-60")}>
                    <Users className="size-4" strokeWidth={1.8} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-semibold text-foreground">{label}</span>
                    <span className="block truncate text-[11px] text-foreground/60">{peopleCount(side.count)}</span>
                  </span>
                  <span className={cn("shrink-0 text-sm font-bold tabular-nums", side.total === 0 ? "text-foreground/45" : "text-foreground")}>{formatCurrency(side.total)}</span>
                  <ArrowRight aria-hidden className="size-3.5 shrink-0 -translate-x-1 text-foreground/40 opacity-0 transition-[opacity,transform] group-hover/ppl:translate-x-0 group-hover/ppl:opacity-100" strokeWidth={2} />
                </Link>
              ))}
            </div>
          </div>
        </div>

        {/* ── Detail: the selected type's items ── */}
        <div className="flex min-w-0 flex-col">
          <div className={cn("flex items-center justify-between gap-3 border-b border-border-strong/50 bg-gradient-to-r to-transparent px-4 py-3", ACCENT_TINT[active.accent])}>
            <div className="flex min-w-0 items-center gap-2.5">
              <span aria-hidden className={cn("flex size-8 shrink-0 items-center justify-center rounded-full", ACCENT_BG[active.accent])}>
                <ActiveIcon className="size-3.5" strokeWidth={1.9} />
              </span>
              <div className="min-w-0">
                <p className="truncate font-heading text-[15px] leading-tight font-semibold text-foreground">{active.title}</p>
                <p className="truncate text-xs text-foreground/65">
                  {active.items.length === 0 ? "Nothing due" : active.meta}
                </p>
              </div>
            </div>
            <div className="shrink-0 text-right">
              <p className="text-[10px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">Total</p>
              <p className="text-sm leading-tight font-bold text-foreground tabular-nums">{formatCurrency(active.total)}</p>
            </div>
          </div>
          <motion.div
            key={active.key}
            id="mc-due-list"
            role="tabpanel"
            aria-labelledby={`mc-due-tab-${active.key}`}
            initial={reduceMotion ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.18 }}
            className="flex-1 divide-y divide-border-strong/40"
          >
            {active.items.length === 0 ? (
              <PanelEmpty compact icon={active.icon} title={active.emptyTitle} description={active.emptyDescription} />
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
              Open {active.key === "emi" ? "EMIs" : active.title.toLowerCase()}
              <ArrowRight className="size-3" strokeWidth={2} />
            </Link>
          </div>
        </div>
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
      <div id={id} className="scroll-mt-28">
        {children}
      </div>
    );
  }
  return (
    <motion.div
      id={id}
      className="scroll-mt-28"
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
  { id: "mc-due", label: "Due", icon: CalendarClock },
  { id: "mc-people", label: "People & accounts", icon: Users },
  { id: "mc-glance", label: "At a glance", icon: ListChecks },
  { id: "mc-budget", label: "Budget", icon: PiggyBank },
] as const;

/** Pill bar that jumps to a section and highlights the one in view — pinned under the top bar. */
function SectionNav({ top }: { top: number }) {
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
      style={{ top }}
      className="sticky z-attached -mx-1 flex gap-1 overflow-x-auto rounded-full border border-border-strong/60 bg-card/90 p-1 shadow-e1 backdrop-blur [scrollbar-width:none] supports-[backdrop-filter]:bg-card/75"
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
  // Compact bar: shown once the page's original title has scrolled out of view, hidden again when it returns.
  const { watch: watchTitle, progress: barProgress, reduceMotion: barReduceMotion, barTop, stackTop } = useCompactHeader();

  if (data.isLoading) {
    return (
      <div className="flex min-w-0 flex-col gap-4 px-1">
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
  const cycleInfoText = data.isCustomCycle
    ? `Cycle totals cover the ${ordinalDay(data.monthCycleStartDay)} of each month through the ${ordinalDay(data.monthCycleStartDay - 1)} of the next — change this in Settings.`
    : "Cycle totals cover the current calendar month.";
  const cycleStatusText = data.isCurrentCycle
    ? `${data.daysLeftInMonth} day${data.daysLeftInMonth === 1 ? "" : "s"} left`
    : data.daysLeftInMonth < 0
      ? "Cycle ended"
      : "Upcoming cycle";
  const barButton = "flex size-10 shrink-0 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground";

  return (
    <div className="flex min-w-0 flex-col gap-4 px-1">
      {/* ── Compact bar: zero-height sticky slot (no layout footprint); the same handlers as the header below ── */}
      <CompactHeaderBar label="Month Cycle quick bar" progress={barProgress} reduceMotion={barReduceMotion} top={barTop}>
        <span className="hidden min-w-0 shrink-0 truncate px-2 font-heading text-sm font-bold tracking-tight text-foreground min-[480px]:block">Month Cycle</span>
        <div className="flex min-w-0 items-center">
          <button type="button" onClick={data.goToPreviousCycle} aria-label="Previous cycle" className={barButton}>
            <ChevronLeft className="size-4" strokeWidth={1.75} />
          </button>
          <CyclePicker
            compact
            label={data.monthLabel}
            rangeLabel={data.monthRangeLabel}
            selected={data.cycleRange.end}
            onPick={data.goToCycleForMonth}
            onToday={data.goToCurrentCycle}
          />
          <button type="button" onClick={data.goToNextCycle} aria-label="Next cycle" className={barButton}>
            <ChevronRight className="size-4" strokeWidth={1.75} />
          </button>
        </div>
        {!data.isCurrentCycle && (
          <button type="button" onClick={data.goToCurrentCycle} aria-label="Back to current" title="Back to current" className={barButton}>
            <RotateCcw className="size-4" strokeWidth={2} />
          </button>
        )}
        {/* From `lg`, not `md`: at 768–1023px the sidebar is showing and the bar is too narrow for the chip (the "Cycle details" menu carries the status there). */}
        <span className="hidden h-7 shrink-0 items-center rounded-[6px] bg-secondary px-2 text-xs font-semibold text-foreground lg:inline-flex">{cycleStatusText}</span>
        <div className="ml-auto flex min-w-0 items-center gap-1.5">
          <span className="hidden min-w-0 flex-col items-end px-2 text-right leading-tight lg:flex">
            <span className="text-[10px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">{isMine ? "My spend" : "Total outflow"}</span>
            <span className="text-sm font-bold text-foreground tabular-nums">{formatCurrency(spent)}</span>
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" aria-label="Cycle details" className={barButton}>
                <MoreHorizontal className="size-4" strokeWidth={1.75} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuLabel className="lg:hidden">{cycleStatusText}</DropdownMenuLabel>
              <DropdownMenuLabel className="text-xs leading-snug font-normal text-muted-foreground">
                <span className="mb-0.5 block text-sm font-semibold text-foreground">About this cycle</span>
                {cycleInfoText}
              </DropdownMenuLabel>
            </DropdownMenuContent>
          </DropdownMenu>
          <Link
            href="/transactions"
            aria-label="New transaction"
            className="flex h-10 min-w-10 shrink-0 items-center justify-center gap-1.5 rounded-[6px] border border-primary-accent-text bg-primary px-2.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 sm:px-3.5"
          >
            <Plus className="size-4" strokeWidth={2.25} />
            {/* Icon-only at 768–1023px (sidebar showing, narrow bar); the link keeps its aria-label. */}
            <span className="hidden sm:inline md:max-lg:hidden">New transaction</span>
          </Link>
        </div>
      </CompactHeaderBar>

      {/* ── Header: title · cycle navigator · primary action ── */}
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-2">
          <div ref={watchTitle}>
            <h1 className="font-heading text-[22px] leading-tight font-bold tracking-tight text-foreground sm:text-2xl">Month Cycle</h1>
            <p className="mt-0.5 text-[13px] text-muted-foreground">Everything that moves your money this cycle.</p>
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
              <TooltipContent>{cycleInfoText}</TooltipContent>
            </Tooltip>
            {!data.isFollowingGlobalCycle && (
              <button
                type="button"
                onClick={data.followGlobalCycle}
                className="inline-flex h-7 items-center gap-1 rounded-[6px] border border-dashed border-border-strong px-2 text-xs font-semibold text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              >
                Sync with top-bar cycle
              </button>
            )}
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

      <SectionNav top={stackTop} />

      <Reveal id="mc-overview">
      {/* ── Cycle summary: spend leads; income, net, budget and savings support it ── */}
      <section aria-label="Cycle summary" className="@container overflow-hidden rounded-[16px] border border-border-strong/60 bg-card shadow-e1">
        <div className="flex flex-col @5xl:flex-row @5xl:items-stretch">
          {/* Hero */}
          <div className="relative flex flex-col gap-2.5 overflow-hidden bg-[image:var(--gradient-hero)] px-5 py-4 text-white sm:px-6 @5xl:min-w-[24rem] @5xl:max-w-[30rem]">
            <span aria-hidden className="pointer-events-none absolute -top-20 -right-16 size-56 rounded-full bg-primary/25 blur-3xl" />
            <span aria-hidden className="pointer-events-none absolute -bottom-24 -left-16 size-52 rounded-full border border-white/10" />
            <div className="relative flex flex-wrap items-center justify-between gap-2">
              <span className="text-[11px] font-semibold tracking-[0.08em] text-white/75 uppercase">{isMine ? "My spend" : "Total outflow"}</span>
              <ViewToggle isMine={isMine} onChange={setExpenseView} onDark />
            </div>
            <button
              type="button"
              onClick={() => setShowExpenseList(true)}
              className="relative w-fit text-left text-[34px] leading-none font-bold tracking-tight tabular-nums transition-opacity hover:opacity-85 sm:text-[38px]"
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
          <div className="grid min-w-0 flex-1 auto-rows-fr grid-cols-2 content-center gap-2.5 p-3.5 @xl:grid-cols-4 @5xl:grid-cols-2">
            <SummaryTile label="Income" icon={Wallet} tone="text-success" chip="bg-success/12 text-success" meta="Received this cycle">
              <AnimatedNumber value={financialView.income} format={formatCurrency} />
            </SummaryTile>
            <SummaryTile
              label="Net balance"
              icon={TrendingUp}
              tone={net < 0 ? "text-expense" : "text-foreground"}
              chip={net < 0 ? "bg-expense/10 text-expense" : "bg-primary/20 text-foreground dark:text-primary-accent-text"}
              meta="Income − spend"
            >
              <AnimatedNumber value={net} format={formatCurrency} />
            </SummaryTile>
            <SummaryTile
              label="Budget"
              href={data.budgetOverview ? undefined : "/budgets"}
              tone={data.budgetOverview?.isOverBudget ? "text-expense" : data.budgetOverview ? undefined : "text-foreground/70"}
              meta={data.budgetOverview ? `of ${formatCurrency(data.budgetOverview.limit)} used` : "Tap to set one"}
              leading={
                <ProgressRing value={budgetPercent ?? 0} size={46} strokeWidth={5}>
                  <span className="text-[10.5px] font-bold tabular-nums">{budgetPercent != null ? `${budgetPercent}%` : "—"}</span>
                </ProgressRing>
              }
            >
              {data.budgetOverview ? `${formatCurrency(Math.max(data.budgetOverview.remaining, 0))} left` : "No budget set"}
            </SummaryTile>
            <SummaryTile label="Saved" icon={PiggyBank} chip="bg-success/12 text-success" meta={`of ${formatCurrency(financialView.income)} income`}>
              {data.savingsRatePercent}%
            </SummaryTile>
          </div>
        </div>
        <AccountSpendingBreakdown spending={data.spendingFromAccounts} range={data.cycleRange} startDay={data.monthCycleStartDay} exportPeriod={data.monthLabel} />
      </section>
      </Reveal>

      <Reveal id="mc-due">
      {/* ── Due this cycle — one workspace: total + split by type + people balances, and the selected type's items ── */}
      <CommitmentsPanel
        give={{ total: data.peopleSides.totalToGive, count: data.peopleSides.giveCount }}
        receive={{ total: data.peopleSides.totalToReceive, count: data.peopleSides.receiveCount }}
        panels={[
          { key: "emi", icon: Banknote, accent: "primary", title: "EMI", total: data.emi.total, href: "/emi", addLabel: "Add EMI", items: data.emi.items, meta: `${data.emi.count} due this month`, emptyTitle: "No EMIs due", emptyDescription: "Active EMI installments due this cycle appear here." },
          {
            key: "loans", icon: Landmark, accent: "purple", title: "Loans", total: data.loans.total, href: "/loans", addLabel: "Add loan", items: data.loans.items,
            meta:
              data.loans.carriedOverdue > 0
                ? `${formatCurrency(data.loans.dueThisCycle)} this cycle · ${formatCurrency(data.loans.carriedOverdue)} overdue`
                : `${data.loans.count} installment${data.loans.count === 1 ? "" : "s"} due`,
            emptyTitle: "No loan EMIs due", emptyDescription: "Active loan installments due this cycle appear here.",
          },
          { key: "cards", icon: CreditCard, accent: "expense", title: "Card bills", total: data.cards.total, href: "/credit-cards", addLabel: "Add card bill", items: data.cards.items, meta: `${data.cards.count} bill${data.cards.count === 1 ? "" : "s"} due`, emptyTitle: "No card bills due", emptyDescription: "Unpaid statements due this cycle appear here." },
          {
            key: "bills", icon: Receipt, accent: "success", title: "Bills", total: data.bills.total, href: "/bills", addLabel: "Add bill", items: data.bills.items,
            meta:
              data.bills.overdueCount > 0
                ? `${formatCurrency(data.bills.total - data.bills.overdueTotal)} this cycle · ${formatCurrency(data.bills.overdueTotal)} overdue`
                : `${data.bills.count} bill${data.bills.count === 1 ? "" : "s"} due`,
            emptyTitle: "No bills due", emptyDescription: "Utility and other recurring bills due this cycle appear here.",
          },
        ]}
      />
      </Reveal>

      <Reveal id="mc-people">
      {/* ── People + account spend ── */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <section aria-label="People ledger" className={cn(PANEL, "@container flex flex-col")}>
          <PanelHeader icon={Users} accent="warning" title="People ledger" subtitle="Money between you and others" href="/people" />
          {/* Gross sides, never one net figure: each column's header IS its total (no separate tile row repeating it),
              and a held advance is shown on its own below instead of being folded into "to receive". */}
          {data.peopleYouNeedToGive.length === 0 && data.peopleHandoverPending.length === 0 ? (
            <PanelEmpty icon={Users} title="No pending balances" description="Money you're owed or owe will show up here." />
          ) : (
            <div className="grid min-w-0 flex-1 @xl:grid-cols-2 [&>*+*]:border-t [&>*+*]:border-border-strong/40 @xl:[&>*+*]:border-t-0 @xl:[&>*+*]:border-l">
              <PeopleSideColumn
                label="You need to give"
                total={data.peopleSides.totalToGive}
                count={data.peopleSides.giveCount}
                shown={data.peopleYouNeedToGive.length}
                tone="expense"
                emptyText="Nothing to give right now."
              >
                {data.peopleYouNeedToGive.map((p) => <PersonRow key={p.id} item={p} tone="expense" />)}
              </PeopleSideColumn>
              <PeopleSideColumn
                label="You need to receive"
                total={data.peopleSides.totalToReceive}
                count={data.peopleSides.receiveCount}
                shown={data.peopleHandoverPending.length}
                tone="success"
                emptyText="Nothing to receive right now."
              >
                {data.peopleHandoverPending.map((p) => <PersonRow key={p.id} item={p} tone="success" />)}
              </PeopleSideColumn>
            </div>
          )}
          <div className="flex items-center justify-between gap-3 border-t border-border-strong/40 pr-4">
            <Link href="/people" className="flex items-center gap-1.5 px-4 py-2.5 text-xs font-semibold text-primary-accent-text transition-colors hover:bg-primary/10">
              <Plus className="size-3.5" strokeWidth={2} />
              Add person
            </Link>
            {data.peopleSides.advanceHeld > 0 && (
              <p className="text-xs text-foreground/70">
                Advance held <span className="font-bold text-foreground tabular-nums">{formatCurrency(data.peopleSides.advanceHeld)}</span>
              </p>
            )}
          </div>
        </section>

        <section aria-label="Account spend" className={cn(PANEL, "flex flex-col")}>
          <PanelHeader icon={Wallet} accent="primary" title="Account outflow" subtitle="Where this cycle's money left from" figure={financialView.spent} href="/accounts" />
          {data.accountSpends.length === 0 ? (
            <PanelEmpty icon={Wallet} title="No spending yet this month" description="Expenses posted this cycle will be grouped by account here." />
          ) : (
            <>
              {/* One bar for the whole outflow, split by account — each row below carries its segment's colour. */}
              <div className="px-4 pt-3 pb-2">
                <div role="img" aria-label="Share of this cycle's outflow, by account" className="flex h-2 gap-0.5 overflow-hidden rounded-full bg-secondary">
                  {data.accountSpends.map((account, index) =>
                    account.percentOfTotal > 0 ? (
                      <span
                        key={account.id}
                        title={`${account.name} ${formatCurrency(account.amount)}`}
                        className={cn("h-full rounded-full", ACCENT_BAR[ACCOUNT_BAR_CYCLE[index % ACCOUNT_BAR_CYCLE.length]])}
                        style={{ width: `${account.percentOfTotal}%` }}
                      />
                    ) : null,
                  )}
                </div>
              </div>
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
              <p className="mt-auto border-t border-border-strong/40 px-4 py-2 text-[11px] text-foreground/60">
                {data.accountSpends.length} account{data.accountSpends.length === 1 ? "" : "s"} with spending this cycle
              </p>
            </>
          )}
        </section>
      </div>
      </Reveal>

      {/* ── Money to use — purposes due this cycle (informational; never Bills) ── */}
      <MonthCyclePurposePanel cycle={data.cycleRange} />

      <Reveal id="mc-glance">
      {/* ── Month at a glance ── */}
      <section aria-label="Month at a glance" className={PANEL}>
        <h2 className="sr-only">Month at a glance</h2>
        {/* Five facts as one hairline-divided strip (gap-px over a border-coloured ground), not five boxes inside a box. */}
        <div className="grid grid-cols-1 gap-px bg-border-strong/40 sm:grid-cols-2 lg:grid-cols-5 sm:max-lg:[&>*:last-child:nth-child(odd)]:col-span-2">
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
            muted={!data.monthSummary.highestSpendCategory}
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
            muted={!data.monthSummary.mostUsedAccount}
          />
          <GlanceCell icon={ListChecks} label="Total transactions" value={String(data.monthSummary.totalTransactions)} meta="This month" accent="purple" />
          <GlanceCell icon={TrendingUp} label="Avg. daily spend" value={formatCurrency(data.monthSummary.avgDailySpend)} meta="Per day" accent="warning" muted={data.monthSummary.avgDailySpend === 0} />
          <GlanceCell icon={CalendarClock} label="Pending actions" value={String(data.monthSummary.pendingActionsCount)} meta="EMI, bills & settlements" accent="success" />
        </div>
      </section>
      </Reveal>

      <Reveal id="mc-budget">
      {/* ── Budget ── */}
      <section aria-label="Budget overview" className={PANEL}>
        {data.budgetOverview ? (
          <>
            <PanelHeader icon={PiggyBank} accent="success" title="Budget overview" subtitle="Your monthly limit and how much is used" figure={data.budgetOverview.limit} figureLabel="Total budget" />
            <div className="flex flex-col gap-2.5 px-4 py-3">
              <div className="flex items-end justify-between gap-3">
                <p className="flex items-baseline gap-2">
                  <span className={cn("text-2xl leading-none font-bold tabular-nums", data.budgetOverview.isOverBudget ? "text-expense" : "text-foreground")}>
                    {Math.round(data.budgetOverview.usageRatio * 100)}%
                  </span>
                  <span className="text-xs text-foreground/65">{data.budgetOverview.isOverBudget ? "of budget — over the limit" : "of budget used"}</span>
                </p>
                <Link href="/budgets" className={LINK}>
                  Manage budget
                  <ArrowRight className="size-3" strokeWidth={2} />
                </Link>
              </div>
              <div className="h-2.5 w-full overflow-hidden rounded-full bg-secondary">
                <motion.div
                  className={cn("h-full rounded-full", data.budgetOverview.isOverBudget ? "bg-expense" : "bg-primary-accent-text")}
                  initial={{ width: 0 }}
                  animate={{ width: `${Math.min(100, Math.round(data.budgetOverview.usageRatio * 100))}%` }}
                  transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
                />
              </div>
              <div className="flex items-end justify-between gap-3">
                <div>
                  <p className={LABEL}>Used</p>
                  <p className="text-lg leading-tight font-bold text-foreground tabular-nums">{formatCurrency(data.budgetOverview.spent)}</p>
                </div>
                <div className="text-right">
                  <p className={LABEL}>{data.budgetOverview.isOverBudget ? "Over by" : "Remaining"}</p>
                  <p className={cn("text-lg leading-tight font-bold tabular-nums", data.budgetOverview.isOverBudget ? "text-expense" : "text-foreground")}>
                    {formatCurrency(data.budgetOverview.isOverBudget ? Math.abs(data.budgetOverview.remaining) : Math.max(data.budgetOverview.remaining, 0))}
                  </p>
                </div>
              </div>
            </div>
          </>
        ) : (
          // Nothing to chart yet — one prompt row (the old header + body said "Budget" twice over an empty panel).
          <div className="flex flex-wrap items-center gap-3 bg-gradient-to-r from-success/10 to-transparent px-4 py-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-success/12 text-success">
              <PiggyBank className="size-4.5" strokeWidth={1.9} />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="font-heading text-[15px] leading-tight font-semibold text-foreground">No monthly budget set</h2>
              <p className="text-xs text-foreground/65">Set an overall monthly limit to see how much of it this cycle uses.</p>
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

      {/* ── Expense list — the cycle's expenses as a ledger, in a side sheet that keeps the dashboard in view ── */}
      <Sheet open={showExpenseList} onOpenChange={setShowExpenseList}>
        <SheetContent
          side="right"
          showCloseButton={false}
          overlayClassName="bg-black/20 backdrop-blur-none dark:bg-black/35"
          // A floating card docked to the right edge, not a full-height drawer: inset on all sides and height
          // capped-not-fixed (h-auto + max-h), so a short list (the common case) hugs its own content instead of
          // leaving a wall of empty space below it; a long one still caps at the viewport and scrolls internally.
          className="w-[calc(100%-1.5rem)] gap-0 overflow-hidden rounded-2xl border border-border-strong/60 bg-popover p-0 shadow-[var(--shadow-e4)] data-[side=right]:inset-y-3 data-[side=right]:right-3 data-[side=right]:h-auto data-[side=right]:max-h-[calc(100vh-1.5rem)] data-[side=right]:w-[calc(100%-1.5rem)] data-[side=right]:sm:max-w-xl data-[side=right]:lg:max-w-2xl"
        >
          <SheetTitle className="sr-only">{isMine ? "My spend this cycle" : "Total outflow this cycle"}</SheetTitle>
          <div className="relative shrink-0 overflow-hidden bg-[image:var(--gradient-hero)] px-5 pt-5 pb-4 text-white">
            <span aria-hidden className="pointer-events-none absolute -top-16 -right-12 size-44 rounded-full bg-primary/25 blur-3xl" />
            <div className="relative flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[11px] font-semibold tracking-[0.08em] text-white/75 uppercase">
                  {isMine ? "My spend" : "Total outflow"} · {data.monthRangeLabel}
                </p>
                <p className="mt-1.5 text-[32px] leading-none font-bold tracking-tight tabular-nums">
                  <AnimatedNumber value={spent} format={formatCurrency} />
                </p>
                <p className="mt-1.5 text-xs text-white/70">
                  {data.expenseRows.length} transaction{data.expenseRows.length === 1 ? "" : "s"} this cycle
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowExpenseList(false)}
                aria-label="Close"
                className="flex size-8 shrink-0 items-center justify-center rounded-full bg-white/12 text-white/85 ring-1 ring-white/20 transition-colors hover:bg-white/20 hover:text-white"
              >
                <X className="size-4" />
              </button>
            </div>
            <div className="relative mt-4">
              <ViewToggle isMine={isMine} onChange={setExpenseView} onDark />
            </div>
          </div>

          <ScrollArea className="min-h-0 flex-1">
            {!isMine && <OutflowBreakdown breakdown={financialView.spentBreakdown} total={financialView.spent} />}
            {data.expenseRows.length === 0 ? (
              <PanelEmpty title="No expenses this cycle" description="Transactions in this cycle will appear here." />
            ) : (
              <ExpenseTable rows={data.expenseRows} isMine={isMine} />
            )}
          </ScrollArea>
        </SheetContent>
      </Sheet>
    </div>
  );
}
