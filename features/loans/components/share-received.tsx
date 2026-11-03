"use client";

import { ArrowRight, CircleAlert, Loader2 } from "lucide-react";
import { useRef, useState } from "react";
import { AccountSelect } from "@/components/finance/account-label";
import { DateInput } from "@/components/forms/date-input";
import { Field, LOAN_EMI_INPUT } from "@/features/loans/components/loan-emi-ui";
import { useHistoricalReimbursement, type ReimbursementTarget } from "@/features/loans/hooks/use-historical-reimbursement";
import {
  planReimbursements,
  reimbursementLineKey,
  type ReimbursementDraft,
  type ReimbursementResult,
} from "@/lib/engines/historical-reimbursement";
import { PAYMENT_EPSILON, round2 } from "@/lib/engines/person-payment";
import { formatCurrencyExact } from "@/lib/format";
import type { Account } from "@/lib/models/account";
import { generateId } from "@/lib/utils/id-generator";

/**
 * Shared Loan / EMI Record payment — "Received": the person gave you their share, recorded right in the dialog.
 * It is the ONE People receipt (`recordPersonPayment`, through `useHistoricalReimbursement.record` — the same idempotent
 * per person × installment write the past-payment flow uses), always as a real receipt that credits the chosen
 * account on the chosen date. Paying the lender stays a separate, later step: this never touches the lender installment.
 *
 * Each person starts on their full open share; lowering the amount records a part receipt (oldest installment first)
 * and leaves the rest owed. A new idempotency batch starts after every fully saved run, so a later top-up is never
 * mistaken for a repeat of this one; a failed run keeps its batch, so a retry writes only what didn't save.
 */

export interface ReceivedSummary {
  names: string[];
  total: number;
}

const toInputDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const LABEL = "text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase";

