"use client";

import { forwardRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowRight, Check, CheckCircle2, ChevronDown, Loader2 } from "lucide-react";
import {
  peopleSettleHref,
  settleActionFor,
  type LinkedPeopleReadiness,
  type LinkedPerson,
  type PeopleSettlementGate,
} from "@/lib/engines/linked-people-readiness";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";

/** "AMMA", "AMMA and ANU", "AMMA, ANU and JOHN". */
function namesOf(people: readonly LinkedPerson[]): string {
  const names = people.map((p) => p.personName);
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** The blocked lender payment's one primary action — "Settle ₹1,000 with AMMA". */
export function settleCtaLabel(gate: PeopleSettlementGate): string {
  return gate.next ? `Settle ${formatCurrency(gate.next.amount)} with ${gate.next.personName}` : "Resolve People payment";
}

export interface PeopleSettlementCardProps {
  readiness: LinkedPeopleReadiness | null;
  gate: PeopleSettlementGate;
  /** People statements still loading — the gate is unknown, so the payment waits. */
  loading?: boolean;
  /** What the lender asks for, e.g. "Bill", "EMI due", "Installment #3 due". */
  dueLabel: string;
  /** What these obligations are linked to, e.g. "this card bill", "this EMI installment". */
  subject: string;
  /** Who gets paid once People is settled, e.g. "OCTANE". */
  payeeName: string;
  /** In-app path People returns to after the settlement is recorded. */
  returnTo?: string;
  className?: string;
}

/**
 * Lender-payment screens (card bill / Loan / EMI): the People settlement step that must complete before the
 * lender can be paid. Blocked → one row per person still to pay, each with the exact Settle deep link; settled →
 * a compact confirmation. The full accounting breakdown stays one click away. The ref is the first Settle link
 * (what Enter focuses while the payment is blocked).
 */
export const PeopleSettlementCard = forwardRef<HTMLAnchorElement, PeopleSettlementCardProps>(function PeopleSettlementCard(
  { readiness, gate, loading = false, dueLabel, subject, payeeName, returnTo, className },
  firstSettleRef,
) {
  const [breakdownOpen, setBreakdownOpen] = useState(false);
  const hasPeople = readiness != null && readiness.people.length > 0;

  if (!hasPeople) {
    if (!loading) return null;
    return (
      <p role="status" className={cn("flex items-center gap-2 rounded-[8px] border border-border-strong bg-secondary px-3 py-2 text-xs font-medium text-foreground/80", className)}>
        <Loader2 className="size-3.5 animate-spin" aria-hidden /> Checking linked People…
      </p>
    );
  }

  const blocked = gate.blocked;
  const multiple = gate.attention.length > 1;
  return (
    <section
      aria-label="People settlement"
      data-state={blocked ? "blocked" : "settled"}
      className={cn(
        "overflow-hidden rounded-[8px] border border-l-[4px] border-border-strong bg-card text-sm",
        blocked ? "border-l-warning" : "border-l-success",
        className,
      )}
    >
      <header className={cn("flex items-center justify-between gap-2 px-3 pt-2.5 pb-1.5", blocked ? "bg-warning/10" : "bg-success/10")}>
        <span className="inline-flex items-center gap-1.5 text-[11px] font-bold tracking-[0.06em] text-foreground uppercase">
          {blocked ? <AlertTriangle className="size-3.5 text-warning-foreground dark:text-warning" aria-hidden /> : <CheckCircle2 className="size-3.5 text-success" aria-hidden />}
          {blocked ? (multiple ? "People settlement" : "People payment pending") : "People settled"}
        </span>
        {/* "Linked to …" repeats the sentence below — dropped on phones so the header never wraps; the count always shows. */}
        <span className={cn("shrink-0 text-[11px] font-semibold text-foreground/80", !(blocked && multiple) && "hidden min-[480px]:inline")}>
          {blocked ? (multiple ? `${gate.attention.length} need attention` : `Linked to ${subject}`) : `Linked to ${subject}`}
        </span>
      </header>

      <ul className="divide-y divide-border-strong/50 border-y border-border-strong/50">
        {gate.attention.map((p, i) => {
          const action = settleActionFor(p);
          return (
            <li key={p.personId} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold text-foreground uppercase">{p.personName}</p>
                <p className="text-[11.5px] leading-snug text-foreground/75">
                  {p.state === "partial" ? `${formatCurrency(p.received)} of ${formatCurrency(p.share)} received · ${formatCurrency(p.remaining)} remaining` : "Not received yet"}
                  {p.obligations.length > 1 ? ` · ${p.obligations.length} items` : ""}
                </p>
              </div>
              <span className="font-bold text-foreground tabular-nums">{formatCurrency(p.remaining)}</span>
              <Link
                ref={i === 0 ? firstSettleRef : undefined}
                href={peopleSettleHref(action.personId, action.obligationKey, returnTo)}
                aria-label={`Settle ${formatCurrency(action.amount)} with ${p.personName}`}
                className="inline-flex h-8 shrink-0 items-center gap-1 rounded-[6px] border border-warning-foreground/70 bg-warning/20 px-2.5 text-xs font-bold text-foreground outline-none transition-colors hover:bg-warning/30 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 dark:border-warning/80"
              >
                Settle <ArrowRight className="size-3" aria-hidden />
              </Link>
            </li>
          );
        })}
        {gate.resolved.map((p) => (
          <li key={p.personId} className="flex items-center gap-3 px-3 py-1.5">
            <p className="min-w-0 flex-1 truncate font-semibold text-foreground uppercase">{p.personName}</p>
            <span className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-success">
              <span className="text-foreground tabular-nums">{formatCurrency(p.share)}</span> received
              <Check className="size-3.5" strokeWidth={2.5} aria-hidden />
            </span>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2">
        <p className="min-w-0 text-xs font-medium text-foreground">
          {blocked ? (
            <>
              <span className="font-bold tabular-nums">{formatCurrency(gate.outstanding)}</span> must be recorded from {namesOf(gate.attention)} before {subject} can be paid.
            </>
          ) : (
            <>Ready to pay {payeeName}.</>
          )}
        </p>
        <button
          type="button"
          onClick={() => setBreakdownOpen((v) => !v)}
          aria-expanded={breakdownOpen}
          className="-mr-1 inline-flex h-7 shrink-0 items-center gap-1 rounded-[6px] px-1 text-xs font-semibold text-foreground/80 outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          {breakdownOpen ? "Hide breakdown" : "View breakdown"}
          <ChevronDown className={cn("size-3.5 transition-transform", breakdownOpen && "rotate-180")} aria-hidden />
        </button>
      </div>

      {breakdownOpen && (
        <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 border-t border-border-strong/50 bg-secondary/60 px-3 py-2 text-xs">
          <dt className="text-foreground/75">{dueLabel}</dt>
          <dd className="text-right font-bold text-foreground tabular-nums">{formatCurrency(readiness.lenderDue)}</dd>
          <dt className="text-foreground/75">People share</dt>
          <dd className="text-right font-semibold text-foreground tabular-nums">{formatCurrency(readiness.peopleShare)}</dd>
          <dt className="text-foreground/75">Received</dt>
          <dd className="text-right font-semibold text-foreground tabular-nums">{formatCurrency(readiness.received)}</dd>
          <dt className="text-foreground/75">Remaining</dt>
          <dd className="text-right font-semibold text-foreground tabular-nums">{formatCurrency(readiness.stillExpected)}</dd>
          <dt className="text-foreground/75">Your share</dt>
          <dd className="text-right font-semibold text-foreground tabular-nums">{formatCurrency(readiness.yourPortion)}</dd>
        </dl>
      )}
    </section>
  );
});
