"use client";

/**
 * Top-level orchestrator for the Transaction Inbox (the SMS Transaction Candidates review queue) — the web side of Transaction Intelligence.
 * Deliberately its own flat feature/route (see this folder's module doc / docs/adr/ADR-009). A candidate has nothing
 * inline-editable (see `lib/models/sms-transaction-candidate.ts` — Android-owned, web-writable only via full delete), so
 * the list is read-only and every change goes through the review drawer (`CandidateDetailsModal`).
 *
 * Review lanes: every candidate is in exactly ONE lane (duplicate / needs account / needs review / no issues flagged —
 * `deriveCandidateStatus(...).lane`), so the lane counts add up to the total and a row's lane always matches its badge.
 *
 * Layout: an overview band (whole-queue counts), compact views (All / Attention needed / Clean / Duplicates), search + filters,
 * then a transaction-led ledger grouped by month (`CandidateLedger`). The ledger reflows from its OWN container width, not the
 * viewport, because the app's sidebar leaves a 768px tablet only ~500px. Controls are independent (checkbox, notice, Review,
 * Dismiss); no row wraps them in a button role. This file owns ALL data/selection/import state — the components below it are
 * presentation only.
 *
 * Bulk safety: a bulk action only ever touches rows the user can currently SEE; a batch is limited to rows that agree on
 * direction AND destination (`lib/bulk-selection.ts`); and a candidate whose account/card identity isn't reliable — no match,
 * a stale match, an SMS with no bank and no last-4 — can't be selected for bulk import at all (enforced when selecting AND
 * again when confirming), so it always gets an individual review.
 */

import { Maximize2, Minimize2, Search } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfirmDialog, EmptyState } from "@/components/finance";
import { ScrollNav } from "@/components/layout/scroll-nav";
import { SmsSyncOnboarding } from "@/features/transaction-candidates/components/sms-sync-onboarding";
import { formatCurrencyExact } from "@/lib/format";
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
import {
  candidateDestinationGroupKey,
  candidateDestinationState,
  formatMatchedAccountLabel,
  resolveMatchedIdentity,
  formatUnresolvedAccountHint,
  resolveCandidateDestinationKey,
} from "../lib/candidate-account-matching";
import { buildDestinationOptions, categoryOptionsForDirection } from "../lib/candidate-details-view";
import { evaluateCandidateDuplicate, type CandidateDuplicateResult } from "../lib/candidate-duplicate";
import { candidateNeighbors } from "../lib/candidate-navigation";
import { deriveCandidateStatus, type CandidateStatus } from "../lib/candidate-status";
import { deriveCandidatesViewState } from "../lib/candidates-load-state";
import { suggestCategories } from "../lib/category-suggestions";
import { deriveVisibleSelection, matchesAnchor, partitionBulkEligible, selectableRows, selectionAnchorOf } from "../lib/bulk-selection";
import {
  applyCandidateSearchAndFilters,
  attentionCount,
  CANDIDATE_SORT_LABELS,
  countCandidatesByLane,
  DEFAULT_CANDIDATE_FILTERS,
  deriveCandidateMonthOptions,
  countActiveCandidateFilters,
  hasActiveCandidateFilters,
  normalizeCandidateFilters,
  sortCandidates,
  type CandidateFilters,
  type CandidateSortKey,
  type DuplicatesByCandidateId,
  type LaneByCandidateId,
} from "../lib/filters";
import { buildFilterChips, type FilterChip } from "../lib/candidate-filter-chips";
import { parseCandidateViewState, serializeCandidateViewState } from "../lib/candidate-filter-url";
import { groupCandidatesForDisplay } from "../lib/candidate-month-groups";
import { scheduleDelayedDismiss } from "../lib/delayed-dismiss";
import { bulkImportCandidates, ignoreCandidate } from "../lib/import-candidate";
import { bulkImportSummaryText, summarizeBulkImport, type PartialImportNotice } from "../lib/import-messages";
import { BulkImportDialog, type BulkImportSelection } from "./bulk-import-dialog";
import { CandidateBulkBar } from "./candidate-bulk-bar";
import { CandidateDetailsModal } from "./candidate-details-modal";
import { CandidateLedger, CandidateLedgerSkeleton, type LedgerGroup } from "./candidate-ledger";
import { CandidateFilterSheet } from "./candidate-filter-sheet";
import { CandidateOverview } from "./candidate-overview";
import { candidateTitle, FOCUS_RING, type CandidateRowModel } from "./candidate-row-parts";
import { CandidateToolbar } from "./candidate-toolbar";
import { CandidateViews } from "./candidate-views";
import { CandidatesLoadError } from "./candidates-load-error";
import { PartialImportNotices } from "./partial-import-notice";

