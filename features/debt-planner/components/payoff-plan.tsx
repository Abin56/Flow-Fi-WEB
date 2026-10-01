"use client";

import { AlertTriangle, ArrowDown, ArrowUp, Check, CheckCircle2, PauseCircle } from "lucide-react";
import { useState } from "react";
import type { DebtPosition } from "@/lib/engines/debt-position";
import type { BudgetScenario, PayoffPlan, PayoffStrategy, PlanMonth } from "@/lib/engines/debt-payoff";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";
import { CATEGORY_SWATCH } from "./debt-overview";
import { Chip, Explain, Money, Section } from "./planner-ui";

export const STRATEGY_COPY: Record<PayoffStrategy, { label: string; short: string; tab: string; oneLine: string; body: string }> = {
  avalanche: {
    label: "Highest interest first",
    short: "Avalanche",
    tab: "Highest interest",
    oneLine: "Extra money goes to the debt with the highest known interest rate.",
    body:
      "Extra money goes to the debt with the highest known interest rate. This may reduce total interest compared with other orders, depending on each debt's actual terms. Cards without a modeled rate rank after debts with known interest; 0% debts come last.",
  },
  snowball: {
    label: "Lowest balance first",
    short: "Snowball",
    tab: "Lowest balance",
    oneLine: "Extra money goes to the smallest balance, so individual debts clear sooner.",
    body: "Extra money goes to the smallest balance, so individual debts clear sooner. It can cost more interest than highest-interest-first.",
  },
  duePriority: {
    label: "Due date first",
    short: "Due priority",
    tab: "Due date",
    oneLine: "Extra money goes to whichever debt is due soonest.",
    body: "Overdue and required payments come first, as in every strategy. Extra money then goes to whichever debt is due soonest.",
  },
  custom: {
    label: "Custom order",
    short: "Custom",
    tab: "Custom",
    oneLine: "Extra money follows the order you set below.",
    body: "Extra money follows the order you set below. Required payments are still covered first on every debt.",
  },
};

const STRATEGIES: PayoffStrategy[] = ["avalanche", "snowball", "duePriority", "custom"];

/** Segmented strategy control — one track, the selected option lifted in lime with a check. */
export function StrategyPicker({ value, onChange }: { value: PayoffStrategy; onChange: (s: PayoffStrategy) => void }) {
  return (
    <div role="radiogroup" aria-label="Payoff strategy" className="grid grid-cols-2 gap-1 rounded-[8px] border border-border-strong bg-secondary p-1">
      {STRATEGIES.map((s) => {
        const active = s === value;
        return (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(s)}
            className={cn(
              "inline-flex h-8 items-center justify-center gap-1 rounded-[6px] border px-2 text-[13px] whitespace-nowrap outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring",
              active ? "border-primary-accent-text bg-primary font-bold text-primary-foreground shadow-sm" : "border-transparent font-medium text-foreground hover:bg-card",
            )}
          >
            {active && <Check className="size-3.5" strokeWidth={2.75} />}
            {STRATEGY_COPY[s].tab}
          </button>
        );
      })}
    </div>
  );
}

function CustomOrder({ positions, order, onChange }: { positions: DebtPosition[]; order: string[]; onChange: (o: string[]) => void }) {
  const byId = new Map(positions.map((p) => [p.id, p]));
  const ids = [...order.filter((id) => byId.has(id)), ...positions.map((p) => p.id).filter((id) => !order.includes(id))];
  const move = (i: number, d: -1 | 1) => {
    const next = [...ids];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    onChange(next);
  };
  const btn =
    "flex size-7 items-center justify-center rounded-[5px] border border-border-strong bg-card outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring disabled:border-border disabled:text-foreground/45";
  return (
    <ol className="overflow-hidden rounded-[8px] border border-border" aria-label="Custom payoff order">
      {ids.map((id, i) => (
        <li key={id} className="flex items-center gap-2 border-b border-border bg-card px-3 py-1.5 last:border-b-0">
          <span className="w-6 text-[13px] font-bold text-foreground/80 tabular-nums">{String(i + 1).padStart(2, "0")}</span>
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">{byId.get(id)!.name}</span>
          <span className="text-xs text-foreground/80 tabular-nums">{formatCurrency(byId.get(id)!.outstanding)}</span>
          <button type="button" aria-label={`Move ${byId.get(id)!.name} up`} disabled={i === 0} onClick={() => move(i, -1)} className={btn}>
            <ArrowUp className="size-3.5" />
          </button>
          <button type="button" aria-label={`Move ${byId.get(id)!.name} down`} disabled={i === ids.length - 1} onClick={() => move(i, 1)} className={btn}>
            <ArrowDown className="size-3.5" />
          </button>
        </li>
      ))}
    </ol>
  );
}

