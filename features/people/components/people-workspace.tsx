"use client";

import { useMemo, useState } from "react";
import { Contact, IndianRupee, StickyNote, User, Users } from "lucide-react";
import { ConfirmDialog, FLAT_INPUT, FormDialog, SectionedFormDialog, SectionLabel } from "@/components/finance";
import { EmptyState } from "@/components/finance/empty-state";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { PeopleGrid } from "@/features/people/components/people-grid";
import { PeopleHeader } from "@/features/people/components/people-header";
import { PeopleStats } from "@/features/people/components/people-stats";
import { PeopleTable } from "@/features/people/components/people-table";
import { type PeopleTab, PeopleToolbar } from "@/features/people/components/people-toolbar";
import { PersonOverviewPanel } from "@/features/people/components/person-overview-panel";
import { RecentPeopleTransactions } from "@/features/people/components/recent-people-transactions";
import { usePeopleActions, usePeopleRows } from "@/features/people/hooks/use-people-data";
import { usePeople } from "@/hooks/use-people";
import type { LedgerEntryType, Person } from "@/lib/models/person";
import { cn } from "@/lib/utils";
import { toast } from "@/store/toast-store";

const LEDGER_ENTRY_TYPE_OPTIONS: { value: LedgerEntryType; label: string }[] = [
  { value: "gave", label: "I gave money (they owe me)" },
  { value: "borrowed", label: "I borrowed money (I owe them)" },
  { value: "repaid", label: "I paid them back" },
  { value: "receivedBack", label: "They paid me back" },
];

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

function personFormFromPerson(person: Person): PersonFormState {
  return {
    name: person.name,
    phone: person.phone ?? "",
    email: person.email ?? "",
    openingBalance: String(person.openingBalance),
    notes: person.notes,
  };
}

interface LedgerEntryFormState {
  type: LedgerEntryType;
  amount: string;
  date: string;
  note: string;
}

