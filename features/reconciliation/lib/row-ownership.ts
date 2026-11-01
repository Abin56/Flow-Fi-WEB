/**
 * Person / split assignment for an imported expense — pure. It validates the drafted allocation (in integer paise, so
 * nothing drifts), explains each problem in words, and maps a valid draft onto the staged-record shape the existing
 * commit engine already writes (`shared_expense` / `someone_elses_expense` → `createExpenseAtomic`). Nothing here reads
 * or writes FlowFi data; the repositories stay the authority and re-check everything when the approval writes.
 *
 * One person, one row — the rule behind the "duplicate participant ledger" blocker (a picked person plus the same name
 * typed as a custom row both resolved to one person id and overwrote one ledger entry while the balance moved twice).
 * It is refused here before any approval, and again by the repository before any write.
 */

import type { Person } from "@/lib/models/person";
import type { SplitParticipantDraft, RecordActionDetail } from "@/lib/models/document-import";
import { toPaise } from "./amounts-and-days";
import type { ReconRow, RowOwnership, SplitShareDraft } from "./types";

/** The slice of a Person the checks need. */
export type PersonRef = Pick<Person, "id" | "name"> & { deletedAt?: Date | null };

const normalized = (name: string) => name.trim().toLowerCase();
/** The typed name "Me" would become a second, ordinary contact called Me beside the permanent Me row. */
const isMeName = (name: string) => normalized(name) === "me";

const fromPaise = (paise: number) => Math.round(paise) / 100;
const money = (paise: number) => `₹${fromPaise(paise).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

let counter = 0;
export function newShareId(): string {
  counter += 1;
  return `share-${Date.now().toString(36)}-${counter}`;
}

/** A fresh split: Me, plus one empty row for the other person. */
export function emptySplit(): Extract<RowOwnership, { kind: "split" }> {
  return {
    kind: "split",
    splitType: "equal",
    shares: [
      { id: newShareId(), personId: null, name: "Me", isMe: true, amount: "" },
      { id: newShareId(), personId: null, name: "", isMe: false, amount: "" },
    ],
  };
}

/** Parses what was typed into an amount cell: a plain number with at most two decimals, else null. */
export function parseShareAmount(text: string): number | null {
  const cleaned = text.replace(/[,\s₹]/g, "");
  if (cleaned === "" || !/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return Number(cleaned);
}

/**
 * Every participant's share in paise. Equal splits follow the repository's own rule (each share rounded, the last
 * person takes the remainder); custom splits are the typed amounts. `null` for a custom cell that can't be read.
 */
export function sharePaise(shares: readonly SplitShareDraft[], splitType: "equal" | "custom", totalPaise: number): (number | null)[] {
  if (splitType === "equal") {
    const each = Math.round(totalPaise / Math.max(1, shares.length));
    const out = shares.map(() => each);
    if (out.length > 0) out[out.length - 1] += totalPaise - each * out.length;
    return out;
  }
  return shares.map((s) => {
    const n = parseShareAmount(s.amount);
    return n == null ? null : toPaise(n);
  });
}

function personErrors(name: string, personId: string | null, people: readonly PersonRef[] | undefined, others: readonly { personId: string | null; name: string }[]): string | null {
  const label = name.trim() || "Someone";
  if (personId != null) {
    if (people && !people.some((p) => p.id === personId && p.deletedAt == null)) return `${label} isn't in People any more — choose someone else.`;
    return null;
  }
  if (name.trim() === "") return "Choose a person, or type a name.";
  if (isMeName(name)) return `"${name.trim()}" is you — use your own row instead.`;
  const known = people?.find((p) => p.deletedAt == null && normalized(p.name) === normalized(name));
  if (known) return `${name.trim()} is already in People — pick them from the list instead of typing the name.`;
  if (others.some((o) => o.personId == null && normalized(o.name) === normalized(name))) return `${name.trim()} is already in this split — remove one of the rows.`;
  return null;
}

/**
 * What stops this ownership from being imported (empty = valid). `people` is the list the check runs against; when it
 * isn't loaded yet (undefined) a picked person can't be checked, and the final approval re-checks against the server.
 */
