"use client";

/**
 * The Savings overview screen — answers "where do I stand this month?" and "what should I do next?":
 *  money picture (safe to save · this month · saved) → active goals (top few) · what needs attention · what is due soon.
 * Presentation only: every figure comes from `useSavingsPlanner` / the shared engines.
 */

import { AlertTriangle, ArrowRight, CalendarClock, CheckCircle2, Info, PiggyBank, Plus } from "lucide-react";
import { useMemo } from "react";
import Link from "next/link";
import { ClayButton } from "@/components/clay/clay-button";
import { formatCurrency } from "@/lib/format";
import type { GoalView, SavingsInsight } from "@/lib/engines/savings-goals";
import type { GoalCyclePlan } from "@/lib/engines/savings-plan";
import type { Account } from "@/lib/models/account";
import type { SavingsGoalKind } from "@/lib/models/savings-goal";
import { cn } from "@/lib/utils";
import type { SavingsPlanner } from "@/features/savings/hooks/use-savings-planner";
import { renderGoalIcon } from "@/features/savings/lib/goal-style";
import { PlannerHero } from "@/features/savings/components/planner-hero";
import { GoalTile } from "@/features/savings/components/goal-tile";
import { GOAL_TEMPLATES } from "@/features/savings/components/goal-editor";

const INSIGHT_STYLE: Record<SavingsInsight["tone"], { icon: typeof Info; cls: string }> = {
  good: { icon: CheckCircle2, cls: "text-success" },
  warn: { icon: AlertTriangle, cls: "text-warning-foreground dark:text-warning" },
  bad: { icon: AlertTriangle, cls: "text-expense" },
  info: { icon: Info, cls: "text-muted-foreground" },
};

/** How many goals the overview shows; the rest live under Goals. */
const TOP_GOALS = 6;

/**
 * Which goals need the user first — display order only (no figure changes):
 * overdue → this month's plan still open (due / partly saved / missed) → behind its pace → everything else,
 * then the nearest deadline, then the furthest along.
 */
function needsYouRank(v: GoalView, plan: GoalCyclePlan | undefined): number {
  if (v.status === "overdue") return 0;
  if (plan && (plan.status === "due" || plan.status === "partial" || plan.status === "missed")) return 1;
  if (v.pace === "behind") return 2;
  return 3;
}

