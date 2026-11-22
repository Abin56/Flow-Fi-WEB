"use client";

import { ArrowLeft, Bell, Calendar, ChevronRight, HandCoins, ListX, Mail, MoreHorizontal, Paperclip, Pencil, Phone, Plus, Share2, Split, StickyNote, Trash2, Users } from "lucide-react";
import { useEffect, useMemo, useRef, useState, cloneElement } from "react";
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
import { buildStatementBalances, paymentLinesOf } from "@/features/people/lib/statement-balance";
import { buildLedgerRows, cycleShowingNewEntry, type LedgerRow, type PaymentRecord } from "@/features/people/lib/person-ledger-rows";
import type { PendingSplitParticipant } from "@/lib/engines/person-pending-split-participants";
import { PersonSettlementStrip } from "@/features/people/components/cycle-statement/person-cycle-statement-section";
import { StatementBreakdown, StatementCalculation } from "@/features/people/components/cycle-statement/statement-parts";
import { PersonBalanceStory } from "@/features/people/components/person-balance-story";
import { CyclePaymentHistory } from "@/features/people/components/workspace/settlement-summary";
import { PersonOpenItems } from "@/features/people/components/person-open-items";
import { PersonTabBar, personTabId, personTabPanelId, type PersonTab } from "@/features/people/components/person-section-nav";
import { EmiAgreementList, EmiHeaderColumn, LinkedEmisPanel, useRepaysToggle } from "@/features/people/components/linked-emis-panel";
import { PersonActivityFeed, type CarriedForward, type LedgerRowHandlers, type LedgerScope } from "@/features/people/components/person-activity-feed";
import { AddEntryPanel, type AddEntryParams } from "@/features/people/components/workspace/add-entry-panel";
import { EditPersonMode, type EditPersonPatch } from "@/features/people/components/workspace/edit-person-mode";
import { LedgerConfirmDialog, PeopleDrawer, type EntryEditValues, type EntrySettleValues } from "@/features/people/components/workspace/ledger-ui";
import { LE_RADIUS } from "@/features/loans/components/loan-emi-ui";
import { DateInput } from "@/components/forms/date-input";
import { WS_FIELD, WS_PRIMARY, WS_SECONDARY, WsLabel } from "@/features/people/components/workspace/person-workspace-ui";
import { paymentInitialFor, RecordPaymentPanel, type RecordPaymentInitial } from "@/features/people/components/workspace/record-payment-panel";
import { generalCreditOf } from "@/features/people/lib/settlement-presentation";
import { paymentImpact } from "@/lib/engines/person-payment-impact";
import { ApplyAdvancePanel, PaymentRevertDetails } from "@/features/people/components/workspace/payment-extras";
import { MoneyToUseSection } from "@/features/people/components/workspace/purpose-money";
import { usePersonPurposeFunds } from "@/features/people/hooks/use-purpose-funds";
import { purposeCashOf } from "@/lib/engines/purpose-funds";
import { advanceSources, payableObligations, routeFor } from "@/features/people/lib/person-payment-obligations";
import { advanceRemaining, PAYMENT_EPSILON, round2, type AdvanceUse } from "@/lib/engines/person-payment";
import { followUpStatus } from "@/lib/models/person-follow-up";
import { useAllPersonFollowUps, usePersonFollowUpActions } from "@/features/people/hooks/use-person-follow-ups";
import { FollowUpContext, type FollowUpContextValue } from "@/features/people/components/workspace/follow-up";
import { DeferralContext, DeferralCycleSummary, type DeferralContextValue } from "@/features/people/components/workspace/payment-deferral";
import { usePaymentDeferralActions, usePersonPaymentDeferrals } from "@/features/people/hooks/use-payment-deferrals";
import { cycleName, deferralView, type DeferralView } from "@/lib/engines/person-payment-deferral";
import { isInAppPath } from "@/lib/engines/linked-people-readiness";
import { peopleLedgerHref } from "@/features/people/lib/people-return-link";
import type { RecordPaymentInput } from "@/lib/repositories/person-payment-repository";
import { ShareStatementMode } from "@/features/people/components/workspace/share-statement-mode";
import { SplitExpenseMode } from "@/features/people/components/workspace/split-expense-mode";
import { TransactionLedgerMode, type LedgerView } from "@/features/people/components/workspace/transaction-ledger-mode";
import { cn } from "@/lib/utils";
import { toast } from "@/store/toast-store";

const toInputDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

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
const ACTION_SECONDARY = cn(
  WS_SECONDARY,
  "h-8 gap-1.5 rounded-full px-3 text-[12.5px] [&>svg]:text-foreground/70 lg:justify-center lg:px-2",
);

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

const TABS: readonly PersonTab[] = ["overview", "emis", "transactions", "details"];

/** `?tab=` wins; a deep link to one row (`?obligation=` without `settle`) or a return to the ledger opens Transactions. */
function initialTabFrom(initialView: "ledger" | null | undefined): PersonTab {
  if (typeof window === "undefined") return "overview";
  const params = new URLSearchParams(window.location.search);
  const asked = params.get("tab") as PersonTab | null;
  if (asked && TABS.includes(asked)) return asked;
  if (initialView === "ledger" || (params.get("obligation") && params.get("settle") !== "1")) return "transactions";
  return "overview";
}

