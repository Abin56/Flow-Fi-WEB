"use client";

import { CalendarClock, Loader2 } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { DateInput } from "@/components/forms/date-input";
import { LOAN_EMI_INPUT } from "@/features/loans/components/loan-emi-ui";
import { usePaymentDeferralActions } from "@/features/people/hooks/use-payment-deferrals";
import { planSharePostpone, type PostponeShare } from "@/features/loans/lib/share-postpone-plan";
import { formatCycleLabel, formatStatementDate } from "@/lib/engines/person-cycle-statement";
import { cycleName, cycleStartReminderKind, defaultTargetCycle, targetCycleOptions } from "@/lib/engines/person-payment-deferral";
import { PAYMENT_EPSILON } from "@/lib/engines/person-payment";
import type { PersonPaymentDeferral } from "@/lib/models/person-payment-deferral";
import { formatCurrencyExact } from "@/lib/format";
import { cn } from "@/lib/utils";
import { toast } from "@/store/toast-store";

/**
 * Shared Loan / EMI Record payment — "Not received yet — postpone their share", right in the dialog. It writes the
 * ONE postponement People already has (`paymentDeferrals`, through `PaymentDeferralRepository`): only WHEN each
 * person's share is expected moves. It is never a payment — no ledger entry, no transaction, no account or balance
 * change — and the lender installment, its due date and its status stay exactly as they are. People's own
 * "Postpone collection" reads the same records, so both places always agree. The requests: `planSharePostpone`.
 */

export type { PostponeShare };

const newRequestId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
const toInputDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const fromInputDate = (s: string): Date | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
};
const chip = (active: boolean) =>
  cn(
    "h-8 rounded-full border px-3 text-xs font-semibold transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring",
    active ? "border-foreground bg-foreground text-background" : "border-border-strong text-foreground hover:bg-secondary",
  );

