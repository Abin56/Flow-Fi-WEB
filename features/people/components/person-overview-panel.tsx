"use client";

import { Bell, Calendar, HandCoins, ListX, Mail, MoreHorizontal, Paperclip, Pencil, Phone, Plus, Share2, Split, StickyNote, Trash2, Users, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { ClayAvatar } from "@/components/clay/clay-avatar";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
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
import { usePersonUpcomingEmi } from "@/features/people/hooks/use-person-upcoming-emi";
import { buildLedgerRows, cycleShowingNewEntry, type LedgerRow, type PaymentRecord } from "@/features/people/lib/person-ledger-rows";
import type { PendingSplitParticipant } from "@/lib/engines/person-pending-split-participants";
import { useTransactionActions } from "@/features/transactions/hooks/use-transactions-data";
import { PersonCycleStatementSection } from "@/features/people/components/cycle-statement/person-cycle-statement-section";
import { PersonActivityFeed, type LedgerRowHandlers, type LedgerScope } from "@/features/people/components/person-activity-feed";
import { AddEntryPanel, type AddEntryParams } from "@/features/people/components/workspace/add-entry-panel";
import { EditPersonMode, type EditPersonPatch } from "@/features/people/components/workspace/edit-person-mode";
import { InlineReveal, LedgerConfirmDialog, type EntrySettleValues } from "@/features/people/components/workspace/ledger-ui";
import { WsLabel } from "@/features/people/components/workspace/person-workspace-ui";
import { SettleUpPanel } from "@/features/people/components/workspace/settle-up-panel";
import { ShareStatementMode } from "@/features/people/components/workspace/share-statement-mode";
import { SplitExpenseMode } from "@/features/people/components/workspace/split-expense-mode";
import { BACK_TO_TRANSACTIONS, TransactionLedgerMode, type LedgerView } from "@/features/people/components/workspace/transaction-ledger-mode";
import { cn } from "@/lib/utils";
import { toast } from "@/store/toast-store";

/** Settles one manual "gave"/"borrowed" entry — a "repaid"/"receivedBack" entry with `parentEntryId` set. */
export interface SettleEntryParams {
  type: "repaid" | "receivedBack";
  amount: number;
  date: Date;
  parentEntryId: string;
}

/** The workspace's internal modes — the shell (header) stays put; only the content area changes. */
type Mode = { kind: "overview" } | { kind: "split" } | { kind: "share" } | { kind: "edit" } | { kind: "ledger" };

/** Add and Settle expand inline in the overview (Add also in the expanded ledger) — one at a time. */
type InlineAction = "add" | "settle" | null;

/** Complex modes get a wider shell; quick forms a narrower one. */
const WIDE: Mode["kind"][] = ["overview", "split", "share"];

/** Loan events ride in `person.activity` as `loan:`/`loan-txn:` items — listed under "All transactions". */
const isLoanItem = (id: string) => id.startsWith("loan:") || id.startsWith("loan-txn:");

const VIEWS = ["Activity", "Details"] as const;
type View = (typeof VIEWS)[number];

const ICON_BUTTON =
  "flex size-8 shrink-0 items-center justify-center rounded-[6px] text-muted-foreground outline-none transition-colors hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-secondary data-[state=open]:text-foreground";

const SECONDARY_ACTION =
  "flex h-9 items-center gap-1.5 rounded-[6px] px-3 text-sm font-medium text-foreground outline-none transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40 [&_svg]:text-muted-foreground hover:[&_svg]:text-foreground";

function DetailRow({ icon: Icon, label, children }: { icon: typeof Calendar; label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5 text-sm">
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
 * The Person Ledger workspace — one centered surface (full-height sheet on phones) that behaves like a
 * small app: the overview (position, actions, Activity/Details) where Add and Settle expand inline,
 * plus Split, Share, Edit and the expanded transaction ledger as modes within the same shell — no
 * second backdrop, no modal-on-modal (only a destructive delete asks for confirmation). Same data,
 * statement engine and repository calls as before.
 */
export function PersonOverviewPanel({
  person,
  rawPerson,
  open,
  onClose,
  onAddEntry,
  onSettleEntry,
  onDeleteEntries,
  onUndoSplitReceived,
  onEditPerson,
  onDelete,
}: {
  person: PersonViewRow;
  /** The stored `Person` record — Settle, Split and Edit act on it. */
  rawPerson: Person | null;
  open: boolean;
  onClose: () => void;
  /** Records a "gave"/"borrowed" entry for this person (same payload as the old Add Transaction dialog). */
  onAddEntry?: (params: AddEntryParams) => Promise<void>;
  /** Settles one "gave"/"borrowed" entry (same payload as the old Settle Transaction dialog). */
  onSettleEntry?: (params: SettleEntryParams) => Promise<void>;
  /** Reverses + soft-deletes ledger entries planned by `planEntryDeletion`/`planBulkDeletion`. */
  onDeleteEntries?: (entries: LedgerEntry[]) => Promise<void>;
  /** Reverses a split share's "received" status through the existing received-status toggle. */
  onUndoSplitReceived?: (pending: PendingSplitParticipant) => Promise<void>;
  onEditPerson?: (patch: EditPersonPatch) => Promise<void>;
  onDelete?: () => void;
}) {
  const [mode, setMode] = useState<Mode>({ kind: "overview" });
  const [direction, setDirection] = useState<"forward" | "back">("forward");
  const [view, setView] = useState<View>("Activity");
  const [cycle, setCycle] = useState<StatementCycle>(() => cycleContaining(new Date()));
  const [inline, setInline] = useState<InlineAction>(null);
  /** The expanded ledger's own navigation (Transactions ↔ Settle / Split) — kept here so Escape can step back. */
  const [ledgerView, setLedgerView] = useState<LedgerView>("transactions");
  const [scope, setScope] = useState<LedgerScope>("cycle");
  const [settlingKey, setSettlingKey] = useState<string | null>(null);
  // Delete plans are frozen when a confirmation opens, so live updates (including the delete itself) never change what it says.
  const [deleting, setDeleting] = useState<{ row: LedgerRow; plan: EntryDeletionPlan | null } | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [bulkDelete, setBulkDelete] = useState<BulkDeletionPlan | null>(null);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [undoing, setUndoing] = useState<{ row: LedgerRow; payment: PaymentRecord } | null>(null);
  const [undoOpen, setUndoOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
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
    setLedgerView("transactions");
    scrollRef.current?.scrollTo({ top: 0 });
  };
  const back = () => go({ kind: "overview" });
  /** Opening one inline action collapses the other; pressing the open one again collapses it. */
  const toggleInline = (next: Exclude<InlineAction, null>) => {
    setInline((current) => (current === next ? null : next));
    setSettlingKey(null);
  };

  /** Add (compact or expanded): the existing `onAddEntry`, then show where the new transaction landed. */
  async function saveNewEntry(params: AddEntryParams) {
    if (!onAddEntry) throw new Error("Not signed in");
    await onAddEntry(params);
    setInline(null);
    setView("Activity");
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
      });
    } else {
      if (!txActions) throw new Error("Not signed in");
      const { expense, participant, installment } = target.pending;
      await txActions.settleParticipant({ expense, participant, installment, amount: values.amount, date: values.date });
    }
    setSettlingKey(null);
  }

  const rowHandlers: LedgerRowHandlers = {
    settlingKey,
    onSettleStart: (row) => {
      setInline(null);
      setSettlingKey(row.key);
    },
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
    } catch (e) {
      toast.error(failure, e instanceof Error ? e.message : "Please try again.");
      throw e;
    }
  }

  const actionButton = (active: boolean) =>
    cn(SECONDARY_ACTION, active && "bg-secondary text-foreground shadow-[inset_0_-2px_0_var(--color-primary-accent-text)] [&_svg]:text-foreground");

  const actions = (
    <div className="flex flex-wrap items-center gap-y-2">
      <button
        type="button"
        onClick={() => toggleInline("add")}
        disabled={!onAddEntry}
        aria-expanded={inline === "add"}
        aria-controls="person-inline-add"
        className={cn(
          "flex h-9 items-center gap-1.5 rounded-[6px] border border-primary-accent-text bg-primary pr-4 pl-3 text-sm font-semibold text-primary-foreground outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
          inline === "add" && "ring-2 ring-primary-accent-text/40",
        )}
      >
        <Plus className={cn("size-4 transition-transform duration-200", inline === "add" && "rotate-45")} strokeWidth={2.25} />
        Add
      </button>
      <span className="mx-2.5 h-5 w-px bg-border-strong/60" aria-hidden />
      <div className="-ml-1 flex items-center">
        <button
          type="button"
          onClick={() => toggleInline("settle")}
          disabled={!rawPerson}
          aria-expanded={inline === "settle"}
          aria-controls="person-inline-settle"
          className={actionButton(inline === "settle")}
        >
          <HandCoins className="size-4" strokeWidth={1.75} />
          Settle
        </button>
        <button type="button" onClick={() => go({ kind: "split" })} disabled={!rawPerson} className={SECONDARY_ACTION}>
          <Split className="size-4" strokeWidth={1.75} />
          Split
        </button>
        <button type="button" onClick={() => go({ kind: "share" })} disabled={statement == null} className={SECONDARY_ACTION}>
          <Share2 className="size-4" strokeWidth={1.75} />
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
    <>
      <div className="shrink-0 px-4 pt-5 pb-6 sm:px-7 sm:pt-6">
        <PersonCycleStatementSection
          statement={statement}
          isLoading={isLoading}
          cycle={cycle}
          onCycleChange={setCycle}
          linkedEmis={linkedEmis}
          setRepays={setRepays}
          actions={actions}
          footnote={loansNote}
        />
        {/* Inline actions — expand right here, pushing the rest of the workspace down; one at a time */}
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
      </div>

      <div role="tablist" aria-label="Person workspace" className="sticky top-0 z-10 flex shrink-0 gap-6 border-y border-border bg-card px-4 sm:px-7">
        {VIEWS.map((v) => (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={view === v}
            onClick={() => setView(v)}
            className={cn(
              "-mb-px border-b-2 py-3 text-sm transition-colors outline-none focus-visible:text-foreground",
              view === v ? "border-primary-accent-text font-semibold text-foreground" : "border-transparent font-medium text-muted-foreground hover:text-foreground",
            )}
          >
            {v}
          </button>
        ))}
      </div>

      <div
        key={view}
        className={cn(
          "px-4 pt-4 animate-in duration-200 fade-in-0 sm:px-7",
          // Activity: the feed takes the remaining height and scrolls its own list (sm+); Details scrolls with the page.
          view === "Activity" ? "flex flex-col pb-4 sm:min-h-0 sm:flex-1" : "pb-7",
        )}
      >
        {view === "Activity" ? (
          <PersonActivityFeed
            personName={person.name}
            rows={scopeRows}
            isLoading={rowsLoading}
            scope={scope}
            onScopeChange={(next) => {
              setScope(next);
              setSettlingKey(null);
            }}
            counts={scopeCounts}
            cycleLabel={cycleLabel}
            onAdd={
              onAddEntry
                ? () => {
                    setInline("add");
                    scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
                  }
                : undefined
            }
            onExpand={() => go({ kind: "ledger" })}
            handlers={rowHandlers}
            carriedForward={carriedForward}
          />
        ) : (
          <div className="grid gap-x-10 gap-y-7 md:grid-cols-2">
            <div>
              <SectionTitle>Overview</SectionTitle>
              <div className="mt-1 divide-y divide-border">
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

            <div>
              <SectionTitle icon={Bell}>Upcoming EMI</SectionTitle>
              {upcomingEmi.length === 0 ? (
                <p className="mt-2.5 text-sm text-muted-foreground">No upcoming EMI</p>
              ) : (
                <div className="mt-1 divide-y divide-border">
                  {upcomingEmi.slice(0, 5).map((item) => (
                    <div key={item.loanId} className="flex items-start justify-between gap-3 py-2.5 text-sm">
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

            <div>
              <SectionTitle icon={StickyNote}>Notes</SectionTitle>
              {person.notes ? (
                <p className="mt-2.5 text-sm whitespace-pre-wrap text-foreground">{person.notes}</p>
              ) : (
                <p className="mt-2.5 text-sm text-muted-foreground">No notes yet.</p>
              )}
            </div>

            <div>
              <SectionTitle icon={Paperclip}>Attachments</SectionTitle>
              <p className="mt-2.5 text-sm text-muted-foreground">No attachments yet.</p>
            </div>
          </div>
        )}
      </div>
    </>
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
        }}
        counts={scopeCounts}
        cycle={cycle}
        onCycleChange={(next) => {
          setCycle(next);
          setSettlingKey(null);
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
        }}
        renderSettle={
          rawPerson
            ? (backToTransactions) => (
                <SettleUpPanel
                  person={rawPerson}
                  variant="page"
                  backLabel={BACK_TO_TRANSACTIONS}
                  onCancel={backToTransactions}
                  onDone={backToTransactions}
                />
              )
            : undefined
        }
        renderSplit={
          rawPerson
            ? (backToTransactions) => (
                <SplitExpenseMode
                  person={rawPerson}
                  accounts={accounts}
                  categories={categories}
                  people={people}
                  backLabel={BACK_TO_TRANSACTIONS}
                  onBack={backToTransactions}
                  onDone={backToTransactions}
                />
              )
            : undefined
        }
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

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={(e) => {
          // Escape steps back out of a settle form, an inline section, then a mode; only closes from a clean overview.
          if (settlingKey != null) {
            e.preventDefault();
            setSettlingKey(null);
          } else if (inline != null) {
            e.preventDefault();
            setInline(null);
          } else if (mode.kind === "ledger" && ledgerView !== "transactions") {
            e.preventDefault();
            setLedgerView("transactions");
          } else if (mode.kind !== "overview") {
            e.preventDefault();
            back();
          }
        }}
        className={cn(
          "flex flex-col gap-0 overflow-hidden border border-border bg-card p-0 shadow-[var(--shadow-e4)] ring-0",
          // Phone: full-height sheet. Desktop: centered workspace that widens for complex modes.
          "top-0 left-0 h-[100dvh] max-h-[100dvh] max-w-none translate-x-0 translate-y-0 rounded-none",
          "sm:top-1/2 sm:left-1/2 sm:max-h-[min(92vh,60rem)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-[10px]",
          "transition-[max-width] duration-[260ms] ease-out",
          // The expanded ledger takes most of the viewport, with a fixed height so only its table scrolls.
          mode.kind === "ledger"
            ? "sm:h-[min(92vh,60rem)] sm:max-w-[min(94vw,84rem)]"
            : cn("sm:h-auto", WIDE.includes(mode.kind) ? "sm:max-w-3xl" : "sm:max-w-xl"),
        )}
      >
        {/* Shell header — who, always visible */}
        <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3 sm:px-7">
          <ClayAvatar name={person.name} size={36} />
          <div className="flex min-w-0 flex-1 flex-col">
            <DialogTitle className="truncate font-heading text-base leading-tight font-semibold tracking-tight sm:text-lg">{person.name}</DialogTitle>
            <DialogDescription className="truncate text-xs text-muted-foreground">{subline}</DialogDescription>
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            {onEditPerson && rawPerson && (
              <button
                type="button"
                aria-label="Edit person"
                aria-pressed={mode.kind === "edit"}
                onClick={() => go({ kind: "edit" })}
                className={cn(ICON_BUTTON, mode.kind === "edit" && "bg-secondary text-foreground")}
              >
                <Pencil className="size-4" strokeWidth={1.75} />
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
            <span className="mx-1 h-5 w-px bg-border" aria-hidden />
            <button type="button" aria-label="Close person view" onClick={onClose} className={ICON_BUTTON}>
              <X className="size-[18px]" strokeWidth={1.75} />
            </button>
          </div>
        </div>

        {/* Mode content — slides in from the right going deeper, from the left coming back; the ledger grows in */}
        <div
          ref={scrollRef}
          className={cn("flex min-h-0 flex-1 flex-col overflow-x-hidden", mode.kind === "ledger" ? "overflow-y-hidden" : "overflow-y-auto")}
        >
          <div
            key={mode.kind}
            className={cn(
              "animate-in duration-200 ease-out fade-in-0",
              // The overview's Activity view fits the workspace height so only its transaction list scrolls.
              mode.kind === "overview"
                ? cn("flex flex-1 flex-col", view === "Activity" && "sm:min-h-0")
                : mode.kind === "ledger"
                  ? "flex min-h-0 flex-1 flex-col duration-[260ms] zoom-in-[0.98]"
                  : "min-h-full shrink-0",
              mode.kind !== "ledger" && (direction === "forward" ? "slide-in-from-right-6" : "slide-in-from-left-6"),
            )}
          >
            {content}
          </div>
        </div>

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
      </DialogContent>
    </Dialog>
  );
}
