"use client";

import { ArrowRight, Info } from "lucide-react";
import { LE_RADIUS } from "@/features/loans/components/loan-emi-ui";
import { annualRateForOrdering, hasKnownPositiveInterest, type DebtPosition } from "@/lib/engines/debt-position";
import type { ExtraPaymentImpact, PayoffPlan, PayoffStrategy } from "@/lib/engines/debt-payoff";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";
import { STRATEGY_COPY } from "./payoff-plan";
import { Label, Money, Panel, PanelHeader, PlanAmountInput } from "./planner-ui";

/** Why the strategy put money on this debt — a description of the rule, never advice. */
function allocationReason(p: DebtPosition, strategy: PayoffStrategy, chosen: boolean, first: boolean): string {
  if (chosen) return "You chose this debt";
  if (!first) return `Remainder, next under "${STRATEGY_COPY[strategy].label}"`;
  switch (strategy) {
    case "avalanche": {
      if (hasKnownPositiveInterest(p)) return "Highest applicable interest rate among eligible debts";
      const stated = annualRateForOrdering(p.interest);
      return stated != null && stated > 0 ? `Stated rate ${stated}% (not modeled), ranked by it` : "No known-interest debt left to pay first";
    }
    case "snowball":
      return "Smallest remaining balance";
    case "duePriority":
      return "Next payment due soonest";
    case "custom":
      return "First in your custom order";
  }
}

/** Debt-free value for a comparison column — "Unavailable" when the engine has no date. */
function freeValue(plan: PayoffPlan): string {
  if (plan.status === "debtFree") return plan.debtFree!.label;
  if (plan.status === "noDebt") return "Debt-free";
  return "Unavailable";
}

function Column({ title, plan, highlight }: { title: string; plan: PayoffPlan; highlight?: boolean }) {
  const free = freeValue(plan);
  return (
    <div className={cn("flex min-w-0 flex-col gap-2.5 px-4 py-3", highlight && "bg-primary/12")}>
      <Label className={highlight ? "text-foreground" : undefined}>{title}</Label>
      <div>
        <p className="text-xs text-foreground/80">Debt-free</p>
        <p className={cn("text-[19px] leading-tight font-bold", free === "Unavailable" ? "text-foreground/75" : "text-foreground")}>{free}</p>
      </div>
      <div>
        <p className="text-xs text-foreground/80">Projected interest</p>
        <p className="text-[16px] font-bold text-foreground">
          <Money amount={plan.projectedInterest.known} />
          {!plan.projectedInterest.complete && <span className="ml-1 text-xs font-medium text-foreground/80">+ card interest</span>}
        </p>
      </div>
    </div>
  );
}

