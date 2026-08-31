"use client";

import Link from "next/link";
import {
  ArrowDownRight,
  ArrowUpRight,
  Banknote,
  CalendarClock,
  CalendarRange,
  ChevronDown,
  CreditCard,
  Info,
  Landmark,
  ListChecks,
  type LucideIcon,
  PiggyBank,
  Plus,
  Receipt,
  ShoppingBag,
  Sparkles,
  TrendingUp,
  Users,
  Wallet,
  Wallet2,
} from "lucide-react";
import { Stagger, StaggerItem } from "@/components/foundation/animated-container";
import { AnimatedNumber } from "@/components/foundation/animated-number";
import { ProgressRing } from "@/components/foundation/progress-ring";
import { EmptyState, SectionLabel } from "@/components/finance";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  useMonthCycleData,
  type MonthCycleAccountSpend,
  type MonthCyclePersonItem,
  type MonthCycleUpcomingItem,
} from "@/features/month-cycle/hooks/use-month-cycle-data";

type Accent = "primary" | "expense" | "warning" | "success" | "purple";

const ACCENT_BG: Record<Accent, string> = {
  primary: "bg-primary/10 text-primary",
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

const ACCOUNT_BAR_CYCLE: Accent[] = ["success", "primary", "warning", "purple", "expense"];

function StatTile({
  icon: Icon,
  label,
  amount,
  meta,
  accent,
}: {
  icon: LucideIcon;
  label: string;
  amount: number;
  meta?: string;
  accent: Accent;
}) {
  return (
    <div className="surface-primary flex flex-col gap-3 rounded-2xl p-4" style={{ boxShadow: "var(--shadow-e1)" }}>
      <span className={cn("flex size-9 items-center justify-center rounded-xl", ACCENT_BG[accent])}>
        <Icon className="size-4.5" />
      </span>
      <div>
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <p className="font-heading text-xl font-bold tabular-nums text-foreground">
          <AnimatedNumber value={amount} format={formatCurrency} />
        </p>
        {meta && <p className="mt-0.5 text-[11px] text-muted-foreground">{meta}</p>}
      </div>
    </div>
  );
}

function UpcomingRow({ item, icon: Icon, accent }: { item: MonthCycleUpcomingItem; icon: LucideIcon; accent: Accent }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl px-2 py-2.5 transition-colors hover:bg-muted/40">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-full", ACCENT_BG[accent])}>
          <Icon className="size-4" />
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-foreground">{item.title}</p>
          <p className="truncate text-xs text-muted-foreground">{item.subtitle}</p>
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5">
        <span className={cn("text-sm font-bold tabular-nums", item.daysLeft < 0 ? "text-expense" : "text-foreground")}>
          {formatCurrency(item.amount)}
        </span>
        <span className={cn("text-[11px]", item.daysLeft < 0 ? "font-medium text-expense" : "text-muted-foreground")}>
          {item.metaLabel}
        </span>
      </div>
    </div>
  );
}

function PersonRow({ item, tone }: { item: MonthCyclePersonItem; tone: "expense" | "success" }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl px-2 py-2.5 transition-colors hover:bg-muted/40">
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
          {item.note && <p className="truncate text-xs text-muted-foreground">({item.note})</p>}
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5">
        <span className={cn("text-sm font-bold tabular-nums", tone === "success" ? "text-success" : "text-expense")}>
          {formatCurrency(item.amount)}
        </span>
        {item.daysSince != null && (
          <span className="text-[11px] text-muted-foreground">
            {item.daysSince === 0 ? "Today" : `Since ${item.daysSince}d`}
          </span>
        )}
      </div>
    </div>
  );
}

