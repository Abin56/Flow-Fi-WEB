"use client";

/**
 * Top-level orchestrator for the SMS Transaction Candidates review queue —
 * the web side of Transaction Intelligence. Deliberately its own flat
 * feature/route (see this folder's module doc / docs/adr/ADR-009), not a
 * tab bolted onto `features/transaction-studio/`, which is hard-wired to a
 * single `documentId`. Visually borrows Transaction Studio's tone
 * vocabulary and status-badge/row-tint conventions without importing its
 * TanStack `GridRow`/`StagedRecord`-typed grid or commit machinery.
 *
 * List → detail → rules flow mirrors Transaction Studio's own UX (click a
 * row for a docked detail view, select rows for a floating bulk-action bar,
 * an actionable "possible duplicates" panel standing in for a rules
 * engine) — built on the same generic `components/finance/*` primitives
 * `features/transactions/` (the plain transaction list) already uses for
 * exactly this pattern (`FinanceTable` + `onRowClick` → `DetailDrawer`,
 * `BulkActionsBar`), not Transaction Studio's bespoke `GridRow`-typed
 * `RightSidebar`/`Spreadsheet`, since a candidate has nothing
 * inline-editable (see `lib/models/sms-transaction-candidate.ts`'s module
 * doc — Android-owned, web-writable only via full delete).
 */

import { MessageSquareText, Maximize2, Minimize2, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ClayButton } from "@/components/clay/clay-button";
import { BulkActionsBar, ConfirmDialog, EmptyState, FinanceTable, type FinanceTableColumn } from "@/components/finance";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useAccounts } from "@/hooks/use-accounts";
import { useCategories } from "@/hooks/use-categories";
import { useCreditCards } from "@/hooks/use-credit-cards";
import { usePeople } from "@/hooks/use-people";
import { useSmsTransactionCandidates } from "@/hooks/use-sms-transaction-candidates";
import { useTransactions } from "@/hooks/use-transactions";
import {
  createAccountRepository,
  createExpenseRepository,
  createPersonRepository,
  createSmsTransactionCandidateRepository,
  createTransactionRepository,
} from "@/lib/repositories/repository-factory";
import { smsCandidateEventTypeLabel, type SmsTransactionCandidate } from "@/lib/models/sms-transaction-candidate";
import { useAuthStore } from "@/store/auth-store";
import { toast } from "@/store/toast-store";
import { DuplicateWarningDialog } from "@/lib/services/duplicate-detection/duplicate-warning-dialog";
import type { DuplicateDetectionResult, ExistingTransactionForDuplicateCheck } from "@/lib/services/duplicate-detection/duplicate-detection-service";
import { formatMatchedAccountLabel, formatUnresolvedAccountHint } from "../lib/candidate-account-matching";
import { buildDestinationOptions } from "../lib/candidate-details-view";
import { evaluateCandidateDuplicate, type CandidateDuplicateResult } from "../lib/candidate-duplicate";
import { deriveCandidateStatus } from "../lib/candidate-status";
import {
  applyCandidateSearchAndFilters,
  applyCandidateTabFilter,
  DEFAULT_CANDIDATE_FILTERS,
  deriveActiveCandidateTab,
  deriveCandidateMonthOptions,
  type CandidateFilters,
  type CandidateTabKey,
  type DuplicatesByCandidateId,
} from "../lib/filters";
import { scheduleDelayedDismiss } from "../lib/delayed-dismiss";
import { bulkImportCandidates, ignoreCandidate } from "../lib/import-candidate";
import { BulkImportDialog, type BulkImportSelection } from "./bulk-import-dialog";
import { CandidateDetailsModal } from "./candidate-details-modal";
import { CandidateStatusBadge } from "./candidate-status-badge";
import { IgnoreCandidateButton } from "./ignore-candidate-button";

const TAB_LABELS: Record<CandidateTabKey, string> = {
  all: "All",
  needsReview: "Needs Review",
  duplicates: "Duplicates",
  readyToImport: "Ready to Import",
  unmatched: "Unmatched",
};

