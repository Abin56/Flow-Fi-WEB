"use client";

/**
 * A goal at a glance, in two layouts that show the same facts and offer the same actions:
 *  - "card": identity · progress ring + saved / to go · this month's plan status + the one repeated action (Add).
 *  - "row": one scannable line per goal (identity · progress bar · saved of target · plan status · Add) — built for
 *    many goals, so the page doesn't turn into a long scroll of cards.
 * Selecting the goal opens its details in the side sheet.
 */

import { ArrowRight, CalendarDays, Landmark, Lock, LockOpen, Plus } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import { ProgressRing } from "@/components/foundation/progress-ring";
import { formatCurrency } from "@/lib/format";
import { lockState, type GoalCyclePlan } from "@/lib/engines/savings-plan";
import type { GoalView } from "@/lib/engines/savings-goals";
import type { Account } from "@/lib/models/account";
import { cn } from "@/lib/utils";
import { dueLabel, formatShortDate, goalAccent, paceLine, renderGoalIcon, TONE_TEXT } from "@/features/savings/lib/goal-style";
import { Meter, PLAN_STATUS } from "@/features/savings/components/savings-ui";

export type GoalLayout = "card" | "row";
/** "feature" = the roomier card the Overview uses when there are only one or two goals. */
export type GoalTileLayout = GoalLayout | "feature";

