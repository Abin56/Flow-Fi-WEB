"use client";

import { LOAN_EMI_INPUT, Reveal } from "@/features/loans/components/loan-emi-ui";
import { cn } from "@/lib/utils";

/**
 * Shared Loan / EMI Record payment, when people's shares of what this payment settles are still open: the
 * user picks how to go on — nothing is preselected. "Pay now from my account" is the explicit
 * acknowledgement the write gate requires; it never marks anyone as paid, never postpones, and creates no
 * receivable, expense or transfer — their shares simply stay owed in People. "Collect money from others
 * first" leads to People Record payment (where Postpone also lives) for the person picked in the list.
 */
export type LenderPaymentDecision = "collect" | "ownMoney";

export const OWN_MONEY_REASONS = [
  { value: "couldNotPay", label: "Person could not pay" },
  { value: "delayed", label: "Payment delayed" },
  { value: "collectLater", label: "I will collect later" },
  { value: "other", label: "Other" },
] as const;

export type OwnMoneyReason = (typeof OWN_MONEY_REASONS)[number]["value"];

export function ownMoneyReasonLabel(reason: OwnMoneyReason | null): string | null {
  return OWN_MONEY_REASONS.find((r) => r.value === reason)?.label ?? null;
}

/**
 * What is saved with the payment (its existing `note` field — there is no separate audit field): that it
 * was paid from the user's own money, the optional reason and the optional note.
 */
export function ownMoneyPaymentNote(reason: OwnMoneyReason | null, note: string): string {
  const label = ownMoneyReasonLabel(reason);
  const extra = note.trim();
  return `Paid from my own money${label ? ` — ${label}` : ""}${extra ? `: ${extra}` : ""}`;
}

/** "Sanju" · "Sanju and AMMA" · "Sanju and 2 others". */
export function peopleNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]} and ${names.length - 1} others`;
}

/** A neutral radio row: selected = strong edge + filled dot (no full-colour fill), readable in both themes. */
export function ChoiceRow({ active, title, hint, onSelect }: { active: boolean; title: string; hint?: string; onSelect: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onSelect}
      className={cn(
        "flex w-full items-start gap-2.5 rounded-[6px] border px-3 py-2 text-left transition-[border-color,background-color] duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active ? "border-foreground bg-secondary" : "border-border hover:border-border-strong hover:bg-secondary/60",
      )}
    >
      <span aria-hidden className={cn("mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border-[1.5px]", active ? "border-foreground" : "border-border-strong")}>
        {active && <span className="size-2 rounded-full bg-foreground" />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm font-semibold text-foreground">{title}</span>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </span>
    </button>
  );
}

export function PeoplePaymentDecision({
  decision,
  onDecision,
  reason,
  onReason,
  note,
  onNote,
  accountName,
  allPostponed = false,
  postponedNote = "",
  unresolvedNames = [],
  lapsedNames = [],
  amountLabel = null,
  advanceNote = null,
}: {
  /** Collect first, when the picked person already gave money held as advance — applying it is offered first. */
  advanceNote?: string | null;
  decision: LenderPaymentDecision | null;
  onDecision: (d: LenderPaymentDecision) => void;
  reason: OwnMoneyReason | null;
  onReason: (r: OwnMoneyReason | null) => void;
  note: string;
  onNote: (n: string) => void;
  /** The paying account / card — null when none is picked yet. */
  accountName: string | null;
  /** Every open share was already moved to a later cycle in People — only "pay from my account" is offered. */
  allPostponed?: boolean;
  /** "SANJU and AMMA will pay you in the Nov cycle." — empty when nothing is postponed. */
  postponedNote?: string;
  /** People whose open share has no live postponement — the choice below is about them. */
  unresolvedNames?: readonly string[];
  /** People whose postponed cycle already passed while still unpaid. */
  lapsedNames?: readonly string[];
  amountLabel?: string | null;
}) {
  const from = accountName ? `from ${accountName}` : "from my account";
  const heading = allPostponed
    ? "Payment to lender"
    : postponedNote && unresolvedNames.length > 0
      ? `What about ${peopleNames(unresolvedNames)}'s share?`
      : "How do you want to pay?";
  return (
    <section aria-label="Payment decision" className="flex flex-col gap-1.5">
      {postponedNote && (
        <p role="note" className="text-sm text-foreground" data-testid="postponed-note">
          <span className="text-settle-receivable-text">{postponedNote}</span>
          {allPostponed && " You can pay the lender now from your account."}
        </p>
      )}
      {lapsedNames.length > 0 && (
        <p className="text-xs text-warning-foreground dark:text-warning" data-testid="lapsed-note">
          {peopleNames(lapsedNames)}: postponed date has passed — still not received.
        </p>
      )}
      <h3 className="text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">{heading}</h3>
      <div role="radiogroup" aria-label="How to pay the lender" className="flex flex-col gap-1.5">
        <ChoiceRow
          active={decision === "ownMoney"}
          title={allPostponed ? `Pay ${amountLabel ? `${amountLabel} ` : ""}to lender ${from}` : `Pay now ${from}`}
          hint={allPostponed ? "Their shares stay owed to you until they pay." : "Unpaid shares stay owed to you."}
          onSelect={() => onDecision("ownMoney")}
        />
        {decision === "ownMoney" && (
          <Reveal className="flex flex-col gap-1.5 pb-1 pl-[26px]">
            {!allPostponed && (
              <div className="flex flex-wrap gap-1.5" aria-label="Reason (optional)">
                {OWN_MONEY_REASONS.map((r) => {
                  const active = reason === r.value;
                  return (
                    <button
                      key={r.value}
                      type="button"
                      aria-pressed={active}
                      onClick={() => onReason(active ? null : r.value)}
                      className={cn(
                        "h-7 rounded-full border px-2.5 text-xs transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        active ? "border-foreground bg-foreground text-background" : "border-border-strong text-foreground hover:bg-secondary",
                      )}
                    >
                      {r.label}
                    </button>
                  );
                })}
              </div>
            )}
            <input
              className={cn(LOAN_EMI_INPUT, "h-9")}
              aria-label="Note about paying with your own money"
              placeholder="Note (optional) — saved with this payment"
              value={note}
              onChange={(e) => onNote(e.target.value)}
            />
          </Reveal>
        )}
        {!allPostponed && (
          <ChoiceRow
            active={decision === "collect"}
            title="Collect money from others first"
            hint="Apply an advance, record what they paid, or postpone their share in People — then come back here."
            onSelect={() => onDecision("collect")}
          />
        )}
        {decision === "collect" && advanceNote && (
          <p className="pl-[26px] text-xs font-medium text-settle-advance-text" data-testid="collect-advance-note">
            {advanceNote}
          </p>
        )}
      </div>
    </section>
  );
}
