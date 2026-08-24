"use client";

/**
 * Composes the People (Ledger) page's real data/actions from the ported
 * `Person`/`LedgerEntry` models (`lib/models/person.ts`) and
 * `PersonRepository`/`LedgerRepository` (`lib/repositories/person-repository.ts`)
 * — replaces `lib/mock/people-data.ts` as the page's data source. Mirrors
 * `features/bills/hooks/use-bills-data.ts`'s composition style: live people
 * come from `hooks/use-people.ts` (a `watchAll` subscription), and each
 * person's ledger entries (a subcollection, not a flat uid-scoped
 * collection — see `person-repository.ts`'s doc comment) are fetched once
 * per person-id-set via `features/people/lib/ledger-factory.ts`, matching
 * `use-bills-data.ts`'s `useBillRows` occurrence-fetch shape.
 *
 * Creditor/debtor role and balance are never recomputed here — `isCreditor`/
 * `isDebtor`/`signedAmount` from `lib/models/person.ts` are the sole source
 * of truth, exactly as the model's doc comments describe.
 *
 * Known, accepted gaps for this pass (called out here instead of invented):
 *  - `Person` has no `relationship` (Friend/Colleague/...) field anywhere in
 *    the ported model, so `relationship` is always `""` rather than
 *    fabricated. The UI still renders the field; it just renders blank.
 *  - `Person`/`LedgerEntry` carry no due-date or reminder concept, so a
 *    per-person "overdue" status can't be derived — `status` is only ever
 *    "settled" (currentBalance === 0) or "active" (nonzero balance), never
 *    "overdue", and `reminder` is always `null`.
 *  - `LedgerEntry` has no spending-category field, so the recent-activity
 *    feed's "category" chip uses the entry's real `LedgerEntryType`
 *    (title-cased) instead of inventing a category — the same approach
 *    `use-accounts-data.ts` takes for `Transaction.type`.
 *  - "Settled this month" is derived from real ledger entries of type
 *    "repaid"/"receivedBack" (the two types that represent a debt being
 *    paid back) dated in the current calendar month — a real aggregate, not
 *    a stored field, since no "settled" flag exists on `LedgerEntry`.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { usePeople, peopleQueryKey } from "@/hooks/use-people";
import {
  isCreditor,
  isDebtor,
  ledgerEntryTypeFromName,
  signedAmount,
  type LedgerEntry,
  type LedgerEntryType,
  type Person,
} from "@/lib/models/person";
import { createPersonRepository } from "@/lib/repositories/repository-factory";
import type { CreatePersonParams, EditPersonParams } from "@/lib/repositories/person-repository";
import { createLedgerRepository } from "@/features/people/lib/ledger-factory";
import { useAuthStore } from "@/store/auth-store";

/**
 * "settled" (zero balance) vs "active" (nonzero balance) — never "overdue",
 * since neither `Person` nor `LedgerEntry` carries a due date to be overdue
 * against. Kept here (not re-exported from `lib/mock/people-data.ts`, which
 * this hook replaces) so the People page has no remaining mock dependency.
 */
export type PersonStatus = "active" | "overdue" | "settled";

function formatDate(date: Date): string {
  return date.toLocaleDateString("en-IN", { month: "short", day: "numeric", year: "numeric" });
}

function formatTimestamp(date: Date, now: Date): string {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.round((today.getTime() - target.getTime()) / (24 * 60 * 60 * 1000));
  const time = date.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
  if (diffDays === 0) return `Today, ${time}`;
  if (diffDays === 1) return `Yesterday, ${time}`;
  return formatDate(date);
}

const ENTRY_TYPE_LABEL: Record<LedgerEntryType, string> = {
  gave: "Gave",
  borrowed: "Borrowed",
  receivedBack: "Received Back",
  repaid: "Repaid",
  adjustment: "Adjustment",
};

function ledgerEntriesQueryKey(uid: string | undefined, personIds: string[]) {
  return ["people-ledger-entries", uid, ...personIds] as const;
}

