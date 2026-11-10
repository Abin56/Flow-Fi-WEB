"use client";

import { useEffect, useRef } from "react";
import { CalendarClock, Users, Wallet, X, type LucideIcon } from "lucide-react";
import { LOAN_EMI_INPUT, Reveal } from "@/features/loans/components/loan-emi-ui";
import { formatCurrencyExact } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Shared Loan / EMI Record payment, when people's shares of what this payment settles are still open: the
 * user picks how to go on — nothing is preselected. The question is "Did they give you their share?":
 * "Received" records what they paid right here (`collectSlot`, the People receipt), "Not received yet" moves when
 * their share is expected, right here (`postponeSlot`; it records no payment and leaves the lender installment due
 * as it is). "Pay the lender from my own money" is the explicit acknowledgement the write gate requires; it never
 * marks anyone as paid, never postpones, and creates no receivable, expense or transfer — their shares simply stay
 * owed in People.
 */
export type LenderPaymentDecision = "collect" | "ownMoney" | "postpone";

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

/**
 * One choice of the grouped control: radio dot, a small icon tile that tells the three choices apart at a glance,
 * the title and ONE short hint. Selected = strong edge + tinted row (neutral, never a full-colour fill); the chosen
 * option's details open inside the same row, so nothing jumps elsewhere.
 */
export function ChoiceRow({
  active,
  title,
  hint,
  onSelect,
  icon: Icon,
  tone = "neutral",
  children,
}: {
  active: boolean;
  title: string;
  hint?: string;
  onSelect: () => void;
  icon?: LucideIcon;
  tone?: "neutral" | "collect" | "postpone";
  children?: React.ReactNode;
}) {
  const tile = tone === "collect" ? "bg-settle-receivable-tint text-settle-receivable-text" : tone === "postpone" ? "bg-settle-split-tint text-settle-split-text" : "bg-secondary text-foreground";
  return (
    <div className={cn("transition-colors duration-150", active ? "bg-secondary/70" : "hover:bg-secondary/40")}>
      <button
        type="button"
        role="radio"
        aria-checked={active}
        onClick={onSelect}
        className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <span aria-hidden className={cn("flex size-4 shrink-0 items-center justify-center rounded-full border-[1.5px]", active ? "border-foreground" : "border-border-strong")}>
          {active && <span className="size-2 rounded-full bg-foreground" />}
        </span>
        {Icon && (
          <span aria-hidden className={cn("flex size-7 shrink-0 items-center justify-center rounded-[6px]", tile)}>
            <Icon className="size-3.5" strokeWidth={2} />
          </span>
        )}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm font-semibold text-foreground">{title}</span>
          {hint && <span className="truncate text-xs text-muted-foreground">{hint}</span>}
        </span>
      </button>
      {active && children && <Reveal className="flex flex-col gap-1.5 px-3 pb-3 pl-[62px]">{children}</Reveal>}
    </div>
  );
}

