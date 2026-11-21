/**
 * Ordering for the People Ledger list. Pure presentation — every amount comes from the person's own
 * `PersonCycleStatement` (`toReceive` / `toGive`), read, never re-derived or netted.
 */

import type { PersonCycleStatement } from "@/lib/engines/person-cycle-statement";

export type PeopleSort = "amountDesc" | "amountAsc" | "name" | "recent";

export const PEOPLE_SORTS: { value: PeopleSort; label: string }[] = [
  { value: "amountDesc", label: "Highest amount" },
  { value: "amountAsc", label: "Lowest amount" },
  { value: "name", label: "Name" },
  { value: "recent", label: "Recent activity" },
];

export interface SortableRow {
  id: string;
  name: string;
  statement: PersonCycleStatement;
  /** Newest ledger activity for this person (any cycle), when known. */
  lastActive?: Date | null;
}

/**
 * The figure a person is ranked by: the side of their own direction (what they owe you, or what you owe them).
 * For someone owing in both directions, the larger side — the two are never added or netted.
 */
export function sortAmount(s: PersonCycleStatement): number {
  if (s.direction === "theyOwe") return s.toReceive;
  if (s.direction === "iOwe") return s.toGive;
  return Math.max(s.toReceive, s.toGive);
}

const isOpen = (s: PersonCycleStatement) => s.direction !== "settled" || s.toReceive > 0 || s.toGive > 0;
const byName = (a: SortableRow, b: SortableRow) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });

export function sortPeople<T extends SortableRow>(rows: readonly T[], sort: PeopleSort): T[] {
  const list = [...rows];
  switch (sort) {
    case "name":
      return list.sort(byName);
    case "recent":
      return list.sort((a, b) => (b.lastActive?.getTime() ?? 0) - (a.lastActive?.getTime() ?? 0) || byName(a, b));
    case "amountAsc":
    case "amountDesc": {
      const dir = sort === "amountDesc" ? -1 : 1;
      // Settled people (nothing open either way) always go last — "lowest" means the smallest open amount, not ₹0.
      return list.sort(
        (a, b) =>
          Number(isOpen(b.statement)) - Number(isOpen(a.statement)) ||
          dir * (sortAmount(a.statement) - sortAmount(b.statement)) ||
          byName(a, b),
      );
    }
  }
}
