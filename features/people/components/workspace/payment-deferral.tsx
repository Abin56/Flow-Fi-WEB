"use client";

/**
 * "Postpone payment" on one open People obligation — moves only WHEN collection is expected (see
 * `lib/models/person-payment-deferral.ts`). The original transaction, its amount and date, and every total
 * stay exactly as they are; what is shown as expected is always the row's live remaining.
 *
 * Mirrors `follow-up.tsx`: rows read their deferral from `DeferralContext`, keyed by statement row key, so
 * the row model and the totals never carry it.
 */

import { CalendarClock, CheckCircle2, ChevronDown, Undo2 } from "lucide-react";
import { createContext, useContext, useMemo, useRef, useState } from "react";
import { PanelSection } from "@/components/finance/context-panel";
import { DateInput } from "@/components/forms/date-input";
import { money } from "@/lib/engines/person-cycle-statement-share";
import { cycleContaining, formatCycleLabel, formatStatementDate, type StatementCycle } from "@/lib/engines/person-cycle-statement";
import {
  cycleName,
  cycleStartReminderKind,
  cycleTitle,
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
import { PostponeEmiPanel } from "./postpone-emi-panel";
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
  /**
   * Opens the one Record payment sheet on this obligation ("Received", with its Full / Part choice) — so a postponed
   * collection is settled from its own row, never by hunting through pages. Absent where no payment can be recorded.
   */
  onOpenPayment?: (obligationKey: string) => void;
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
export function useRowDeferral(rowKey: string, rowDate: Date): { status: Exclude<DeferralView["status"], "resolved">; name: string; from: string; range: string; date: Date | null } | null {
  const ctx = useContext(DeferralContext);
  const view = ctx?.byKey.get(rowKey);
  if (!ctx || !view || view.status === "resolved") return null;
  return { status: view.status, name: cycleName(view.cycle), from: cycleName(cycleContaining(rowDate, ctx.cycleStartDay)), range: rangeLabel(view.cycle), date: view.date };
}

/**
 * "Moved to Nov cycle" — a secondary line under the row. `hidePostponed`: the row's status already says it.
 * Never changes the row's amounts.
 */
export function DeferralNote({ rowKey, rowDate, className, hidePostponed = false }: { rowKey: string; rowDate: Date; className?: string; hidePostponed?: boolean }) {
  const view = useRowDeferral(rowKey, rowDate);
  if (!view || (hidePostponed && view.status === "postponed")) return null;
  const { name, from } = view;
  // An exact day reads as a date ("Postponed until 25 Nov 2026 · was due 15 Nov 2026"); a cycle-only one keeps its cycle wording.
  const until = view.date ? formatStatementDate(view.date, true) : null;
  const wasDue = formatStatementDate(rowDate, true);
  const text = until
    ? view.status === "postponed"
      ? `Postponed until ${until} · was due ${wasDue}`
      : view.status === "expectedNow"
        ? `Due today · postponed from ${wasDue}`
        : `Was postponed until ${until} · still not paid`
    : view.status === "postponed"
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

const BTN =
  "inline-flex h-7 items-center gap-1 rounded-[6px] border border-border-strong bg-card px-2 text-[12px] font-semibold text-foreground outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

/** The expanded row's quiet variant: text-weight actions in one line, so Postpone never competes with Record payment. */
const QUIET_BTN =
  "inline-flex h-6 items-center gap-1 rounded-[5px] px-1.5 text-[12px] font-semibold text-foreground/75 outline-none transition-colors hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

type ReminderMode = "none" | "cycleStart" | "date";

/**
 * In a row's expansion: Postpone / Change cycle / Undo. Renders nothing for rows that can't be postponed.
 * `compact` (the expanded ledger row) only restyles the same buttons; `hideReceived` drops the "Received" shortcut when the
 * row's own Record payment button — the very same `openPayment` flow — is already shown right above it.
 */
export function DeferralControl({ row, title, compact = false, hideReceived = false }: { row: LedgerRow; title: string; compact?: boolean; hideReceived?: boolean }) {
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

  const btn = compact ? QUIET_BTN : BTN;
  return (
    <div className={cn("min-w-0", editing && eligible && "basis-full")} onClick={(e) => e.stopPropagation()}>
      {editing && eligible ? (
        <>
        <p className="mb-1 text-[10.5px] font-bold tracking-[0.08em] text-foreground/65 uppercase">Payment timing</p>
        <PostponePanel row={row} title={title} onDone={() => setEditing(false)} />
        </>
      ) : (
        <div className={cn("flex flex-wrap items-center", compact ? "gap-x-2 gap-y-1" : "gap-1.5")}>
          <span className="mr-0.5 text-[10.5px] font-bold tracking-[0.08em] text-foreground/65 uppercase">{compact ? "Timing" : "Payment timing"}</span>
          {live ? (
            <>
              <DeferralNote rowKey={row.key} rowDate={row.date} className="mr-1" />
              {live.deferral.expected?.reason && (
                <span className="mr-1 text-[11.5px] text-foreground/65">
                  · {live.deferral.expected.reason === "other" && live.deferral.expected.note ? live.deferral.expected.note : DEFERRAL_REASON_LABEL[live.deferral.expected.reason]}
                </span>
              )}
              {ctx.onOpenPayment && eligible && !hideReceived && (
                <button
                  type="button"
                  className={cn(btn, !compact && "border-primary-accent-text/60 bg-primary/10")}
                  disabled={busy}
                  onClick={() => ctx.onOpenPayment?.(row.key)}
                  title="Record the money they paid — all of it, or part (the rest stays owed)."
                >
                  <CheckCircle2 className="size-3.5" aria-hidden />
                  Received
                </button>
              )}
              {eligible && (
                <button type="button" className={btn} disabled={busy} onClick={() => setEditing(true)} title="Move when it's expected again — nothing new is created.">
                  {compact && <CalendarClock className="size-3.5" aria-hidden />}
                  {live.date ? "Postpone again · change date" : "Postpone again"}
                </button>
              )}
              <button type="button" className={btn} disabled={busy} onClick={undo} title={live.undoTo ? "Restore the previous expected cycle" : "Remove the postponement — the payment is expected on its own date again. Nothing else changes."}>
                <Undo2 className="size-3.5" aria-hidden />
                {live.undoTo ? `Back to ${cycleName(live.undoTo)} cycle` : "Cancel postponement"}
              </button>
            </>
          ) : (
            <>
              <button type="button" className={btn} disabled={busy} onClick={() => setEditing(true)} title="Can't be paid this cycle? Move when it's expected — the amount and totals don't change.">

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
  // A person's share of a Loan / EMI installment is two decisions (their date, then the bank EMI) — see postpone-emi-panel.tsx.
  if (row.category === "emi" && /^(emi|loan)-inst:/.test(row.key)) return <PostponeEmiPanel row={row} title={title} onDone={onDone} />;
  return <PostponeItemPanel row={row} title={title} onDone={onDone} />;
}

function PostponeItemPanel({ row, title, onDone }: { row: LedgerRow; title: string; onDone: () => void }) {
  const items = useMemo(() => [{ row, title }], [row, title]);
  const draft = usePostponeDraft(items);
  const submit = async () => {
    if (await draft.submit()) onDone();
  };
  return (
    <div role="group" aria-label="Postpone payment" className="max-w-2xl rounded-[8px] border border-border-strong bg-card px-3 py-2.5">
      <p className="mb-2 text-[13px] text-foreground" data-testid="postpone-heading">
        <span className="font-semibold">{draft.personName}</span> · <span className="font-bold tabular-nums">{money(draft.remaining)}</span> pending
      </p>
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
          {draft.busy ? "Postponing…" : "Confirm postpone"}
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
  // The exact day the person is given until. Empty = use the chosen cycle (the original behaviour). A day wins over the chips.
  const [untilText, setUntilText] = useState(() => (single?.date ? toInputDate(single.date) : ""));
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

  // An exact day must be after today and after every item's own due date — the lender's date is never moved by it.
  const dayAfter = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
  const minUntil = useMemo(() => {
    const t = dayAfter(today);
    const o = latestDay > 0 ? dayAfter(new Date(latestDay)) : t;
    return o.getTime() > t.getTime() ? o : t;
  }, [today, latestDay]);
  const untilDate = fromInputDate(untilText);
  const untilError =
    untilText === "" ? null : untilDate == null ? "Enter a valid date." : untilDate.getTime() < minUntil.getTime() ? `Choose a date from ${formatStatementDate(minUntil)} — after today and after the original due date.` : null;
  const exactDate = untilDate != null && untilError == null ? untilDate : null;
  const pickCycle = (i: number) => {
    setTargetIdx(i);
    setUntilText("");
  };
  const target = exactDate ? cycleContaining(exactDate, startDay) : options[Math.min(targetIdx, options.length - 1)];
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
          targetDate: exactDate,
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
  // The very same expectation as the saved one (same cycle or day, reason and no new reminder): confirming would write nothing.
  const unchanged =
    single != null &&
    items.length === 1 &&
    reminderMode === "none" &&
    reason === (single.deferral.expected?.reason ?? null) &&
    (reason !== "other" || (note.trim() || null) === (single.deferral.expected?.note ?? null)) &&
    (exactDate
      ? single.date != null && single.date.getTime() === exactDate.getTime()
      : single.date == null && single.cycle.start.getTime() === target.start.getTime());

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
    ready: !busy && !reminderMissing && untilError == null && !(untilText !== "" && untilDate == null) && pending.length > 0 && !unchanged,
    unchanged,
    submit,
    /** The exact-date control: text ("yyyy-mm-dd" or empty), its parsed day, its error, and the earliest allowed day. */
    untilText,
    setUntilText,
    exactDate,
    untilError,
    minUntil,
    /** Picks a cycle chip and clears any exact day (the chips and the day are alternatives). */
    pickCycle,
    /** The original due date of a single item (null for several) — shown next to the new date. */
    originalDue: items.length === 1 ? items[0].row.date : null,
  };
}

/** "18 Nov" (this year) / "18 Nov 2027" — the year only when it isn't `today`'s, so ordinary dates stay short. */
const shortDate = (d: Date, today: Date) => formatStatementDate(d, d.getFullYear() !== today.getFullYear());

/**
 * The one line that says what will happen — "Selected: Dec 2026 · Expected from 18 Nov". The date is read from the
 * chosen cycle's configured first day (Settings → Month cycle), never typed. An exact custom day replaces it.
 * Display only: the lender's EMI date and every total are untouched by either.
 */
function SelectedLine({ draft }: { draft: PostponeDraft }) {
  const { exactDate, target, today } = draft;
  return (
    <p className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[13px] text-foreground" data-testid="postpone-preview" aria-live="polite">
      {exactDate ? (
        <>
          <span>
            <span className="text-foreground/60">Selected </span>
            <span className="font-bold">Custom date</span>
          </span>
          <span key={exactDate.getTime()} className="duration-200 animate-in fade-in">
            <span className="text-foreground/60">Expected on </span>
            <span className="font-bold tabular-nums">{shortDate(exactDate, today)}</span>
            <span className="text-foreground/60"> · {cycleTitle(target)} cycle</span>
          </span>
        </>
      ) : (
        <>
          <span>
            <span className="text-foreground/60">Selected </span>
            <span className="font-bold">{cycleTitle(target)}</span>
          </span>
          <span key={target.start.getTime()} className="duration-200 animate-in fade-in">
            <span className="text-foreground/60">Expected from </span>
            <span className="font-bold tabular-nums" title={rangeLabel(target)}>
              {shortDate(target.start, today)}
            </span>
          </span>
        </>
      )}
    </p>
  );
}

/** An exact day — a secondary option. Closed by default; the cycle above is the normal way and needs no date. */
function CustomDate({ draft }: { draft: PostponeDraft }) {
  const { untilText, setUntilText, untilError, minUntil, exactDate } = draft;
  const [open, setOpen] = useState(untilText !== "");
  const shown = open || untilText !== "";
  return (
    <div data-testid="postpone-until">
      <button
        type="button"
        aria-expanded={shown}
        onClick={() => {
          if (shown) {
            setUntilText("");
            setOpen(false);
          } else setOpen(true);
        }}
        className="inline-flex h-7 items-center gap-1 rounded-[6px] px-1 text-xs font-semibold text-primary-accent-text outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
      >
        <CalendarClock className="size-3.5" aria-hidden />
        {shown ? "Use the cycle date instead" : "Custom date"}
      </button>
      {shown && (
        <div className="mt-1 duration-200 animate-in fade-in slide-in-from-top-1">
          <DateInput aria-label="Postpone until date" min={toInputDate(minUntil)} className={cn(WS_FIELD, "h-8")} wrapperClassName="w-44" value={untilText} onChange={(e) => setUntilText(e.target.value)} />
          {untilError ? (
            <p role="alert" className="mt-1 text-[11.5px] font-medium text-expense">
              {untilError}
            </p>
          ) : (
            !exactDate && <p className="mt-1 text-[11.5px] text-foreground/60">From {formatStatementDate(minUntil, true)}.</p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The postpone choices, kept to the minimum: pick a cycle (its start date is shown on the card and derived from the
 * Month Cycle setting), read one "Selected / Expected from" line, and — only if wanted — a custom date, a reason or a
 * reminder. Same draft, same write for the Record-payment sheet and a row's own panel.
 */
export function PostponeFields({ draft }: { draft: PostponeDraft; noMoneyNote?: boolean; compact?: boolean }) {
  const { options, targetIdx, target, today, anyView, reason, setReason, note, setNote, reminderMode, setReminderMode, dateText, setDateText, single } = draft;
  const chipCount = 3;
  const [extrasOpen, setExtrasOpen] = useState(false);
  // A chosen date that is still empty is what keeps Postpone disabled — never hide it in a closed section.
  const dateMissing = reminderMode === "date" && fromInputDate(dateText) == null;
  const extrasSummary =
    [reason ? DEFERRAL_REASON_LABEL[reason] : null, reminderMode === "cycleStart" ? `Remind ${formatStatementDate(target.start)}` : reminderMode === "date" && !dateMissing ? `Remind ${formatStatementDate(fromInputDate(dateText)!)}` : null]
      .filter(Boolean)
      .join(" · ") || "Optional";
  const currentStart = single?.date == null ? (single?.cycle.start.getTime() ?? null) : null;
  const card = (on: boolean) =>
    cn(
      "flex min-w-[6.25rem] shrink-0 snap-start flex-col items-start rounded-[12px] border px-3 py-2 text-left outline-none transition-[border-color,background-color,box-shadow,transform] duration-200 focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.98] @md:min-w-0",
      on ? "border-primary-accent-text bg-primary/12 shadow-[0_4px_14px_-8px_rgb(0_0_0/0.3)]" : "border-border-strong bg-card hover:border-muted-foreground hover:bg-secondary/50",
    );
  const smallChip = (on: boolean) =>
    cn(
      "inline-flex h-8 shrink-0 items-center rounded-full border px-3 text-xs font-semibold outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring",
      on ? "border-primary-accent-text bg-primary/15 text-foreground" : "border-border-strong bg-card text-foreground/80 hover:bg-secondary",
    );
  return (
    <div className="@container space-y-2.5" data-testid="postpone-fields">
      <div>
        <p className="mb-1.5 text-xs font-bold text-foreground/85">Choose a cycle</p>
        <div role="radiogroup" aria-label="Expected cycle" className="-mx-1 flex snap-x gap-1.5 overflow-x-auto px-1 pb-1 [scrollbar-width:none] @md:grid @md:grid-cols-4 @md:overflow-visible">
          {options.slice(0, chipCount).map((c, i) => {
            const on = targetIdx === i && !draft.exactDate;
            const isCurrent = currentStart === c.start.getTime();
            return (
              <button key={c.start.getTime()} type="button" role="radio" aria-checked={on} aria-label={`${cycleName(c, today)} cycle`} title={rangeLabel(c)} className={card(on)} onClick={() => draft.pickCycle(i)}>
                <span className="flex w-full items-center justify-between gap-2">
                  <span className="font-heading text-[15px] leading-tight font-bold text-foreground">{cycleName(c, today)}</span>
                  {on && <CheckCircle2 className="size-4 shrink-0 text-primary-accent-text duration-200 animate-in zoom-in-50" aria-hidden />}
                </span>
                <span className="mt-0.5 text-[11px] font-medium text-foreground/65">{isCurrent ? "Current" : `From ${shortDate(c.start, today)}`}</span>
              </button>
            );
          })}
          <label className={cn(card(targetIdx >= chipCount && !draft.exactDate), "relative cursor-pointer")}>
            <span className="font-heading text-[15px] leading-tight font-bold text-foreground">{targetIdx >= chipCount && !draft.exactDate ? cycleName(target, today) : "Later"}</span>
            <span className="mt-0.5 flex items-center gap-0.5 text-[11px] font-medium text-foreground/65">
              {targetIdx >= chipCount && !draft.exactDate ? `From ${shortDate(target.start, today)}` : "Pick a cycle"}
              <ChevronDown className="size-3" aria-hidden />
            </span>
            <select
              aria-label="Later cycle"
              className="absolute inset-0 cursor-pointer opacity-0"
              value={targetIdx >= chipCount && !draft.exactDate ? String(targetIdx) : ""}
              onChange={(e) => e.target.value !== "" && draft.pickCycle(Number(e.target.value))}
            >
              <option value="">Later…</option>
              {options.slice(chipCount).map((c, i) => (
                <option key={c.start.getTime()} value={String(i + chipCount)}>
                  {cycleName(c, today)} cycle · {rangeLabel(c)}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <SelectedLine draft={draft} />
      {draft.unchanged && draft.doneKeys.size === 0 && (
        <p className="text-[11.5px] font-medium text-foreground/65" data-testid="postpone-unchanged">
          Already set to this — pick another {anyView ? "cycle or date" : "cycle"} to change it.
        </p>
      )}
      <CustomDate draft={draft} />

      <PanelSection title="Reason & reminder" summary={extrasSummary} open={extrasOpen || dateMissing} onOpenChange={setExtrasOpen}>
        <div className="space-y-3">
          <div>
            <p className="mb-1.5 text-xs font-bold text-foreground/85">
              Reason <span className="font-normal text-foreground/60">(optional)</span>
            </p>
            <div role="radiogroup" aria-label="Reason" className="flex flex-wrap gap-1.5">
              {DEFERRAL_REASONS.map((r) => (
                <button key={r} type="button" role="radio" aria-checked={reason === r} className={smallChip(reason === r)} onClick={() => setReason(reason === r ? null : r)}>
                  {DEFERRAL_REASON_LABEL[r]}
                </button>
              ))}
            </div>
            {reason === "other" && (
              <input aria-label="Reason note" className={cn(WS_FIELD, "mt-1.5 h-8 duration-200 animate-in fade-in")} maxLength={DEFERRAL_NOTE_MAX} placeholder="Add a short note" value={note} onChange={(e) => setNote(e.target.value)} />
            )}
          </div>
          <div>
            <p className="mb-1.5 text-xs font-bold text-foreground/85">
              Reminder <span className="font-normal text-foreground/60">(optional)</span>
            </p>
            <div role="radiogroup" aria-label="Reminder" className="flex flex-wrap gap-1.5">
              <button type="button" role="radio" aria-checked={reminderMode === "none"} className={smallChip(reminderMode === "none")} onClick={() => setReminderMode("none")}>
                No new reminder
              </button>
              <button type="button" role="radio" aria-checked={reminderMode === "cycleStart"} className={smallChip(reminderMode === "cycleStart")} onClick={() => setReminderMode("cycleStart")}>
                When it starts · {formatStatementDate(target.start)}
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={reminderMode === "date"}
                className={smallChip(reminderMode === "date")}
                onClick={() => {
                  setReminderMode("date");
                  if (!dateText) setDateText(toInputDate(target.start));
                }}
              >
                Choose date
              </button>
            </div>
            {reminderMode === "date" && (
              <DateInput aria-label="Reminder date" className={cn(WS_FIELD, "h-8")} wrapperClassName="mt-1.5 w-44 duration-200 animate-in fade-in" value={dateText} onChange={(e) => setDateText(e.target.value)} />
            )}
            {draft.movingReminder && (
              <p className="mt-1.5 text-[11.5px] text-foreground/65">
                Your reminder on {formatStatementDate(draft.movingReminder)} moves to {formatStatementDate(target.start)} so it won&apos;t show as overdue.
              </p>
            )}
          </div>
        </div>
      </PanelSection>
      <span className="sr-only">already included in pending, not added again</span>
    </div>
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
    <>
      {summary.expectedHereCount > 0 && (
        <span
          aria-label="Postponed payments"
          title="Expected this cycle after postponement — already included in pending, not added again"
          className={cn("inline-flex items-center gap-1 rounded-full bg-warning/12 px-2 py-0.5 text-[11.5px] font-medium text-foreground tabular-nums ring-1 ring-warning/30", className)}
        >
          <CalendarClock className="size-3 text-warning" aria-hidden />
          Expected this cycle after postponement <span className="font-bold">{money(summary.expectedHere)}</span>
        </span>
      )}
      {summary.postponedLaterCount > 0 && (
        <span
          aria-label={summary.expectedHereCount > 0 ? undefined : "Postponed payments"}
          title="Postponed to later cycles — already included in pending, not added again"
          className={cn("inline-flex items-center gap-1 rounded-full bg-warning/12 px-2 py-0.5 text-[11.5px] font-medium text-foreground tabular-nums ring-1 ring-warning/30", className)}
        >
          <CalendarClock className="size-3 text-warning" aria-hidden />
          Postponed to later cycles <span className="font-bold">{money(summary.postponedLater)}</span>
        </span>
      )}
    <span className="sr-only">already included in pending, not added again</span>
    </>
  );
}
