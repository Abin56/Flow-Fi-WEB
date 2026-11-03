"use client";

import { ArrowRight, CalendarClock, CheckCircle2, CircleAlert, Landmark, Loader2, X } from "lucide-react";
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

/**
 * Shared Loan / EMI Record payment — "Not received yet — postpone their share", right in the dialog. It writes the
 * ONE postponement People already has (`paymentDeferrals`, through `PaymentDeferralRepository`): only WHEN each
 * person's share is expected moves. It is never a payment — no ledger entry, no transaction, no account or balance
 * change — and the lender installment, its due date and its status stay exactly as they are. People's own
 * "Postpone collection" reads the same records, so both places always agree. The requests: `planSharePostpone`.
 *
 * Layout, top to bottom: who hasn't paid (each person's open share, pick who to postpone) → when to expect it (next
 * month, or a later cycle) → an optional reminder → what will happen (their share vs. the lender EMI, side by side)
 * → one action. Success is reported by the dialog (`onDone`), which keeps the result on screen.
 */

export type { PostponeShare };

/** What was postponed — the dialog shows it as its success state. */
export interface SharePostponeResult {
  names: string[];
  total: number;
  cycle: string;
  range: string;
  reminderOn: Date | null;
}

const newRequestId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
const toInputDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const fromInputDate = (s: string): Date | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
};
const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const joinNames = (names: readonly string[]) => (names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);
const chip = (active: boolean) =>
  cn(
    "h-8 rounded-full border px-3 text-xs font-semibold whitespace-nowrap transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring",
    active ? "border-foreground bg-foreground text-background" : "border-border-strong bg-card text-foreground hover:bg-secondary",
  );
const LABEL = "text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase";

