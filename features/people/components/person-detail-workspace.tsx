"use client";

import { ArrowLeft, Bell, Calendar, ChevronDown, HandCoins, ListX, Mail, MoreHorizontal, Paperclip, Pencil, Phone, Plus, Share2, Split, StickyNote, Trash2, Users } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ClayAvatar } from "@/components/clay/clay-avatar";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useAccounts } from "@/hooks/use-accounts";
import { useCategories } from "@/hooks/use-categories";
import { usePeople } from "@/hooks/use-people";
import { usePersonCashLegIds, useTransactions } from "@/hooks/use-transactions";
import { formatCurrency } from "@/lib/format";
import { cycleContaining, formatCycleLabel, formatStatementDate, type StatementCycle } from "@/lib/engines/person-cycle-statement";
import { money } from "@/lib/engines/person-cycle-statement-share";
import { planBulkDeletion, planEntryDeletion, type BulkDeletionPlan, type EntryDeletionPlan } from "@/lib/engines/person-ledger-deletion";
import type { AdvanceApplication, LedgerEntry, Person } from "@/lib/models/person";
import type { LedgerSourceKind } from "@/lib/models/person";
import type { PersonViewRow } from "@/features/people/hooks/use-people-data";
import { usePersonCycleStatement } from "@/features/people/hooks/use-person-cycle-statement";
import { useSelectedCycle } from "@/features/people/hooks/use-selected-cycle";
import { usePersonPendingSplitParticipants } from "@/features/people/hooks/use-person-pending-split-participants";
import { usePersonUpcomingEmi } from "@/features/people/hooks/use-person-upcoming-emi";
import { useSettlementLookups } from "@/features/people/hooks/use-settlement-lookups";
import { buildLedgerRows, cycleShowingNewEntry, type LedgerRow, type PaymentRecord } from "@/features/people/lib/person-ledger-rows";
import type { PendingSplitParticipant } from "@/lib/engines/person-pending-split-participants";
import { useTransactionActions } from "@/features/transactions/hooks/use-transactions-data";
import { PersonCycleStatementSection } from "@/features/people/components/cycle-statement/person-cycle-statement-section";
import { PersonActivityFeed, type LedgerRowHandlers, type LedgerScope } from "@/features/people/components/person-activity-feed";
import { AddEntryPanel, type AddEntryParams } from "@/features/people/components/workspace/add-entry-panel";
import { EditPersonMode, type EditPersonPatch } from "@/features/people/components/workspace/edit-person-mode";
import { InlineReveal, LedgerConfirmDialog, type EntryEditValues, type EntrySettleValues } from "@/features/people/components/workspace/ledger-ui";
import { LE_RADIUS } from "@/features/loans/components/loan-emi-ui";
import { WS_PRIMARY, WS_SECONDARY, WsLabel } from "@/features/people/components/workspace/person-workspace-ui";
import { paymentInitialFor, RecordPaymentPanel, type RecordPaymentInitial } from "@/features/people/components/workspace/record-payment-panel";
import { paymentImpact } from "@/lib/engines/person-payment-impact";
import { ApplyAdvancePanel, PaymentRevertDetails } from "@/features/people/components/workspace/payment-extras";
import { MoneyToUseSection } from "@/features/people/components/workspace/purpose-money";
import { usePersonPurposeFunds } from "@/features/people/hooks/use-purpose-funds";
import { purposeCashOf } from "@/lib/engines/purpose-funds";
import { advanceSources, payableObligations } from "@/features/people/lib/person-payment-obligations";
import { advanceRemaining, PAYMENT_EPSILON, type AdvanceUse } from "@/lib/engines/person-payment";
import { followUpStatus } from "@/lib/models/person-follow-up";
import { useAllPersonFollowUps, usePersonFollowUpActions } from "@/features/people/hooks/use-person-follow-ups";
import { FollowUpContext, type FollowUpContextValue } from "@/features/people/components/workspace/follow-up";
import { isInAppPath } from "@/lib/engines/linked-people-readiness";
import { peopleLedgerHref } from "@/features/people/lib/people-return-link";
import type { RecordPaymentInput } from "@/lib/repositories/person-payment-repository";
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
  parentEntryId?: string;
  sourceKind?: LedgerSourceKind;
  obligationRef?: string;
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
/** The sides on which this person has advance held right now (their advance, or advance I paid them). */
function advanceSides(available: ReturnType<typeof advanceRemaining>): ("theyOwe" | "iOwe")[] {
  return (["theyOwe", "iOwe"] as const).filter((side) => available.filter((a) => a.side === side).reduce((s, a) => s + a.remaining, 0) > 0.005);
}

