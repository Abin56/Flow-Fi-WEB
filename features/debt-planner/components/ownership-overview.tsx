"use client";

import { Users } from "lucide-react";
import type { DebtSnapshot, requiredByOwnership } from "@/lib/engines/debt-position";
import { cn } from "@/lib/utils";
import { Label, Money } from "./planner-ui";

/**
 * Whose debt is it? A VIEW over the planner snapshot — never a change to it. The lender / card issuer
 * still holds you liable for the full total; "Others' share" is what the people it was for owe you back.
 * Every figure comes from `DebtPosition.ownership` (`lib/engines/debt-ownership.ts`).
 */

export type DebtView = "mine" | "all" | "others";

const VIEWS: { value: DebtView; label: string }[] = [
  { value: "mine", label: "My debt" },
  { value: "all", label: "All liabilities" },
  { value: "others", label: "Others' share" },
];

export function DebtViewSelector({ value, onChange }: { value: DebtView; onChange: (v: DebtView) => void }) {
  return (
    <div role="radiogroup" aria-label="Debt view" className="inline-flex h-9 overflow-hidden rounded-[6px] border border-border-strong bg-card">
      {VIEWS.map((v, i) => {
        const active = v.value === value;
        return (
          <button
            key={v.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(v.value)}
            className={cn(
              "px-3 text-[13px] font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
              i > 0 && "border-l border-border-strong",
              active ? "bg-primary text-primary-foreground" : "text-foreground hover:bg-secondary",
            )}
          >
            {v.label}
          </button>
        );
      })}
    </div>
  );
}

function Cell({ label, amount, note, emphasis, tone }: { label: string; amount: number; note?: string; emphasis?: boolean; tone?: "people" }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-0.5 border-border px-4 py-3 sm:border-l sm:first:border-l-0", tone === "people" && "border-l-[3px] border-l-purple sm:border-l-[3px] sm:border-l-purple")}>
      <Label>{label}</Label>
      <Money amount={amount} className={cn("tabular-nums text-foreground", emphasis ? "text-[22px] font-bold" : "text-[17px] font-semibold")} />
      {note && <p className="text-xs text-foreground/80">{note}</p>}
    </div>
  );
}

export function OwnershipOverview({
  snapshot,
  requiredSplit,
  view,
  onView,
}: {
  snapshot: DebtSnapshot;
  requiredSplit: ReturnType<typeof requiredByOwnership>;
  view: DebtView;
  onView: (v: DebtView) => void;
}) {
  const o = snapshot.ownership;
  const shared = o.others > 0;
  return (
    <section aria-labelledby="dp-ownership" className="overflow-hidden rounded-[8px] border border-border-strong bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <Users className="size-4 shrink-0 text-foreground" strokeWidth={2} />
          <h2 id="dp-ownership" className="font-heading text-[15px] font-semibold tracking-tight text-foreground">
            Whose debt is it?
          </h2>
        </div>
        <DebtViewSelector value={view} onChange={onView} />
      </div>

      <div className="grid grid-cols-1 divide-y divide-border sm:grid-cols-3 sm:divide-y-0">
        <Cell label="Total liability" amount={snapshot.total} note="Everything lenders and card issuers hold you liable for" />
        <Cell label="My debt" amount={o.mine} emphasis note={shared ? "Your own share — the planning number" : "All of it is yours"} />
        <Cell label="Others' share" amount={o.others} tone={shared ? "people" : undefined} note={shared ? "Expected back from people" : "Nothing assigned to people"} />
      </div>

      {(shared || requiredSplit.fromPeople > 0) && (
        <div className="grid gap-0 border-t border-border lg:grid-cols-2">
          <div className="px-4 py-3">
            <Label>Payments due to lenders this cycle</Label>
            <dl className="mt-1.5 text-[13px]">
              <Line label="You still need to pay lenders" amount={requiredSplit.required} strong />
              <Line label="Your economic share" amount={requiredSplit.mine} />
              <Line label="Expected from people" amount={requiredSplit.fromPeople} />
            </dl>
            <p className="mt-1.5 text-xs text-foreground/80">
              The lender expects the full amount on time, whoever it was for. Payoff dates below plan these full payments.
            </p>
          </div>
          {o.byPerson.length > 0 && (
            <div className="border-t border-border px-4 py-3 lg:border-t-0 lg:border-l">
              <Label>Others owe you (inside these debts)</Label>
              <dl className="mt-1.5 text-[13px]">
                {o.byPerson.map((p) => (
                  <Line key={p.personId} label={`${p.name}'s share`} amount={p.amount} />
                ))}
              </dl>
            </div>
          )}
        </div>
      )}
      {o.unallocated > 0 && (
        <p className="border-t border-border px-4 py-2 text-xs text-foreground/80">
          <Money amount={o.unallocated} /> can&apos;t be assigned from your records and is counted as yours.
        </p>
      )}
    </section>
  );
}

function Line({ label, amount, strong }: { label: string; amount: number; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border/70 py-1.5 last:border-b-0">
      <dt className={cn("min-w-0 text-foreground", strong && "font-semibold")}>{label}</dt>
      <dd className={cn("shrink-0 tabular-nums text-foreground", strong ? "font-bold" : "font-semibold")}>
        <Money amount={amount} />
      </dd>
    </div>
  );
}