/** Fetches every (non-live) person's ledger entries once per person-id-set. */
function usePeopleLedgerEntries() {
  const uid = useAuthStore((s) => s.user?.uid);
  const { data: people = [], isLoading: peopleLoading } = usePeople();
  const personIds = useMemo(() => (people as Person[]).map((p) => p.id).sort(), [people]);

  const query = useQuery({
    queryKey: ledgerEntriesQueryKey(uid, personIds),
    queryFn: async () => {
      if (!uid) return {} as Record<string, LedgerEntry[]>;
      const personRepository = createPersonRepository(uid);
      const entries = await Promise.all(
        (people as Person[]).map(async (person) => {
          const ledgerRepository = createLedgerRepository(uid, person.id, personRepository);
          const active = await ledgerRepository.getAll();
          return [person.id, active] as const;
        }),
      );
      return Object.fromEntries(entries) as Record<string, LedgerEntry[]>;
    },
    enabled: !!uid && personIds.length > 0,
    staleTime: 60_000,
  });

  return {
    entriesByPersonId: query.data ?? {},
    isLoading: peopleLoading || (personIds.length > 0 && query.isLoading),
    uid,
  };
}

export interface PersonActivityItem {
  id: string;
  type: "received" | "paid";
  description: string;
  amount: number;
  date: string;
}

export interface PersonViewRow {
  id: string;
  name: string;
  phone: string;
  email: string;
  relationship: string;
  notes: string;
  youAreOwed: number;
  youOwe: number;
  status: PersonStatus;
  lastActivity: string;
  firstTransaction: string;
  reminder: string | null;
  transactionsCount: number;
  activity: PersonActivityItem[];
}

function toActivityItem(entry: LedgerEntry): PersonActivityItem {
  const amount = signedAmount(entry);
  return {
    id: entry.id,
    type: amount >= 0 ? "received" : "paid",
    description: entry.note || ENTRY_TYPE_LABEL[ledgerEntryTypeFromName(entry.type)],
    amount: Math.abs(amount),
    date: formatDate(entry.date),
  };
}

function toPersonRow(person: Person, entries: LedgerEntry[]): PersonViewRow {
  const sortedEntries = entries.slice().sort((a, b) => b.date.getTime() - a.date.getTime());
  const now = new Date();

  return {
    id: person.id,
    name: person.name,
    phone: person.phone ?? "",
    email: person.email ?? "",
    // `Person` has no `relationship` field — see module doc comment's
    // accepted-gaps list.
    relationship: "",
    notes: person.notes,
    youAreOwed: isCreditor(person) ? person.currentBalance : 0,
    youOwe: isDebtor(person) ? -person.currentBalance : 0,
    status: person.currentBalance === 0 ? "settled" : "active",
    lastActivity: sortedEntries[0] ? formatTimestamp(sortedEntries[0].date, now) : formatDate(person.createdAt),
    firstTransaction: sortedEntries.length > 0 ? formatDate(sortedEntries[sortedEntries.length - 1].date) : formatDate(person.createdAt),
    // No reminder concept exists on `Person`/`LedgerEntry` — always null.
    reminder: null,
    transactionsCount: entries.length,
    activity: sortedEntries.map(toActivityItem),
  };
}

/** Live-derived People-page list — replaces `ledgerPeople`. */
export function usePeopleRows(): { rows: PersonViewRow[]; isLoading: boolean } {
  const { data: people = [], isLoading: peopleLoading } = usePeople();
  const { entriesByPersonId, isLoading: entriesLoading } = usePeopleLedgerEntries();

  const rows = useMemo(
    () => (people as Person[]).map((person) => toPersonRow(person, entriesByPersonId[person.id] ?? [])),
    [people, entriesByPersonId],
  );

  return { rows, isLoading: peopleLoading || entriesLoading };
}

export interface PeopleStatsSummary {
  totalYouAreOwed: number;
  owedByPeopleCount: number;
  totalYouOwe: number;
  owingPeopleCount: number;
  netBalance: number;
  settledThisMonth: number;
  settledTransactionsCount: number;
}

/** Stats row — real sums over `Person.currentBalance` and this month's repayment-type ledger entries. */
export function usePeopleStats(): { stats: PeopleStatsSummary; isLoading: boolean } {
  const { data: people = [], isLoading: peopleLoading } = usePeople();
  const { entriesByPersonId, isLoading: entriesLoading } = usePeopleLedgerEntries();

  const stats = useMemo(() => {
    const list = people as Person[];
    const totalYouAreOwed = list.filter(isCreditor).reduce((sum, p) => sum + p.currentBalance, 0);
    const owedByPeopleCount = list.filter(isCreditor).length;
    const totalYouOwe = list.filter(isDebtor).reduce((sum, p) => sum - p.currentBalance, 0);
    const owingPeopleCount = list.filter(isDebtor).length;

    const now = new Date();
    let settledThisMonth = 0;
    let settledTransactionsCount = 0;
    for (const entries of Object.values(entriesByPersonId)) {
      for (const entry of entries) {
        const isSettlementType = entry.type === "repaid" || entry.type === "receivedBack";
        const isThisMonth = entry.date.getFullYear() === now.getFullYear() && entry.date.getMonth() === now.getMonth();
        if (isSettlementType && isThisMonth) {
          settledThisMonth += entry.amount;
          settledTransactionsCount += 1;
        }
      }
    }

    return {
      totalYouAreOwed,
      owedByPeopleCount,
      totalYouOwe,
      owingPeopleCount,
      netBalance: totalYouAreOwed - totalYouOwe,
      settledThisMonth,
      settledTransactionsCount,
    };
  }, [people, entriesByPersonId]);

  return { stats, isLoading: peopleLoading || entriesLoading };
}

