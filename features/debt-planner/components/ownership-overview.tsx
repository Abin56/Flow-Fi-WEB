"use client";

import { Users } from "lucide-react";
import type { DebtSnapshot, requiredByOwnership } from "@/lib/engines/debt-position";
import { cn } from "@/lib/utils";
import { Label, Money } from "./planner-ui";

/**
 * Whose debt is it? A VIEW over the planner snapshot — never a change to it. The lender / card issuer
 * still holds you liable for the full total; "Others' share" is the part of that lender debt economically
 * ALLOCATED to the people it was for — ownership, not a receivable: someone who already reimbursed you
 * still has a share here until the lender is paid. What a person still owes you is People's figure.
 * Every figure comes from `DebtPosition.ownership` (`lib/engines/debt-ownership.ts`). Card attributions
 * use the card's overall mine/others ratio, so they are labelled as estimates.
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
  // What I separately owe each person (their own People position) — a separate offset, never subtracted
  // from their gross ownership.
  const owedTo = new Map(snapshot.positions.filter((p) => p.sourceType === "person").map((p) => [p.sourceId, p.outstanding]));
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
        <Cell label="Others' share" amount={o.others} tone={shared ? "people" : undefined} note={shared ? "Lender debt allocated to others — not what they owe you now (see People)" : "Nothing assigned to people"} />
      </div>

      {(shared || requiredSplit.fromPeople > 0) && (
        <div className="grid gap-0 border-t border-border lg:grid-cols-2">
          <div className="px-4 py-3">
            <Label>Payments due to lenders this cycle</Label>
            <dl className="mt-1.5 text-[13px]">
              <Line label="You still need to pay lenders" amount={requiredSplit.required} strong />
              <Line label="Your economic share" amount={requiredSplit.mine} />
              <Line label="Others' allocated share" amount={requiredSplit.fromPeople} />
            </dl>
            <p className="mt-1.5 text-xs text-foreground/80">
              The lender expects the full amount on time, whoever it was for. Payoff dates below plan these full payments.
              Money people have already given you is tracked in People and is not deducted here. Card splits are estimated
              from each card&apos;s overall share.
            </p>
          </div>
          {o.byPerson.length > 0 && (
            <div className="border-t border-border px-4 py-3 lg:border-t-0 lg:border-l">
              <Label>Allocated to others (ownership, not receivable)</Label>
              <dl className="mt-1.5 text-[13px]">
                {o.byPerson.map((p) => {
                  const offset = owedTo.get(p.personId) ?? 0;
                  const net = Math.round((p.amount - offset) * 100) / 100;
                  return (
                    <div key={p.personId} className="border-b border-border/70 py-1.5 last:border-b-0">
                      <div className="flex items-baseline justify-between gap-3">
                        <dt className="min-w-0 text-foreground">Caused by {p.name}</dt>
                        <dd className="shrink-0 font-semibold tabular-nums text-foreground">
                          <Money amount={p.amount} />
                        </dd>
                      </div>
                      {offset > 0 && (
                        <p className="mt-0.5 text-xs text-foreground/80">
                          Separately, you owe {p.name} <Money amount={offset} /> (People) · net <Money amount={Math.abs(net)} />{" "}
                          {net > 0 ? `from ${p.name}` : net < 0 ? `to ${p.name}` : "even"}
                        </p>
                      )}
                    </div>
                  );
                })}
              </dl>
              <p className="mt-1.5 text-xs text-foreground/80">
                Gross ownership. Anything you owe a person is its own debt and never reduces their share here.
              </p>
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
