"use client";

import { ArrowDownLeft, ArrowUpRight, CalendarClock, Check, ChevronDown, Scale } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { CycleNavigator } from "@/features/people/components/workspace/transaction-ledger-mode";
import { type PersonCycleStatement, type StatementCycle } from "@/lib/engines/person-cycle-statement";
import { money } from "@/lib/engines/person-cycle-statement-share";
import { cn } from "@/lib/utils";
import { CycleReconciliation, settlementFigures } from "@/features/people/components/workspace/settlement-summary";
import { cyclePosition } from "@/features/people/lib/settlement-presentation";
import { ColumnLabel, Leader } from "./header-parts";
import { StatementBreakdown, StatementCalculation } from "./statement-parts";

const LABEL = "text-[10.5px] font-bold tracking-[0.07em] text-foreground/60 uppercase";

const toneOf = (s: PersonCycleStatement | null) =>
  s?.direction === "theyOwe" ? "text-settle-receivable-text" : s?.direction === "iOwe" ? "text-settle-payable-text" : "text-success";

const tileOf = (s: PersonCycleStatement | null) =>
  s?.direction === "theyOwe"
    ? "bg-settle-receivable-tint/70 ring-settle-receivable-edge/25"
    : s?.direction === "iOwe"
      ? "bg-settle-payable-tint/70 ring-settle-payable-edge/25"
      : s?.direction === "settled"
        ? "bg-success/[0.07] ring-success/20"
        : "bg-secondary/45 ring-border";

/** This cycle's settled share as a ring — received of the cycle's total (the same `settlementFigures`). */
function CycleRing({ pct }: { pct: number }) {
  const r = 22;
  const c = 2 * Math.PI * r;
  return (
    <span
      role="progressbar"
      aria-label={`${pct}% of this cycle settled`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      className="relative grid size-[58px] shrink-0 place-items-center"
    >
      <svg viewBox="0 0 52 52" className="absolute inset-0 size-full -rotate-90" aria-hidden>
        <circle cx="26" cy="26" r={r} fill="none" strokeWidth="5" className="stroke-border-strong/45" />
        <circle
          cx="26"
          cy="26"
          r={r}
          fill="none"
          strokeWidth="5"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - pct / 100)}
          className="stroke-success transition-[stroke-dashoffset] duration-700 ease-out"
        />
      </svg>
      <span className="relative font-heading text-[12.5px] font-bold text-foreground tabular-nums">{pct}%</span>
    </span>
  );
}

/** The overall position from the People engine's own breakdown (never a re-sum). */
export interface OverallPosition {
  toReceive: number;
  toGive: number;
  /** Unapplied advance — negative: held from them; positive: I paid ahead. */
  advance: number;
}

/**
 * The person header's one-line financial summary: this cycle's settlement (headline + amount + how much of the cycle's
 * total came in), the cycle switcher, and the overall position with the person. Every figure is an existing engine value
 * (`settlementFigures` = the old Total · Received · Remaining strip; the overall = `person.breakdown`) — shown once each.
 */