export interface RecentPersonTransactionRow {
  id: string;
  type: "received" | "paid";
  personName: string;
  description: string;
  date: string;
  category: string;
  amount: number;
}

/** Most-recent ledger entries across every person — replaces `recentPeopleTransactions`. */
export function useRecentPeopleTransactions(limit = 5): { rows: RecentPersonTransactionRow[]; isLoading: boolean } {
  const { data: people = [], isLoading: peopleLoading } = usePeople();
  const { entriesByPersonId, isLoading: entriesLoading } = usePeopleLedgerEntries();

  const rows = useMemo(() => {
    const personById = new Map((people as Person[]).map((p) => [p.id, p]));
    const all: { entry: LedgerEntry; personName: string }[] = [];
    for (const [personId, entries] of Object.entries(entriesByPersonId)) {
      const person = personById.get(personId);
      if (!person) continue;
      for (const entry of entries) all.push({ entry, personName: person.name });
    }
    return all
      .sort((a, b) => b.entry.date.getTime() - a.entry.date.getTime())
      .slice(0, limit)
      .map(({ entry, personName }) => {
        const amount = signedAmount(entry);
        return {
          id: entry.id,
          type: amount >= 0 ? ("received" as const) : ("paid" as const),
          personName,
          description: entry.note || ENTRY_TYPE_LABEL[ledgerEntryTypeFromName(entry.type)],
          date: formatDate(entry.date),
          // No spending-category field on `LedgerEntry` — see module doc comment.
          category: ENTRY_TYPE_LABEL[ledgerEntryTypeFromName(entry.type)],
          amount: Math.abs(amount),
        };
      });
  }, [people, entriesByPersonId, limit]);

  return { rows, isLoading: peopleLoading || entriesLoading };
}

/** Create/edit/delete actions wired to the real repositories, scoped to the signed-in user. */
export function usePeopleActions() {
  const uid = useAuthStore((s) => s.user?.uid);
  const queryClient = useQueryClient();

  return useMemo(() => {
    if (!uid) return null;
    const personRepository = createPersonRepository(uid);

    const invalidateLedger = () =>
      queryClient.invalidateQueries({ queryKey: ["people-ledger-entries", uid], exact: false });

    return {
      createPerson: async (params: CreatePersonParams) => {
        const person = await personRepository.createPerson(params);
        await queryClient.invalidateQueries({ queryKey: peopleQueryKey(uid) });
        return person;
      },
      editPerson: async (person: Person, params: EditPersonParams) => {
        await personRepository.editPerson(person, params);
        await queryClient.invalidateQueries({ queryKey: peopleQueryKey(uid) });
      },
      deletePerson: async (person: Person) => {
        const ledgerRepository = createLedgerRepository(uid, person.id, personRepository);
        await personRepository.deletePersonAndLedger(person, ledgerRepository);
        await queryClient.invalidateQueries({ queryKey: peopleQueryKey(uid) });
        await invalidateLedger();
      },
      addLedgerEntry: async (
        person: Person,
        params: { type: LedgerEntryType; amount: number; date: Date; note?: string; increasesBalance?: boolean },
      ) => {
        const ledgerRepository = createLedgerRepository(uid, person.id, personRepository);
        const entry = await ledgerRepository.addEntry(person, params);
        await queryClient.invalidateQueries({ queryKey: peopleQueryKey(uid) });
        await invalidateLedger();
        return entry;
      },
      deleteLedgerEntry: async (person: Person, entry: LedgerEntry) => {
        const ledgerRepository = createLedgerRepository(uid, person.id, personRepository);
        await ledgerRepository.softDeleteEntry(person, entry);
        await queryClient.invalidateQueries({ queryKey: peopleQueryKey(uid) });
        await invalidateLedger();
      },
    };
  }, [uid, queryClient]);
}