export function ExtraPaymentPanel({
  positions,
  strategy,
  amountInput,
  onAmountInput,
  targetId,
  onTarget,
  impact,
}: {
  positions: DebtPosition[];
  strategy: PayoffStrategy;
  amountInput: string;
  onAmountInput: (v: string) => void;
  targetId: string | null;
  onTarget: (id: string | null) => void;
  impact: ExtraPaymentImpact | null;
}) {
  const byId = new Map(positions.map((p) => [p.id, p]));
  const eligible = positions.filter((p) => !p.excludedFromPlan);
  const touched = impact?.allocation.map((l) => byId.get(l.debtId)).filter((p): p is DebtPosition => p != null) ?? [];
  const onlyZeroInterest = touched.length > 0 && touched.every((p) => p.interest.kind === "none");
  const touchesUnknown = touched.some((p) => p.interest.kind === "unknown");
  const baseBlocked = impact != null && impact.base.status === "shortfall";
  const amount = Number(amountInput) || 0;

  return (
    <Panel aria-labelledby="dp-extra">
      <PanelHeader id="dp-extra" title="What if I pay extra?" subtitle="A one-time extra amount this cycle, on top of your monthly budget. Simulation only." />
      <div className="grid gap-3 border-b border-border px-4 py-3 sm:grid-cols-2 sm:px-5">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="dp-extra-amount" className="text-xs font-semibold text-foreground">
            Extra this month
          </label>
          <PlanAmountInput id="dp-extra-amount" label="Extra this month" value={amountInput} onChange={onAmountInput} />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="dp-extra-target" className="text-xs font-semibold text-foreground">
            Apply using
          </label>
          <select
            id="dp-extra-target"
            value={targetId ?? ""}
            onChange={(e) => onTarget(e.target.value || null)}
            className={cn(LE_RADIUS.input, "h-10 w-full border border-border-strong bg-card px-3 text-[14px] font-medium text-foreground outline-none hover:border-muted-foreground focus:border-primary-accent-text focus-visible:ring-2 focus-visible:ring-ring/40")}
          >
            <option value="">Strategy: {STRATEGY_COPY[strategy].label}</option>
            {eligible.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({formatCurrency(p.outstanding)})
              </option>
            ))}
          </select>
        </div>
      </div>

      {!impact ? (
        <p className="px-4 py-4 text-[13px] text-foreground/85 sm:px-5">Enter an amount to compare your plan with and without it.</p>
      ) : baseBlocked ? (
        // Said once: the header's status line already explains the shortfall itself.
        <p className="flex items-start gap-2 px-4 py-4 text-[13px] text-foreground sm:px-5">
          <Info className="mt-0.5 size-4 shrink-0 text-foreground/80" />
          <span>
            <strong>Payoff comparison unavailable at the current monthly budget.</strong> The plan pauses when the budget can&apos;t cover required payments, so there is no debt-free date to compare
            yet. Raise the monthly budget to compare.
          </span>
        </p>
      ) : (
        <>
          <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-stretch border-b border-border">
            <Column title="Without extra" plan={impact.base} />
            <div className="flex items-center border-x border-border px-1.5">
              <ArrowRight className="size-4 text-foreground/80" />
            </div>
            <Column title={`With ${formatCurrency(amount)} extra`} plan={impact.withExtra} highlight />
          </div>
          <dl className="grid grid-cols-2 border-b border-border">
            <div className="border-r border-border px-4 py-2.5">
              <dt className="text-xs text-foreground/80">Months saved</dt>
              <dd className={cn("text-[15px] font-bold tabular-nums", impact.periodsEarlier && impact.periodsEarlier > 0 ? "text-success" : "text-foreground")}>
                {impact.periodsEarlier != null ? (impact.periodsEarlier > 0 ? `${impact.periodsEarlier} ${impact.periodsEarlier === 1 ? "month" : "months"} earlier` : "Same month") : "Unavailable"}
              </dd>
            </div>
            <div className="px-4 py-2.5">
              <dt className="text-xs text-foreground/80">Interest saved</dt>
              <dd className={cn("text-[15px] font-bold", impact.knownInterestSaved > 0.5 ? "text-success" : "text-foreground")}>
                {onlyZeroInterest
                  ? "No change · 0% debts"
                  : impact.knownInterestSaved > 0.5
                    ? formatCurrency(impact.knownInterestSaved)
                    : touchesUnknown
                      ? "Unavailable"
                      : "No change"}
              </dd>
            </div>
          </dl>
          {(touchesUnknown || !impact.base.projectedInterest.complete) && (
            <p className="flex items-start gap-1.5 border-b border-border px-4 py-2 text-xs text-foreground/85 sm:px-5">
              <Info className="mt-0.5 size-3.5 shrink-0" />
              {touchesUnknown ? "Card interest isn't calculated by FlowFi, so any saving on card interest isn't included." : "Interest figures cover debts with known terms only. Card interest is not calculated."}
            </p>
          )}
        </>
      )}

      {impact && !baseBlocked && impact.allocation.length > 0 && (
        <div className="flex flex-col gap-1.5 px-4 py-3 sm:px-5">
          <Label>Where the extra goes</Label>
          <ul>
            {impact.allocation.map((l, i) => {
              const p = byId.get(l.debtId)!;
              return (
                <li key={l.debtId} className="border-b border-border/70 py-1.5 last:border-b-0">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="truncate text-[13px] font-semibold text-foreground">{p.name}</span>
                    <Money amount={l.amount} className="text-[14px] text-foreground" />
                  </div>
                  <p className="text-xs text-foreground/80">{allocationReason(p, strategy, targetId === p.id, i === 0)}</p>
                  {p.extraMode === "advanceOnly" && <p className="text-xs text-foreground/80">Pays upcoming installments early. Their interest stays the same.</p>}
                  {p.extraMode === "reamortize" && <p className="text-xs text-foreground/80">Principal prepayment. The loan keeps its installment and its tenure shortens.</p>}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Panel>
  );
}
