"use client";

import { useMemo, useState } from "react";
import { Contact, IndianRupee, User, Users } from "lucide-react";
import { ConfirmDialog, FLAT_INPUT, SectionedFormDialog, SectionLabel } from "@/components/finance";
import { EmptyState } from "@/components/finance/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { PeopleGrid } from "@/features/people/components/people-grid";
import { PeopleHeader } from "@/features/people/components/people-header";
import { PeopleStats } from "@/features/people/components/people-stats";
import { PeopleTable } from "@/features/people/components/people-table";
import { type PeopleTab, PeopleToolbar } from "@/features/people/components/people-toolbar";
import { PersonOverviewPanel } from "@/features/people/components/person-overview-panel";
import type { AddEntryParams } from "@/features/people/components/workspace/add-entry-mode";
import type { EditPersonPatch } from "@/features/people/components/workspace/edit-person-mode";
import type { SettleEntryParams } from "@/features/people/components/workspace/settle-entry-mode";
import { usePeopleActions, usePeopleRows } from "@/features/people/hooks/use-people-data";
import { usePeople } from "@/hooks/use-people";
import type { Person } from "@/lib/models/person";
import { cn } from "@/lib/utils";
import { toast } from "@/store/toast-store";

interface PersonFormState {
  name: string;
  phone: string;
  email: string;
  openingBalance: string;
  notes: string;
}

function emptyPersonForm(): PersonFormState {
  return { name: "", phone: "", email: "", openingBalance: "0", notes: "" };
}

function PeopleListSkeleton() {
  return (
    <div className="surface-flat flex flex-col gap-3 rounded-2xl border border-border/50 p-5">
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="size-8 shrink-0 rounded-full" />
          <Skeleton className="h-4 w-40" />
          <Skeleton className="ml-auto h-4 w-24" />
        </div>
      ))}
    </div>
  );
}

