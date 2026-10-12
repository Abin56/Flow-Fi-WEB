/**
 * Payment deferral — pure rules (no React, no Firebase I/O) behind "Postpone payment" on one open People
 * obligation. See `lib/models/person-payment-deferral.ts` for what is stored and why.
 *
 * Accounting integrity: nothing here reads or produces an amount that feeds a total. The statement engine
 * (`buildPersonCycleStatement`), Net Worth, My Spend and every balance never see a deferral, so they are
 * unchanged by construction. The amount shown as "expected" is always the obligation's live remaining.
 *
 * Cycles: canonical Month Cycle boundaries via `cycleContaining`/`shiftCycle` (`month-cycle-range.ts`'s
 * `cycleRangeFor`) — custom start days, short months and the December → January rollover included.
 */

import { cycleContaining, shiftCycle, type StatementCategory, type StatementCycle } from "@/lib/engines/person-cycle-statement";
import type { PersonFollowUp } from "@/lib/models/person-follow-up";
import type {
  DeferralExpectation,
  DeferralFrame,
  DeferralHistoryEntry,
  DeferralReason,
  PersonPaymentDeferral,
  ReminderSnapshot,
} from "@/lib/models/person-payment-deferral";
import type { FollowUpKind } from "@/lib/models/person-follow-up";

const EPSILON = 0.005;
const MAX_FRAMES = 20;
const MAX_HISTORY = 30;
export const DEFERRAL_NOTE_MAX = 140;

const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const dayIdx = (d: Date) => dayStart(d).getTime();

// ---------------------------------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------------------------------

/**
 * Receivables the People Ledger settles itself: a split / assigned share, money given, a person-linked
 * EMI share (only the PERSON's reimbursement timing — the lender installment is a different record and is
 * never touched) and an opening balance they owe. Person-Loan installments are excluded: they carry a
 * contractual due date on the Loan's own schedule, which a collection deferral must not appear to move.
 */
const POSTPONABLE: ReadonlySet<StatementCategory | "loan"> = new Set(["split", "gave", "emi", "opening"]);

export function isPostponableObligation(row: {
  kind: "obligation" | "settlement" | null | undefined;
  category: StatementCategory | "loan";
  signedAmount: number;
  remaining: number | null | undefined;
}): boolean {
  return row.kind === "obligation" && POSTPONABLE.has(row.category) && row.signedAmount > 0 && (row.remaining ?? 0) > EPSILON;
}

// ---------------------------------------------------------------------------------------------------
// Cycles
// ---------------------------------------------------------------------------------------------------

/** "Nov" / "Jan 2027" — the month a cycle ends in (the name the Month Cycle header uses), year when not `today`'s. */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function cycleName(cycle: StatementCycle, today: Date = new Date()): string {
  const m = MONTHS[cycle.end.getMonth()];
  return cycle.end.getFullYear() === today.getFullYear() ? m : `${m} ${cycle.end.getFullYear()}`;
}

/** Where a stored expectation lands under today's start day — the cycle containing its last day. */
export function resolveExpectedCycle(expected: Pick<DeferralExpectation, "cycle"> | null, startDay: number): StatementCycle | null {
  return expected == null ? null : cycleContaining(expected.cycle.end, startDay);
}

/**
 * The first cycle payment can be moved to: after today's cycle AND after the obligation's own cycle (an
 * EMI share can be dated in a future cycle). Never a past or current cycle — that is not a postponement.
 */
export function earliestTargetCycle(obligationDate: Date, today: Date, startDay: number): StatementCycle {
  const now = cycleContaining(today, startDay);
  const own = cycleContaining(obligationDate, startDay);
  const base = own.start.getTime() > now.start.getTime() ? own : now;
  return shiftCycle(base, 1, startDay);
}

/** `count` consecutive choosable cycles, earliest first. */
export function targetCycleOptions(obligationDate: Date, today: Date, startDay: number, count = 12): StatementCycle[] {
  const first = earliestTargetCycle(obligationDate, today, startDay);
  return Array.from({ length: count }, (_, i) => shiftCycle(first, i, startDay));
}

