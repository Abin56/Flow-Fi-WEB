"use client";

/**
 * Purpose money (`people/{personId}/purposeFunds`), LIVE, plus its actions. The derived views
 * (still to use, statuses, due in a cycle) come from `lib/engines/purpose-funds.ts`.
 */

import { onSnapshot } from "firebase/firestore";
import { useMemo } from "react";
import { useFirestoreWatch } from "@/hooks/use-firestore-watch";
import { usePeople } from "@/hooks/use-people";
import { useTransactions } from "@/hooks/use-transactions";
import { summarizePurposes, type PurposeSummary } from "@/lib/engines/purpose-funds";
import type { Person } from "@/lib/models/person";
import type { PurposeFund, PurposeLink } from "@/lib/models/purpose-fund";
import type { PurposeEditPatch, RecordUseInput } from "@/lib/repositories/purpose-fund-repository";
import { createCategoryRepository, createPurposeFundRepository, createPurposeFundsCollection } from "@/lib/repositories/repository-factory";
import { useAuthStore } from "@/store/auth-store";

/** Every person's purpose docs (soft-deleted left out), keyed by person. Emits once every person has reported. */
export function useAllPurposeFunds() {
  const uid = useAuthStore((s) => s.user?.uid);
  const { data: people = [], isLoading: peopleLoading } = usePeople();
  const personIds = useMemo(() => (people as Person[]).map((p) => p.id).sort(), [people]);

  const query = useFirestoreWatch<Record<string, PurposeFund[]>>({
    queryKey: ["people-purpose-funds", uid, ...personIds] as const,
    enabled: !!uid && personIds.length > 0,
    hookName: "useAllPurposeFunds",
    emptyValue: {},
    deps: [uid, personIds.join("|")],
    subscribe: (onData, onError) => {
      if (!uid) return () => {};
      const byPerson: Record<string, PurposeFund[]> = {};
      const pending = new Set(personIds);
      const unsubscribes = personIds.map((personId) =>
        onSnapshot(
          createPurposeFundsCollection(uid, personId),
          (snapshot) => {
            byPerson[personId] = snapshot.docs.map((d) => d.data()).filter((f) => f.deletedAt == null);
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
    fundsByPersonId: query.data ?? {},
    isLoading: peopleLoading || (personIds.length > 0 && query.data === undefined),
  };
}

/** One person's purposes, with the derived summary. */
export function usePersonPurposeFunds(personId: string): { funds: PurposeFund[]; summary: PurposeSummary; isLoading: boolean } {
  const { fundsByPersonId, isLoading } = useAllPurposeFunds();
  const { data: transactions } = useTransactions();
  const funds = useMemo(() => fundsByPersonId[personId] ?? [], [fundsByPersonId, personId]);
  const summary = useMemo(() => summarizePurposes(funds, transactions ?? null, new Date()), [funds, transactions]);
  return { funds, summary, isLoading };
}

/** Everyone's open purposes — the Dashboard signal and Month Cycle section. */
export function useAllPurposeSummary(): { summary: PurposeSummary; personName: (id: string) => string; isLoading: boolean } {
  const { fundsByPersonId, isLoading } = useAllPurposeFunds();
  const { data: transactions } = useTransactions();
  const { data: people = [] } = usePeople();
  const summary = useMemo(
    () => summarizePurposes(Object.values(fundsByPersonId).flat(), transactions ?? null, new Date()),
    [fundsByPersonId, transactions],
  );
  const names = useMemo(() => new Map((people as Person[]).map((p) => [p.id, p.name])), [people]);
  return { summary, personName: (id) => names.get(id) ?? "Someone", isLoading };
}

export function usePurposeFundActions() {
  const uid = useAuthStore((s) => s.user?.uid);
  return useMemo(() => {
    if (!uid) return null;
    const repo = async (personId: string) => {
      const category = await createCategoryRepository(uid).getOrCreatePersonalLoanCategory();
      return createPurposeFundRepository(uid, personId, category.id);
    };
    return {
      recordUse: async (person: Person, fundId: string, input: RecordUseInput) => (await repo(person.id)).recordUse(person, fundId, input),
      undoUse: async (person: Person, fundId: string, useId: string) => (await repo(person.id)).undoUse(fundId, useId),
      editFund: async (person: Person, fundId: string, patch: PurposeEditPatch) => (await repo(person.id)).editFund(fundId, patch),
      cancelFund: async (person: Person, fundId: string) => (await repo(person.id)).cancelFund(fundId),
      assignUnassigned: async (
        person: Person,
        unassignedId: string,
        draft: { title: string; amount: number; dueDate: Date | null; note: string; link: PurposeLink | null },
      ) => (await repo(person.id)).assignUnassigned(unassignedId, draft),
      releaseUnassigned: async (person: Person, unassignedId: string, to: { kind: "advance" } | { kind: "income"; categoryId: string; description: string }) =>
        (await repo(person.id)).releaseUnassigned(person, unassignedId, to),
    };
  }, [uid]);
}
