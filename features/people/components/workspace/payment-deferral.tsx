"use client";

/**
 * "Postpone payment" on one open People obligation — moves only WHEN collection is expected (see
 * `lib/models/person-payment-deferral.ts`). The original transaction, its amount and date, and every total
 * stay exactly as they are; what is shown as expected is always the row's live remaining.
 *
 * Mirrors `follow-up.tsx`: rows read their deferral from `DeferralContext`, keyed by statement row key, so
 * the row model and the totals never carry it.
 */

import { CalendarClock, Undo2 } from "lucide-react";
import { createContext, useContext, useMemo, useRef, useState } from "react";
import { DateInput } from "@/components/forms/date-input";
import { money } from "@/lib/engines/person-cycle-statement-share";
import { cycleContaining, formatCycleLabel, formatStatementDate, type StatementCycle } from "@/lib/engines/person-cycle-statement";
import {
  cycleName,
  cycleStartReminderKind,
  DEFERRAL_NOTE_MAX,
  defaultTargetCycle,
  deferralCycleSummary,
  isPostponableObligation,
  targetCycleOptions,
  type DeferralRequest,
  type DeferralView,
} from "@/lib/engines/person-payment-deferral";
import type { FollowUpKind } from "@/lib/models/person-follow-up";
import { DEFERRAL_REASON_LABEL, DEFERRAL_REASONS, type DeferralReason } from "@/lib/models/person-payment-deferral";
import { cn } from "@/lib/utils";
import { toast } from "@/store/toast-store";
import type { LedgerRow } from "@/features/people/lib/person-ledger-rows";
import { FollowUpContext } from "./follow-up";
import { WS_FIELD } from "./person-workspace-ui";

/** The request minus what the workspace fills in (person, start day, clock). */
export type DeferralSubmit = DeferralRequest extends infer R ? (R extends DeferralRequest ? Omit<R, "personId" | "startDay" | "now"> : never) : never;

export interface DeferralContextValue {
  /** Active deferrals with their live status, by obligation key. */
  byKey: ReadonlyMap<string, DeferralView>;
  /** Stored revision per obligation key (incl. cleared docs) — every write must match it. */
  revisionByKey: ReadonlyMap<string, number>;
  cycleStartDay: number;
  personName: string;
  /** Resolves "written" / "noop"; throws `PaymentDeferralError` on a conflict or invalid request. */
  onApply: (request: DeferralSubmit, options?: { silent?: boolean }) => Promise<"written" | "noop">;
}

export const DeferralContext = createContext<DeferralContextValue | null>(null);

const newRequestId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
const rangeLabel = (c: StatementCycle) => formatCycleLabel(c, true);
const toInputDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const fromInputDate = (s: string): Date | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
};

export function canPostponeRow(row: Pick<LedgerRow, "statementRow" | "category" | "remaining" | "state">): boolean {
  return (row.state === "open" || row.state === "partial") && isPostponableObligation({ kind: row.statementRow?.kind, category: row.category, signedAmount: row.statementRow?.signedAmount ?? 0, remaining: row.remaining });
}

/** A row's live postponement for display — the cycle it was moved to ("Nov") and the cycle it came from. */
export function useRowDeferral(rowKey: string, rowDate: Date): { status: Exclude<DeferralView["status"], "resolved">; name: string; from: string; range: string } | null {
  const ctx = useContext(DeferralContext);
  const view = ctx?.byKey.get(rowKey);
  if (!ctx || !view || view.status === "resolved") return null;
  return { status: view.status, name: cycleName(view.cycle), from: cycleName(cycleContaining(rowDate, ctx.cycleStartDay)), range: rangeLabel(view.cycle) };
}

/**
 * "Moved to Nov cycle" — a secondary line under the row. `hidePostponed`: the row's status already says it.
 * Never changes the row's amounts.
 */
export function DeferralNote({ rowKey, rowDate, className, hidePostponed = false }: { rowKey: string; rowDate: Date; className?: string; hidePostponed?: boolean }) {
  const view = useRowDeferral(rowKey, rowDate);
  if (!view || (hidePostponed && view.status === "postponed")) return null;
  const { name, from } = view;
  const text =
    view.status === "postponed"
      ? `Moved to ${name} cycle`
      : view.status === "expectedNow"
        ? `Due this cycle · moved from ${from} cycle`
        : `Was moved to ${name} cycle · still not paid`;
  return (
    <span
      title={`Expected payment: ${view.range}. First due in the ${from} cycle. The amount and totals do not change.`}
      className={cn(
        "inline-flex items-center gap-1 text-[11px] font-semibold",
        view.status === "lapsed" ? "text-warning" : view.status === "expectedNow" ? "text-primary-accent-text" : "text-foreground/70",
        className,
      )}
    >
      <CalendarClock className="size-3 shrink-0" aria-hidden />
      {text}
    </span>
  );
}

