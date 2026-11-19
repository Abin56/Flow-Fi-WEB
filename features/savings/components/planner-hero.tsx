"use client";

/**
 * The top of the Savings workspace — three linked cards:
 *  1. Safe to save now: free money in accounts − what is still due this cycle − an everyday-spending buffer.
 *     Already-paid commitments and received income are shown for context only (never subtracted twice, never assumed).
 *  2. This month's plan: planned vs saved this cycle, status per goal, plan vs typical surplus, and the Allocate CTA.
 *  3. Saved in goals: total, a segmented bar per goal, where the money sits and how much of it is locked.
 */

import { ArrowRight, CalendarClock, ChevronDown, Info, Lock, Pencil, RotateCcw, Sparkles, Wallet } from "lucide-react";
import { useMemo, useState } from "react";
import { ClayButton } from "@/components/clay/clay-button";
import { AccountMark } from "@/components/finance";
import { ProgressRing } from "@/components/foundation/progress-ring";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency } from "@/lib/format";
import type { Account } from "@/lib/models/account";
import { cn } from "@/lib/utils";
import type { SavingsPlanner } from "@/features/savings/hooks/use-savings-planner";
import { goalAccent } from "@/features/savings/lib/goal-style";
import { AmountInput, PLAN_STATUS } from "@/features/savings/components/savings-ui";

const KIND_LABEL = { card: "Card bills", loan: "Loans", emi: "EMIs", bill: "Bills" } as const;