/** Preselected choice: the cycle after the current expectation (or the earliest allowed when that is later). */
export function defaultTargetCycle(obligationDate: Date, today: Date, startDay: number, currentExpected: StatementCycle | null): StatementCycle {
  const first = earliestTargetCycle(obligationDate, today, startDay);
  if (currentExpected == null) return first;
  const after = shiftCycle(currentExpected, 1, startDay);
  return after.start.getTime() > first.start.getTime() ? after : first;
}

// ---------------------------------------------------------------------------------------------------
// Live status
// ---------------------------------------------------------------------------------------------------

/**
 * POSTPONED (expected in a later cycle) / EXPECTED NOW (today's cycle is the expected one) / LAPSED (the
 * expected cycle passed and it is still open) / RESOLVED (nothing left to collect — paid, or the
 * obligation no longer exists). Derived on every render from the live remaining, never stored by a
 * payment: reverting a payment reopens it, exactly like follow-up reminders.
 */
export type DeferralStatus = "postponed" | "expectedNow" | "lapsed" | "resolved";

export interface DeferralView {
  deferral: PersonPaymentDeferral;
  /** Expected cycle under today's start day. */
  cycle: StatementCycle;
  status: DeferralStatus;
  /** Live remaining on the obligation (what is expected). */
  remaining: number;
  /** What Undo returns to — null: the obligation's own timing. */
  undoTo: StatementCycle | null;
}

export function deferralView(
  deferral: PersonPaymentDeferral,
  remaining: number | null | undefined,
  startDay: number,
  today: Date = new Date(),
): DeferralView | null {
  if (deferral.state !== "active" || deferral.expected == null) return null;
  const cycle = resolveExpectedCycle(deferral.expected, startDay)!;
  const left = remaining ?? 0;
  const now = cycleContaining(today, startDay);
  const status: DeferralStatus =
    left <= EPSILON ? "resolved" : cycle.start.getTime() > now.start.getTime() ? "postponed" : cycle.start.getTime() === now.start.getTime() ? "expectedNow" : "lapsed";
  const top = deferral.frames[deferral.frames.length - 1];
  return { deferral, cycle, status, remaining: Math.max(0, left), undoTo: top?.previous ? resolveExpectedCycle(top.previous, startDay) : null };
}

/**
 * Selected-cycle split of what is still open (live remaining, each obligation once): expected in a LATER
 * cycle vs. expected IN this cycle because it was postponed here. Display only — never added to a total.
 */
export function deferralCycleSummary(views: Iterable<DeferralView>, selected: StatementCycle): { postponedLater: number; postponedLaterCount: number; expectedHere: number; expectedHereCount: number } {
  let postponedLater = 0;
  let postponedLaterCount = 0;
  let expectedHere = 0;
  let expectedHereCount = 0;
  for (const v of views) {
    if (v.status === "resolved") continue;
    if (v.cycle.start.getTime() > selected.start.getTime()) {
      postponedLater += v.remaining;
      postponedLaterCount += 1;
    } else if (v.cycle.start.getTime() === selected.start.getTime()) {
      expectedHere += v.remaining;
      expectedHereCount += 1;
    }
  }
  const r = (n: number) => Math.round(n * 100) / 100;
  return { postponedLater: r(postponedLater), postponedLaterCount, expectedHere: r(expectedHere), expectedHereCount };
}

// ---------------------------------------------------------------------------------------------------
// Write planning — every rule a write must pass, decided from freshly read state
// ---------------------------------------------------------------------------------------------------

interface DeferralRequestBase {
  /** Unique per user intent — a retry of the same intent reuses it, making the write idempotent. */
  requestId: string;
  /** The deferral revision the UI was showing (0 when it showed none) — a mismatch is a stale write. */
  expectedRevision: number;
  personId: string;
  obligationKey: string;
  obligationTitle: string;
  now: Date;
  startDay: number;
}

