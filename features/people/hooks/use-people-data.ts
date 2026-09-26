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

import { useFirestoreWatch } from "@/hooks/use-firestore-watch";
import { useTrashedLoans } from "@/hooks/use-loans";
import { useTransactions } from "@/hooks/use-transactions";
import { useLoanRows } from "@/features/loans/hooks/use-loans-data";
import { personLoanActivity } from "@/features/people/lib/person-loan-activity";
import { isLegacyLoanLedgerEntry, peopleTotals, personPosition, type PersonPosition } from "@/lib/engines/person-position";
import type { Loan } from "@/lib/models/loan";
import { useMemo } from "react";
import { usePeople } from "@/hooks/use-people";
import {
  compareLedgerEntriesNewestFirst,
  ledgerEntryTypeFromName,
  signedAmount,
  type LedgerEntry,
  type LedgerEntryType,
  type Person,
} from "@/lib/models/person";
import type { Expense, ExpenseParticipant, ReceivedStatus } from "@/lib/models/expense";
import { createAccountRepository, createExpenseRepository, createPersonRepository } from "@/lib/repositories/repository-factory";
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

/**
 * Every person's active ledger entries, LIVE — one `watchAll` per person's ledger subcollection,
 * shared through `useFirestoreWatch`. Live (not a one-shot fetch) because People totals now read the
 * entries alongside the live `Person.currentBalance` to recognise legacy Loan-generated entries
 * (`lib/engines/person-position.ts`); a stale entry list next to a fresh balance would mis-split them.
 */
export function usePeopleLedgerEntries() {
  const uid = useAuthStore((s) => s.user?.uid);
  const { data: people = [], isLoading: peopleLoading } = usePeople();
  const personIds = useMemo(() => (people as Person[]).map((p) => p.id).sort(), [people]);

  const query = useFirestoreWatch<Record<string, LedgerEntry[]>>({
    queryKey: ledgerEntriesQueryKey(uid, personIds),
    enabled: !!uid && personIds.length > 0,
    hookName: "usePeopleLedgerEntries",
    emptyValue: {},
    deps: [uid, personIds.join("|")],
    subscribe: (onData, onError) => {
      if (!uid) return () => {};
      const personRepository = createPersonRepository(uid);
      const byPerson: Record<string, LedgerEntry[]> = {};
      const pending = new Set(personIds);
      const unsubscribes = personIds.map((personId) =>
        createLedgerRepository(uid, personId, personRepository).watchAll((entries) => {
          byPerson[personId] = entries;
          pending.delete(personId);
          // Emit only once every person has reported, so totals never mix a partial set.
          if (pending.size === 0) onData({ ...byPerson });
        }, onError),
      );
      return () => unsubscribes.forEach((u) => u());
    },
  });

  return {
    entriesByPersonId: query.data ?? {},
    isLoading: peopleLoading || (personIds.length > 0 && query.data === undefined),
    uid,
  };
}

export interface PersonActivityItem {
  id: string;
  /** Money direction only (derived from the entry's signed amount) — see `receivedStatus` for whether it's actually settled. */
  type: "received" | "paid";
  /** Real settlement status — independent of `type`. */
  receivedStatus: ReceivedStatus;
  description: string;
  amount: number;
  date: string;
  /** Raw `LedgerEntry.date` — for callers that need to compute their own "days since" instead of the formatted `date` string. */
  rawDate: Date;
  /** The person this entry belongs to — needed to resolve the split-expense participant for the ✓/✕ status toggle. */
  personId: string;
  /** `LedgerEntry.transactionRef` — links back to the `Expense`/`Transaction` this entry came from, if any. */
  transactionRef: string | null;
}

export interface PersonViewRow {
  id: string;
  name: string;
  phone: string;
  email: string;
  relationship: string;
  notes: string;
  /** Net position they owe me (direct ledger + Loans, see `lib/engines/person-position.ts`). */
  youAreOwed: number;
  /** Net position I owe them. */
  youOwe: number;
  /** Direct Person ledger balance only (split expenses, settlements, manual entries) — the part Settle Up settles. */
  directBalance: number;
  /** Outstanding Loan principal they owe me / I owe them — settled from the Loan, never from the ledger. */
  loanReceivable: number;
  loanPayable: number;
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
    receivedStatus: entry.receivedStatus,
    description: entry.note || ENTRY_TYPE_LABEL[ledgerEntryTypeFromName(entry.type)],
    amount: Math.abs(amount),
    date: formatDate(entry.date),
    rawDate: entry.date,
    personId: entry.personId,
    transactionRef: entry.transactionRef,
  };
}