function AccountSpendRow({ item, accent }: { item: MonthCycleAccountSpend; accent: Accent }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-xl px-2 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-lg", ACCENT_BG[accent])}>
            <Wallet2 className="size-3.5" />
          </span>
          <p className="truncate text-sm font-semibold text-foreground">
            {item.name}
            {item.mask && <span className="ml-1.5 text-xs font-normal text-muted-foreground">•••• {item.mask}</span>}
          </p>
        </div>
        <span className="shrink-0 text-sm font-bold tabular-nums text-foreground">{formatCurrency(item.amount)}</span>
      </div>
      <div className="flex items-center gap-2 pl-9.5">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
          <div className={cn("h-full rounded-full", ACCENT_BAR[accent])} style={{ width: `${item.percentOfTotal}%` }} />
        </div>
        <span className="w-10 shrink-0 text-right text-[11px] font-medium text-muted-foreground">{item.percentOfTotal}%</span>
      </div>
    </div>
  );
}

function SectionCard({
  icon,
  title,
  total,
  viewAllHref,
  addHref,
  addLabel,
  children,
  isEmpty,
  emptyTitle,
  emptyDescription,
}: {
  icon: LucideIcon;
  title: string;
  total: number;
  viewAllHref: string;
  addHref: string;
  addLabel: string;
  children: React.ReactNode;
  isEmpty: boolean;
  emptyTitle: string;
  emptyDescription: string;
}) {
  return (
    <div className="surface-primary flex flex-col gap-1 rounded-2xl p-4" style={{ boxShadow: "var(--shadow-e1)" }}>
      <div className="flex items-center justify-between gap-3">
        <SectionLabel icon={icon}>{title}</SectionLabel>
        <Link href={viewAllHref} className="shrink-0 text-xs font-semibold text-primary hover:underline">
          View All
        </Link>
      </div>
      <p className="text-[11px] font-medium text-muted-foreground">
        Total <span className="font-bold text-foreground">{formatCurrency(total)}</span>
      </p>
      <div className="mt-1">
        {isEmpty ? (
          <EmptyState icon={icon} title={emptyTitle} description={emptyDescription} className="py-6" />
        ) : (
          <div className="flex flex-col divide-y divide-border/50">{children}</div>
        )}
      </div>
      <Link href={addHref} className="mt-2 flex items-center gap-1.5 text-xs font-semibold text-primary hover:underline">
        <Plus className="size-3.5" />
        {addLabel}
      </Link>
    </div>
  );
}

function SummaryTile({ icon: Icon, label, value, meta, accent }: { icon: LucideIcon; label: string; value: string; meta: string; accent: Accent }) {
  return (
    <div className="surface-secondary flex items-center gap-3 rounded-2xl p-3.5">
      <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-xl", ACCENT_BG[accent])}>
        <Icon className="size-4.5" />
      </span>
      <div className="min-w-0">
        <p className="text-[11px] font-medium text-muted-foreground">{label}</p>
        <p className="truncate text-sm font-bold text-foreground">{value}</p>
        <p className="truncate text-[11px] text-muted-foreground">{meta}</p>
      </div>
    </div>
  );
}