export interface PostponeRequest extends DeferralRequestBase {
  action: "postpone";
  /** The obligation's own date (re-read from its source inside the transaction where possible). */
  obligationDate: Date;
  /** Live remaining when the user confirmed — a fully paid obligation cannot be postponed. */
  remaining: number;
  target: StatementCycle;
  reason: DeferralReason | null;
  note: string | null;
  /** An explicit reminder to set; null leaves reminders alone (except re-dating one that would read overdue). */
  reminder: { kind: FollowUpKind; remindOn: Date } | null;
}

export interface UndoRequest extends DeferralRequestBase {
  action: "undo";
}

export type DeferralRequest = PostponeRequest | UndoRequest;

export type FollowUpWrite = { op: "set"; value: PersonFollowUp } | { op: "delete" };

export type DeferralPlan =
  | { kind: "write"; deferral: PersonPaymentDeferral; followUp: FollowUpWrite | null }
  /** Nothing to write: this exact request already committed, or it would change nothing. */
  | { kind: "noop"; why: "alreadyApplied" | "unchanged"; deferral: PersonPaymentDeferral | null }
  /** Someone changed it since the UI read it — refresh, never overwrite. */
  | { kind: "conflict"; message: string }
  | { kind: "invalid"; message: string };

export const STALE_MESSAGE = "This payment's timing was just changed elsewhere (another tab or device). Review the latest and try again.";

function snapshotOf(f: PersonFollowUp | null): ReminderSnapshot | null {
  return f == null ? null : { kind: f.kind, remindOn: dayStart(f.remindOn), state: f.state };
}

function sameReminder(a: ReminderSnapshot | null, b: ReminderSnapshot | null): boolean {
  if (a == null || b == null) return a === b;
  return a.kind === b.kind && a.state === b.state && dayIdx(a.remindOn) === dayIdx(b.remindOn);
}

function followUpFrom(req: DeferralRequestBase, snap: ReminderSnapshot, existing: PersonFollowUp | null): PersonFollowUp {
  return {
    id: encodeURIComponent(req.obligationKey),
    personId: req.personId,
    obligationKey: req.obligationKey,
    obligationTitle: existing?.obligationTitle || req.obligationTitle,
    kind: snap.kind,
    remindOn: dayStart(snap.remindOn),
    state: snap.state,
    createdAt: existing?.createdAt ?? req.now,
    updatedAt: req.now,
    dismissedAt: snap.state === "dismissed" ? (existing?.dismissedAt ?? req.now) : null,
  };
}

/**
 * A reminder on a cycle's first day: the existing "next cycle" form only when that cycle IS the next one
 * (follow-ups label that form "next cycle"); a plain dated reminder for any later cycle.
 */
export function cycleStartReminderKind(target: StatementCycle, today: Date, startDay: number): FollowUpKind {
  return shiftCycle(cycleContaining(today, startDay), 1, startDay).start.getTime() === target.start.getTime() ? "nextCycle" : "date";
}

const cap = <T>(list: T[], max: number) => (list.length > max ? list.slice(list.length - max) : list);