export function GoalTile({
  view,
  plan,
  selected,
  onOpen,
  onQuickAdd,
  showAdd,
  layout = "card",
}: {
  view: GoalView;
  plan: GoalCyclePlan | null;
  /** Kept for callers that still pass the account map; the tile no longer lists accounts. */
  accountsById?: Map<string, Account>;
  selected: boolean;
  onOpen: () => void;
  onQuickAdd: () => void;
  showAdd: boolean;
  layout?: GoalTileLayout;
}) {
  const accent = goalAccent(view);
  const pct = Math.round(view.progress * 100);
  const due = dueLabel(view);
  const pace = paceLine(view);
  const done = view.status === "completed";
  const tone = done ? "var(--success)" : accent;
  const lock = lockState(view, new Date());
  const hasPlan = plan != null && plan.status !== "none";
  const planStatus = hasPlan && plan ? PLAN_STATUS[plan.status] : null;

  const onKey = (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onOpen();
    }
  };

  const iconTile = (size: string, icon: string) => (
    <span className={cn("flex shrink-0 items-center justify-center rounded-xl transition-transform duration-200 group-hover:scale-105", size)} style={{ background: `color-mix(in oklab, ${accent} 20%, transparent)`, color: accent }}>
      {renderGoalIcon(view.goal.icon, icon)}
    </span>
  );

  const fundChip =
    view.goal.kind === "deposit" ? (
      <span className="inline-flex shrink-0 items-center gap-0.5 rounded-md bg-muted px-1 py-px text-[9.5px] font-semibold text-muted-foreground" title="Deposit-style fund">
        <Landmark className="size-2.5" /> Fund
      </span>
    ) : null;

  const lockChip = lock.active ? (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-purple/15 px-1.5 py-0.5 text-[10px] font-semibold text-purple" title={`Locked${lock.until ? ` until ${formatShortDate(lock.until)}` : ""} — a FlowFi reservation`} data-testid="goal-locked">
      <Lock className="size-3" />
      {lock.until ? lock.until.toLocaleDateString("en-IN", { month: "short", year: "2-digit" }) : "Locked"}
    </span>
  ) : lock.matured ? (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-success/15 px-1.5 py-0.5 text-[10px] font-semibold text-success" title="The lock has ended — the money is available">
      <LockOpen className="size-3" /> Available
    </span>
  ) : null;

  /** This month's plan status, or the pace line when there is no plan. */
  const planLine: ReactNode =
    hasPlan && plan && planStatus ? (
      <p className="flex items-center gap-1.5 truncate" data-plan-status={plan.status}>
        <span className={cn("size-1.5 shrink-0 rounded-full", planStatus.dot)} />
        <span className="font-medium text-foreground/85">{planStatus.label}</span>
        <span className="truncate">{plan.status === "skipped" ? "· this month" : `· ${formatCurrency(Math.min(plan.contributed, plan.target || plan.contributed))}/${formatCurrency(plan.target || view.goal.monthlyTarget || 0)}`}</span>
      </p>
    ) : (
      <p className={cn("truncate font-medium", TONE_TEXT[pace.tone])}>{done ? "Goal reached 🎉" : view.goal.monthlyTarget == null ? `${pace.text} · no plan` : pace.text}</p>
    );

  const addButton = showAdd ? (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onQuickAdd();
      }}
      aria-label={`Add money to ${view.goal.name}`}
      className="inline-flex h-7 shrink-0 items-center gap-1 rounded-lg bg-primary px-2.5 text-xs font-semibold text-primary-foreground shadow-sm transition-[transform,filter] hover:brightness-105 active:scale-95"
    >
      <Plus className="size-3.5" /> Add
    </button>
  ) : null;

  const shared = {
    "data-testid": "savings-goal-card",
    "data-goal-name": view.goal.name,
    "data-expanded": selected || undefined,
    role: "button" as const,
    tabIndex: 0,
    "aria-label": `${view.goal.name} — ${pct}% saved`,
    "aria-haspopup": "dialog" as const,
    onClick: onOpen,
    onKeyDown: onKey,
    style: { ["--goal-accent" as string]: accent },
  };

  if (layout === "row") {
    return (
      <article
        {...shared}
        className={cn(
          "group surface-flat relative grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 overflow-hidden rounded-2xl py-2.5 pr-3.5 pl-4 text-left outline-none transition-[box-shadow,background-color] duration-200 focus-visible:ring-2 focus-visible:ring-ring md:grid-cols-[minmax(11rem,1.2fr)_minmax(7rem,1fr)_8.5rem_auto] xl:grid-cols-[minmax(12rem,1.1fr)_minmax(8rem,1fr)_8.5rem_minmax(10rem,1fr)_auto]",
          selected ? "shadow-[0_0_0_2px_var(--goal-accent)]" : "hover:bg-muted/30 hover:shadow-md",
        )}
      >
        <span aria-hidden className="absolute inset-y-0 left-0 w-1" style={{ background: tone }} />
        <div className="flex min-w-0 items-center gap-3">
          {iconTile("size-9", "size-[18px]")}
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <h3 className="truncate text-sm font-semibold text-foreground">{view.goal.name}</h3>
              {fundChip}
              {lockChip}
            </div>
            <p className={cn("flex items-center gap-1 truncate text-[11.5px]", TONE_TEXT[due.tone])}>
              <CalendarDays className="size-3 shrink-0 opacity-70" />
              {due.text}
            </p>
          </div>
        </div>

        <div className="hidden min-w-0 items-center gap-2 md:flex">
          <Meter value={view.progress} color={tone} label={`${view.goal.name} progress`} className="h-2 flex-1" />
          <span className="w-9 shrink-0 text-right font-mono text-xs font-bold tabular-nums" style={{ color: tone }}>
            {pct}%
          </span>
        </div>

        <p className="hidden text-right md:block">
          <span className="block font-mono text-[15px] leading-tight font-bold tracking-tight tabular-nums text-foreground" data-testid="goal-saved">
            {formatCurrency(view.saved)}
          </span>
          <span className="block text-[11px] text-muted-foreground">of {formatCurrency(view.target)}</span>
        </p>

        <div className="hidden min-w-0 text-[11.5px] text-muted-foreground xl:block" data-testid="goal-plan-row">
          {planLine}
        </div>

        <div className="flex items-center justify-end gap-3">
          {/* Below md the amounts fold into the end of the row. */}
          <p className="text-right md:hidden">
            <span className="block font-mono text-sm font-bold tabular-nums text-foreground">{formatCurrency(view.saved)}</span>
            <span className="block text-[10.5px] text-muted-foreground">{pct}% of {formatCurrency(view.target)}</span>
          </p>
          {addButton}
        </div>
      </article>
    );
  }

  if (layout === "feature") {
    const stats = [
      { label: "Needed / mo", value: !done && view.requiredPerMonth != null ? formatCurrency(view.requiredPerMonth) : "—" },
      { label: "Your pace / mo", value: view.pacePerMonth > 0 ? formatCurrency(view.pacePerMonth) : "—" },
      { label: "Finish by", value: view.projectedDate ? formatShortDate(view.projectedDate) : "—" },
    ];
    return (
      <article
        {...shared}
        className={cn(
          "group surface-flat relative flex cursor-pointer flex-col overflow-hidden rounded-[22px] text-left outline-none transition-[transform,box-shadow] duration-200 focus-visible:ring-2 focus-visible:ring-ring",
          selected ? "shadow-[0_0_0_2px_var(--goal-accent)]" : "hover:-translate-y-0.5 hover:shadow-md",
        )}
      >
        <span aria-hidden className="absolute inset-x-0 top-0 h-1" style={{ background: tone }} />
        <div className="flex flex-1 flex-col gap-4 px-5 pt-6 pb-4">
          <div className="flex items-start gap-3">
            {iconTile("size-11", "size-5")}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <h3 className="truncate text-base font-semibold text-foreground">{view.goal.name}</h3>
                {fundChip}
              </div>
              <p className={cn("flex items-center gap-1 truncate text-xs", TONE_TEXT[due.tone])}>
                <CalendarDays className="size-3 shrink-0 opacity-70" />
                {due.text}
              </p>
            </div>
            {lockChip}
          </div>

          <div className="flex items-center gap-5">
            <span role="progressbar" aria-label={`${view.goal.name} progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="shrink-0">
              <ProgressRing value={pct} size={92} strokeWidth={8} color={tone}>
                <span className="font-mono text-lg font-bold tabular-nums text-foreground">{pct}%</span>
              </ProgressRing>
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate font-mono text-[30px] leading-none font-bold tracking-tight tabular-nums text-foreground" data-testid="goal-saved">
                {formatCurrency(view.saved)}
              </p>
              <p className="mt-1 truncate text-xs text-muted-foreground">
                of {formatCurrency(view.target)}
                {!done && view.remaining > 0 && (
                  <>
                    {" "}· <span className="font-semibold text-foreground/80">{formatCurrency(view.remaining)}</span> to go
                  </>
                )}
              </p>
              <dl className="mt-3 grid grid-cols-3 gap-x-3 border-t border-border/50 pt-2.5">
                {stats.map((s) => (
                  <div key={s.label} className="min-w-0">
                    <dt className="truncate text-[10.5px] font-medium text-muted-foreground">{s.label}</dt>
                    <dd className="truncate font-mono text-[13px] font-semibold tabular-nums text-foreground">{s.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border/50 bg-muted/25 px-5 py-2.5" data-testid="goal-plan-row">
          <div className="min-w-0 flex-1 text-xs text-muted-foreground">{planLine}</div>
          <span className="hidden items-center gap-1 text-xs font-semibold text-muted-foreground transition-colors group-hover:text-foreground sm:inline-flex">
            Open <ArrowRight className="size-3.5" />
          </span>
          {addButton}
        </div>
      </article>
    );
  }

  return (
    <article
      {...shared}
      className={cn(
        "group surface-flat relative flex cursor-pointer flex-col overflow-hidden rounded-[20px] text-left outline-none transition-[transform,box-shadow] duration-200 focus-visible:ring-2 focus-visible:ring-ring",
        selected ? "shadow-[0_0_0_2px_var(--goal-accent)]" : "hover:-translate-y-0.5 hover:shadow-md",
      )}
    >
      <span aria-hidden className="absolute inset-x-0 top-0 h-[3px]" style={{ background: tone }} />

      <div className="flex flex-col gap-3 px-3.5 pt-4 pb-3">
        <div className="flex items-start gap-2.5">
          {iconTile("size-9", "size-[18px]")}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <h3 className="truncate text-sm font-semibold text-foreground">{view.goal.name}</h3>
              {fundChip}
            </div>
            <p className={cn("flex items-center gap-1 truncate text-[11.5px]", TONE_TEXT[due.tone])}>
              <CalendarDays className="size-3 shrink-0 opacity-70" />
              {due.text}
            </p>
          </div>
          {lockChip}
        </div>

        <div className="flex items-center gap-3.5">
          <span role="progressbar" aria-label={`${view.goal.name} progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="shrink-0">
            <ProgressRing value={pct} size={62} strokeWidth={6} color={tone}>
              <span className="font-mono text-[13px] font-bold tabular-nums text-foreground">{pct}%</span>
            </ProgressRing>
          </span>
          <div className="min-w-0">
            <p className="truncate font-mono text-[22px] leading-tight font-bold tracking-tight tabular-nums text-foreground" data-testid="goal-saved">
              {formatCurrency(view.saved)}
            </p>
            <p className="truncate text-[11.5px] text-muted-foreground">
              of {formatCurrency(view.target)}
              {!done && view.remaining > 0 && (
                <>
                  {" "}· <span className="font-semibold text-foreground/80">{formatCurrency(view.remaining)}</span> to go
                </>
              )}
            </p>
          </div>
        </div>
      </div>

      <div className="mt-auto flex items-center justify-between gap-2 border-t border-border/50 bg-muted/25 px-3.5 py-2" data-testid="goal-plan-row">
        <div className="min-w-0 flex-1 text-[11px] text-muted-foreground">{planLine}</div>
        {addButton}
      </div>
    </article>
  );
}