function toPersonRow(
  person: Person,
  entries: LedgerEntry[],
  position: PersonPosition,
  loanItems: PersonActivityItem[],
  loanIds: ReadonlySet<string>,
): PersonViewRow {
  // Legacy Loan-generated ledger entries are replaced by the Loan's own events (`loanItems`), so a
  // Loan event never appears twice.
  const sortedEntries = entries.filter((e) => !isLegacyLoanLedgerEntry(e, loanIds)).sort(compareLedgerEntriesNewestFirst);
  const activity = [...sortedEntries.map(toActivityItem), ...loanItems].sort((a, b) => b.rawDate.getTime() - a.rawDate.getTime());
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
    youAreOwed: position.owesMe,
    youOwe: position.iOwe,
    directBalance: position.directBalance,
    loanReceivable: position.loanReceivable,
    loanPayable: position.loanPayable,
    status: position.net === 0 ? "settled" : "active",
    lastActivity: activity[0] ? formatTimestamp(activity[0].rawDate, now) : formatDate(person.createdAt),
    firstTransaction: activity.length > 0 ? formatDate(activity[activity.length - 1].rawDate) : formatDate(person.createdAt),
    // No reminder concept exists on `Person`/`LedgerEntry` — always null.
    reminder: null,
    transactionsCount: activity.length,
    activity,
  };
}

/** Live-derived People-page list — replaces `ledgerPeople`. */
export function usePeopleRows(): { rows: PersonViewRow[]; isLoading: boolean } {
  const { data: people = [], isLoading: peopleLoading } = usePeople();
  const { entriesByPersonId, isLoading: entriesLoading } = usePeopleLedgerEntries();

  const { positionsByPersonId, loans, loanIds, isLoading: positionsLoading } = usePersonPositions();
  const { data: transactions = [] } = useTransactions();

  const rows = useMemo(
    () =>
      (people as Person[]).map((person) => {
        const loanItems: PersonActivityItem[] = personLoanActivity(person.id, loans, transactions).map((item) => ({
          id: item.id,
          type: item.signedEffect >= 0 ? "received" : "paid",
          receivedStatus: "notApplicable",
          description: item.description,
          amount: item.amount,
          date: formatDate(item.date),
          rawDate: item.date,
          personId: person.id,
          transactionRef: null,
        }));
        return toPersonRow(person, entriesByPersonId[person.id] ?? [], positionsByPersonId[person.id], loanItems, loanIds);
      }),
    [people, entriesByPersonId, positionsByPersonId, loans, loanIds, transactions],
  );

  return { rows, isLoading: peopleLoading || entriesLoading || positionsLoading };
}

/**
 * Live People positions — every person's direct ledger balance plus the Loans they are the
 * counterparty on, with legacy Loan-generated ledger entries de-duplicated (see
 * `lib/engines/person-position.ts`). Composes existing live sources only: `usePeople`
 * (`Person.currentBalance`), the live ledger entries, and `useLoanRows` (the same
 * `outstandingPrincipal` Net Worth reads) — so a Loan payment, prepayment, Borrow/Lend More or
 * reversal updates People with no Person write and no refresh.
 */
export function usePersonPositions(): {
  positionsByPersonId: Record<string, PersonPosition>;
  loans: Loan[];
  loanIds: ReadonlySet<string>;
  isLoading: boolean;
} {
  const { data: people = [], isLoading: peopleLoading } = usePeople();
  const { entriesByPersonId, isLoading: entriesLoading } = usePeopleLedgerEntries();
  const { rows: loanRows, isLoading: loansLoading } = useLoanRows();
  const { data: trashedLoans = [], isLoading: trashLoading } = useTrashedLoans();

  return useMemo(() => {
    const loans = loanRows.map((r) => r.loan);
    const positionLoans = loanRows.map((r) => ({
      id: r.loan.id,
      personId: r.loan.personId,
      direction: r.loan.direction,
      outstandingPrincipal: r.outstandingPrincipal,
      isDeleted: false,
    }));
    const loanIds = new Set([...loans.map((l) => l.id), ...(trashedLoans as Loan[]).map((l) => l.id)]);
    const positionsByPersonId: Record<string, PersonPosition> = {};
    for (const person of people as Person[]) {
      positionsByPersonId[person.id] = personPosition({
        personId: person.id,
        currentBalance: person.currentBalance,
        loans: positionLoans,
        ledgerEntries: (entriesByPersonId[person.id] ?? []).map((e) => ({
          transactionRef: e.transactionRef,
          signedAmount: signedAmount(e),
          isDeleted: e.deletedAt != null,
        })),
        loanIds,
      });
    }
    return { positionsByPersonId, loans, loanIds, isLoading: peopleLoading || entriesLoading || loansLoading || trashLoading };
  }, [people, entriesByPersonId, loanRows, trashedLoans, peopleLoading, entriesLoading, loansLoading, trashLoading]);
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

  const { positionsByPersonId, isLoading: positionsLoading } = usePersonPositions();

  const stats = useMemo(() => {
    const totals = peopleTotals((people as Person[]).map((p) => positionsByPersonId[p.id]).filter((p) => p != null));
    const totalYouAreOwed = totals.totalOwedToMe;
    const owedByPeopleCount = totals.owedByCount;
    const totalYouOwe = totals.totalIOwe;
    const owingPeopleCount = totals.owingCount;

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
  }, [people, entriesByPersonId, positionsByPersonId]);

  return { stats, isLoading: peopleLoading || entriesLoading || positionsLoading };
}

