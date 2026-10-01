"use client";

import { AlertTriangle, CalendarCheck2, CheckCircle2, Clock, Info, Wallet } from "lucide-react";
import { DEBT_CATEGORY_LABEL, type DebtCategory, type DebtSnapshot } from "@/lib/engines/debt-position";
import type { PayoffPlan, requiredThisPeriod } from "@/lib/engines/debt-payoff";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { CycleAffordability, DebtReconciliation } from "@/features/debt-planner/hooks/use-debt-planner-data";
import { Breakdown, Explain, Label, Money, Panel, PlanAmountInput, PresetButton, Stat } from "./planner-ui";

export const CATEGORY_SWATCH: Record<DebtCategory, string> = {
  creditCards: "bg-royal",
  loans: "bg-foreground",
  emis: "bg-sky",
  people: "bg-purple",
};

const CATEGORY_ORDER: DebtCategory[] = ["creditCards", "loans", "emis", "people"];

/** One-line debt-free answer for a plan. */
export function debtFreeText(plan: PayoffPlan): { text: string; tone: "success" | "expense" | "neutral" } {
  switch (plan.status) {
    case "debtFree":
      return { text: plan.debtFree!.label, tone: "success" };
    case "noDebt":
      return { text: "Debt-free", tone: "success" };
    case "shortfall":
      return { text: "Budget too low", tone: "expense" };
    case "stalled":
      return { text: "No payoff date", tone: "neutral" };
    case "horizon":
      return { text: "Beyond 50 years", tone: "neutral" };
  }
}

/** The debt-free figure for the header — short, with the reason living in the single status line. */
function debtFreeFigure(plan: PayoffPlan): { value: string; note: string; tone: "success" | "neutral" } {
  switch (plan.status) {
    case "debtFree":
      return { value: plan.debtFree!.label, note: `In ${plan.months.length} ${plan.months.length === 1 ? "month" : "months"} at this budget`, tone: "success" };
    case "noDebt":
      return { value: "Debt-free", note: "Nothing to plan", tone: "success" };
    case "shortfall":
      return { value: "Not yet", note: "Budget must cover required payments", tone: "neutral" };
    case "stalled":
      return { value: "No date", note: "Some debts get no payments", tone: "neutral" };
    case "horizon":
      return { value: "50+ years", note: "Beyond the planning range", tone: "neutral" };
  }
}