export function PersonSettlementStrip({
  statement,
  isLoading,
  cycle,
  onCycleChange,
  firstName,
  overall,
  third,
}: {
  statement: PersonCycleStatement | null;
  isLoading: boolean;
  cycle: StatementCycle;
  onCycleChange: (cycle: StatementCycle) => void;
  firstName: string;
  overall: OverallPosition;
  /** Replaces the third column (e.g. EMI responsibility); defaults to how the cycle's total was built. */
  third?: React.ReactNode;
}) {
  const loading = isLoading || statement == null;
  const tone = toneOf(statement);
  const DirectionIcon = statement?.direction === "theyOwe" ? ArrowDownLeft : statement?.direction === "iOwe" ? ArrowUpRight : Check;
  const figures = statement ? settlementFigures(statement, statement.personName) : null;
  const total = figures?.find((f) => f.testId === "settlement-total");
  const settled = figures?.find((f) => f.testId === "settlement-received");
  const pct = total && settled && total.value > 0.005 ? Math.min(100, Math.round((settled.value / total.value) * 100)) : null;
  const bothSides = statement != null && statement.toReceive > 0 && statement.toGive > 0;
  const hasAdvance = Math.abs(overall.advance) >= 0.005;

  const tile = bothSides ? "bg-secondary/45 ring-border" : tileOf(statement);

  return (
    <div className="grid min-w-0 items-stretch gap-x-5 gap-y-3 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)]" aria-label="Settlement summary">
      {/* 1 · This cycle's settlement — the strongest figure on the page, on a tile tinted by who owes whom */}
      <div className={cn("min-w-0 rounded-[14px] px-3.5 py-2.5 ring-1 ring-inset", loading ? "bg-secondary/40 ring-border" : tile)}>
        <div className="flex min-w-0 items-center justify-between gap-2">
          <p className={LABEL}>Settlement</p>
          <div className="-my-1 -mr-1 scale-[0.94] origin-right">
            <CycleNavigator cycle={cycle} onCycleChange={onCycleChange} />
          </div>
        </div>
        {loading ? (
          <div className="mt-1.5 space-y-2">
            <Skeleton className="h-8 w-40" />
            <Skeleton className="h-1.5 w-full" />
          </div>
        ) : bothSides ? (
          // Two independent obligations — both gross, each settled on its own; never one netted figure.
          <div className="mt-1 grid grid-cols-2 gap-3">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold text-settle-receivable-text">You need to receive</p>
              <p className="font-heading text-[24px] leading-none font-bold tracking-tight tabular-nums text-settle-receivable-text">{money(statement.toReceive)}</p>
            </div>
            <div className="min-w-0">
              <p className="text-[11px] font-semibold text-settle-payable-text">You need to give</p>
              <p className="font-heading text-[24px] leading-none font-bold tracking-tight tabular-nums text-settle-payable-text">{money(statement.toGive)}</p>
            </div>
            <p className="col-span-2 text-[11px] font-medium text-foreground/60">Tracked separately — each side is settled on its own.</p>
          </div>
        ) : (
          <div className="mt-1 flex min-w-0 items-center gap-3.5">
            <CycleRing pct={pct ?? (statement.direction === "settled" ? 100 : 0)} />
            <div className="min-w-0 flex-1">
              <p className={cn("inline-flex items-center gap-1 text-[12px] font-semibold", tone)}>
                <DirectionIcon className="size-3.5" strokeWidth={2.5} aria-hidden />
                {cyclePosition(statement, statement.personName).headline}
              </p>
              {statement.direction === "settled" ? (
                <p className="mt-0.5 font-heading text-[26px] leading-none font-bold tracking-tight text-success">All settled</p>
              ) : (
                <p className={cn("mt-0.5 font-heading text-[30px] leading-none font-bold tracking-tight tabular-nums", tone)} data-testid="settlement-remaining">
                  {money(statement.amount)}
                </p>
              )}
              {total && settled && (
                <dl className="mt-1.5 flex min-w-0 items-baseline gap-x-3 text-[11.5px] text-foreground/60 tabular-nums">
                  <div className="flex items-baseline gap-1">
                    <dt>Due this cycle</dt>
                    <dd data-testid="settlement-total" className="font-semibold text-foreground/85">{money(total.value)}</dd>
                  </div>
                  <div className="flex items-baseline gap-1">
                    <dt className="inline-flex items-center gap-1">
                      <span className="size-1.5 rounded-full bg-success" aria-hidden />
                      {settled.label}
                    </dt>
                    <dd data-testid="settlement-received" className="font-semibold text-success">{money(settled.value)}</dd>
                  </div>
                </dl>
              )}
            </div>
          </div>
        )}
      </div>

      {/* 2 · Overall with the person — both directions, each its own obligation */}
      <div className="min-w-0 py-0.5 lg:border-l lg:border-border-strong/60 lg:pl-5">
        <ColumnLabel icon={<Scale className="size-3" strokeWidth={2.25} aria-hidden />}>Overall with {firstName}</ColumnLabel>
        <dl className="mt-2 space-y-1.5 text-[12.5px] tabular-nums" aria-label="Balance summary">
          <div className="flex items-center gap-2">
            <SideDot on={overall.toReceive > 0} tone="receivable" icon={<ArrowDownLeft className="size-3" strokeWidth={2.5} aria-hidden />} />
            <dt className="text-foreground/75">You need to receive</dt>
            <Leader />
            <dd className={cn("font-heading text-[16px] leading-none font-bold", overall.toReceive > 0 ? "text-settle-receivable-text" : "text-foreground/40")}>{money(overall.toReceive)}</dd>
          </div>
          <div className="flex items-center gap-2">
            <SideDot on={overall.toGive > 0} tone="payable" icon={<ArrowUpRight className="size-3" strokeWidth={2.5} aria-hidden />} />
            <dt className="text-foreground/75">You need to give</dt>
            <Leader />
            <dd className={cn("font-heading text-[16px] leading-none font-bold", overall.toGive > 0 ? "text-settle-payable-text" : "text-foreground/40")}>{money(overall.toGive)}</dd>
          </div>
          {hasAdvance && (
            <div className="flex items-baseline justify-between gap-2 border-t border-dashed border-border-strong/70 pt-1.5">
              <dt className="text-foreground/75">{overall.advance < 0 ? "Advance held" : "Advance you paid"}</dt>
              <dd className="font-semibold text-settle-advance-text">{money(Math.abs(overall.advance))}</dd>
            </div>
          )}
        </dl>
      </div>

      {/* 3 · EMI responsibility, or where the cycle's total came from */}
      <div className="min-w-0 py-0.5 lg:border-l lg:border-border-strong/60 lg:pl-5">
        {third ?? (
        <>
        <ColumnLabel icon={<CalendarClock className="size-3" strokeWidth={2.25} aria-hidden />}>This cycle</ColumnLabel>
        {loading ? (
          <Skeleton className="mt-2 h-10 w-full" />
        ) : (
          <dl className="mt-2 space-y-1.5 text-[12.5px] tabular-nums">
            <div className="flex items-baseline gap-2">
              <dt className="text-foreground/75">Brought forward</dt>
              <Leader />
              <dd className={cn("font-semibold", Math.abs(statement.previousPending) >= 0.005 ? "text-settle-carried-text" : "text-foreground/45")}>{money(Math.abs(statement.previousPending))}</dd>
            </div>
            <div className="flex items-baseline gap-2">
              <dt className="text-foreground/75">Added this cycle</dt>
              <Leader />
              <dd className="font-semibold text-foreground">{money(Math.abs(statement.cycleActivity))}</dd>
            </div>
          </dl>
        )}
        </>
        )}
      </div>
    </div>
  );
}