export interface RecentPersonTransactionRow {
  id: string;
  /** Money direction only (derived from the entry's signed amount) — see `receivedStatus` for whether it's actually settled. */
  type: "received" | "paid";
  /** Real settlement status — independent of `type`. */
  receivedStatus: ReceivedStatus;
  personId: string;
  personName: string;
  description: string;
  date: string;
  category: string;
  amount: number;
  /** `LedgerEntry.transactionRef` — links back to the `Expense`/`Transaction` this entry came from, if any. */
  transactionRef: string | null;
}

/**
 * Most-recent ledger entries across every person — replaces `recentPeopleTransactions`.
 * Pass `limit: null` for the unbounded list (the "View All" popup); the default `5` keeps
 * the workspace's inline preview short.
 */
export function useRecentPeopleTransactions(limit: number | null = 5): { rows: RecentPersonTransactionRow[]; isLoading: boolean } {
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
    const sorted = all.sort((a, b) => compareLedgerEntriesNewestFirst(a.entry, b.entry));
    return (limit == null ? sorted : sorted.slice(0, limit))
      .map(({ entry, personName }) => {
        const amount = signedAmount(entry);
        return {
          id: entry.id,
          type: amount >= 0 ? ("received" as const) : ("paid" as const),
          receivedStatus: entry.receivedStatus,
          personId: entry.personId,
          personName,
          description: entry.note || ENTRY_TYPE_LABEL[ledgerEntryTypeFromName(entry.type)],
          date: formatDate(entry.date),
          // No spending-category field on `LedgerEntry` — see module doc comment.
          category: ENTRY_TYPE_LABEL[ledgerEntryTypeFromName(entry.type)],
          amount: Math.abs(amount),
          transactionRef: entry.transactionRef,
        };
      });
  }, [people, entriesByPersonId, limit]);

  return { rows, isLoading: peopleLoading || entriesLoading };
}

/** Create/edit/delete actions wired to the real repositories, scoped to the signed-in user. */
export function usePeopleActions() {
  const uid = useAuthStore((s) => s.user?.uid);

  return useMemo(() => {
    if (!uid) return null;
    const personRepository = createPersonRepository(uid);
    const accountRepository = createAccountRepository(uid);
    const expenseRepository = createExpenseRepository(uid, accountRepository);

    // No ledger invalidation: `usePeopleLedgerEntries` is a live watch, and invalidating a watch
    // query would reset it to its empty placeholder until the next snapshot.

    return {
      createPerson: async (params: CreatePersonParams) => {
        return personRepository.createPerson(params);
      },
      editPerson: async (person: Person, params: EditPersonParams) => {
        await personRepository.editPerson(person, params);
      },
      deletePerson: async (person: Person) => {
        const ledgerRepository = createLedgerRepository(uid, person.id, personRepository);
        await personRepository.deletePersonAndLedger(person, ledgerRepository);
      },
      addLedgerEntry: async (
        person: Person,
        params: {
          type: LedgerEntryType;
          amount: number;
          date: Date;
          note?: string;
          increasesBalance?: boolean;
          receivedStatus?: ReceivedStatus;
        },
      ) => {
        const ledgerRepository = createLedgerRepository(uid, person.id, personRepository);
        const entry = await ledgerRepository.addEntry(person, params);
        return entry;
      },
      deleteLedgerEntry: async (person: Person, entry: LedgerEntry) => {
        const ledgerRepository = createLedgerRepository(uid, person.id, personRepository);
        await ledgerRepository.softDeleteEntry(person, entry);
      },
      /** ✓/✕ quick-toggle on a split-expense ledger row — see `ExpenseRepository.setParticipantReceivedStatus`. */
      setParticipantReceivedStatus: async (expense: Expense, participant: ExpenseParticipant, receivedStatus: ReceivedStatus) => {
        const updated = await expenseRepository.setParticipantReceivedStatus(expense, participant, receivedStatus);
        return updated;
      },
    };
  }, [uid]);
}
