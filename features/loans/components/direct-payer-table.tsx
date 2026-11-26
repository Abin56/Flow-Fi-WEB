"use client";

import { Bell, Check, Loader2 } from "lucide-react";
import { Fragment, useState } from "react";
import { AccountSelect } from "@/components/finance/account-label";
import { DateInput } from "@/components/forms/date-input";
import { Segmented, reimbursementFailure, type HistoricalReconcileState } from "@/features/loans/components/historical-people-reconcile";
import { reimbursementLineKey, type ReceivedChoice, type ReimbursementLine } from "@/lib/engines/historical-reimbursement";
import { PAYMENT_EPSILON, round2 } from "@/lib/engines/person-payment";
import { formatCurrency, formatCurrencyExact } from "@/lib/format";
import type { Account } from "@/lib/models/account";
import { cn } from "@/lib/utils";
import styles from "./payment-contributions.module.css";

/**
 * "Person pays lender", in the same table as "I pay": share · received · remaining, and for each person whether THEY paid
 * the lender, and how much of their share it covered.
 *
 * PRESENTATION ONLY over the very same draft the past / direct record has always used (`useHistoricalReconcile`): every
 * row starts on "Didn't pay" (nobody is ever preselected), amounts are checked by `planReimbursements`, the lender-amount
 * limit by `directSettlementError`, and the save — including retrying only what failed — is the hook's own. Money paid to
 * the lender never reaches an account of mine (the hook forces every receipt to "no balance change"), and no card is
 * charged.
 */

const CHOICES: { value: ReceivedChoice; label: string }[] = [
  { value: "none", label: "Didn't pay" },
  { value: "full", label: "Full share" },
  { value: "some", label: "Part" },
];

/** A person's per-installment rows fold away beyond this many. */
const COLLAPSE_AFTER = 6;

const pad = (n: number) => String(n).padStart(2, "0");
const dateText = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const inAWeek = () => {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  return dateText(d);
};
const shared = (values: readonly string[]) => (values.every((v) => v === values[0]) ? (values[0] ?? "") : "");