export function planDeferralWrite(current: PersonPaymentDeferral | null, followUp: PersonFollowUp | null, req: DeferralRequest): DeferralPlan {
  // Idempotent retry: this exact request already committed (e.g. the response was lost).
  if (current != null && current.lastRequestId === req.requestId) return { kind: "noop", why: "alreadyApplied", deferral: current };
  if ((current?.revision ?? 0) !== req.expectedRevision) return { kind: "conflict", message: STALE_MESSAGE };

  const active = current?.state === "active" && current.expected != null ? current.expected : null;
  const base = {
    id: encodeURIComponent(req.obligationKey),
    personId: req.personId,
    obligationKey: req.obligationKey,
    obligationTitle: req.obligationTitle || current?.obligationTitle || "",
    cycleStartDay: req.startDay,
    revision: (current?.revision ?? 0) + 1,
    lastRequestId: req.requestId,
    createdAt: current?.createdAt ?? req.now,
    updatedAt: req.now,
  };

  if (req.action === "undo") {
    if (current == null || active == null) return { kind: "invalid", message: "There is no postponement to undo." };
    // Past the capped undo stack there is nothing older to return to — clear the deferral.
    const top: DeferralFrame = current.frames[current.frames.length - 1] ?? { previous: null, reminderTouched: false, reminderBefore: null, reminderAfter: null };
    let followUpWrite: FollowUpWrite | null = null;
    // Restore the reminder only while it is still exactly what this move set — a later edit by the user wins.
    if (top.reminderTouched && sameReminder(snapshotOf(followUp), top.reminderAfter)) {
      followUpWrite = top.reminderBefore == null ? { op: "delete" } : { op: "set", value: followUpFrom(req, top.reminderBefore, followUp) };
    }
    const history: DeferralHistoryEntry = { at: req.now, action: "undo", fromEnd: active.cycle.end, toEnd: top.previous?.cycle.end ?? null, reason: top.previous?.reason ?? null };
    return {
      kind: "write",
      deferral: {
        ...base,
        state: top.previous == null ? "cleared" : "active",
        expected: top.previous,
        frames: current.frames.slice(0, -1),
        history: cap([...current.history, history], MAX_HISTORY),
      },
      followUp: followUpWrite,
    };
  }

  // ---- postpone (first move, move again, or change the expected cycle) ----
  if (!(req.remaining > EPSILON)) return { kind: "invalid", message: "Nothing is left to collect on this — it is already fully paid." };
  const earliest = earliestTargetCycle(req.obligationDate, req.now, req.startDay);
  const target = cycleContaining(req.target.end, req.startDay);
  if (target.start.getTime() < earliest.start.getTime()) return { kind: "invalid", message: "Choose a future cycle after this one." };
  const note = req.reason === "other" && req.note ? req.note.trim().slice(0, DEFERRAL_NOTE_MAX) || null : null;
  const today = dayStart(req.now);
  if (req.reminder != null && dayIdx(req.reminder.remindOn) < today.getTime()) return { kind: "invalid", message: "Choose a reminder date from today onwards." };

  const sameTarget = active != null && cycleContaining(active.cycle.end, req.startDay).start.getTime() === target.start.getTime();
  if (sameTarget && active!.reason === req.reason && active!.note === note && req.reminder == null) return { kind: "noop", why: "unchanged", deferral: current };

  // Reminder: an explicit choice is used as-is. Otherwise an ACTIVE reminder dated before the new cycle
  // would read "overdue" for money no longer expected then — it moves to the new cycle's first day (the
  // existing "next cycle" reminder form). No reminder is invented when there was none.
  const before = snapshotOf(followUp);
  let after: ReminderSnapshot | null = null;
  if (req.reminder != null) after = { kind: req.reminder.kind, remindOn: dayStart(req.reminder.remindOn), state: "active" };
  else if (before != null && before.state === "active" && dayIdx(before.remindOn) < target.start.getTime()) after = { kind: cycleStartReminderKind(target, req.now, req.startDay), remindOn: target.start, state: "active" };
  const touched = after != null && !sameReminder(before, after);

  const expected: DeferralExpectation = { cycle: { start: target.start, end: target.end }, reason: req.reason, note };
  const frame: DeferralFrame = { previous: active, reminderTouched: touched, reminderBefore: touched ? before : null, reminderAfter: touched ? after : null };
  const history: DeferralHistoryEntry = { at: req.now, action: "postpone", fromEnd: active?.cycle.end ?? null, toEnd: target.end, reason: req.reason };
  return {
    kind: "write",
    deferral: {
      ...base,
      state: "active",
      expected,
      frames: cap([...(current?.frames ?? []), frame], MAX_FRAMES),
      history: cap([...(current?.history ?? []), history], MAX_HISTORY),
    },
    followUp: touched ? { op: "set", value: followUpFrom(req, after!, followUp) } : null,
  };
}
