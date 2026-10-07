/**
 * Follow-up reminder on one open People obligation — "AMMA will pay the ₹1,400 next cycle". Stored in
 * `users/{uid}/people/{personId}/followUps/{id}`, a web-only subcollection like `purposeFunds` and
 * `advanceApplications`: never a ledger entry, never on the Person doc (shared with Flutter) and never on
 * a financial record. It moves no money and changes no balance — workflow metadata only.
 *
 * One reminder per obligation: the doc id is derived from the obligation's statement row key
 * (`ledger:{id}`, `emi-inst:{id}`, `opening:{personId}` …), so setting it again replaces the date.
 *
 * Whether it is still actionable is DERIVED, never stored by a payment:
 *  - "dismissed" is the only stored end state (the user marked it handled);
 *  - an obligation with nothing left open makes the reminder "resolved";
 *  - reverting a payment reopens the obligation, and a reminder that was never dismissed becomes
 *    actionable again on its original date — nothing to repair, nothing that can drift.
 */

import type { DocumentData, QueryDocumentSnapshot, SnapshotOptions } from "firebase/firestore";
import { Timestamp } from "firebase/firestore";
import { cycleContaining, shiftCycle } from "@/lib/engines/person-cycle-statement";

/** "date": a specific day (incl. "tomorrow"); "nextCycle": the start of the following Month Cycle. */
export type FollowUpKind = "date" | "nextCycle";
export type FollowUpStoredState = "active" | "dismissed";

export interface PersonFollowUp {
  id: string;
  personId: string;
  /** The obligation's statement row key. */
  obligationKey: string;
  /** Display snapshot only — the ledger row stays authoritative. */
  obligationTitle: string;
  kind: FollowUpKind;
  /** Local midnight of the day it needs attention. */
  remindOn: Date;
  state: FollowUpStoredState;
  createdAt: Date;
  updatedAt: Date;
  dismissedAt: Date | null;
}

/** UPCOMING (future) / DUE TODAY / OVERDUE (past, still open) / RESOLVED (settled or dismissed). */
export type FollowUpStatus = "upcoming" | "dueToday" | "overdue" | "resolved";

/** Firestore doc ids can't contain "/" — keys are encoded so every obligation key maps to one id. */
export function followUpDocId(obligationKey: string): string {
  return encodeURIComponent(obligationKey);
}

const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/**
 * The reminder's state today. `stillOpen` is the obligation's live remaining (> 0) from the statement
 * engine — false once it is fully settled, true again if that payment is reverted.
 */
export function followUpStatus(f: Pick<PersonFollowUp, "remindOn" | "state">, stillOpen: boolean, today: Date = new Date()): FollowUpStatus {
  if (f.state === "dismissed" || !stillOpen) return "resolved";
  const due = dayStart(f.remindOn).getTime();
  const now = dayStart(today).getTime();
  return due > now ? "upcoming" : due === now ? "dueToday" : "overdue";
}

/** Only reminders that reached their date while the obligation is still open need attention (the badge). */
export function isActionable(status: FollowUpStatus): boolean {
  return status === "dueToday" || status === "overdue";
}

/** "Next cycle" = the first day of the cycle after today's, per Settings → Month Cycle (never a calendar month). */
export function nextCycleStart(today: Date, cycleStartDay: number): Date {
  return shiftCycle(cycleContaining(today, cycleStartDay), 1, cycleStartDay).start;
}

export function tomorrow(today: Date): Date {
  return new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
}

const toDate = (v: unknown): Date | null => (v instanceof Timestamp ? v.toDate() : v instanceof Date ? v : null);

export function personFollowUpFromFirestore(snapshot: QueryDocumentSnapshot<DocumentData>, _options?: SnapshotOptions): PersonFollowUp {
  const data = snapshot.data();
  return {
    id: snapshot.id,
    personId: (data.personId as string) ?? "",
    obligationKey: (data.obligationKey as string) ?? decodeURIComponent(snapshot.id),
    obligationTitle: (data.obligationTitle as string | undefined) ?? "",
    kind: data.kind === "nextCycle" ? "nextCycle" : "date",
    remindOn: toDate(data.remindOn) ?? new Date(0),
    state: data.state === "dismissed" ? "dismissed" : "active",
    createdAt: toDate(data.createdAt) ?? new Date(0),
    updatedAt: toDate(data.updatedAt) ?? new Date(0),
    dismissedAt: toDate(data.dismissedAt),
  };
}

export function personFollowUpToFirestore(f: PersonFollowUp): DocumentData {
  return {
    personId: f.personId,
    obligationKey: f.obligationKey,
    obligationTitle: f.obligationTitle,
    kind: f.kind,
    remindOn: Timestamp.fromDate(f.remindOn),
    state: f.state,
    createdAt: Timestamp.fromDate(f.createdAt),
    updatedAt: Timestamp.fromDate(f.updatedAt),
    dismissedAt: f.dismissedAt ? Timestamp.fromDate(f.dismissedAt) : null,
  };
}