function shortDate(d: Date) {
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

function Panel({ title, action, children, className }: { title: string; action?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("surface-flat flex min-w-0 flex-col gap-2.5 rounded-[20px] p-4", className)} aria-label={title}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function SavingsOverview({
  planner,
  accounts,
  onAllocate,
  planByGoal,
  onOpenGoal,
  onQuickAdd,
  onSeeGoals,
  onNewGoal,
}: {
  planner: SavingsPlanner;
  accounts: Account[];
  onAllocate: () => void;
  planByGoal: ReadonlyMap<string, GoalCyclePlan>;
  onOpenGoal: (v: GoalView) => void;
  onQuickAdd: (v: GoalView) => void;
  onSeeGoals: () => void;
  onNewGoal: (preset?: { name: string; icon: string; kind?: SavingsGoalKind; target?: number } | null) => void;
}) {
  const { position, upcoming } = planner;
  const hasAny = position.views.length > 0;
  const ordered = useMemo(
    () =>
      [...position.open].sort(
        (a, b) =>
          needsYouRank(a, planByGoal.get(a.goal.id)) - needsYouRank(b, planByGoal.get(b.goal.id)) ||
          (a.daysLeft == null ? 1 : 0) - (b.daysLeft == null ? 1 : 0) ||
          (a.daysLeft ?? 0) - (b.daysLeft ?? 0) ||
          b.progress - a.progress,
      ),
    [position.open, planByGoal],
  );
  const top = ordered.slice(0, TOP_GOALS);
  const more = position.open.length - top.length;
  // One or two goals get the roomier featured card; three or more use the compact grid.
  const featured = top.length > 0 && top.length <= 2;

  const hero = <PlannerHero planner={planner} accounts={accounts} allocating={false} onAllocate={onAllocate} />;

  if (!hasAny) {
    return (
      <div className="flex flex-col gap-4">
        {hero}
        <div className="surface-flat flex flex-col items-center gap-4 rounded-[22px] px-6 py-8 text-center" data-testid="savings-empty">
          <span className="flex size-12 items-center justify-center rounded-2xl bg-primary/18 text-primary-accent-text">
            <PiggyBank className="size-6" />
          </span>
          <div>
            <p className="text-lg font-semibold text-foreground">Start your first goal</p>
            <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">Name it, set a target, save a little every month.</p>
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            {GOAL_TEMPLATES.map((t) => (
              <button key={t.name} type="button" className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/30 px-3 py-1.5 text-xs font-medium text-foreground/80 transition-colors hover:border-primary hover:text-foreground" onClick={() => onNewGoal(t)}>
                {renderGoalIcon(t.icon, "size-3.5")}
                {t.name}
              </button>
            ))}
          </div>
          <ClayButton size="sm" className="gap-1.5" onClick={() => onNewGoal(null)}>
            <Plus className="size-3.5" /> Create a goal
          </ClayButton>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {hero}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
        <section className="flex min-w-0 flex-col gap-3" aria-label="Active goals">
          <div className="flex items-center justify-between gap-2 px-0.5">
            <h2 className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
              Active goals{position.open.length > 0 ? ` · ${position.open.length}` : ""}
              {position.open.length > 1 && <span className="ml-2 font-medium tracking-normal text-muted-foreground/70 normal-case">needs you first</span>}
            </h2>
            <button type="button" onClick={onSeeGoals} className="inline-flex items-center gap-1 text-xs font-semibold text-primary-accent-text hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none" data-testid="see-all-goals">
              All goals <ArrowRight className="size-3.5" />
            </button>
          </div>
          <div className={featured ? "grid grid-cols-1 gap-3 xl:grid-cols-2" : "grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-3"} data-testid="savings-overview-goals">
            {top.map((v) => (
              <GoalTile key={v.goal.id} view={v} plan={planByGoal.get(v.goal.id) ?? null} selected={false} onOpen={() => onOpenGoal(v)} onQuickAdd={() => onQuickAdd(v)} showAdd layout={featured ? "feature" : "card"} />
            ))}
            {more > 0 ? (
              <button
                type="button"
                onClick={onSeeGoals}
                className="group flex min-h-[10.5rem] flex-col items-center justify-center gap-1.5 rounded-[20px] border-2 border-dashed border-border/70 p-4 text-sm text-muted-foreground transition-colors hover:border-primary hover:bg-primary/5 hover:text-foreground"
              >
                <span className="font-mono text-2xl font-bold text-foreground">+{more}</span>
                <span className="inline-flex items-center gap-1 font-semibold">
                  More goals <ArrowRight className="size-3.5" />
                </span>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => onNewGoal(null)}
                className={cn(
                  "group flex items-center justify-center gap-1.5 rounded-[20px] border-2 border-dashed border-border/70 text-sm text-muted-foreground transition-colors hover:border-primary hover:bg-primary/5 hover:text-foreground",
                  top.length === 2 ? "min-h-14 flex-row gap-2.5 p-3 xl:col-span-2" : "min-h-[10.5rem] flex-col p-4",
                )}
                data-testid="new-goal-tile"
              >
                <span className="flex size-9 items-center justify-center rounded-xl bg-muted transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
                  <Plus className="size-4" />
                </span>
                <span className="font-semibold">New goal or fund</span>
              </button>
            )}
          </div>
          {position.open.length === 0 && <p className="rounded-xl bg-muted/40 px-3 py-3 text-center text-sm text-muted-foreground">No active goals — completed ones are under Goals.</p>}
        </section>

        <div className="flex min-w-0 flex-col gap-4">
          <Panel title="Needs attention">
            {position.insights.length === 0 ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="savings-insights">
                <CheckCircle2 className="size-4 shrink-0 text-success" /> Everything is on track.
              </p>
            ) : (
              <ul className="flex flex-col gap-2" data-testid="savings-insights">
                {position.insights.map((i) => {
                  const { icon: Icon, cls } = INSIGHT_STYLE[i.tone];
                  return (
                    <li key={i.id} className="flex items-start gap-2 text-[13px] leading-snug text-foreground/90">
                      <Icon className={cn("mt-0.5 size-4 shrink-0", cls)} />
                      <span>{i.text}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>

          <Panel title="Due this cycle" action={<span className="text-xs font-semibold text-muted-foreground tabular-nums">{formatCurrency(planner.due.total)}</span>}>
            {upcoming.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing left to pay.</p>
            ) : (
              <ul className="flex flex-col" data-testid="savings-due-list">
                {upcoming.slice(0, 4).map((u) => (
                  <li key={u.key}>
                    <Link href={u.href} className="flex items-center gap-2 rounded-lg px-1.5 py-1.5 text-[13px] transition-colors hover:bg-muted/60">
                      <CalendarClock className={cn("size-3.5 shrink-0", u.status === "overdue" ? "text-expense" : "text-muted-foreground")} aria-hidden />
                      <span className="min-w-0 flex-1 truncate text-foreground/90">{u.title}</span>
                      <span className={cn("shrink-0 text-[11px]", u.status === "overdue" ? "font-semibold text-expense" : "text-muted-foreground")}>{u.status === "overdue" ? "overdue" : shortDate(u.dueDate)}</span>
                      <span className="shrink-0 font-mono text-xs font-semibold tabular-nums">{formatCurrency(u.amount)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}
