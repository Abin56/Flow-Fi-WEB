"use client";

import { ArrowLeft, Bell, Calendar, ChevronDown, HandCoins, ListX, Mail, MoreHorizontal, Paperclip, Pencil, Phone, Plus, Share2, Split, StickyNote, Trash2, Users } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { ClayAvatar } from "@/components/clay/clay-avatar";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useAccounts } from "@/hooks/use-accounts";
import { useCategories } from "@/hooks/use-categories";
import { usePeople } from "@/hooks/use-people";
import { formatCurrency } from "@/lib/format";
import { cycleContaining, formatStatementDate, type StatementCycle } from "@/lib/engines/person-cycle-statement";
import { money } from "@/lib/engines/person-cycle-statement-share";
import { planBulkDeletion, planEntryDeletion, type BulkDeletionPlan, type EntryDeletionPlan } from "@/lib/engines/person-ledger-deletion";
import type { LedgerEntry, Person } from "@/lib/models/person";
import type { PersonViewRow } from "@/features/people/hooks/use-people-data";
import { usePersonCycleStatement } from "@/features/people/hooks/use-person-cycle-statement";
import { usePersonPendingSplitParticipants } from "@/features/people/hooks/use-person-pending-split-participants";
import { usePersonUpcomingEmi } from "@/features/people/hooks/use-person-upcoming-emi";import { buildLedgerRows, cycleShowingNewEntry, type LedgerRow, type PaymentRecord } from "@/features/people/lib/person-ledger-rows";
import type { PendingSplitParticipant } from "@/lib/engines/person-pending-split-participants";
import { useTransactionActions } from "@/features/transactions/hooks/use-transactions-data";
import { PersonCycleStatementSection } from "@/features/people/components/cycle-statement/person-cycle-statement-section";
import { PersonActivityFeed, type LedgerRowHandlers, type LedgerScope } from "@/features/people/components/person-activity-feed";
import { AddEntryPanel, type AddEntryParams } from "@/features/people/components/workspace/add-entry-panel";
import { EditPersonMode, type EditPersonPatch } from "@/features/people/components/workspace/edit-person-mode";
import { InlineReveal, LedgerConfirmDialog, type EntryEditValues, type EntrySettleValues } from "@/features/people/components/workspace/ledger-ui";
import { LE_RADIUS } from "@/features/loans/components/loan-emi-ui";
import { WS_PRIMARY, WS_SECONDARY, WsLabel } from "@/features/people/components/workspace/person-workspace-ui";
import { SettleUpPanel } from "@/features/people/components/workspace/settle-up-panel";
import { ShareStatementMode } from "@/features/people/components/workspace/share-statement-mode";
import { SplitExpenseMode } from "@/features/people/components/workspace/split-expense-mode";
import { TransactionLedgerMode, type LedgerView } from "@/features/people/components/workspace/transaction-ledger-mode";
import { cn } from "@/lib/utils";
import { toast } from "@/store/toast-store";

/** Settles one manual "gave"/"borrowed" entry — a "repaid"/"receivedBack" entry with `parentEntryId` set. */
export interface SettleEntryParams {
  type: "repaid" | "receivedBack";
  amount: number;
  date: Date;
  parentEntryId: string;
  /** The account the settlement's cash leg posts to. */
  accountId: string;
}

/** The workspace's internal modes — the shell (header) stays put; only the content area changes. */
type Mode = { kind: "overview" } | { kind: "split" } | { kind: "share" } | { kind: "edit" } | { kind: "ledger" };

/** Add, Settle and Split expand inline in the overview (Add also in the expanded ledger) — one at a time. */
type InlineAction = "add" | "settle" | "split" | null;


/** Loan events ride in `person.activity` as `loan:`/`loan-txn:` items — listed under "All transactions". */
const isLoanItem = (id: string) => id.startsWith("loan:") || id.startsWith("loan-txn:");


const ICON_BUTTON =
  "flex size-8 shrink-0 items-center justify-center rounded-[6px] text-muted-foreground outline-none transition-colors hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-secondary data-[state=open]:text-foreground";

/** Navigation, not a CTA: a tinted neutral chip with a firm border and full-contrast text + arrow. */
const BACK_BUTTON =
  "flex h-8 shrink-0 items-center gap-2 rounded-[6px] border border-border-strong bg-secondary pr-3 pl-2.5 text-sm font-semibold text-foreground outline-none transition-colors hover:border-foreground/40 hover:bg-border/50 focus-visible:ring-2 focus-visible:ring-ring [&_svg]:text-foreground";

