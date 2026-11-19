"use client";

import { CalendarDays, ChevronDown, Landmark, Lock, LockOpen, Plus } from "lucide-react";
import type { KeyboardEvent } from "react";
import { ClayButton } from "@/components/clay/clay-button";
import { AccountMark } from "@/components/finance";
import { ProgressRing } from "@/components/foundation/progress-ring";
import { formatCurrency } from "@/lib/format";
import { UNLINKED, type GoalView } from "@/lib/engines/savings-goals";
import { lockState, type GoalCyclePlan } from "@/lib/engines/savings-plan";
import type { Account } from "@/lib/models/account";
import { cn } from "@/lib/utils";
import { dueLabel, formatShortDate, goalAccent, paceLine, renderGoalIcon, TONE_TEXT } from "@/features/savings/lib/goal-style";
import { Meter, PlanStatusPill } from "@/features/savings/components/savings-ui";

export function GoalTile({
  view,
  plan,
  accountsById,
  expanded,
  onToggle,
  onQuickAdd,
  showAdd,
}: {
  view: GoalView;
  plan: GoalCyclePlan | null;
  accountsById: Map<string, Account>;
  expanded: boolean;
  onToggle: () => void;
  onQuickAdd: () => void;
  showAdd: boolean;
}) {
  const accent = goalAccent(view);
  const pct = Math.round(view.progress * 100);
  const due = dueLabel(view);
  const pace = paceLine(view);
  const done = view.status === "completed";
  const lock = lockState(view, new Date());
  const held = Array.from(view.heldByAccount.keys()).filter((k) => k !== UNLINKED && accountsById.has(k));
  const hasPlan = plan != null && plan.status !== "none";

  const onKey = (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onToggle();
    }
  };

  return (
    <article
      data-testid="savings-goal-card"
      data-goal-name={view.goal.name}
      data-expanded={expanded || undefined}
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      aria-label={`${view.goal.name} — ${pct}% saved`}
      onClick={onToggle}
      onKeyDown={onKey}
      className={cn(
        "group surface-flat relative flex h-full cursor-pointer flex-col gap-3 overflow-hidden rounded-[22px] p-4 text-left transition-all duration-300 outline-none focus-visible:ring-2 focus-visible:ring-ring",
        expanded ? "border-transparent shadow-[0_0_0_2px_var(--goal-accent)]" : "hover:-translate-y-0.5 hover:shadow-lg",
      )}
      style={{ ["--goal-accent" as string]: accent }}
    >
      {/* Soft accent wash from the corner — thematic, follows the goal colour. */}
      <span aria-hidden className="pointer-events-none absolute -top-16 -right-16 size-40 rounded-full opacity-[0.13] blur-2xl transition-opacity group-hover:opacity-20" style={{ background: accent }} />

      <div className="relative flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-2xl" style={{ background: `color-mix(in oklab, ${accent} 20%, transparent)`, color: accent }}>
          {renderGoalIcon(view.goal.icon, "size-5")}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h3 className="truncate text-[15px] font-semibold text-foreground">{view.goal.name}</h3>
            {view.goal.kind === "deposit" && (
              <span className="inline-flex shrink-0 items-center gap-0.5 rounded-md bg-muted px-1.5 py-px text-[10px] font-semibold text-muted-foreground" title="Deposit-style fund">
                <Landmark className="size-2.5" /> Fund
              </span>
            )}
          </div>
          <p className={cn("mt-0.5 flex items-center gap-1 truncate text-xs", TONE_TEXT[due.tone])}>
            <CalendarDays className="size-3 shrink-0 opacity-70" />
            {due.text}
          </p>
        </div>
        {lock.active ? (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-purple/15 px-2 py-0.5 text-[10.5px] font-semibold text-purple" title={`Locked${lock.until ? ` until ${formatShortDate(lock.until)}` : ""} — a FlowFi reservation`} data-testid="goal-locked">
            <Lock className="size-3" />
            {lock.until ? formatShortDate(lock.until).replace(/ \d{4}$/, "") : "Locked"}
          </span>
        ) : lock.matured ? (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-[10.5px] font-semibold text-success" title="The lock has ended — the money is available">
            <LockOpen className="size-3" /> Available
          </span>
        ) : null}
      </div>

      <div className="relative flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-[22px] leading-tight font-bold tracking-tight tabular-nums text-foreground" data-testid="goal-saved">
            {formatCurrency(view.saved)}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            of {formatCurrency(view.target)}
            {view.remaining > 0 && !done ? ` · ${formatCurrency(view.remaining)} to go` : ""}
          </p>
        </div>
        <ProgressRing value={pct} size={54} strokeWidth={6} color={done ? "var(--success)" : accent}>
          <span className="text-[11px] font-bold tabular-nums text-foreground">{pct}%</span>
        </ProgressRing>
      </div>

      {/* This month's plan — the heart of the card. */}
      <div className="relative flex flex-col gap-1.5 rounded-2xl bg-muted/40 px-3 py-2.5" data-testid="goal-plan-row">
        {hasPlan && plan ? (
          <>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-medium text-muted-foreground">This month</span>
              <PlanStatusPill status={plan.status} />
            </div>
            <Meter value={plan.target > 0 ? plan.contributed / plan.target : 1} color={accent} label={`${view.goal.name} this month`} />
            <p className="flex items-baseline justify-between gap-2 text-[11px] text-muted-foreground">
              <span>
                <span className="font-mono font-semibold text-foreground tabular-nums">{formatCurrency(Math.min(plan.contributed, plan.target || plan.contributed))}</span> of {formatCurrency(plan.target || view.goal.monthlyTarget || 0)}
              </span>
              {plan.status === "skipped" ? <span>Skipped this month</span> : plan.remaining > 0 ? <span>{formatCurrency(plan.remaining)} left</span> : null}
            </p>
          </>
        ) : (
          <p className={cn("text-[11px] font-medium", TONE_TEXT[pace.tone])}>{done ? "Goal reached 🎉" : view.goal.monthlyTarget == null ? `${pace.text} · no monthly plan` : pace.text}</p>
        )}
      </div>

      <div className="relative mt-auto flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          {held.length > 0 ? (
            <>
              <span className="flex -space-x-1.5">
                {held.slice(0, 3).map((id) => (
                  <span key={id} className="rounded-full ring-2 ring-card" title={accountsById.get(id)?.name}>
                    <AccountMark account={accountsById.get(id)!} size={18} />
                  </span>
                ))}
              </span>
              <span className="truncate text-[11px] text-muted-foreground">{held.length === 1 ? accountsById.get(held[0])?.name : `${held.length} accounts`}</span>
            </>
          ) : (
            <span className="truncate text-[11px] text-muted-foreground">{view.saved > 0 ? "Opening balance" : "No money yet"}</span>
          )}
        </div>
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          {showAdd && (
            <ClayButton size="sm" className="h-8 gap-1 rounded-xl px-3" onClick={onQuickAdd} aria-label={`Add money to ${view.goal.name}`}>
              <Plus className="size-3.5" /> Add
            </ClayButton>
          )}
          <ClayButton variant="ghost" size="icon" className="size-8 rounded-xl" onClick={onToggle} aria-label={expanded ? `Collapse ${view.goal.name}` : `Open ${view.goal.name}`}>
            <ChevronDown className={cn("size-4 transition-transform duration-300", expanded && "rotate-180")} />
          </ClayButton>
        </div>
      </div>
    </article>
  );
}