const CHIP =
  "h-8 rounded-full border px-2.5 text-xs font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
const chip = (on: boolean) => cn(CHIP, on ? "border-primary-accent-text bg-primary/15 text-foreground" : "border-border-strong bg-card text-foreground/80 hover:bg-secondary");
const BTN =
  "inline-flex h-7 items-center gap-1 rounded-[6px] border border-border-strong bg-card px-2 text-[12px] font-semibold text-foreground outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

type ReminderMode = "none" | "cycleStart" | "date";

/** In a row's expansion: Postpone / Change cycle / Undo. Renders nothing for rows that can't be postponed. */
export function DeferralControl({ row, title }: { row: LedgerRow; title: string }) {
  const ctx = useContext(DeferralContext);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!ctx) return null;
  const view = ctx.byKey.get(row.key);
  const live = view && view.status !== "resolved" ? view : null;
  const eligible = canPostponeRow(row);
  if (!eligible && !live) return null;

  const undo = async () => {
    setBusy(true);
    setError(null);
    try {
      await ctx.onApply({ action: "undo", requestId: newRequestId(), expectedRevision: ctx.revisionByKey.get(row.key) ?? 0, obligationKey: row.key, obligationTitle: title });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't undo. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={cn("min-w-0", editing && eligible && "basis-full")} onClick={(e) => e.stopPropagation()}>
      {editing && eligible ? (
        <>
        <p className="mb-1 text-[10.5px] font-bold tracking-[0.08em] text-foreground/65 uppercase">Payment timing</p>
        <PostponePanel row={row} title={title} onDone={() => setEditing(false)} />
        </>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-0.5 text-[10.5px] font-bold tracking-[0.08em] text-foreground/65 uppercase">Payment timing</span>
          {live ? (
            <>
              <DeferralNote rowKey={row.key} rowDate={row.date} className="mr-1" />
              {live.deferral.expected?.reason && (
                <span className="mr-1 text-[11.5px] text-foreground/65">
                  · {live.deferral.expected.reason === "other" && live.deferral.expected.note ? live.deferral.expected.note : DEFERRAL_REASON_LABEL[live.deferral.expected.reason]}
                </span>
              )}
              {eligible && (
                <button type="button" className={BTN} disabled={busy} onClick={() => setEditing(true)}>
                  Change cycle
                </button>
              )}
              <button type="button" className={BTN} disabled={busy} onClick={undo} title="Restore the previous expected cycle">
                <Undo2 className="size-3.5" aria-hidden />
                {live.undoTo ? `Back to ${cycleName(live.undoTo)} cycle` : "Undo postponement"}
              </button>
            </>
          ) : (
            <>
              <button type="button" className={BTN} disabled={busy} onClick={() => setEditing(true)} title="Can't be paid this cycle? Move when it's expected — the amount and totals don't change.">

                <CalendarClock className="size-3.5" aria-hidden />
                Postpone payment
              </button>
            </>
          )}
        </div>
      )}
      {error && !editing && (
        <p role="alert" className="mt-1 text-[11.5px] font-medium text-expense">
          {error}
        </p>
      )}
    </div>
  );
}

function PostponePanel({ row, title, onDone }: { row: LedgerRow; title: string; onDone: () => void }) {
  const items = useMemo(() => [{ row, title }], [row, title]);
  const draft = usePostponeDraft(items);
  const submit = async () => {
    if (await draft.submit()) onDone();
  };
  return (
    <div role="group" aria-label="Postpone payment" className="max-w-2xl rounded-[8px] border border-border-strong bg-card px-3 py-2.5">
      <PostponeFields draft={draft} />
      {draft.error && (
        <p role="alert" className="mt-1.5 text-[12px] font-medium text-expense">
          {draft.error}
        </p>
      )}
      <div className="mt-2.5 flex items-center justify-end gap-1.5">
        <button type="button" className={cn(BTN, "h-8 px-3")} disabled={draft.busy} onClick={onDone}>
          Cancel
        </button>
        <button
          type="button"
          className={cn(BTN, "h-8 border-primary-accent-text bg-primary px-3 text-primary-foreground hover:bg-primary hover:opacity-90")}
          disabled={!draft.ready}
          aria-busy={draft.busy}
          onClick={submit}
        >
          {draft.busy ? "Moving…" : "Move payment"}
        </button>
      </div>
    </div>
  );
}

