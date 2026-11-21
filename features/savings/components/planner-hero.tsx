"use client";

/**
 * The top of the Savings workspace — one compact band of three linked panels (≈190px tall):
 *  1. Safe to save now: free money − commitments still unpaid this cycle. Only recorded balances, goal reservations
 *     and confirmed dues — never a forecast of spending or income. The full working (accounts counted, due list,
 *     income / paid / spent) lives in a popover so the band stays small.
 *  2. This month's plan: planned vs saved this cycle, status counts, plan vs typical surplus, and the Allocate action.
 *  3. Saved in goals: total, a segmented bar per goal, counts, and where the money is held.
 * Already-paid commitments and received income are context only — never subtracted twice, never assumed.
 */

import { ArrowRight, CalendarClock, Info, Lock, Sparkles, Wallet } from "lucide-react";
import { useMemo } from "react";
import { ClayButton } from "@/components/clay/clay-button";
import { AccountMark } from "@/components/finance";
import { ProgressRing } from "@/components/foundation/progress-ring";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency } from "@/lib/format";
import type { Account } from "@/lib/models/account";
import { cn } from "@/lib/utils";
import type { SavingsPlanner } from "@/features/savings/hooks/use-savings-planner";
import { goalAccent } from "@/features/savings/lib/goal-style";
import { PLAN_STATUS } from "@/features/savings/components/savings-ui";

const KIND_LABEL = { card: "Card bills", loan: "Loans", emi: "EMIs", bill: "Bills" } as const;

