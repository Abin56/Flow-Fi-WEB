"use client";

/**
 * Follow-up reminders on open People obligations (`people/{personId}/followUps`), LIVE, plus actions and
 * the derived attention list. A reminder never moves money: its status is derived from the obligation's
 * live remaining in the statement engine (`followUpStatus`), so settling closes it and reverting that
 * payment reopens it — nothing is written by a payment.
 */

import { deleteDoc, doc, onSnapshot, setDoc, updateDoc, Timestamp } from "firebase/firestore";
import { useMemo } from "react";
import { useFirestoreWatch } from "@/hooks/use-firestore-watch";
import { usePeople } from "@/hooks/use-people";
import { useMonthCycleStartDay } from "@/features/settings/hooks/use-user-preferences";
import { usePeopleCycleStatements } from "@/features/people/hooks/use-person-cycle-statement";
import { cycleContaining, type PersonCycleStatement } from "@/lib/engines/person-cycle-statement";
import { PAYMENT_EPSILON } from "@/lib/engines/person-payment";
import type { Person } from "@/lib/models/person";
import { followUpDocId, followUpStatus, isActionable, type FollowUpKind, type FollowUpStatus, type PersonFollowUp } from "@/lib/models/person-follow-up";
import { createPersonFollowUpsCollection } from "@/lib/repositories/repository-factory";
import { useAuthStore } from "@/store/auth-store";

/** Every person's follow-up reminders, keyed by person. Emits once every person has reported. */
export function useAllPersonFollowUps() {
  const uid = useAuthStore((s) => s.user?.uid);
  const { data: people = [], isLoading: peopleLoading } = usePeople();
  const personIds = useMemo(() => (people as Person[]).map((p) => p.id).sort(), [people]);

  const query = useFirestoreWatch<Record<string, PersonFollowUp[]>>({
    queryKey: ["people-follow-ups", uid, ...personIds] as const,
    enabled: !!uid && personIds.length > 0,
    hookName: "useAllPersonFollowUps",
    emptyValue: {},
    deps: [uid, personIds.join("|")],
    subscribe: (onData, onError) => {
      if (!uid) return () => {};
      const byPerson: Record<string, PersonFollowUp[]> = {};
      const pending = new Set(personIds);
      const unsubscribes = personIds.map((personId) =>
        onSnapshot(
          createPersonFollowUpsCollection(uid, personId),
          (snapshot) => {
            byPerson[personId] = snapshot.docs.map((d) => d.data());
            pending.delete(personId);
            if (pending.size === 0) onData({ ...byPerson });
          },
          onError,
        ),
      );
      return () => unsubscribes.forEach((u) => u());
    },
  });

  return {
    followUpsByPersonId: query.data ?? {},
    isLoading: peopleLoading || (personIds.length > 0 && query.data === undefined),
  };
}

export interface SetFollowUpInput {
  personId: string;
  obligationKey: string;
  obligationTitle: string;
  kind: FollowUpKind;
  remindOn: Date;
}

export function usePersonFollowUpActions() {
  const uid = useAuthStore((s) => s.user?.uid);
  const ref = (personId: string, obligationKey: string) => {
    if (!uid) throw new Error("Not signed in.");
    return doc(createPersonFollowUpsCollection(uid, personId), followUpDocId(obligationKey));
  };
  return {
    /** Adds or re-dates the obligation's one reminder (re-arming a dismissed one). */
    async set(input: SetFollowUpInput) {
      const now = new Date();
      const remindOn = new Date(input.remindOn.getFullYear(), input.remindOn.getMonth(), input.remindOn.getDate());
      await setDoc(ref(input.personId, input.obligationKey), {
        id: followUpDocId(input.obligationKey),
        personId: input.personId,
        obligationKey: input.obligationKey,
        obligationTitle: input.obligationTitle,
        kind: input.kind,
        remindOn,
        state: "active",
        createdAt: now,
        updatedAt: now,
        dismissedAt: null,
      });
    },
    /** Marks it handled — the debt stays exactly as it is. */
    async dismiss(personId: string, obligationKey: string) {
      const now = Timestamp.fromDate(new Date());
      await updateDoc(ref(personId, obligationKey), { state: "dismissed", dismissedAt: now, updatedAt: now });
    },
    /** Removes the reminder only — never the obligation. */
    async remove(personId: string, obligationKey: string) {
      await deleteDoc(ref(personId, obligationKey));
    },
  };
}

/** Live remaining per obligation key, from a whole-history statement (obligation rows only). */
export function openRemainingByKey(statement: Pick<PersonCycleStatement, "rows"> | null | undefined): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of statement?.rows ?? []) if (r.kind === "obligation") out.set(r.key, r.remainingNow ?? 0);
  return out;
}

export interface AttentionItem {
  personId: string;
  personName: string;
  followUp: PersonFollowUp;
  /** Still open on the obligation right now. */
  remaining: number;
  status: FollowUpStatus;
}

/**
 * Pure: every reminder with its derived status. An obligation the statement no longer lists (deleted)
 * or with nothing left reads as resolved — the reminder never keeps a closed debt alive.
 */
export function attentionItems(
  people: readonly Pick<Person, "id" | "name">[],
  followUpsByPersonId: Readonly<Record<string, readonly PersonFollowUp[]>>,
  remainingByPerson: (personId: string) => Map<string, number>,
  today: Date = new Date(),
): AttentionItem[] {
  const out: AttentionItem[] = [];
  for (const person of people) {
    const list = followUpsByPersonId[person.id] ?? [];
    if (list.length === 0) continue;
    const remaining = remainingByPerson(person.id);
    for (const f of list) {
      const left = remaining.get(f.obligationKey) ?? 0;
      out.push({ personId: person.id, personName: person.name, followUp: f, remaining: left, status: followUpStatus(f, left > PAYMENT_EPSILON, today) });
    }
  }
  return out.sort((a, b) => a.followUp.remindOn.getTime() - b.followUp.remindOn.getTime());
}

/** Whole history up to today's cycle end — `remainingNow` there is what is still open today. */
function useAllTimeCycle() {
  const startDay = useMonthCycleStartDay();
  const end = cycleContaining(new Date(), startDay).end.getTime();
  return useMemo(() => ({ start: new Date(1970, 0, 1), end: new Date(end) }), [end]);
}

/**
 * Reminders across all people with their live status — the People "Needs attention" list and the drawer
 * badge. Mounts the shared statement watches, so callers render it only when a reminder exists.
 */
export function usePeopleAttention(followUpsByPersonId: Readonly<Record<string, readonly PersonFollowUp[]>>) {
  const { data: people = [] } = usePeople();
  const cycle = useAllTimeCycle();
  const { statementsByPersonId, isLoading } = usePeopleCycleStatements(cycle);
  const items = useMemo(
    () => attentionItems(people as Person[], followUpsByPersonId, (id) => openRemainingByKey(statementsByPersonId[id])),
    [people, followUpsByPersonId, statementsByPersonId],
  );
  const actionable = items.filter((i) => isActionable(i.status));
  // Upcoming reminders are listed (not urgent); resolved ones drop out of attention entirely.
  const open = items.filter((i) => i.status !== "resolved");
  return { items: open, actionable, isLoading };
}

/** Cheap pre-check (no statements): is any active reminder dated today or earlier? */
export function hasDueCandidate(followUpsByPersonId: Readonly<Record<string, readonly PersonFollowUp[]>>, today: Date = new Date()): boolean {
  const now = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  return Object.values(followUpsByPersonId).some((list) => list.some((f) => f.state === "active" && f.remindOn.getTime() <= now));
}
