"use client";

import { cn } from "@/lib/utils";
import { formatCurrencyExact } from "@/lib/format";
import type { UnsettledPeopleAcknowledgement } from "@/lib/engines/linked-people-readiness";
import { peopleNames } from "@/features/loans/components/people-payment-decision";

/** Has the person already paid their share? Nothing until the user answers — never a default. */
export type PeopleShareAnswer = "yes" | "no";

/**
 * The acknowledgement the write gate requires once the question below is answered either way. Either answer
 * satisfies the gate — "No" only records a plain-language note on the payment; it never blocks paying the
 * lender. This function writes nothing itself: on "Yes" the Record Payment dialog asks how much each person paid
 * (and into which account) and records those receipts in People right after the lender payment.
 */
export function peopleShareAcknowledgement(answer: PeopleShareAnswer | null, names: readonly string[]): UnsettledPeopleAcknowledgement | null {
  if (answer == null) return null;
  const who = peopleNames(names);
  return {
    acknowledgedUnsettledPeople: true,
    reason: answer === "yes" ? `Marked: ${who} already paid their share of this.` : `Marked: ${who} hasn't paid their share yet — paying the lender anyway.`,
  };
}

/**
 * Shared Loan / EMI Record payment, when people's shares of what this payment settles are still open: one
 * plain question — "Has X already paid you their share?" — Yes or No. Either answer only marks status
 * (saved in the payment's own note) and lets the lender payment proceed; it never moves money, never
 * settles anyone in People, and never postpones anything. A real reimbursement is recorded separately, in
 * the person's own People ledger.
 */
export function PeopleShareConfirm({
  names,
  amount,
  answer,
  onAnswer,
  dense = false,
  compactCopy = false,
}: {
  names: readonly string[];
  /** The people's combined still-open share, for the question's own hint. */
  amount: number;
  answer: PeopleShareAnswer | null;
  onAnswer: (a: PeopleShareAnswer) => void;
  /** One line: the question with its two answers beside it (inside a titled section, so no heading of its own). */
  dense?: boolean;
  compactCopy?: boolean;
}) {
  const who = peopleNames(names);
  if (dense) {
    const choice = "h-8 rounded-[6px] border px-3 text-xs font-semibold whitespace-nowrap transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring";
    return (
      <section aria-label="Has their share been paid?" className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <p className="min-w-0 flex-1 basis-52 text-[13px] text-foreground">
            Has {who} already paid you their share{amount > 0.005 ? ` — ${formatCurrencyExact(amount)}` : ""}?
          </p>
          <div role="radiogroup" aria-label={`Has ${who} paid their share?`} className="flex max-w-full flex-wrap gap-1.5">
            <button type="button" role="radio" aria-checked={answer === "yes"} onClick={() => onAnswer("yes")} className={cn(choice, answer === "yes" ? "border-success bg-success/10 text-success" : "border-border-strong text-foreground hover:bg-secondary")}>
              Yes, already paid
            </button>
            <button type="button" role="radio" aria-checked={answer === "no"} onClick={() => onAnswer("no")} className={cn(choice, answer === "no" ? "border-warning bg-warning/10 text-warning-foreground dark:text-warning" : "border-border-strong text-foreground hover:bg-secondary")}>
              No, not yet
            </button>
          </div>
        </div>
        {answer === "no" && (
          <p role="status" className="text-xs text-warning-foreground dark:text-warning" data-testid="share-not-paid-warning">
            {compactCopy ? "The share stays pending in People." : `Marked as not paid yet — you can still pay the lender now. ${who} still owes you this in People.`}
          </p>
        )}
      </section>
    );
  }
  return (
    <section aria-label="Has their share been paid?" className="flex flex-col gap-2">
      <h3 className="text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">Shared with people</h3>
      <p className="text-sm text-foreground">
        Has {who} already paid you their share{amount > 0.005 ? ` — ${formatCurrencyExact(amount)}` : ""}?
      </p>
      <div role="radiogroup" aria-label={`Has ${who} paid their share?`} className="flex gap-2">
        <button
          type="button"
          role="radio"
          aria-checked={answer === "yes"}
          onClick={() => onAnswer("yes")}
          className={cn(
            "flex-1 rounded-[10px] border px-3 py-2 text-sm font-semibold transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring",
            answer === "yes" ? "border-success bg-success/10 text-success" : "border-border-strong text-foreground hover:bg-secondary",
          )}
        >
          Yes, already paid
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={answer === "no"}
          onClick={() => onAnswer("no")}
          className={cn(
            "flex-1 rounded-[10px] border px-3 py-2 text-sm font-semibold transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring",
            answer === "no" ? "border-warning bg-warning/10 text-warning-foreground dark:text-warning" : "border-border-strong text-foreground hover:bg-secondary",
          )}
        >
          No, not yet
        </button>
      </div>
      {answer === "no" && (
        <p role="status" className="text-xs text-warning-foreground dark:text-warning" data-testid="share-not-paid-warning">
          Marked as not paid yet — you can still pay the lender now. {who} still owes you this in People.
        </p>
      )}
    </section>
  );
}
