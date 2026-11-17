"use client";

/**
 * "Postpone payment" on a person's share of a Loan / EMI installment, from the row — one panel, no steps, no second
 * dialog: pick when THIS PERSON is expected to pay, and (only here, because the share is a bank EMI) what happens to the
 * BANK EMI — "Pay from my account" / "Already paid" / "Pay later" (the default, which writes nothing for the bank).
 *
 * The two are different records and stay different (see `postpone-emi-handling.tsx`): the postponement is private
 * scheduling metadata for the person's reimbursement and never touches the lender's schedule, due date or an account;
 * the bank EMI changes only through the existing Loan / EMI payment write, and only after the postponement is saved.
 * Same behaviour as the Record payment sheet's "Not paid yet" — this is that flow, opened from the row.
 */

import { Loader2 } from "lucide-react";
import { useMemo, useState } from "react";
import { money } from "@/lib/engines/person-cycle-statement-share";
import { installmentStatus, remainingAmount, type Installment } from "@/lib/models/payment-schedule";
import { cn } from "@/lib/utils";
import type { LedgerRow } from "@/features/people/lib/person-ledger-rows";
import { PostponeFields, usePostponeDraft } from "./payment-deferral";
import { EmiHandlingSection, type EmiHandle } from "./postpone-emi-handling";

export type EmiHandling = "payNow" | "paidEarlier" | "pending";

const BTN =
  "inline-flex h-8 items-center gap-1 rounded-[6px] border border-border-strong bg-card px-3 text-[12px] font-semibold text-foreground outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
const PRIMARY = "border-primary-accent-text bg-primary text-primary-foreground hover:bg-primary hover:opacity-90";

const dayIdx = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** The bank side of one installment, in plain words — independent of anything the person did. */
export function bankEmiState(inst: Pick<Installment, "amountDue" | "amountPaid" | "dueDate" | "isSkipped">, now: Date = new Date()): {
  kind: "paid" | "partial" | "overdue" | "due" | "upcoming";
  label: string;
  remaining: number;
  daysOverdue: number;
} {
  const remaining = remainingAmount(inst as Installment);
  const status = installmentStatus(inst as Installment, now);
  const daysOverdue = Math.max(0, Math.round((dayIdx(now) - dayIdx(inst.dueDate)) / 86_400_000));
  if (status === "paid") return { kind: "paid", label: "Paid to the bank", remaining: 0, daysOverdue: 0 };
  if (status === "partiallyPaid") return { kind: "partial", label: `Part paid · ${money(remaining)} still due`, remaining, daysOverdue };
  if (daysOverdue > 0) return { kind: "overdue", label: `Unpaid · overdue by ${daysOverdue} ${daysOverdue === 1 ? "day" : "days"}`, remaining, daysOverdue };
  if (dayIdx(inst.dueDate) === dayIdx(now)) return { kind: "due", label: "Unpaid · due today", remaining, daysOverdue: 0 };
  return { kind: "upcoming", label: "Unpaid · not due yet", remaining, daysOverdue: 0 };
}

export function PostponeEmiPanel({ row, title, onDone }: { row: LedgerRow; title: string; onDone: () => void }) {
  const items = useMemo(() => [{ row, title }], [row, title]);
  const draft = usePostponeDraft(items);
  const [handle, setHandle] = useState<EmiHandle | null>(null);
  const [emiBusy, setEmiBusy] = useState(false);
  const [emiError, setEmiError] = useState<string | null>(null);

  const emiActive = handle != null && handle.choice !== "later";
  const saved = draft.doneKeys.has(row.key);
  // Postponement already saved (a retry of the bank step) or already in place and unchanged: only the EMI step is left.
  const emiOnly = emiActive && (saved || draft.unchanged);
  const confirmable = (emiOnly || draft.ready) && !emiBusy && !(emiActive && handle?.blocker);

  const confirm = async () => {
    if (!confirmable) return;
    setEmiError(null);
    if (!emiOnly && !(await draft.submit())) return;
    if (emiActive && handle) {
      setEmiBusy(true);
      try {
        await handle.run();
      } catch (e) {
        setEmiError(e instanceof Error ? e.message : "Couldn't save the EMI step.");
        return;
      } finally {
        setEmiBusy(false);
      }
    }
    onDone();
  };

  const label = draft.busy
    ? "Postponing…"
    : emiBusy
      ? "Saving the EMI…"
      : emiOnly
        ? saved
          ? `Retry: ${handle?.action ?? "EMI step"}`
          : (handle?.action ?? "Continue").replace(/^./, (c) => c.toUpperCase())
        : emiActive && handle?.action
          ? `Postpone & ${handle.action}`
          : "Confirm postpone";

  return (
    <div role="group" aria-label="Postpone payment" className="max-w-2xl space-y-3 rounded-[8px] border border-border-strong bg-card px-3 py-2.5" data-testid="postpone-emi-panel">
      <p className="text-[13px] text-foreground" data-testid="postpone-heading">
        <span className="font-semibold">{draft.personName || "They"}</span> · <span className="font-bold tabular-nums">{money(row.remaining ?? 0)}</span> pending
      </p>
      <PostponeFields draft={draft} />
      <EmiHandlingSection row={row} onHandle={setHandle} disabled={draft.busy || emiBusy} />
      {(draft.error || emiError) && (
        <p role="alert" className="text-[12px] font-medium text-expense">
          {emiError ? `Postponed, but the EMI step wasn't saved: ${emiError}` : draft.error}
        </p>
      )}
      {emiActive && handle?.blocker && (
        <p className="text-[11.5px] font-medium text-foreground/65" data-testid="emi-still-needed">
          Still needed: {handle.blocker}
        </p>
      )}
      <div className="flex items-center justify-end gap-1.5">
        <button type="button" className={BTN} disabled={draft.busy || emiBusy} onClick={onDone}>
          Cancel
        </button>
        <button type="button" className={cn(BTN, PRIMARY)} disabled={!confirmable} aria-busy={draft.busy || emiBusy} onClick={confirm} data-testid="postpone-emi-confirm">
          {(draft.busy || emiBusy) && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
          {label}
        </button>
      </div>
    </div>
  );
}