/** The form a person's "Record received" / "Postpone" button opens right under the people list. */
export function ActionPanel({ title, onClose, children, testId }: { title: string; onClose: () => void; children: React.ReactNode; testId: string }) {
  // It opens below the person cards, often under the fold: bring it into view.
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, []);
  return (
    <div ref={ref} className="scroll-mb-4">
    <Reveal className="flex flex-col gap-3 rounded-xl border border-border-strong bg-card p-3 shadow-e1">
      <div className="flex items-center justify-between gap-2" data-testid={testId}>
        <h4 className="text-sm font-semibold text-foreground">{title}</h4>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close this form"
          className="grid size-7 place-items-center rounded-[8px] text-muted-foreground outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-4" strokeWidth={1.75} />
        </button>
      </div>
      {children}
    </Reveal>
    </div>
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
  postponeSlot = null,
  collectSlot = null,
  pendingPeople = [],
  actionsInRows = false,
  panelsOutside = false,
}: {
  /** The Received / Postpone forms are drawn by the host (beside this list on a wide sheet) — not under the people. */
  panelsOutside?: boolean;
  /**
   * Each undecided person's "Record received" / "Postpone" buttons are on their own card above, so their forms open
   * below that list when pressed and only "pay from my own money" is a choice here.
   */
  actionsInRows?: boolean;
  /** What each undecided person still owes for this payment — shown under "own money" as what goes to People. */
  pendingPeople?: readonly { name: string; amount: number }[];
  /** The in-dialog "record what they paid" form, shown under "Received". */
  collectSlot?: React.ReactNode;
  /** The postpone form, shown under "Not received yet" — null: the choice isn't offered. */
  postponeSlot?: React.ReactNode;
  /** Collect first, when the picked person already gave money held as advance — applying it is offered first. */
  advanceNote?: string | null;
  decision: LenderPaymentDecision | null;
  onDecision: (d: LenderPaymentDecision | null) => void;
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
  const waiting = unresolvedNames.length > 0 ? peopleNames(unresolvedNames) : "Their";
  const heading = allPostponed
    ? "Payment to lender"
    : actionsInRows
      ? "Or pay the lender now"
    : postponedNote && unresolvedNames.length > 0
      ? `What about ${peopleNames(unresolvedNames)}'s share?`
      : unresolvedNames.length > 0
        ? `Did ${peopleNames(unresolvedNames)} give you their share?`
        : "How do you want to pay?";
  return (
    <section aria-label="Payment decision" className="flex flex-col gap-1.5">
      {postponedNote && (
        <p role="note" className="flex items-start gap-1.5 text-sm text-foreground" data-testid="postponed-note">
          <CalendarClock className="mt-0.5 size-3.5 shrink-0 text-settle-split-text" aria-hidden />
          <span>
            <span className="text-settle-receivable-text">{postponedNote}</span>
            {allPostponed && " You can pay the lender now from your account."}
          </span>
        </p>
      )}
      {lapsedNames.length > 0 && (
        <p className="text-xs text-warning-foreground dark:text-warning" data-testid="lapsed-note">
          {peopleNames(lapsedNames)}: postponed date has passed — still not received.
        </p>
      )}
      {actionsInRows && !panelsOutside && !allPostponed && decision === "collect" && (
        <ActionPanel title={`Record what ${waiting === "Their" ? "they" : waiting} gave you`} onClose={() => onDecision(null)} testId="decision-collect">
          {collectSlot}
        </ActionPanel>
      )}
      {actionsInRows && !panelsOutside && !allPostponed && decision === "postpone" && postponeSlot != null && (
        <ActionPanel title="Move their share to a later month" onClose={() => onDecision(null)} testId="decision-postpone">
          {postponeSlot}
        </ActionPanel>
      )}
      <h3 className="mt-1 text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">{heading}</h3>
      {!actionsInRows && <p className="text-xs text-muted-foreground">Paying the lender and collecting from them are separate. The lender is paid in full either way — their share is tracked in People.</p>}
      <div role="radiogroup" aria-label="How to pay the lender" className="divide-y divide-border overflow-hidden rounded-[10px] border border-border-strong bg-card">
        {!allPostponed && !actionsInRows && (
          <ChoiceRow
            active={decision === "collect"}
            icon={Users}
            tone="collect"
            title="Received"
            hint={`${waiting} ${unresolvedNames.length === 1 ? "has" : "have"} given you their share`}
            onSelect={() => onDecision("collect")}
          >
            {collectSlot ??
              (advanceNote ? (
                <p className="text-xs font-medium text-settle-advance-text" data-testid="collect-advance-note">
                  {advanceNote}
                </p>
              ) : null)}
          </ChoiceRow>
        )}
        {!allPostponed && !actionsInRows && postponeSlot != null && (
          <ChoiceRow
            active={decision === "postpone"}
            icon={CalendarClock}
            tone="postpone"
            title="Not received yet"
            hint="Move their share to a later month · the EMI stays due"
            onSelect={() => onDecision("postpone")}
          >
            {postponeSlot}
          </ChoiceRow>
        )}
        <ChoiceRow
          active={decision === "ownMoney"}
          icon={Wallet}
          title={allPostponed ? `Pay ${amountLabel ? `${amountLabel} ` : ""}to lender ${from}` : "Pay the lender from my own money"}
          hint={allPostponed ? "Their shares stay owed to you until they pay." : `${accountName ? `From ${accountName} · ` : ""}their share stays owed to you`}
          onSelect={() => onDecision("ownMoney")}
        >
            {pendingPeople.length > 0 && !actionsInRows && (
              <div className="flex flex-col gap-1 rounded-[6px] border border-settle-receivable-text/30 bg-settle-receivable-tint px-2.5 py-2 text-xs" data-testid="own-money-pending">
                <span className="font-semibold text-settle-receivable-text">Stays pending with them — kept in the People ledger</span>
                {pendingPeople.map((p) => (
                  <span key={p.name} className="flex justify-between gap-3 text-foreground">
                    <span className="uppercase">{p.name}</span>
                    <span className="font-semibold tabular-nums">{formatCurrencyExact(p.amount)}</span>
                  </span>
                ))}
                <span className="text-muted-foreground">You pay the lender now. They still owe you this until they pay.</span>
              </div>
            )}
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
        </ChoiceRow>
      </div>
    </section>
  );
}