/** Payoff strategy — segmented control, one short line, and the detail behind a disclosure. */
export function StrategySection({
  positions,
  strategy,
  onStrategy,
  customOrder,
  onCustomOrder,
}: {
  positions: DebtPosition[];
  strategy: PayoffStrategy;
  onStrategy: (s: PayoffStrategy) => void;
  customOrder: string[];
  onCustomOrder: (o: string[]) => void;
}) {
  return (
    <section aria-labelledby="dp-strategy" className="flex flex-col gap-2.5">
      <h2 id="dp-strategy" className="text-[12px] font-bold tracking-[0.08em] text-foreground uppercase">
        Payoff strategy
      </h2>
      <StrategyPicker value={strategy} onChange={onStrategy} />
      <p key={strategy} className="text-[13px] text-foreground animate-in duration-200 fade-in-0">
        {STRATEGY_COPY[strategy].oneLine}
      </p>
      <Explain label="How this works">
        <p className="text-[13px] text-foreground">{STRATEGY_COPY[strategy].body}</p>
        <p className="mt-1 text-xs text-foreground/80">This explains the selected strategy. It is not financial advice.</p>
      </Explain>
      {strategy === "custom" && <CustomOrder positions={positions.filter((p) => !p.excludedFromPlan)} order={customOrder} onChange={onCustomOrder} />}
    </section>
  );
}