export function DirectPayerTable({
  cardEmi = false,
  state,
  accounts,
  myShare,
  showInstallment,
  lenderAmount,
  locked,
}: {
  cardEmi?: boolean;
  state: HistoricalReconcileState;
  accounts: readonly Account[];
  /** My part of the one installment shown; null when the record covers several (my part differs per installment). */
  myShare: number | null;
  showInstallment: boolean;
  /** What is being recorded as paid to the lender. */
  lenderAmount: number | null;
  /** After saving: read-only. */
  locked?: boolean;
}) {
  const { lines, loading, draft, plan } = state;
  const [expandedPeople, setExpandedPeople] = useState<ReadonlySet<string>>(() => new Set());
  if (lines.length === 0) {
    return loading ? (
      <p role="status" className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" aria-hidden /> Checking who shares this…
      </p>
    ) : null;
  }
  const people = [...new Map(lines.map((l) => [l.personId, l.personName])).entries()];
  const errors = plan.ok ? {} : plan.errors;
  const summary = plan.ok ? plan.summary : null;
  const answered = (l: ReimbursementLine) => (draft[reimbursementLineKey(l)]?.choice ?? "none") !== "none";
  const anyCovered = lines.some((l) => l.remaining > PAYMENT_EPSILON && answered(l));
  const staysOwed = summary ? round2(summary.people.reduce((t, p) => t + p.remainingAfter, 0)) : null;
  const th = "px-2 py-1.5 text-[10.5px] font-bold tracking-[0.06em] text-muted-foreground uppercase";
  const num = "px-2 py-2 text-right tabular-nums";

  const lineRows = (l: ReimbursementLine, label: React.ReactNode, indented: boolean) => {
    const key = reimbursementLineKey(l);
    const d = draft[key];
    const choice = d?.choice ?? "none";
    const who = `${l.personName}${showInstallment ? ` #${l.sequenceNumber}` : ""}`;
    const open = l.remaining > PAYMENT_EPSILON;
    const failed = reimbursementFailure(state, l);
    return (
      <Fragment key={key}>
        <tr role="row" className={cn(styles.row, "align-top", indented && "bg-secondary/40")}>
          <th role="rowheader" scope="row" className={cn("py-2 pr-2 text-left", indented ? "pl-7 font-medium text-foreground/80" : "pl-3 font-semibold text-foreground")}>
            {label}
          </th>
          <td role="cell" data-label="Share" className={cn(num, "font-semibold text-foreground")}>{formatCurrency(l.share)}</td>
          <td role="cell" data-label="Received" className={cn(num, "text-foreground")}>{formatCurrency(l.received)}</td>
          <td role="cell" data-label="Remaining" className={cn(num, open ? "font-semibold text-foreground" : "text-muted-foreground")}>{formatCurrency(l.remaining)}</td>
          <td role="cell" className="py-1.5 pr-3 pl-2 text-right">
            {open ? (
              <Segmented name={who} value={choice} disabled={locked} wrap options={CHOICES.map((c) => ({ value: c.value, label: c.value === "full" && l.received > PAYMENT_EPSILON ? "The rest" : c.label }))} onChange={(v) => state.setLine(key, { choice: v })} />
            ) : (
              <span className="inline-flex h-7 items-center gap-1 font-semibold text-success">
                <Check className="size-3.5" aria-hidden /> Settled
              </span>
            )}
          </td>
        </tr>
        {open && (choice !== "none" || errors[key] || failed) && (
          <tr role="row" className={cn(indented && "bg-secondary/40")}>
            <td role="cell" colSpan={5} className="px-3 pb-2">
              {choice !== "none" && (
                <div className="flex flex-wrap items-center gap-1.5">
                  {choice === "some" && (
                    <input
                      type="number"
                      inputMode="decimal"
                      aria-label={`Amount covered for ${l.personName}`}
                      placeholder={`Up to ${formatCurrency(l.remaining)}`}
                      disabled={locked}
                      className="h-8 w-32 rounded-[6px] border border-border bg-card px-2 text-right text-xs tabular-nums"
                      value={d?.amount ?? ""}
                      onChange={(e) => state.setLine(key, { amount: e.target.value })}
                    />
                  )}
                  <span className="text-[11px] text-muted-foreground">Paid on</span>
                  <DateInput aria-label={`Date share was paid by ${who}`} title="Leave blank if you don't know the date" className="h-8 w-36 rounded-[6px] border border-border bg-card px-2 text-xs" value={d?.date ?? ""} disabled={locked} onChange={(e) => state.setLine(key, { date: e.target.value })} />
                  {!(d?.date ?? "") && <span className="text-[11px] text-muted-foreground">Saved as “date not known”</span>}
                </div>
              )}
              {errors[key] && (
                <p role="alert" className="mt-1 text-right text-[11px] font-semibold text-expense">
                  {errors[key]}
                </p>
              )}
              {failed && (
                <p role="alert" className="mt-1 text-right text-[11px] font-semibold text-expense">
                  {failed}
                </p>
              )}
            </td>
          </tr>
        )}
      </Fragment>
    );
  };

  return (
    <div className="flex flex-col gap-2" data-testid="direct-payer-table">
      <div className={cn(styles.container, "rounded-lg border border-border bg-card")}>
        <table role="table" className={cn(styles.table, "text-xs")} aria-label="Who paid the lender">
          <thead role="rowgroup" className="bg-secondary/50">
            <tr role="row" className="border-b border-border">
              <th className={cn(th, "pl-3 text-left")}>Person</th>
              <th className={cn(th, "text-right")}>Share</th>
              <th className={cn(th, "text-right")}>Received</th>
              <th className={cn(th, "text-right")}>Remaining</th>
              <th className={cn(th, "pr-3 text-right")}>Paid the lender?</th>
            </tr>
          </thead>
          {myShare != null && myShare > PAYMENT_EPSILON && (
            <tbody role="rowgroup" className="border-b border-border/70">
              <tr role="row" className={styles.row} data-testid="share-row-me" title="Your part of this installment — your cost, not money anyone owes you.">
                <th role="rowheader" scope="row" className="py-2 pr-2 pl-3 text-left font-semibold text-foreground">
                  Me
                </th>
                <td role="cell" data-label="Share" className={cn(num, "font-semibold text-foreground")}>{formatCurrency(myShare)}</td>
                <td role="cell" data-label="Received" className={cn(num, "text-muted-foreground")}>—</td>
                <td role="cell" data-label="Remaining" className={cn(num, "text-muted-foreground")}>—</td>
                <td role="cell" />
              </tr>
            </tbody>
          )}
          {people.map(([personId, personName]) => {
            const own = lines.filter((l) => l.personId === personId);
            if (!showInstallment) {
              return (
                <tbody role="rowgroup" key={personId} className="border-b border-border/70 last:border-b-0" data-testid={`reconcile-person-${personId}`}>
                  {own.map((l) => lineRows(l, personName, false))}
                </tbody>
              );
            }
            const open = own.filter((l) => l.remaining > PAYMENT_EPSILON);
            const covered = open.filter(answered);
            const failedAny = own.some((l) => state.failed.some((f) => f.personId === l.personId && f.obligationKey === l.obligationKey));
            const foldable = own.length > COLLAPSE_AFTER;
            // A failed save is never folded out of sight.
            const unfolded = !foldable || failedAny || expandedPeople.has(personId);
            const unanswered = own.filter((l) => errors[reimbursementLineKey(l)] != null).length;
            return (
              <tbody role="rowgroup" key={personId} className="border-b border-border/70 last:border-b-0" data-testid={`reconcile-person-${personId}`}>
                <tr role="row">
                  <td role="cell" colSpan={5} className="px-3 py-1.5">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="font-semibold text-foreground">{personName}</span>
                      <span className="text-[11px] text-muted-foreground" data-testid={`reconcile-count-${personId}`}>
                        {covered.length} of {open.length} marked covered
                      </span>
                      {open.length > 1 && !locked && (
                        <span className="flex gap-2 text-[11px] font-medium">
                          <button type="button" className="underline-offset-2 hover:underline" onClick={() => state.setPerson(personId, "full")}>
                            Cover all
                          </button>
                          <button type="button" className="text-muted-foreground underline-offset-2 hover:underline" onClick={() => state.setPerson(personId, "none")}>
                            None
                          </button>
                        </span>
                      )}
                      {covered.length > 1 && !locked && (
                        <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                          Same date for all {covered.length}
                          <DateInput aria-label={`Date ${personName} paid you, for all received`} className="h-7 w-32 rounded-[6px] border border-border bg-card px-2 text-[11px]" value={shared(covered.map((l) => draft[reimbursementLineKey(l)]?.date ?? ""))} onChange={(e) => state.setPersonReceived(personId, { date: e.target.value })} />
                        </label>
                      )}
                      {foldable && !failedAny && (
                        <button
                          type="button"
                          aria-expanded={unfolded}
                          onClick={() =>
                            setExpandedPeople((s) => {
                              const next = new Set(s);
                              if (next.has(personId)) next.delete(personId);
                              else next.add(personId);
                              return next;
                            })
                          }
                          className="text-[11px] font-semibold underline underline-offset-2"
                        >
                          {unfolded ? "Hide each installment" : `Show each installment (${own.length})`}
                        </button>
                      )}
                      {!unfolded && unanswered > 0 && <span className="text-[11px] font-semibold text-expense">{unanswered} still need an answer</span>}
                    </div>
                  </td>
                </tr>
                {unfolded && own.map((l) => lineRows(l, `#${l.sequenceNumber}`, true))}
              </tbody>
            );
          })}
        </table>
      </div>

      <dl className="flex flex-wrap gap-x-5 gap-y-2 border-t border-border pt-2" aria-label="Direct payment summary">
        {[
          { label: cardEmi ? "Card EMI" : "To lender", value: lenderAmount != null ? formatCurrencyExact(lenderAmount) : "—", note: "This record" },
          { label: "Covered by people", value: summary ? formatCurrencyExact(summary.total) : "—", note: "Paid the lender directly" },
          { label: "Stays owed", value: staysOwed != null ? formatCurrencyExact(staysOwed) : "—", note: "In People, after saving" },
        ].map((f) => (
          <div key={f.label} className="flex min-w-0 flex-col">
            <dt className="text-[11px] font-medium text-muted-foreground">{f.label}</dt>
            <dd className="text-sm font-semibold text-foreground tabular-nums">{f.value}</dd>
            <dd className="text-[11px] text-muted-foreground">{f.note}</dd>
          </div>
        ))}
      </dl>

      {anyCovered && (
        <label className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          <span className="font-medium">Account for the People record</span>
          <AccountSelect className="h-9 min-w-0 flex-1 basis-40 rounded-md border border-border bg-card px-2 text-xs" accounts={accounts as Account[]} value={state.accountId} onChange={state.setAccountId} ariaLabel="Account for the People record" />
        </label>
      )}

      {/* The existing reminder — which also postpones what isn't postponed yet (`splitReminderShares`), so it says so. */}
      {summary && staysOwed != null && staysOwed > PAYMENT_EPSILON && (
        <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="reconcile-reminder">
          {state.remindOn === "" ? (
            <button type="button" disabled={locked} onClick={() => state.setRemindOn(inAWeek())} className="inline-flex min-h-7 items-center gap-1.5 rounded-[6px] font-semibold text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
              <Bell className="size-3.5" aria-hidden /> Remind me about the rest
            </button>
          ) : (
            <>
              <span className="font-medium text-foreground">Remind me on</span>
              <DateInput aria-label="Reminder date" className="h-8 w-36 rounded-[6px] border border-border bg-card px-2 text-xs" value={state.remindOn} min={dateText(new Date())} disabled={locked} onChange={(e) => state.setRemindOn(e.target.value)} />
              <button type="button" disabled={locked} onClick={() => state.setRemindOn("")} className="font-medium text-muted-foreground underline-offset-2 hover:underline">
                Remove reminder
              </button>
              <span className="basis-full text-[11px] text-warning-foreground dark:text-warning">Shares not postponed yet move to a later cycle. Shares already postponed stay where they are.</span>
            </>
          )}
          {state.reminderStatus === "failed" && (
            <span role="alert" className="font-semibold text-expense">
              Payments saved, but the reminder wasn&apos;t. Set it from the person&apos;s page in People.
            </span>
          )}
        </div>
      )}
    </div>
  );
}