export function MonthCycleWorkspace() {
  const data = useMonthCycleData();

  if (data.isLoading) {
    return (
      <div className="flex flex-col gap-5 p-4 sm:p-6">
        <Skeleton className="h-16 w-full rounded-2xl" />
        <Skeleton className="h-36 w-full rounded-3xl" />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-28 rounded-2xl" />
          ))}
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-64 rounded-2xl" />
          <Skeleton className="h-64 rounded-2xl" />
        </div>
      </div>
    );
  }

  const { financialView } = data;
  const changePercent = financialView.spentChangePercent;
  const changeIsLess = changePercent != null && changePercent <= 0;

  return (
    <div className="flex flex-col gap-5 p-4 sm:p-6">
      {/* Page header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="font-heading text-2xl font-bold tracking-tight text-foreground">Month Cycle</h1>
            <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
              {data.monthLabel} Cycle
              <ChevronDown className="size-3" />
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <CalendarRange className="size-3.5" />
              {data.monthRangeLabel}
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 font-medium text-foreground">
              {data.daysLeftInMonth} day{data.daysLeftInMonth === 1 ? "" : "s"} left in cycle
            </span>
            <Tooltip>
              <TooltipTrigger asChild>
                <Info className="size-3.5 cursor-help" />
              </TooltipTrigger>
              <TooltipContent>Cycle totals cover the current calendar month.</TooltipContent>
            </Tooltip>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="inline-flex h-9 items-center gap-2 rounded-xl border border-border/60 bg-card px-3 text-sm font-medium text-foreground">
            <CalendarClock className="size-3.5 text-muted-foreground" />
            This Month
          </span>
          <Link
            href="/transactions"
            className="inline-flex h-10 items-center justify-center gap-2 rounded-2xl border border-transparent bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors"
            style={{ boxShadow: "var(--shadow-e1)" }}
          >
            <Plus className="size-4" />
            New Transaction
          </Link>
        </div>
      </div>

      {/* Hero */}
      <section
        className="relative overflow-hidden rounded-3xl p-5 text-primary-foreground sm:p-7"
        style={{ background: "var(--gradient-hero)", boxShadow: "var(--shadow-dialog), var(--glow-primary)" }}
      >
        <div className="relative grid grid-cols-2 gap-6 sm:grid-cols-3 lg:grid-cols-5 lg:divide-x lg:divide-white/15">
          <div className="flex flex-col gap-2 lg:pr-6">
            <p className="text-[11px] font-semibold tracking-wide text-primary-foreground/75 uppercase">
              Total Spent This Month
            </p>
            <span className="font-heading text-2xl font-bold tracking-tight tabular-nums sm:text-3xl">
              <AnimatedNumber value={financialView.spent} format={formatCurrency} />
            </span>
            {changePercent != null && (
              <p className="flex items-center gap-1 text-xs font-medium text-primary-foreground/85">
                {changeIsLess ? <ArrowDownRight className="size-3.5" /> : <ArrowUpRight className="size-3.5" />}
                {Math.abs(Math.round(changePercent * 10) / 10)}% {changeIsLess ? "less" : "more"} than last month
              </p>
            )}
          </div>

          <div className="flex flex-col gap-2 lg:px-6">
            <p className="text-[11px] font-semibold tracking-wide text-primary-foreground/75 uppercase">Income</p>
            <span className="flex items-center gap-2 font-heading text-2xl font-bold tabular-nums">
              <Wallet className="size-5 text-primary-foreground/70" />
              <AnimatedNumber value={financialView.income} format={formatCurrency} />
            </span>
          </div>

          <div className="flex flex-col gap-2 lg:px-6">
            <p className="text-[11px] font-semibold tracking-wide text-primary-foreground/75 uppercase">Net Balance</p>
            <span className="font-heading text-2xl font-bold tabular-nums">
              <AnimatedNumber value={financialView.net} format={formatCurrency} />
            </span>
          </div>

          <div className="flex flex-col items-center justify-center gap-2 lg:px-6">
            {data.budgetOverview ? (
              <>
                <ProgressRing
                  value={Math.round(data.budgetOverview.usageRatio * 100)}
                  size={78}
                  strokeWidth={6}
                  color="white"
                  trackColor="rgba(255,255,255,0.25)"
                >
                  <span className="font-heading text-base font-bold">{Math.round(data.budgetOverview.usageRatio * 100)}%</span>
                </ProgressRing>
                <p className="text-center text-[11px] leading-snug text-primary-foreground/75">
                  of {formatCurrency(data.budgetOverview.limit)} Budget Used
                </p>
              </>
            ) : (
              <>
                <ProgressRing value={0} size={78} strokeWidth={6} color="white" trackColor="rgba(255,255,255,0.25)">
                  <TrendingUp className="size-5" />
                </ProgressRing>
                <p className="text-center text-[11px] leading-snug text-primary-foreground/75">No monthly budget set</p>
              </>
            )}
          </div>

          <div className="flex flex-col items-center justify-center gap-2 lg:pl-6">
            <span className="flex size-9 items-center justify-center rounded-full bg-white/15">
              <PiggyBank className="size-4.5" />
            </span>
            <p className="text-center font-heading text-lg font-bold">{data.savingsRatePercent}%</p>
            <p className="text-center text-[11px] leading-snug text-primary-foreground/75">
              Saved of {formatCurrency(financialView.income)} in
            </p>
          </div>
        </div>
      </section>

      {/* Stat grid */}
      <Stagger className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StaggerItem>
          <StatTile icon={Banknote} label="EMI (Total)" amount={data.emi.total} meta={`${data.emi.count} due this month`} accent="primary" />
        </StaggerItem>
        <StaggerItem>
          <StatTile icon={Landmark} label="Loans (Payable)" amount={data.loans.total} meta={`${data.loans.count} active loans`} accent="purple" />
        </StaggerItem>
        <StaggerItem>
          <StatTile icon={CreditCard} label="Credit Card Bills" amount={data.cards.total} meta={`${data.cards.count} bills due`} accent="expense" />
        </StaggerItem>
        <StaggerItem>
          <StatTile
            icon={Users}
            label="People (You Need to Give)"
            amount={data.peopleStats.totalYouOwe}
            meta={`${data.peopleStats.owingPeopleCount} people`}
            accent="warning"
          />
        </StaggerItem>
        <StaggerItem>
          <StatTile
            icon={Users}
            label="People (Handover Pending)"
            amount={data.peopleStats.totalYouAreOwed}
            meta={`${data.peopleStats.owedByPeopleCount} people`}
            accent="purple"
          />
        </StaggerItem>
        <StaggerItem>
          <StatTile icon={Receipt} label="Bills (Utility & Others)" amount={data.bills.total} meta={`${data.bills.count} bills due`} accent="success" />
        </StaggerItem>
      </Stagger>

      {/* Upcoming sections */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SectionCard
          icon={Banknote}
          title="EMI (Upcoming)"
          total={data.emi.total}
          viewAllHref="/emi"
          addHref="/emi"
          addLabel="Add EMI"
          isEmpty={data.emi.items.length === 0}
          emptyTitle="No EMIs due"
          emptyDescription="Active EMI installments due this cycle appear here."
        >
          {data.emi.items.map((item) => (
            <UpcomingRow key={item.id} item={item} icon={Banknote} accent="primary" />
          ))}
        </SectionCard>

        <SectionCard
          icon={Landmark}
          title="Loans (Payable)"
          total={data.loans.total}
          viewAllHref="/loans"
          addHref="/loans"
          addLabel="Add Loan"
          isEmpty={data.loans.items.length === 0}
          emptyTitle="No loan EMIs due"
          emptyDescription="Active loan installments due this cycle appear here."
        >
          {data.loans.items.map((item) => (
            <UpcomingRow key={item.id} item={item} icon={Landmark} accent="purple" />
          ))}
        </SectionCard>

        <SectionCard
          icon={CreditCard}
          title="Credit Card Bills"
          total={data.cards.total}
          viewAllHref="/credit-cards"
          addHref="/credit-cards"
          addLabel="Add Card Bill"
          isEmpty={data.cards.items.length === 0}
          emptyTitle="No card bills due"
          emptyDescription="Unpaid statements due this cycle appear here."
        >
          {data.cards.items.map((item) => (
            <UpcomingRow key={item.id} item={item} icon={CreditCard} accent="expense" />
          ))}
        </SectionCard>

        <SectionCard
          icon={Receipt}
          title="Bills & Reminders"
          total={data.bills.total}
          viewAllHref="/bills"
          addHref="/bills"
          addLabel="Add Bill"
          isEmpty={data.bills.items.length === 0}
          emptyTitle="No bills due"
          emptyDescription="Utility and other recurring bills due this cycle appear here."
        >
          {data.bills.items.map((item) => (
            <UpcomingRow key={item.id} item={item} icon={Receipt} accent="success" />
          ))}
        </SectionCard>
      </div>

      {/* People ledger + account spend */}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="surface-primary flex flex-col gap-4 rounded-2xl p-4" style={{ boxShadow: "var(--shadow-e1)" }}>
          <div className="flex items-center justify-between gap-3">
            <SectionLabel icon={Users}>People Ledger</SectionLabel>
            <div className="flex items-center gap-3">
              <div className="text-right">
                <p className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">Net balance</p>
                <p className={cn("text-sm font-bold tabular-nums", data.peopleStats.netBalance >= 0 ? "text-success" : "text-expense")}>
                  {formatCurrency(data.peopleStats.netBalance)}
                </p>
              </div>
              <Link href="/people" className="shrink-0 text-xs font-semibold text-primary hover:underline">
                View All
              </Link>
            </div>
          </div>

          {data.peopleYouNeedToGive.length === 0 && data.peopleHandoverPending.length === 0 ? (
            <EmptyState icon={Users} title="No pending balances" description="Money you're owed or owe will show up here." className="py-6" />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <div className="mb-1 flex items-center justify-between px-2">
                  <p className="text-[11px] font-semibold tracking-wide text-warning-foreground uppercase">You Need to Give</p>
                  <p className="text-[11px] font-bold text-warning-foreground">{formatCurrency(data.peopleStats.totalYouOwe)}</p>
                </div>
                <div className="flex flex-col divide-y divide-border/50">
                  {data.peopleYouNeedToGive.length === 0 ? (
                    <p className="px-2 py-2 text-xs text-muted-foreground">You owe nobody right now.</p>
                  ) : (
                    data.peopleYouNeedToGive.map((p) => <PersonRow key={p.id} item={p} tone="expense" />)
                  )}
                </div>
              </div>
              <div>
                <div className="mb-1 flex items-center justify-between px-2">
                  <p className="text-[11px] font-semibold tracking-wide text-success uppercase">Handover Pending</p>
                  <p className="text-[11px] font-bold text-success">{formatCurrency(data.peopleStats.totalYouAreOwed)}</p>
                </div>
                <div className="flex flex-col divide-y divide-border/50">
                  {data.peopleHandoverPending.length === 0 ? (
                    <p className="px-2 py-2 text-xs text-muted-foreground">Nobody owes you right now.</p>
                  ) : (
                    data.peopleHandoverPending.map((p) => <PersonRow key={p.id} item={p} tone="success" />)
                  )}
                </div>
              </div>
            </div>
          )}
          <Link href="/people" className="flex items-center gap-1.5 text-xs font-semibold text-primary hover:underline">
            <Plus className="size-3.5" />
            Add Person
          </Link>
        </div>

        <div className="surface-primary flex flex-col gap-3 rounded-2xl p-4" style={{ boxShadow: "var(--shadow-e1)" }}>
          <div className="flex items-center justify-between gap-3">
            <SectionLabel icon={Wallet}>Account Spend This Month</SectionLabel>
            <div className="flex items-center gap-3">
              <div className="text-right">
                <p className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">Total</p>
                <p className="text-sm font-bold tabular-nums text-foreground">{formatCurrency(financialView.spent)}</p>
              </div>
              <Link href="/accounts" className="shrink-0 text-xs font-semibold text-primary hover:underline">
                View All
              </Link>
            </div>
          </div>
          {data.accountSpends.length === 0 ? (
            <EmptyState icon={Wallet} title="No spending yet this month" description="Expenses posted this cycle will be grouped by account here." className="py-6" />
          ) : (
            <div className="flex flex-col gap-1">
              {data.accountSpends.map((account, index) => (
                <AccountSpendRow key={account.id} item={account} accent={ACCOUNT_BAR_CYCLE[index % ACCOUNT_BAR_CYCLE.length]} />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Month summary at a glance */}
      <div className="surface-primary flex flex-col gap-3 rounded-2xl p-4" style={{ boxShadow: "var(--shadow-e1)" }}>
        <SectionLabel icon={Sparkles}>Month Summary at a Glance</SectionLabel>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <SummaryTile
            icon={ShoppingBag}
            label="Highest Spend"
            value={data.monthSummary.highestSpendCategory ? data.monthSummary.highestSpendCategory.name : "—"}
            meta={
              data.monthSummary.highestSpendCategory
                ? `${formatCurrency(data.monthSummary.highestSpendCategory.amount)} · ${data.monthSummary.highestSpendCategory.percentOfTotal}% of total`
                : "No expenses yet"
            }
            accent="expense"
          />
          <SummaryTile
            icon={Wallet2}
            label="Most Used Account"
            value={data.monthSummary.mostUsedAccount ? data.monthSummary.mostUsedAccount.name : "—"}
            meta={
              data.monthSummary.mostUsedAccount
                ? `${data.monthSummary.mostUsedAccount.transactionCount} transactions · ${formatCurrency(data.monthSummary.mostUsedAccount.amount)}`
                : "No activity yet"
            }
            accent="primary"
          />
          <SummaryTile
            icon={ListChecks}
            label="Total Transactions"
            value={String(data.monthSummary.totalTransactions)}
            meta="This month"
            accent="purple"
          />
          <SummaryTile
            icon={TrendingUp}
            label="Avg. Daily Spend"
            value={formatCurrency(data.monthSummary.avgDailySpend)}
            meta="Per day"
            accent="warning"
          />
          <SummaryTile
            icon={CalendarClock}
            label="Pending Actions"
            value={String(data.monthSummary.pendingActionsCount)}
            meta="EMI, Bills & Settlements"
            accent="success"
          />
        </div>
      </div>

      {/* Budget overview */}
      <div className="surface-primary flex flex-col gap-3 rounded-2xl p-4" style={{ boxShadow: "var(--shadow-e1)" }}>
        <div className="flex items-center justify-between gap-3">
          <SectionLabel icon={PiggyBank}>Budget Overview</SectionLabel>
          {data.budgetOverview && (
            <div className="text-right">
              <p className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">Total Budget</p>
              <p className="text-sm font-bold tabular-nums text-foreground">{formatCurrency(data.budgetOverview.limit)}</p>
            </div>
          )}
        </div>

        {data.budgetOverview ? (
          <>
            <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={cn("h-full rounded-full", data.budgetOverview.isOverBudget ? "bg-expense" : "bg-primary")}
                style={{ width: `${Math.round(data.budgetOverview.usageRatio * 100)}%` }}
              />
            </div>
            <div className="flex items-center justify-between text-sm">
              <div>
                <p className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">Used</p>
                <p className="font-bold tabular-nums text-foreground">{formatCurrency(data.budgetOverview.spent)}</p>
              </div>
              <div className="text-right">
                <p className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">Remaining</p>
                <p className={cn("font-bold tabular-nums", data.budgetOverview.isOverBudget ? "text-expense" : "text-foreground")}>
                  {formatCurrency(Math.max(data.budgetOverview.remaining, 0))}
                </p>
              </div>
            </div>
            <Link href="/budgets" className="self-start text-xs font-semibold text-primary hover:underline">
              Manage Budget
            </Link>
          </>
        ) : (
          <div className="flex flex-col items-center">
            <EmptyState
              icon={PiggyBank}
              title="No monthly budget set"
              description="Set an overall monthly budget to track usage here."
              className="py-6"
            />
            <Link href="/budgets" className="-mt-3 text-xs font-semibold text-primary hover:underline">
              Manage Budget
            </Link>
          </div>
        )}
      </div>

      <p className="flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground">
        <CalendarClock className="size-3.5" />
        Cycle totals reflect the current calendar month and update live as you record payments and transactions.
      </p>
    </div>
  );
}