export function PersonDetailWorkspace({
  person,
  rawPerson,
  onBack,
  onAddEntry,
  onSettleEntry,
  onDeleteEntries,
  onEditEntry,
  onUndoSplitReceived,
  onRevertPayment,
  onRemoveAdvanceApplications,
  onRecordPayment,
  onApplyAdvance,
  onEditPerson,
  onDelete,
  initialCycle,
  initialView,
}: {
  /** The cycle the People list was showing when this person was opened (defaults to the current one). */
  initialCycle?: StatementCycle;
  /** "ledger" reopens the expanded ledger — set when coming back from a transaction opened there. */
  initialView?: "ledger" | null;
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
  /** Reverts one recorded payment as a whole (every obligation line, its cash leg and any advance). */
  onRevertPayment?: (paymentId: string) => Promise<void>;
  /** Un-applies advance from an obligation — the advance becomes available again. */
  onRemoveAdvanceApplications?: (applications: AdvanceApplication[]) => Promise<void>;
  /** Record payment — records (paymentId null) or edits one real payment (`PersonPaymentRepository`). */
  onRecordPayment?: (input: RecordPaymentInput, paymentId: string | null) => Promise<void>;
  /** Applies advance to one obligation — no cash, no balance move. */
  onApplyAdvance?: (params: { targets: { obligationKey: string; uses: AdvanceUse[] }[]; date: Date }) => Promise<void>;
  onEditPerson?: (patch: EditPersonPatch) => Promise<void>;
  onDelete?: () => void;
}) {
  const [mode, setMode] = useState<Mode>(() => (initialView === "ledger" ? { kind: "ledger" } : { kind: "overview" }));
  const [direction, setDirection] = useState<"forward" | "back">("forward");
  const [cycle, setCycle, cycleStartDay] = useSelectedCycle(initialCycle);
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
  /** The Record payment workspace: which obligation it opened for, or the payment being edited. */
  const [paying, setPaying] = useState<{ preselectKey?: string | null; initial?: RecordPaymentInitial | null } | null>(null);
  const [advanceOpen, setAdvanceOpen] = useState<"theyOwe" | "iOwe" | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const { statement, allTimeStatement, ledgerEntries, isLoading, linkedEmis, setRepays, advanceApplications } = usePersonCycleStatement(person.id, cycle);
  const { pending, trackedShareRefs: trackedAll, isLoading: sharesLoading } = usePersonPendingSplitParticipants(person.id);
  // Until expenses have loaded, whether a share is tracked is unknown — keep it conservative (null).
  const trackedShareRefs = sharesLoading ? null : trackedAll;
  const txActions = useTransactionActions();
  const router = useRouter();
  const { items: upcomingEmi } = usePersonUpcomingEmi(person.id);
  const { data: accounts = [] } = useAccounts();
  const { data: categories = [] } = useCategories();
  const { data: people = [] } = usePeople();
  const firstName = person.name.split(" ")[0];
  const followUpActions = usePersonFollowUpActions();
  const contact = [person.phone, person.email].filter(Boolean).join(" · ");

  // ---- Transactions: one row model for the compact list and the expanded ledger ----
  // Entries added here with an account carry their own cash-leg Transaction as `transactionRef` — still
  // ledger-owned (Settle/Delete here), unlike a split-expense or Loan link. See `planEntryDeletion`.
  const cashLegIds = usePersonCashLegIds();
  // Cycle rows read payment history from the whole-history statement, so a transaction shows every payment against it.
  const cycleRows = useMemo(
    () => buildLedgerRows({ statement, history: allTimeStatement, entries: ledgerEntries, pending, cashLegIds, trackedShareRefs }),
    [statement, allTimeStatement, ledgerEntries, pending, cashLegIds, trackedShareRefs],
  );
  const allRows = useMemo(
    () =>
      buildLedgerRows({
        statement: allTimeStatement,
        entries: ledgerEntries,
        loanItems: person.activity.filter((a) => isLoanItem(a.id)),
        pending,
        cashLegIds,
        trackedShareRefs,
        advanceApplications,
      }),
    [allTimeStatement, ledgerEntries, person.activity, pending, cashLegIds, trackedShareRefs, advanceApplications],
  );
  const scopeRows = scope === "cycle" ? cycleRows : allRows;
  const baseLookups = useSettlementLookups(ledgerEntries, pending);
  // "Open expense" carries this exact ledger context (person, selected cycle, expanded ledger) to Transactions.
  const returnHref = peopleLedgerHref({ personId: person.id, cycle, view: mode.kind === "ledger" ? "ledger" : null });
  const lookups = useMemo(() => ({ ...baseLookups, sourceReturn: { href: returnHref, label: person.name } }), [baseLookups, returnHref, person.name]);
  // Obligations dated before the selected cycle that are still open today — listed as "Brought forward"
  // with their source, so carried money never reads as a new expense. Engine rows, nothing recomputed.
  const carriedRows = useMemo(() => {
    const start = new Date(cycle.start.getFullYear(), cycle.start.getMonth(), cycle.start.getDate()).getTime();
    return allRows.filter((r) => r.statementRow?.kind === "obligation" && r.date.getTime() < start && (r.state === "open" || r.state === "partial"));
  }, [allRows, cycle]);
  const cycleLabelOf = (d: Date) => `${formatCycleLabel(cycleContaining(d, cycleStartDay), false)} cycle`;
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

  const bulkPlan = useMemo(() => planBulkDeletion(ledgerEntries, cashLegIds), [ledgerEntries, cashLegIds]);
  const { data: allTransactions = [] } = useTransactions();
  const { funds: purposeFunds } = usePersonPurposeFunds(person.id);

  // ---- Edit / revert one recorded payment — read from its own records, never assumed ----
  const transactionById = useMemo(() => new Map(allTransactions.map((t) => [t.id, t])), [allTransactions]);
  const purposePaymentIds = useMemo(() => new Set(purposeFunds.filter((f) => f.deletedAt == null).map((f) => f.paymentId)), [purposeFunds]);
  const accountIdOf = (id: string) => transactionById.get(id)?.accountId ?? null;
  const incomeOf = (id: string) => {
    const t = transactionById.get(id);
    return t && t.deletedAt == null ? { amount: t.amount, categoryId: t.categoryId, description: t.description ?? "" } : null;
  };
  // Live: re-computed as the dependency list changes (e.g. after undoing a later advance use).
  const undoImpactId = undoing?.payment.undo?.kind === "payment" ? undoing.payment.undo.paymentId : null;
  const paymentInitial = (paymentId: string) => paymentInitialFor(paymentId, ledgerEntries, accountIdOf, purposePaymentIds, incomeOf);
  const impactOf = (paymentId: string) =>
    paymentImpact({
      paymentId,
      entries: ledgerEntries,
      applications: advanceApplications,
      transactionOf: (id) => transactionById.get(id),
      purposeAmount: purposeCashOf(purposeFunds, paymentId),
      purposeCashRefs: purposeFunds.flatMap((f) => (f.deletedAt == null && f.paymentId === paymentId ? [f.receiptTransactionRef] : [])),
      purposeIncomeRefs: purposeFunds.flatMap((f) => (f.deletedAt == null && f.paymentId === paymentId && f.incomeTransactionRef ? [f.incomeTransactionRef] : [])),
    });
  const undoImpact = undoImpactId ? impactOf(undoImpactId) : null;

  /** Record payment opens in place: inline on the page, or as the expanded ledger's own view. */
  function openPayment(next: { preselectKey?: string | null; initial?: RecordPaymentInitial | null }) {
    setPaying(next);
    setSettlingKey(null);
    setEditingKey(null);
    if (mode.kind === "ledger") setLedgerView("settle");
    else {
      setInline("settle");
      rootRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }
  const closePayment = () => {
    settleReturnRef.current = null;
    setPaying(null);
    setInline(null);
    setLedgerView("transactions");
  };

  // Deep link from a lender-payment gate (`?obligation=<key>&settle=1[&return=<path>]`): open Record payment with
  // that exact obligation preselected, once. Once it is recorded, go back to the lender payment it unblocks.
  const settleReturnRef = useRef<string | null>(null);
  const settleDeepLinkedRef = useRef(false);
  useEffect(() => {
    if (settleDeepLinkedRef.current || isLoading || onRecordPayment == null || typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const key = params.get("obligation");
    if (params.get("settle") !== "1" || !key || !allRows.some((r) => r.key === key)) return;
    settleDeepLinkedRef.current = true;
    const back = params.get("return");
    requestAnimationFrame(() => {
      openPayment({ preselectKey: key });
      settleReturnRef.current = back && isInAppPath(back) ? back : null;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot on load; `openPayment` is render-scoped
  }, [isLoading, allRows, onRecordPayment]);
  const paymentPanel =
    onRecordPayment != null ? (
      <RecordPaymentPanel
        key={`${paying?.preselectKey ?? ""}|${paying?.initial?.paymentId ?? ""}|${cycle.start.getTime()}`}
        cycle={cycle}
        cycleLabel={formatCycleLabel(cycle)}
        personName={person.name}
        rows={allRows}
        preselectKey={paying?.preselectKey}
        initial={paying?.initial}
        onCancel={closePayment}
        onSubmit={async (input, paymentId) => {
          await onRecordPayment(input, paymentId);
          const back = settleReturnRef.current;
          toast.success(paymentId ? "Payment updated" : back ? "Payment recorded — back to your payment" : "Payment recorded");
          closePayment();
          if (back) router.push(back);
        }}
        cycleStartDay={cycleStartDay}
        onSetReminder={async (targets, when) => {
          try {
            for (const t of targets) await followUpActions.set({ personId: person.id, obligationKey: t.key, obligationTitle: t.title, ...when });
            toast.success("Reminder set");
          } catch {
            toast.error("Payment recorded, but the reminder couldn't be saved.");
          }
        }}
      />
    ) : null;

  // Advance held for / by this person, and the oldest obligation it could settle right now.
  const advanceAvailable = useMemo(() => advanceRemaining(advanceSources(ledgerEntries), advanceApplications), [ledgerEntries, advanceApplications]);
  const openObligations = useMemo(() => payableObligations(allRows), [allRows]);

  // Follow-up reminders — metadata on open rows; status derived from each row's live remaining.
  const { followUpsByPersonId } = useAllPersonFollowUps();
  const personFollowUps = followUpsByPersonId[person.id];
  const followUpContext = useMemo<FollowUpContextValue>(() => {
    const remainingByKey = new Map(allRows.map((r) => [r.key, r.remaining ?? 0]));
    const byKey = new Map(
      (personFollowUps ?? []).map((f) => [f.obligationKey, { followUp: f, status: followUpStatus(f, (remainingByKey.get(f.obligationKey) ?? 0) > PAYMENT_EPSILON) }]),
    );
    const guard = async (fn: () => Promise<void>, failure: string) => {
      try {
        await fn();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : failure);
        throw e;
      }
    };
    return {
      byKey,
      cycleStartDay,
      onSet: (key, title, when) => guard(() => followUpActions.set({ personId: person.id, obligationKey: key, obligationTitle: title, ...when }), "Couldn't save the reminder."),
      onDismiss: (key) => guard(() => followUpActions.dismiss(person.id, key), "Couldn't update the reminder."),
      onRemove: (key) => guard(() => followUpActions.remove(person.id, key), "Couldn't remove the reminder."),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- actions are stateless wrappers over the signed-in uid
  }, [allRows, personFollowUps, cycleStartDay, person.id]);
  const heldSides = advanceSides(advanceAvailable);
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
    const next = cycleShowingNewEntry(scope, cycle, params.date, cycleStartDay);
    if (next) setCycle(next);
  }

  function openBulkDelete() {
    setBulkDelete(bulkPlan);
    setBulkDeleteOpen(true);
  }

  async function settleRow(row: LedgerRow, values: EntrySettleValues) {
    const target = row.settle;
    if (!target) return;
    if (target.kind === "entry" || target.kind === "derivedInstallment" || target.kind === "opening") {
      if (!onSettleEntry) throw new Error("Not signed in");
      await onSettleEntry({
        // "I borrowed X" / an opening balance I owe settles by "I repaid"; everything else is a Person receivable.
        type: (target.kind === "entry" && target.entry.type === "borrowed") || (target.kind === "opening" && row.direction === "iOwe") ? "repaid" : "receivedBack",
        amount: values.amount,
        date: values.date,
        parentEntryId: target.kind === "entry" ? target.entry.id : undefined,
        sourceKind: target.kind === "derivedInstallment" ? target.sourceKind : undefined,
        obligationRef: target.kind === "entry" ? undefined : target.obligationRef,
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
      // One Record payment flow for every obligation — with this row preselected.
      if (onRecordPayment) openPayment({ preselectKey: row.key });
      else {
        setInline(null);
        setEditingKey(null);
        setSettlingKey(row.key);
      }
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
          setDeleting({ row, plan: row.entryId ? planEntryDeletion(row.entryId, ledgerEntries, cashLegIds) : null });
          setDeleteOpen(true);
        }
      : undefined,
    editablePayment: (p) => p.undo?.kind === "payment" && paymentInitial(p.undo.paymentId) != null,
    onEditPayment: onRecordPayment
      ? (p) => {
          const initial = p.undo?.kind === "payment" ? paymentInitial(p.undo.paymentId) : null;
          if (initial) openPayment({ initial });
        }
      : undefined,
    onUndoPayment:
      onDeleteEntries || onUndoSplitReceived || onRevertPayment || onRemoveAdvanceApplications
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
      } else if (target.kind === "payment") {
        if (!onRevertPayment) throw new Error("Not signed in");
        await onRevertPayment(target.paymentId);
      } else if (target.kind === "advanceApplication") {
        if (!onRemoveAdvanceApplications) throw new Error("Not signed in");
        const applications = advanceApplications.filter((a) => a.id === target.applicationId);
        if (applications.length === 0) throw new Error("That advance application no longer exists.");
        await onRemoveAdvanceApplications(applications);
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
        onClick={() => (inline === "settle" ? closePayment() : openPayment({}))}
        disabled={!rawPerson || !onRecordPayment}
        aria-expanded={inline === "settle"}
        aria-controls="person-inline-settle"
        title="Record money received from, or paid to, this person"
        className={cn(WS_PRIMARY, "lg:w-full", inline === "settle" && "ring-2 ring-primary-accent-text/40")}
      >
        <HandCoins className="size-4" strokeWidth={2} />
        {inline === "settle" ? "Close" : "Record payment"}
      </button>
      <div className="flex flex-wrap gap-1.5 lg:grid lg:grid-cols-3">
        <button
          type="button"
          onClick={() => toggleInline("add")}
          disabled={!onAddEntry}
          aria-expanded={inline === "add"}
          aria-controls="person-inline-add"
          title="Add a transaction"
          className={secondaryAction(inline === "add")}
        >
          <Plus className={cn("size-3.5 transition-transform duration-200", inline === "add" && "rotate-45")} strokeWidth={2} />
          Add
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
      Loans are settled from the Loan, outside this statement. Overall incl. loans: you need to receive {formatCurrency(person.breakdown.toReceive)}
      {" · "}you need to give {formatCurrency(person.breakdown.toGive)}
      {person.loanReceivable > 0 && ` · Loans — you need to receive ${formatCurrency(person.loanReceivable)}`}
      {person.loanPayable > 0 && ` · Loans — you need to give ${formatCurrency(person.loanPayable)}`}
    </p>
  );

  // Balance summary — explains the overall position from the People engine's own breakdown (never a re-sum):
  // each borrowed/gave entry stays its own obligation, and the two directions are settled separately —
  // the net is a summary line only (it never drives Record Payment, Full payment or allocation).
  const b = person.breakdown;
  const summaryLines: { label: string; amount: number; tone: "expense" | "success" }[] = [
    { label: "You need to give", amount: b.toGive, tone: "expense" },
    { label: "You need to receive", amount: b.toReceive, tone: "success" },
  ];
  const breakdownNote = Math.abs(b.unlinked) >= 0.005 || b.loanPayable > 0 || b.loanReceivable > 0 || b.emiReceivableOpen > 0;
  const balanceSummary = (b.toGive > 0 || b.toReceive > 0) && (
    <div aria-label="Balance summary" className="text-[13px] tabular-nums">
      <p className="text-[11px] font-bold tracking-[0.08em] text-foreground/75 uppercase">Overall with {person.name.split(" ")[0]}</p>
      <dl className="mt-1">
        {summaryLines.map((l) => (
          <div key={l.label} className="flex items-baseline justify-between gap-3 py-0.5">
            <dt className="font-medium text-foreground">{l.label}</dt>
            <dd className={cn("font-semibold", l.amount > 0 ? (l.tone === "expense" ? "text-expense" : "text-success") : "text-foreground/60")}>
              {formatCurrency(l.amount)}
            </dd>
          </div>
        ))}
      </dl>
      {b.toGive > 0 && b.toReceive > 0 && (
        // Secondary on purpose: the two sides are separate obligations — the net never means "nothing to do".
        <p className="mt-0.5 text-[11.5px] text-foreground/70">
          Net {formatCurrency(Math.abs(b.net))} {b.net > 0 ? "to receive" : b.net < 0 ? "to give" : "even"} · Summary only — payments are settled separately.
        </p>
      )}
      {breakdownNote && (
        <details className="group mt-1">
          <summary className="flex cursor-pointer list-none items-center gap-1 text-xs font-medium text-foreground/70 hover:text-foreground [&::-webkit-details-marker]:hidden">
            How this is calculated
            <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" strokeWidth={1.75} />
          </summary>
          <p className="mt-1 rounded-[6px] bg-secondary/60 px-2.5 py-1.5 text-[11px] leading-snug text-foreground/80">
            Open borrowed {formatCurrency(b.borrowedOpen)} · Open given {formatCurrency(b.gaveOpen)}
            {Math.abs(b.unlinked) >= 0.005 &&
              ` · Payments/adjustments not tied to one transaction ${b.unlinked > 0 ? "+" : "−"}${formatCurrency(Math.abs(b.unlinked))}`}
            {b.loanPayable > 0 && ` · Loans — you need to give ${formatCurrency(b.loanPayable)}`}
            {b.loanReceivable > 0 && ` · Loans — you need to receive ${formatCurrency(b.loanReceivable)}`}
            {b.emiReceivableOpen > 0 && ` · EMI shares — you need to receive ${formatCurrency(b.emiReceivableOpen)}`}
          </p>
        </details>
      )}
    </div>
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
            footnote={
              <>
                {balanceSummary}
                {loansNote}
              </>
            }
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
        {/* Money to use — received money held for specific purposes (not income, not advance) */}
        {rawPerson && <MoneyToUseSection person={rawPerson} entries={ledgerEntries} onRevertPayment={onRevertPayment} />}
        {onApplyAdvance &&
          heldSides.map((side) => (
            <ApplyAdvancePanel
              key={side}
              personName={person.name}
              side={side}
              available={advanceAvailable}
              obligations={openObligations}
              cycle={cycle}
              open={advanceOpen === side}
              onOpenChange={(o) => setAdvanceOpen(o ? side : null)}
              onConfirm={async (targets) => {
                await onApplyAdvance({ targets, date: new Date() });
                toast.success("Advance applied");
              }}
            />
          ))}
        <div id="person-inline-settle">
          <InlineReveal open={inline === "settle" && rawPerson != null}>
            {rawPerson && inline === "settle" && paymentPanel}
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
          personId={person.id}
          personName={person.name}
          rows={scopeRows}
          carriedRows={carriedRows}
          lookups={lookups}
          statement={statement}
          cycleLabelOf={cycleLabelOf}
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
        personId={person.id}
        personName={person.name}
        rows={scopeRows}
        carriedRows={carriedRows}
        statement={statement}
        lookups={lookups}
        cycleLabelOf={cycleLabelOf}
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
        balance={allTimeStatement ? { direction: allTimeStatement.direction, amount: allTimeStatement.amount, toReceive: allTimeStatement.toReceive, toGive: allTimeStatement.toGive } : null}
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
        renderSettle={paymentPanel ? () => <div className="mx-auto w-full max-w-6xl px-4 pb-6 sm:px-7">{paymentPanel}</div> : undefined}
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
    <FollowUpContext.Provider value={followUpContext}>
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
          title={undoImpact ? (undoImpact.canRevert ? "Revert payment?" : "Can't revert this payment yet") : "Undo this settlement?"}
          confirmLabel={undoImpact ? "Revert payment" : "Undo settlement"}
          busyLabel="Undoing…"
          disabled={undoing?.payment.undo == null || (undoImpact != null && !undoImpact.canRevert)}
          onConfirm={async () => {
            if (undoing) await undoPayment(undoing.payment);
          }}
        >
          {undoing && undoImpact ? (
            <PaymentRevertDetails
              impact={undoImpact}
              firstName={firstName}
              initial={undoing.payment.undo?.kind === "payment" ? paymentInitial(undoing.payment.undo.paymentId) : null}
              onEdit={
                onRecordPayment
                  ? (initial) => {
                      setUndoOpen(false);
                      openPayment({ initial });
                    }
                  : undefined
              }
              accountNameOf={(id) => accounts.find((a) => a.id === id)?.name ?? "the account"}
              obligationTitleOf={(key) => allRows.find((r) => r.key === key)?.title ?? "A later obligation"}
              onUndoDependency={
                onRemoveAdvanceApplications
                  ? async (applicationId) => {
                      const applications = advanceApplications.filter((x) => x.id === applicationId);
                      try {
                        if (applications.length === 0) throw new Error("That advance use no longer exists.");
                        await onRemoveAdvanceApplications(applications);
                        toast.success("Advance use undone");
                      } catch (e) {
                        toast.error("Couldn't undo that use", e instanceof Error ? e.message : "Please try again.");
                      }
                    }
                  : undefined
              }
            />
          ) : (
            undoing && (
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
            )
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
    </FollowUpContext.Provider>
  );
}