export function ownershipErrors(row: Pick<ReconRow, "amount" | "direction">, ownership: RowOwnership | null | undefined, people?: readonly PersonRef[]): string[] {
  if (!ownership) return [];
  if (row.direction !== "debit") return ["Only expenses can be assigned to a person or split."];
  if (row.amount == null || !(row.amount > 0)) return ["Enter the amount first."];

  if (ownership.kind === "person") return [personErrors(ownership.name, ownership.personId, people, [])].filter((e): e is string => e != null);

  const errors: string[] = [];
  const { shares, splitType } = ownership;
  const others = shares.filter((s) => !s.isMe);
  if (shares.filter((s) => s.isMe).length !== 1) errors.push("A split needs exactly one row for you.");
  if (others.length === 0) errors.push("Add at least one other person to split with.");

  const seenIds = new Set<string>();
  others.forEach((s, i) => {
    const err = personErrors(s.name, s.personId, people, others.filter((_, j) => j !== i));
    if (err) errors.push(err);
    if (s.personId != null) {
      if (seenIds.has(s.personId)) errors.push(`${s.name.trim() || "Someone"} is already in this split — remove one of the rows.`);
      seenIds.add(s.personId);
    }
  });

  const total = toPaise(row.amount);
  if (splitType === "equal") {
    if (shares.length > 0 && total < shares.length) errors.push(`${money(total)} is too small to split between ${shares.length} people.`);
  } else {
    const parsed = sharePaise(shares, "custom", total);
    const unreadable = shares.filter((_, i) => parsed[i] == null);
    if (unreadable.length > 0) errors.push("Enter every amount as a number with at most two decimals.");
    else {
      parsed.forEach((p, i) => {
        if (!shares[i].isMe && (p as number) < 1) errors.push(`${shares[i].name.trim() || "Someone"} needs an amount above ₹0.`);
      });
      const sum = (parsed as number[]).reduce((s, p) => s + p, 0);
      if (sum !== total) errors.push(sum < total ? `${money(total - sum)} left to assign — the amounts must add up to ${money(total)}.` : `${money(sum - total)} over — the amounts must add up to ${money(total)}.`);
    }
  }
  // Several rows can fail the same way (two empty person rows) — say each problem once.
  return [...new Set(errors)];
}

/** One line for the review / approval: "Ravi owes ₹500.00", "Split with Ravi, Asha". */
export function describeOwnership(row: Pick<ReconRow, "amount">, ownership: RowOwnership | null | undefined): string | null {
  if (!ownership) return null;
  if (ownership.kind === "person") return `For ${ownership.name.trim() || "someone"} — they owe the full amount`;
  const names = ownership.shares.filter((s) => !s.isMe).map((s) => s.name.trim() || "someone");
  const total = row.amount != null ? toPaise(row.amount) : 0;
  const mine = sharePaise(ownership.shares, ownership.splitType, total)[ownership.shares.findIndex((s) => s.isMe)];
  return `Split with ${names.join(", ")}${mine != null ? ` · your share ${money(mine)}` : ""}`;
}

/**
 * The staged-record detail the commit engine takes, for a VALID ownership (callers check `ownershipErrors` first).
 * Equal splits carry the repository's own share rule, so the engine's keyed replay check compares like with like.
 */
export function ownershipDetail(row: Pick<ReconRow, "amount">, ownership: RowOwnership): { action: "shared_expense" | "someone_elses_expense"; detail: RecordActionDetail } {
  if (ownership.kind === "person") {
    return { action: "someone_elses_expense", detail: { kind: "someone_elses_expense", personId: ownership.personId, personName: ownership.name.trim() } };
  }
  const total = toPaise(row.amount ?? 0);
  const paise = sharePaise(ownership.shares, ownership.splitType, total);
  const participants: SplitParticipantDraft[] = ownership.shares.map((s, i) => ({
    personId: s.isMe ? null : s.personId,
    name: s.isMe ? "Me" : s.name.trim(),
    share: fromPaise(paise[i] ?? 0),
    isMe: s.isMe,
    receivedStatus: s.isMe ? "notApplicable" : "yetToReceive",
  }));
  return { action: "shared_expense", detail: { kind: "shared_expense", splitType: ownership.splitType, participants } };
}
