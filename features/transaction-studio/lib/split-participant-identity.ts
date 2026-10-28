/**
 * One person, one row: a typed (custom) name that is the same person as a row already picked from People. The
 * commit resolves typed names to People by name, so "Ravi" picked + "Ravi" typed would be Ravi twice — the
 * repository refuses that (`DuplicateSplitParticipantError`); the editor says so before the row is saved.
 */

import type { Person } from "@/lib/models/person";

interface ParticipantIdentity {
  personId: string | null;
  name: string;
  isMe: boolean;
}

const normalized = (name: string) => name.trim().toLowerCase();

/** Every name a picked (non-"Me") row answers to: the name on the row and the person's name in People. */
function pickedNames(participants: readonly ParticipantIdentity[], people: readonly Pick<Person, "id" | "name">[]): Set<string> {
  const names = new Set<string>();
  for (const p of participants) {
    if (p.isMe || p.personId == null) continue;
    names.add(normalized(p.name));
    const person = people.find((x) => x.id === p.personId);
    if (person) names.add(normalized(person.name));
  }
  names.delete("");
  return names;
}

/** The message for the first typed row that repeats a picked person, or null. */
export function repeatedParticipantError(participants: readonly ParticipantIdentity[], people: readonly Pick<Person, "id" | "name">[]): string | null {
  const picked = pickedNames(participants, people);
  const repeat = participants.find((p) => !p.isMe && p.personId == null && picked.has(normalized(p.name)));
  return repeat ? `${repeat.name.trim()} is already in this split — remove one of the rows.` : null;
}

/** People that can still be added: not picked already, and not already typed as a custom name. */
export function addablePeople<P extends Pick<Person, "id" | "name">>(people: readonly P[], participants: readonly ParticipantIdentity[]): P[] {
  const typed = new Set(participants.filter((p) => !p.isMe && p.personId == null).map((p) => normalized(p.name)));
  return people.filter((person) => !participants.some((d) => d.personId === person.id) && !typed.has(normalized(person.name)));
}