export function SharePostponePanel({
  people,
  dateOf,
  deferralsByPerson,
  startDay,
  lenderDueDate,
  onDone,
}: {
  people: readonly PostponeShare[];
  dateOf: (obligationKey: string) => Date;
  deferralsByPerson: Readonly<Record<string, readonly PersonPaymentDeferral[]>>;
  startDay: number;
  /** The lender installment's own due date — stated, never changed. */
  lenderDueDate: Date | null;
  /** Every share is postponed (the live deferrals then say so in the dialog). */
  onDone: () => void;
}) {
  const actions = usePaymentDeferralActions();
  const today = useMemo(() => new Date(), []);
  const keys = people.flatMap((p) => p.obligations.filter((o) => o.remaining > PAYMENT_EPSILON).map((o) => o.key));
  const latest = keys.reduce((m, k) => Math.max(m, dateOf(k).getTime()), 0);
  const { options, initialIdx } = useMemo(() => {
    const base = latest > 0 ? new Date(latest) : today;
    const list = targetCycleOptions(base, today, startDay, 12);
    const first = defaultTargetCycle(base, today, startDay, null);
    return { options: list, initialIdx: Math.max(0, list.findIndex((c) => c.start.getTime() === first.start.getTime())) };
  }, [latest, today, startDay]);
  const [targetIdx, setTargetIdx] = useState(initialIdx);
  const target = options[Math.min(targetIdx, options.length - 1)];
  const [remind, setRemind] = useState<"none" | "cycleStart" | "date">("none");
  const [dateText, setDateText] = useState("");
  const reminder =
    remind === "cycleStart"
      ? { kind: cycleStartReminderKind(target, today, startDay), remindOn: target.start }
      : remind === "date"
        ? (() => {
            const d = fromInputDate(dateText);
            return d ? { kind: "date" as const, remindOn: d } : null;
          })()
        : null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Saved shares, by person + share (several people share one installment key) — skipped on retry.
  const [doneKeys, setDoneKeys] = useState<ReadonlySet<string>>(() => new Set());
  const shareId = (personId: string, key: string) => `${personId}|${key}`;
  // One id per share per intent: a retry after a lost response is the same request (the write is idempotent).
  const requestIds = useRef(new Map<string, string>());
  const requestIdFor = (personId: string, key: string) => {
    let id = requestIds.current.get(shareId(personId, key));
    if (!id) requestIds.current.set(shareId(personId, key), (id = newRequestId()));
    return id;
  };
  const nameOf = (personId: string) => people.find((p) => p.personId === personId)?.personName ?? "";
  const inFlight = useRef(false);
  const total = people.reduce((t, p) => t + p.obligations.reduce((s, o) => s + Math.max(0, o.remaining), 0), 0);
  const names = people.map((p) => p.personName);
  const nameText = names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  const ready = !busy && keys.length > 0 && !(remind === "date" && reminder == null);

  async function submit() {
    if (!ready || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const requests = planSharePostpone({ people, dateOf, deferralsByPerson, target, reminder, startDay, now: new Date(), requestIdFor }).filter((r) => !doneKeys.has(shareId(r.personId, r.obligationKey)));
    const done = new Set(doneKeys);
    const failed: string[] = [];
    for (const r of requests) {
      try {
        await actions.apply(r);
        done.add(shareId(r.personId, r.obligationKey));
      } catch (e) {
        failed.push(`${nameOf(r.personId)}: ${e instanceof Error ? e.message : "couldn't postpone"}`);
      }
    }
    setDoneKeys(done);
    inFlight.current = false;
    setBusy(false);
    if (failed.length > 0) {
      setError(failed.join(" · "));
      return;
    }
    requestIds.current.clear();
    toast.success(`Moved to the ${cycleName(target, today)} cycle`, `${nameText}'s share is still owed — nothing was paid and the EMI is unchanged.`);
    onDone();
  }

  return (
    <div className="flex flex-col gap-2.5 rounded-[6px] border border-border bg-secondary/40 px-3 py-3" data-testid="share-postpone">
      <p className="text-[13px] text-foreground">
        <span className="font-semibold">{nameText}</span> still {names.length === 1 ? "owes" : "owe"} you{" "}
        <span className="font-semibold tabular-nums">{formatCurrencyExact(total)}</span> for this payment.
      </p>
      <div>
        <p className="mb-1.5 text-xs font-semibold text-foreground/85">Expect their money in</p>
        <div role="radiogroup" aria-label="Expected cycle" className="flex flex-wrap items-center gap-1.5">
          {options.slice(0, 2).map((c, i) => (
            <button key={c.start.getTime()} type="button" role="radio" aria-checked={targetIdx === i} title={formatCycleLabel(c, true)} className={chip(targetIdx === i)} onClick={() => setTargetIdx(i)}>
              {i === 0 ? `Next month · ${cycleName(c, today)}` : `${cycleName(c, today)} cycle`}
            </button>
          ))}
          <select
            aria-label="Another cycle"
            className={cn(LOAN_EMI_INPUT, "h-8 w-auto rounded-full px-2.5 text-xs font-semibold", targetIdx >= 2 && "border-foreground")}
            value={targetIdx >= 2 ? String(targetIdx) : ""}
            onChange={(e) => e.target.value !== "" && setTargetIdx(Number(e.target.value))}
          >
            <option value="">Another month…</option>
            {options.slice(2).map((c, i) => (
              <option key={c.start.getTime()} value={String(i + 2)}>
                {cycleName(c, today)} cycle · {formatCycleLabel(c, true)}
              </option>
            ))}
          </select>
        </div>
        <p className="mt-1 text-[11.5px] text-foreground/65 tabular-nums">{formatCycleLabel(target, true)}</p>
      </div>
      <div>
        <p className="mb-1.5 text-xs font-semibold text-foreground/85">
          Remind me <span className="font-normal text-foreground/60">(optional)</span>
        </p>
        <div role="radiogroup" aria-label="Reminder" className="flex flex-wrap items-center gap-1.5">
          <button type="button" role="radio" aria-checked={remind === "none"} className={chip(remind === "none")} onClick={() => setRemind("none")}>
            No reminder
          </button>
          <button type="button" role="radio" aria-checked={remind === "cycleStart"} className={chip(remind === "cycleStart")} onClick={() => setRemind("cycleStart")}>
            On {formatStatementDate(target.start)}
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={remind === "date"}
            className={chip(remind === "date")}
            onClick={() => {
              setRemind("date");
              if (!dateText) setDateText(toInputDate(target.start));
            }}
          >
            Pick a date
          </button>
          {remind === "date" && (
            <DateInput aria-label="Reminder date" className={cn(LOAN_EMI_INPUT, "h-8")} wrapperClassName="w-40" value={dateText} onChange={(e) => setDateText(e.target.value)} />
          )}
        </div>
      </div>
      <p className="flex items-start gap-2 text-[12px] leading-snug text-foreground/80" data-testid="share-postpone-preview">
        <CalendarClock className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <span>
          Not a payment: nothing is recorded, no account changes, and the EMI stays due
          {lenderDueDate ? ` on ${formatStatementDate(lenderDueDate, true)}` : ""}. Their share stays owed and is expected in the{" "}
          <span className="font-semibold">{cycleName(target, today)} cycle</span>.
        </span>
      </p>
      {error && (
        <p role="alert" className="text-xs font-semibold text-expense">
          {error}
        </p>
      )}
      <button
        type="button"
        onClick={() => void submit()}
        disabled={!ready}
        className="flex h-9 items-center justify-center gap-1.5 self-start rounded-[6px] border border-foreground bg-foreground px-3.5 text-sm font-semibold text-background outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        {busy && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
        {busy ? "Postponing…" : doneKeys.size > 0 ? "Retry postponing" : `Postpone to ${cycleName(target, today)} cycle`}
      </button>
    </div>
  );
}