/** Finish line — one bar per projected debt, from now to its projected finish. */
function FinishLines({ plan, positions }: { plan: PayoffPlan; positions: DebtPosition[] }) {
  const span = Math.max(plan.months.length, 1);
  const projected = positions.filter((p) => !p.excludedFromPlan);
  return (
    <div className="flex flex-col gap-1.5 border-b border-border py-3">
      {projected.map((p) => {
        const outcome = plan.outcomes[p.id];
        const done = outcome?.finishIndex != null;
        const end = done ? outcome.finishIndex! + 1 : span;
        return (
          <div key={p.id} className="grid grid-cols-[minmax(0,7.5rem)_minmax(0,1fr)_minmax(0,6.5rem)] items-center gap-3">
            <span className="truncate text-[13px] font-semibold text-foreground">{p.name}</span>
            <div className="h-2 w-full rounded-[2px] bg-secondary ring-1 ring-border">
              <div className={cn("h-full rounded-[2px] transition-[width] duration-300", done ? CATEGORY_SWATCH[p.category] : "bg-foreground/35")} style={{ width: `${(end / span) * 100}%` }} />
            </div>
            <span className={cn("inline-flex items-center gap-1 text-xs font-semibold", done ? "text-success" : "text-foreground/80")}>
              {done ? (
                <>
                  <CheckCircle2 className="size-3.5" />
                  {outcome.finishLabel}
                </>
              ) : (
                "Not within plan"
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function RoadmapMonth({ month, names, paused, last }: { month: PlanMonth; names: Map<string, string>; paused: boolean; last: boolean }) {
  const byDebt = new Map<string, { required: number; extra: number; overdue: boolean }>();
  for (const l of month.lines) {
    const e = byDebt.get(l.debtId) ?? { required: 0, extra: 0, overdue: false };
    if (l.kind === "required") e.required += l.amount;
    else e.extra += l.amount;
    e.overdue ||= l.overdue;
    byDebt.set(l.debtId, e);
  }
  const finished = month.completed.length > 0;
  return (
    <li className="relative grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-3">
      {/* Rail + node */}
      <div className="relative flex justify-center">
        {!last && <span className="absolute top-4 bottom-0 w-px bg-border-strong" aria-hidden />}
        <span
          className={cn(
            "relative z-10 mt-1 flex size-3.5 items-center justify-center rounded-full border-2",
            paused ? "border-expense bg-card" : finished ? "border-success bg-success" : "border-foreground/70 bg-card",
          )}
          aria-hidden
        />
      </div>
      <div className={cn("flex min-w-0 flex-col gap-1.5 pb-4", !last && "border-b border-border/70 mb-3")}>
        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
          <span className="text-[13px] font-bold tracking-[0.04em] text-foreground uppercase">{month.period.label}</span>
          <span className="text-xs text-foreground/80 tabular-nums">
            Required {formatCurrency(month.required)}
            {month.extra + month.lumpSum > 0 && <span className="font-semibold text-success"> + extra {formatCurrency(month.extra + month.lumpSum)}</span>}
          </span>
        </div>
        <ul className="flex flex-col">
          {[...byDebt.entries()].map(([id, e]) => (
            <li key={id} className="flex items-baseline justify-between gap-3 border-l-2 border-border pl-2.5 text-[13px] leading-6">
              <span className="min-w-0 truncate text-foreground">
                {names.get(id)}
                <span className="ml-1.5 text-xs text-foreground/75">{e.required > 0 ? "required" : "extra"}</span>
                {e.overdue && <span className="ml-1.5 text-xs font-semibold text-expense">incl. overdue</span>}
              </span>
              <span className="shrink-0 font-semibold text-foreground tabular-nums">
                {e.required > 0 && formatCurrency(e.required)}
                {e.required > 0 && e.extra > 0 && " + "}
                {e.extra > 0 && <span className="text-success">{formatCurrency(e.extra)} extra</span>}
              </span>
            </li>
          ))}
          {month.completed.map((id) => (
            <li key={`done-${id}`} className="inline-flex items-center gap-1.5 pl-3 text-xs leading-6 font-semibold text-success">
              <CheckCircle2 className="size-3.5" /> {names.get(id)} paid off
            </li>
          ))}
        </ul>
        {paused ? (
          <p className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-expense">
            <PauseCircle className="size-4" strokeWidth={2.25} />
            Plan paused — budget shortfall
          </p>
        ) : (
          <p className="flex items-baseline justify-between gap-3 text-[13px]">
            <span className="text-foreground/80">Still to pay after this month</span>
            <Money amount={month.remainingDebt} className="text-[14px] text-foreground" />
          </p>
        )}
      </div>
    </li>
  );
}

/** Payoff roadmap — the engine's month-by-month plan as a vertical timeline. Nothing past a shortfall. */
export function PayoffRoadmap({ plan, positions, isStale }: { plan: PayoffPlan; positions: DebtPosition[]; isStale: boolean }) {
  const [showAll, setShowAll] = useState(false);
  const names = new Map(positions.map((p) => [p.id, p.name]));
  const visible = showAll ? plan.months : plan.months.slice(0, 6);
  const shortfall = plan.status === "shortfall";

  return (
    <Section
      id="dp-payoff"
      title="Payoff roadmap"
      hint="A projection only. No payment, transaction or balance is created."
      className={cn("transition-opacity duration-200", isStale && "opacity-70")}
      aside={
        plan.status === "debtFree" ? (
          <Chip tone="success" icon={CheckCircle2}>
            Debt-free {plan.debtFree!.label}
          </Chip>
        ) : shortfall ? (
          <Chip tone="expense" icon={AlertTriangle}>
            Paused {plan.shortfall!.period.label}
          </Chip>
        ) : null
      }
    >
      {plan.months.length > 0 && !shortfall && positions.filter((p) => !p.excludedFromPlan).length > 0 && <FinishLines plan={plan} positions={positions} />}

      {plan.months.length > 0 && (
        <div className="flex items-baseline justify-between gap-3 pt-3 pb-3 text-xs">
          <span className="text-foreground/80">
            {plan.months.length} {plan.months.length === 1 ? "month" : "months"} projected
          </span>
          <span className="text-foreground/80">
            Projected interest{" "}
            <span className="font-semibold text-foreground">
              {formatCurrency(plan.projectedInterest.known)}
              {!plan.projectedInterest.complete && " + card interest (not calculated)"}
            </span>
          </span>
        </div>
      )}

      {plan.months.length > 0 ? (
        <ol>
          {visible.map((m, i) => (
            <RoadmapMonth key={m.period.index} month={m} names={names} paused={shortfall && m === plan.months.at(-1)} last={i === visible.length - 1} />
          ))}
        </ol>
      ) : (
        <p className="py-3 text-[13px] text-foreground/80">No months to project.</p>
      )}

      {plan.months.length > 6 && (
        <button
          type="button"
          onClick={() => setShowAll((s) => !s)}
          className="w-fit text-[13px] font-semibold text-foreground underline decoration-border-strong underline-offset-4 outline-none hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          {showAll ? "Show fewer months" : `Show all ${plan.months.length} months`}
        </button>
      )}

      {plan.notProjected.length > 0 && (
        <p className="mt-3 text-xs text-foreground/80">
          Not projected: {plan.notProjected.map((n) => `${names.get(n.debtId)} (${n.reason})`).join(", ")}. Still counted in total debt.
        </p>
      )}
    </Section>
  );
}

/** Budget scenarios — same strategy at other budgets, from the engine. Collapses when it has nothing to say. */
export function BudgetScenariosPanel({ scenarios, currentBudget, onPick }: { scenarios: BudgetScenario[]; currentBudget: number; onPick: (b: number) => void }) {
  if (scenarios.length === 0) return null;
  return (
    <section aria-labelledby="dp-scenarios" className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="dp-scenarios" className="text-[12px] font-bold tracking-[0.08em] text-foreground uppercase">
          Monthly budget scenarios
        </h2>
        <span className="text-xs text-foreground/80">Same strategy · pick one to try it</span>
      </div>
      <ul className="overflow-hidden rounded-[8px] border border-border bg-card">
        {scenarios.map((s) => {
          const current = Math.abs(s.budget - currentBudget) < 0.5;
          return (
            <li key={s.budget} className="border-b border-border last:border-b-0">
              <button
                type="button"
                aria-pressed={current}
                onClick={() => onPick(s.budget)}
                className={cn(
                  "grid w-full grid-cols-[minmax(0,8.5rem)_minmax(0,1fr)] items-center gap-3 px-3 py-2 text-left outline-none transition-colors duration-150 hover:bg-secondary/70 focus-visible:bg-secondary/70 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                  current && "bg-primary/15 shadow-[inset_3px_0_0_var(--primary-accent-text)]",
                )}
              >
                <span className="flex items-baseline gap-1">
                  <Money amount={s.budget} className="text-[14px] text-foreground" />
                  <span className="text-xs text-foreground/80">/ mo</span>
                </span>
                <span className="flex min-w-0 items-center justify-between gap-2 text-[13px] text-foreground">
                  {s.status === "debtFree" ? (
                    <span className="min-w-0 truncate">
                      Debt-free <strong>{s.debtFree!.label}</strong>
                      <span className="text-foreground/80"> · interest {formatCurrency(s.knownInterest)}</span>
                    </span>
                  ) : s.status === "shortfall" ? (
                    <span className="inline-flex items-center gap-1.5 font-semibold text-expense">
                      <AlertTriangle className="size-3.5 shrink-0" /> {formatCurrency(s.shortfall)} short
                    </span>
                  ) : s.status === "stalled" ? (
                    <span className="text-foreground/85">No payoff date</span>
                  ) : s.status === "noDebt" ? (
                    <span>No debt</span>
                  ) : (
                    <span className="text-foreground/85">Over 50 years</span>
                  )}
                  {current && (
                    <Chip tone="primary" className="h-5 px-1.5 text-[10.5px]">
                      Current
                    </Chip>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