/** One Overview card — a titled surface with an optional action on the right. */
function OverviewCard({ title, meta, action, children, className, testId }: { title: string; meta?: React.ReactNode; action?: React.ReactNode; children: React.ReactNode; className?: string; testId?: string }) {
  return (
    <section aria-label={title} data-testid={testId} className={cn("min-w-0 rounded-[14px] border border-border bg-card px-4 pt-3 pb-3.5 shadow-e1", className)}>
      <div className="mb-1.5 flex min-w-0 items-baseline gap-2">
        <h2 className="font-heading text-[14px] font-semibold text-foreground">{title}</h2>
        {meta && <span className="min-w-0 truncate text-[11.5px] font-medium text-foreground/55">{meta}</span>}
        {action && <span className="ml-auto shrink-0">{action}</span>}
      </div>
      {children}
    </section>
  );
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
  onEditPaymentDate,
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
  /** Changes only the date of one recorded payment, in place (`PersonPaymentRepository.editPaymentDate`). */
  onEditPaymentDate?: (paymentId: string, params: { date: Date; expectedDate: Date }) => Promise<void>;
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
  /** Which content tab is showing — Overview · Linked EMIs · Transactions · Details. Kept in `?tab=` so a reload stays put. */
  const [tab, setTabState] = useState<PersonTab>(() => initialTabFrom(initialView));
  const setTab = (next: PersonTab) => {
    setTabState(next);
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (next === "overview") params.delete("tab");
    else params.set("tab", next);
    const rest = params.toString();
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${rest ? `?${rest}` : ""}`);
  };
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
  const [paying, setPaying] = useState<{ preselectKey?: string | null; initial?: RecordPaymentInitial | null; intent?: "received" | "postpone"; alreadyReceived?: boolean } | null>(null);
  const [advanceOpen, setAdvanceOpen] = useState<"theyOwe" | "iOwe" | null>(null);
  // The obligation the Apply advance panel opens on (a lender payment's deep link, or Record payment's
  // "Apply advance instead"), and where to go once it is applied — the lender payment that sent the user here.
  const [advanceKey, setAdvanceKey] = useState<string | null>(null);
  const advanceReturnRef = useRef<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const { statement, allTimeStatement, ledgerEntries, isLoading, linkedEmis, linkedEmiSummaries, setRepays, advanceApplications } = usePersonCycleStatement(person.id, cycle);
  const { pending, trackedShareRefs: trackedAll, isLoading: sharesLoading } = usePersonPendingSplitParticipants(person.id);
  // Until expenses have loaded, whether a share is tracked is unknown — keep it conservative (null).
  const trackedShareRefs = sharesLoading ? null : trackedAll;
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
  // Payments toward the overall balance that no item carries (general payments) — open rows then point at the balance.
  const generalCredit = useMemo(() => generalCreditOf(allTimeStatement), [allTimeStatement]);
  const lookups = useMemo(
    () => ({ ...baseLookups, sourceReturn: { href: returnHref, label: person.name }, generalCredit }),
    [baseLookups, returnHref, person.name, generalCredit],
  );
  // Obligations dated before the selected cycle that are still open today — listed as "Brought forward"
  // with their source, so carried money never reads as a new expense. Engine rows, nothing recomputed.
  const carriedRows = useMemo(() => {
    const start = new Date(cycle.start.getFullYear(), cycle.start.getMonth(), cycle.start.getDate()).getTime();
    return allRows.filter((r) => r.statementRow?.kind === "obligation" && r.date.getTime() < start && (r.state === "open" || r.state === "partial"));
  }, [allRows, cycle]);
  const cycleLabelOf = (d: Date) => `${formatCycleLabel(cycleContaining(d, cycleStartDay), false)} cycle`;
  const scopeCounts = { cycle: cycleRows.length, all: allRows.length };
  // Bank-statement view: the running outstanding balance after every line (whole history, so it never depends on the
  // selected cycle) and each recorded payment as its own line. Derived from the rows — nothing is stored or recomputed.
  const statementBalances = useMemo(() => buildStatementBalances(allRows), [allRows]);
  const statementPaymentLines = useMemo(() => {
    const all = paymentLinesOf(allRows);
    if (scope === "all") return all;
    const from = new Date(cycle.start.getFullYear(), cycle.start.getMonth(), cycle.start.getDate()).getTime();
    const to = new Date(cycle.end.getFullYear(), cycle.end.getMonth(), cycle.end.getDate() + 1).getTime();
    return all.filter((l) => l.payment.date.getTime() >= from && l.payment.date.getTime() < to);
  }, [allRows, scope, cycle]);
  // The cycle view is always the cycle picked with ‹ › (shared by the statement, the list and the expanded ledger).
  const cycleLabel = "Selected cycle";
  const rowsLoading = isLoading || statement == null;
  // The selected cycle's previous pending — the engine's carried-forward balance (FlowFi sign: + they owe me) —
  // and what of it is still unpaid today: the earlier items' open remaining, as the rows already carry it.
  const carriedForward: CarriedForward | null = (() => {
    if (!statement || Math.abs(statement.previousPending) < 0.005) return null;
    const direction = statement.previousPending > 0 ? "theyOwe" : "iOwe";
    const left = carriedRows.filter((r) => r.direction === direction).reduce((s, r) => s + (r.remaining ?? 0), 0);
    return { amount: Math.abs(statement.previousPending), direction, left };
  })();
  // Primary transactions only — a payment recorded against a transaction is its history, not another transaction.
  const primaryCount = allRows.length;
  // Hero accents follow the overall direction — green when they owe you, red when you owe them.
  const heroRing = person.breakdown.toGive > person.breakdown.toReceive ? "ring-expense/70" : person.breakdown.toReceive > 0 ? "ring-success/70" : "ring-white/40";
  const heroGlow = person.breakdown.toGive > person.breakdown.toReceive ? "bg-expense/25" : "bg-success/25";
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
  function openPayment(next: { preselectKey?: string | null; initial?: RecordPaymentInitial | null; intent?: "received" | "postpone"; alreadyReceived?: boolean }) {
    setPaying(next);
    setSettlingKey(null);
    setEditingKey(null);
    if (mode.kind === "ledger") setLedgerView("settle");
    else {
      setInline("settle");
      rootRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }
  // The deferral context (built below, memoised) opens payments through this ref so it never captures a stale `mode`.
  const openPaymentRef = useRef(openPayment);
  useEffect(() => {
    openPaymentRef.current = openPayment;
  });
  const closePayment = () => {
    settleReturnRef.current = null;
    setPaying(null);
    setInline(null);
    setLedgerView("transactions");
  };

  // Deep link from a lender-payment gate (`?obligation=<key>&settle=1[&intent=postpone][&return=<path>]`): open
  // Record payment (or straight into "Postpone collection") with that exact obligation preselected, once. Once it
  // is recorded / postponed, go back to the lender payment it came from.
  const settleReturnRef = useRef<string | null>(null);
  const settleDeepLinkedRef = useRef(false);
  useEffect(() => {
    if (settleDeepLinkedRef.current || isLoading || onRecordPayment == null || typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const key = params.get("obligation");
    if (params.get("settle") !== "1" || !key || !allRows.some((r) => r.key === key)) return;
    settleDeepLinkedRef.current = true;
    const back = params.get("return");
    const intent = params.get("intent") === "postpone" ? ("postpone" as const) : undefined;
    requestAnimationFrame(() => {
      openPayment({ preselectKey: key, intent });
      settleReturnRef.current = back && isInAppPath(back) ? back : null;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot on load; `openPayment` is render-scoped
  }, [isLoading, allRows, onRecordPayment]);
  // Deep link from a Transaction's "Edit in People Ledger" (`?paymentTx=<cash-leg transaction id>`): opens that
  // exact payment's date dialog, once. Resolved from the live ledger — a payment that no longer exists says so.
  const [dateEdit, setDateEdit] = useState<{ paymentId: string; expectedDate: Date; amount: number; value: string } | null>(null);
  const [dateEditOpen, setDateEditOpen] = useState(false);
  const paymentTxHandledRef = useRef(false);
  const paymentTxTimerRef = useRef<number | null>(null);
  useEffect(() => () => { if (paymentTxTimerRef.current != null) window.clearTimeout(paymentTxTimerRef.current); }, []);
  useEffect(() => {
    if (paymentTxHandledRef.current || isLoading || typeof window === "undefined") return;
    const txId = new URLSearchParams(window.location.search).get("paymentTx");
    if (!txId) return;
    const consume = () => {
      paymentTxHandledRef.current = true;
      const params = new URLSearchParams(window.location.search);
      params.delete("paymentTx");
      const rest = params.toString();
      window.history.replaceState(window.history.state, "", `${window.location.pathname}${rest ? `?${rest}` : ""}`);
    };
    const group = ledgerEntries.filter((e) => e.deletedAt == null && e.paymentId != null && e.transactionRef === txId);
    if (group.length === 0) {
      if (ledgerEntries.some((e) => e.deletedAt == null && e.transactionRef === txId)) {
        consume();
        toast.error("This is a ledger entry, not a recorded payment", "Edit it from its row in this ledger.");
      } else if (paymentTxTimerRef.current == null) {
        // The ledger may still be loading on a fresh page open — only say it is gone after giving it time.
        paymentTxTimerRef.current = window.setTimeout(() => {
          if (paymentTxHandledRef.current) return;
          consume();
          toast.error("That payment isn't in this ledger any more", "It may have been edited or reverted. Check the ledger.");
        }, 8000);
      }
      return;
    }
    consume();
    const paymentId = group[0].paymentId!;
    const all = ledgerEntries.filter((e) => e.deletedAt == null && e.paymentId === paymentId);
    const amount = round2(all.reduce((sum, e) => sum + e.amount, 0));
    requestAnimationFrame(() => {
      setDateEdit({ paymentId, expectedDate: group[0].date, amount, value: toInputDate(group[0].date) });
      setDateEditOpen(true);
    });
  }, [isLoading, ledgerEntries]);
  // Advance held for / by this person, and the oldest obligation it could settle right now.
  const advanceAvailable = useMemo(() => advanceRemaining(advanceSources(ledgerEntries), advanceApplications), [ledgerEntries, advanceApplications]);
  const openObligations = useMemo(() => payableObligations(allRows), [allRows]);
  // Money this person already gave me that is still held (not applied) — Record payment offers applying it first.
  const advanceHeldFromThem = round2(advanceAvailable.filter((a) => a.side === "theyOwe").reduce((t, a) => t + a.remaining, 0));

  const paymentPanel =
    onRecordPayment != null ? (
      <RecordPaymentPanel
        key={`${paying?.preselectKey ?? ""}|${paying?.initial?.paymentId ?? ""}|${paying?.intent ?? ""}|${paying?.alreadyReceived ? "earlier" : ""}|${cycle.start.getTime()}`}
        cycle={cycle}
        cycleLabel={formatCycleLabel(cycle)}
        personName={person.name}
        rows={allRows}
        preselectKey={paying?.preselectKey}
        initial={paying?.initial}
        initialIntent={paying?.intent}
        initialInBalance={paying?.alreadyReceived === true}
        advanceHeld={onApplyAdvance ? advanceHeldFromThem : 0}
        onApplyAdvance={() => {
          // Applying moves no money (the advance already did). The lender payment this came from stays the way back.
          const back = settleReturnRef.current;
          const key = paying?.preselectKey ?? null;
          closePayment();
          // The Apply advance panel lives on the person's overview, under the expanded ledger.
          if (mode.kind === "ledger") {
            setDirection("back");
            setMode({ kind: "overview" });
          }
          advanceReturnRef.current = back;
          setAdvanceKey(key);
          setAdvanceOpen("theyOwe");
          // The Apply advance panel lives on the Overview tab.
          setTabState("overview");
          rootRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
        }}
        onCancel={closePayment}
        onSubmit={async (input, paymentId, options) => {
          await onRecordPayment(input, paymentId);
          const back = settleReturnRef.current;
          // The panel still postpones what stays unpaid — it closes itself (onComplete) once that is done.
          if (options?.keepOpen) return void toast.success("Payment recorded");
          toast.success(paymentId ? "Payment updated" : back ? "Payment recorded — back to your payment" : "Payment recorded");
          closePayment();
          if (back) router.push(back);
        }}
        onComplete={() => {
          const back = settleReturnRef.current;
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

  // Payment deferrals — expected-collection timing on open rows; status derived from each row's live remaining.
  const { deferrals } = usePersonPaymentDeferrals(person.id);
  const deferralActions = usePaymentDeferralActions();
  const deferralContext = useMemo<DeferralContextValue>(() => {
    const remainingByKey = new Map(allRows.map((r) => [r.key, r.remaining ?? 0]));
    const byKey = new Map<string, DeferralView>();
    for (const d of deferrals) {
      const view = deferralView(d, remainingByKey.get(d.obligationKey), cycleStartDay);
      if (view) byKey.set(d.obligationKey, view);
    }
    return {
      byKey,
      revisionByKey: new Map(deferrals.map((d) => [d.obligationKey, d.revision])),
      cycleStartDay,
      personName: person.name,
      onOpenPayment: onRecordPayment ? (key) => openPaymentRef.current({ preselectKey: key }) : undefined,
      onApply: async (request, options) => {
        const result = await deferralActions.apply({ ...request, personId: person.id, startDay: cycleStartDay, now: new Date() });
        // A multi-item postpone reports one consolidated result itself.
        if (result.outcome === "written" && !options?.silent) {
          if (request.action === "postpone") toast.success(`Payment moved to the ${cycleName(request.target)} cycle`, "Still owed — the original transaction and totals are unchanged.");
          else toast.success("Postponement undone");
        }
        return result.outcome;
      },
    };
  }, [allRows, deferrals, cycleStartDay, person.id, person.name, deferralActions, onRecordPayment]);
  // Postponed money is still owed — only its due date moved. Summed from the live deferral views (never from payments).
  const postponedSummary = useMemo(() => {
    const remainingByKey = new Map(allRows.map((r) => [r.key, r.remaining ?? 0]));
    let amount = 0;
    let until: Date | null = null;
    for (const d of deferrals) {
      const view = deferralView(d, remainingByKey.get(d.obligationKey), cycleStartDay);
      if (!view || view.status !== "postponed" || view.remaining < 0.005) continue;
      amount += view.remaining;
      if (view.date && (!until || view.date < until)) until = view.date;
    }
    return { amount, until: until ? formatStatementDate(until, true) : null };
  }, [allRows, deferrals, cycleStartDay]);
  const heldSides = advanceSides(advanceAvailable);
  // Deep link from a lender payment (`?applyAdvance=1&obligation=<key>`): opens the existing Apply advance panel
  // with that obligation preselected, once. Nothing is applied until the user confirms.
  const advanceDeepLinkedRef = useRef(false);
  const advanceTimerRef = useRef<number | null>(null);
  useEffect(() => () => { if (advanceTimerRef.current != null) window.clearTimeout(advanceTimerRef.current); }, []);
  const heldTheyOwe = heldSides.includes("theyOwe");
  useEffect(() => {
    if (advanceDeepLinkedRef.current || isLoading || typeof window === "undefined") return;
    if (new URLSearchParams(window.location.search).get("applyAdvance") !== "1") return;
    const consume = () => {
      advanceDeepLinkedRef.current = true;
      const params = new URLSearchParams(window.location.search);
      params.delete("applyAdvance");
      params.delete("obligation");
      const rest = params.toString();
      window.history.replaceState(window.history.state, "", `${window.location.pathname}${rest ? `?${rest}` : ""}`);
    };
    if (!onApplyAdvance || !heldTheyOwe) {
      // The ledger may still be loading on a fresh page open — only say there is none after giving it time.
      if (advanceTimerRef.current == null) {
        advanceTimerRef.current = window.setTimeout(() => {
          if (advanceDeepLinkedRef.current) return;
          consume();
          toast.error("No advance is available to apply", "Check the person's ledger for the receipt.");
        }, 8000);
      }
      return;
    }
    const params = new URLSearchParams(window.location.search);
    const key = params.get("obligation");
    const back = params.get("return");
    consume();
    requestAnimationFrame(() => {
      advanceReturnRef.current = back && isInAppPath(back) ? back : null;
      setAdvanceKey(key);
      setAdvanceOpen("theyOwe");
      setTabState("overview");
      rootRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }, [isLoading, onApplyAdvance, heldTheyOwe]);
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
      // A split share is settled as a real receipt through Record Payment's `split` route — one atomic write:
      // cash leg into the chosen account, the share's settlement entry and its tracking installment. Never a
      // ledger-only settlement (that cleared the receivable while no account received the money).
      if (!onRecordPayment) throw new Error("Not signed in");
      if (!values.accountId) throw new Error("Select the account it was received into.");
      await onRecordPayment(
        { direction: "theyPaid", amount: values.amount, date: values.date, accountId: values.accountId, lines: [{ key: row.key, amount: values.amount, route: routeFor(target) }], extra: null },
        null,
      );
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
    onSettleStart: (row, opts) => {
      // One Record payment flow for every obligation — with this row preselected.
      if (onRecordPayment) openPayment({ preselectKey: row.key, alreadyReceived: opts?.alreadyReceived });
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
    onPostpone: onRecordPayment ? (row) => openPayment({ preselectKey: row.key, intent: "postpone" }) : undefined,
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

  /** The Person's actions — Record payment is primary; Add, Split and Share are quieter, in one row under it. */
  const actionBar = (
    <div role="group" aria-label="Actions" className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={() => (inline === "settle" ? closePayment() : openPayment({}))}
        disabled={!rawPerson || !onRecordPayment}
        aria-expanded={inline === "settle"}
        aria-controls="person-inline-settle"
        title="Record money received from, or paid to, this person"
        className={cn(WS_PRIMARY, "h-10 w-full rounded-full px-5 text-[14px] shadow-[0_8px_20px_-10px_color-mix(in_oklch,var(--primary-accent-text)_70%,transparent)] transition-transform active:scale-[0.98]", inline === "settle" && "ring-2 ring-primary-accent-text/40")}
      >
        <HandCoins className="size-4" strokeWidth={2} />
        {inline === "settle" ? "Close" : "Record payment"}
      </button>
      <div className="grid grid-cols-3 gap-1.5">
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
    <p className="text-[11.5px] leading-relaxed text-foreground/65">
      Loans are settled from the Loan, outside this statement. Overall incl. loans: you need to receive {formatCurrency(person.breakdown.toReceive)}
      {" · "}you need to give {formatCurrency(person.breakdown.toGive)}
      {person.loanReceivable > 0 && ` · Loans — you need to receive ${formatCurrency(person.loanReceivable)}`}
      {person.loanPayable > 0 && ` · Loans — you need to give ${formatCurrency(person.loanPayable)}`}
    </p>
  );

  // Overall position — the header shows the two sides (and any advance) from the People engine's own breakdown; this card
  // explains them: the net (a summary line only — it never drives Record Payment, Full payment or allocation), what makes up
  // the balance, and the loans note. Nothing is re-summed here.
  const b = person.breakdown;
  const hasAdvance = Math.abs(b.advance) >= 0.005;
  const breakdownNote = Math.abs(b.unlinked) >= 0.005 || b.loanPayable > 0 || b.loanReceivable > 0 || b.emiReceivableOpen > 0;
  const showNet = (b.toGive > 0 && b.toReceive > 0) || (hasAdvance && (b.toGive > 0 || b.toReceive > 0));
  const overallDetails = (showNet || breakdownNote || loansNote) && (
    <div className="space-y-2 text-[12.5px] tabular-nums">
      {showNet && (
        // Secondary on purpose: the two sides are separate obligations — the net never means "nothing to do".
        <p className="text-foreground/75">
          {hasAdvance
            ? `Net position ${formatCurrency(Math.abs(b.net))} ${b.net > 0 ? "in your favour" : b.net < 0 ? `in ${firstName}'s favour` : "even"} · includes the advance held · Summary only.`
            : `Net ${formatCurrency(Math.abs(b.net))} ${b.net > 0 ? "to receive" : b.net < 0 ? "to give" : "even"} · Summary only — payments are settled separately.`}
        </p>
      )}
      {breakdownNote && (
        <dl className="divide-y divide-border-strong/45 rounded-[10px] bg-secondary/45 px-3 py-1" aria-label="How this is calculated">
          {[
            { label: "Open borrowed", value: formatCurrency(b.borrowedOpen) },
            { label: "Open given", value: formatCurrency(b.gaveOpen) },
            ...(Math.abs(b.unlinked) >= 0.005 ? [{ label: "Payments / adjustments not tied to one transaction", value: `${b.unlinked > 0 ? "+" : "−"}${formatCurrency(Math.abs(b.unlinked))}` }] : []),
            ...(b.emiReceivableOpen > 0 ? [{ label: "EMI shares — you need to receive", value: formatCurrency(b.emiReceivableOpen) }] : []),
            ...(b.loanReceivable > 0 ? [{ label: "Loans — you need to receive", value: formatCurrency(b.loanReceivable) }] : []),
            ...(b.loanPayable > 0 ? [{ label: "Loans — you need to give", value: formatCurrency(b.loanPayable) }] : []),
          ].map((l) => (
            <div key={l.label} className="flex items-baseline justify-between gap-3 py-1">
              <dt className="min-w-0 text-foreground/70">{l.label}</dt>
              <dd className="shrink-0 font-semibold text-foreground">{l.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {loansNote}
    </div>
  );

  // Linked EMI responsibility — for the header's third column and the tab's count / attention dot.
  const { savingId: savingLink, toggle: toggleRepays } = useRepaysToggle(setRepays);
  const emiCount = linkedEmiSummaries.length + linkedEmis.filter((x) => !linkedEmiSummaries.some((sm) => sm.key === `${x.kind}:${x.id}`)).length;
  const emiOverdue = linkedEmiSummaries.some((sm) => sm.status === "overdue");
  const upcomingTotal = upcomingEmi.reduce((t, e) => t + e.amount, 0);
  const emiColumn =
    emiCount > 0 || upcomingEmi.length > 0 ? (
      <EmiHeaderColumn
        summaries={linkedEmiSummaries}
        owedNow={b.emiReceivableOpen}
        fallbackLater={{ label: upcomingEmi.length > 0 ? `${upcomingEmi.length} upcoming` : "Upcoming", amount: upcomingTotal }}
      />
    ) : undefined;

  const highlights = (
    <>
      <DeferralCycleSummary cycle={cycle} />
      {upcomingEmi.length > 0 && (
        <span
          title={upcomingEmi.slice(0, 5).map((e) => `${e.label} · ${formatCurrency(e.amount)}`).join("\n")}
          className="inline-flex items-center gap-1 rounded-full bg-primary/20 px-2 py-0.5 text-[11.5px] font-medium text-foreground tabular-nums ring-1 ring-primary-accent-text/30"
        >
          <span className="text-[10px] font-bold tracking-wide text-primary-accent-text">EMI</span>
          {upcomingEmi.length} upcoming <span className="font-bold">{formatCurrency(upcomingTotal)}</span>
        </span>
      )}
    </>
  );

  /** Popups and inline panels the actions open — mounted once, whichever tab is showing. */
  const actionSurfaces = (
    <>
      <PeopleDrawer id="person-inline-add" compact width="sm" open={inline === "add" && onAddEntry != null} onOpenChange={(o) => !o && setInline(null)} title={`Add transaction with ${person.name}`}>
        {onAddEntry && <AddEntryPanel personName={person.name} onCancel={() => setInline(null)} onSave={saveNewEntry} />}
      </PeopleDrawer>
      {/* Record payment opens as the Transaction Details top sheet (the panel portals itself) — the person page stays underneath */}
      <div id="person-inline-settle">{rawPerson && inline === "settle" && paymentPanel != null && cloneElement(paymentPanel, { sheet: true })}</div>
      {/* Split is the one focused popup — the person page stays underneath, unchanged */}
      <PeopleDrawer id="person-inline-split" compact width="wide" open={inline === "split" && rawPerson != null} onOpenChange={(o) => !o && setInline(null)} title={`Split expense with ${person.name}`}>
        {rawPerson && (
          <SplitExpenseMode person={rawPerson} accounts={accounts} categories={categories} people={people} closeable onBack={() => setInline(null)} onDone={() => setInline(null)} />
        )}
      </PeopleDrawer>
    </>
  );

  const untiedOwed = generalCredit && generalCredit.theyOwe.credit >= 0.005 ? generalCredit.theyOwe.owed : null;
  const overviewTab = (
    <div className="flex flex-col gap-3">
      {/* 1 · The cycle maths, once: previous ± new − received = remaining, with how the payments were applied */}
      <PersonBalanceStory statement={statement} personName={person.name} isLoading={isLoading} />

      {/* 2 · What is still open (actionable) beside the linked agreements */}
      <div className={cn("grid items-start gap-3", linkedEmiSummaries.length > 0 && "xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]")}>
        <OverviewCard
          title="Open items"
          meta={openObligations.length > 0 ? `${openObligations.length} unpaid` : "all settled"}
          action={
            openObligations.length > 0 ? (
              <button type="button" onClick={() => setTab("transactions")} className="rounded-[6px] text-[12px] font-semibold text-primary-accent-text outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
                All transactions →
              </button>
            ) : undefined
          }
          testId="person-overview-open"
        >
          <PersonOpenItems
            personName={person.name}
            obligations={openObligations}
            onRecord={rawPerson && onRecordPayment ? (key) => openPayment({ preselectKey: key }) : undefined}
            onPostpone={rawPerson && onRecordPayment ? (key) => openPayment({ preselectKey: key, intent: "postpone" }) : undefined}
            generalCreditOwed={untiedOwed}
          />
        </OverviewCard>
        {linkedEmiSummaries.length > 0 && (
          <OverviewCard
            title="EMI agreements"
            meta={`${linkedEmiSummaries.length} linked`}
            action={
              <button type="button" onClick={() => setTab("emis")} className="rounded-[6px] text-[12px] font-semibold text-primary-accent-text outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
                Linked EMIs →
              </button>
            }
            testId="person-overview-emis"
          >
            <EmiAgreementList personName={person.name} summaries={linkedEmiSummaries} onOpen={() => setTab("emis")} />
          </OverviewCard>
        )}
      </div>

      {/* 3 · Secondary details, on demand */}
      <details data-testid="person-overview-more" className="group rounded-[14px] border border-border bg-card shadow-e1 open:pb-3.5">
        <summary className="flex cursor-pointer list-none items-center gap-2 rounded-[14px] px-4 py-2.5 text-[12.5px] font-semibold text-foreground outline-none hover:bg-secondary/50 focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          <ChevronRight className="size-4 text-muted-foreground transition-transform duration-200 group-open:rotate-90" aria-hidden />
          More details
          <span className="truncate text-[11.5px] font-medium text-muted-foreground">All time with {firstName} · how it&apos;s calculated · each payment · postponements</span>
        </summary>
        {!isLoading && statement && (
          <div className="grid gap-x-6 gap-y-4 px-4 pt-1 duration-200 animate-in fade-in-0 xl:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-4">
              {overallDetails && (
                <div>
                  <p className="mb-1 text-[11px] font-semibold text-muted-foreground">All time</p>
                  {overallDetails}
                </div>
              )}
              <div className="flex flex-wrap items-center gap-1.5 empty:hidden">{highlights}</div>
              <div id="person-payment-history" data-testid="payment-history-details">
                <p className="mb-1 text-[11px] font-semibold text-muted-foreground">Each payment and what it was applied to</p>
                <CyclePaymentHistory statement={statement} personName={person.name} accountForEntry={lookups.accountForEntry} incomeForEntry={lookups.incomeForEntry} className="[&>h3]:sr-only" />
              </div>
            </div>
            <div className="min-w-0 space-y-3">
              <p className="text-[11px] font-semibold text-muted-foreground">How this cycle is calculated</p>
              <StatementBreakdown statement={statement} />
              <StatementCalculation statement={statement} />
            </div>
          </div>
        )}
      </details>
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
            preselectKey={side === "theyOwe" ? advanceKey : null}
            onOpenChange={(o) => {
              setAdvanceOpen(o ? side : null);
              if (!o) advanceReturnRef.current = null;
            }}
            onConfirm={async (targets) => {
              await onApplyAdvance({ targets, date: new Date() });
              const back = advanceReturnRef.current;
              advanceReturnRef.current = null;
              toast.success(back ? "Advance applied — no money moved. Back to your payment" : "Advance applied");
              if (back) router.push(back);
            }}
          />
        ))}
    </div>
  );

  const emisTab = (
    <section aria-label="Linked EMIs" id="person-linked-emis" className={cn(emiCount === 0 && "rounded-[16px] border border-border bg-card p-4 shadow-e1")}>
      {emiCount > 0 ? (
        <LinkedEmisPanel personName={person.name} summaries={linkedEmiSummaries} sources={linkedEmis} savingId={savingLink} onToggle={toggleRepays} generalCredit={generalCredit} />
      ) : (
        <div className="flex flex-col items-start gap-1 py-6">
          <p className="text-sm font-semibold text-foreground">No EMIs linked to {firstName}</p>
          <p className="text-[12.5px] text-foreground/60">Share a Loan or EMI with {firstName} from its own screen — their monthly share, payments and progress then show up here.</p>
        </div>
      )}
    </section>
  );

  const transactionsTab = (
    <section id="person-sec-transactions" aria-label="Activity" className="flex min-w-0 flex-col">
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
        paymentLines={statementPaymentLines}
        balances={statementBalances}
        outstanding={{ toReceive: person.breakdown.toReceive, toGive: person.breakdown.toGive }}
        postponed={postponedSummary}
        cycleLabel={cycleLabel}
        onAdd={onAddEntry ? () => setInline("add") : undefined}
        onExpand={() => go({ kind: "ledger" })}
        handlers={rowHandlers}
        carriedForward={carriedForward}
      />
    </section>
  );

  const detailsTab = (
    <section id="person-sec-details" aria-label="Details" className="rounded-[16px] border border-border bg-card p-4 shadow-e1">
      <div id="person-details" className="grid gap-x-8 gap-y-5 sm:grid-cols-2 xl:grid-cols-4">
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
    </section>
  );

  const tabPanels: Record<PersonTab, React.ReactNode> = { overview: overviewTab, emis: emisTab, transactions: transactionsTab, details: detailsTab };
  const overview = (
    <>
      <div
        key={tab}
        role="tabpanel"
        id={personTabPanelId(tab)}
        aria-labelledby={personTabId(tab)}
        className="min-w-0 animate-in duration-200 ease-out fade-in-0 slide-in-from-bottom-1 motion-reduce:animate-none"
      >
        {tabPanels[tab]}
      </div>
      {actionSurfaces}
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
        personId={person.id}
        personName={person.name}
        rows={scopeRows}
        carriedRows={carriedRows}
        paymentLines={statementPaymentLines}
        balances={statementBalances}
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
    <DeferralContext.Provider value={deferralContext}>
    <div ref={rootRef} onKeyDown={onKeyDown} className="isolate flex min-w-0 scroll-mt-6 flex-col gap-3 px-1">
      {/* `isolate`: the sticky tab bar (z-20) and sticky table headers stay ordered among themselves but can no longer
          out-stack the dialogs/sheets (--z-dialog, portaled to <body>) opened from this page. */}
      {/* Identity + money at a glance — one compact card: who (on the brand band), then this cycle's settlement, the overall
          position, EMI responsibility and the actions. Every mode renders below it. */}
      <header ref={headerRef} className="overflow-hidden rounded-[18px] border border-border bg-card shadow-e1 duration-300 animate-in fade-in-0">
        <div className="relative flex items-center gap-3 overflow-hidden bg-[image:var(--gradient-hero)] px-4 py-2.5 text-white">
          <span aria-hidden className={cn("pointer-events-none absolute -top-16 -right-10 size-40 rounded-full blur-3xl", heroGlow)} />
          <span aria-hidden className="pointer-events-none absolute -bottom-20 left-1/3 size-40 rounded-full border border-white/10" />
          <span className={cn("relative shrink-0 rounded-full ring-2 ring-offset-2 ring-offset-surface-hero", heroRing)}>
            <ClayAvatar name={person.name} size={38} fallbackClassName="bg-white/15 text-[15px] font-semibold text-white" />
          </span>
          <div className="relative flex min-w-0 flex-1 items-center gap-x-3 gap-y-0">
            <h1 className="truncate font-heading text-[20px] leading-tight font-bold tracking-tight">{person.name}</h1>
            <p className="truncate rounded-full bg-white/10 px-2.5 py-0.5 text-[12px] font-medium text-white/75 ring-1 ring-white/10 ring-inset">{subline}</p>
          </div>
          <div className="relative flex shrink-0 items-center gap-1 [&_button]:border-white/20 [&_button]:bg-white/10 [&_button]:text-white [&_button:hover]:bg-white/20 [&_svg]:text-white!">
            <button type="button" onClick={onBack} title="Back to People Ledger" className={BACK_BUTTON}>
              <ArrowLeft className="size-4" strokeWidth={2} />
              <span className="hidden sm:inline">People Ledger</span>
              <span className="sr-only sm:hidden">Back to People Ledger</span>
            </button>
            <span className="mx-1 h-5 w-px bg-white/25" aria-hidden />
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
                    <DropdownMenuItem variant="destructive" disabled={bulkPlan.entries.length === 0} onSelect={openBulkDelete}>
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
        </div>
        <div className="flex flex-col gap-3 px-3.5 py-3 lg:flex-row lg:items-stretch lg:gap-5">
          <div className="min-w-0 flex-1">
            <PersonSettlementStrip
              statement={statement}
              isLoading={isLoading}
              cycle={cycle}
              onCycleChange={setCycle}
              firstName={firstName}
              overall={{ toReceive: b.toReceive, toGive: b.toGive, advance: b.advance }}
              third={emiColumn}
            />
          </div>
          <div className="shrink-0 lg:w-[14rem] lg:border-l lg:border-border-strong/60 lg:pl-5">{actionBar}</div>
        </div>
      </header>

      {/* Sticky tabs — Overview / Linked EMIs / Transactions / Details switch the content below; once the header scrolls away
          the bar also carries the name, the balance and Record payment. */}
      {(mode.kind === "overview" || mode.kind === "ledger" || mode.kind === "share") && (
        <PersonTabBar
          tabs={[
            { id: "overview", label: "Overview" },
            { id: "emis", label: "Linked EMIs", count: emiCount, alert: emiOverdue },
            { id: "transactions", label: "Transactions", count: scopeCounts[scope] },
            { id: "details", label: "Details" },
          ]}
          active={tab}
          onChange={setTab}
          watchRef={headerRef}
          name={person.name}
          balance={
            statement == null
              ? null
              : statement.toReceive > 0 && statement.toGive > 0
                ? `${money(statement.toReceive)} to receive · ${money(statement.toGive)} to give`
                : statement.direction === "theyOwe"
                  ? `${money(statement.amount)} to receive`
                  : statement.direction === "iOwe"
                    ? `${money(statement.amount)} to give`
                    : "All settled"
          }
          balanceTone={statement?.direction === "theyOwe" ? "text-settle-receivable-text" : statement?.direction === "iOwe" ? "text-settle-payable-text" : "text-success"}
          onRecordPayment={() => (inline === "settle" ? undefined : openPayment({}))}
          recordDisabled={!rawPerson || !onRecordPayment}
        />
      )}

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
      <PeopleDrawer width="lg" open={mode.kind === "share" && statement != null} onOpenChange={(o) => !o && back()} title={`Share ${person.name}'s statement`}>
        {mode.kind === "share" && content}
      </PeopleDrawer>

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
          open={dateEditOpen && dateEdit != null && onEditPaymentDate != null}
          onOpenChange={setDateEditOpen}
          variant="reverse"
          title="Change payment date"
          confirmLabel="Save date"
          busyLabel="Saving…"
          disabled={dateEdit == null || dateEdit.value === "" || dateEdit.value === toInputDate(dateEdit.expectedDate)}
          onConfirm={async () => {
            if (!dateEdit || !onEditPaymentDate) return;
            try {
              const [y, m, d] = dateEdit.value.split("-").map(Number);
              await onEditPaymentDate(dateEdit.paymentId, { date: new Date(y, m - 1, d), expectedDate: dateEdit.expectedDate });
              toast.success("Payment date updated");
            } catch (e) {
              toast.error("Couldn't change the date", e instanceof Error ? e.message : "Please try again.");
              throw e;
            }
          }}
        >
          {dateEdit && (
            <>
              <p className="font-medium text-foreground">
                {money(dateEdit.amount)} · currently {formatStatementDate(dateEdit.expectedDate, true)}
              </p>
              <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                New date
                <DateInput className={WS_FIELD} value={dateEdit.value} onChange={(e) => setDateEdit({ ...dateEdit, value: e.target.value })} />
              </label>
              <p>Only the date changes. The amount, account balance and what this payment settled stay exactly as they are.</p>
            </>
          )}
        </LedgerConfirmDialog>
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
    </DeferralContext.Provider>
    </FollowUpContext.Provider>
  );
}
