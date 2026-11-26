"use client";

import { Check, Loader2 } from "lucide-react";
import { useState } from "react";
import { AccountSelect } from "@/components/finance/account-label";
import { DateInput } from "@/components/forms/date-input";
import { Segmented, reimbursementFailure, type HistoricalReconcileState } from "@/features/loans/components/historical-people-reconcile";
import { reimbursementLineKey, type BalanceTreatment, type ReceivedChoice } from "@/lib/engines/historical-reimbursement";
import { PAYMENT_EPSILON, round2 } from "@/lib/engines/person-payment";
import { formatCurrency, formatCurrencyExact } from "@/lib/format";
import type { Account } from "@/lib/models/account";

/**
 * The compact "They paid" form (People side only) shared by the inline panel and the sheet. One block per person:
 * name + installment / received / left on one line, a 3-way answer, and — only once something is received — the amount
 * (partial), date, where the money is, and the account. Everything it edits is the same `useHistoricalReconcile` draft
 * the past-payment form uses; the single "Record Received" button lives with the caller.
 */

const CHOICES: { value: ReceivedChoice; label: string }[] = [
  { value: "full", label: "Received in Full" },
  { value: "some", label: "Received Partially" },
  { value: "none", label: "Not Received" },
];
const TREATMENTS: { value: BalanceTreatment; label: string }[] = [
  { value: "addToAccount", label: "Add to my account" },
  { value: "included", label: "Already in my account" },
];

const pad = (n: number) => String(n).padStart(2, "0");
const toText = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const defaultRemindOn = () => {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  return toText(d);
};

function Stat({ label, value, tone }: { label: string; value: string; tone?: "ok" | "owe" }) {
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className="text-muted-foreground">{label}</span>
      <span className={tone === "ok" ? "font-semibold text-success tabular-nums" : tone === "owe" ? "font-semibold text-expense tabular-nums" : "font-semibold text-foreground tabular-nums"}>{value}</span>
    </span>
  );
}