/** Compact per-category composition: one aligned row per category, a thin bar scaled to the total. */
function Composition({ snapshot }: { snapshot: DebtSnapshot }) {
  const present = CATEGORY_ORDER.filter((c) => snapshot.byCategory[c] > 0);
  const single = present.length <= 1;
  return (
    <ul className="grid grid-cols-2 gap-x-5 gap-y-2 sm:grid-cols-4 lg:grid-cols-1 lg:gap-y-1.5" aria-label="Debt by category">
      {CATEGORY_ORDER.map((c) => {
        const amount = snapshot.byCategory[c];
        const share = snapshot.total > 0 ? amount / snapshot.total : 0;
        return (
          <li key={c} className={cn("grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2", amount <= 0 && "text-foreground/70")}>
            <span className={cn("size-2.5 rounded-[2px]", amount > 0 ? CATEGORY_SWATCH[c] : "border border-border-strong")} aria-hidden />
            <span className="truncate text-[13px] font-medium text-inherit">{DEBT_CATEGORY_LABEL[c]}</span>
            <span className={cn("text-[13px] tabular-nums", amount > 0 ? "font-bold text-foreground" : "font-medium")}>{formatCurrency(amount)}</span>
            {/* Bars only compare categories — with a single category they'd say nothing, so show its share instead. */}
            {!single && (
              <span className="col-span-3 col-start-1 mt-1 hidden h-1.5 overflow-hidden rounded-[2px] bg-secondary ring-1 ring-border lg:block" aria-hidden>
                <span className={cn("block h-full", CATEGORY_SWATCH[c])} style={{ width: `${share * 100}%` }} />
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Budget presets — the planner's existing rule: required, then +₹1,000 and +₹5,000 rounded up to ₹500. */
function budgetPresets(required: number): number[] {
  return [required, Math.ceil((required + 1000) / 500) * 500, Math.ceil((required + 5000) / 500) * 500].filter((v, i, a) => v > 0 && a.indexOf(v) === i);
}

/**
 * The one contextual plan status. Shortfall / stalled / horizon are each said here once; every other
 * section only refers back to it.
 */
export function PlanStatusNotice({ plan, names }: { plan: PayoffPlan; names: Map<string, string> }) {
  if (plan.status === "shortfall" && plan.shortfall) {
    const s = plan.shortfall;
    return (
      <div role="status" className="flex items-start gap-2.5 rounded-[6px] border border-expense/60 bg-expense/[0.07] px-3 py-2.5">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-expense" strokeWidth={2.25} />
        <div className="min-w-0 text-[13px] text-foreground">
          <p className="font-bold text-expense">Budget shortfall</p>
          <p>
            {s.period.index === 0 ? "This cycle" : s.period.label} requires <strong className="tabular-nums">{formatCurrency(s.required)}</strong>. Your monthly budget is{" "}
            <strong className="tabular-nums">{formatCurrency(s.budget)}</strong>.
          </p>
          <p className="text-foreground/80">Increase the budget by {formatCurrency(s.amount)} to cover required payments and see a payoff date.</p>
        </div>
      </div>
    );
  }
  if (plan.status === "stalled" && plan.stalled.length > 0) {
    const who = plan.stalled.map((id) => names.get(id)).join(", ");
    const one = plan.stalled.length === 1;
    return (
      <div role="status" className="flex items-start gap-2.5 rounded-[6px] border border-warning bg-warning/15 px-3 py-2.5 text-[13px] text-foreground">
        <Info className="mt-0.5 size-4 shrink-0" strokeWidth={2.25} />
        <div className="min-w-0">
          <p className="font-bold">No payoff date yet</p>
          <p>
            {who} {one ? "has" : "have"} no repayment schedule, and no money above required payments reaches {one ? "it" : "them"}. Raise the budget above required payments to include {one ? "it" : "them"}.
          </p>
        </div>
      </div>
    );
  }
  if (plan.status === "horizon") {
    return (
      <div role="status" className="flex items-start gap-2.5 rounded-[6px] border border-warning bg-warning/15 px-3 py-2.5 text-[13px] text-foreground">
        <Info className="mt-0.5 size-4 shrink-0" strokeWidth={2.25} />
        <p>At this budget the plan runs past 50 years. A higher budget brings the debt-free date into range.</p>
      </div>
    );
  }
  return null;
}

/**
 * Debt command header — answers, in order: how much do I owe, what is due now, what can I put in per
 * month, and when am I debt-free. One surface, laid out across the width instead of stacked boxes.
 */
export function DebtCommandHeader({
  snapshot,
  required,
  plan,
  affordability,
  budgetInput,
  onBudgetInput,
  names,
}: {
  snapshot: DebtSnapshot;
  required: ReturnType<typeof requiredThisPeriod>;
  plan: PayoffPlan;
  affordability: CycleAffordability;
  budgetInput: string;
  onBudgetInput: (v: string) => void;
  names: Map<string, string>;
}) {
  const free = debtFreeFigure(plan);
  const first = plan.months[0];
  const extraCapacity = first && plan.status !== "shortfall" ? first.extra + first.lumpSum + first.unallocated : 0;
  const presets = budgetPresets(required.total);
  const budgetValue = Number(budgetInput) || 0;
  const count = snapshot.positions.length;

  return (
    <Panel aria-labelledby="dp-total" className="overflow-hidden">
      <div className="grid lg:grid-cols-12">
        {/* 1 — How much do I owe? */}
        <div className="flex flex-col gap-4 px-4 py-4 sm:px-5 lg:col-span-4 lg:border-r lg:border-border">
          <div className="flex flex-col gap-1">
            <Label>
              <span id="dp-total">Total debt</span>
            </Label>
            <Money amount={snapshot.total} className="text-[36px] leading-none tracking-tight text-foreground sm:text-[42px]" />
            <p className="text-[13px] text-foreground/80">
              Still to pay across {count} {count === 1 ? "debt" : "debts"}
            </p>
          </div>
          <Composition snapshot={snapshot} />
        </div>

        {/* 2 — What is due now, and when does it end? */}
        <div className="grid grid-cols-2 content-start gap-x-4 gap-y-4 border-t border-border px-4 py-4 sm:px-5 lg:col-span-3 lg:grid-cols-1 lg:border-t-0 lg:border-r">
          <Stat label="Required this cycle" amount={required.total} icon={Wallet} note={required.period.label} />
          <Stat
            label="Overdue"
            amount={snapshot.overdue}
            icon={snapshot.overdue > 0 ? AlertTriangle : CheckCircle2}
            tone={snapshot.overdue > 0 ? "expense" : "neutral"}
            note={snapshot.overdue > 0 ? "Past due, unpaid" : "Nothing overdue"}
          />
          <Stat
            label="Projected debt-free"
            value={free.value}
            icon={CalendarCheck2}
            tone={free.tone}
            note={free.note}
            className="col-span-2 border-t border-border pt-3 lg:col-span-1"
          />
        </div>

        {/* 3 — How much can I afford per month? */}
        <div className="flex flex-col gap-3 border-t border-border bg-secondary/40 px-4 py-4 sm:px-5 lg:col-span-5 lg:border-t-0">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3">
            <label htmlFor="dp-budget" className="text-[12px] font-bold tracking-[0.08em] text-foreground uppercase">
              Monthly payoff budget
            </label>
            <span className="text-xs text-foreground/75">Planning only — this does not move money</span>
          </div>
          <p className="-mt-2 text-[13px] text-foreground/80">How much can you put toward debt each month?</p>
          <div className="grid gap-2 sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)] sm:items-center">
            <PlanAmountInput id="dp-budget" label="Monthly payoff budget" value={budgetInput} onChange={onBudgetInput} size="lg" />
            <div className="flex flex-wrap gap-1.5" aria-label="Suggested budgets">
              {presets.map((v, i) => (
                <PresetButton key={v} active={Math.abs(v - budgetValue) < 0.5} onClick={() => onBudgetInput(String(Math.ceil(v)))}>
                  {i === 0 && v === required.total ? `Required ${formatCurrency(v)}` : formatCurrency(v)}
                </PresetButton>
              ))}
            </div>
          </div>

          <dl className="grid grid-cols-2 gap-x-4 border-y border-border py-2 text-[13px]">
            <div className="flex flex-col">
              <dt className="text-xs text-foreground/80">Required payments</dt>
              <dd className="font-bold text-foreground tabular-nums">{formatCurrency(required.total)}</dd>
            </div>
            <div className="flex flex-col">
              <dt className="text-xs text-foreground/80">{plan.status === "shortfall" ? "Extra toward payoff" : "Extra toward your strategy"}</dt>
              <dd className={cn("font-bold tabular-nums", extraCapacity > 0 ? "text-success" : "text-foreground")}>{formatCurrency(extraCapacity)}</dd>
            </div>
          </dl>

          <PlanStatusNotice plan={plan} names={names} />

          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="inline-flex items-center gap-1.5 text-[13px] text-foreground">
              <Clock className="size-3.5 text-foreground/75" />
              Left this cycle after bills and debt:
              <strong className={cn("tabular-nums", affordability.remaining < 0 ? "text-expense" : "text-foreground")}>{formatCurrency(affordability.remaining)}</strong>
            </p>
            <Explain label="Month Cycle details">
              <Breakdown
                rows={[
                  { label: "Income received", amount: affordability.income },
                  { label: "Spent so far", note: "incl. payments made", amount: -affordability.spent },
                  { label: "Bills still due", amount: -affordability.billsDue },
                  { label: "Debt payments still due", amount: -affordability.debtDue },
                ]}
                total={{ label: "Left this cycle", amount: affordability.remaining }}
              />
              <p className="mt-1.5 text-xs text-foreground/80">From Month Cycle · {affordability.label}. For reference only — your budget is never set from this automatically.</p>
            </Explain>
          </div>
        </div>
      </div>
    </Panel>
  );
}

/** "How is this calculated?" — sources, exclusions, duplicate prevention, reconciliation. */
export function CalculationDetails({ snapshot, reconciliation }: { snapshot: DebtSnapshot; reconciliation: DebtReconciliation }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Breakdown
        rows={snapshot.positions.map((p) => ({ label: p.name, note: p.kindLabel, amount: p.outstanding }))}
        total={{ label: "Total debt", amount: snapshot.total }}
      />
      <ul className="flex flex-col gap-1.5 text-[13px] text-foreground">
        <li>Loans and EMIs count remaining principal only, never future interest.</li>
        <li>Cards count their outstanding plus card-EMI principal still locked on them. Card purchases and card EMIs are never counted twice.</li>
        <li>People counts only what you owe them directly. A loan from a person appears once, as that loan.</li>
        <li>Card interest is not modeled by FlowFi, so projected interest covers debts with known terms only.</li>
        {(snapshot.receivables.lentLoans > 0 || snapshot.receivables.people > 0) && (
          <li>
            Not counted (owed to you): {formatCurrency(snapshot.receivables.lentLoans + snapshot.receivables.people)}
            {snapshot.receivables.lentLoans > 0 && ` · loans you gave ${formatCurrency(snapshot.receivables.lentLoans)}`}
            {snapshot.receivables.people > 0 && ` · people ${formatCurrency(snapshot.receivables.people)}`}
          </li>
        )}
        <li className={cn("inline-flex items-start gap-1.5 font-semibold", reconciliation.matches ? "text-success" : "text-expense")}>
          {reconciliation.matches ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" /> : <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />}
          <span>
            {reconciliation.matches ? "Matches" : "Does not match"} Net Worth liabilities {formatCurrency(reconciliation.balanceSheetDebt)} + direct People debt{" "}
            {formatCurrency(reconciliation.peopleDirect)} = {formatCurrency(reconciliation.expected)}
          </span>
        </li>
      </ul>
    </div>
  );
}
