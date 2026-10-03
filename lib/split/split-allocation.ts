/**
 * The visual split breakdown's one data shape — read straight from a stored split `Expense`. Pure and
 * presentation-only: the original total is `Expense.totalAmount` and every participant amount is the
 * stored `ExpenseParticipant.share`, passed through unchanged. Nothing is re-split, re-rounded or
 * derived from a share × count, so custom and odd-paise splits show exactly what the engine stored.
 */

import type { Expense } from "@/lib/models/expense";

const SHARE_EPSILON = 0.005;

export interface SplitAllocationParticipant {
  key: string;
  /** The owner's portion: `ownerName` when given (shared statements), else "You"; otherwise the participant's stored display name. */
  label: string;
  /** The stored allocation (`ExpenseParticipant.share`). */
  amount: number;
  isMe: boolean;
  /** The participant whose People Ledger / statement is being viewed. */
  isFocus: boolean;
}

export interface SplitAllocation {
  /** The whole expense (`Expense.totalAmount`) — never derived from a share. */
  original: number;
  /** Participants carrying a stored share above zero, "You" included. */
  participantCount: number;
  /** Those participants in stored order, with "You" first. Empty for a legacy expense with no participant detail. */
  participants: SplitAllocationParticipant[];
  /** My stored allocation (0 when I carry none). */
  myShare: number;
  /** The focus person's stored allocation; null when there is no focus person or they are not on the expense. */
  focusShare: number | null;
  /** Sum of the stored allocations, as stored. */
  allocated: number;
  /** The stored allocations add up to the stored original (to the paisa). */
  reconciles: boolean;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The breakdown of one split Expense, or null when there is nothing live to show (no expense, or it is
 * deleted — a trashed expense never keeps a live breakdown). `focusPersonId` marks the People Ledger's person.
 */
export function splitAllocation(
  expense: Expense | null | undefined,
  focusPersonId: string | null = null,
  /** Recipient-facing output names the owner ("You" would read as the recipient); private UI omits it and keeps "You". */
  ownerName: string | null = null,
): SplitAllocation | null {
  if (!expense || expense.deletedAt != null) return null;
  const stored = expense.participants ?? [];
  const carrying = stored
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => Number.isFinite(p.share) && p.share > SHARE_EPSILON);
  const participants: SplitAllocationParticipant[] = carrying
    .map(({ p, i }) => ({
      key: p.isMe ? `me:${i}` : p.personId != null ? `person:${p.personId}:${i}` : `name:${i}`,
      label: p.isMe ? ownerName?.trim() || "You" : p.name || "Unnamed",
      amount: p.share,
      isMe: p.isMe,
      isFocus: !p.isMe && focusPersonId != null && p.personId === focusPersonId,
    }))
    // "You" first; everyone else keeps the stored order (a stable sort).
    .sort((a, b) => Number(b.isMe) - Number(a.isMe));
  const theirs = stored.filter((p) => !p.isMe && focusPersonId != null && p.personId === focusPersonId);
  const allocated = round2(stored.reduce((s, p) => s + (Number.isFinite(p.share) ? p.share : 0), 0));
  return {
    original: expense.totalAmount,
    participantCount: participants.length,
    participants,
    myShare: round2(stored.filter((p) => p.isMe).reduce((s, p) => s + p.share, 0)),
    focusShare: theirs.length > 0 ? round2(theirs.reduce((s, p) => s + p.share, 0)) : null,
    allocated,
    reconciles: Math.abs(allocated - expense.totalAmount) < SHARE_EPSILON,
  };
}

/** "4-way split" / "Assigned in full" (one carrier) / "Split expense" (no participant detail). */
export function splitCountLabel(a: Pick<SplitAllocation, "participantCount">): string {
  if (a.participantCount >= 2) return `${a.participantCount}-way split`;
  return a.participantCount === 1 ? "Assigned in full" : "Split expense";
}

/** The screen-reader sentence: "Original total ₹4,000. Split among 4 participants. You ₹1,000. Amma ₹1,000." */
export function splitAllocationSentence(a: SplitAllocation, money: (n: number) => string): string {
  const parts = [`Original total ${money(a.original)}.`];
  if (a.participantCount > 0) parts.push(`Split among ${a.participantCount} participant${a.participantCount === 1 ? "" : "s"}.`);
  for (const p of a.participants) parts.push(`${p.label} ${money(p.amount)}${p.isFocus ? " (their share)" : ""}.`);
  return parts.join(" ");
}