export function SharePostponePanel({
  people,
  dateOf,
  deferralsByPerson,
  startDay,
  lenderDueDate,
  onDone,
  only = null,
}: {
  /** Start with just this person selected (their row's "Postpone"); null = everyone who hasn't paid. */
  only?: string | null;
  people: readonly PostponeShare[];
  dateOf: (obligationKey: string) => Date;
  deferralsByPerson: Readonly<Record<string, readonly PersonPaymentDeferral[]>>;
  startDay: number;
  /** The lender installment's own due date — stated, never changed. */
  lenderDueDate: Date | null;
  /** Every chosen share is postponed (the live deferrals then say so in the dialog). */
  onDone: (result: SharePostponeResult) => void;
}) {
  const actions = usePaymentDeferralActions();
  const today = useMemo(() => new Date(), []);
  const owing = people.map((p) => ({ ...p, total: p.obligations.reduce((s, o) => s + Math.max(0, o.remaining), 0) })).filter((p) => p.total > PAYMENT_EPSILON);
  // Who to postpone — everyone who hasn't paid, until the user unticks someone.
  const [off, setOff] = useState<ReadonlySet<string>>(() => new Set(only ? owing.filter((p) => p.personId !== only).map((p) => p.personId) : []));
  const chosen = owing.filter((p) => !off.has(p.personId));
  const keys = chosen.flatMap((p) => p.obligations.filter((o) => o.remaining > PAYMENT_EPSILON).map((o) => o.key));
  // Every chosen share must move after its own cycle: the latest-dated share decides the earliest choice.
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
  const pickedDate = remind === "date" ? fromInputDate(dateText) : null;
  const reminder =
    remind === "cycleStart"
      ? { kind: cycleStartReminderKind(target, today, startDay), remindOn: target.start }
      : pickedDate
        ? { kind: "date" as const, remindOn: pickedDate }
        : null;
  const reminderError =
    remind !== "date" ? null : pickedDate == null ? "Choose a reminder date." : dayStart(pickedDate) < dayStart(today) ? "A reminder can't be in the past." : null;

  const [busy, setBusy] = useState(false);
  const [failures, setFailures] = useState<{ name: string; message: string }[]>([]);
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
  const inFlight = useRef(false);
  const total = chosen.reduce((t, p) => t + p.total, 0);
  const names = chosen.map((p) => p.personName);
  const nobody = chosen.length === 0;
  const ready = !busy && !nobody && reminderError == null;
  const range = formatCycleLabel(target, true);
  const month = cycleName(target, today);

  async function submit() {
    if (!ready || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setFailures([]);
    const requests = planSharePostpone({ people: chosen, dateOf, deferralsByPerson, target, reminder, startDay, now: new Date(), requestIdFor }).filter(
      (r) => !doneKeys.has(shareId(r.personId, r.obligationKey)),
    );
    const done = new Set(doneKeys);
    const failed: { name: string; message: string }[] = [];
    for (const r of requests) {
      try {
        await actions.apply(r);
        done.add(shareId(r.personId, r.obligationKey));
      } catch (e) {
        failed.push({ name: chosen.find((p) => p.personId === r.personId)?.personName ?? "", message: e instanceof Error ? e.message : "Couldn't postpone." });
      }
    }
    setDoneKeys(done);
    inFlight.current = false;
    setBusy(false);
    if (failed.length > 0) {
      setFailures(failed);
      return;
    }
    requestIds.current.clear();
    onDone({ names, total, cycle: month, range, reminderOn: reminder?.remindOn ?? null });
  }

  if (owing.length === 0) {
    return <p className="text-xs text-muted-foreground">Everyone&apos;s share is already received — nothing to postpone.</p>;
  }

  return (
    <div className="flex flex-col gap-3" data-testid="share-postpone">
      {/* Who hasn't paid — each person's own open share. */}
      <div className="flex flex-col gap-1">
        <p className={LABEL}>Not received from</p>
        <ul className="divide-y divide-border overflow-hidden rounded-[6px] border border-border bg-card" aria-label="Shares not received">
          {owing.map((p) => {
            const on = !off.has(p.personId);
            const row = (
              <>
                <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground uppercase">{p.personName}</span>
                <span className="shrink-0 text-sm font-semibold text-foreground tabular-nums">{formatCurrencyExact(p.total)}</span>
              </>
            );
            return (
              <li key={p.personId}>
                {owing.length > 1 ? (
                  <label className={cn("flex cursor-pointer items-center gap-2.5 px-3 py-2", !on && "opacity-60")}>
                    <input
                      type="checkbox"
                      className="size-4 shrink-0 accent-[var(--color-primary)]"
                      checked={on}
                      disabled={busy || doneKeys.size > 0}
                      aria-label={`Postpone ${p.personName}'s share`}
                      onChange={() =>
                        setOff((s) => {
                          const next = new Set(s);
                          if (next.has(p.personId)) next.delete(p.personId);
                          else next.add(p.personId);
                          return next;
                        })
                      }
                    />
                    {row}
                  </label>
                ) : (
                  <span className="flex items-center gap-2.5 px-3 py-2">{row}</span>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      {/* When to expect it — next month by default. */}
      <div className="flex flex-col gap-1.5">
        <p className={LABEL}>Expect their money in</p>
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
            <option value="">Later…</option>
            {options.slice(2).map((c, i) => (
              <option key={c.start.getTime()} value={String(i + 2)}>
                {cycleName(c, today)} cycle · {formatCycleLabel(c, true)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Optional reminder. */}
      <div className="flex flex-col gap-1.5">
        <p className={LABEL}>
          Reminder <span className="font-normal tracking-normal normal-case">(optional)</span>
        </p>
        <div role="radiogroup" aria-label="Reminder" className="flex flex-wrap items-center gap-1.5">
          <button type="button" role="radio" aria-checked={remind === "none"} className={chip(remind === "none")} onClick={() => setRemind("none")}>
            None
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
            <DateInput
              aria-label="Reminder date"
              aria-invalid={reminderError ? true : undefined}
              className={cn(LOAN_EMI_INPUT, "h-8")}
              wrapperClassName="w-40"
              value={dateText}
              min={toInputDate(today)}
              onChange={(e) => setDateText(e.target.value)}
            />
          )}
        </div>
        {reminderError && (
          <p className="text-xs font-medium text-expense" role="alert">
            {reminderError}
          </p>
        )}
      </div>

      {/* What will happen: their share moves; the lender EMI does not. */}
      <dl className="overflow-hidden rounded-[6px] border border-border bg-card text-xs" data-testid="share-postpone-preview" aria-label="What will happen">
        <div className="flex items-start gap-2.5 px-3 py-2">
          <CalendarClock className="mt-0.5 size-3.5 shrink-0 text-settle-split-text" aria-hidden />
          <dt className="sr-only">Their share</dt>
          <dd className="min-w-0 flex-1">
            <span className="font-semibold text-foreground">{nobody ? "No one selected" : `${joinNames(names)}'s ${formatCurrencyExact(total)}`}</span>
            <span className="text-muted-foreground"> — expected in </span>
            <span className="font-semibold text-foreground">{month} cycle</span>
            <span className="block text-muted-foreground tabular-nums">
              {range}
              {reminder ? ` · reminder ${formatStatementDate(reminder.remindOn)}` : ""}
            </span>
          </dd>
        </div>
        <div className="flex items-start gap-2.5 border-t border-border px-3 py-2">
          <Landmark className="mt-0.5 size-3.5 shrink-0 text-foreground/70" aria-hidden />
          <dt className="sr-only">Lender EMI</dt>
          <dd className="min-w-0 flex-1">
            <span className="font-semibold text-foreground">Lender EMI unchanged</span>
            <span className="block text-muted-foreground">
              Still due{lenderDueDate ? ` ${formatStatementDate(lenderDueDate, true)}` : ""}. Not a payment: nothing is recorded and no account changes.
            </span>
          </dd>
        </div>
      </dl>

      {failures.length > 0 && (
        <div role="alert" className="flex items-start gap-1.5 rounded-[6px] bg-expense/10 px-3 py-2 text-xs text-foreground">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-expense" aria-hidden />
          <span>
            {failures.map((f) => `${f.name}: ${f.message}`).join(" · ")}
            {doneKeys.size > 0 && <span className="text-muted-foreground"> The others are saved — retry sends only these.</span>}
          </span>
        </div>
      )}

      <button
        type="button"
        onClick={() => void submit()}
        disabled={!ready}
        className="flex h-9 items-center justify-center gap-1.5 self-start rounded-[6px] border border-foreground bg-foreground px-3.5 text-sm font-semibold text-background outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <ArrowRight className="size-3.5" aria-hidden />}
        {busy
          ? "Postponing…"
          : failures.length > 0
            ? "Retry postponing"
            : nobody
              ? "Choose who to postpone"
              : `Postpone ${chosen.length === 1 ? `${names[0]}'s share` : `${chosen.length} shares`} to ${month}`}
      </button>
    </div>
  );
}

/** The dialog's success state after postponing: whose share, until when — and that the lender EMI didn't move. */
export function PostponedBanner({ result, lenderDueDate, onDismiss }: { result: SharePostponeResult; lenderDueDate: Date | null; onDismiss: () => void }) {
  return (
    <div role="status" className="flex items-start gap-2.5 rounded-[8px] border border-success/40 bg-success/10 px-3 py-2.5 text-xs text-foreground" data-testid="share-postponed">
      <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-semibold">
          Postponed — {joinNames(result.names)}&apos;s {formatCurrencyExact(result.total)} now expected in the {result.cycle} cycle
        </span>
        <span className="block text-muted-foreground">
          {result.range}
          {result.reminderOn ? ` · reminder ${formatStatementDate(result.reminderOn)}` : ""} · still owed to you. Nothing was paid; the lender EMI is still due
          {lenderDueDate ? ` ${formatStatementDate(lenderDueDate, true)}` : ""}.
        </span>
      </span>
      <button type="button" onClick={onDismiss} aria-label="Dismiss" className="-m-1 rounded-[6px] p-1 text-foreground/60 outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
        <X className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}