const HEADER_BUTTON =
  "flex h-8 shrink-0 items-center gap-1.5 rounded-[6px] border border-border-strong bg-card px-2.5 text-sm font-medium text-foreground outline-none transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring [&_svg]:text-muted-foreground";

/** A compact secondary Person action — quieter than Add, the same 32px height as the ledger's controls. */
const ACTION_SECONDARY = cn(WS_SECONDARY, "h-8 gap-1.5 px-2.5 text-[13px] [&>svg]:text-muted-foreground");

function DetailRow({ icon: Icon, label, children }: { icon: typeof Calendar; label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2 text-sm">
      <span className="flex shrink-0 items-center gap-2 text-muted-foreground">
        <Icon className="size-4" strokeWidth={1.75} />
        {label}
      </span>
      <span className="min-w-0 text-right font-medium break-words text-foreground">{children}</span>
    </div>
  );
}

function SectionTitle({ icon: Icon, children }: { icon?: typeof Calendar; children: React.ReactNode }) {
  return (
    <WsLabel>
      <span className="inline-flex items-center gap-1.5">
        {Icon && <Icon className="size-3.5" strokeWidth={1.75} />}
        {children}
      </span>
    </WsLabel>
  );
}

/**
 * The Person detail workspace — a full page inside the People Ledger (no dialog, no drawer). A fixed
 * breadcrumb + identity header sits above one mode at a time: the overview (position, cycle, actions,
 * Activity with Details beside it) where Add and Settle expand inline, or Split, Share, Edit and the
 * expanded transaction ledger. Only a destructive delete asks for confirmation. Same data, statement
 * engine and repository calls as before.
 */
