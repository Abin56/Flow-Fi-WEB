/**
 * Payment deferral on one open People obligation — "SHAMBU will pay the ₹2,000 in the November cycle".
 * Stored in `users/{uid}/people/{personId}/paymentDeferrals/{id}`, a web-only subcollection like
 * `followUps`: never a ledger entry, never on the Person doc (shared with Flutter), never on a financial
 * record. It moves no money, changes no balance and stores NO amount — what is still owed is always the
 * obligation's live remaining from the statement engine, so a later payment, revert or split edit can
 * never leave a stale "deferred amount" behind. It only records WHEN payment is expected.
 *
 * Difference from the automatic carry-forward: an unpaid obligation already flows into every later
 * cycle's Previous Pending / "Brought forward" on its own. A deferral is the user's explicit statement of
 * which cycle they now expect to collect it in — the original transaction stays in its own cycle.
 *
 * One deferral per obligation: the doc id is derived from the obligation's statement row key
 * (`ledger:{id}`, `emi-inst:{id}`, `opening:{personId}`), so moving it again updates the same doc instead
 * of stacking records. Undo pops `frames` (the expectation before each move); `history` is a short audit
 * log. `revision` + `lastRequestId` make every write stale-safe and retry-idempotent
 * (`planDeferralWrite`, `PaymentDeferralRepository`).
 */

import type { DocumentData, QueryDocumentSnapshot, SnapshotOptions } from "firebase/firestore";
import { Timestamp } from "firebase/firestore";
import type { FollowUpKind, FollowUpStoredState } from "@/lib/models/person-follow-up";

export type DeferralReason = "moreTime" | "unableNow" | "missed" | "other";

export const DEFERRAL_REASONS: readonly DeferralReason[] = ["moreTime", "unableNow", "missed", "other"];

export const DEFERRAL_REASON_LABEL: Record<DeferralReason, string> = {
  moreTime: "Requested more time",
  unableNow: "Unable to pay now",
  missed: "Missed payment",
  other: "Other",
};

/**
 * The cycle payment is expected in, as resolved when it was chosen. `end` (inclusive last day, local
 * midnight) is the authority: under a different Month Cycle start day the expectation re-resolves to the
 * cycle containing that day — the same rule People uses to re-resolve its selected cycle — so a settings
 * change moves the window, never loses the deferral.
 */
export interface DeferralCycleRef {
  start: Date;
  end: Date;
}

export interface DeferralExpectation {
  cycle: DeferralCycleRef;
  reason: DeferralReason | null;
  note: string | null;
}

/** The follow-up reminder's state as one move found / left it. */
export interface ReminderSnapshot {
  kind: FollowUpKind;
  remindOn: Date;
  state: FollowUpStoredState;
}

/** One move, kept so Undo restores exactly what was there before it. */
export interface DeferralFrame {
  /** The expectation before this move — null: none (the obligation's own timing). */
  previous: DeferralExpectation | null;
  /** Whether this move wrote the follow-up reminder. */
  reminderTouched: boolean;
  /** The reminder before this move (null: there was none). Only meaningful when `reminderTouched`. */
  reminderBefore: ReminderSnapshot | null;
  /** What this move wrote — Undo restores `reminderBefore` only while the reminder still equals this. */
  reminderAfter: ReminderSnapshot | null;
}

export type DeferralAction = "postpone" | "undo";

export interface DeferralHistoryEntry {
  at: Date;
  action: DeferralAction;
  /** Expected cycle's last day before / after — null: no deferral. */
  fromEnd: Date | null;
  toEnd: Date | null;
  reason: DeferralReason | null;
}

export type DeferralState = "active" | "cleared";

export interface PersonPaymentDeferral {
  id: string;
  personId: string;
  /** The obligation's statement row key. */
  obligationKey: string;
  /** Display snapshot only — the ledger row stays authoritative. */
  obligationTitle: string;
  /** "cleared": every move was undone — the doc stays so its revision keeps guarding stale writes. */
  state: DeferralState;
  /** Null when cleared. */
  expected: DeferralExpectation | null;
  /** Settings → Month Cycle start day when it was last written (audit only — never used to resolve). */
  cycleStartDay: number;
  revision: number;
  lastRequestId: string | null;
  frames: DeferralFrame[];
  history: DeferralHistoryEntry[];
  createdAt: Date;
  updatedAt: Date;
}

/** Firestore doc ids can't contain "/" — same encoding as `followUpDocId`. */
export function deferralDocId(obligationKey: string): string {
  return encodeURIComponent(obligationKey);
}

// ---------------------------------------------------------------------------------------------------
// Firestore
// ---------------------------------------------------------------------------------------------------

