"use client";

import { PeopleAttention } from "@/features/people/components/people-attention";
import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { Plus, UserPlus, Users, X } from "lucide-react";
import { ConfirmDialog } from "@/components/finance";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AddPersonInline,
  type AddPersonValues,
} from "@/features/people/components/add-person-inline";
import {
  PeopleCycleControl,
  PeopleCycleSummary,
  PeopleCycleSummarySkeleton,
  PeopleLedgerList,
  PeopleLedgerListSkeleton,
  PeopleListToolbar,
  type PeopleFilter,
  type PeopleLedgerRow,
} from "@/features/people/components/people-ledger-list";
import {
  PersonDetailWorkspace,
  type SettleEntryParams,
} from "@/features/people/components/person-detail-workspace";
import type { AddEntryParams } from "@/features/people/components/workspace/add-entry-panel";
import type { EditPersonPatch } from "@/features/people/components/workspace/edit-person-mode";
import type { EntryEditValues } from "@/features/people/components/workspace/ledger-ui";
import { LE_RADIUS } from "@/features/loans/components/loan-emi-ui";
import {
  WS_PRIMARY,
  WS_SECONDARY,
} from "@/features/people/components/workspace/person-workspace-ui";
import {
  usePeopleActions,
  usePeopleRows,
} from "@/features/people/hooks/use-people-data";
import { usePeopleCycleStatements } from "@/features/people/hooks/use-person-cycle-statement";
import { usePeople } from "@/hooks/use-people";
import type { StatementCycle } from "@/lib/engines/person-cycle-statement";
import { useSelectedCycle } from "@/features/people/hooks/use-selected-cycle";
import { CYCLE_PARAM, parseCycleAnchor, VIEW_PARAM } from "@/features/people/lib/people-return-link";
import type { LedgerEntry, Person } from "@/lib/models/person";
import { cn } from "@/lib/utils";
import { toast } from "@/store/toast-store";

/** Receivables first, then payables, largest first; settled people last, by name. */
function byPosition(a: PeopleLedgerRow, b: PeopleLedgerRow): number {
  const rank = (r: PeopleLedgerRow) =>
    r.statement.direction === "theyOwe"
      ? 0
      : r.statement.direction === "iOwe"
        ? 1
        : 2;
  return (
    rank(a) - rank(b) ||
    b.statement.amount - a.statement.amount ||
    a.name.localeCompare(b.name)
  );
}

