"use client";

import { ChevronDown, Link2, Unlink } from "lucide-react";
import { useState } from "react";
import { formatCurrencyExact } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Transaction } from "@/lib/models/transaction";

const dateText = (d: Date) => d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
const dayIdx = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

export interface LinkSuggestion {
  t: Transaction;
  /** Why it looks like this agreement's payment (a name, the word EMI, a loan category) — never just the amount. */
  reasons: string[];
}

/** Facts the user can check against their own records — amount vs what is owed, and the date vs the due date. */
function facts(t: Transaction, owed: number, due: Date): string[] {
  const out: string[] = [];
  out.push(Math.abs(t.amount - owed) < 0.005 ? "Same amount as the EMI" : `${formatCurrencyExact(owed - t.amount)} less than the EMI`);
  const gap = Math.round((dayIdx(t.dateTime) - dayIdx(due)) / 86_400_000);
  out.push(gap === 0 ? "Paid on the due date" : gap > 0 ? `${gap} day${gap === 1 ? "" : "s"} after the due date` : `${-gap} day${gap === -1 ? "" : "s"} before the due date`);
  return out;
}

/**
 * "Link a transaction you already recorded" — inside a Loan / EMI past (already-paid) payment. Choosing one of YOUR existing
 * expenses makes it the payment: amount, date and account come from it (never retyped), nothing is posted and no account
 * moves (that transaction already did, once), and it can't be linked a second time. Optional — without it a past payment is
 * recorded exactly as before.
 *
 * Nothing here is ever assumed:
 *  - only expenses that name the agreement or sit in a loan category are SUGGESTED ("likely matches", with the reason);
 *  - expenses that merely have the same amount / date are hidden until the user asks, under a warning;
 *  - picking a row only opens its details — the link exists only after "Link this expense" is pressed (and the payment is saved).
 */