function shortDate(d: Date) {
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

/** Compact currency for tight figure rows (₹1.2L / ₹38.4K) — the exact amount is always one click away. */
function compact(n: number) {
  const abs = Math.abs(n);
  if (abs >= 10_000_000) return `₹${(n / 10_000_000).toFixed(abs >= 100_000_000 ? 0 : 1).replace(/\.0$/, "")}Cr`;
  if (abs >= 100_000) return `₹${(n / 100_000).toFixed(abs >= 1_000_000 ? 0 : 1).replace(/\.0$/, "")}L`;
  if (abs >= 10_000) return `₹${(n / 1000).toFixed(1).replace(/\.0$/, "")}K`;
  return formatCurrency(n);
}

function Line({ label, value, sign, strong, children, testId }: { label: React.ReactNode; value: number; sign?: "−" | "="; strong?: boolean; children?: React.ReactNode; testId?: string }) {
  return (
    <div className={cn("flex items-center justify-between gap-3 py-1", strong && "mt-1 border-t border-border/60 pt-2")} data-testid={testId}>
      <span className={cn("flex min-w-0 items-center gap-1.5 text-[12.5px]", strong ? "font-semibold text-foreground" : "text-muted-foreground")}>{label}</span>
      <span className="flex shrink-0 items-center gap-1.5">
        {children}
        <span className={cn("font-mono tabular-nums", strong ? "text-[15px] font-bold text-primary-accent-text" : "text-[13px] font-semibold text-foreground")}>
          {sign === "−" && value > 0 ? "−" : ""}
          {formatCurrency(value)}
        </span>
      </span>
    </div>
  );
}

function AccountRows({ rows }: { rows: SavingsPlanner["countedAccounts"] }) {
  return (
    <>
      {rows.map((a) => (
        <div key={a.id} className="flex items-center justify-between gap-2 px-1.5 py-0.5 text-[11.5px]">
          <span className="min-w-0 truncate text-foreground/85">
            {a.name}
            {a.last4 ? <span className="text-muted-foreground"> ••••{a.last4}</span> : null}
          </span>
          <span className="shrink-0 font-mono font-semibold tabular-nums text-foreground">{formatCurrency(a.balance)}</span>
        </div>
      ))}
    </>
  );
}

/**
 * The full working behind "Safe to save now" — opened from the hero, never always-on. Read top to bottom:
 * the money you have, what is already claimed (goal reservations, unpaid commitments), what is left.
 */
function CapacityBreakdown({ planner }: { planner: SavingsPlanner }) {
  const { capacity, due, upcoming, countedAccounts, leftOutAccounts } = planner;
  const dueKinds = (["emi", "loan", "card", "bill"] as const).filter((k) => due[k] > 0);

  return (
    <div className="flex flex-col" data-testid="cap-breakdown">
      <p className="mb-1.5 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">How this is worked out</p>

      <p className="mt-0.5 text-[10px] font-semibold tracking-[0.08em] text-muted-foreground/80 uppercase">Money you have</p>
      <Line label="In your accounts" value={capacity.inAccounts} testId="cap-in-accounts" />
      <details className="group mb-1 rounded-xl bg-muted/50 px-2 py-1.5" data-testid="cap-accounts">
        <summary className="flex cursor-pointer list-none items-center justify-between text-[11px] text-muted-foreground">
          <span>
            Accounts counted · {countedAccounts.length}
            {leftOutAccounts.length > 0 ? ` · ${leftOutAccounts.length} card account${leftOutAccounts.length === 1 ? "" : "s"} not counted` : ""}
          </span>
          <span className="text-[10px] group-open:hidden">Show</span>
          <span className="hidden text-[10px] group-open:inline">Hide</span>
        </summary>
        <div className="mt-1 flex max-h-32 flex-col overflow-y-auto">
          {countedAccounts.length === 0 ? <p className="px-1.5 text-[11px] text-muted-foreground">No accounts yet.</p> : <AccountRows rows={countedAccounts} />}
          {leftOutAccounts.length > 0 && (
            <>
              <p className="mt-1 px-1.5 text-[10px] text-muted-foreground">Not counted (card accounts, not savings money)</p>
              <div className="opacity-70">
                <AccountRows rows={leftOutAccounts} />
              </div>
            </>
          )}
        </div>
      </details>

      <p className="mt-1 text-[10px] font-semibold tracking-[0.08em] text-muted-foreground/80 uppercase">Already claimed</p>
      <Line label="Set aside for goals" value={capacity.reserved} sign="−" testId="cap-reserved" />
      <Line label={`Still to pay this cycle${due.count > 0 ? ` · ${due.count}` : ""}`} value={capacity.due} sign="−" testId="cap-due" />
      <div className="mb-1 flex flex-col gap-0.5 rounded-xl bg-muted/50 p-2" data-testid="cap-due-list">
        {upcoming.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">Nothing left to pay this cycle.</p>
        ) : (
          <>
            {dueKinds.length > 0 && (
              <p className="flex flex-wrap gap-x-2.5 pb-0.5 text-[10.5px] text-muted-foreground">
                {dueKinds.map((k) => (
                  <span key={k}>
                    {KIND_LABEL[k]} {formatCurrency(due[k])}
                  </span>
                ))}
                {due.overdue > 0 && <span className="text-warning-foreground dark:text-warning">incl. overdue {formatCurrency(due.overdue)}</span>}
              </p>
            )}
            <div className="flex max-h-32 flex-col overflow-y-auto">
              {upcoming.map((u) => (
                <a key={u.key} href={u.href} className="flex items-center justify-between gap-2 rounded-lg px-1.5 py-1 text-[11.5px] hover:bg-muted">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <CalendarClock className={cn("size-3 shrink-0", u.status === "overdue" ? "text-warning-foreground dark:text-warning" : "text-muted-foreground")} />
                    <span className="truncate text-foreground/85">{u.title}</span>
                    <span className="shrink-0 text-muted-foreground">{u.status === "overdue" ? "overdue" : shortDate(u.dueDate)}</span>
                  </span>
                  <span className="shrink-0 font-mono font-semibold tabular-nums text-foreground">{formatCurrency(u.amount)}</span>
                </a>
              ))}
            </div>
          </>
        )}
      </div>
      <Line label="Safe to save now" value={capacity.safeToSave} sign="=" strong testId="cap-safe" />

      <div className="mt-3 grid grid-cols-3 gap-2 rounded-xl bg-muted/50 p-2 text-center" data-testid="cap-this-cycle">
        <div className="min-w-0">
          <p className="truncate text-[10px] text-muted-foreground">Income received</p>
          <p className="truncate font-mono text-[13px] font-semibold tabular-nums text-success">{planner.incomeThisCycle == null ? "…" : formatCurrency(planner.incomeThisCycle)}</p>
        </div>
        <div className="min-w-0">
          <p className="truncate text-[10px] text-muted-foreground">Commitments paid</p>
          <p className="truncate font-mono text-[13px] font-semibold tabular-nums text-foreground">{formatCurrency(planner.paidThisCycle)}</p>
        </div>
        <div className="min-w-0">
          <p className="truncate text-[10px] text-muted-foreground">Spent (my share)</p>
          <p className="truncate font-mono text-[13px] font-semibold tabular-nums text-foreground">{formatCurrency(planner.spentThisCycle)}</p>
        </div>
      </div>
      <p className="mt-2 flex items-start gap-1 text-[10.5px] leading-snug text-muted-foreground">
        <Info className="mt-px size-3 shrink-0" /> Uses only recorded balances and confirmed dues. Spending you haven&apos;t made and income that hasn&apos;t arrived are never assumed, and paid commitments already left your balances, so they aren&apos;t subtracted again.
      </p>
    </div>
  );
}