export function PeopleWorkspace() {
  const { rows: people, isLoading: peopleLoading } = usePeopleRows();
  const { data: rawPeople = [] } = usePeople();
  const actions = usePeopleActions();

  // A return link from Transactions (`?person=…&cycle=<start>[&view=ledger]`) restores that exact ledger
  // context, resolved against the global Month cycle setting. Read once — later navigation is local state.
  const initialParams = useSearchParams();
  const [returnAnchor] = useState(() => parseCycleAnchor(initialParams.get(CYCLE_PARAM)));
  /** The person whose expanded ledger the return link reopens — consumed when that person is closed. */
  const [returnLedgerPersonId, setReturnLedgerPersonId] = useState<string | null>(() =>
    initialParams.get(VIEW_PARAM) === "ledger" ? initialParams.get("person") : null,
  );
  const [cycle, setCycleState] = useSelectedCycle(undefined, returnAnchor);
  const [cycleDirection, setCycleDirection] = useState<-1 | 0 | 1>(0);
  function setCycle(next: StatementCycle) {
    const delta = next.start.getTime() - cycle.start.getTime();
    setCycleDirection(delta < 0 ? -1 : delta > 0 ? 1 : 0);
    setCycleState(next);
  }
  const { statementsByPersonId, isLoading: statementsLoading } =
    usePeopleCycleStatements(cycle);
  const isLoading = peopleLoading || statementsLoading;

  const [filter, setFilter] = useState<PeopleFilter>("all");
  const [search, setSearch] = useState("");
  // The open person lives in the URL (`?person=<id>`) via the native History API, which Next's router
  // syncs with `useSearchParams` — so browser Back/Forward move between the list and a person. List
  // state (cycle, search, filter) stays in this component, which never unmounts.
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const selectedId = searchParams.get("person");
  /** True when this page pushed the person entry, so leaving can pop it instead of stacking another. */
  const pushedRef = useRef(false);
  const listScrollRef = useRef(0);

  function openPerson(id: string) {
    listScrollRef.current = scroller()?.scrollTop ?? 0;
    pushedRef.current = true;
    window.history.pushState(null, "", `${pathname}?person=${encodeURIComponent(id)}`);
  }

  function closePerson() {
    setReturnLedgerPersonId(null);
    if (pushedRef.current) {
      pushedRef.current = false;
      window.history.back();
    } else {
      window.history.replaceState(null, "", pathname);
    }
  }

  // Detail opens at the top; the list comes back where it was left.
  useEffect(() => {
    const el = scroller();
    if (!el) return;
    if (selectedId) {
      el.scrollTo({ top: 0 });
    } else {
      pushedRef.current = false;
      const top = listScrollRef.current;
      requestAnimationFrame(() => el.scrollTo({ top }));
    }
  }, [selectedId]);
  const [addPersonOpen, setAddPersonOpenState] = useState(false);
  /** Bumped on every open so the inline form starts empty. */
  const [addPersonKey, setAddPersonKey] = useState(0);
  const [deletingPerson, setDeletingPerson] = useState<Person | null>(null);

  function setAddPersonOpen(open: boolean) {
    if (open && !addPersonOpen) setAddPersonKey((k) => k + 1);
    setAddPersonOpenState(open);
  }

  async function handleAddPerson(values: AddPersonValues) {
    if (!actions) throw new Error("Not signed in");
    await actions.createPerson({ ...values, avatarColorValue: 0, notes: "" });
    setAddPersonOpen(false);
    toast.success("Person added", `${values.name} is now in your People Ledger.`);
  }

  async function handleDeletePerson() {
    if (!actions || !deletingPerson) return;
    try {
      await actions.deletePerson(deletingPerson);
      if (selectedId === deletingPerson.id) closePerson();
      setDeletingPerson(null);
    } catch (e) {
      toast.error(
        "Couldn't delete person",
        e instanceof Error ? e.message : "Please try again.",
      );
    }
  }

  /** Same `editPerson` payload the old Edit Person dialog sent; errors surface in the workspace's Edit mode. */
  async function handleEditPerson(person: Person, patch: EditPersonPatch) {
    if (!actions) throw new Error("Not signed in");
    await actions.editPerson(person, patch);
  }

  /**
   * Posts a real, account-affecting Transaction alongside the LedgerEntry (not the old ledger-only
   * `addLedgerEntry`) — so a Borrowed/Gave entry shows up in the main Transactions list, Accounts,
   * Month Cycle, and Dashboard the same way an "I Gave" expense-assignment already does.
   */
  async function handleAddEntry(person: Person, params: AddEntryParams) {
    if (!actions) throw new Error("Not signed in");
    await actions.addLedgerEntryWithTransaction(
      person,
      {
        type: params.type,
        amount: params.amount,
        date: params.date,
        note: params.note,
        receivedStatus: "yetToReceive",
      },
      params.accountId,
    );
  }

  async function handleSettleEntry(person: Person, params: SettleEntryParams) {
    if (!actions) throw new Error("Not signed in");
    await actions.addLedgerEntryWithTransaction(
      person,
      {
        type: params.type,
        amount: params.amount,
        date: params.date,
        receivedStatus: "received",
        parentEntryId: params.parentEntryId,
        sourceKind: params.sourceKind,
        obligationRef: params.obligationRef,
      },
      params.accountId,
    );
  }

  async function handleEditEntry(
    person: Person,
    entry: LedgerEntry,
    patch: EntryEditValues,
  ) {
    if (!actions) throw new Error("Not signed in");
    await actions.editLedgerEntry(person, entry, patch);
  }

  /** Entries come from `planEntryDeletion`/`planBulkDeletion`; each is reversed out of the balance as it is soft-deleted. */
  async function handleDeleteEntries(person: Person, entries: LedgerEntry[]) {
    if (!actions) throw new Error("Not signed in");
    await actions.deleteLedgerEntries(person, entries);
  }

  /** One row per person for the selected cycle — the person's own statement, never a re-sum. */
  const ledgerRows = useMemo<PeopleLedgerRow[]>(
    () =>
      (rawPeople as Person[])
        .filter((p) => statementsByPersonId[p.id])
        .map((p) => ({
          id: p.id,
          name: p.name,
          statement: statementsByPersonId[p.id],
        }))
        .sort(byPosition),
    [rawPeople, statementsByPersonId],
  );

  const searched = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q
      ? ledgerRows.filter((r) => r.name.toLowerCase().includes(q))
      : ledgerRows;
  }, [ledgerRows, search]);

  const counts = useMemo<Record<PeopleFilter, number>>(
    () => ({
      all: searched.length,
      theyOwe: searched.filter((r) => r.statement.direction === "theyOwe")
        .length,
      iOwe: searched.filter((r) => r.statement.direction === "iOwe").length,
      settled: searched.filter((r) => r.statement.direction === "settled")
        .length,
    }),
    [searched],
  );

  const visible =
    filter === "all"
      ? searched
      : searched.filter((r) => r.statement.direction === filter);

  const selected = selectedId
    ? people.find((p) => p.id === selectedId)
    : undefined;
  const selectedRaw = selected
    ? (rawPeople.find((p) => p.id === selected.id) ?? null)
    : null;

  const deleteDialog = (
        <ConfirmDialog
          open={deletingPerson != null}
          onOpenChange={(open) => !open && setDeletingPerson(null)}
          title={`Delete ${deletingPerson?.name ?? "person"}?`}
          description="This permanently removes this person and their entire ledger history. This action cannot be undone."
          variant="destructive"
          confirmLabel="Delete"
          onConfirm={handleDeletePerson}
        />
  );

  // Detail state: the person replaces the list inside the same workspace (a person still loading shows a skeleton, not the list).
  if (selectedId != null && (selected || peopleLoading)) {
    return (
      <div className="flex min-w-0 flex-col pb-10">
        {selected ? (
            <PersonDetailWorkspace
              person={selected}
              rawPerson={selectedRaw}
              key={selected.id}
              initialCycle={cycle}
              initialView={returnLedgerPersonId === selected.id ? "ledger" : null}
              onBack={closePerson}
              onAddEntry={async (params) => {
                if (!selectedRaw) throw new Error("Person not found");
                await handleAddEntry(selectedRaw, params);
              }}
              onSettleEntry={async (params) => {
                if (!selectedRaw) throw new Error("Person not found");
                await handleSettleEntry(selectedRaw, params);
              }}
              onEditEntry={async (entry, patch) => {
                if (!selectedRaw) throw new Error("Person not found");
                await handleEditEntry(selectedRaw, entry, patch);
              }}
              onDeleteEntries={async (entries) => {
                if (!selectedRaw) throw new Error("Person not found");
                await handleDeleteEntries(selectedRaw, entries);
              }}
              onUndoSplitReceived={async ({ expense, participant }) => {
                if (!actions) throw new Error("Not signed in");
                await actions.setParticipantReceivedStatus(
                  expense,
                  participant,
                  "yetToReceive",
                );
              }}
              onRecordPayment={async (input, paymentId) => {
                if (!selectedRaw || !actions) throw new Error("Not signed in");
                if (paymentId) await actions.editPersonPayment(selectedRaw, paymentId, input);
                else await actions.recordPersonPayment(selectedRaw, input);
              }}
              onApplyAdvance={async (params) => {
                if (!selectedRaw || !actions) throw new Error("Not signed in");
                await actions.applyPersonAdvance(selectedRaw, params);
              }}
              onRevertPayment={async (paymentId) => {
                if (!selectedRaw || !actions) throw new Error("Not signed in");
                await actions.revertPersonPayment(selectedRaw, paymentId);
              }}
              onRemoveAdvanceApplications={async (applications) => {
                if (!selectedRaw || !actions) throw new Error("Not signed in");
                await actions.removePersonAdvanceApplications(selectedRaw, applications);
              }}
              onEditPerson={async (patch) => {
                if (!selectedRaw) throw new Error("Person not found");
                await handleEditPerson(selectedRaw, patch);
              }}
              onDelete={() => {
                if (selectedRaw) setDeletingPerson(selectedRaw);
              }}
            />
        ) : (
          <div className="flex flex-col gap-3 px-1">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-11 w-64" />
            <Skeleton className="mt-4 h-24 w-full max-w-xl" />
          </div>
        )}
        {deleteDialog}
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-5 px-1 pb-10">
      <div className="flex flex-col">
        <header className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <h1 className="font-heading text-2xl font-bold tracking-tight text-foreground">
              People Ledger
            </h1>
            <p className="text-sm text-muted-foreground">
              Money between you and the people in your life.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setAddPersonOpen(!addPersonOpen)}
            disabled={!actions}
            aria-expanded={addPersonOpen}
            className={cn(addPersonOpen ? WS_SECONDARY : WS_PRIMARY, "shrink-0 px-4")}
          >
            {addPersonOpen ? (
              <X className="size-4" strokeWidth={2} />
            ) : (
              <UserPlus className="size-4" strokeWidth={2} />
            )}
            {addPersonOpen ? "Close" : "Add Person"}
          </button>
        </header>

        <AddPersonInline
          open={addPersonOpen}
          formKey={addPersonKey}
          onCancel={() => setAddPersonOpen(false)}
          onSubmit={handleAddPerson}
        />
      </div>

      <PeopleCycleControl
        cycle={cycle}
        onCycleChange={setCycle}
        direction={cycleDirection}
      />

      {isLoading ? (
        <>
          <PeopleCycleSummarySkeleton />
          <section className={cn(LE_RADIUS.panel, "border border-border bg-card")}>
            <PeopleLedgerListSkeleton />
          </section>
        </>
      ) : ledgerRows.length === 0 ? (
        <section className={cn(LE_RADIUS.panel, "flex flex-col items-center gap-4 border border-dashed border-border bg-card px-6 py-12 text-center")}>
          <span className="flex size-11 items-center justify-center rounded-full bg-secondary text-muted-foreground">
            <Users className="size-5" strokeWidth={1.75} />
          </span>
          <div>
            <p className="font-heading text-base font-semibold text-foreground">
              No people yet
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              Add someone to start tracking money between you.
            </p>
          </div>
          {!addPersonOpen && (
            <button
              type="button"
              onClick={() => setAddPersonOpen(true)}
              disabled={!actions}
              className={WS_PRIMARY}
            >
              <Plus className="size-4" strokeWidth={2} />
              Add Person
            </button>
          )}
        </section>
      ) : (
        // Keyed by cycle: the summary and list for one cycle are never shown under another's label.
        <div
          key={cycle.start.getTime()}
          className="flex animate-in flex-col gap-5 fade-in duration-200"
        >
          <PeopleCycleSummary rows={ledgerRows} />
          <PeopleAttention onOpenPerson={openPerson} />

          <section aria-label="People" className="flex flex-col gap-3">
            <PeopleListToolbar
              search={search}
              onSearchChange={setSearch}
              filter={filter}
              onFilterChange={setFilter}
              counts={counts}
            />
            <div className={cn(LE_RADIUS.panel, "overflow-hidden border border-border bg-card shadow-e1")}>
              {visible.length === 0 ? (
                <div className="px-6 py-12 text-center">
                  <p className="text-sm font-semibold text-foreground">
                    {search.trim()
                      ? "No one matches that search"
                      : "No one in this group for this cycle"}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {search.trim()
                      ? "Try a different name."
                      : "Everyone is still listed under All — or pick another cycle."}
                  </p>
                </div>
              ) : (
                <PeopleLedgerList rows={visible} onOpen={openPerson} />
              )}
            </div>
            <p className="px-1 text-xs text-muted-foreground">
              Open a person to add, settle, split or share their statement for this cycle.
            </p>
          </section>
        </div>
      )}

      {deleteDialog}
    </div>
  );
}

/** The app shell's scrolling `<main>` — the page scrolls there, not on the window. */
function scroller(): HTMLElement | null {
  return typeof document === "undefined" ? null : document.querySelector("main");
}