export function PersonDetailWorkspace({
  person,
  rawPerson,
  onBack,
  onAddEntry,
  onSettleEntry,
  onDeleteEntries,
  onEditEntry,
  onUndoSplitReceived,
  onEditPerson,
  onDelete,
  initialCycle,
}: {
  /** The cycle the People list was showing when this person was opened (defaults to the current one). */
  initialCycle?: StatementCycle;
  person: PersonViewRow;
  /** The stored `Person` record — Settle, Split and Edit act on it. */
  rawPerson: Person | null;
  /** Returns to the People list (the breadcrumb). */
  onBack: () => void;
  /** Records a "gave"/"borrowed" entry for this person (same payload as the old Add Transaction dialog). */
  onAddEntry?: (params: AddEntryParams) => Promise<void>;
  /** Settles one "gave"/"borrowed" entry (same payload as the old Settle Transaction dialog). */
  onSettleEntry?: (params: SettleEntryParams) => Promise<void>;
  /** Edits one manual ledger entry's amount/date/note. */
  onEditEntry?: (entry: LedgerEntry, patch: EntryEditValues) => Promise<void>;
  /** Reverses + soft-deletes ledger entries planned by `planEntryDeletion`/`planBulkDeletion`. */
  onDeleteEntries?: (entries: LedgerEntry[]) => Promise<void>;
  /** Reverses a split share's "received" status through the existing received-status toggle. */
  onUndoSplitReceived?: (pending: PendingSplitParticipant) => Promise<void>;
  onEditPerson?: (patch: EditPersonPatch) => Promise<void>;
  onDelete?: () => void;
}) {
  const [mode, setMode] = useState<Mode>({ kind: "overview" });
  const [direction, setDirection] = useState<"forward" | "back">("forward");
  const [cycle, setCycle] = useState<StatementCycle>(() => initialCycle ?? cycleContaining(new Date()));
  const [inline, setInline] = useState<InlineAction>(null);
  /** Details (contact, EMI, notes, attachments) are secondary — collapsed under Activity until asked for. */
  const [detailsOpen, setDetailsOpen] = useState(false);
  /** The expanded ledger's own navigation (Transactions ↔ Settle / Split) — kept here so Escape can step back. */
  const [ledgerView, setLedgerView] = useState<LedgerView>("transactions");
  const [scope, setScope] = useState<LedgerScope>("cycle");
  const [settlingKey, setSettlingKey] = useState<string | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  // Delete plans are frozen when a confirmation opens, so live updates (including the delete itself) never change what it says.
  const [deleting, setDeleting] = useState<{ row: LedgerRow; plan: EntryDeletionPlan | null } | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [bulkDelete, setBulkDelete] = useState<BulkDeletionPlan | null>(null);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [undoing, setUndoing] = useState<{ row: LedgerRow; payment: PaymentRecord } | null>(null);
  const [undoOpen, setUndoOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const { statement, allTimeStatement, ledgerEntries, isLoading, linkedEmis, setRepays } = usePersonCycleStatement(person.id, cycle);
  const { pending } = usePersonPendingSplitParticipants(person.id);
  const txActions = useTransactionActions();
  const { items: upcomingEmi } = usePersonUpcomingEmi(person.id);
  const { data: accounts = [] } = useAccounts();
  const { data: categories = [] } = useCategories();
  const { data: people = [] } = usePeople();
  const net = person.youAreOwed - person.youOwe;
  const firstName = person.name.split(" ")[0];
  const contact = [person.phone, person.email].filter(Boolean).join(" · ");

  // ---- Transactions: one row model for the compact list and the expanded ledger ----
  // Cycle rows read payment history from the whole-history statement, so a transaction shows every payment against it.
  const cycleRows = useMemo(
    () => buildLedgerRows({ statement, history: allTimeStatement, entries: ledgerEntries, pending }),
    [statement, allTimeStatement, ledgerEntries, pending],
  );
  const allRows = useMemo(
    () =>
      buildLedgerRows({
        statement: allTimeStatement,
        entries: ledgerEntries,
        loanItems: person.activity.filter((a) => isLoanItem(a.id)),
        pending,
      }),
    [allTimeStatement, ledgerEntries, person.activity, pending],
  );
  const scopeRows = scope === "cycle" ? cycleRows : allRows;
  const scopeCounts = { cycle: cycleRows.length, all: allRows.length };
  // The cycle view is always the cycle picked with ‹ › (shared by the statement, the list and the expanded ledger).
  const cycleLabel = "Selected cycle";
  const rowsLoading = isLoading || statement == null;
  // The selected cycle's previous pending — the engine's carried-forward balance (FlowFi sign: + they owe me).
  const carriedForward =
    statement && Math.abs(statement.previousPending) >= 0.005
      ? { amount: Math.abs(statement.previousPending), direction: statement.previousPending > 0 ? ("theyOwe" as const) : ("iOwe" as const) }
      : null;
  // Primary transactions only — a payment recorded against a transaction is its history, not another transaction.
  const primaryCount = allRows.length;
  const subline = [`${primaryCount} ${primaryCount === 1 ? "transaction" : "transactions"}`, contact].filter(Boolean).join(" · ");

  const bulkPlan = useMemo(() => planBulkDeletion(ledgerEntries), [ledgerEntries]);
  const deletingRow = deleting?.row ?? null;
  const rowPlan = deleting?.plan ?? null;
  const frozenBulk = bulkDelete ?? bulkPlan;

  const go = (next: Mode) => {
    setDirection(next.kind === "overview" ? "back" : "forward");
    setMode(next);
    setInline(null);
    setSettlingKey(null);
    setEditingKey(null);
    setLedgerView("transactions");
    rootRef.current?.scrollIntoView({ block: "start" });
  };
  const back = () => go({ kind: "overview" });
  /** Opening one inline action collapses the other; pressing the open one again collapses it. */
  const toggleInline = (next: Exclude<InlineAction, null>) => {
    setInline((current) => (current === next ? null : next));
    setSettlingKey(null);
    setEditingKey(null);
  };

  /** Add (compact or expanded): the existing `onAddEntry`, then show where the new transaction landed. */
  async function saveNewEntry(params: AddEntryParams) {
    if (!onAddEntry) throw new Error("Not signed in");
    await onAddEntry(params);
    setInline(null);
    const next = cycleShowingNewEntry(scope, cycle, params.date);
    if (next) setCycle(next);
  }

  function openBulkDelete() {
    setBulkDelete(bulkPlan);
    setBulkDeleteOpen(true);
  }

  async function settleRow(row: LedgerRow, values: EntrySettleValues) {
    const target = row.settle;
    if (!target) return;
    if (target.kind === "entry") {
      if (!onSettleEntry) throw new Error("Not signed in");
      await onSettleEntry({
        // "I borrowed X" settles by "I repaid"; "I gave X" settles by "Received back".
        type: target.entry.type === "borrowed" ? "repaid" : "receivedBack",
        amount: values.amount,
        date: values.date,
        parentEntryId: target.entry.id,
        accountId: values.accountId ?? "",
      });
    } else {
      if (!txActions) throw new Error("Not signed in");
      const { expense, participant, installment } = target.pending;
      await txActions.settleParticipant({ expense, participant, installment, amount: values.amount, date: values.date });
    }
    setSettlingKey(null);
    setEditingKey(null);
  }

  async function editRow(row: LedgerRow, values: EntryEditValues) {
    const entry = row.entryId ? ledgerEntries.find((e) => e.id === row.entryId) : undefined;
    if (!entry || !onEditEntry) throw new Error("This transaction can't be edited here.");
    await onEditEntry(entry, values);
    setEditingKey(null);
  }

  const rowHandlers: LedgerRowHandlers = {
    settlingKey,
    onSettleStart: (row) => {
      setInline(null);
      setEditingKey(null);
      setSettlingKey(row.key);
    },
    editingKey,
    onEditStart: onEditEntry
      ? (row) => {
          setInline(null);
          setSettlingKey(null);
          setEditingKey(row.key);
        }
      : undefined,
    onEditCancel: () => setEditingKey(null),
    onEditSubmit: editRow,
    onSettleCancel: () => setSettlingKey(null),
    onSettleSubmit: settleRow,
    onDelete: onDeleteEntries
      ? (row) => {
          setDeleting({ row, plan: row.entryId ? planEntryDeletion(row.entryId, ledgerEntries) : null });
          setDeleteOpen(true);
        }
      : undefined,
    onUndoPayment:
      onDeleteEntries || onUndoSplitReceived
        ? (row, payment) => {
            setUndoing({ row, payment });
            setUndoOpen(true);
          }
        : undefined,
  };

  /**
   * Undo settlement — reverses exactly one recorded payment through the path that recorded it: a
   * standalone settlement entry is reversed out of the balance and soft-deleted; a split share's
   * "received" status goes back to "yet to receive". The transaction reopens by that payment only.
   */
  async function undoPayment(payment: PaymentRecord) {
    const target = payment.undo;
    if (!target) return;
    try {
      if (target.kind === "entry") {
        if (!onDeleteEntries) throw new Error("Not signed in");
        await onDeleteEntries(target.entries);
      } else {
        if (!onUndoSplitReceived) throw new Error("Not signed in");
        await onUndoSplitReceived(target.pending);
      }
    } catch (e) {
      toast.error("Couldn't undo the settlement", e instanceof Error ? e.message : "Please try again.");
      throw e;
    }
  }

  async function deleteEntries(entries: LedgerEntry[], failure: string) {
    if (!onDeleteEntries) return;
    try {
      await onDeleteEntries(entries);
      setSettlingKey(null);
    setEditingKey(null);
    } catch (e) {
      toast.error(failure, e instanceof Error ? e.message : "Please try again.");
      throw e;
    }
  }

  const secondaryAction = (active: boolean) =>
    cn(ACTION_SECONDARY, active && "border-primary-accent-text bg-primary/10 font-semibold [&>svg]:text-foreground");

  /** The Person's actions — Add is primary; Settle, Split and Share are quieter, in one group. */
  const actionBar = (
    <div role="group" aria-label="Actions" className="flex flex-wrap items-center gap-2 lg:flex-col lg:items-stretch lg:gap-2.5">
      <button
        type="button"
        onClick={() => toggleInline("add")}
        disabled={!onAddEntry}
        aria-expanded={inline === "add"}
        aria-controls="person-inline-add"
        className={cn(WS_PRIMARY, "lg:w-full", inline === "add" && "ring-2 ring-primary-accent-text/40")}
      >
        <Plus className={cn("size-4 transition-transform duration-200", inline === "add" && "rotate-45")} strokeWidth={2.25} />
        {inline === "add" ? "Close" : "Add transaction"}
      </button>
      <div className="flex flex-wrap gap-1.5 lg:grid lg:grid-cols-3">
        <button
          type="button"
          onClick={() => toggleInline("settle")}
          disabled={!rawPerson}
          aria-expanded={inline === "settle"}
          aria-controls="person-inline-settle"
          title="Settle the overall balance"
          className={secondaryAction(inline === "settle")}
        >
          <HandCoins className="size-3.5" strokeWidth={1.75} />
          Settle
        </button>
        <button
          type="button"
          onClick={() => toggleInline("split")}
          disabled={!rawPerson}
          aria-expanded={inline === "split"}
          aria-controls="person-inline-split"
          title="Split an expense"
          className={secondaryAction(inline === "split")}
        >
          <Split className="size-3.5" strokeWidth={1.75} />
          Split
        </button>
        <button type="button" onClick={() => go({ kind: "share" })} disabled={statement == null} title="Share this cycle's statement" className={secondaryAction(false)}>
          <Share2 className="size-3.5" strokeWidth={1.75} />
          Share
        </button>
      </div>
    </div>
  );

  const loansNote = (person.loanReceivable > 0 || person.loanPayable > 0) && (
    <p className="mt-4 max-w-md text-xs leading-relaxed text-muted-foreground">
      Loans are settled from the Loan, outside this statement. Overall incl. loans {formatCurrency(Math.abs(net))}
      {net > 0 ? " owed to you" : net < 0 ? " you owe" : ""}
      {" · "}Direct balance {formatCurrency(Math.abs(person.directBalance))}
      {person.directBalance > 0 ? " owed to you" : person.directBalance < 0 ? " you owe" : ""}
      {person.loanReceivable > 0 && ` · Loans owed to you ${formatCurrency(person.loanReceivable)}`}
      {person.loanPayable > 0 && ` · Loans you owe ${formatCurrency(person.loanPayable)}`}
    </p>
  );

  const overview = (
    <div className="flex flex-col gap-5">
      <div>
        {/* Financial context — position (hero) · statement · actions, divided by rules, not boxes */}
        <div className="grid gap-x-8 gap-y-4 border-b border-border-strong/75 pb-5 lg:grid-cols-[minmax(0,1fr)_15.5rem]">
          <PersonCycleStatementSection
            statement={statement}
            isLoading={isLoading}
            cycle={cycle}
            onCycleChange={setCycle}
            linkedEmis={linkedEmis}
            setRepays={setRepays}
            footnote={loansNote}
          />
          <div className="min-w-0 lg:border-l lg:border-border-strong/75 lg:pl-7">{actionBar}</div>
        </div>
        {/* Inline actions — open as a workspace state right under the position, full width; one at a time */}
        <div id="person-inline-add">
          <InlineReveal open={inline === "add" && onAddEntry != null}>
            {onAddEntry && (
              <AddEntryPanel
                personName={person.name}
                onCancel={() => setInline(null)}
                onSave={saveNewEntry}
              />
            )}
          </InlineReveal>
        </div>
        <div id="person-inline-settle">
          <InlineReveal open={inline === "settle" && rawPerson != null}>
            {rawPerson && <SettleUpPanel person={rawPerson} onCancel={() => setInline(null)} onDone={() => setInline(null)} />}
          </InlineReveal>
        </div>
        {/* Split is the one focused popup — the person page stays underneath, unchanged */}
        <Dialog open={inline === "split" && rawPerson != null} onOpenChange={(o) => !o && setInline(null)}>
          <DialogContent
            id="person-inline-split"
            showCloseButton={false}
            className="flex max-h-[min(92vh,56rem)] flex-col gap-0 overflow-hidden rounded-[10px] border border-border bg-card p-0 shadow-[var(--shadow-e4)] ring-0 sm:max-w-5xl"
          >
            <DialogTitle className="sr-only">Split expense with {person.name}</DialogTitle>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
              {rawPerson && (
                <SplitExpenseMode
                  person={rawPerson}
                  accounts={accounts}
                  categories={categories}
                  people={people}
                  closeable
                  onBack={() => setInline(null)}
                  onDone={() => setInline(null)}
                />
              )}
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {/* Activity — the main body, full width */}
      <section aria-label="Activity" className="flex min-w-0 flex-col">
        <PersonActivityFeed
          personName={person.name}
          rows={scopeRows}
          isLoading={rowsLoading}
          scope={scope}
          onScopeChange={(next) => {
            setScope(next);
            setSettlingKey(null);
            setEditingKey(null);
          }}
          counts={scopeCounts}
          cycleLabel={cycleLabel}
          onAdd={
            onAddEntry
              ? () => {
                  setInline("add");
                  rootRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
                }
              : undefined
          }
          onExpand={() => go({ kind: "ledger" })}
          handlers={rowHandlers}
          carriedForward={carriedForward}
        />
      </section>

      {/* Details — secondary information, one line until opened */}
      <section aria-label="Details" className="-mt-1 border-b border-border-strong/75">
        <button
          type="button"
          aria-expanded={detailsOpen}
          aria-controls="person-details"
          onClick={() => setDetailsOpen((o) => !o)}
          className="flex w-full min-w-0 items-center gap-3 rounded-[6px] py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="shrink-0 text-sm font-semibold text-foreground">Details</span>
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            {[
              person.firstTransaction && `First transaction ${person.firstTransaction}`,
              upcomingEmi.length > 0 ? `${upcomingEmi.length} upcoming EMI` : "No upcoming EMI",
              person.notes ? "Notes" : null,
              contact || null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
          <ChevronDown className={cn("ml-auto size-4 shrink-0 text-muted-foreground transition-transform", detailsOpen && "rotate-180")} strokeWidth={1.75} />
        </button>
        <InlineReveal open={detailsOpen}>
          <div id="person-details" className="grid gap-x-8 gap-y-5 pt-1 pb-5 sm:grid-cols-2 xl:grid-cols-4">
            <div className="min-w-0">
              <SectionTitle icon={Users}>Person</SectionTitle>
              <div className="mt-1 divide-y divide-border-strong/60">
                <DetailRow icon={Calendar} label="First transaction">
                  {person.firstTransaction || "—"}
                </DetailRow>
                <DetailRow icon={Users} label="Relationship">
                  {person.relationship || "—"}
                </DetailRow>
                {person.phone && (
                  <DetailRow icon={Phone} label="Phone">
                    {person.phone}
                  </DetailRow>
                )}
                {person.email && (
                  <DetailRow icon={Mail} label="Email">
                    {person.email}
                  </DetailRow>
                )}
              </div>
            </div>

            <div className="min-w-0">
              <SectionTitle icon={Bell}>Upcoming EMI</SectionTitle>
              {upcomingEmi.length === 0 ? (
                <p className="mt-2 text-sm text-muted-foreground">No upcoming EMI</p>
              ) : (
                <div className="mt-1 divide-y divide-border-strong/60">
                  {upcomingEmi.slice(0, 5).map((item) => (
                    <div key={item.loanId} className="flex items-start justify-between gap-3 py-2 text-sm">
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate font-medium text-foreground">{item.label}</span>
                        <span className="text-xs text-muted-foreground">
                          Due {item.dueDate.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
                          {item.isPayerOnly && " · Pays this for you"}
                        </span>
                      </div>
                      <span className="font-semibold text-foreground tabular-nums">{formatCurrency(item.amount)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="min-w-0">
              <SectionTitle icon={StickyNote}>Notes</SectionTitle>
              {person.notes ? (
                <p className="mt-2 text-sm whitespace-pre-wrap text-foreground">{person.notes}</p>
              ) : (
                <p className="mt-2 text-sm text-muted-foreground">No notes yet.</p>
              )}
            </div>

            <div className="min-w-0">
              <SectionTitle icon={Paperclip}>Attachments</SectionTitle>
              <p className="mt-2 text-sm text-muted-foreground">No attachments yet.</p>
            </div>
          </div>
        </InlineReveal>
      </section>
    </div>
  );

  let content: React.ReactNode = overview;
  if (mode.kind === "split" && rawPerson) {
    content = <SplitExpenseMode person={rawPerson} accounts={accounts} categories={categories} people={people} onBack={back} onDone={back} />;
  } else if (mode.kind === "share" && statement) {
    content = <ShareStatementMode statement={statement} phone={person.phone} onBack={back} />;
  } else if (mode.kind === "ledger") {
    content = (
      <TransactionLedgerMode
        personName={person.name}
        rows={scopeRows}
        isLoading={rowsLoading}
        scope={scope}
        onScopeChange={(next) => {
          setScope(next);
          setSettlingKey(null);
    setEditingKey(null);
        }}
        counts={scopeCounts}
        cycle={cycle}
        onCycleChange={(next) => {
          setCycle(next);
          setSettlingKey(null);
    setEditingKey(null);
        }}
        balance={allTimeStatement ? { direction: allTimeStatement.direction, amount: allTimeStatement.amount } : null}
        onClose={back}
        handlers={rowHandlers}
        carriedForward={carriedForward}
        view={ledgerView}
        onViewChange={(next) => {
          setLedgerView(next);
          setInline(null);
          setSettlingKey(null);
    setEditingKey(null);
        }}
        addSection={
          onAddEntry ? (
            <AddEntryPanel personName={person.name} saveLabel="Add transaction" onCancel={() => setInline(null)} onSave={saveNewEntry} />
          ) : undefined
        }
        addOpen={inline === "add"}
        onAddToggle={() => {
          setInline((current) => (current === "add" ? null : "add"));
          setSettlingKey(null);
    setEditingKey(null);
        }}
        deleteAllCount={bulkPlan.entries.length}
        onDeleteAll={onDeleteEntries ? openBulkDelete : undefined}
      />
    );
  } else if (mode.kind === "edit" && rawPerson && onEditPerson) {
    content = (
      <EditPersonMode
        person={rawPerson}
        onBack={back}
        onSave={async (patch) => {
          await onEditPerson(patch);
          back();
        }}
      />
    );
  }

  const deletingTitle = deletingRow ? `“${deletingRow.title}” · ${money(deletingRow.amount)} · ${formatStatementDate(deletingRow.date, true)}` : "";
  const dependents = rowPlan?.ok ? rowPlan.dependentSettlements : [];
  const settledParent = deletingRow?.statementRow?.settles;


  /** Escape steps back out of a settle/edit row, an inline section, then a mode; a clean overview ignores it. */
  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key !== "Escape" || e.defaultPrevented || mode.kind === "ledger" || mode.kind === "share") return;
    if (settlingKey != null || editingKey != null) {
      setSettlingKey(null);
      setEditingKey(null);
    } else if (inline != null) {
      setInline(null);
    } else if (mode.kind !== "overview") {
      back();
    } else {
      return;
    }
    e.preventDefault();
  }

  return (
    <div ref={rootRef} onKeyDown={onKeyDown} className="flex min-w-0 scroll-mt-6 flex-col gap-4 px-1">
      {/* Identity — who, always visible; every mode renders below it. Navigation sits with the actions on the right. */}
      <div>
        <header className="flex items-center gap-3 border-b border-border-strong/75 pb-3.5">
          <ClayAvatar name={person.name} size={40} />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <h1 className="truncate font-heading text-2xl leading-tight font-bold tracking-tight text-foreground">{person.name}</h1>
            <p className="truncate text-sm text-muted-foreground">{subline}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button type="button" onClick={onBack} title="Back to People Ledger" className={BACK_BUTTON}>
              <ArrowLeft className="size-4" strokeWidth={2} />
              <span className="hidden sm:inline">People Ledger</span>
              <span className="sr-only sm:hidden">Back to People Ledger</span>
            </button>
            <span className="mx-1 h-5 w-px bg-border-strong/75" aria-hidden />
            {onEditPerson && rawPerson && (
              <button
                type="button"
                aria-pressed={mode.kind === "edit"}
                onClick={() => go(mode.kind === "edit" ? { kind: "overview" } : { kind: "edit" })}
                className={cn(HEADER_BUTTON, mode.kind === "edit" && "bg-secondary")}
              >
                <Pencil className="size-4" strokeWidth={1.75} />
                <span className="hidden sm:inline">Edit</span>
                <span className="sr-only sm:hidden">Edit person</span>
              </button>
            )}
            {(onDelete || onDeleteEntries) && (
              <DropdownMenu modal={false}>
                <DropdownMenuTrigger asChild>
                  <button type="button" aria-label="More actions" className={ICON_BUTTON}>
                    <MoreHorizontal className="size-4" strokeWidth={1.75} />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-48 rounded-[8px]">
                  {onDeleteEntries && (
                    <DropdownMenuItem
                      variant="destructive"
                      disabled={bulkPlan.entries.length === 0}
                      onSelect={openBulkDelete}
                    >
                      <ListX strokeWidth={1.75} />
                      Delete all transactions
                    </DropdownMenuItem>
                  )}
                  {onDeleteEntries && onDelete && <DropdownMenuSeparator />}
                  {onDelete && (
                    <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                      <Trash2 strokeWidth={1.75} />
                      Delete person
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </header>
      </div>

      {/* Mode content — slides in from the right going deeper, from the left coming back */}
      <div
        key={mode.kind === "ledger" || mode.kind === "share" ? "overview" : mode.kind}
        className={cn(
          "min-w-0 animate-in duration-200 ease-out fade-in-0",
          direction === "forward" ? "slide-in-from-right-4" : "slide-in-from-left-4",
        )}
      >
        {mode.kind === "overview" || mode.kind === "ledger" || mode.kind === "share" ? (
          overview
        ) : (
          // Focused tools (Split, Share, Edit) keep their own padded layout on one surface, at a readable width.
          <div
            className={cn(
              LE_RADIUS.panel,
              "overflow-hidden border border-border bg-card shadow-e1",
              mode.kind === "edit" ? "max-w-2xl" : "max-w-4xl",
            )}
          >
            {content}
          </div>
        )}
      </div>

      {/* Share statement — preview, WhatsApp, copy and PDF in a focused popup over the person page */}
      <Dialog open={mode.kind === "share" && statement != null} onOpenChange={(o) => !o && back()}>
        <DialogContent
          showCloseButton={false}
          className="flex max-h-[min(92vh,60rem)] flex-col gap-0 overflow-hidden rounded-[10px] border border-border bg-card p-0 shadow-[var(--shadow-e4)] ring-0 sm:max-w-4xl"
        >
          <DialogTitle className="sr-only">Share {person.name}&apos;s statement</DialogTitle>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {mode.kind === "share" && content}
          </div>
        </DialogContent>
      </Dialog>

      {/* Expanded ledger — just the transactions, in a large focused popup over the person page */}
      <Dialog open={mode.kind === "ledger"} onOpenChange={(o) => !o && back()}>
        <DialogContent
          showCloseButton={false}
          onEscapeKeyDown={(e) => {
            // Escape steps out of an open row form or ledger sub-view first; only then closes.
            if (settlingKey != null || editingKey != null || inline != null || ledgerView !== "transactions") {
              e.preventDefault();
              setSettlingKey(null);
              setEditingKey(null);
              setInline(null);
              setLedgerView("transactions");
            }
          }}
          className={cn(
            "flex flex-col gap-0 overflow-hidden border border-border bg-card p-0 shadow-[var(--shadow-e4)] ring-0",
            // Phone: full screen. Desktop: most of the viewport, fixed height so only the table scrolls.
            "top-0 left-0 h-[100dvh] max-h-[100dvh] max-w-none translate-x-0 translate-y-0 rounded-none",
            "sm:top-1/2 sm:left-1/2 sm:h-[min(94vh,68rem)] sm:max-w-[min(96vw,100rem)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-[10px]",
          )}
        >
          <DialogTitle className="sr-only">{person.name} — Transactions</DialogTitle>
          {mode.kind === "ledger" && content}
        </DialogContent>
      </Dialog>

        <LedgerConfirmDialog
          open={undoOpen}
          onOpenChange={setUndoOpen}
          variant="reverse"
          title="Undo this settlement?"
          confirmLabel="Undo settlement"
          busyLabel="Undoing…"
          disabled={undoing?.payment.undo == null}
          onConfirm={async () => {
            if (undoing) await undoPayment(undoing.payment);
          }}
        >
          {undoing && (
            <>
              <p className="font-medium text-foreground">
                {undoing.payment.direction === "youPaid" ? "Paid" : "Received"} {money(undoing.payment.amount)} ·{" "}
                {formatStatementDate(undoing.payment.date, true)} · for “{undoing.row.title}”
              </p>
              <p>
                {money(undoing.payment.amount)} will become outstanding again and the People Ledger balance will be updated —{" "}
                {undoing.row.direction === "iOwe" ? `you'll owe ${firstName}` : `${firstName} will owe you`} that amount on this transaction.
              </p>
              {undoing.row.payments.length > 1 && <p>Only this payment is reversed; the other payments on this transaction stay as they are.</p>}
            </>
          )}
        </LedgerConfirmDialog>

        <LedgerConfirmDialog
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          title="Delete this transaction?"
          confirmLabel="Delete transaction"
          busyLabel="Deleting…"
          disabled={!rowPlan?.ok}
          onConfirm={async () => {
            if (rowPlan?.ok) await deleteEntries(rowPlan.entries, "Couldn't delete transaction");
          }}
        >
          <p className="font-medium text-foreground">{deletingTitle}</p>
          {rowPlan && !rowPlan.ok ? (
            <p>This transaction is linked to another record and can&apos;t be deleted from here.</p>
          ) : (
            <>
              <p>It will be removed from your ledger with {firstName}, and your balance with them is recalculated right away.</p>
              {dependents.length > 0 && (
                <p>
                  {dependents.length === 1 ? "The settlement" : `The ${dependents.length} settlements`} recorded against it (
                  {money(dependents.reduce((s, e) => s + e.amount, 0))}) will be removed too.
                </p>
              )}
              {settledParent && <p>“{settledParent.title}” will show this amount as open again.</p>}
            </>
          )}
        </LedgerConfirmDialog>

        <LedgerConfirmDialog
          open={bulkDeleteOpen}
          onOpenChange={setBulkDeleteOpen}
          title={`Delete all transactions with ${firstName}?`}
          confirmLabel="Delete all"
          busyLabel="Deleting…"
          disabled={frozenBulk.entries.length === 0}
          onConfirm={() => deleteEntries(frozenBulk.entries, "Couldn't delete transactions")}
        >
          <p>
            <span className="font-heading text-base font-semibold text-foreground tabular-nums">
              {frozenBulk.entries.length} {frozenBulk.entries.length === 1 ? "transaction" : "transactions"}
            </span>{" "}
            will be removed and the resulting People Ledger balance will be recalculated.
          </p>
          {frozenBulk.keptLinked.length > 0 && (
            <p>
              {frozenBulk.keptLinked.length} split-expense {frozenBulk.keptLinked.length === 1 ? "entry stays" : "entries stay"} — they belong to their
              expense and are changed from there.
            </p>
          )}
          {rawPerson && Math.abs(rawPerson.openingBalance) >= 0.005 && <p>The opening balance of {money(Math.abs(rawPerson.openingBalance))} stays.</p>}
        </LedgerConfirmDialog>
    </div>
  );
}