export function PeopleWorkspace() {
  const { rows: people, isLoading } = usePeopleRows();
  const { data: rawPeople = [] } = usePeople();
  const actions = usePeopleActions();

  const [tab, setTab] = useState<PeopleTab>("all");
  const [search, setSearch] = useState("");
  const [view, setView] = useState<"list" | "grid">("list");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(8);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [addPersonOpen, setAddPersonOpen] = useState(false);
  const [deletingPerson, setDeletingPerson] = useState<Person | null>(null);
  const [personForm, setPersonForm] = useState<PersonFormState>(emptyPersonForm);
  const [personFormError, setPersonFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function openAddPerson() {
    setPersonForm(emptyPersonForm());
    setPersonFormError(null);
    setAddPersonOpen(true);
  }

  async function handleSavePerson() {
    if (!actions) return;
    const name = personForm.name.trim();
    if (!name) {
      setPersonFormError("Name is required.");
      return;
    }
    const openingBalance = Number(personForm.openingBalance || "0");
    if (!Number.isFinite(openingBalance)) {
      setPersonFormError("Opening balance must be a number.");
      return;
    }

    setSaving(true);
    setPersonFormError(null);
    try {
      await actions.createPerson({
        name,
        avatarColorValue: 0,
        openingBalance,
        phone: personForm.phone || null,
        email: personForm.email || null,
        notes: personForm.notes,
      });
      setAddPersonOpen(false);
    } catch (e) {
      setPersonFormError(e instanceof Error ? e.message : "Something went wrong. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDeletePerson() {
    if (!actions || !deletingPerson) return;
    try {
      await actions.deletePerson(deletingPerson);
      if (selectedId === deletingPerson.id) setSelectedId(null);
      setDeletingPerson(null);
    } catch (e) {
      toast.error("Couldn't delete person", e instanceof Error ? e.message : "Please try again.");
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
      },
      params.accountId,
    );
  }

  const counts = useMemo(
    () => ({
      all: people.length,
      owed: people.filter((p) => p.youAreOwed > p.youOwe).length,
      owe: people.filter((p) => p.youOwe > p.youAreOwed).length,
      settled: people.filter((p) => p.status === "settled").length,
    }),
    [people],
  );

  const filtered = useMemo(() => {
    return people.filter((person) => {
      const matchesSearch =
        person.name.toLowerCase().includes(search.toLowerCase()) ||
        person.relationship.toLowerCase().includes(search.toLowerCase());
      const matchesTab =
        tab === "all" ||
        (tab === "owed" && person.youAreOwed > person.youOwe) ||
        (tab === "owe" && person.youOwe > person.youAreOwed) ||
        (tab === "settled" && person.status === "settled");
      return matchesSearch && matchesTab;
    });
  }, [people, search, tab]);

  const paged = useMemo(() => filtered.slice((page - 1) * pageSize, page * pageSize), [filtered, page, pageSize]);

  const selected = selectedId ? people.find((p) => p.id === selectedId) : undefined;
  const selectedRaw = selected ? (rawPeople.find((p) => p.id === selected.id) ?? null) : null;

  function selectPerson(id: string) {
    setSelectedId(id);
  }

  function changeTab(next: PeopleTab) {
    setTab(next);
    setPage(1);
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex min-w-0 flex-col gap-6">
        <PeopleHeader onAddPerson={openAddPerson} />
        <PeopleStats />

        <div className="flex flex-col gap-4">
          <PeopleToolbar
            tab={tab}
            onTabChange={changeTab}
            counts={counts}
            search={search}
            onSearchChange={(v) => {
              setSearch(v);
              setPage(1);
            }}
            view={view}
            onViewChange={setView}
          />

          {isLoading ? (
            <PeopleListSkeleton />
          ) : people.length === 0 ? (
            <div className="surface-flat rounded-2xl border border-border/50">
              <EmptyState
                icon={Users}
                title="No people yet"
                description="Add someone you lend to or borrow from to start tracking a running ledger."
                actionLabel="Add Person"
                onAction={openAddPerson}
              />
            </div>
          ) : filtered.length === 0 ? (
            <div className="surface-flat rounded-2xl border border-border/50">
              <EmptyState icon={Users} title="No matching people" description="Try a different search or tab." />
            </div>
          ) : view === "list" ? (
            <PeopleTable
              people={paged}
              selectedId={selected?.id ?? ""}
              onSelect={selectPerson}
              page={page}
              pageSize={pageSize}
              totalCount={filtered.length}
              onPageChange={setPage}
              onPageSizeChange={(size) => {
                setPageSize(size);
                setPage(1);
              }}
            />
          ) : (
            <PeopleGrid people={filtered} selectedId={selected?.id ?? ""} onSelect={selectPerson} />
          )}
        </div>
      </div>

      {selected && (
        <PersonOverviewPanel
          person={selected}
          rawPerson={selectedRaw}
          open
          onClose={() => setSelectedId(null)}
          onAddEntry={async (params) => {
            if (!selectedRaw) throw new Error("Person not found");
            await handleAddEntry(selectedRaw, params);
          }}
          onSettleEntry={async (params) => {
            if (!selectedRaw) throw new Error("Person not found");
            await handleSettleEntry(selectedRaw, params);
          }}
          onEditPerson={async (patch) => {
            if (!selectedRaw) throw new Error("Person not found");
            await handleEditPerson(selectedRaw, patch);
          }}
          onDelete={() => {
            if (selectedRaw) setDeletingPerson(selectedRaw);
          }}
        />
      )}

      <SectionedFormDialog
        open={addPersonOpen}
        onOpenChange={(open) => {
          if (!open) setAddPersonOpen(false);
        }}
        title="Add a Person"
        description="Someone you lend to or borrow from — start tracking a running ledger."
        onConfirm={handleSavePerson}
        confirmLabel={saving ? "Saving…" : "Add Person"}
        loading={saving}
        contentClassName="sm:max-w-md rounded-3xl [&_.rounded-none]:rounded-full"
      >
        <div className="flex flex-col gap-3 rounded-2xl bg-muted/30 p-4">
          <SectionLabel icon={Contact}>Contact Details</SectionLabel>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Name</span>
            <div className="relative">
              <User className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <input
                className={cn(FLAT_INPUT, "rounded-xl pl-9")}
                placeholder="e.g. Priya Sharma"
                value={personForm.name}
                onChange={(e) => setPersonForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>
          </label>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Phone (optional)</span>
              <input
                className={cn(FLAT_INPUT, "rounded-xl")}
                value={personForm.phone}
                onChange={(e) => setPersonForm((f) => ({ ...f, phone: e.target.value }))}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Email (optional)</span>
              <input
                type="email"
                className={cn(FLAT_INPUT, "rounded-xl")}
                value={personForm.email}
                onChange={(e) => setPersonForm((f) => ({ ...f, email: e.target.value }))}
              />
            </label>
          </div>
        </div>

        <div className="mt-5 flex flex-col gap-1 rounded-2xl bg-muted/30 p-4">
          <SectionLabel icon={IndianRupee}>Opening Balance</SectionLabel>
          <div className="relative mt-2">
            <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm font-semibold text-primary-accent-text">₹</span>
            <input
              type="number"
              className={cn(FLAT_INPUT, "rounded-xl border-primary/30 bg-primary/5 pl-7 text-base font-semibold focus:border-primary")}
              placeholder="0.00"
              value={personForm.openingBalance}
              onChange={(e) => setPersonForm((f) => ({ ...f, openingBalance: e.target.value }))}
            />
          </div>
          <span className="mt-1 text-xs text-muted-foreground">Positive if they owe you, negative if you owe them.</span>
        </div>

        {personFormError && (
          <p className="flex items-center gap-1.5 rounded-xl border border-expense/30 bg-expense/8 px-3 py-2 text-xs font-medium text-expense">
            {personFormError}
          </p>
        )}
      </SectionedFormDialog>

      <ConfirmDialog
        open={deletingPerson != null}
        onOpenChange={(open) => !open && setDeletingPerson(null)}
        title={`Delete ${deletingPerson?.name ?? "person"}?`}
        description="This permanently removes this person and their entire ledger history. This action cannot be undone."
        variant="destructive"
        confirmLabel="Delete"
        onConfirm={handleDeletePerson}
      />
    </div>
  );
}