export function TheyPaidForm({ state, accounts, locked, personId, inlineAmount = false }: { state: HistoricalReconcileState; accounts: readonly Account[]; locked?: boolean; personId?: string; inlineAmount?: boolean }) {
  const { draft, plan } = state;
  const lines = personId ? state.lines.filter((l) => l.personId === personId) : state.lines;
  const [reminderOpen, setReminderOpen] = useState(false);
  if (lines.length === 0) {
    return state.loading ? (
      <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" aria-hidden /> Checking who shares this…
      </p>
    ) : null;
  }
  const errors = plan.ok ? {} : plan.errors;
  const summary = plan.ok ? plan.summary : null;
  const anyReceived = lines.some((l) => l.remaining > PAYMENT_EPSILON && (Boolean(personId) || (draft[reimbursementLineKey(l)]?.choice ?? "none") !== "none"));
  const pendingTotal = summary ? summary.people.filter((p) => !personId || p.personId === personId).reduce((t, p) => t + p.remainingAfter, 0) : 0;
  const todayText = toText(new Date());

  return (
    <div className="flex flex-col gap-2" data-testid="they-paid-form">
      {lines.map((l) => {
        const key = reimbursementLineKey(l);
        const d = draft[key];
        const choice = d?.choice ?? "none";
        const typedAmount = round2(Number(d?.amount ?? ""));
        const projected = personId && !inlineAmount && typedAmount > 0 && typedAmount <= l.remaining ? round2(l.remaining - typedAmount) : null;
        const name = l.personName;
        if (l.remaining <= PAYMENT_EPSILON) {
          return (
            <div key={key} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-secondary/40 px-2.5 py-1.5 text-xs">
              <span className="font-semibold text-foreground">{name}</span>
              <span className="inline-flex items-center gap-1 font-medium text-success">
                <Check className="size-3" aria-hidden /> Received earlier · {formatCurrency(l.share)}
              </span>
            </div>
          );
        }
        const failed = reimbursementFailure(state, l);
        return (
          <div key={key} className={inlineAmount ? "flex min-w-0 flex-col gap-1.5" : "flex min-w-0 flex-col gap-2 border-b border-border py-2"} data-testid={`reconcile-person-${l.personId}`}>
            {!personId && <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-xs">
              <span className="text-sm font-semibold text-foreground">{name}</span>
              <span className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                <Stat label="Installment" value={formatCurrency(l.share)} />
                <Stat label="Received" value={formatCurrency(l.received)} tone={l.received > PAYMENT_EPSILON ? "ok" : undefined} />
                <Stat label="Left" value={formatCurrency(l.remaining)} tone="owe" />
              </span>
            </div>}
            {!personId && <Segmented
              name={name}
              value={choice}
              disabled={locked}
              wrap
              options={CHOICES.map((c) => ({ value: c.value, label: c.value === "full" && l.received > PAYMENT_EPSILON ? "Received the Rest" : c.label }))}
              onChange={(v) => state.setLine(key, { choice: v, ...(v === "none" ? { amount: "" } : {}) })}
            />}
            {(personId || choice !== "none") && (
              <div className={inlineAmount ? "grid grid-cols-[minmax(7.5rem,1fr)_minmax(0,2fr)] items-end gap-1.5" : "flex flex-wrap items-center gap-1.5"}>
                {!inlineAmount && (personId || choice === "some") && (
                  <input
                    type="number"
                    inputMode="decimal"
                    aria-label={`Amount received from ${name}`}
                    placeholder={`Amount (max ${formatCurrency(l.remaining)})`}
                    disabled={locked}
                    className="h-9 w-40 max-w-full rounded-md border border-border bg-card px-2 text-xs tabular-nums"
                    value={d?.amount ?? ""}
                    onChange={(e) => state.setLine(key, { amount: e.target.value, ...(personId ? { choice: "some" } : {}) })}
                  />
                )}
                {personId && !inlineAmount && (
                  <button type="button" disabled={locked} className="min-h-8 text-xs font-semibold underline underline-offset-2" onClick={() => state.setLine(key, { choice: "some", amount: String(l.remaining) })}>
                    Use remaining {formatCurrencyExact(l.remaining)}
                  </button>
                )}
                {projected != null && <p className="basis-full text-xs text-muted-foreground">Left after this receipt <strong className="text-foreground">{formatCurrencyExact(projected)}</strong></p>}
                <div className="min-w-0">
                  {inlineAmount && <span className="mb-0.5 block text-[11px] font-medium text-muted-foreground">Received on</span>}
                  <DateInput
                    aria-label={`Date received from ${name}`}
                    title="Leave blank if you don't know the date"
                    className={inlineAmount ? "h-8 rounded-[6px] border border-border bg-card px-2 text-xs" : "h-8 w-36 rounded-[6px] border border-border bg-card px-2 text-xs"}
                    value={d?.date ?? ""}
                    max={todayText}
                    calendar={inlineAmount ? { dueDate: l.dueDate } : undefined}
                    disabled={locked}
                    onChange={(e) => state.setLine(key, { date: e.target.value })}
                  />
                </div>
                <Segmented name={`Where is ${name}'s money`} value={d?.treatment ?? null} disabled={locked} wrap options={TREATMENTS} onChange={(v) => state.setLine(key, { treatment: v })} />
              </div>
            )}
            {choice !== "none" && errors[key] && (
              <p role="alert" className="text-[11px] font-medium text-expense">
                {errors[key]}
              </p>
            )}
            {failed && (
              <p role="alert" className="text-[11px] font-semibold text-expense">
                {failed}
              </p>
            )}
          </div>
        );
      })}

      {anyReceived && (
        <label className="flex flex-wrap items-center gap-2 text-xs">
          <span className="shrink-0 font-medium text-muted-foreground">Account</span>
          <AccountSelect className="h-9 min-w-0 flex-1 basis-36 rounded-md border border-border bg-card px-2 text-xs" accounts={accounts as Account[]} value={state.accountId} onChange={state.setAccountId} ariaLabel="Received into account" />
        </label>
      )}

      {summary && summary.total > PAYMENT_EPSILON && (
        <p className="text-[11.5px] text-muted-foreground" data-testid="reconcile-summary">
          Recording <span className="font-semibold text-foreground tabular-nums">{formatCurrency(summary.total)}</span> ·{" "}
          {summary.balanceChange > PAYMENT_EPSILON ? `account +${formatCurrency(summary.balanceChange)}` : "account balance unchanged"}
          {!personId && pendingTotal > PAYMENT_EPSILON ? ` · ${formatCurrency(pendingTotal)} still owed` : ""}
        </p>
      )}

      {/* Optional reminder — hidden until someone still owes after this save and the user asks for it. */}
      {/* Not offered for one person: the reminder postpones every share still open on the installment. */}
      {!personId && pendingTotal > PAYMENT_EPSILON && summary && summary.total > PAYMENT_EPSILON && (
        <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="reconcile-reminder">
          {state.remindOn === "" && !reminderOpen ? (
            <button type="button" disabled={locked} onClick={() => { setReminderOpen(true); state.setRemindOn(defaultRemindOn()); }} className="font-semibold text-foreground underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring">
              Remind me about the rest
            </button>
          ) : (
            <>
              <span className="text-muted-foreground">Remind me on</span>
              <DateInput aria-label="Reminder date" className="h-8 w-36 rounded-[6px] border border-border bg-card px-2 text-xs" value={state.remindOn} min={todayText} disabled={locked} onChange={(e) => state.setRemindOn(e.target.value)} />
              <button type="button" disabled={locked} onClick={() => { setReminderOpen(false); state.setRemindOn(""); }} className="text-muted-foreground underline underline-offset-2">
                No reminder
              </button>
            </>
          )}
          {state.reminderStatus === "failed" && (
            <span role="alert" className="font-semibold text-expense">
              Payment saved, but the reminder wasn&apos;t. Set it from the person&apos;s page.
            </span>
          )}
        </div>
      )}
    </div>
  );
}
