"use client";

import { Info } from "lucide-react";
import { CyclePaymentHistory } from "@/features/people/components/workspace/settlement-summary";
import type { GeneralCredit } from "@/features/people/lib/settlement-presentation";
import { repaymentMix, type RepaymentSide } from "@/features/people/lib/repayment-mix";
import type { PersonCycleStatement } from "@/lib/engines/person-cycle-statement";
import { money } from "@/lib/engines/person-cycle-statement-share";
import { cn } from "@/lib/utils";

const SEGMENTS = [
  { key: "toItems", label: "Applied to items", hint: "Tied to a specific installment, share or entry — that item shows it as paid.", bar: "bg-success", dot: "bg-success" },
  { key: "toBalance", label: "Toward overall balance", hint: "Paid without choosing items — lowers the overall balance; items stay open and read “Part of balance”.", bar: "bg-settle-receivable-edge", dot: "bg-settle-receivable-edge" },
  { key: "toAdvance", label: "Held as advance", hint: "Paid ahead — kept for the next obligations until you apply it.", bar: "bg-settle-advance-edge", dot: "bg-settle-advance-edge" },
] as const;

function MixBar({ side, title }: { side: RepaymentSide; title: string }) {
  const parts = SEGMENTS.filter((s) => side[s.key] >= 0.005);
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[12px] font-semibold text-foreground/80">{title}</p>
        <p className="font-heading text-[15px] font-bold text-foreground tabular-nums">{money(side.total)}</p>
      </div>
      <div className="mt-1.5 flex h-2 gap-0.5 overflow-hidden rounded-full bg-border-strong/40" aria-hidden>
        {parts.map((s) => (
          <span key={s.key} className={cn("h-full transition-[flex-grow] duration-700 ease-out first:rounded-l-full last:rounded-r-full", s.bar)} style={{ flexGrow: side[s.key] }} />
        ))}
      </div>
      <dl className="mt-2 grid grid-cols-3 gap-x-3">
        {SEGMENTS.map((s) => (
          <div key={s.key} className={cn("min-w-0", side[s.key] < 0.005 && "opacity-45")} title={s.hint}>
            <dt className="flex items-center gap-1.5 truncate text-[10.5px] font-semibold text-foreground/60">
              <span className={cn("size-2 shrink-0 rounded-[3px]", s.dot)} aria-hidden />
              {s.label}
            </dt>
            <dd className="pl-3.5 text-[13px] font-semibold text-foreground tabular-nums">
              {money(side[s.key])}
              {s.key === "toItems" && side.itemCount > 0 && <span className="ml-1 text-[11px] font-medium text-foreground/50">· {side.itemCount}</span>}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/**
 * Repayments · this cycle: where the person's payments went — applied to specific items vs. toward the overall balance
 * (general payments) vs. held as advance — then each payment with its allocation. Grouped from the statement's own
 * payment rows; the all-time "toward overall balance" line is the existing `GeneralCredit`.
 */
export function PersonRepaymentsCard({
  statement,
  personName,
  generalCredit,
  accountForEntry,
  incomeForEntry,
}: {
  statement: PersonCycleStatement | null;
  personName: string;
  generalCredit: GeneralCredit | null;
  accountForEntry: (entryId: string | null) => string | null;
  incomeForEntry?: (entryId: string | null) => number;
}) {
  const first = personName.split(" ")[0];
  if (!statement) return null;
  const mix = repaymentMix(statement);
  const any = mix.in.total >= 0.005 || mix.out.total >= 0.005;
  const untied = generalCredit && generalCredit.theyOwe.credit >= 0.005 ? generalCredit.theyOwe : null;
  return (
    <div className="space-y-3">
      {any ? (
        <>
          {mix.in.total >= 0.005 && <MixBar side={mix.in} title={`Received from ${first}`} />}
          {mix.out.total >= 0.005 && <MixBar side={mix.out} title={`Paid to ${first}`} />}
        </>
      ) : (
        <p className="text-[12.5px] text-foreground/60">No payments recorded in this cycle.</p>
      )}
      {untied && (
        <p className="flex items-start gap-1.5 rounded-[8px] bg-settle-receivable-tint/55 px-2.5 py-1.5 text-[11.5px] leading-snug text-foreground/80" data-testid="repayments-general-note">
          <Info className="mt-px size-3.5 shrink-0 text-settle-receivable-text" aria-hidden />
          <span>
            All time, {first} paid <b className="font-semibold text-foreground tabular-nums">{money(untied.credit)}</b> toward the overall balance without choosing items —{" "}
            {untied.owed < 0.005 ? "nothing is owed overall." : <><b className="font-semibold text-foreground tabular-nums">{money(untied.owed)}</b> is still owed overall.</>}
          </span>
        </p>
      )}
      {any && (
        <details id="person-payment-history" className="group scroll-mt-16" data-testid="payment-history-details">
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded-[6px] text-xs font-semibold text-foreground/65 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
            <span className="transition-transform duration-200 group-open:rotate-90" aria-hidden>›</span>
            Each payment and what it was applied to
          </summary>
          <CyclePaymentHistory statement={statement} personName={personName} accountForEntry={accountForEntry} incomeForEntry={incomeForEntry} className="mt-1.5 [&>h3]:sr-only" />
        </details>
      )}
    </div>
  );
}
