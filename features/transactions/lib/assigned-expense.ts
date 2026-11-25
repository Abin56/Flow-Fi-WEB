/**
 * "Paid for someone else" vs "Split" — read from the saved Expense, never written.
 *
 * An expense assigned to one person (Smart Capture "Someone else", Assign to a person, `assignToPerson`) is stored as a
 * one-participant Expense: that person owes the whole amount and there is no "Me" share. It is shaped like a split, but it
 * is not one — my share is ₹0. A real split keeps a "Me" share above ₹0 (or has several people sharing it).
 * Stored data is untouched; this only decides which label the lists and the details show.
 */

import { isSplit, meParticipant, type Expense } from "@/lib/models/expense";

/** The one person this whole expense was paid for, or null when it is not an assigned-to-one-person expense. */
export function assignedPerson(expense: Expense | null | undefined): { personId: string | null; name: string } | null {
  if (!expense || !isSplit(expense)) return null;
  if ((meParticipant(expense)?.share ?? 0) > 0) return null;
  const others = expense.participants.filter((p) => !p.isMe);
  if (others.length !== 1) return null;
  const [person] = others;
  return { personId: person.personId, name: person.name };
}
