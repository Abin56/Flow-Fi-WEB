"use client";

import { ArrowDownLeft, ArrowUpRight } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { repaymentMix } from "@/features/people/lib/repayment-mix";
import { cyclePosition } from "@/features/people/lib/settlement-presentation";
import type { PersonCycleStatement } from "@/lib/engines/person-cycle-statement";
import { formatCycleLabel } from "@/lib/engines/person-cycle-statement";
import { money } from "@/lib/engines/person-cycle-statement-share";
import { cn } from "@/lib/utils";

const TERM_LABEL: Record<string, string> = {
  previous: "Previous balance",
  added: "New this cycle",
  received: "Received",
  paid: "Paid",
  advanceApplied: "Covered by advance",
};

export function PersonBalanceStory({ statement, personName, isLoading }: { statement: PersonCycleStatement | null; personName: string; isLoading: boolean }) {
  if (isLoading || !statement) {
    return (
      <section aria-label="This cycle">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="mt-3 h-7 w-full max-w-xl" />
        <Skeleton className="mt-3 h-1.5 w-full" />
      </section>
    );
  }

  const firstName = personName.split(" ")[0];
  const pos = cyclePosition(statement, personName);
  const bothSides = statement.toReceive > 0 && statement.toGive > 0;
  const totalDue = statement.previousPending + statement.cycleActivity;
  // Display changes in the direction of the remaining balance, or the amount originally due for a settled cycle.
  const frame = Math.abs(statement.currentPending) >= 0.005 ? Math.sign(statement.currentPending) : Math.abs(totalDue) >= 0.005 ? Math.sign(totalDue) : 1;
  const terms = pos.lines
    .filter((l) => l.key !== "current")
    .filter((l) => l.key === "previous" || l.key === "added" || l.value >= 0.005)
    .map((l) => ({ ...l, label: TERM_LABEL[l.key] ?? l.label, negative: l.signed * frame < -0.0001 }));

  const mix = repaymentMix(statement);
  const paymentSides = [
    { id: "in", label: `Received from ${firstName}`, icon: ArrowDownLeft, ...mix.in },
    { id: "out", label: `Paid to ${firstName}`, icon: ArrowUpRight, ...mix.out },
  ].filter((side) => side.total >= 0.005);
  const remainingTone = statement.direction === "theyOwe" ? "text-settle-receivable-text" : statement.direction === "iOwe" ? "text-settle-payable-text" : "text-success";

  return (
    <section aria-label="This cycle" data-testid="person-overview-cycle" className="min-w-0">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
        <h3 className="text-sm font-semibold text-foreground">This cycle</h3>
        <p className="text-xs text-muted-foreground tabular-nums">{formatCycleLabel(statement.cycle)}</p>
      </div>
      <div>
        {bothSides && <p className="mb-2 text-xs font-semibold text-foreground">Net activity</p>}
        <dl className="space-y-2 text-sm">
          {terms.map((term, index) => (
            <div key={term.key} className="flex items-baseline justify-between gap-3">
              <dt className="text-muted-foreground">{term.label}</dt>
              <dd className="text-right font-semibold text-foreground tabular-nums">
                {term.value >= 0.005 && (term.negative ? "− " : index > 0 ? "+ " : "")}{money(term.value)}
              </dd>
            </div>
          ))}
          <div className="space-y-1.5 border-t border-border pt-2.5 font-semibold">
            {bothSides ? (
              <>
                <div className="flex items-baseline justify-between gap-3 text-settle-receivable-text">
                  <dt>To receive</dt>
                  <dd className="font-heading text-lg font-bold tabular-nums">{money(statement.toReceive)}</dd>
                </div>
                <div className="flex items-baseline justify-between gap-3 text-settle-payable-text">
                  <dt>To pay</dt>
                  <dd className="font-heading text-lg font-bold tabular-nums">{money(statement.toGive)}</dd>
                </div>
              </>
            ) : (
              <div className={cn("flex items-baseline justify-between gap-3", remainingTone)}>
                <dt>
                  {statement.direction === "settled" ? "Settled" : "Remaining"}
                  {statement.direction !== "settled" && <span className="block text-xs font-medium text-muted-foreground">{statement.direction === "theyOwe" ? "To receive" : "To pay"}</span>}
                </dt>
                <dd className="text-right font-heading text-xl font-bold tabular-nums">{money(statement.amount)}</dd>
              </div>
            )}
          </div>
        </dl>

        <div data-testid="person-overview-repayments" className="mt-3 space-y-2">
          {paymentSides.length === 0 && <p className="text-xs text-muted-foreground">No payments recorded this cycle.</p>}
          {paymentSides.map(({ id, label, icon: Icon, total, toItems, toBalance, toAdvance }) => (
            <dl key={id} className="space-y-1.5 border-t border-border-subtle pt-2.5 text-xs">
              <div className="flex items-start justify-between gap-2 font-semibold text-foreground">
                <dt className="flex items-center gap-1.5">
                  <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  {label}
                </dt>
                <dd className="text-right tabular-nums">{money(total)}</dd>
              </div>
              <PaymentLine label="To specific items" value={toItems} />
              <PaymentLine label="Toward overall balance" value={toBalance} />
              {toAdvance >= 0.005 && <PaymentLine label="Held as advance" value={toAdvance} />}
            </dl>
          ))}
        </div>
      </div>
    </section>
  );
}

function PaymentLine({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium text-foreground tabular-nums">{money(value)}</dd>
    </div>
  );
}