function shortDate(d: Date) {
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

function Line({ label, value, sign, strong, children, testId }: { label: React.ReactNode; value: number; sign?: "−" | "="; strong?: boolean; children?: React.ReactNode; testId?: string }) {
  return (
    <div className={cn("flex items-center justify-between gap-3 py-1", strong && "border-t border-hero-foreground/15 pt-2")} data-testid={testId}>
      <span className={cn("flex min-w-0 items-center gap-1.5 text-[12.5px]", strong ? "font-semibold text-hero-foreground" : "text-hero-foreground/70")}>{label}</span>
      <span className="flex shrink-0 items-center gap-1.5">
        {children}
        <span className={cn("font-mono tabular-nums", strong ? "text-[15px] font-bold text-primary" : "text-[13px] font-semibold text-hero-foreground")}>
          {sign === "−" && value > 0 ? "−" : ""}
          {formatCurrency(value)}
        </span>
      </span>
    </div>
  );
}

function SafeToSaveCard({ planner, onBufferChange, bufferOverridden }: { planner: SavingsPlanner; onBufferChange: (v: number | null) => void; bufferOverridden: boolean }) {
  const { capacity, due, upcoming, cycle } = planner;
  const [showDue, setShowDue] = useState(false);
  const [editBuffer, setEditBuffer] = useState(false);
  const [bufferText, setBufferText] = useState("");

  const total = Math.max(capacity.free, capacity.due + capacity.buffer, 1);
  const seg = (v: number) => `${(Math.max(0, v) / total) * 100}%`;
  const dueKinds = (["emi", "loan", "card", "bill"] as const).filter((k) => due[k] > 0);

  return (
    <section className="surface-hero relative flex min-w-0 flex-col gap-3 overflow-hidden rounded-[26px] p-5 lg:col-span-5" data-testid="savings-capacity" aria-label="Safe to save now">
      <span aria-hidden className="pointer-events-none absolute -right-20 -bottom-24 size-72 rounded-full bg-primary/20 blur-3xl" />
      <div className="relative flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-[11px] font-semibold tracking-[0.08em] text-hero-foreground/60 uppercase">
            <Wallet className="size-3.5" /> Safe to save now
          </p>
          {planner.pictureLoading ? (
            <Skeleton className="mt-2 h-10 w-44 bg-hero-foreground/10" />
          ) : (
            <p className="mt-1 font-mono text-[38px] leading-none font-bold tracking-tight tabular-nums text-hero-foreground" data-testid="safe-to-save">
              {formatCurrency(capacity.safeToSave)}
            </p>
          )}
          <p className="mt-1.5 text-[11.5px] text-hero-foreground/60">
            {capacity.shortBy > 0 ? (
              <span className="font-medium text-warning">Short by {formatCurrency(capacity.shortBy)} for what&apos;s still due this cycle.</span>
            ) : (
              <>After everything due by {shortDate(cycle.end)} · {cycle.daysLeft} day{cycle.daysLeft === 1 ? "" : "s"} left</>
            )}
          </p>
        </div>
      </div>

      {/* Where free money goes: due → buffer → safe to save. */}
      <div className="relative">
        <div className="flex h-2.5 overflow-hidden rounded-full bg-hero-foreground/10" role="img" aria-label="Free money split into still due, spending buffer and safe to save">
          <span className="h-full bg-chart-5 transition-[width] duration-700" style={{ width: seg(Math.min(capacity.due, capacity.free)) }} />
          <span className="h-full bg-warning transition-[width] duration-700" style={{ width: seg(Math.min(capacity.buffer, Math.max(0, capacity.free - capacity.due))) }} />
          <span className="h-full bg-primary transition-[width] duration-700" style={{ width: seg(capacity.safeToSave) }} />
          {capacity.shortBy > 0 && <span className="h-full bg-[repeating-linear-gradient(135deg,var(--warning)_0_4px,transparent_4px_8px)] opacity-70" style={{ width: seg(capacity.shortBy) }} />}
        </div>
        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[10.5px] text-hero-foreground/60">
          <span className="flex items-center gap-1"><span className="size-2 rounded-full bg-chart-5" /> Still due</span>
          <span className="flex items-center gap-1"><span className="size-2 rounded-full bg-warning" /> Spending buffer</span>
          <span className="flex items-center gap-1"><span className="size-2 rounded-full bg-primary" /> Safe to save</span>
        </div>
      </div>

      <div className="relative flex flex-col">
        <Line label="In your accounts" value={capacity.inAccounts} testId="cap-in-accounts" />
        <Line label="Already set aside for goals" value={capacity.reserved} sign="−" testId="cap-reserved" />
        <Line
          testId="cap-due"
          label={
            <button type="button" className="flex items-center gap-1 text-left hover:text-hero-foreground" onClick={() => setShowDue((v) => !v)} aria-expanded={showDue}>
              Still due this cycle{due.count > 0 ? ` · ${due.count}` : ""}
              <ChevronDown className={cn("size-3 transition-transform", showDue && "rotate-180")} />
            </button>
          }
          value={capacity.due}
          sign="−"
        />
        {showDue && (
          <div className="mb-1 flex flex-col gap-1 rounded-xl bg-hero-foreground/6 p-2" data-testid="cap-due-list">
            {upcoming.length === 0 ? (
              <p className="text-[11px] text-hero-foreground/60">Nothing left to pay this cycle.</p>
            ) : (
              <>
                {dueKinds.length > 0 && (
                  <p className="flex flex-wrap gap-x-2.5 text-[10.5px] text-hero-foreground/55">
                    {dueKinds.map((k) => (
                      <span key={k}>
                        {KIND_LABEL[k]} {formatCurrency(due[k])}
                      </span>
                    ))}
                    {due.overdue > 0 && <span className="text-warning">incl. overdue {formatCurrency(due.overdue)}</span>}
                  </p>
                )}
                {upcoming.map((u) => (
                  <a key={u.key} href={u.href} className="flex items-center justify-between gap-2 rounded-lg px-1.5 py-1 text-[11.5px] hover:bg-hero-foreground/8">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <CalendarClock className={cn("size-3 shrink-0", u.status === "overdue" ? "text-warning" : "text-hero-foreground/50")} />
                      <span className="truncate text-hero-foreground/85">{u.title}</span>
                      <span className="shrink-0 text-hero-foreground/45">{u.status === "overdue" ? "overdue" : shortDate(u.dueDate)}</span>
                    </span>
                    <span className="shrink-0 font-mono font-semibold tabular-nums text-hero-foreground">{formatCurrency(u.amount)}</span>
                  </a>
                ))}
              </>
            )}
          </div>
        )}
        <Line
          testId="cap-buffer"
          label={
            <span className="flex items-center gap-1">
              Everyday spending till {shortDate(cycle.end)}
              {planner.typicalSpend != null && !editBuffer && <span className="hidden text-hero-foreground/40 sm:inline">· usual {formatCurrency(planner.typicalSpend)}/mo</span>}
            </span>
          }
          value={capacity.buffer}
          sign="−"
        >
          {editBuffer ? (
            <span className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
              <AmountInput value={bufferText} onChange={setBufferText} ariaLabel="Everyday spending buffer" size="sm" className="w-28 [&_input]:h-7 [&_input]:bg-hero-foreground/10 [&_input]:text-hero-foreground" autoFocus />
              <button
                type="button"
                className="rounded-lg bg-primary px-2 py-1 text-[11px] font-semibold text-primary-foreground"
                onClick={() => {
                  const n = Number(bufferText);
                  if (bufferText.trim() !== "" && Number.isFinite(n) && n >= 0) onBufferChange(n);
                  setEditBuffer(false);
                }}
              >
                Set
              </button>
            </span>
          ) : (
            <>
              {bufferOverridden && (
                <button type="button" title="Back to the estimate" aria-label="Reset spending buffer" className="rounded-md p-0.5 text-hero-foreground/50 hover:text-hero-foreground" onClick={() => onBufferChange(null)}>
                  <RotateCcw className="size-3" />
                </button>
              )}
              <button
                type="button"
                aria-label="Edit spending buffer"
                className="rounded-md p-0.5 text-hero-foreground/50 hover:text-hero-foreground"
                onClick={() => {
                  setBufferText(String(Math.round(capacity.buffer)));
                  setEditBuffer(true);
                }}
              >
                <Pencil className="size-3" />
              </button>
            </>
          )}
        </Line>
        <Line label="Safe to save now" value={capacity.safeToSave} sign="=" strong />
      </div>

      <div className="relative mt-auto grid grid-cols-3 gap-2 rounded-2xl bg-hero-foreground/6 p-2.5 text-center" data-testid="cap-this-cycle">
        <div className="min-w-0">
          <p className="truncate text-[10px] text-hero-foreground/55">Income received</p>
          <p className="truncate font-mono text-[13px] font-semibold tabular-nums text-success">{planner.incomeThisCycle == null ? "…" : formatCurrency(planner.incomeThisCycle)}</p>
        </div>
        <div className="min-w-0">
          <p className="truncate text-[10px] text-hero-foreground/55">Commitments paid</p>
          <p className="truncate font-mono text-[13px] font-semibold tabular-nums text-hero-foreground">{formatCurrency(planner.paidThisCycle)}</p>
        </div>
        <div className="min-w-0">
          <p className="truncate text-[10px] text-hero-foreground/55">Spent (my share)</p>
          <p className="truncate font-mono text-[13px] font-semibold tabular-nums text-hero-foreground">{formatCurrency(planner.spentThisCycle)}</p>
        </div>
      </div>
      <p className="relative -mt-1 flex items-start gap-1 text-[10.5px] leading-snug text-hero-foreground/45">
        <Info className="mt-px size-3 shrink-0" /> Paid commitments already left your balances, so they aren&apos;t subtracted again. Income that hasn&apos;t arrived is never assumed.
      </p>
    </section>
  );
}

function PlanCard({ planner, onAllocate, allocating }: { planner: SavingsPlanner; onAllocate: () => void; allocating: boolean }) {
  const { plan, surplus, cycle, position } = planner;
  const ratio = plan.planned > 0 ? plan.onPlan / plan.planned : 0;
  const hasPlans = plan.planned > 0 || plan.counts.skipped > 0;
  const share = surplus && surplus.surplus > 0 ? plan.monthlyCommitment / surplus.surplus : null;
  const chips = (["done", "partial", "due", "skipped"] as const).filter((k) => plan.counts[k] > 0);

  return (
    <section className="surface-flat flex min-w-0 flex-col gap-3 rounded-[26px] p-5 lg:col-span-4" data-testid="savings-plan-card" aria-label="This month's plan">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">This month&apos;s plan</p>
          <p className="truncate text-xs text-muted-foreground">{cycle.rangeLabel}</p>
        </div>
        <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10.5px] font-semibold text-muted-foreground">{cycle.daysLeft}d left</span>
      </div>

      <div className="flex items-center gap-4">
        <ProgressRing value={Math.round(ratio * 100)} size={84} strokeWidth={8} color={ratio >= 1 ? "var(--success)" : "var(--primary)"}>
          <span className="text-base font-bold tabular-nums text-foreground">{hasPlans ? `${Math.round(ratio * 100)}%` : "—"}</span>
        </ProgressRing>
        <div className="min-w-0 flex-1">
          <p className="font-mono text-2xl leading-tight font-bold tabular-nums text-foreground" data-testid="plan-on-track">
            {formatCurrency(plan.onPlan)}
          </p>
          <p className="text-xs text-muted-foreground">
            of {formatCurrency(plan.planned)} planned
            {plan.savedThisCycle > plan.onPlan ? ` · ${formatCurrency(plan.savedThisCycle)} saved in all` : ""}
          </p>
          {chips.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {chips.map((k) => (
                <span key={k} className={cn("inline-flex items-center gap-1 rounded-full px-1.5 py-px text-[10px] font-semibold", PLAN_STATUS[k].cls)}>
                  <span className={cn("size-1.5 rounded-full", PLAN_STATUS[k].dot)} />
                  {plan.counts[k]} {PLAN_STATUS[k].label.toLowerCase()}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {hasPlans ? (
        <div className="flex flex-col gap-1.5" data-testid="plan-goal-list">
          {plan.goals
            .filter((g) => g.status !== "none")
            .slice(0, 4)
            .map((g) => {
              const v = position.open.find((x) => x.goal.id === g.goalId);
              if (!v) return null;
              const accent = goalAccent(v);
              return (
                <div key={g.goalId} className="flex items-center gap-2 text-[11.5px]">
                  <span className="size-2 shrink-0 rounded-full" style={{ background: accent }} />
                  <span className="min-w-0 flex-1 truncate text-foreground/85">{v.goal.name}</span>
                  <span className="shrink-0 font-mono tabular-nums text-muted-foreground">
                    {formatCurrency(Math.min(g.contributed, g.target || g.contributed))}/{formatCurrency(g.target || v.goal.monthlyTarget || 0)}
                  </span>
                  <span className={cn("size-1.5 shrink-0 rounded-full", PLAN_STATUS[g.status].dot)} title={PLAN_STATUS[g.status].label} />
                </div>
              );
            })}
        </div>
      ) : (
        <p className="rounded-2xl bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground">
          No monthly plans yet. Give a goal a monthly amount (Plan & lock), or split this month&apos;s money with <span className="font-semibold text-foreground">Allocate</span>.
        </p>
      )}

      <div className="mt-auto flex flex-col gap-2">
        {surplus ? (
          <div className="flex flex-col gap-1" data-testid="plan-vs-surplus">
            <p className="flex items-baseline justify-between gap-2 text-[11px] text-muted-foreground">
              <span>
                Plan {formatCurrency(plan.monthlyCommitment)}/mo vs usual surplus <span className="font-mono font-semibold text-foreground">{formatCurrency(surplus.surplus)}</span>
              </span>
              {share != null && <span className={cn("font-semibold", share > 1 ? "text-expense" : share > 0.8 ? "text-warning-foreground dark:text-warning" : "text-success")}>{Math.round(share * 100)}%</span>}
            </p>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div className={cn("h-full rounded-full", share != null && share > 1 ? "bg-expense" : share != null && share > 0.8 ? "bg-warning" : "bg-success")} style={{ width: `${Math.min(100, (share ?? 1) * 100)}%` }} />
            </div>
            <p className="text-[10px] text-muted-foreground">
              {surplus.surplus <= 0 ? "Your recent cycles spent all their income — plans may be hard to keep." : `Average income ${formatCurrency(surplus.income)} − outflow ${formatCurrency(surplus.outflow)} over the last ${surplus.cycles} cycle${surplus.cycles === 1 ? "" : "s"}.`}
            </p>
          </div>
        ) : (
          <p className="text-[10.5px] text-muted-foreground">Once a full cycle with income is recorded, your plan is compared with your usual surplus.</p>
        )}
        <ClayButton className="h-10 w-full gap-1.5 rounded-2xl" onClick={onAllocate} data-testid="open-allocate" aria-expanded={allocating}>
          <Sparkles className="size-4" />
          {allocating ? "Close allocation" : plan.remaining > 0 ? `Allocate ${formatCurrency(plan.remaining)} for this month` : "Allocate this month"}
          {!allocating && <ArrowRight className="size-4" />}
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
    <section className="surface-flat flex min-w-0 flex-col gap-3 rounded-[26px] p-5 lg:col-span-3" data-testid="savings-summary" aria-label="Savings summary">
      <div>
        <p className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">Saved in goals</p>
        <p className="mt-1 truncate font-mono text-[28px] leading-tight font-bold tracking-tight tabular-nums text-foreground" data-testid="total-saved">
          {formatCurrency(totals.saved)}
        </p>
        <p className="text-xs text-muted-foreground">
          of {formatCurrency(totals.target)} · {pct}%
        </p>
      </div>
      <div className="flex h-2.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label="Overall savings progress" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        {goals.map((v) => (
          <span key={v.goal.id} className="h-full border-r border-card last:border-r-0" title={`${v.goal.name} ${formatCurrency(v.saved)}`} style={{ width: `${totals.target > 0 ? (Math.min(v.saved, v.target) / totals.target) * 100 : 0}%`, background: goalAccent(v) }} />
        ))}
      </div>
      <div className="grid grid-cols-3 gap-1.5 text-center">
        {[
          ["Active", totals.openCount],
          ["Done", totals.completedCount],
          ["Overdue", totals.overdueCount],
        ].map(([l, n]) => (
          <div key={l as string} className="rounded-xl bg-muted/40 py-1.5">
            <p className="font-mono text-sm font-bold tabular-nums text-foreground">{n}</p>
            <p className="text-[10px] text-muted-foreground">{l}</p>
          </div>
        ))}
      </div>
      {where.length > 0 && (
        <div className="mt-auto flex flex-col gap-1.5">
          <p className="text-[10.5px] font-semibold tracking-wide text-muted-foreground uppercase">Held in</p>
          <ul className="flex flex-col gap-1">
            {where.slice(0, 3).map(({ account, amount }) => (
              <li key={account.id} className="flex items-center justify-between gap-2 text-xs">
                <span className="flex min-w-0 items-center gap-1.5">
                  <AccountMark account={account} size={16} />
                  <span className="truncate text-foreground/85">{account.name}</span>
                  {(lockedByAccount.get(account.id) ?? 0) > 0 && <Lock className="size-3 shrink-0 text-purple" aria-label="Partly locked" />}
                </span>
                <span className="shrink-0 font-mono font-semibold tabular-nums">{formatCurrency(amount)}</span>
              </li>
            ))}
            {where.length > 3 && <li className="text-[10.5px] text-muted-foreground">+{where.length - 3} more</li>}
          </ul>
          {lockedTotal > 0 && (
            <p className="flex items-center gap-1 text-[10.5px] text-purple" data-testid="locked-total">
              <Lock className="size-3" /> {formatCurrency(lockedTotal)} locked in FlowFi (not at the bank)
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
  onBufferChange,
  bufferOverridden,
}: {
  planner: SavingsPlanner;
  accounts: Account[];
  onAllocate: () => void;
  allocating: boolean;
  onBufferChange: (v: number | null) => void;
  bufferOverridden: boolean;
}) {
  return (
    <div className="grid gap-3 lg:grid-cols-12" data-testid="savings-hero">
      <SafeToSaveCard planner={planner} onBufferChange={onBufferChange} bufferOverridden={bufferOverridden} />
      <PlanCard planner={planner} onAllocate={onAllocate} allocating={allocating} />
      <SavedCard planner={planner} accounts={accounts} />
    </div>
  );
}
