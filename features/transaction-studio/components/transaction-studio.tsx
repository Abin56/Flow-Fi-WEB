"use client";

/**
 * Top-level orchestrator (architecture §3) — wires the live data hooks,
 * search/filter state, row selection, the focused-row Inspector, and the
 * commit orchestrator together. The Spreadsheet itself owns focus/edit/
 * keyboard-nav state (architecture §4c); everything shared across panels
 * (selection, filters, the Inspector's target row) lives here.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useDocumentImportRecords } from "@/hooks/use-document-import-records";
import { useTransactionStudioMutations } from "@/hooks/use-transaction-studio-mutations";
import { useAccounts } from "@/hooks/use-accounts";
import { useBills } from "@/hooks/use-bills";
import { useCategories } from "@/hooks/use-categories";
import { useCreditCards, useEmis } from "@/hooks/use-credit-cards";
import { useFinancialDocuments } from "@/hooks/use-financial-documents";
import { useLoans } from "@/hooks/use-loans";
import { usePeople } from "@/hooks/use-people";
import { useTransactions } from "@/hooks/use-transactions";
import { createExpenseRepository, createInstallmentRepositoryFor, createLoanRepository, createEmiRepository, createTransactionRepository, createAccountRepository } from "@/lib/repositories/repository-factory";
import { useAuthStore } from "@/store/auth-store";
import { generateMockCategories } from "../dev/generate-mock-categories";
import { generateMockStagedRecords } from "../dev/generate-mock-staged-records";
import { DuplicateWarningDialog } from "@/lib/services/duplicate-detection/duplicate-warning-dialog";
import { useUndoRedo } from "../hooks/use-undo-redo";
import { commitReviewImport, detectFreshDuplicatesForCommit, getPreflightBlockers, type CommitBlockingReason, type CommitReviewImportResult, type FreshDuplicateWarning } from "../lib/commit-review-import";
import { DEFAULT_STUDIO_FILTERS, applyStudioSearchAndFilters, type StudioFilters } from "../lib/filters";
import { BulkActionBar } from "./bulk-action-bar";
import { ImportedStatementsPanel } from "./imported-statements-panel";
import { ImportSuccessPanel } from "./import-success-panel";
import { TransactionManageModal } from "./inspector/transaction-manage-modal";
import { RightSidebar } from "./right-sidebar";
import { SmsCandidatesLink } from "./sms-candidates-link";
import { Spreadsheet } from "./spreadsheet/spreadsheet";
import { StudioHeader } from "./studio-header";
import { StudioToolbar } from "./studio-toolbar";
import { ValidationBar } from "./validation-bar";
import { ValidationPanel } from "./validation-panel";

export function TransactionStudio({ initialDocumentId }: { initialDocumentId: string }) {
  const uid = useAuthStore((s) => s.user?.uid);
  const [documentId, setDocumentId] = useState(initialDocumentId);
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<StudioFilters>(DEFAULT_STUDIO_FILTERS);
  const [selectedRowIds, setSelectedRowIds] = useState<Set<string>>(new Set());
  const [showSelectedOnly, setShowSelectedOnly] = useState(false);
  const [inspectorRowId, setInspectorRowId] = useState<string | null>(null);
  /** The grid's Action button entry point (brief: "I clicked one transaction and now I have complete control over that transaction") — a centered modal, distinct from the docked Inspector's `inspectorRowId` (still reachable from the validation bar / duplicate / preflight "Review" links). */
  const [manageModalRowId, setManageModalRowId] = useState<string | null>(null);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [commitResult, setCommitResult] = useState<CommitReviewImportResult | null>(null);
  const [committing, setCommitting] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [freshDuplicateWarnings, setFreshDuplicateWarnings] = useState<FreshDuplicateWarning[] | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const panelRowRef = useRef<HTMLDivElement>(null);

  // Auto-collapse the side panels when there isn't room for both fixed-width panels (256px + 320px)
  // plus a usable grid. Measured against the nearest ancestor whose width is anchored to the
  // viewport/app-sidebar rather than to Transaction Studio's own content — `panelRowRef`'s own width
  // is a flex child of that chain, so opening/closing a panel changes what the row itself measures
  // next tick, which fed back into this same observer and oscillated. Walking up to `<main>` (fixed
  // by the app shell's layout, never by anything Transaction Studio renders) breaks that loop. Only
  // ever auto-*closes* a panel the user hasn't already closed; never fights a manual re-open via the
  // existing toggle buttons above.
  useEffect(() => {
    const main = panelRowRef.current?.closest("main");
    if (!main) return;
    const GRID_MIN_WIDTH = 360;
    const LEFT_PANEL_WIDTH = 256;
    const RIGHT_PANEL_WIDTH = 320;
    // `main`'s own horizontal padding (px-4/sm:px-6/lg:px-8) isn't part of contentRect, and isn't
    // available space for the row either, so no separate accounting is needed for it here.
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width === undefined) return;
      setRightOpen((wasOpen) => (wasOpen ? width >= GRID_MIN_WIDTH + LEFT_PANEL_WIDTH + RIGHT_PANEL_WIDTH : wasOpen));
      setLeftOpen((wasOpen) => (wasOpen ? width >= GRID_MIN_WIDTH + LEFT_PANEL_WIDTH + RIGHT_PANEL_WIDTH : wasOpen));
    });
    observer.observe(main);
    return () => observer.disconnect();
  }, []);

  // Immersive review mode (redesign brief §4) — a CSS-only overlay (matching the one existing precedent,
  // `transactions-workspace.tsx`) rather than the browser Fullscreen API, so there's no permission prompt
  // and no cross-browser inconsistency. Deliberately `overflow-hidden` (not `-auto`) at this level — the
  // Spreadsheet's own `useVirtualizer` owns its internal scroll container and needs that untouched.
  useEffect(() => {
    if (!fullscreen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setFullscreen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [fullscreen]);

  // §6 keyboard baseline — "/" or Cmd/Ctrl+K jumps focus to search from anywhere in the Studio,
  // except while the user is actually typing in another field (where "/" should just type a slash).
  useEffect(() => {
    function handleGlobalKeyDown(e: KeyboardEvent) {
      const isMac = typeof navigator !== "undefined" && navigator.platform.toLowerCase().includes("mac");
      const mod = isMac ? e.metaKey : e.ctrlKey;
      const target = e.target as HTMLElement | null;
      const isTypingElsewhere = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable;

      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchInputRef.current?.focus();
        return;
      }
      if (e.key === "/" && !isTypingElsewhere) {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    }
    document.addEventListener("keydown", handleGlobalKeyDown);
    return () => document.removeEventListener("keydown", handleGlobalKeyDown);
  }, []);

  const { data: documents = [] } = useFinancialDocuments();
  const { data: liveRows = [] } = useDocumentImportRecords(documentId);
  const { data: liveCategories = [] } = useCategories();
  // DEV-ONLY scrolling/sticky-layout QA fixture — see `../dev/generate-mock-staged-records`.
  // Always 0 (and the toggle UI never renders) outside development, so this can never substitute
  // real data in production; remove this block + the `<DevFixtureToggle>` JSX below to fully undo.
  const [devFixtureRowCount, setDevFixtureRowCount] = useState(0);
  // Swaps in alongside `rows` below — without a real signed-in user `liveCategories` is always `[]`
  // (see `hooks/use-categories.ts`), which would make every mock expense/income row "Missing
  // Category" instead of a realistic mix. See `../dev/generate-mock-categories`.
  const mockCategories = useMemo(() => {
    if (process.env.NODE_ENV !== "development" || devFixtureRowCount <= 0) return [];
    return generateMockCategories();
  }, [devFixtureRowCount]);
  const categories = devFixtureRowCount > 0 ? mockCategories : liveCategories;
  const mockRows = useMemo(() => {
    if (process.env.NODE_ENV !== "development" || devFixtureRowCount <= 0) return [];
    return generateMockStagedRecords(devFixtureRowCount, categories);
  }, [devFixtureRowCount, categories]);
  const rows = devFixtureRowCount > 0 ? mockRows : liveRows;
  const { data: people = [] } = usePeople();
  const { data: accounts = [] } = useAccounts();
  const { data: creditCards = [] } = useCreditCards();
  const { data: emis = [] } = useEmis();
  const { data: loans = [] } = useLoans();
  const { data: bills = [] } = useBills();
  // Rows already committed to a real `transactions/{id}` doc need that live document, not the
  // staging copy, as the source of truth for the modal's Save/Delete — see `TransactionManageModal`.
  const { data: liveTransactions = [] } = useTransactions();

  const mutations = useTransactionStudioMutations(documentId);
  const undoRedo = useUndoRedo(documentId, mutations);

  // One `TransactionRepository` for the whole component tree, mirroring `handleApprove`'s own
  // construction below — the modal's committed-row Save/Delete route through this exact repository
  // (`editTransaction`/`softDeleteTransaction`), the same balance-safe path `/transactions` uses.
  const accountRepositoryForEdit = useMemo(() => (uid ? createAccountRepository(uid) : null), [uid]);
  const transactionRepositoryForEdit = useMemo(
    () => (uid && accountRepositoryForEdit ? createTransactionRepository(uid, accountRepositoryForEdit) : null),
    [uid, accountRepositoryForEdit],
  );

  const activeDocument = documents.find((d) => d.id === documentId);
  const filteredRows = useMemo(() => {
    const base = applyStudioSearchAndFilters(rows, search, filters);
    return showSelectedOnly ? base.filter((r) => selectedRowIds.has(r.id)) : base;
  }, [rows, search, filters, showSelectedOnly, selectedRowIds]);
  const preflightBlockers = useMemo(() => getPreflightBlockers(rows, categories), [rows, categories]);
  // The Status column's source for "something's actually wrong with this row" beyond needsReview/
  // duplicate — the exact same validation the Validation Bar already runs, just keyed by row id for
  // `StatusCell` to look up (see `deriveRowStatus`), not a second validation pass.
  const blockingReasonsByRowId = useMemo(() => {
    const map = new Map<string, CommitBlockingReason[]>();
    for (const blocker of preflightBlockers) map.set(blocker.recordId, blocker.blockingReasons);
    return map;
  }, [preflightBlockers]);
  // Both edit surfaces (the docked Inspector and the Action-button modal) need the same lookup —
  // the row's real `Transaction` once it's committed, `null` otherwise/while still loading.
  const findCommittedTransaction = (row: (typeof rows)[number] | null) =>
    row?.committedTransactionId ? (liveTransactions.find((t) => t.id === row.committedTransactionId) ?? null) : null;
  const inspectorRow = rows.find((r) => r.id === inspectorRowId) ?? null;
  const inspectorCommittedTransaction = findCommittedTransaction(inspectorRow);
  const manageModalRow = rows.find((r) => r.id === manageModalRowId) ?? null;
  const manageModalCommittedTransaction = findCommittedTransaction(manageModalRow);
  // `FinancialDocument.accountId` is documented (see that model's own field comment) to be the
  // `creditCards/{cardId}` this statement was uploaded against, NOT a real `accounts/{id}` — a card's
  // own id is always generated independently of the `Account` it extends (`CreditCardRepository.
  // createCard`). Both the display name here and, far more importantly, the real `accountId` the
  // commit engine writes onto every imported `Transaction` must resolve through the `CreditCardProfile`
  // to get the underlying `Account.id` first — treating `activeDocument.accountId` as a real account id
  // directly (as this used to) means every "Approve & Import" commit sent `TransactionRepository.
  // createTransaction` an id that's never a real `Account`, which throws "Account not found" for every
  // row, and the grid's own account display fell back to the generic "This card/account" placeholder.
  const sourceCreditCard = creditCards.find((c) => c.id === activeDocument?.accountId) ?? null;
  const sourceAccountId = sourceCreditCard?.accountId ?? null;
  const sourceAccountName = accounts.find((a) => a.id === sourceAccountId)?.name ?? "This card/account";

  async function handleApprove(skipDuplicateCheck = false) {
    if (!uid || !activeDocument || !sourceAccountId) return;

    if (!skipDuplicateCheck) {
      const warnings = detectFreshDuplicatesForCommit(rows, liveTransactions, sourceAccountId);
      if (warnings.length > 0) {
        setFreshDuplicateWarnings(warnings);
        return;
      }
    }

    setCommitting(true);
    try {
      const accountRepository = createAccountRepository(uid);
      const result = await commitReviewImport({
        rows,
        accountId: sourceAccountId,
        categories,
        people,
        accounts,
        emis,
        loans,
        bills,
        repositories: {
          transactionRepository: createTransactionRepository(uid, accountRepository),
          expenseRepository: createExpenseRepository(uid, accountRepository),
          emiRepository: createEmiRepository(uid),
          loanRepository: createLoanRepository(uid),
          installmentRepositoryFor: (scheduleId) => createInstallmentRepositoryFor(uid, scheduleId),
        },
        onRowCommitted: (recordId, transactionId) => mutations.updateFields(recordId, { committedTransactionId: transactionId }),
      });
      setCommitResult(result);
    } finally {
      setCommitting(false);
    }
  }

  const pendingCount = rows.filter((r) => r.include && !r.committedTransactionId).length;

  return (
    <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-hidden", fullscreen && "fixed inset-0 z-50 !flex-none bg-background p-4")}>
      {process.env.NODE_ENV === "development" && (
        <div className="fixed bottom-3 left-3 z-[60] flex items-center gap-1 rounded-full border bg-background/95 px-2 py-1 text-[11px] shadow-lg backdrop-blur">
          <span className="pl-1 text-muted-foreground">Dev data:</span>
          {([0, 20, 30, 200] as const).map((count) => (
            <button
              key={count}
              type="button"
              className={cn("rounded-full px-2 py-0.5 transition-colors", devFixtureRowCount === count ? "bg-primary text-primary-foreground" : "hover:bg-muted")}
              onClick={() => setDevFixtureRowCount(count)}
            >
              {count === 0 ? "Live" : `${count} rows`}
            </button>
          ))}
        </div>
      )}
      <SmsCandidatesLink />
      <StudioHeader
        document={activeDocument}
        sourceAccountName={sourceAccountName}
        rows={rows}
        selectedCount={selectedRowIds.size}
        filters={filters}
        onFiltersChange={setFilters}
        showSelectedOnly={showSelectedOnly}
        onShowSelectedOnlyChange={setShowSelectedOnly}
        onApprove={handleApprove}
        approveDisabled={committing || pendingCount === 0 || !sourceAccountId}
        approveLabel={committing ? "Importing…" : `Approve & Import (${pendingCount})`}
      />

      <ValidationBar blockers={preflightBlockers} rows={rows} mutations={mutations} onOpenRow={setInspectorRowId} />

      <StudioToolbar
        people={people}
        search={search}
        onSearchChange={setSearch}
        filters={filters}
        onFiltersChange={setFilters}
        canUndo={undoRedo.canUndo}
        canRedo={undoRedo.canRedo}
        onUndo={() => void undoRedo.undo()}
        onRedo={() => void undoRedo.redo()}
        searchInputRef={searchInputRef}
        fullscreen={fullscreen}
        onToggleFullscreen={() => setFullscreen((v) => !v)}
      />

      {commitResult && <ValidationPanel result={commitResult} onOpenRow={setInspectorRowId} />}
      {commitResult && <ImportSuccessPanel result={commitResult} onDismiss={() => setCommitResult(null)} />}

      <div ref={panelRowRef} className="flex min-h-0 min-w-0 flex-1 gap-3">
        {leftOpen ? (
          <div className="w-64 shrink-0">
            <ImportedStatementsPanel documents={documents} activeDocumentId={documentId} onSelect={setDocumentId} />
          </div>
        ) : (
          <Button variant="outline" size="icon-sm" className="h-fit" onClick={() => setLeftOpen(true)} aria-label="Show imported statements">
            <PanelLeftOpen className="size-4" />
          </Button>
        )}
        {leftOpen && (
          <Button variant="ghost" size="icon-xs" className="h-fit" onClick={() => setLeftOpen(false)} aria-label="Hide imported statements">
            <PanelLeftClose className="size-4" />
          </Button>
        )}

        <div className="flex min-w-0 flex-1 flex-col gap-2">
          {selectedRowIds.size > 0 && (
            <BulkActionBar
              selectedRowIds={selectedRowIds}
              setSelectedRowIds={setSelectedRowIds}
              rows={rows}
              categories={categories}
              liveTransactions={liveTransactions}
              transactionRepository={transactionRepositoryForEdit}
              mutations={mutations}
              undoRedo={undoRedo}
              onClear={() => setSelectedRowIds(new Set())}
            />
          )}
          <div className="flex min-h-0 flex-1 flex-col">
            <Spreadsheet
              documentId={documentId}
              rows={filteredRows}
              mutations={mutations}
              onOpenInspector={setManageModalRowId}
              selectedRowIds={selectedRowIds}
              setSelectedRowIds={setSelectedRowIds}
              liveTransactions={liveTransactions}
              transactionRepository={transactionRepositoryForEdit}
              blockingReasonsByRowId={blockingReasonsByRowId}
            />
          </div>
        </div>

        {rightOpen && (
          <Button variant="ghost" size="icon-xs" className="h-fit" onClick={() => setRightOpen(false)} aria-label="Hide details panel">
            <PanelRightClose className="size-4" />
          </Button>
        )}
        {rightOpen ? (
          <div className="w-80 shrink-0">
            <RightSidebar
              row={inspectorRow}
              committedTransaction={inspectorCommittedTransaction}
              transactionRepository={transactionRepositoryForEdit}
              sourceAccountName={sourceAccountName}
              accounts={accounts}
              people={people}
              emis={emis}
              loans={loans}
              bills={bills}
              categories={categories}
              mutations={mutations}
              onClose={() => setInspectorRowId(null)}
            />
          </div>
        ) : (
          <Button variant="outline" size="icon-sm" className="h-fit" onClick={() => setRightOpen(true)} aria-label="Show details panel">
            <PanelRightOpen className="size-4" />
          </Button>
        )}
      </div>

      <TransactionManageModal
        row={manageModalRow}
        committedTransaction={manageModalCommittedTransaction}
        transactionRepository={transactionRepositoryForEdit}
        open={manageModalRowId != null}
        onOpenChange={(open) => !open && setManageModalRowId(null)}
        sourceAccountName={sourceAccountName}
        accounts={accounts}
        people={people}
        emis={emis}
        loans={loans}
        bills={bills}
        categories={categories}
        mutations={mutations}
      />

      <DuplicateWarningDialog
        open={freshDuplicateWarnings != null && freshDuplicateWarnings.length > 0}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setFreshDuplicateWarnings(null);
        }}
        result={freshDuplicateWarnings?.[0]?.result ?? null}
        additionalCount={Math.max(0, (freshDuplicateWarnings?.length ?? 0) - 1)}
        confirmLabel="Import anyway"
        busy={committing}
        // Multiple rows can flag at once — the dialog surfaces the strongest match's reason as a
        // representative sample; "Import anyway" proceeds with the whole commit, never auto-excludes
        // any row, matching the "never auto-reject" requirement for this whole feature.
        onConfirm={() => {
          setFreshDuplicateWarnings(null);
          void handleApprove(true);
        }}
      />
    </div>
  );
}