const TAB_ORDER: CandidateTabKey[] = ["all", "needsReview", "duplicates", "readyToImport", "unmatched"];

const CONFIDENCE_LABEL: Record<SmsTransactionCandidate["confidenceLevel"], string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};

const MONTH_LABEL_FORMAT = new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric" });

/** `"2026-08"` -> `"August 2026"` — the month filter's option label. */
function formatMonthOptionLabel(monthKey: string): string {
  const [year, month] = monthKey.split("-").map(Number);
  return MONTH_LABEL_FORMAT.format(new Date(year, month - 1, 1));
}

export function TransactionCandidatesWorkspace() {
  const uid = useAuthStore((s) => s.user?.uid);
  const { data: liveCandidates = [], isLoading } = useSmsTransactionCandidates();
  const { data: accounts = [] } = useAccounts();
  const { data: creditCards = [] } = useCreditCards();
  const { data: categories = [] } = useCategories();
  const { data: transactions = [] } = useTransactions();
  const { data: people = [] } = usePeople();

  const repositories = useMemo(() => {
    if (!uid) return null;
    const accountRepository = createAccountRepository(uid);
    return {
      transactionRepository: createTransactionRepository(uid, accountRepository),
      candidateRepository: createSmsTransactionCandidateRepository(uid),
      expenseRepository: createExpenseRepository(uid, accountRepository),
      personRepository: createPersonRepository(uid),
    };
  }, [uid]);

  const [detailCandidate, setDetailCandidate] = useState<SmsTransactionCandidate | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDismissConfirmOpen, setBulkDismissConfirmOpen] = useState(false);
  const [bulkRunning, setBulkRunning] = useState(false);
  const [bulkImportDialogOpen, setBulkImportDialogOpen] = useState(false);
  // The category/destination the user picked in `BulkImportDialog` for the batch currently being
  // imported — kept around (rather than only threaded through a function argument) so a duplicate
  // detected mid-batch can be retried via `handleBulkImportDuplicatesAnyway` with the same forced
  // destination the user already chose, without reopening the dialog.
  const [bulkSelection, setBulkSelection] = useState<BulkImportSelection | null>(null);
  // Rows `bulkImportCandidates` flagged as `duplicate_detected` on the last attempt — nothing was
  // written for these yet. Confirming past `DuplicateWarningDialog` re-runs the import for exactly
  // these candidate ids with `skipDuplicateCheck: true`; cancelling just clears this (candidates and
  // any already-succeeded rows from the same batch are untouched either way).
  const [bulkDuplicateState, setBulkDuplicateState] = useState<{ result: DuplicateDetectionResult; additionalCount: number; candidateIds: string[] } | null>(
    null,
  );

  // Same fullscreen pattern as Transaction Studio's own toggle — `fixed inset-0` overlay, Escape to exit.
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    if (!fullscreen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setFullscreen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [fullscreen]);

  // Ids whose Dismiss is currently in its undo window (see `delayed-dismiss.ts`) — hidden from every
  // view of the list immediately, before the real Firestore delete actually runs.
  const [pendingDismissIds, setPendingDismissIds] = useState<Set<string>>(new Set());
  const hideCandidate = (candidateId: string) => setPendingDismissIds((prev) => new Set(prev).add(candidateId));
  const unhideCandidate = (candidateId: string) =>
    setPendingDismissIds((prev) => {
      if (!prev.has(candidateId)) return prev;
      const next = new Set(prev);
      next.delete(candidateId);
      return next;
    });

  const candidates = useMemo(() => liveCandidates.filter((c) => !pendingDismissIds.has(c.id)), [liveCandidates, pendingDismissIds]);

  const duplicates: DuplicatesByCandidateId = useMemo(() => {
    const map = new Map<string, CandidateDuplicateResult>();
    for (const candidate of candidates) {
      const result = evaluateCandidateDuplicate(candidate, transactions);
      if (result.duplicateOfTransactionId != null) map.set(candidate.id, result);
    }
    return map;
  }, [candidates, transactions]);
  const transactionById = useMemo(() => new Map(transactions.map((t) => [t.id, t])), [transactions]);
  // Source-agnostic — manual entry, PDF import, and prior SMS imports are all just `Transaction`
  // records here, exactly like `checkForDuplicates` itself has no opinion on where they came from.
  // Passed straight through to `importCandidate`'s own fresh, immediately-before-write duplicate
  // check (see that module's doc comment) rather than only feeding the list-level `duplicates` map
  // above, which is display-only.
  const existingTransactionsForDuplicateCheck: ExistingTransactionForDuplicateCheck[] = useMemo(
    () => transactions.map((t) => ({ id: t.id, description: t.description, amount: t.amount, dateTime: t.dateTime, accountId: t.accountId, type: t.type })),
    [transactions],
  );

  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState(DEFAULT_CANDIDATE_FILTERS);
  const activeTab = deriveActiveCandidateTab(filters);
  // Only accounts/cards at least one candidate actually resolved to — not every account/card in the
  // whole app (which produced a long, often-duplicate-looking list unrelated to what's being reviewed).
  const destinationOptions = useMemo(() => {
    const linkedKeys = new Set(candidates.flatMap((c) => [c.accountId && `account:${c.accountId}`, c.cardId && `card:${c.cardId}`].filter((k): k is string => !!k)));
    return buildDestinationOptions(accounts, creditCards).filter((opt) => linkedKeys.has(opt.key));
  }, [candidates, accounts, creditCards]);
  const monthOptions = useMemo(() => deriveCandidateMonthOptions(candidates), [candidates]);

  const visibleCandidates = useMemo(
    () => applyCandidateSearchAndFilters(candidates, search, filters, duplicates),
    [candidates, search, filters, duplicates],
  );

  const candidateById = useMemo(() => new Map(candidates.map((c) => [c.id, c])), [candidates]);
  // Selection is locked to whichever direction (income/expense) the first selected row belongs to —
  // a bulk import applies one category/account to the whole batch, which only makes sense for
  // transactions of the same type. `null` once nothing is selected, so either direction can start a
  // fresh selection.
  const selectionDirection = useMemo(() => {
    const first = candidates.find((c) => selectedIds.has(c.id));
    return first?.direction ?? null;
  }, [candidates, selectedIds]);

  const selectableVisibleCandidates = selectionDirection
    ? visibleCandidates.filter((c) => c.direction === selectionDirection)
    : visibleCandidates;
  const allVisibleSelected = selectableVisibleCandidates.length > 0 && selectableVisibleCandidates.every((c) => selectedIds.has(c.id));
  const someVisibleSelected = selectableVisibleCandidates.some((c) => selectedIds.has(c.id));

  function toggleSelectAllVisible(checked: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const c of selectableVisibleCandidates) {
        if (checked) next.add(c.id);
        else next.delete(c.id);
      }
      return next;
    });
  }

  function toggleRowSelected(candidateId: string, checked: boolean) {
    if (checked && selectionDirection) {
      const candidate = candidateById.get(candidateId);
      if (candidate && candidate.direction !== selectionDirection) {
        toast.error(
          "Can't mix income and expense",
          `Clear the current selection first — you're selecting ${selectionDirection === "credit" ? "income" : "expense"} transactions.`,
        );
        return;
      }
    }
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(candidateId);
      else next.delete(candidateId);
      return next;
    });
  }

  const selectedCandidates = useMemo(() => candidates.filter((c) => selectedIds.has(c.id)), [candidates, selectedIds]);

  /**
   * Runs `bulkImportCandidates` for exactly `candidatesToImport`, against the live
   * `existingTransactionsForDuplicateCheck` (source-agnostic — manual, PDF, and prior SMS imports
   * alike). A row flagged `duplicate_detected` performs no write and is collected into
   * `bulkDuplicateState`; everything else (success or a genuine write failure) is reported via toast
   * exactly as before. `force` is only ever `true` when re-invoked from the
   * `DuplicateWarningDialog`'s "Import anyway" — it re-imports only the previously-flagged rows, not
   * the whole original selection, so already-succeeded rows are never retried.
   */
  async function runBulkImport(candidatesToImport: SmsTransactionCandidate[], force: boolean, selection: BulkImportSelection) {
    if (!repositories || candidatesToImport.length === 0) return;
    setBulkRunning(true);
    try {
      const results = await bulkImportCandidates(
        candidatesToImport,
        selection.categoryId,
        creditCards,
        repositories.transactionRepository,
        repositories.candidateRepository,
        repositories.expenseRepository,
        existingTransactionsForDuplicateCheck,
        force,
        { accountId: selection.accountId, matchedCard: selection.matchedCard },
        selection.personAssignment,
      );
      const succeededIds = results.filter((r) => r.outcome.status === "success").map((r) => r.candidateId);
      const duplicateRows = results.filter(
        (r): r is { candidateId: string; outcome: Extract<(typeof results)[number]["outcome"], { status: "duplicate_detected" }> } =>
          r.outcome.status === "duplicate_detected",
      );
      const otherFailedCount = results.length - succeededIds.length - duplicateRows.length;

      if (duplicateRows.length > 0) {
        const strongest = duplicateRows.reduce((best, r) => (r.outcome.result.bestMatch!.confidence > best.outcome.result.bestMatch!.confidence ? r : best));
        setBulkDuplicateState({
          result: strongest.outcome.result,
          additionalCount: duplicateRows.length - 1,
          candidateIds: duplicateRows.map((r) => r.candidateId),
        });
      } else {
        setBulkDuplicateState(null);
      }

      if (succeededIds.length > 0 || otherFailedCount > 0) {
        const parts: string[] = [];
        if (succeededIds.length > 0) parts.push(`${succeededIds.length} imported`);
        if (duplicateRows.length > 0) parts.push(`${duplicateRows.length} flagged as possible duplicates`);
        if (otherFailedCount > 0) parts.push(`${otherFailedCount} failed`);
        if (otherFailedCount === 0) toast.success("Import complete", parts.join(", ") + ".");
        else toast.error("Some candidates couldn't be imported", parts.join(", ") + " — failed rows are still pending, try again.");
      }

      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const id of succeededIds) next.delete(id);
        return next;
      });
    } finally {
      setBulkRunning(false);
    }
  }

  function handleBulkImportConfirm(selection: BulkImportSelection) {
    if (!repositories || selectedCandidates.length === 0) return;
    setBulkSelection(selection);
    setBulkImportDialogOpen(false);
    void runBulkImport(selectedCandidates, false, selection);
  }

  function handleBulkImportDuplicatesAnyway() {
    if (!bulkDuplicateState || !bulkSelection) return;
    const flaggedIds = new Set(bulkDuplicateState.candidateIds);
    const candidatesToRetry = selectedCandidates.filter((c) => flaggedIds.has(c.id));
    setBulkDuplicateState(null);
    void runBulkImport(candidatesToRetry, true, bulkSelection);
  }

  function handleBulkDismissSelected() {
    if (!repositories || selectedCandidates.length === 0) return;
    const candidatesToDismiss = selectedCandidates;
    const cancels = candidatesToDismiss.map(
      (c) =>
        scheduleDelayedDismiss({
          candidateId: c.id,
          hide: hideCandidate,
          unhide: unhideCandidate,
          commitDelete: () => ignoreCandidate(c, repositories.candidateRepository),
          onDeleteFailed: (error) => {
            toast.error("Couldn't dismiss a candidate", error instanceof Error ? error.message : "Still pending, try again.");
          },
        }).cancel,
    );
    toast.success("Dismissed", `${candidatesToDismiss.length} candidate${candidatesToDismiss.length === 1 ? "" : "s"} won't show in the review queue.`, {
      label: "Undo",
      onClick: () => cancels.forEach((cancel) => cancel()),
    });
    setSelectedIds(new Set());
    setBulkDismissConfirmOpen(false);
  }

  const counts = useMemo(() => {
    const base: CandidateFilters = {
      ...DEFAULT_CANDIDATE_FILTERS,
      accountFilter: filters.accountFilter,
      month: filters.month,
      direction: filters.direction,
    };
    return {
      all: applyCandidateSearchAndFilters(candidates, "", base, duplicates).length,
      needsReview: applyCandidateSearchAndFilters(candidates, "", applyCandidateTabFilter(base, "needsReview"), duplicates).length,
      duplicates: applyCandidateSearchAndFilters(candidates, "", applyCandidateTabFilter(base, "duplicates"), duplicates).length,
      readyToImport: applyCandidateSearchAndFilters(candidates, "", applyCandidateTabFilter(base, "readyToImport"), duplicates).length,
      unmatched: applyCandidateSearchAndFilters(candidates, "", applyCandidateTabFilter(base, "unmatched"), duplicates).length,
    } satisfies Record<CandidateTabKey, number>;
  }, [candidates, duplicates, filters.accountFilter, filters.month, filters.direction]);

  const columns: FinanceTableColumn<SmsTransactionCandidate>[] = [
    {
      id: "select",
      header: (
        <Checkbox
          checked={allVisibleSelected ? true : someVisibleSelected ? "indeterminate" : false}
          onCheckedChange={(checked) => toggleSelectAllVisible(checked === true)}
          onClick={(e) => e.stopPropagation()}
          aria-label="Select all visible candidates"
        />
      ),
      width: "36px",
      accessor: (c) => {
        const disabled = selectionDirection != null && c.direction !== selectionDirection && !selectedIds.has(c.id);
        return (
          <Checkbox
            checked={selectedIds.has(c.id)}
            disabled={disabled}
            onCheckedChange={(checked) => toggleRowSelected(c.id, checked === true)}
            onClick={(e) => e.stopPropagation()}
            aria-label={`Select ${c.merchant ?? c.bankName ?? "candidate"}`}
            title={disabled ? `Clear the current selection first — you're selecting ${selectionDirection === "credit" ? "income" : "expense"} transactions.` : undefined}
          />
        );
      },
    },
    {
      id: "no",
      header: "No",
      width: "44px",
      accessor: (c) => (
        <span className="text-xs tabular-nums text-muted-foreground">
          {String(visibleCandidates.findIndex((v) => v.id === c.id) + 1).padStart(2, "0")}
        </span>
      ),
    },
    {
      id: "status",
      header: "Status",
      width: "160px",
      accessor: (c) => <CandidateStatusBadge candidate={c} duplicate={duplicates.get(c.id) ?? null} />,
    },
    {
      id: "date",
      header: "Date",
      width: "110px",
      accessor: (c) => c.transactionDate.toLocaleDateString("en-IN", { day: "2-digit", month: "short" }),
      hideOnMobile: true,
    },
    {
      id: "merchant",
      header: "Merchant",
      minWidth: "180px",
      accessor: (c) => (
        <div className="flex flex-col">
          <span className="font-medium text-foreground">{c.merchant ?? c.bankName ?? "Unknown"}</span>
          <span className="text-xs text-muted-foreground">{smsCandidateEventTypeLabel(c.eventType)}</span>
        </div>
      ),
    },
    {
      id: "amount",
      header: "Amount",
      width: "130px",
      numeric: true,
      accessor: (c) => (
        <span className={cn(c.direction === "credit" ? "text-success" : "text-foreground")}>
          {c.direction === "credit" ? "+" : "-"}
          {formatCurrency(c.amount)}
        </span>
      ),
    },
    {
      id: "bank",
      header: "Bank",
      width: "100px",
      accessor: (c) => c.bankName ?? "—",
      hideOnMobile: true,
    },
    {
      id: "account",
      header: "Account / Card",
      minWidth: "180px",
      accessor: (c) => {
        const label = formatMatchedAccountLabel(c, accounts, creditCards);
        return label ?? <span className="text-muted-foreground">{formatUnresolvedAccountHint(c)}</span>;
      },
    },
    {
      id: "confidence",
      header: "Confidence",
      width: "110px",
      accessor: (c) => CONFIDENCE_LABEL[c.confidenceLevel],
      hideOnMobile: true,
    },
    {
      id: "actions",
      header: "",
      width: "170px",
      accessor: (c) =>
        repositories ? (
          <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
            <ClayButton variant="primary" size="sm" onClick={() => setDetailCandidate(c)}>
              Import
            </ClayButton>
            <IgnoreCandidateButton
              candidate={c}
              candidateRepository={repositories.candidateRepository}
              onHide={hideCandidate}
              onUnhide={unhideCandidate}
            />
          </div>
        ) : null,
    },
  ];

  const detailDuplicate = detailCandidate ? (duplicates.get(detailCandidate.id) ?? null) : null;
  const detailMatchedTransaction = detailDuplicate?.duplicateOfTransactionId
    ? (transactionById.get(detailDuplicate.duplicateOfTransactionId) ?? null)
    : null;

  return (
    <div
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-hidden p-6",
        fullscreen && "fixed inset-0 z-50 !flex-none bg-background p-4",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-foreground">SMS Transaction Candidates</h1>
          <p className="text-sm text-muted-foreground">
            Review transactions detected from SMS before they become real transactions.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ClayButton
            variant="secondary"
            size="icon"
            aria-label={fullscreen ? "Exit full screen" : "Full screen"}
            title={fullscreen ? "Exit full screen (Esc)" : "Full screen"}
            onClick={() => setFullscreen((v) => !v)}
          >
            {fullscreen ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
          </ClayButton>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {TAB_ORDER.map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() =>
              setFilters((f) =>
                tab === "all"
                  ? { ...DEFAULT_CANDIDATE_FILTERS, accountFilter: f.accountFilter, month: f.month, direction: f.direction }
                  : applyCandidateTabFilter(f, tab),
              )
            }
            className={cn(
              "flex flex-col items-start gap-0.5 rounded-2xl border border-border/60 bg-card px-4 py-3 text-left transition-colors",
              activeTab === tab ? "border-primary/60 bg-primary/5" : "hover:bg-muted/40",
            )}
          >
            <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{TAB_LABELS[tab]}</span>
            <span className="text-lg font-semibold text-foreground">{counts[tab]}</span>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative max-w-sm flex-1">
          <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search merchant, reference, bank..."
            className="pl-9"
          />
        </div>
        <Select value={filters.month ?? "all"} onValueChange={(v) => setFilters((f) => ({ ...f, month: v === "all" ? null : v }))}>
          <SelectTrigger className="w-44">
            <SelectValue placeholder="All months" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All months</SelectItem>
            {monthOptions.map((month) => (
              <SelectItem key={month} value={month}>
                {formatMonthOptionLabel(month)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={filters.direction ?? "all"}
          onValueChange={(v) => setFilters((f) => ({ ...f, direction: v === "all" ? null : (v as "debit" | "credit") }))}
        >
          <SelectTrigger className="w-36">
            <SelectValue placeholder="Debit & Credit" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Debit &amp; Credit</SelectItem>
            <SelectItem value="debit">Debit</SelectItem>
            <SelectItem value="credit">Credit</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={filters.accountFilter ?? "all"}
          onValueChange={(v) => setFilters((f) => ({ ...f, accountFilter: v === "all" ? null : v }))}
        >
          <SelectTrigger className="w-48">
            <SelectValue placeholder="All accounts" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All accounts</SelectItem>
            {destinationOptions.map((opt) => (
              <SelectItem key={opt.key} value={opt.key}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading ? (
          <Skeleton className="h-64 w-full rounded-2xl" />
        ) : (
          <FinanceTable
            columns={columns}
            data={visibleCandidates}
            getRowId={(c) => c.id}
            onRowClick={(c) => setDetailCandidate(c)}
            className="candidates-grid-lines"
            gridLines
            // A possible duplicate gets a calm left accent + tint right on its row — replaces the old
            // separate "Possible duplicates" summary panel above the list, which repeated the same info
            // the row/status badge already showed and made resolving one a two-place hunt. The Status
            // column's "Possible Duplicate" badge already carries the explanation, so this is just the
            // scan cue — no need to box the row off with a margin gap. Every other "warning" status
            // (Needs Review / Review Recommended) keeps its existing lighter tint. `!` (important) forces
            // the color to win over the table's own base row border (Tailwind doesn't guarantee this
            // className string's later position in the cascade order).
            rowClassName={(c) => {
              if (duplicates.get(c.id)?.duplicateOfTransactionId != null) return "!border-l-4 !border-l-danger bg-danger/5";
              return deriveCandidateStatus(c, duplicates.get(c.id) ?? null).tone === "warning" ? "bg-warning/5" : undefined;
            }}
            emptyState={
              <EmptyState
                icon={MessageSquareText}
                title="No SMS candidates"
                description="Once the Android app detects transactions from SMS, they'll show up here for review."
              />
            }
          />
        )}
      </div>

      {repositories && (
        <BulkActionsBar selectionCount={selectedIds.size} onClear={() => setSelectedIds(new Set())}>
          <ClayButton variant="primary" size="sm" onClick={() => setBulkImportDialogOpen(true)} disabled={bulkRunning}>
            {bulkRunning ? "Importing…" : `Import selected (${selectedIds.size})`}
          </ClayButton>
          <ClayButton variant="secondary" size="sm" onClick={() => setBulkDismissConfirmOpen(true)} disabled={bulkRunning}>
            Dismiss selected
          </ClayButton>
        </BulkActionsBar>
      )}

      <BulkImportDialog
        open={bulkImportDialogOpen}
        onOpenChange={setBulkImportDialogOpen}
        selectedCount={selectedIds.size}
        categories={categories}
        accounts={accounts}
        creditCards={creditCards}
        people={people}
        onCreatePerson={(name) =>
          repositories
            ? repositories.personRepository.createPerson({ name, avatarColorValue: 0, openingBalance: 0 })
            : Promise.reject(new Error("Not signed in"))
        }
        busy={bulkRunning}
        onConfirm={handleBulkImportConfirm}
        direction={selectionDirection}
      />

      {repositories && (
        <CandidateDetailsModal
          candidate={detailCandidate}
          onOpenChange={(open) => {
            if (!open) setDetailCandidate(null);
          }}
          duplicate={detailDuplicate}
          matchedTransaction={detailMatchedTransaction}
          existingTransactions={existingTransactionsForDuplicateCheck}
          accounts={accounts}
          creditCards={creditCards}
          categories={categories}
          people={people}
          transactionRepository={repositories.transactionRepository}
          candidateRepository={repositories.candidateRepository}
          expenseRepository={repositories.expenseRepository}
          onCreatePerson={(name) => repositories.personRepository.createPerson({ name, avatarColorValue: 0, openingBalance: 0 })}
          onHide={hideCandidate}
          onUnhide={unhideCandidate}
        />
      )}

      <ConfirmDialog
        open={bulkDismissConfirmOpen}
        onOpenChange={setBulkDismissConfirmOpen}
        title={`Dismiss ${selectedIds.size} candidate${selectedIds.size === 1 ? "" : "s"}?`}
        description="This removes them from the review queue without creating a transaction. You'll get a few seconds to undo from the confirmation toast."
        variant="destructive"
        confirmLabel="Dismiss"
        onConfirm={handleBulkDismissSelected}
      />

      <DuplicateWarningDialog
        open={bulkDuplicateState != null}
        onOpenChange={(open) => {
          if (!open) setBulkDuplicateState(null);
        }}
        result={bulkDuplicateState?.result ?? null}
        additionalCount={bulkDuplicateState?.additionalCount ?? 0}
        busy={bulkRunning}
        confirmLabel={bulkRunning ? "Importing…" : "Import anyway"}
        onConfirm={handleBulkImportDuplicatesAnyway}
      />
    </div>
  );
}
