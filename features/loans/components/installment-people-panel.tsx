"use client";

import Link from "next/link";
import { CalendarClock, Check, HandCoins, Loader2 } from "lucide-react";
import { usePersonPaymentDeferrals } from "@/features/people/hooks/use-payment-deferrals";
import { useMonthCycleStartDay } from "@/features/settings/hooks/use-user-preferences";
import type { InstallmentBreakdown, InstallmentParticipant, ShareLine } from "@/lib/engines/installment-participants";
import { peopleApplyAdvanceHref, peoplePostponeHref, peopleSettleHref } from "@/lib/engines/linked-people-readiness";
import { formatStatementDate } from "@/lib/engines/person-cycle-statement";
import { cycleName, deferralView, type DeferralView } from "@/lib/engines/person-payment-deferral";
import { PAYMENT_EPSILON } from "@/lib/engines/person-payment";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Shared Loan / EMI Record payment: one card per person sharing this installment — their share, whether it came in,
 * and the two things you can do about it, as two real buttons: "Record received" and "Postpone". Read from the People
 * Ledger (`installmentBreakdown`); the lender figures live in the sheet's header, never repeated here.
 *
 * What happens to a person's share happens in People, through named actions, each written in one place only: "Record
 * received" (People Record payment), "Postpone" (People "Postpone collection") and "Apply advance" (money they already
 * gave — no new money). When the host sheet can take over (`onReceive` / `onPostpone`, for people who haven't paid and
 * aren't postponed yet) the two buttons open the form right below, inside the payment — otherwise they open People and
 * return to this payment. Paying the lender never settles a person.
 */
export function InstallmentPeoplePanel({
  breakdown,
  loading,
  returnTo,
  inline,
  onReceive,
  onPostpone,
  pressed,
  className,
}: {
  breakdown: InstallmentBreakdown | null;
  loading: boolean;
  /** In-app path People returns to after recording. */
  returnTo?: string;
  /** People whose two actions run here (the sheet opens the form below); everyone else's go to People. */
  inline?: ReadonlySet<string>;
  /** "Record received" for a person in `inline`. */
  onReceive?: (personId: string) => void;
  /** "Postpone" for a person in `inline`. */
  onPostpone?: (personId: string) => void;
  /** Which action's form is open for a person — the button reads as pressed. */
  pressed?: (personId: string, kind: "collect" | "postpone") => boolean;
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
    <section aria-label="Who pays this installment" className={cn("flex flex-col gap-2", className)}>
      <h3 className="text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">Shared with</h3>
      <ul className="flex flex-col gap-2">
        {breakdown.participants.map((p) => (
          <ParticipantRow
            key={p.personId}
            participant={p}
            returnTo={returnTo}
            inline={inline?.has(p.personId) ?? false}
            onReceive={onReceive}
            onPostpone={onPostpone}
            pressed={pressed}
          />
        ))}
      </ul>
    </section>
  );
}

/** A postponed date is never shown as received: passed-and-unpaid reads as such, not as a fresh move. */
function postponedTo(view: DeferralView | null): string | null {
  if (!view) return null;
  // Their share, not the lender EMI: when it is now expected, by cycle and its first day.
  if (view.status === "postponed") return `Postponed to ${cycleName(view.cycle)} cycle · from ${formatStatementDate(view.cycle.start)}`;
  if (view.status === "expectedNow") return "Expected this cycle";
  if (view.status === "lapsed") return `Was due in ${cycleName(view.cycle)} cycle — still unpaid`;
  return null;
}

const ACTION =
  "inline-flex h-10 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-[9px] border px-3 text-[13px] font-semibold whitespace-nowrap outline-none transition-[background-color,border-color,color,box-shadow] duration-150 focus-visible:ring-2 focus-visible:ring-ring @[34rem]:h-9 @[34rem]:flex-none";
const ACTION_RECEIVE = "border-primary-accent-text bg-primary text-primary-foreground hover:bg-primary/85";
const ACTION_POSTPONE = "border-border-strong bg-card text-foreground hover:bg-secondary";
const ACTION_ON = "ring-2 ring-foreground/70 ring-offset-1 ring-offset-card";

const AVATAR_TINT = ["bg-primary/30", "bg-settle-split-tint", "bg-settle-receivable-tint", "bg-warning/25"];
const initials = (name: string) =>
  name
    .split(/s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
const tintOf = (name: string) => AVATAR_TINT[[...name].reduce((h, c) => h + c.charCodeAt(0), 0) % AVATAR_TINT.length];

function ParticipantRow({
  participant: p,
  returnTo,
  inline,
  onReceive,
  onPostpone,
  pressed,
}: {
  participant: InstallmentParticipant;
  returnTo?: string;
  inline: boolean;
  onReceive?: (personId: string) => void;
  onPostpone?: (personId: string) => void;
  pressed?: (personId: string, kind: "collect" | "postpone") => boolean;
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
  const receiveOn = inline && pressed?.(p.personId, "collect") === true;
  const postponeOn = inline && pressed?.(p.personId, "postpone") === true;

  return (
    <li className="@container rounded-xl border border-border bg-card p-3 shadow-e1">
      <div className="flex flex-col gap-3 @[34rem]:flex-row @[34rem]:items-center">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <span aria-hidden className={cn("grid size-9 shrink-0 place-items-center rounded-full text-[12px] font-bold text-foreground ring-1 ring-black/5", tintOf(p.personName))}>
            {initials(p.personName)}
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="flex items-baseline justify-between gap-3">
              <span className="truncate text-sm font-semibold text-foreground uppercase">{p.personName}</span>
              <span className="shrink-0 text-base font-semibold text-foreground tabular-nums">{formatCurrency(cur?.share ?? carriedTotal)}</span>
            </span>
            {status && (
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs" data-testid={`share-${p.personId}`}>
                <span
                  className={cn(
                    "inline-flex h-5 items-center gap-1 rounded-full px-2 text-[11px] font-semibold",
                    received ? "bg-success/12 text-[oklch(0.44_0.13_149)] dark:text-success" : partial ? "bg-warning/20 text-warning-foreground dark:text-warning" : "bg-expense/10 text-expense",
                  )}
                >
                  {received && <Check className="size-3" strokeWidth={2.75} aria-hidden />}
                  {status}
                </span>
                {moved && (
                  <>
                    <span aria-hidden className="-mx-1 text-muted-foreground">
                      {" · "}
                    </span>
                    <span className={cn("inline-flex items-center gap-1", curView?.status === "lapsed" ? "text-warning-foreground dark:text-warning" : "text-settle-receivable-text")}>
                      <CalendarClock className="size-3.5 shrink-0" aria-hidden />
                      {moved}
                    </span>
                  </>
                )}
              </span>
            )}
            {firstOpen && advance > PAYMENT_EPSILON && (
              <span className="text-xs text-settle-advance-text" data-testid={`advance-${p.personId}`}>
                Holding {formatCurrency(advance)} advance from {p.personName} — not applied to this share yet.{" "}
                <Link
                  href={peopleApplyAdvanceHref(p.personId, firstOpen.key, returnTo)}
                  aria-label={`Apply ${p.personName}'s ${formatCurrency(advance)} advance in People — no money moves`}
                  title={`Apply ${p.personName}'s ${formatCurrency(advance)} advance in People — no money moves`}
                  className="font-semibold underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Apply advance
                </Link>
              </span>
            )}
            {p.carried.length > 0 && (
              <span className="text-xs text-muted-foreground">
                + {formatCurrency(carriedTotal)} still owed from {p.carried.map((l) => `#${l.sequenceNumber}`).join(", ")}
                {carriedMoved && <span className="text-settle-receivable-text"> · moved to a later cycle</span>}
              </span>
            )}
          </div>
        </div>

        {/* Two different People operations, each named — neither touches the lender's installment. */}
        {firstOpen && (
          <div className="flex gap-2 @[34rem]:shrink-0" data-testid={`share-actions-${p.personId}`}>
            {inline && onReceive ? (
              <button type="button" aria-pressed={receiveOn} aria-label={`Record money received from ${p.personName} here`} onClick={() => onReceive(p.personId)} className={cn(ACTION, ACTION_RECEIVE, receiveOn && ACTION_ON)}>
                <HandCoins className="size-4" aria-hidden />
                Record received
              </button>
            ) : (
              <Link href={peopleSettleHref(p.personId, firstOpen.key, returnTo)} aria-label={`Record money received from ${p.personName} in People`} title={`Record money received from ${p.personName} in People`} className={cn(ACTION, ACTION_RECEIVE)}>
                <HandCoins className="size-4" aria-hidden />
                Record received
              </Link>
            )}
            {inline && onPostpone ? (
              <button type="button" aria-pressed={postponeOn} aria-label={`Postpone ${p.personName}'s share here`} onClick={() => onPostpone(p.personId)} className={cn(ACTION, ACTION_POSTPONE, postponeOn && ACTION_ON)}>
                <CalendarClock className="size-4" aria-hidden />
                Postpone
              </button>
            ) : (
              <Link href={peoplePostponeHref(p.personId, firstOpen.key, returnTo)} aria-label={`Postpone collecting ${p.personName}'s share in People`} title={`Postpone collecting ${p.personName}'s share in People`} className={cn(ACTION, ACTION_POSTPONE)}>
                <CalendarClock className="size-4" aria-hidden />
                {moved ? "Change" : "Postpone"}
              </Link>
            )}
          </div>
        )}
      </div>
    </li>
  );
}
