"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { settlementFigures } from "@/features/people/components/workspace/settlement-summary";
import { repaymentMix } from "@/features/people/lib/repayment-mix";
import { cyclePosition } from "@/features/people/lib/settlement-presentation";
import type { PersonCycleStatement } from "@/lib/engines/person-cycle-statement";
import { formatCycleLabel } from "@/lib/engines/person-cycle-statement";
import { money } from "@/lib/engines/person-cycle-statement-share";
import { cn } from "@/lib/utils";

/**
 * The Overview's cycle maths on one line: previous ± new this cycle − payments = remaining — every term is a line of
 * the engine's own `cyclePosition` (the same lines the full reconciliation lists), shown in the frame of the person's
 * direction, so the operators are honest (+ adds to what is owed, − takes from it). A slim bar shows how much of what
 * was due is settled, and the payments are split into "to specific items" and "toward the overall balance" (general
 * payments), never merged. Display only — nothing is recomputed, written or netted.
 */

const TERM_LABEL: Record<string, string> = {
  previous: "Previous",
  added: "New this cycle",
  received: "Received",
  paid: "Paid",
  advanceApplied: "From advance",
};

export function PersonBalanceStory({ statement, personName, isLoading }: { statement: PersonCycleStatement | null; personName: string; isLoading: boolean }) {
  if (isLoading || !statement) {
    return (
      <section className="rounded-[14px] border border-border bg-card px-4 py-3.5 shadow-e1">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="mt-3 h-7 w-full max-w-xl" />
        <Skeleton className="mt-3 h-1.5 w-full" />
      </section>
    );
  }

  const first = personName.split(" ")[0];
  const pos = cyclePosition(statement, personName);
  const bothSides = statement.toReceive > 0 && statement.toGive > 0;
  const totalDue = statement.previousPending + statement.cycleActivity;
  // Frame: the person's direction (what they owe you = +). Settled → the direction things were due in.
  const frame = Math.abs(statement.currentPending) >= 0.005 ? Math.sign(statement.currentPending) : Math.abs(totalDue) >= 0.005 ? Math.sign(totalDue) : 1;
  const terms = pos.lines
    .filter((l) => l.key !== "current")
    .filter((l) => l.key === "previous" || l.key === "added" || l.value >= 0.005)
    .map((l) => ({ key: l.key, label: TERM_LABEL[l.key] ?? l.label, value: l.value, op: l.signed * frame < -0.0001 ? "−" : "+" }));

  const inbound = frame > 0;
  const mix = repaymentMix(statement)[inbound ? "in" : "out"];
  const applied = pos.lines.find((l) => l.key === "advanceApplied")?.value ?? 0;
  const due = Math.abs(totalDue);
  // Same figures as the header ring (`settlementFigures`: settled ÷ total), so the two never disagree.
  const figures = settlementFigures(statement, personName);
  const pct = figures && figures[0].value >= 0.005 ? Math.min(100, (figures[1].value / figures[0].value) * 100) : statement.direction === "settled" ? 100 : 0;
  const remainingTone = statement.direction === "theyOwe" ? "text-settle-receivable-text" : statement.direction === "iOwe" ? "text-settle-payable-text" : "text-success";

  return (
    <section aria-label="This cycle" data-testid="person-overview-cycle" className="rounded-[14px] border border-border bg-card px-4 pt-3 pb-3.5 shadow-e1">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-[12px] font-semibold text-foreground">
          This cycle <span className="font-medium text-muted-foreground">· {formatCycleLabel(statement.cycle)}</span>
        </p>
        <p className="text-[11.5px] text-muted-foreground">{pos.headline}</p>
      </div>

      {/* The equation */}
      <dl className="mt-2.5 flex flex-wrap items-end gap-x-4 gap-y-2">
        {terms.map((t, i) => (
          <div key={t.key} className="flex items-end gap-4">
            {i > 0 && (
              <span className="pb-0.5 font-heading text-lg leading-none text-muted-foreground/70" aria-hidden>
                {t.op}
              </span>
            )}
            <div className="flex flex-col gap-0.5">
              <dt className="text-[11px] font-medium text-muted-foreground">
                {i === 0 && t.op === "−" ? `${t.label} (you owed)` : t.label}
              </dt>
              <dd className={cn("font-heading text-[17px] leading-none font-bold tabular-nums", t.value < 0.005 ? "text-muted-foreground/50" : t.key === "previous" ? "text-settle-carried-text" : "text-foreground")}>
                {money(t.value)}
              </dd>
            </div>
          </div>
        ))}
        <span className="pb-0.5 font-heading text-lg leading-none text-muted-foreground/70" aria-hidden>
          =
        </span>
        {bothSides ? (
          <div className="flex items-end gap-4">
            <div className="flex flex-col gap-0.5">
              <dt className="text-[11px] font-medium text-settle-receivable-text">To receive</dt>
              <dd className="font-heading text-[22px] leading-none font-bold text-settle-receivable-text tabular-nums">{money(statement.toReceive)}</dd>
            </div>
            <div className="flex flex-col gap-0.5">
              <dt className="text-[11px] font-medium text-settle-payable-text">To give</dt>
              <dd className="font-heading text-[22px] leading-none font-bold text-settle-payable-text tabular-nums">{money(statement.toGive)}</dd>
            </div>
            <p className="pb-0.5 text-[11px] text-muted-foreground">each side is settled separately</p>
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            <dt className={cn("text-[11px] font-semibold", remainingTone)}>{statement.direction === "settled" ? "Settled" : "Remaining"}</dt>
            <dd className={cn("font-heading text-[22px] leading-none font-bold tabular-nums", remainingTone)}>{money(statement.amount)}</dd>
          </div>
        )}
      </dl>

      {/* How much of what was due is settled — and how the payments were applied (kept apart) */}
      {due >= 0.005 && (
        <div className="mt-3 flex flex-col gap-1.5">
          <div
            role="img"
            aria-label={`${Math.round(pct)}% of what was due is settled`}
            className="flex h-1.5 w-full gap-[2px] overflow-hidden rounded-full bg-secondary"
          >
            {mix.toItems >= 0.005 && <span className="h-full bg-success" style={{ flexGrow: mix.toItems }} title={`To specific items · ${money(mix.toItems)}`} />}
            {mix.toBalance >= 0.005 && <span className="h-full bg-settle-receivable-edge" style={{ flexGrow: mix.toBalance }} title={`Toward overall balance · ${money(mix.toBalance)}`} />}
            {applied >= 0.005 && <span className="h-full bg-settle-advance-edge" style={{ flexGrow: applied }} title={`From advance · ${money(applied)}`} />}
            {statement.amount >= 0.005 && <span className="h-full bg-transparent" style={{ flexGrow: statement.amount }} />}
          </div>
          <div data-testid="person-overview-repayments" className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-muted-foreground">
            <span className="font-medium text-foreground/80">
              {inbound ? `Received from ${first}` : `Paid to ${first}`} <b className="font-semibold text-foreground tabular-nums">{money(mix.total)}</b>
            </span>
            <Legend dot="bg-success" label="To specific items" value={mix.toItems} />
            <Legend dot="bg-settle-receivable-edge" label="Toward overall balance" value={mix.toBalance} />
            {mix.toAdvance >= 0.005 && <Legend dot="bg-settle-advance-edge" label="Held as advance" value={mix.toAdvance} />}
            {applied >= 0.005 && <Legend dot="bg-settle-advance-edge" label="Used from advance" value={applied} />}
            {figures && <span className="ml-auto tabular-nums">{Math.round(pct)}% settled</span>}
          </div>
        </div>
      )}
    </section>
  );
}

function Legend({ dot, label, value }: { dot: string; label: string; value: number }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5", value < 0.005 && "opacity-50")}>
      <span className={cn("size-2 rounded-[3px]", dot)} aria-hidden />
      {label} <span className="font-semibold text-foreground tabular-nums">{money(value)}</span>
    </span>
  );
}