const toDate = (v: unknown): Date | null => (v instanceof Timestamp ? v.toDate() : v instanceof Date ? v : null);
const ts = (d: Date) => Timestamp.fromDate(d);
const reasonOf = (v: unknown): DeferralReason | null => ((DEFERRAL_REASONS as readonly unknown[]).includes(v) ? (v as DeferralReason) : null);

function cycleFrom(v: unknown): DeferralCycleRef | null {
  const m = v as Record<string, unknown> | null | undefined;
  const start = toDate(m?.start);
  const end = toDate(m?.end);
  return start && end ? { start, end } : null;
}

function expectationFrom(v: unknown): DeferralExpectation | null {
  const m = v as Record<string, unknown> | null | undefined;
  const cycle = cycleFrom(m?.cycle);
  if (!m || !cycle) return null;
  return { cycle, reason: reasonOf(m.reason), note: typeof m.note === "string" && m.note ? m.note : null };
}

function expectationTo(e: DeferralExpectation | null): DocumentData | null {
  return e == null ? null : { cycle: { start: ts(e.cycle.start), end: ts(e.cycle.end) }, reason: e.reason, note: e.note };
}

function reminderFrom(v: unknown): ReminderSnapshot | null {
  const m = v as Record<string, unknown> | null | undefined;
  const remindOn = toDate(m?.remindOn);
  if (!m || !remindOn) return null;
  return { kind: m.kind === "nextCycle" ? "nextCycle" : "date", remindOn, state: m.state === "dismissed" ? "dismissed" : "active" };
}

function reminderTo(r: ReminderSnapshot | null): DocumentData | null {
  return r == null ? null : { kind: r.kind, remindOn: ts(r.remindOn), state: r.state };
}

export function paymentDeferralFromData(id: string, data: DocumentData): PersonPaymentDeferral {
  const frames = ((data.frames as unknown[] | undefined) ?? []).map((f) => {
    const m = f as Record<string, unknown>;
    return {
      previous: expectationFrom(m.previous),
      reminderTouched: m.reminderTouched === true,
      reminderBefore: reminderFrom(m.reminderBefore),
      reminderAfter: reminderFrom(m.reminderAfter),
    };
  });
  const history = ((data.history as unknown[] | undefined) ?? []).map((h) => {
    const m = h as Record<string, unknown>;
    return {
      at: toDate(m.at) ?? new Date(0),
      action: m.action === "undo" ? ("undo" as const) : ("postpone" as const),
      fromEnd: toDate(m.fromEnd),
      toEnd: toDate(m.toEnd),
      reason: reasonOf(m.reason),
    };
  });
  const expected = expectationFrom(data.expected);
  return {
    id,
    personId: (data.personId as string) ?? "",
    obligationKey: (data.obligationKey as string) ?? decodeURIComponent(id),
    obligationTitle: (data.obligationTitle as string | undefined) ?? "",
    // An "active" doc without a readable expectation is treated as cleared — never a deferral to nowhere.
    state: data.state === "active" && expected != null ? "active" : "cleared",
    expected: data.state === "active" ? expected : null,
    cycleStartDay: typeof data.cycleStartDay === "number" ? data.cycleStartDay : 1,
    revision: typeof data.revision === "number" ? data.revision : 0,
    lastRequestId: (data.lastRequestId as string | undefined) ?? null,
    frames,
    history,
    createdAt: toDate(data.createdAt) ?? new Date(0),
    updatedAt: toDate(data.updatedAt) ?? new Date(0),
  };
}

export function paymentDeferralFromFirestore(snapshot: QueryDocumentSnapshot<DocumentData>, _options?: SnapshotOptions): PersonPaymentDeferral {
  return paymentDeferralFromData(snapshot.id, snapshot.data());
}

export function paymentDeferralToFirestore(d: PersonPaymentDeferral): DocumentData {
  return {
    personId: d.personId,
    obligationKey: d.obligationKey,
    obligationTitle: d.obligationTitle,
    state: d.state,
    expected: expectationTo(d.expected),
    cycleStartDay: d.cycleStartDay,
    revision: d.revision,
    lastRequestId: d.lastRequestId,
    frames: d.frames.map((f) => ({
      previous: expectationTo(f.previous),
      reminderTouched: f.reminderTouched,
      reminderBefore: reminderTo(f.reminderBefore),
      reminderAfter: reminderTo(f.reminderAfter),
    })),
    history: d.history.map((h) => ({ at: ts(h.at), action: h.action, fromEnd: h.fromEnd ? ts(h.fromEnd) : null, toEnd: h.toEnd ? ts(h.toEnd) : null, reason: h.reason })),
    createdAt: ts(d.createdAt),
    updatedAt: ts(d.updatedAt),
  };
}