export function TransactionCandidatesWorkspace() {
  const uid = useAuthStore((s) => s.user?.uid);
  const {
    data: liveCandidates = [],
    hasSnapshot,
    unreadableCount,
    isError: listenerFailed,
    error: listenerError,
    retry: retryListener,
  } = useSmsTransactionCandidates();
  const viewState = deriveCandidatesViewState({ hasSnapshot, isError: listenerFailed });
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

  // ── toolbar layout: decided from this component's own width (the ledger rows reflow themselves via container queries) ──
  const [width, setWidth] = useState(1200);
  const observerRef = useRef<ResizeObserver | null>(null);
  const rootRef = useCallback((node: HTMLDivElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!node || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setWidth(Math.round(w));
    });
    ro.observe(node);
    observerRef.current = ro;
  }, []);
  // Below this the month / direction / sort quick filters fold into the Filters sheet, leaving search + one button.
  const compactToolbar = width < 900;

  // The open candidate is tracked by id and read live from the list, so the drawer never shows (or imports from) a stale
  // copy; if the candidate disappears (imported or removed elsewhere) the drawer simply closes.
  const [detailCandidateId, setDetailCandidateId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDismissConfirmOpen, setBulkDismissConfirmOpen] = useState(false);
  const [bulkRunning, setBulkRunning] = useState(false);
  const [bulkImportDialogOpen, setBulkImportDialogOpen] = useState(false);
  // A fresh dialog instance per open, so a category / destination chosen for one batch can never carry over to the next.
  const [bulkDialogSession, setBulkDialogSession] = useState(0);
  // The category/destination the user picked in `BulkImportDialog` for the batch currently being imported — kept around so a
  // duplicate detected mid-batch can be retried via `handleBulkImportDuplicatesAnyway` with the same destination the user
  // already chose, without reopening the dialog.
  const [bulkSelection, setBulkSelection] = useState<BulkImportSelection | null>(null);
  // Rows `bulkImportCandidates` flagged as `duplicate_detected` on the last attempt — nothing was written for these yet.
  const [bulkDuplicateState, setBulkDuplicateState] = useState<{ result: DuplicateDetectionResult; additionalCount: number; candidateIds: string[] } | null>(
    null,
  );
  // Session progress. Imported ids are reported by the drawer / bulk import; dismissed ones are `pendingDismissIds` below.
  const [importedIds, setImportedIds] = useState<Set<string>>(new Set());
  // Imports that created the transaction but not everything after it — shown until the reviewer closes them.
  const [partialNotices, setPartialNotices] = useState<PartialImportNotice[]>([]);

  // Same fullscreen pattern as Transaction Studio's own toggle — `fixed inset-0` overlay, Escape to exit.
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    if (!fullscreen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      // Escape belongs to an open popup first (it closes that popup), not to the fullscreen toggle underneath it.
      if (document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]')) return;
      setFullscreen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [fullscreen]);

  // Ids whose Dismiss is currently in its undo window (see `delayed-dismiss.ts`) — hidden from every view of the list
  // immediately, before the real Firestore delete actually runs.
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
  // Source-agnostic — manual entry, PDF import, and prior SMS imports are all just `Transaction` records here. Passed straight
  // through to `importCandidate`'s own fresh, immediately-before-write duplicate check rather than only feeding the display-only
  // `duplicates` map above.
  const existingTransactionsForDuplicateCheck: ExistingTransactionForDuplicateCheck[] = useMemo(
    () => transactions.map((t) => ({ id: t.id, description: t.description, amount: t.amount, dateTime: t.dateTime, accountId: t.accountId, type: t.type })),
    [transactions],
  );

  // The watch hooks resolve `[]` before their first snapshot, so an empty accounts/cards list can't be told from "not loaded
  // yet". Until real accounts (and, for card candidates, cards) are present, don't judge whether Android's ids still resolve.
  // While not ready NOTHING is bulk-eligible, so a not-yet-verified match can never slip into a batch.
  const destinationsReady = accounts.length > 0 && (creditCards.length > 0 || !candidates.some((c) => c.cardId));
  const destinationStateOf = useCallback(
    (c: SmsTransactionCandidate) =>
      destinationsReady ? candidateDestinationState(c, accounts, creditCards) : c.accountId != null || c.cardId != null ? ("matched" as const) : ("unmatched" as const),
    [destinationsReady, accounts, creditCards],
  );
  /** Reliable account/card identity: Android resolved it AND it still points at a real account/card. */
  const bulkEligible = useCallback((c: SmsTransactionCandidate) => destinationsReady && candidateDestinationState(c, accounts, creditCards) === "matched", [destinationsReady, accounts, creditCards]);

  const statusById = useMemo(() => {
    const map = new Map<string, CandidateStatus>();
    for (const c of candidates) map.set(c.id, deriveCandidateStatus(c, duplicates.get(c.id) ?? null, destinationStateOf(c)));
    return map;
  }, [candidates, duplicates, destinationStateOf]);
  const laneById: LaneByCandidateId = useMemo(() => new Map([...statusById].map(([id, status]) => [id, status.lane])), [statusById]);

  // Filter state lives in the URL too (so a refresh or a shared link keeps the view); the first render reads it, later changes
  // are written back with router.replace. `searchText` is what the box shows; `search` is the debounced value that filters.
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [initialView] = useState(() => parseCandidateViewState(searchParams));
  const [searchText, setSearchText] = useState(initialView.search);
  const [search, setSearch] = useState(initialView.search);
  const [sortKey, setSortKey] = useState<CandidateSortKey>(initialView.sortKey);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [rawFilters, setRawFilters] = useState<CandidateFilters>(initialView.filters);
  // Only accounts/cards at least one candidate actually resolved to — not every account/card in the whole app.
  const destinationOptions = useMemo(() => {
    const linkedKeys = new Set(candidates.flatMap((c) => [c.accountId && `account:${c.accountId}`, c.cardId && `card:${c.cardId}`].filter((k): k is string => !!k)));
    return buildDestinationOptions(accounts, creditCards).filter((opt) => linkedKeys.has(opt.key));
  }, [candidates, accounts, creditCards]);
  const monthOptions = useMemo(() => deriveCandidateMonthOptions(candidates), [candidates]);
  // An account / month filter whose option has disappeared is dropped instead of leaving the list silently empty.
  const filters = useMemo(
    () => normalizeCandidateFilters(rawFilters, { accountKeys: new Set(destinationOptions.map((o) => o.key)), months: monthOptions }),
    [rawFilters, destinationOptions, monthOptions],
  );
  const filtersActive = hasActiveCandidateFilters(search, filters) || searchText.trim() !== "";
  const activeFilterCount = countActiveCandidateFilters(filters);

  // Typing filters after a short pause, not on every keystroke (126+ rows re-derive on each change).
  useEffect(() => {
    if (searchText === search) return;
    const timer = setTimeout(() => {
      setSearch(searchText);
      setSelectedIds(new Set());
    }, 250);
    return () => clearTimeout(timer);
  }, [searchText, search]);

  // Mirror the view into the URL once the data is real (before that, filters whose options haven't loaded yet would be dropped).
  useEffect(() => {
    if (viewState.phase !== "ready") return;
    const qs = serializeCandidateViewState({ search, sortKey, filters });
    if (qs === searchParams.toString()) return;
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [viewState.phase, search, sortKey, filters, searchParams, pathname, router]);

  // Changing what's on screen also clears the selection, so a bulk action can never silently include rows the user can no
  // longer see.
  function updateFilters(update: (f: CandidateFilters) => CandidateFilters) {
    setRawFilters((f) => update(normalizeCandidateFilters(f, { accountKeys: new Set(destinationOptions.map((o) => o.key)), months: monthOptions })));
    setSelectedIds(new Set());
  }
  function updateSearch(value: string) {
    setSearchText(value);
  }
  function updateSort(key: CandidateSortKey) {
    setSortKey(key);
    setSelectedIds(new Set());
  }
  function clearFilters() {
    setSearchText("");
    setSearch("");
    setSortKey("newest");
    setRawFilters(DEFAULT_CANDIDATE_FILTERS);
    setSelectedIds(new Set());
  }

  const accountLabelOf = useCallback((c: SmsTransactionCandidate) => formatMatchedAccountLabel(c, accounts, creditCards), [accounts, creditCards]);
  const accountHintOf = useCallback((c: SmsTransactionCandidate) => formatUnresolvedAccountHint(c, destinationStateOf(c)), [destinationStateOf]);
  const groupKeyOf = useCallback((c: SmsTransactionCandidate) => candidateDestinationGroupKey(c, accounts, creditCards), [accounts, creditCards]);
  const groupLabelOf = (c: SmsTransactionCandidate) => accountLabelOf(c) ?? accountHintOf(c);

  // Searchable text the filter module can't see: the account label / hint shown on each row.
  const searchTextById = useMemo(() => new Map(candidates.map((c) => [c.id, `${accountLabelOf(c) ?? accountHintOf(c)} ${smsCandidateEventTypeLabel(c.eventType)}`])), [candidates, accountLabelOf, accountHintOf]);

  // Candidates whose account/card doesn't resolve to a real, current one — what the "Unmatched" account filter selects.
  const unmatchedIds = useMemo(() => new Set(candidates.filter((c) => destinationStateOf(c) !== "matched").map((c) => c.id)), [candidates, destinationStateOf]);

  const visibleCandidates = useMemo(
    () => sortCandidates(applyCandidateSearchAndFilters(candidates, search, filters, laneById, searchTextById, unmatchedIds), sortKey),
    [candidates, search, filters, laneById, searchTextById, unmatchedIds, sortKey],
  );
  const visibleIds = useMemo(() => visibleCandidates.map((c) => c.id), [visibleCandidates]);

  const candidateById = useMemo(() => new Map(candidates.map((c) => [c.id, c])), [candidates]);
  const detailCandidate = detailCandidateId ? (candidateById.get(detailCandidateId) ?? null) : null;

  // Bulk actions only ever see rows that are on screen AND bulk-eligible: `selectedCandidates` is selection ∩ visible ∩ eligible.
  const { selected: visibleSelected, hiddenSelectedCount } = useMemo(
    () => deriveVisibleSelection(visibleCandidates, candidates, selectedIds),
    [visibleCandidates, candidates, selectedIds],
  );
  const selectedCandidates = useMemo(() => visibleSelected.filter(bulkEligible), [visibleSelected, bulkEligible]);
  const ineligibleSelectedCount = visibleSelected.length - selectedCandidates.length;
  // A bulk import applies ONE category and ONE destination to the whole batch, so the selection is locked to the first
  // selected row's direction (income/expense) and destination group — `null` once nothing is selected.
  const selectionAnchor = selectedCandidates[0] ? selectionAnchorOf(selectedCandidates[0], groupKeyOf) : null;
  const selectionIsUniform = selectionAnchor == null || selectedCandidates.every((c) => matchesAnchor(c, selectionAnchor, groupKeyOf));
  const selectionDirection = selectionAnchor?.direction ?? null;
  const anchorCandidate = selectedCandidates[0] ?? null;

  const eligibleVisible = useMemo(() => visibleCandidates.filter(bulkEligible), [visibleCandidates, bulkEligible]);
  const selectableVisibleCandidates = selectableRows(eligibleVisible, selectionAnchor, groupKeyOf);
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

  function ineligibleReason(c: SmsTransactionCandidate): string {
    if (!destinationsReady) return "accounts are still loading";
    const state = candidateDestinationState(c, accounts, creditCards);
    return state === "missing" ? "the account Android matched no longer exists" : "Android couldn't match an account or card";
  }

  /** Why `candidate` can't be added to the current selection (never silently), or null when it can. */
  function selectionBlockedReason(candidate: SmsTransactionCandidate): string | null {
    if (!bulkEligible(candidate)) return ineligibleReason(candidate);
    if (!selectionAnchor || !anchorCandidate || matchesAnchor(candidate, selectionAnchor, groupKeyOf)) return null;
    if (candidate.direction !== selectionAnchor.direction) return `you're selecting ${selectionAnchor.direction === "credit" ? "income" : "expense"} — they can't be mixed`;
    return `you're selecting transactions for ${groupLabelOf(anchorCandidate)}; a bulk import posts everything to one account`;
  }

  function toggleRowSelected(candidateId: string, checked: boolean) {
    const candidate = candidateById.get(candidateId);
    if (checked && candidate) {
      const blocked = selectionBlockedReason(candidate);
      if (blocked) {
        toast.error("Can't add this to the selection", `Review it individually — ${blocked}.`);
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

  function recordPartials(partials: { candidateId: string; failedStep: PartialImportNotice["failedStep"]; reusedExisting: boolean; rollbackIncomplete: boolean }[], peopleRequested: boolean) {
    if (partials.length === 0) return;
    setPartialNotices((prev) => {
      const next = [...prev];
      for (const p of partials) {
        const c = candidateById.get(p.candidateId);
        if (!c || next.some((n) => n.id === p.candidateId)) continue;
        next.push({
          id: p.candidateId,
          merchant: candidateTitle(c),
          amountText: formatCurrencyExact(c.amount),
          failedStep: p.failedStep,
          peopleRequested: peopleRequested && c.direction === "debit",
          reusedExisting: p.reusedExisting,
          rollbackIncomplete: p.rollbackIncomplete,
        });
      }
      return next;
    });
  }

  /**
   * Runs `bulkImportCandidates` for exactly `candidatesToImport`, against the live `existingTransactionsForDuplicateCheck`.
   * CONFIRMATION-STAGE GATE: every row must still have a reliable account/card identity; if any doesn't, nothing at all is
   * written (the whole call is refused), so a row that lost its match between selecting and confirming can never be imported
   * into a destination the reviewer chose for other rows. `force` is only `true` from `DuplicateWarningDialog`'s "Import
   * anyway" — it re-imports only the previously-flagged rows, so already-succeeded rows are never retried.
   */
  async function runBulkImport(candidatesToImport: SmsTransactionCandidate[], force: boolean, selection: BulkImportSelection) {
    if (!repositories || candidatesToImport.length === 0) return;
    const { blocked } = partitionBulkEligible(candidatesToImport, bulkEligible);
    if (blocked.length > 0) {
      toast.error("Nothing was imported", `${blocked.length} selected row${blocked.length === 1 ? "" : "s"} can't be bulk-imported (no reliable account or card). Review ${blocked.length === 1 ? "it" : "them"} individually.`);
      return;
    }
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
      const summary = summarizeBulkImport(results);
      const duplicateRows = results.filter(
        (r): r is { candidateId: string; outcome: Extract<(typeof results)[number]["outcome"], { status: "duplicate_detected" }> } =>
          r.outcome.status === "duplicate_detected",
      );

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

      const anythingToReport = summary.imported + summary.alreadyImported + summary.personSplitFailed + summary.deleteFailed + summary.notImported + summary.alreadyDismissed > 0;
      if (anythingToReport) {
        // tombstoneMismatched (Phase F2, 2026-10-24): not a failure — the Transaction is real — but
        // worth the same non-routine toast style as other "needs a look" outcomes, never folded
        // silently into a plain success. alreadyDismissed is NOT included here: it's an expected,
        // clean outcome on the atomic path (nothing was created, nothing lost) — still reported in
        // the summary text, just not styled as a problem.
        const needsAttention = summary.personSplitFailed + summary.deleteFailed + summary.notImported + summary.tombstoneMismatched > 0;
        if (needsAttention) toast.error("Import finished with problems", bulkImportSummaryText(summary));
        else toast.success("Import complete", bulkImportSummaryText(summary));
      }
      recordPartials(summary.partials, selection.personAssignment != null);
      setImportedIds((prev) => new Set([...prev, ...summary.settledIds, ...summary.createdButUnsettledIds]));

      // Rows whose transaction now exists (settled, or created-but-needs-attention) leave the selection, so a second click can
      // never act on them blindly; flagged duplicates and not-imported rows stay selected for a retry.
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const id of [...summary.settledIds, ...summary.createdButUnsettledIds]) next.delete(id);
        return next;
      });
    } finally {
      setBulkRunning(false);
    }
  }

  function openBulkImportDialog() {
    // Opening the dialog is the first confirmation point: refuse a batch that holds a row without a reliable account.
    const { blocked } = partitionBulkEligible(selectedCandidates, bulkEligible);
    if (blocked.length > 0 || !selectionIsUniform) return;
    setBulkDialogSession((n) => n + 1);
    setBulkImportDialogOpen(true);
  }

  function handleBulkImportConfirm(selection: BulkImportSelection) {
    if (!repositories || selectedCandidates.length === 0 || !selectionIsUniform) return;
    setBulkSelection(selection);
    setBulkImportDialogOpen(false);
    void runBulkImport(selectedCandidates, false, selection);
  }

  function handleBulkImportDuplicatesAnyway() {
    if (!bulkDuplicateState || !bulkSelection) return;
    // Looked up from the whole live list (not the visible selection): the user may have changed filters while the warning was open.
    const candidatesToRetry = bulkDuplicateState.candidateIds.map((id) => candidateById.get(id)).filter((c): c is SmsTransactionCandidate => c != null);
    setBulkDuplicateState(null);
    void runBulkImport(candidatesToRetry, true, bulkSelection);
  }

  function dismissWithUndo(candidatesToDismiss: SmsTransactionCandidate[]) {
    if (!repositories) return () => {};
    const cancels = candidatesToDismiss.map(
      (c) =>
        scheduleDelayedDismiss({
          candidateId: c.id,
          hide: hideCandidate,
          unhide: unhideCandidate,
          commitDelete: async () => {
            const { tombstoneMismatched } = await ignoreCandidate(c, repositories.candidateRepository);
            if (tombstoneMismatched) {
              // Phase F2 (2026-10-24): a concurrent Import (another tab/device) already won this race.
              toast.info("Already imported elsewhere", `${c.merchant ?? c.bankName ?? "This transaction"} was imported in another tab or device — it wasn't dismissed.`);
            }
          },
          onDeleteFailed: (error) => {
            toast.error("Couldn't dismiss a candidate", error instanceof Error ? error.message : "Still pending, try again.");
          },
        }).cancel,
    );
    return () => cancels.forEach((cancel) => cancel());
  }

  function handleBulkDismissSelected() {
    if (!repositories || selectedCandidates.length === 0) return;
    const undo = dismissWithUndo(selectedCandidates);
    toast.success("Dismissed", `${selectedCandidates.length} candidate${selectedCandidates.length === 1 ? "" : "s"} won't show in the review queue.`, { label: "Undo", onClick: undo });
    setSelectedIds(new Set());
    setBulkDismissConfirmOpen(false);
  }

  /** "Remove from queue" on a partial-import notice: the transaction already exists, so this is a plain dismissal with Undo. */
  function removeLeftover(candidateId: string) {
    const c = candidateById.get(candidateId);
    if (!c) return;
    const undo = dismissWithUndo([c]);
    toast.success("Removed from the queue", `${candidateTitle(c)} won't show in the review queue.`, { label: "Undo", onClick: undo });
  }

  // Lane counts for exactly the rows each lane would show (search + account/month/direction applied), so they always add up.
  const counts = useMemo(() => countCandidatesByLane(candidates, search, filters, laneById, searchTextById, unmatchedIds), [candidates, search, filters, laneById, searchTextById, unmatchedIds]);

  // Whole-queue partition for the overview (ignores search + filters, so it always describes the inbox itself).
  const queueCounts = useMemo(() => countCandidatesByLane(candidates, "", DEFAULT_CANDIDATE_FILTERS, laneById), [candidates, laneById]);
  const viewCounts = useMemo(() => ({ all: counts.all, attention: attentionCount(counts), noIssues: counts.noIssues, duplicate: counts.duplicate }), [counts]);

  const rows: CandidateRowModel[] = useMemo(
    () =>
      visibleCandidates.map((candidate, index) => {
        const status = statusById.get(candidate.id) ?? deriveCandidateStatus(candidate, null, destinationStateOf(candidate));
        const selected = selectedIds.has(candidate.id);
        return {
          candidate,
          number: index + 1,
          status,
          duplicate: duplicates.get(candidate.id) ?? null,
          destinationState: destinationStateOf(candidate),
          accountLabel: accountLabelOf(candidate),
          identity: resolveMatchedIdentity(candidate, accounts, creditCards),
          accountHint: accountHintOf(candidate),
          selected,
          selectBlockedReason: selected ? null : selectionBlockedReason(candidate),
        };
      }),
    // `selectionBlockedReason` closes over the anchor + eligibility inputs listed here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visibleCandidates, statusById, duplicates, selectedIds, destinationStateOf, accountLabelOf, accountHintOf, selectionAnchor, anchorCandidate, destinationsReady, accounts, creditCards],
  );

  const ledgerGroups: LedgerGroup[] = useMemo(() => {
    const rowById = new Map(rows.map((r) => [r.candidate.id, r]));
    return groupCandidatesForDisplay(visibleCandidates, sortKey, `${CANDIDATE_SORT_LABELS[sortKey]} · all days`).map((g) => ({
      key: g.key,
      label: g.label,
      dateText: g.dateText,
      flat: g.flat,
      rows: g.candidates.map((c) => rowById.get(c.id)).filter((r): r is CandidateRowModel => r != null),
    }));
  }, [rows, visibleCandidates, sortKey]);

  // ── drawer wiring ──
  const neighbors = candidateNeighbors(visibleIds, detailCandidateId);
  const detailDuplicate = detailCandidate ? (duplicates.get(detailCandidate.id) ?? null) : null;
  const detailMatchedTransaction = detailDuplicate?.duplicateOfTransactionId ? (transactionById.get(detailDuplicate.duplicateOfTransactionId) ?? null) : null;
  const detailCategorySuggestions = useMemo(
    () => (detailCandidate ? suggestCategories(detailCandidate, transactions, categoryOptionsForDirection(categories, detailCandidate.direction)) : []),
    [detailCandidate, transactions, categories],
  );
  const stillQueued = useMemo(() => new Set(candidates.map((c) => c.id)), [candidates]);

  // After the drawer closes, keep keyboard focus on something useful: the browser restores it to the Review button that opened
  // the drawer, but that row may be gone (imported / dismissed) — then focus the first remaining Review button, or the list.
  const listRef = useRef<HTMLDivElement>(null);
  const wasOpenRef = useRef(false);
  useEffect(() => {
    const open = detailCandidateId != null;
    if (wasOpenRef.current && !open) {
      const frame = requestAnimationFrame(() => {
        const active = document.activeElement;
        if (active && active !== document.body && active.isConnected) return;
        const first = listRef.current?.querySelector<HTMLElement>("[data-review-id]");
        (first ?? listRef.current)?.focus({ preventScroll: true });
      });
      wasOpenRef.current = open;
      return () => cancelAnimationFrame(frame);
    }
    wasOpenRef.current = open;
  }, [detailCandidateId]);

  const handled = importedIds.size + pendingDismissIds.size;
  const bulkGroupLabel = anchorCandidate ? groupLabelOf(anchorCandidate) : "";
  const bulkDefaultDestinationKey = anchorCandidate ? resolveCandidateDestinationKey(anchorCandidate, accounts, creditCards) : null;
  const bulkNotes: string[] = [];
  if (ineligibleSelectedCount > 0) bulkNotes.push(`${ineligibleSelectedCount} selected row${ineligibleSelectedCount === 1 ? " needs" : "s need"} individual review and ${ineligibleSelectedCount === 1 ? "is" : "are"} left out.`);
  if (hiddenSelectedCount > 0) bulkNotes.push(`${hiddenSelectedCount} more selected row${hiddenSelectedCount === 1 ? " is" : "s are"} hidden and won't be included.`);
  if (!selectionIsUniform) bulkNotes.push("These rows span different accounts or directions — clear the selection and pick one group.");

  const filterChips: FilterChip[] = buildFilterChips(filters, (key) => destinationOptions.find((o) => o.key === key)?.label ?? key);

  return (
    <div
      ref={rootRef}
      className={cn(
        // The inbox is an ordinary page that scrolls with the app shell's <main> (the month headers stick to it). Full screen
        // is the exception: a fixed overlay that scrolls itself.
        "flex min-w-0 flex-col gap-3 p-4 sm:gap-4 sm:p-6",
        fullscreen && "fixed inset-0 z-50 overflow-y-auto bg-background p-4",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="font-heading text-2xl font-semibold tracking-tight text-foreground">Transaction Inbox</h1>
          <p className="mt-0.5 hidden max-w-2xl text-sm text-muted-foreground sm:block">
            <span>Transactions detected from your SMS. Nothing is added to your books until you review and confirm it.</span>
          </p>
        </div>
        <button
          type="button"
          aria-label={fullscreen ? "Exit full screen" : "Full screen"}
          title={fullscreen ? "Exit full screen (Esc)" : "Full screen"}
          onClick={() => setFullscreen((v) => !v)}
          className={cn("flex size-11 shrink-0 items-center justify-center rounded-[10px] border border-border-strong bg-card text-foreground hover:bg-secondary lg:size-10", FOCUS_RING)}
        >
          {fullscreen ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
        </button>
      </div>

      {/* The overview/views/toolbar are zero-value noise above a genuinely empty, unfiltered queue — hide them so the
          onboarding card sits right under the page heading. They reappear the moment there's anything to count or filter. */}
      {!(viewState.phase === "ready" && candidates.length === 0) && (
        <>
          <CandidateOverview
            loading={viewState.phase !== "ready"}
            waiting={candidates.length}
            handled={handled}
            counts={queueCounts}
            active={filters.lane}
            onSelect={(lane) => updateFilters((f) => ({ ...f, lane }))}
          />

          <div className="flex flex-col gap-3">
            <CandidateViews active={filters.lane} counts={viewCounts} onSelect={(lane) => updateFilters((f) => ({ ...f, lane }))} />
            <CandidateToolbar
              searchText={searchText}
              onSearchChange={updateSearch}
              compact={compactToolbar}
              months={monthOptions}
              month={filters.month}
              onMonth={(month) => updateFilters((f) => ({ ...f, month }))}
              direction={filters.direction}
              onDirection={(direction) => updateFilters((f) => ({ ...f, direction }))}
              sortKey={sortKey}
              onSort={updateSort}
              activeFilterCount={activeFilterCount}
              onOpenFilters={() => setFiltersOpen(true)}
              chips={filterChips}
              onRemoveChip={(chip) => updateFilters((f) => chip.clear(f))}
              canClearAll={filtersActive}
              onClearAll={clearFilters}
            />
          </div>
        </>
      )}

      <div ref={listRef} tabIndex={-1} className={cn("flex flex-col gap-3 outline-none", selectedCandidates.length > 0 && "pb-36 md:pb-0")}>
        <PartialImportNotices
          notices={partialNotices}
          stillQueued={stillQueued}
          onRemoveFromQueue={removeLeftover}
          onClose={(id) => setPartialNotices((prev) => prev.filter((n) => n.id !== id))}
        />
        {viewState.showErrorNotice && (
          <CandidatesLoadError error={listenerError} onRetry={retryListener} message="Live updates stopped — the list below may be out of date." />
        )}
        {unreadableCount > 0 && (
          <div
            role="status"
            data-testid="unreadable-candidates-notice"
            className="rounded-xl border border-warning/60 bg-warning/12 px-4 py-2.5 text-sm text-foreground"
          >
            {unreadableCount} candidate{unreadableCount === 1 ? "" : "s"} couldn&apos;t be read and {unreadableCount === 1 ? "isn't" : "aren't"} shown here. Nothing has
            been changed or deleted — opening the SMS Inbox in the Android app syncs a fresh copy.
          </div>
        )}

        {viewState.phase === "loading" ? (
          <CandidateLedgerSkeleton />
        ) : viewState.phase === "error" ? (
          <CandidatesLoadError error={listenerError} onRetry={retryListener} message="Couldn't load your SMS candidates." />
        ) : visibleCandidates.length === 0 ? (
          candidates.length > 0 ? (
            <div className="rounded-2xl border border-border bg-card">
              <EmptyState icon={Search} title="No candidates match" description="Nothing fits the current search and filters." actionLabel="Clear filters" onAction={clearFilters} />
            </div>
          ) : (
            <SmsSyncOnboarding />
          )
        ) : (
          <CandidateLedger
            groups={ledgerGroups}
            shownCount={visibleCandidates.length}
            queueCount={candidates.length}
            allSelected={allVisibleSelected}
            someSelected={someVisibleSelected}
            selectAllDisabled={selectableVisibleCandidates.length === 0}
            onToggleAll={toggleSelectAllVisible}
            onToggle={toggleRowSelected}
            onReview={setDetailCandidateId}
            candidateRepository={repositories?.candidateRepository ?? null}
            onHide={hideCandidate}
            onUnhide={unhideCandidate}
          />
        )}
      </div>

      {/* Outside the scrolling list on purpose: on a phone the page itself scrolls, and a bar inside the list would sit below the fold. */}
      {repositories && (
        <CandidateBulkBar
          count={selectedCandidates.length}
          accountLabel={bulkGroupLabel}
          notes={bulkNotes}
          busy={bulkRunning}
          importDisabled={!selectionIsUniform || selectedCandidates.length === 0}
          onImport={openBulkImportDialog}
          onDismiss={() => setBulkDismissConfirmOpen(true)}
          onClear={() => setSelectedIds(new Set())}
        />
      )}

      <BulkImportDialog
        key={bulkDialogSession}
        open={bulkImportDialogOpen}
        onOpenChange={setBulkImportDialogOpen}
        candidates={selectedCandidates}
        groupLabel={bulkGroupLabel}
        defaultDestinationKey={bulkDefaultDestinationKey}
        categories={categories}
        accounts={accounts}
        creditCards={creditCards}
        people={people}
        onCreatePerson={(name) =>
          repositories ? repositories.personRepository.createPerson({ name, avatarColorValue: 0, openingBalance: 0 }) : Promise.reject(new Error("Not signed in"))
        }
        busy={bulkRunning}
        onConfirm={handleBulkImportConfirm}
        direction={selectionDirection}
      />

      {repositories && (
        <CandidateDetailsModal
          candidate={detailCandidate}
          onOpenChange={(open) => {
            if (!open) setDetailCandidateId(null);
          }}
          navigation={
            detailCandidate && neighbors.index >= 0
              ? {
                  index: neighbors.index,
                  total: neighbors.total,
                  prevId: neighbors.prevId,
                  nextId: neighbors.nextId,
                  advanceToId: neighbors.advanceToId,
                  onGoTo: setDetailCandidateId,
                }
              : undefined
          }
          categorySuggestions={detailCategorySuggestions}
          onImported={(id) => setImportedIds((prev) => new Set(prev).add(id))}
          onPartialImport={(notice) => setPartialNotices((prev) => (prev.some((n) => n.id === notice.id) ? prev : [...prev, notice]))}
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

      <CandidateFilterSheet
        open={filtersOpen}
        onOpenChange={setFiltersOpen}
        applied={filters}
        appliedSort={sortKey}
        options={{ months: monthOptions, accounts: destinationOptions.map((o) => ({ key: o.key, label: o.label })) }}
        previewCount={(draft) => applyCandidateSearchAndFilters(candidates, search, draft, laneById, searchTextById, unmatchedIds).length}
        onApply={(next, nextSort) => {
          setRawFilters(next);
          setSortKey(nextSort);
          setSelectedIds(new Set());
          setFiltersOpen(false);
        }}
      />

      <ConfirmDialog
        open={bulkDismissConfirmOpen}
        onOpenChange={setBulkDismissConfirmOpen}
        title={`Dismiss ${selectedCandidates.length} candidate${selectedCandidates.length === 1 ? "" : "s"}?`}
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
      {!fullscreen && <ScrollNav />}
    </div>
  );
}