/** A small round marker for one side of the balance — tinted when that side holds money, quiet when it is zero. */
function SideDot({ on, tone, icon }: { on: boolean; tone: "receivable" | "payable"; icon: React.ReactNode }) {
  return (
    <span className={cn("grid size-5 shrink-0 place-items-center rounded-full", on ? (tone === "receivable" ? "bg-settle-receivable-badge text-settle-receivable-text" : "bg-settle-payable-badge text-settle-payable-text") : "bg-secondary text-foreground/35")}>{icon}</span>
  );
}

/** A label + rows block for the strip's third column, styled like the others. */
export function StripColumn({ label, rows }: { label: string; rows: { label: string; value: React.ReactNode; tone?: string }[] }) {
  return (
    <>
      <ColumnLabel>{label}</ColumnLabel>
      <dl className="mt-2 space-y-1.5 text-[12.5px] tabular-nums">
        {rows.map((r) => (
          <div key={r.label} className="flex items-baseline gap-2">
            <dt className="truncate text-foreground/75">{r.label}</dt>
            <Leader />
            <dd className={cn("shrink-0 font-semibold text-foreground", r.tone)}>{r.value}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}

/**
 * The Overview's "This cycle" card — the full reconciliation (previous + added − payments = pending) open by default,
 * with the engine's line-by-line calculation one click away. Presentational: the same components as before.
 */
export function CycleSummaryCard({ statement, isLoading, highlights }: { statement: PersonCycleStatement | null; isLoading: boolean; highlights?: React.ReactNode }) {
  if (isLoading || statement == null) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
      </div>
    );
  }
  return (
    <div>
      {highlights && <div className="mb-2 flex flex-wrap items-center gap-1.5 empty:hidden">{highlights}</div>}
      <CycleReconciliation statement={statement} personName={statement.personName} />
      <details className="group mt-2 border-t border-border-strong/50 pt-1.5">
        <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded-[6px] text-xs font-semibold text-foreground/65 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          How is this calculated?
          <ChevronDown className="size-3.5 transition-transform duration-200 group-open:rotate-180" strokeWidth={1.75} />
        </summary>
        <div className="mt-2 space-y-3 duration-200 animate-in fade-in-0">
          <StatementBreakdown statement={statement} />
          <StatementCalculation statement={statement} />
        </div>
      </details>
    </div>
  );
}