/** One open receivable to postpone — its live ledger row and the title the reminder / toast use. */
export interface PostponeItem {
  row: LedgerRow;
  title: string;
}

export type PostponeDraft = ReturnType<typeof usePostponeDraft>;

/**
 * The postpone form's state and its one write path (`DeferralContext.onApply`, one request per obligation),
 * shared by a row's "Postpone payment" and Record payment's "Hasn't paid yet". It never records money: the
 * only write is the private deferral (and, when chosen, its reminder) through the existing repository.
 */
export function usePostponeDraft(items: readonly PostponeItem[]) {
  // Tolerates no provider (Record payment outside a ledger): nothing is offered there, and nothing is written.
  const ctx = useContext(DeferralContext);
  const followUps = useContext(FollowUpContext);
  const today = useMemo(() => new Date(), []);
  const startDay = ctx?.cycleStartDay ?? 1;
  const views = items.map(({ row }) => {
    const v = ctx?.byKey.get(row.key);
    return v && v.status !== "resolved" ? v : null;
  });
  const single = items.length === 1 ? views[0] : null;
  const anyView = views.some((v) => v != null);
  // Every item must move to a cycle after its own: the latest-dated item and the latest default decide.
  const latestDay = items.reduce((m, { row }) => Math.max(m, row.date.getTime()), 0);
  const viewKey = views.map((v) => v?.cycle.start.getTime() ?? 0).join(",");
  const { options, initial } = useMemo(() => {
    const base = latestDay > 0 ? new Date(latestDay) : today;
    let initial = defaultTargetCycle(base, today, startDay, null);
    items.forEach(({ row }, i) => {
      const d = defaultTargetCycle(row.date, today, startDay, views[i]?.cycle ?? null);
      if (d.start.getTime() > initial.start.getTime()) initial = d;
    });
    const list = targetCycleOptions(base, today, startDay, 12);
    if (!list.some((c) => c.start.getTime() === initial.start.getTime())) list.push(initial);
    return { options: list, initial };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `latestDay` / `viewKey` stand for the items' dates and views
  }, [latestDay, today, startDay, viewKey]);
  const [targetIdx, setTargetIdx] = useState(() => Math.max(0, options.findIndex((c) => c.start.getTime() === initial.start.getTime())));
  const [reason, setReason] = useState<DeferralReason | null>(single?.deferral.expected?.reason ?? null);
  const [note, setNote] = useState(single?.deferral.expected?.note ?? "");
  const [reminderMode, setReminderMode] = useState<ReminderMode>("none");
  const [dateText, setDateText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One id per obligation per intent: a retry after a lost response is recognised as the same request (no double write).
  const requestIds = useRef(new Map<string, string>());
  const requestIdFor = (key: string) => {
    let id = requestIds.current.get(key);
    if (!id) requestIds.current.set(key, (id = newRequestId()));
    return id;
  };
  // A ref, not state: a double click lands before the re-render that disables the button.
  const inFlight = useRef(false);

  const target = options[Math.min(targetIdx, options.length - 1)];
  const remaining = items.reduce((t, { row }) => t + (row.remaining ?? 0), 0);
  const reminder: { kind: FollowUpKind; remindOn: Date } | null =
    reminderMode === "cycleStart"
      ? { kind: cycleStartReminderKind(target, today, startDay), remindOn: target.start }
      : reminderMode === "date"
        ? (() => {
            const d = fromInputDate(dateText);
            return d ? { kind: "date" as const, remindOn: d } : null;
          })()
        : null;
  const reminderMissing = reminderMode === "date" && reminder == null;
  // With no new reminder, an existing one before the new cycle is re-dated by the write — say so.
  const movingReminder =
    reminderMode !== "none"
      ? null
      : (items
          .map(({ row }) => followUps?.byKey.get(row.key))
          .find((f) => f != null && f.status !== "resolved" && f.followUp.remindOn.getTime() < target.start.getTime())?.followUp.remindOn ?? null);

  // Each obligation is its own transaction (the repository has no multi-obligation write), so several items can
  // partly succeed: saved ones are remembered and skipped on retry; failures are reported by name.
  const [doneKeys, setDoneKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [failures, setFailures] = useState<{ key: string; title: string; message: string }[]>([]);
  const pending = items.filter(({ row }) => !doneKeys.has(row.key));

  /** Resolves true once every obligation's postponement is saved (or already was); false if any failed. */
  const submit = async (): Promise<boolean> => {
    if (!ctx || inFlight.current || pending.length === 0 || reminderMissing) return false;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const done = new Set(doneKeys);
    const multi = items.length > 1;
    const failed: { key: string; title: string; message: string }[] = [];
    try {
      for (const { row, title } of pending) {
        try {
          const request: DeferralSubmit = {
          action: "postpone",
          requestId: requestIdFor(row.key),
          expectedRevision: ctx.revisionByKey.get(row.key) ?? 0,
          obligationKey: row.key,
          obligationTitle: title,
          obligationDate: row.date,
          remaining: row.remaining ?? 0,
          target,
          reason,
          note: reason === "other" ? note.trim() || null : null,
          reminder,
          };
          await (multi ? ctx.onApply(request, { silent: true }) : ctx.onApply(request));
          done.add(row.key);
        } catch (e) {
          failed.push({ key: row.key, title, message: e instanceof Error ? e.message : "Couldn't move the payment. Please try again." });
        }
      }
      setDoneKeys(done);
      setFailures(failed);
      // One item: its own message. Several: an honest count — never implies all were postponed.
      const saved = items.filter(({ row }) => done.has(row.key)).length;
      // Several items: one consolidated notification for the whole run (each save was silent).
      if (multi) {
        const n = (k: number) => `${k} ${k === 1 ? "payment" : "payments"}`;
        if (failed.length === 0) toast.success(`${n(saved)} postponed successfully.`, "Still owed — the original transactions and totals are unchanged.");
        else toast.error(`${n(saved)} postponed · ${failed.length} failed.`, `Not postponed: ${failed.map((f) => f.title).join(", ")}. Retry from the panel.`);
      }
      if (failed.length === 0) return true;
      setError(
        items.length === 1
          ? failed[0].message
          : `${saved} ${saved === 1 ? "payment" : "payments"} postponed · ${failed.length} could not be postponed`,
      );
      return false;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const pendingRemaining = pending.reduce((t, { row }) => t + (row.remaining ?? 0), 0);

  return {
    personName: ctx?.personName ?? "",
    today,
    options,
    targetIdx,
    setTargetIdx,
    target,
    single,
    anyView,
    remaining,
    reason,
    setReason,
    note,
    setNote,
    reminderMode,
    setReminderMode,
    dateText,
    setDateText,
    movingReminder,
    busy,
    error,
    /** Saved in this session (skipped on retry) / failed on the last attempt, by obligation key. */
    doneKeys,
    failures,
    /** What a retry would still postpone — only the items not yet saved. */
    pendingRemaining,
    retrying: doneKeys.size > 0 && pending.length > 0,
    ready: !busy && !reminderMissing && pending.length > 0,
    submit,
  };
}

/** The postpone choices — expected cycle, optional reason, optional reminder — and a plain-language preview. */
export function PostponeFields({ draft, noMoneyNote = false }: { draft: PostponeDraft; noMoneyNote?: boolean }) {
  const { options, targetIdx, setTargetIdx, target, today, single, anyView, remaining, reason, setReason, note, setNote, reminderMode, setReminderMode, dateText, setDateText } = draft;
  const chipCount = 3;
  return (
    <>
      <p className="text-[13px] text-foreground">
        <span className="font-semibold">{draft.personName}</span> still owes <span className="font-bold tabular-nums">{money(remaining)}</span>
        {single && <span className="text-foreground/70"> · now expected {cycleName(single.cycle)} cycle</span>}
      </p>

      <p className="mt-2 mb-1 text-[11.5px] font-semibold text-foreground/75">Move expected payment to</p>
      <div role="radiogroup" aria-label="Expected cycle" className="flex flex-wrap items-center gap-1.5">
        {options.slice(0, chipCount).map((c, i) => (
          <button key={c.start.getTime()} type="button" role="radio" aria-checked={targetIdx === i} title={rangeLabel(c)} className={chip(targetIdx === i)} onClick={() => setTargetIdx(i)}>
            {i === 0 && !anyView ? `Next cycle · ${cycleName(c, today)}` : `${cycleName(c, today)} cycle`}
          </button>
        ))}
        <select
          aria-label="Later cycle"
          className={cn(WS_FIELD, "h-8 w-auto max-w-full truncate rounded-full px-2.5 text-xs font-semibold", targetIdx >= chipCount && "border-primary-accent-text bg-primary/15")}
          value={targetIdx >= chipCount ? String(targetIdx) : ""}
          onChange={(e) => e.target.value !== "" && setTargetIdx(Number(e.target.value))}
        >
          <option value="">Later…</option>
          {options.slice(chipCount).map((c, i) => (
            <option key={c.start.getTime()} value={String(i + chipCount)}>
              {cycleName(c, today)} cycle · {rangeLabel(c)}
            </option>
          ))}
        </select>
      </div>
      <p className="mt-1 text-[11.5px] text-foreground/65 tabular-nums">{rangeLabel(target)}</p>

      <p className="mt-2 mb-1 text-[11.5px] font-semibold text-foreground/75">
        Reason <span className="font-normal text-foreground/60">(optional)</span>
      </p>
      <div role="radiogroup" aria-label="Reason" className="flex flex-wrap items-center gap-1.5">
        {DEFERRAL_REASONS.map((r) => (
          <button key={r} type="button" role="radio" aria-checked={reason === r} className={chip(reason === r)} onClick={() => setReason(reason === r ? null : r)}>
            {DEFERRAL_REASON_LABEL[r]}
          </button>
        ))}
        {reason === "other" && (
          <input aria-label="Reason note" className={cn(WS_FIELD, "h-8 w-56 max-w-full")} maxLength={DEFERRAL_NOTE_MAX} placeholder="Add a short note" value={note} onChange={(e) => setNote(e.target.value)} />
        )}
      </div>

      <p className="mt-2 mb-1 text-[11.5px] font-semibold text-foreground/75">
        Reminder <span className="font-normal text-foreground/60">(optional)</span>
      </p>
      <div role="radiogroup" aria-label="Reminder" className="flex flex-wrap items-center gap-1.5">
        <button type="button" role="radio" aria-checked={reminderMode === "none"} className={chip(reminderMode === "none")} onClick={() => setReminderMode("none")}>
          No new reminder
        </button>
        <button type="button" role="radio" aria-checked={reminderMode === "cycleStart"} className={chip(reminderMode === "cycleStart")} onClick={() => setReminderMode("cycleStart")}>
          When the cycle starts · {formatStatementDate(target.start)}
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={reminderMode === "date"}
          className={chip(reminderMode === "date")}
          onClick={() => {
            setReminderMode("date");
            if (!dateText) setDateText(toInputDate(target.start));
          }}
        >
          Choose date
        </button>
        {reminderMode === "date" && (
          <DateInput aria-label="Reminder date" className={cn(WS_FIELD, "h-8")} wrapperClassName="w-40" value={dateText} onChange={(e) => setDateText(e.target.value)} />
        )}
      </div>
      {draft.movingReminder && (
        <p className="mt-1 text-[11.5px] text-foreground/65">
          Your reminder on {formatStatementDate(draft.movingReminder)} moves to {formatStatementDate(target.start)} so it won&apos;t show as overdue.
        </p>
      )}

      <p className="mt-2.5 rounded-[6px] border border-border-strong/70 bg-secondary/60 px-2.5 py-1.5 text-[12.5px] leading-snug text-foreground" data-testid="postpone-preview">
        <span className="font-semibold tabular-nums">{money(remaining)}</span> will remain unpaid and will be expected in the{" "}
        <span className="font-semibold">{cycleName(target, today)} cycle</span> ({rangeLabel(target)}).{" "}
        {noMoneyNote ? "No money will be recorded and your balances will not change." : "The original transaction and your financial totals will not change."}
      </p>
    </>
  );
}

/**
 * Selected-cycle line: what is postponed to a later cycle vs. expected here after a postponement. Display
 * only — both amounts are already inside the cycle's pending figures and are never added again.
 */
export function DeferralCycleSummary({ cycle, className }: { cycle: StatementCycle; className?: string }) {
  const ctx = useContext(DeferralContext);
  const summary = useMemo(() => (ctx ? deferralCycleSummary(ctx.byKey.values(), cycle) : null), [ctx, cycle]);
  if (!summary || (summary.postponedLaterCount === 0 && summary.expectedHereCount === 0)) return null;
  return (
    <p aria-label="Postponed payments" className={cn("mt-3 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px] text-foreground/75 tabular-nums", className)}>
      <CalendarClock className="size-3.5 text-foreground/60" aria-hidden />
      {summary.expectedHereCount > 0 && (
        <span>
          Expected this cycle after postponement <span className="font-semibold text-foreground">{money(summary.expectedHere)}</span>
        </span>
      )}
      {summary.postponedLaterCount > 0 && (
        <span>
          Postponed to later cycles <span className="font-semibold text-foreground">{money(summary.postponedLater)}</span>
        </span>
      )}
      <span className="text-foreground/55">· already included in pending, not added again</span>
    </p>
  );
}