export function ShareReceivedPanel({
  target,
  personIds,
  accounts,
  defaultAccountId,
  onDone,
  advanceSlot = null,
}: {
  target: ReimbursementTarget | null;
  /** Only these people's open shares are offered (the ones who haven't paid and aren't postponed). */
  personIds: readonly string[];
  accounts: readonly Account[];
  defaultAccountId: string;
  onDone: (summary: ReceivedSummary) => void;
  /** Shown above the form when someone already gave an advance (applying it comes first). */
  advanceSlot?: React.ReactNode;
}) {
  const { lines: allLines, isLoading, record } = useHistoricalReimbursement(target);
  const lines = allLines.filter((l) => personIds.includes(l.personId) && l.remaining > PAYMENT_EPSILON);
  const people = [...new Map(lines.map((l) => [l.personId, l.personName])).entries()].map(([personId, personName]) => {
    const own = lines.filter((l) => l.personId === personId);
    return { personId, personName, lines: own, total: round2(own.reduce((t, l) => t + l.remaining, 0)) };
  });

  // Typed amounts per person; untouched = the full open share.
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [pickedAccount, setAccountId] = useState("");
  const [date, setDate] = useState(() => toInputDate(new Date()));
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [batchId, setBatchId] = useState(generateId);
  const results = useRef<Record<string, ReimbursementResult>>({});
  const inFlight = useRef(false);
  const accountId = accounts.some((a) => a.id === pickedAccount) ? pickedAccount : accounts.some((a) => a.id === defaultAccountId) ? defaultAccountId : "";
  const today = toInputDate(new Date());

  const amountOf = (personId: string, total: number) => (typed[personId] ?? String(total));
  // Oldest installment first: full where the amount covers it, "some" for the one it runs out in.
  const draft: Record<string, ReimbursementDraft> = {};
  const personErrors: Record<string, string> = {};
  for (const p of people) {
    const n = Number(amountOf(p.personId, p.total));
    if (!Number.isFinite(n) || n < 0) {
      personErrors[p.personId] = "Enter the amount received.";
      continue;
    }
    if (n > p.total + PAYMENT_EPSILON) {
      personErrors[p.personId] = `More than ${p.personName} still owes (${formatCurrencyExact(p.total)}).`;
      continue;
    }
    let left = round2(n);
    for (const l of [...p.lines].sort((a, b) => a.sequenceNumber - b.sequenceNumber)) {
      const take = Math.min(left, l.remaining);
      left = round2(left - take);
      if (take <= PAYMENT_EPSILON) continue;
      draft[reimbursementLineKey(l)] = {
        choice: take >= l.remaining - PAYMENT_EPSILON ? "full" : "some",
        amount: String(take),
        // A real receipt: the money is added to the chosen account on the chosen date.
        treatment: "addToAccount",
        date,
      };
    }
  }
  const plan = planReimbursements({ lines, draft, batchId });
  const items = plan.ok ? plan.items : [];
  const total = plan.ok ? plan.summary.total : 0;
  const dateError = date === "" ? "Choose the date you received it." : date > today ? "Money already received can't be dated in the future." : null;
  const firstError = Object.values(personErrors)[0] ?? (plan.ok ? null : Object.values(plan.errors)[0]) ?? dateError;
  const blocker = firstError ?? (total <= PAYMENT_EPSILON ? "Enter an amount." : accountId === "" ? "Choose the account it was received into." : null);

  async function submit() {
    if (blocker || busy || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setFailed(null);
    const r = await record(items, accountId, results.current);
    results.current = r;
    const bad = items.filter((i) => r[i.key]?.status === "failed");
    inFlight.current = false;
    setBusy(false);
    if (bad.length > 0) {
      setFailed(`${bad.length} not saved — nothing was recorded twice. Try again.`);
      return;
    }
    // Fully saved: the next run (e.g. the rest of a part receipt) is a new request.
    results.current = {};
    setBatchId(generateId());
    setTyped({});
    onDone({ names: [...new Set(items.map((i) => i.personName))], total });
  }

  if (people.length === 0) {
    return (
      <div className="flex flex-col gap-2">
        {advanceSlot}
        {isLoading ? (
          <p role="status" className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" aria-hidden /> Checking who shares this…
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">Everyone&apos;s share is already received.</p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-testid="share-received">
      {advanceSlot}
      <div className="flex flex-col gap-1">
        <p className={LABEL}>Amount received</p>
        <ul className="divide-y divide-border overflow-hidden rounded-[6px] border border-border bg-card" aria-label="Shares received">
          {people.map((p) => (
            <li key={p.personId} className="flex flex-col gap-1 px-3 py-2">
              <div className="flex items-center gap-2.5">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-foreground uppercase">{p.personName}</span>
                  <span className="block text-[11px] text-muted-foreground">Share {formatCurrencyExact(p.total)}</span>
                </span>
                <input
                  type="number"
                  inputMode="decimal"
                  aria-label={`Amount received from ${p.personName}`}
                  disabled={busy}
                  className="h-8 w-28 rounded-[6px] border border-border bg-card px-2 text-right text-sm tabular-nums"
                  value={amountOf(p.personId, p.total)}
                  onChange={(e) => setTyped((t) => ({ ...t, [p.personId]: e.target.value }))}
                />
              </div>
              {personErrors[p.personId] && (
                <p role="alert" className="text-[11px] font-semibold text-expense">
                  {personErrors[p.personId]}
                </p>
              )}
            </li>
          ))}
        </ul>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Received into">
          <AccountSelect
            className={LOAN_EMI_INPUT}
            accounts={accounts as Account[]}
            value={accountId}
            onChange={setAccountId}
            placeholder="Select account"
            ariaLabel="Received into account"
          />
        </Field>
        <Field label="Date received">
          <DateInput className={LOAN_EMI_INPUT} aria-label="Date received" value={date} max={today} onChange={(e) => setDate(e.target.value)} />
        </Field>
      </div>

      <p className="text-xs text-muted-foreground" data-testid="share-received-preview">
        {total > PAYMENT_EPSILON ? `${formatCurrencyExact(total)} is added to ${accounts.find((a) => a.id === accountId)?.name ?? "the account you choose"}. ` : ""}
        This is only what they paid you — the lender installment is still to pay below.
      </p>

      {failed && (
        <div role="alert" className="flex items-start gap-1.5 rounded-[6px] bg-expense/10 px-3 py-2 text-xs text-foreground">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-expense" aria-hidden />
          <span>{failed}</span>
        </div>
      )}
      {firstError && !Object.values(personErrors).length && (
        <p className="text-xs font-medium text-expense" role="alert">
          {firstError}
        </p>
      )}

      <button
        type="button"
        onClick={() => void submit()}
        disabled={blocker != null || busy}
        className="flex h-9 items-center justify-center gap-1.5 self-start rounded-[6px] border border-foreground bg-foreground px-3.5 text-sm font-semibold text-background outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <ArrowRight className="size-3.5" aria-hidden />}
        {busy ? "Recording…" : failed ? "Retry recording" : total > PAYMENT_EPSILON ? `Record ${formatCurrencyExact(total)} received` : "Record received"}
      </button>
    </div>
  );
}