export function LinkTransactionField({
  related,
  others,
  owed,
  dueDate,
  linked,
  accountName,
  mismatch,
  onPick,
  onClear,
}: {
  /** Expenses with evidence they belong to this agreement (from `splitCandidates`). */
  related: readonly LinkSuggestion[];
  /** Eligible expenses with NO evidence — same amount / date only; offered only on request. */
  others: readonly Transaction[];
  /** What the installment still owes, and when it fell due. */
  owed: number;
  dueDate: Date;
  linked: Transaction | null;
  accountName: (accountId: string) => string;
  /** Why the entered amount / date / account no longer match the linked transaction (null: they match). */
  mismatch: string | null;
  onPick: (t: Transaction) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [showOthers, setShowOthers] = useState(false);
  const [pending, setPending] = useState<{ t: Transaction; reasons: string[] } | null>(null);
  if (linked == null && related.length === 0 && others.length === 0) return null;

  if (linked) {
    return (
      <div className="flex flex-col gap-1.5 rounded-[8px] border border-primary-accent-text/50 bg-primary/10 px-3 py-2 text-xs" data-testid="linked-transaction">
        <div className="flex items-start justify-between gap-2">
          <span className="flex min-w-0 items-start gap-1.5 text-foreground">
            <Link2 className="mt-0.5 size-3.5 shrink-0 text-primary-accent-text" strokeWidth={1.75} aria-hidden />
            <span className="min-w-0">
              <span className="block truncate font-semibold">Linked: {linked.description?.trim() || "Expense"}</span>
              <span className="block text-foreground/75">
                {formatCurrencyExact(linked.amount)} · {dateText(linked.dateTime)} · {accountName(linked.accountId)}
              </span>
            </span>
          </span>
          <button type="button" onClick={onClear} className="flex shrink-0 items-center gap-1 rounded-[5px] px-1.5 py-0.5 font-semibold text-foreground/75 outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring">
            <Unlink className="size-3.5" strokeWidth={1.75} aria-hidden />
            Unlink
          </button>
        </div>
        <p className="text-foreground/70">Amount, date and account come from this transaction. It already moved your account, so no balance changes and nothing is counted twice.</p>
        {mismatch && (
          <p role="alert" className="font-semibold text-expense">
            {mismatch}
          </p>
        )}
      </div>
    );
  }

  const row = (t: Transaction, reasons: string[]) => (
    <li key={t.id}>
      <button
        type="button"
        onClick={() => setPending({ t, reasons })}
        data-testid="link-candidate"
        className="flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left outline-none hover:bg-card focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="min-w-0">
          <span className="block truncate font-medium text-foreground">{t.description?.trim() || "Expense"}</span>
          <span className="block text-foreground/65">
            {dateText(t.dateTime)} · {accountName(t.accountId)}
          </span>
          {reasons.length > 0 && <span className="block text-[11px] font-medium text-primary-accent-text">{reasons.join(" · ")}</span>}
        </span>
        <span className="shrink-0 font-semibold text-foreground tabular-nums">{formatCurrencyExact(t.amount)}</span>
      </button>
    </li>
  );

  return (
    <div className="rounded-[8px] border border-border bg-secondary/50 text-xs" data-testid="link-transaction">
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-1.5 px-3 py-2 text-left font-semibold text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <Link2 className="size-3.5 text-foreground/70" strokeWidth={1.75} aria-hidden />
        Link a transaction you already recorded
        <span className="font-normal text-foreground/60">(optional · {related.length === 0 ? "no likely match" : `${related.length} likely`})</span>
        <ChevronDown className={cn("ml-auto size-3.5 transition-transform", open && "rotate-180")} strokeWidth={1.75} aria-hidden />
      </button>
      {open && (
        <div className="space-y-2 border-t border-border px-3 py-2">
          <p className="text-foreground/70" data-testid="link-not-linked">
            Not linked. Nothing is linked unless you pick an expense and confirm it.
          </p>

          {pending ? (
            <div className="space-y-1.5 rounded-[8px] border border-border-strong bg-card px-3 py-2" data-testid="link-pending">
              <p className="font-semibold text-foreground">Is this the payment you made for this EMI?</p>
              <p className="text-foreground">
                <span className="font-semibold">{pending.t.description?.trim() || "Expense"}</span> · {formatCurrencyExact(pending.t.amount)} · {dateText(pending.t.dateTime)} · {accountName(pending.t.accountId)}
              </p>
              <p className="text-foreground/70">{[...pending.reasons, ...facts(pending.t, owed, dueDate)].join(" · ")}</p>
              {pending.reasons.length === 0 && <p className="font-medium text-warning">Nothing in this expense mentions the EMI — only link it if you are sure it was this payment.</p>}
              <div className="flex gap-2 pt-0.5">
                <button
                  type="button"
                  data-testid="link-confirm"
                  onClick={() => {
                    onPick(pending.t);
                    setPending(null);
                  }}
                  className="rounded-[6px] border border-primary-accent-text bg-primary px-2.5 py-1 font-semibold text-primary-foreground outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Link this expense
                </button>
                <button type="button" onClick={() => setPending(null)} className="rounded-[6px] border border-border-strong bg-card px-2.5 py-1 font-semibold text-foreground outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring">
                  Not this one
                </button>
              </div>
            </div>
          ) : (
            <>
              {related.length > 0 ? (
                <ul className="max-h-44 divide-y divide-border overflow-auto rounded-[6px] border border-border" aria-label="Likely matches">
                  {related.slice(0, 12).map((r) => row(r.t, r.reasons))}
                </ul>
              ) : (
                <p className="text-foreground/80" data-testid="link-empty">
                  No recorded expense looks like this EMI payment — none mentions it or sits in a loan category. You can still record it as paid without linking.
                </p>
              )}
              {others.length > 0 && (
                <div>
                  <button type="button" aria-expanded={showOthers} onClick={() => setShowOthers((s) => !s)} className="font-semibold text-primary-accent-text outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring" data-testid="link-show-others">
                    {showOthers ? "Hide other expenses" : `Show ${others.length} other expense${others.length === 1 ? "" : "s"} with a similar amount`}
                  </button>
                  {showOthers && (
                    <>
                      <p className="mt-1 font-medium text-warning">These only match by amount and date — nothing ties them to this EMI. Most are unrelated.</p>
                      <ul className="mt-1 max-h-44 divide-y divide-border overflow-auto rounded-[6px] border border-border" aria-label="Other expenses">
                        {others.slice(0, 12).map((t) => row(t, []))}
                      </ul>
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