function emptyLedgerEntryForm(): LedgerEntryFormState {
  return { type: "gave", amount: "", date: new Date().toISOString().slice(0, 10), note: "" };
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
  const [overviewOpen, setOverviewOpen] = useState(true);

  const [addPersonOpen, setAddPersonOpen] = useState(false);
  const [editingPerson, setEditingPerson] = useState<Person | null>(null);
  const [deletingPerson, setDeletingPerson] = useState<Person | null>(null);
  const [addEntryPerson, setAddEntryPerson] = useState<Person | null>(null);
  const [personForm, setPersonForm] = useState<PersonFormState>(emptyPersonForm);
  const [personFormError, setPersonFormError] = useState<string | null>(null);
  const [entryForm, setEntryForm] = useState<LedgerEntryFormState>(emptyLedgerEntryForm);
  const [entryFormError, setEntryFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function openAddPerson() {
    setPersonForm(emptyPersonForm());
    setPersonFormError(null);
    setAddPersonOpen(true);
  }

  function openEditPerson(person: Person) {
    setPersonForm(personFormFromPerson(person));
    setPersonFormError(null);
    setEditingPerson(person);
  }

  function openAddEntry(person: Person) {
    setEntryForm(emptyLedgerEntryForm());
    setEntryFormError(null);
    setAddEntryPerson(person);
  }

  async function handleSavePerson() {
    if (!actions) return;
    const name = personForm.name.trim();
    if (!name) {
      setPersonFormError("Name is required.");
      return;
    }
    const openingBalance = editingPerson ? 0 : Number(personForm.openingBalance || "0");
    if (!editingPerson && !Number.isFinite(openingBalance)) {
      setPersonFormError("Opening balance must be a number.");
      return;
    }

    setSaving(true);
    setPersonFormError(null);
    try {
      if (editingPerson) {
        await actions.editPerson(editingPerson, {
          name,
          phone: personForm.phone || null,
          email: personForm.email || null,
          notes: personForm.notes,
        });
        setEditingPerson(null);
      } else {
        await actions.createPerson({
          name,
          avatarColorValue: 0,
          openingBalance,
          phone: personForm.phone || null,
          email: personForm.email || null,
          notes: personForm.notes,
        });
        setAddPersonOpen(false);
      }
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

  async function handleAddEntry() {
    if (!actions || !addEntryPerson) return;
    const amount = Number(entryForm.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setEntryFormError("Amount must be greater than 0.");
      return;
    }

    setSaving(true);
    setEntryFormError(null);
    try {
      await actions.addLedgerEntry(addEntryPerson, {
        type: entryForm.type,
        amount,
        date: new Date(entryForm.date),
        note: entryForm.note || undefined,
      });
      setAddEntryPerson(null);
    } catch (e) {
      setEntryFormError(e instanceof Error ? e.message : "Something went wrong. Please try again.");
    } finally {
      setSaving(false);
    }
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

  const selected = people.find((p) => p.id === selectedId) ?? people[0];

  function selectPerson(id: string) {
    setSelectedId(id);
    setOverviewOpen(true);
  }

  function changeTab(next: PeopleTab) {
    setTab(next);
    setPage(1);
  }

  return (
    <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
      <div className="flex min-w-0 flex-1 flex-col gap-6">
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

        <RecentPeopleTransactions />
      </div>

      {overviewOpen && selected && (
        <PersonOverviewPanel
          person={selected}
          onClose={() => setOverviewOpen(false)}
          onAddTransaction={() => {
            const raw = rawPeople.find((p) => p.id === selected.id);
            if (raw) openAddEntry(raw);
          }}
          onEdit={() => {
            const raw = rawPeople.find((p) => p.id === selected.id);
            if (raw) openEditPerson(raw);
          }}
          onDelete={() => {
            const raw = rawPeople.find((p) => p.id === selected.id);
            if (raw) setDeletingPerson(raw);
          }}
        />
      )}

      <SectionedFormDialog
        open={addPersonOpen || editingPerson != null}
        onOpenChange={(open) => {
          if (!open) {
            setAddPersonOpen(false);
            setEditingPerson(null);
          }
        }}
        title={editingPerson ? `Edit ${editingPerson.name}` : "Add a Person"}
        description={editingPerson ? undefined : "Someone you lend to or borrow from — start tracking a running ledger."}
        onConfirm={handleSavePerson}
        confirmLabel={saving ? "Saving…" : editingPerson ? "Save Changes" : "Add Person"}
        loading={saving}
        contentClassName="sm:max-w-xl"
      >
        <div className="flex flex-col gap-3 bg-muted/30 p-4">
          <SectionLabel icon={Contact}>Contact Details</SectionLabel>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Name</span>
            <div className="relative">
              <User className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <input
                className={cn(FLAT_INPUT, "pl-9")}
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
                className={FLAT_INPUT}
                value={personForm.phone}
                onChange={(e) => setPersonForm((f) => ({ ...f, phone: e.target.value }))}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Email (optional)</span>
              <input
                type="email"
                className={FLAT_INPUT}
                value={personForm.email}
                onChange={(e) => setPersonForm((f) => ({ ...f, email: e.target.value }))}
              />
            </label>
          </div>
        </div>

        {!editingPerson && (
          <div className="mt-5 flex flex-col gap-1 bg-muted/30 p-4">
            <SectionLabel icon={IndianRupee}>Opening Balance</SectionLabel>
            <div className="relative mt-2">
              <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm font-semibold text-primary">₹</span>
              <input
                type="number"
                className={cn(FLAT_INPUT, "border-primary/30 bg-primary/5 pl-7 text-base font-semibold focus:border-primary")}
                placeholder="0.00"
                value={personForm.openingBalance}
                onChange={(e) => setPersonForm((f) => ({ ...f, openingBalance: e.target.value }))}
              />
            </div>
            <span className="mt-1 text-xs text-muted-foreground">Positive if they owe you, negative if you owe them.</span>
          </div>
        )}

        <div className="mt-5 flex flex-col gap-1 bg-muted/30 p-4">
          <SectionLabel icon={StickyNote}>Notes (optional)</SectionLabel>
          <textarea
            className={cn(FLAT_INPUT, "min-h-20 resize-none py-2")}
            rows={3}
            value={personForm.notes}
            onChange={(e) => setPersonForm((f) => ({ ...f, notes: e.target.value }))}
          />
        </div>

        {personFormError && (
          <p className="flex items-center gap-1.5 border border-expense/30 bg-expense/8 px-3 py-2 text-xs font-medium text-expense">
            {personFormError}
          </p>
        )}
      </SectionedFormDialog>

      <FormDialog
        open={addEntryPerson != null}
        onOpenChange={(open) => !open && setAddEntryPerson(null)}
        title={`Add Transaction — ${addEntryPerson?.name ?? ""}`}
        onConfirm={handleAddEntry}
        confirmLabel={saving ? "Saving…" : "Save"}
        contentClassName="sm:max-w-lg"
      >
        <div className="flex flex-col gap-3 rounded-2xl bg-muted/30 p-4 text-sm">
          <SectionLabel icon={IndianRupee}>Transaction Details</SectionLabel>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Type</span>
            <Select value={entryForm.type} onValueChange={(v) => setEntryForm((f) => ({ ...f, type: v as LedgerEntryType }))}>
              <SelectTrigger className="h-10 w-full rounded-xl">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LEDGER_ENTRY_TYPE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Amount</span>
              <div className="relative">
                <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm font-semibold text-primary">₹</span>
                <input
                  type="number"
                  className="clay-pressed h-10 w-full rounded-xl border border-primary/20 bg-primary/5 pl-7 text-sm font-semibold outline-none"
                  placeholder="0.00"
                  value={entryForm.amount}
                  onChange={(e) => setEntryForm((f) => ({ ...f, amount: e.target.value }))}
                />
              </div>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Date</span>
              <input
                type="date"
                className="clay-pressed h-10 rounded-xl px-3 text-sm outline-none"
                value={entryForm.date}
                onChange={(e) => setEntryForm((f) => ({ ...f, date: e.target.value }))}
              />
            </label>
          </div>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Note (optional)</span>
            <input
              className="clay-pressed h-10 rounded-xl px-3 text-sm outline-none"
              value={entryForm.note}
              onChange={(e) => setEntryForm((f) => ({ ...f, note: e.target.value }))}
            />
          </label>
          {entryFormError && <p className="text-xs text-expense">{entryFormError}</p>}
        </div>
      </FormDialog>

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