function SafeToSaveCard({ planner }: { planner: SavingsPlanner }) {
  const { capacity, cycle } = planner;
  const total = Math.max(capacity.free, capacity.due, 1);
  const seg = (v: number) => `${(Math.max(0, v) / total) * 100}%`;

  const figures: { label: string; value: number; dot: string }[] = [
    { label: "In accounts", value: capacity.inAccounts, dot: "bg-hero-foreground/40" },
    { label: "Set aside", value: capacity.reserved, dot: "bg-purple" },
    { label: "Still due", value: capacity.due, dot: "bg-chart-5" },
    { label: "Safe to save", value: capacity.safeToSave, dot: "bg-primary" },
  ];

  return (
    <section className="surface-hero relative flex min-w-0 flex-col gap-2.5 overflow-hidden rounded-[22px] p-4 lg:col-span-5" data-testid="savings-capacity" aria-label="Safe to save now">
      <span aria-hidden className="pointer-events-none absolute -right-16 -bottom-20 size-56 rounded-full bg-primary/18 blur-3xl" />
      <div className="relative flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-[10.5px] font-semibold tracking-[0.08em] text-hero-foreground/60 uppercase">
            <Wallet className="size-3.5" /> Safe to save now
          </p>
          {planner.pictureLoading ? (
            <Skeleton className="mt-2 h-9 w-40 bg-hero-foreground/10" />
          ) : (
            <p className="mt-1 font-mono text-[38px] leading-none font-bold tracking-tight tabular-nums text-hero-foreground" data-testid="safe-to-save">
              {formatCurrency(capacity.safeToSave)}
            </p>
          )}
        </div>
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              data-testid="cap-details" aria-label="How it's worked out"
              className="inline-flex shrink-0 items-center gap-1 rounded-full bg-hero-foreground/10 px-2.5 py-1 text-[11px] font-medium text-hero-foreground/85 transition-colors hover:bg-hero-foreground/18 hover:text-hero-foreground"
            >
              <Info className="size-3" aria-hidden /> Details
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-[min(92vw,380px)] p-4">
            <CapacityBreakdown planner={planner} />
          </PopoverContent>
        </Popover>
      </div>
      <p className="relative -mt-1 text-[11.5px] text-hero-foreground/60">
        {capacity.shortBy > 0 ? (
          <span className="font-medium text-warning">Short {formatCurrency(capacity.shortBy)} for dues this cycle</span>
        ) : (
          <>
            After dues · by {shortDate(cycle.end)} · {cycle.daysLeft}d left
          </>
        )}
      </p>

      {planner.upcoming.length > 0 && (
        <ul className="relative flex flex-wrap items-center gap-1.5" aria-label="Next payments due" data-testid="cap-next-due">
          {planner.upcoming.slice(0, 2).map((u) => (
            <li key={u.key} className="inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-full bg-hero-foreground/10 px-2.5 py-1 text-[11px] text-hero-foreground/85">
              <CalendarClock className="size-3 shrink-0" aria-hidden />
              <span className="truncate">{u.title}</span>
              <span className="shrink-0 text-hero-foreground/60">{u.status === "overdue" ? "overdue" : shortDate(u.dueDate)}</span>
              <span className="shrink-0 font-mono font-semibold tabular-nums">{compact(u.amount)}</span>
            </li>
          ))}
          {planner.upcoming.length > 2 && <li className="text-[11px] text-hero-foreground/60">+{planner.upcoming.length - 2} more due</li>}
        </ul>
      )}

      {/* Where free money goes: still due → safe to save. */}
      <div className="relative mt-auto flex flex-col gap-2">
        <div className="flex h-2 overflow-hidden rounded-full bg-hero-foreground/10" role="img" aria-label="Free money split into still due and safe to save">
          <span className="h-full bg-chart-5 transition-[width] duration-700" style={{ width: seg(Math.min(capacity.due, capacity.free)) }} />
          <span className="h-full bg-primary transition-[width] duration-700" style={{ width: seg(capacity.safeToSave) }} />
          {capacity.shortBy > 0 && <span className="h-full bg-[repeating-linear-gradient(135deg,var(--warning)_0_4px,transparent_4px_8px)] opacity-70" style={{ width: seg(capacity.shortBy) }} />}
        </div>
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 sm:grid-cols-4">
          {figures.map((f) => (
            <div key={f.label} className="min-w-0">
              <dt className="flex items-center gap-1 truncate text-[10px] text-hero-foreground/55">
                <span className={cn("size-1.5 shrink-0 rounded-full", f.dot)} />
                {f.label}
              </dt>
              <dd className="truncate font-mono text-[12.5px] font-semibold tabular-nums text-hero-foreground" title={formatCurrency(f.value)}>
                {compact(f.value)}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

function PlanCard({ planner, onAllocate, allocating }: { planner: SavingsPlanner; onAllocate: () => void; allocating: boolean }) {
  const { plan, surplus, cycle } = planner;
  const ratio = plan.planned > 0 ? plan.onPlan / plan.planned : 0;
  const hasPlans = plan.planned > 0 || plan.counts.skipped > 0;
  const share = surplus && surplus.surplus > 0 ? plan.monthlyCommitment / surplus.surplus : null;
  const chips = (["done", "partial", "due", "skipped"] as const).filter((k) => plan.counts[k] > 0);

  return (
    <section className="flex min-w-0 flex-col gap-3 p-4" data-testid="savings-plan-card" aria-label="This month's plan">
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 truncate text-[10.5px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
          This month <span className="font-medium tracking-normal normal-case">· {cycle.rangeLabel}</span>
        </p>
      </div>

      {hasPlans ? (
        <div className="flex items-center gap-3.5">
          <ProgressRing value={Math.round(ratio * 100)} size={68} strokeWidth={7} color={ratio >= 1 ? "var(--success)" : "var(--primary)"}>
            <span className="text-[13px] font-bold tabular-nums text-foreground">{hasPlans ? `${Math.round(ratio * 100)}%` : "—"}</span>
          </ProgressRing>
          <div className="min-w-0 flex-1">
            <p className="font-mono text-[22px] leading-tight font-bold tabular-nums text-foreground" data-testid="plan-on-track">
              {formatCurrency(plan.onPlan)}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              of {formatCurrency(plan.planned)} planned
              {plan.savedThisCycle > plan.onPlan ? ` · ${formatCurrency(plan.savedThisCycle)} saved in all` : ""}
            </p>
            {chips.length > 0 ? (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {chips.map((k) => (
                  <span key={k} className={cn("inline-flex items-center gap-1 rounded-full px-1.5 py-px text-[10px] font-semibold", PLAN_STATUS[k].cls)}>
                    <span className={cn("size-1.5 rounded-full", PLAN_STATUS[k].dot)} />
                    {plan.counts[k]} {PLAN_STATUS[k].label.toLowerCase()}
                  </span>
                ))}
              </div>
            ) : (
              !hasPlans && <p className="mt-1 text-[11px] leading-snug text-muted-foreground">No monthly plans yet — set one in a goal&apos;s Plan &amp; lock, or use Allocate.</p>
            )}
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-3" data-testid="plan-empty">
          <span aria-hidden className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-primary/15 text-primary-accent-text">
            <CalendarClock className="size-5" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-foreground">No monthly plans yet</p>
            <p className="mt-0.5 text-[11.5px] leading-snug text-muted-foreground">Give goals a monthly amount to track them here.</p>
          </div>
        </div>
      )}

      <div className="mt-auto flex flex-col gap-2">
        {surplus ? (
          <div className="flex flex-col gap-1" data-testid="plan-vs-surplus" title={surplus.surplus <= 0 ? "Your recent cycles spent all their income." : `Average income ${formatCurrency(surplus.income)} − outflow ${formatCurrency(surplus.outflow)} over the last ${surplus.cycles} cycle${surplus.cycles === 1 ? "" : "s"}.`}>
            <p className="flex items-baseline justify-between gap-2 text-[11px] text-muted-foreground">
              <span className="truncate">
                {formatCurrency(plan.monthlyCommitment)}/mo plan · <span className="font-mono font-semibold text-foreground">{formatCurrency(surplus.surplus)}</span> usual surplus
              </span>
              {share != null && <span className={cn("shrink-0 font-semibold", share > 1 ? "text-expense" : share > 0.8 ? "text-warning-foreground dark:text-warning" : "text-success")}>{Math.round(share * 100)}%</span>}
            </p>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div className={cn("h-full rounded-full", share != null && share > 1 ? "bg-expense" : share != null && share > 0.8 ? "bg-warning" : "bg-success")} style={{ width: `${Math.min(100, (share ?? 1) * 100)}%` }} />
            </div>
          </div>
        ) : null}
        <ClayButton className="h-9 w-full gap-1.5 rounded-xl" onClick={onAllocate} data-testid="open-allocate" aria-expanded={allocating}>
          <Sparkles className="size-3.5" />
          {plan.remaining > 0 ? `Allocate ${formatCurrency(plan.remaining)}` : "Allocate this month"}
          <ArrowRight className="size-3.5" />
        </ClayButton>
      </div>
    </section>
  );
}

function SavedCard({ planner, accounts }: { planner: SavingsPlanner; accounts: Account[] }) {
  const { position, lockedByAccount } = planner;
  const { totals, reservedByAccount } = position;
  const pct = Math.round(totals.progress * 100);
  const goals = useMemo(() => [...position.open, ...position.completed].filter((v) => v.saved > 0), [position.open, position.completed]);
  const where = useMemo(() => {
    const byId = new Map(accounts.map((a) => [a.id, a]));
    return Array.from(reservedByAccount.entries())
      .map(([id, amount]) => ({ account: byId.get(id), amount }))
      .filter((r): r is { account: Account; amount: number } => r.account != null && r.amount > 0)
      .sort((a, b) => b.amount - a.amount);
  }, [reservedByAccount, accounts]);
  const lockedTotal = Array.from(lockedByAccount.values()).reduce((s, v) => s + v, 0);

  return (
    <section className="flex min-w-0 flex-col gap-2.5 p-4" data-testid="savings-summary" aria-label="Savings summary">
      <p className="text-[10.5px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">Saved</p>
      <div className="-mt-1">
        <p className="truncate font-mono text-[26px] leading-tight font-bold tracking-tight tabular-nums text-foreground" data-testid="total-saved">
          {formatCurrency(totals.saved)}
        </p>
        <p className="text-xs text-muted-foreground">
          of {formatCurrency(totals.target)} · {pct}%
        </p>
      </div>
      <div className="flex h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label="Overall savings progress" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        {goals.map((v) => (
          <span key={v.goal.id} className="h-full border-r border-card last:border-r-0" title={`${v.goal.name} ${formatCurrency(v.saved)}`} style={{ width: `${totals.target > 0 ? (Math.min(v.saved, v.target) / totals.target) * 100 : 0}%`, background: goalAccent(v) }} />
        ))}
      </div>
      <p className="text-[11px] text-muted-foreground" data-testid="saved-counts">
        <span className="font-semibold text-foreground">{totals.openCount}</span> active · <span className="font-semibold text-foreground">{totals.completedCount}</span> done
        {totals.overdueCount > 0 && (
          <>
            {" "}· <span className="font-semibold text-expense">{totals.overdueCount} overdue</span>
          </>
        )}
      </p>
      {where.length === 0 && totals.saved <= 0 && <p className="mt-auto text-[11px] leading-snug text-muted-foreground">Add money to a goal to see where it&apos;s held.</p>}
      {where.length > 0 && (
        <div className="mt-auto flex flex-col gap-1">
          <ul className="flex flex-col gap-0.5" data-testid="saved-held-in">
            {where.slice(0, 2).map(({ account, amount }) => (
              <li key={account.id} className="flex items-center justify-between gap-2 text-[11.5px]">
                <span className="flex min-w-0 items-center gap-1.5">
                  <AccountMark account={account} size={15} />
                  <span className="truncate text-foreground/85">{account.name}</span>
                  {(lockedByAccount.get(account.id) ?? 0) > 0 && <Lock className="size-3 shrink-0 text-purple" aria-label="Partly locked" />}
                </span>
                <span className="shrink-0 font-mono font-semibold tabular-nums">{formatCurrency(amount)}</span>
              </li>
            ))}
            {where.length > 2 && <li className="text-[10.5px] text-muted-foreground">+{where.length - 2} more account{where.length - 2 === 1 ? "" : "s"}</li>}
          </ul>
          {lockedTotal > 0 && (
            <p className="flex items-center gap-1 text-[10.5px] text-purple" data-testid="locked-total">
              <Lock className="size-3" /> {formatCurrency(lockedTotal)} locked in FlowFi
            </p>
          )}
        </div>
      )}
    </section>
  );
}

export function PlannerHero({
  planner,
  accounts,
  onAllocate,
  allocating,
}: {
  planner: SavingsPlanner;
  accounts: Account[];
  onAllocate: () => void;
  allocating: boolean;
}) {
  return (
    <div className="grid gap-3 lg:grid-cols-12" data-testid="savings-hero">
      <SafeToSaveCard planner={planner} />
      <div className="surface-flat grid min-w-0 overflow-hidden rounded-[22px] sm:grid-cols-[1.25fr_1fr] sm:divide-x sm:divide-border/60 lg:col-span-7">
        <PlanCard planner={planner} onAllocate={onAllocate} allocating={allocating} />
        <SavedCard planner={planner} accounts={accounts} />
      </div>
    </div>
  );
}
