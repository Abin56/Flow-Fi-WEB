"use client";

import Link from "next/link";
import { Loader2 } from "lucide-react";
import { usePersonPaymentDeferrals } from "@/features/people/hooks/use-payment-deferrals";
import { useMonthCycleStartDay } from "@/features/settings/hooks/use-user-preferences";
import type { InstallmentBreakdown, InstallmentParticipant, ShareLine } from "@/lib/engines/installment-participants";
import { peopleApplyAdvanceHref, peoplePostponeHref, peopleSettleHref } from "@/lib/engines/linked-people-readiness";
import { cycleName, deferralView, type DeferralView } from "@/lib/engines/person-payment-deferral";
import { PAYMENT_EPSILON } from "@/lib/engines/person-payment";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Shared Loan / EMI Record payment: one compact row per person sharing this installment — their share and
 * whether it came in. Read from the People Ledger (`installmentBreakdown`); the lender figures live in the
 * dialog's summary, never repeated here. What happens to a person's share happens in People, through three
 * separate, named links: "Apply advance" (money they already gave — no new money), "Record received" (People
 * Record payment) and "Postpone" (People "Postpone collection"), each written in one place only and each
 * returning to the payment. Paying the lender never settles a person.
 *
 * `selectable` turns the open rows into a single choice (the dialog's "Collect money from others first").
 */
export function InstallmentPeoplePanel({
  breakdown,
  loading,
  returnTo,
  selectable,
  selectedId,
  onSelect,
  className,
}: {
  breakdown: InstallmentBreakdown | null;
  loading: boolean;
  /** In-app path People returns to after recording. */
  returnTo?: string;
  /** People who can be picked (collect first); null/undefined = read-only rows. */
  selectable?: ReadonlySet<string> | null;
  selectedId?: string | null;
  onSelect?: (personId: string) => void;
  className?: string;
}) {
  if (breakdown == null || breakdown.participants.length === 0) {
    if (!loading) return null;
    return (
      <p role="status" className={cn("flex items-center gap-2 text-xs font-medium text-muted-foreground", className)}>
        <Loader2 className="size-3.5 animate-spin" aria-hidden /> Checking who shares this installment…
      </p>
    );
  }
  return (
    <section aria-label="Who pays this installment" className={cn("flex flex-col gap-1.5", className)}>
      <h3 className="text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">Shared with</h3>
      <ul className="flex flex-col divide-y divide-border">
        {breakdown.participants.map((p) => (
          <ParticipantRow
            key={p.personId}
            participant={p}
            returnTo={returnTo}
            selectable={selectable?.has(p.personId) ?? false}
            selected={selectedId === p.personId}
            onSelect={onSelect}
          />
        ))}
      </ul>
    </section>
  );
}

/** A postponed date is never shown as received: passed-and-unpaid reads as such, not as a fresh move. */
function postponedTo(view: DeferralView | null): string | null {
  if (!view) return null;
  if (view.status === "postponed") return `Moved to ${cycleName(view.cycle)} cycle`;
  if (view.status === "expectedNow") return "Expected this cycle";
  if (view.status === "lapsed") return `Was due in ${cycleName(view.cycle)} cycle — still unpaid`;
  return null;
}

function ParticipantRow({
  participant: p,
  returnTo,
  selectable,
  selected,
  onSelect,
}: {
  participant: InstallmentParticipant;
  returnTo?: string;
  selectable: boolean;
  selected: boolean;
  onSelect?: (personId: string) => void;
}) {
  const { deferrals } = usePersonPaymentDeferrals(p.personId);
  const startDay = useMonthCycleStartDay();
  const viewOf = (line: ShareLine): DeferralView | null => {
    const d = deferrals.find((x) => x.obligationKey === line.key);
    return d ? deferralView(d, line.remaining, startDay) : null;
  };
  const firstOpen = [...p.carried, ...(p.current ? [p.current] : [])].find((l) => l.remaining > PAYMENT_EPSILON);
  const cur = p.current;
  const received = cur != null && cur.remaining <= PAYMENT_EPSILON;
  const partial = cur != null && !received && cur.received > PAYMENT_EPSILON;
  const curView = cur ? viewOf(cur) : null;
  const moved = postponedTo(curView);
  const status = cur == null ? null : received ? "Received" : partial ? `${formatCurrency(cur.received)} of ${formatCurrency(cur.share)} received` : "Not received";
  const carriedTotal = p.carried.reduce((t, l) => t + l.remaining, 0);
  const carriedMoved = p.carried.some((l) => viewOf(l)?.status === "postponed");
  const advance = p.advanceHeld ?? 0;

  const body = (
    <>
      {selectable && (
        <span
          aria-hidden
          className={cn("mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border-[1.5px]", selected ? "border-foreground" : "border-border-strong")}
        >
          {selected && <span className="size-2 rounded-full bg-foreground" />}
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-baseline justify-between gap-3">
          <span className="truncate text-sm font-semibold text-foreground uppercase">{p.personName}</span>
          <span className="shrink-0 text-sm font-semibold text-foreground tabular-nums">{formatCurrency(cur?.share ?? carriedTotal)}</span>
        </span>
        {status && (
          <span className="text-xs" data-testid={`share-${p.personId}`}>
            <span className={cn(received ? "font-medium text-success" : partial ? "font-medium text-warning-foreground dark:text-warning" : "text-muted-foreground")}>{status}</span>
            {moved && <span className={curView?.status === "lapsed" ? "text-warning-foreground dark:text-warning" : "text-settle-receivable-text"}> · {moved}</span>}
          </span>
        )}
        {firstOpen && advance > PAYMENT_EPSILON && (
          <span className="text-xs text-settle-advance-text" data-testid={`advance-${p.personId}`}>
            Holding {formatCurrency(advance)} advance from {p.personName} — not applied to this share yet.
          </span>
        )}
        {p.carried.length > 0 && (
          <span className="text-xs text-muted-foreground">
            + {formatCurrency(carriedTotal)} still owed from {p.carried.map((l) => `#${l.sequenceNumber}`).join(", ")}
            {carriedMoved && <span className="text-settle-receivable-text"> · moved to a later cycle</span>}
          </span>
        )}
      </span>
    </>
  );

  return (
    <li className="flex flex-col gap-1 py-2">
      {selectable && onSelect ? (
        <button
          type="button"
          role="radio"
          aria-checked={selected}
          aria-label={`Collect from ${p.personName}`}
          onClick={() => onSelect(p.personId)}
          className="flex min-w-0 flex-1 items-start gap-2.5 rounded-[6px] text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {body}
        </button>
      ) : (
        <span className="flex min-w-0 flex-1 items-start gap-2.5">{body}</span>
      )}
      {/* Three different People operations, each named — none of them touches the lender's installment. */}
      {firstOpen && (advance > PAYMENT_EPSILON || !selectable) && (
        <span className={cn("flex flex-wrap items-center gap-x-1 gap-y-0.5", selectable && "pl-[26px]")} data-testid={`share-actions-${p.personId}`}>
          {advance > PAYMENT_EPSILON && (
            <ShareAction href={peopleApplyAdvanceHref(p.personId, firstOpen.key, returnTo)} label={`Apply ${p.personName}'s ${formatCurrency(advance)} advance in People — no money moves`} tone="advance">
              Apply advance
            </ShareAction>
          )}
          {!selectable && (
            <>
              <ShareAction href={peopleSettleHref(p.personId, firstOpen.key, returnTo)} label={`Record money received from ${p.personName} in People`}>
                Record received
              </ShareAction>
              <ShareAction href={peoplePostponeHref(p.personId, firstOpen.key, returnTo)} label={`Postpone collecting ${p.personName}'s share in People`}>
                Postpone
              </ShareAction>
            </>
          )}
        </span>
      )}
    </li>
  );
}

function ShareAction({ href, label, tone, children }: { href: string; label: string; tone?: "advance"; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      aria-label={label}
      title={label}
      className={cn(
        "rounded-[6px] px-1.5 py-0.5 text-xs font-semibold underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring",
        tone === "advance" ? "text-settle-advance-text" : "text-settle-receivable-text",
      )}
    >
      {children}
    </Link>
  );
}
