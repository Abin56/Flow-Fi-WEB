"use client";

/**
 * Transaction Reconciliation Studio — an isolated, client-side review of statement rows against what FlowFi already
 * has. Matching is advisory; every decision is a draft kept in this tab. Nothing is written while reviewing. The only
 * write is the explicit final approval (Phase 4, approval-dialog.tsx → approval-commit.ts), which re-reads FlowFi,
 * revalidates, and imports only rows decided "Import as new" through the existing commit engine.
 *
 * Layout: desktop = the workspace fits the viewport — header, account bar, toolbar and action bar stay put; the grid
 * body scrolls on its own, and the comparison docked beside it (wide screens) scrolls separately; below the wide
 * breakpoint the comparison opens in a drawer. Mobile = one natural page scroll of compact cards, a details/match
 * sheet, and a sticky action bar.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { ArrowLeft, GitCompareArrows, History, Keyboard, Loader2, RefreshCw, Trash2, TriangleAlert, X } from "lucide-react";
import { HeaderAction, WorkspaceHeader } from "@/features/smart-capture/components/workspace-header";
import { ClayButton } from "@/components/clay/clay-button";
import { cn } from "@/lib/utils";
import { ConfirmDialog } from "@/components/finance/confirm-dialog";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DetailDrawer } from "@/components/finance/detail-drawer";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useReconciliationApproval } from "../hooks/use-reconciliation-approval";
import { useReconciliationSession } from "../hooks/use-reconciliation-session";
import { sourceLabel, type RecordsSync } from "../hooks/use-reconciliation-data";
import { consumePendingHandoff, declinePendingHandoff, getHandoffState, releaseReconciliationScreenshot, screenshotFor, subscribeHandoff } from "../lib/capture-handoff";
import { buildCycleResolver } from "../lib/card-cycle-status";
import { bulkLinkEligible, decisionErrors, decisionFor, importBlockReasons, reviewSummary, type RowGateContext } from "../lib/decisions";
import { buildExistingRecords } from "../lib/existing-records";
import { computeMatches, siblingAccountIdsFor, type ReconciliationData } from "../lib/analyze";
import type { ApprovalDeps } from "../lib/approval-commit";
import { buildApprovalPlan } from "../lib/approval-plan";
import { readinessCounts, type ReadinessCounts } from "../lib/readiness";
import type { MatchState, ReconRow, RowMatch } from "../lib/types";
import { ApprovalDialog } from "./approval-dialog";
import { MatchPanel } from "./match-panel";
import { ReconAccountBar, type AccountOption } from "./recon-header";
import { ReconIntake } from "./recon-intake";
import { ReconMobileList } from "./recon-mobile-list";
import { ReconRowEditor } from "./recon-row-editor";
import { ReconTable } from "./recon-table";
import { ReconToolbar, type ReconFilter, type ReconSort } from "./recon-toolbar";
import { accountIdentity, accountLabel } from "./recon-ui";

export type { ReconciliationData };

const ATTENTION_ORDER: Record<MatchState, number> = { conflict: 0, multiple: 1, near_amount: 2, same_merchant_date: 2, in_inbox: 3, no_match: 4, exact_candidate: 5, already_imported: 6, excluded: 7 };

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable || el.getAttribute("role") === "combobox";
}

/** Whether match results may be shown: never before the account is chosen or before every required source has loaded. */
export type MatchStatus = "need_account" | "loading" | "error" | "ready";

const SYNCED: RecordsSync = { loading: [], failed: [], retry: () => undefined };

export function ReconciliationWorkspace({ uid, data, sync = SYNCED, approvalDeps }: { uid: string | null | undefined; data: ReconciliationData; sync?: RecordsSync; /** Test seam for the final approval's server read and repositories; the app builds its own. */ approvalDeps?: ApprovalDeps }) {
  const s = useReconciliationSession(uid, data.accounts);
  const session = s.session;
  const accountId = session?.accountId ?? null;
  const handoff = useSyncExternalStore(subscribeHandoff, getHandoffState, getHandoffState);
  const [handoffNotice, setHandoffNotice] = useState<string | null>(null);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const matchStatus: MatchStatus = !accountId ? "need_account" : sync.failed.length > 0 ? "error" : sync.loading.length > 0 ? "loading" : "ready";
  const screenshot = screenshotFor(session?.fingerprint)?.capture ?? null;
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  const isWide = useMediaQuery("(min-width: 1536px)");

  const [filter, setFilter] = useState<ReconFilter>("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<ReconSort>("statement");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [compareOpen, setCompareOpen] = useState(false);
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);
  const [lastBulk, setLastBulk] = useState<{ id: string; count: number } | null>(null);
  const [pendingAccount, setPendingAccount] = useState<string | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);

  // ---- derived, read-only ----
  const records = useMemo(
    () => buildExistingRecords({ transactions: data.transactions, trashedTransactions: data.trashedTransactions, smsCandidates: data.smsCandidates, creditCards: data.creditCards, expenses: data.expenses }),
    [data.transactions, data.trashedTransactions, data.smsCandidates, data.creditCards, data.expenses],
  );
  const recordsById = useMemo(() => new Map(records.map((r) => [r.id, r])), [records]);
  const accountName = useCallback((id: string) => accountLabel(id, data.accounts, data.creditCards), [data.accounts, data.creditCards]);
  const accountOptions: AccountOption[] = useMemo(
    () =>
      data.accounts
        .filter((a) => a.deletedAt == null)
        .sort((a, b) => Number(b.type === "card") - Number(a.type === "card") || a.name.localeCompare(b.name))
        .map((a) => accountIdentity(a, data.creditCards)),
    [data.accounts, data.creditCards],
  );
  const accountsStatus = sync.failed.includes("accounts") ? "error" : sync.loading.includes("accounts") ? "loading" : "ready";
  const account = data.accounts.find((a) => a.id === accountId) ?? null;
  const card = useMemo(() => (accountId ? (data.creditCards.find((c) => c.accountId === accountId && c.deletedAt == null) ?? null) : null), [accountId, data.creditCards]);
  const siblingAccountIds = useMemo(() => siblingAccountIdsFor(card, data.creditCards), [card, data.creditCards]);

  const matches = useMemo(() => {
    // An empty list before the first snapshot is "not loaded", never "no match" — results wait for every source.
    if (!session || !accountId || matchStatus !== "ready") return new Map<string, RowMatch>();
    return computeMatches({ session, accountId, records, siblingAccountIds, accountLabel: accountName });
  }, [session, accountId, matchStatus, records, siblingAccountIds, accountName]);

  // ---- Smart Capture handoff ----
  // Waits for the tab's draft to load first, so an in-progress review is never overwritten by accident.
  const pending = handoff.pending;
  const handoffConflict = s.ready && pending != null && session != null && session.fingerprint !== pending.fingerprint;
  useEffect(() => {
    if (!s.ready || !pending) return;
    if (!session) {
      const taken = consumePendingHandoff();
      if (taken) {
        s.startFromHandoff(taken);
        /* eslint-disable-next-line react-hooks/set-state-in-effect -- reports the handoff that was just applied */
        setHandoffNotice(`${taken.rows.filter((r) => r.include).length} verified rows arrived from Smart Capture.`);
      }
      return;
    }
    if (session.fingerprint === pending.fingerprint) {
      const taken = consumePendingHandoff();
      const outcome = taken ? s.applySameCaptureHandoff(taken) : null;
      if (outcome) {
        const parts = [outcome.changed && `${outcome.changed} changed (their decisions were cleared)`, outcome.added && `${outcome.added} added`, outcome.removed && `${outcome.removed} removed`].filter(Boolean);
        setHandoffNotice(parts.length ? `Updated from Smart Capture: ${parts.join(", ")}. Your other decisions are kept.` : "Back from Smart Capture — nothing changed, your decisions are kept.");
      }
    }
    // A different capture waits for the user's explicit choice (handoffConflict).
  }, [s, pending, session]);

  const cycleOf = useMemo(() => buildCycleResolver({ card, transactions: data.transactions, statements: data.statements }), [card, data.transactions, data.statements]);
  const isCardAccount = account?.type === "card";
  const gate = useCallback((row: ReconRow): RowGateContext => ({ isCardAccount, cycle: row.date ? cycleOf(row.date) : null }), [isCardAccount, cycleOf]);

  const rows = useMemo(() => session?.rows ?? [], [session]);
  const decisions = useMemo(() => session?.decisions ?? {}, [session]);
  const numberOf = useCallback((rowId: string) => rows.findIndex((r) => r.id === rowId) + 1, [rows]);
  const summary = useMemo(() => (session && matchStatus === "ready" ? reviewSummary(rows, matches, decisions, gate) : null), [session, matchStatus, rows, matches, decisions, gate]);
  const readiness = useMemo(() => (session && matchStatus === "ready" ? readinessCounts(rows, matches, decisions, gate) : null), [session, matchStatus, rows, matches, decisions, gate]);
  const plan = useMemo(() => (session && accountId && matchStatus === "ready" ? buildApprovalPlan({ rows, matches, decisions, gate }) : null), [session, accountId, matchStatus, rows, matches, decisions, gate]);
  const approval = useReconciliationApproval({ uid, session, plan, account, liveData: data, dataReady: matchStatus === "ready", deps: approvalDeps });
  const period = useMemo(() => {
    const dates = rows.filter((r) => r.include && r.date).map((r) => r.date!.getTime());
    return dates.length ? { from: new Date(Math.min(...dates)), to: new Date(Math.max(...dates)) } : null;
  }, [rows]);

  const filterOf = useCallback(
    (row: ReconRow): ReconFilter[] => {
      const match = matches.get(row.id);
      if (!match) return ["all"];
      const decision = decisionFor(decisions, row.id);
      const out: ReconFilter[] = ["all"];
      const stateFilter: Partial<Record<MatchState, ReconFilter>> = {
        exact_candidate: "exact",
        near_amount: "near",
        same_merchant_date: "near",
        multiple: "multiple",
        no_match: "no_match",
        in_inbox: "in_inbox",
        conflict: "conflict",
        already_imported: "imported",
        excluded: "excluded",
      };
      if (stateFilter[match.state]) out.push(stateFilter[match.state]!);
      if (match.state !== "excluded") {
        const valid = decision.kind != null && decision.kind !== "investigate" && decisionErrors(row, match, decision, gate(row)).length === 0;
        out.push(valid ? "decided" : "open");
      }
      return out;
    },
    [matches, decisions, gate],
  );

  const counts = useMemo(() => {
    const c = { all: 0, open: 0, exact: 0, near: 0, multiple: 0, no_match: 0, in_inbox: 0, conflict: 0, imported: 0, decided: 0, excluded: 0 } satisfies Record<ReconFilter, number>;
    for (const row of rows) for (const f of filterOf(row)) c[f]++;
    return c;
  }, [rows, filterOf]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/[,₹\s]/g, "");
    const list = rows.filter((row) => {
      if (!filterOf(row).includes(filter)) return false;
      if (!q) return true;
      return row.description.toLowerCase().replace(/\s/g, "").includes(q) || (row.amount != null && row.amount.toFixed(2).includes(q));
    });
    const order = new Map(rows.map((r, i) => [r.id, i]));
    const byOrder = (a: ReconRow, b: ReconRow) => order.get(a.id)! - order.get(b.id)!;
    if (sort === "date") return [...list].sort((a, b) => (a.date?.getTime() ?? 0) - (b.date?.getTime() ?? 0) || byOrder(a, b));
    if (sort === "amount") return [...list].sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0) || byOrder(a, b));
    if (sort === "attention") {
      const rank = (r: ReconRow) => (matches.get(r.id) ? ATTENTION_ORDER[matches.get(r.id)!.state] : 9);
      return [...list].sort((a, b) => rank(a) - rank(b) || byOrder(a, b));
    }
    return list;
  }, [rows, filter, query, sort, filterOf, matches]);

  const activeId = selectedId && rows.some((r) => r.id === selectedId) ? selectedId : (visible[0]?.id ?? null);
  const activeRow = rows.find((r) => r.id === activeId) ?? null;
  const activeMatch = activeId ? matches.get(activeId) : undefined;
  const bulkPairs = useMemo(() => bulkLinkEligible(rows, matches, decisions), [rows, matches, decisions]);

  // Keep the keyboard-selected row in view (the app scrolls <main>, so the browser finds the right scroller).
  useEffect(() => {
    if (activeId) document.getElementById(`recon-row-${activeId}`)?.scrollIntoView?.({ block: "nearest" });
  }, [activeId]);

  // ---- actions ----
  const select = (rowId: string) => setSelectedId(rowId);
  const compare = (rowId: string) => {
    setSelectedId(rowId);
    if (!isWide) setCompareOpen(true);
  };

  function chooseAccount(id: string) {
    const hasDecisions = Object.values(decisions).some((d) => d.kind === "link" || d.kind === "import_new" || d.kind === "inbox");
    if (accountId && id !== accountId && hasDecisions) setPendingAccount(id);
    else s.setAccount(id);
    setLastBulk(null);
  }

  function onGridKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
    const idx = visible.findIndex((r) => r.id === activeId);
    const move = (delta: number) => {
      const next = visible[Math.min(Math.max(idx + delta, 0), visible.length - 1)];
      if (next) setSelectedId(next.id);
    };
    const row = activeRow;
    const match = activeMatch;
    switch (e.key) {
      case "ArrowDown":
      case "j":
        e.preventDefault();
        move(1);
        return;
      case "ArrowUp":
      case "k":
        e.preventDefault();
        move(-1);
        return;
      case "Enter":
        if (row) {
          e.preventDefault();
          setExpandedId((x) => (x === row.id ? null : row.id));
        }
        return;
      case "Escape":
        setExpandedId(null);
        return;
      case "o":
        if (row && match) compare(row.id);
        return;
    }
    if (!row || !match || match.state === "excluded") return;
    switch (e.key.toLowerCase()) {
      case "l": {
        const target = match.alreadyImportedId ?? match.suggestedRecordId;
        if (target && !match.claimedBy[target]) s.decide(row.id, { kind: "link", linkedRecordId: target });
        return;
      }
      case "n": {
        // Import as new straight from the keyboard only when there's nothing to compare against; otherwise open the
        // comparison so the "different transaction" confirmation is given explicitly.
        const blocked = importBlockReasons(row, match, gate(row)).length > 0;
        if (blocked) return;
        if (match.candidates.length > 0 || match.pendingSms.length > 0) compare(row.id);
        else s.decide(row.id, { kind: "import_new" });
        return;
      }
      case "i":
        s.decide(row.id, { kind: "ignore" });
        return;
      case "?":
        s.decide(row.id, { kind: "investigate" });
        return;
    }
  }

  // ---- render ----
  if (!s.ready) {
    return <div className="h-40 animate-pulse rounded-3xl bg-muted/60" aria-label="Loading" />;
  }

  const panelFor = (row: ReconRow, match: RowMatch) => (
    <MatchPanel
      row={row}
      rowNumber={numberOf(row.id)}
      match={match}
      decision={decisionFor(decisions, row.id)}
      gate={gate(row)}
      records={records}
      recordsById={recordsById}
      accountId={accountId!}
      accountName={accountName}
      rowNumberOf={numberOf}
      onDecide={(patch) => s.decide(row.id, patch)}
      onReject={(recordId) => s.reject(row.id, recordId)}
      screenshot={screenshot}
      captureSource={session?.source ?? "text"}
    />
  );
  const pendingLabel = matchStatus === "loading" ? "Loading FlowFi records…" : matchStatus === "error" ? "Can't compare — data didn't load" : "Choose the statement account";
  const editorFor = (row: ReconRow) => (
    <ReconRowEditor
      row={row}
      decision={decisionFor(decisions, row.id)}
      categories={data.categories}
      onPatch={(patch) => s.patchRow(row.id, patch)}
      onConfirmRow={() => s.confirmRow(row.id)}
      onConfirmField={(field) => s.confirmField(row.id, field)}
      onDecide={(patch) => s.decide(row.id, patch)}
      accountLabel={accountId ? accountName(accountId) : null}
    />
  );

  const noticeText =
    s.notice === "restored"
      ? "Restored your review from earlier in this tab."
      : s.notice === "expired"
        ? "Your earlier review was more than 12 hours old, so it was removed."
        : s.notice === "corrupt"
          ? "A saved review couldn't be read, so it was removed."
          : null;

  // Desktop with a review open: fit the viewport so only the grid (and the docked comparison) scroll. Very short
  // windows fall back to the page scrolling (min height), never to clipped controls.
  const fit = isDesktop && session != null;

  return (
    <div className={cn("flex flex-col gap-3 px-1 pb-2", fit && "h-[calc(100dvh-6.5rem)] min-h-[36rem] pb-0")}>
      <WorkspaceHeader icon={GitCompareArrows} title="Reconciliation" current="reconcile" steps={{ capture: { href: "/smart-capture" }, review: { href: "/smart-capture" } }}>
        <Link
          href="/smart-capture"
          data-testid="back-to-capture"
          className="inline-flex h-7 items-center gap-1.5 rounded-full border border-white/10 px-2.5 text-xs font-medium text-hero-foreground/80 transition-colors hover:bg-white/10 hover:text-hero-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <ArrowLeft className="size-3.5" /> Back to Smart Capture
        </Link>
        {session && (
          <HeaderAction icon={Trash2} tone="danger" onClick={() => setDiscardOpen(true)}>
            Discard this review
          </HeaderAction>
        )}
      </WorkspaceHeader>

      {noticeText && (
        <div role="status" className="flex items-center gap-2 rounded-2xl bg-primary/10 px-3 py-2 text-sm text-foreground">
          <History className="size-4 shrink-0 text-primary-accent-text" />
          <span className="min-w-0 flex-1">{noticeText}</span>
          <button type="button" aria-label="Dismiss" onClick={s.dismissNotice} className="rounded-full p-1 text-muted-foreground hover:text-foreground">
            <X className="size-4" />
          </button>
        </div>
      )}

      {handoffNotice && (
        <div role="status" className="flex items-center gap-2 rounded-2xl bg-primary/10 px-4 py-2.5 text-sm text-foreground" data-testid="handoff-notice">
          <History className="size-4 shrink-0 text-primary-accent-text" />
          <span className="min-w-0 flex-1">{handoffNotice}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setHandoffNotice(null)} className="rounded-full p-1 text-muted-foreground hover:text-foreground">
            <X className="size-4" />
          </button>
        </div>
      )}

      {handoffConflict && pending && (
        <section role="alertdialog" aria-labelledby="handoff-conflict-title" className="surface-primary flex flex-col gap-3 rounded-3xl border border-warning/40 p-4" data-testid="handoff-conflict">
          <div>
            <h2 id="handoff-conflict-title" className="text-sm font-semibold text-foreground">
              A different capture is waiting
            </h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Smart Capture sent {pending.rows.filter((r) => r.include).length} new rows, but you already have a review in progress here. Nothing has been replaced.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <ClayButton size="sm" variant="secondary" onClick={() => declinePendingHandoff()}>
              Keep my current review
            </ClayButton>
            <ClayButton size="sm" onClick={() => setReplaceOpen(true)}>
              Review the new capture instead
            </ClayButton>
          </div>
        </section>
      )}

      {session && accountId && matchStatus === "loading" && (
        <p role="status" className="flex items-center gap-2 rounded-2xl bg-muted/60 px-4 py-2.5 text-sm text-muted-foreground" data-testid="records-loading">
          <Loader2 className="size-4 shrink-0 animate-spin" /> Loading your FlowFi {sync.loading.map(sourceLabel).join(", ")}… Matches appear once everything has loaded.
        </p>
      )}
      {session && accountId && matchStatus === "error" && (
        <div role="alert" className="flex flex-wrap items-center gap-2 rounded-2xl border border-danger/30 bg-danger/10 px-4 py-2.5 text-sm text-danger" data-testid="records-error">
          <TriangleAlert className="size-4 shrink-0" />
          <span className="min-w-0 flex-1">Couldn&apos;t load your FlowFi {sync.failed.map(sourceLabel).join(", ")}, so rows can&apos;t be compared — nothing is shown as &quot;No match&quot; until this works.</span>
          <ClayButton size="sm" variant="secondary" onClick={sync.retry}>
            <RefreshCw className="size-3.5" /> Retry
          </ClayButton>
        </div>
      )}

      {!session ? (
        <ReconIntake onStart={s.startFromText} />
      ) : (
        <>
          <ReconAccountBar
            options={accountOptions}
            accountId={accountId}
            onChange={chooseAccount}
            status={accountsStatus}
            onRetry={sync.retry}
            period={period}
            expiresAt={s.expiresAt}
            storageFailed={s.storageFailed}
          />

          {accountId && (
            <ReconToolbar
              filter={filter}
              onFilter={setFilter}
              counts={counts}
              query={query}
              onQuery={setQuery}
              sort={sort}
              onSort={setSort}
              bulkCount={bulkPairs.length}
              onBulkLink={() => setBulkConfirmOpen(true)}
              undoCount={lastBulk?.count ?? 0}
              onUndo={() => {
                if (lastBulk) s.undoBulk(lastBulk.id);
                setLastBulk(null);
              }}
            />
          )}

          {isDesktop ? (
            <div className={cn("grid min-h-0 flex-1 gap-3", isWide && accountId && "grid-cols-[minmax(0,1fr)_26rem]")}>
              <ReconTable
                ref={gridRef}
                rows={visible}
                numberOf={numberOf}
                matches={matches}
                decisions={decisions}
                selectedId={activeId}
                expandedId={expandedId}
                onSelect={select}
                onToggleExpand={(id) => {
                  setSelectedId(id);
                  setExpandedId((x) => (x === id ? null : id));
                }}
                onCompare={compare}
                pendingLabel={pendingLabel}
                renderEditor={editorFor}
                onKeyDown={onGridKeyDown}
              />
              {isWide && accountId && (
                <aside aria-label="Match comparison" className="min-h-0 overflow-y-auto overscroll-contain rounded-2xl border border-border bg-card p-3" data-testid="compare-aside">
                  {activeRow && activeMatch ? panelFor(activeRow, activeMatch) : <p className="text-sm text-muted-foreground">{matchStatus === "ready" ? "Select a row to compare it." : pendingLabel}</p>}
                </aside>
              )}
            </div>
          ) : (
            <ReconMobileList rows={visible} numberOf={numberOf} matches={matches} decisions={decisions} onOpen={compare} pendingLabel={pendingLabel} />
          )}

          <ReadinessBar
            rowsCount={rows.length}
            summary={summary}
            readiness={readiness}
            canApprove={approval.canOpen}
            hasAccount={!!accountId}
            onApprove={approval.open}
            desktop={isDesktop}
          />
        </>
      )}

      {/* Comparison: drawer on desktop below the wide breakpoint; details/match sheet on mobile. */}
      {isDesktop && !isWide && activeRow && activeMatch && (
        <DetailDrawer open={compareOpen} onOpenChange={setCompareOpen} title={`Compare row ${numberOf(activeRow.id)}`} description="Statement row vs. FlowFi — nothing changes until you give the final approval."
          // The Sheet's own `data-[side=right]:sm:max-w-sm` out-ranks a plain `sm:` width, so widen with the same variant.
          className="data-[side=right]:sm:max-w-[560px]"
        >
          {panelFor(activeRow, activeMatch)}
        </DetailDrawer>
      )}
      {!isDesktop && activeRow && (
        <Sheet open={compareOpen} onOpenChange={setCompareOpen}>
          <SheetContent side="bottom" className="gap-0 rounded-t-3xl p-0" data-testid="mobile-sheet">
            <SheetHeader className="border-b border-border/60 px-4 py-3">
              <SheetTitle>Row {numberOf(activeRow.id)}</SheetTitle>
              <SheetDescription className="truncate">{activeRow.description || "No description"}</SheetDescription>
            </SheetHeader>
            <Tabs defaultValue={activeMatch ? "match" : "details"} className="px-4 py-3">
              <TabsList className="w-full">
                <TabsTrigger value="match" disabled={!activeMatch}>
                  Match
                </TabsTrigger>
                <TabsTrigger value="details">Details</TabsTrigger>
              </TabsList>
              <TabsContent value="match" className="pt-3">
                {activeMatch && panelFor(activeRow, activeMatch)}
              </TabsContent>
              <TabsContent value="details" className="pt-3">
                {editorFor(activeRow)}
              </TabsContent>
            </Tabs>
          </SheetContent>
        </Sheet>
      )}

      <ApprovalDialog
        approval={approval}
        plan={plan}
        account={account}
        accountLabel={accountId ? accountName(accountId) : ""}
        onClearReview={() => {
          approval.close();
          s.discard();
          releaseReconciliationScreenshot();
          setSelectedId(null);
          setExpandedId(null);
          setLastBulk(null);
          setFilter("all");
        }}
      />
      <ConfirmDialog
        open={bulkConfirmOpen}
        onOpenChange={setBulkConfirmOpen}
        title={`Mark ${bulkPairs.length} exact match${bulkPairs.length === 1 ? "" : "es"} as already recorded?`}
        description="Each of these rows has exactly one FlowFi transaction on this account with the same amount and day, and no other close match. They'll be skipped at import. This only changes your draft — nothing in FlowFi changes, and you can undo it."
        confirmLabel="Mark already recorded"
        onConfirm={() => {
          const id = `bulk_${Date.now()}`;
          s.bulkLink(bulkPairs, id);
          setLastBulk({ id, count: bulkPairs.length });
          setBulkConfirmOpen(false);
        }}
      />
      <ConfirmDialog
        open={pendingAccount != null}
        onOpenChange={(open) => !open && setPendingAccount(null)}
        title="Change the statement account?"
        description={`Possible matches are recalculated for ${pendingAccount ? accountName(pendingAccount) : "the new account"}. "Already recorded", "Add as new" and Inbox decisions were made against ${accountId ? accountName(accountId) : "the current account"}'s transactions, so they'll be cleared — along with any "Not this match" choices. Skip and Review later stay.`}
        confirmLabel="Change account"
        onConfirm={() => {
          if (pendingAccount) s.setAccount(pendingAccount);
          setPendingAccount(null);
        }}
      />
      <ConfirmDialog
        open={discardOpen}
        onOpenChange={setDiscardOpen}
        variant="destructive"
        title="Discard this review?"
        description="Removes these rows and your decisions from this tab. Nothing in FlowFi is affected."
        confirmLabel="Discard"
        onConfirm={() => {
          s.discard();
          releaseReconciliationScreenshot();
          setDiscardOpen(false);
          setSelectedId(null);
          setExpandedId(null);
          setLastBulk(null);
          setFilter("all");
        }}
      />
      <ConfirmDialog
        open={replaceOpen}
        onOpenChange={setReplaceOpen}
        variant="destructive"
        title="Replace your current review?"
        description="Your current review's rows and decisions are removed from this tab and the new capture from Smart Capture takes their place. Nothing in FlowFi is affected."
        confirmLabel="Replace review"
        onConfirm={() => {
          releaseReconciliationScreenshot();
          const taken = consumePendingHandoff();
          if (taken) {
            s.startFromHandoff(taken);
            setHandoffNotice(`${taken.rows.filter((r) => r.include).length} verified rows arrived from Smart Capture.`);
          }
          setReplaceOpen(false);
          setSelectedId(null);
          setExpandedId(null);
          setLastBulk(null);
          setFilter("all");
        }}
      />
    </div>
  );
}

type ReadinessTone = "default" | "success" | "primary" | "warning" | "danger";
const READINESS_TONE: Record<ReadinessTone, string> = {
  default: "text-foreground",
  success: "text-success",
  primary: "text-primary-accent-text",
  warning: "text-warning",
  danger: "text-danger",
};

/**
 * The draft-only readiness summary + the final approval entry point. It never says everything will be imported: it
 * names what final approval would add, and what it would leave alone.
 */
function ReadinessBar({
  rowsCount,
  summary,
  readiness,
  canApprove,
  hasAccount,
  onApprove,
  desktop,
}: {
  rowsCount: number;
  summary: ReturnType<typeof reviewSummary> | null;
  readiness: ReadinessCounts | null;
  canApprove: boolean;
  hasAccount: boolean;
  onApprove: () => void;
  desktop: boolean;
}) {
  const items: { key: string; label: string; value: number; tone: ReadinessTone; hideZero?: boolean }[] = readiness
    ? [
        { key: "included", label: "Included", value: readiness.included, tone: "default" },
        { key: "already-recorded", label: "Already recorded", value: readiness.alreadyRecorded, tone: "success" },
        { key: "add-new", label: "Add as new", value: readiness.proposedNew, tone: "primary" },
        { key: "imported-earlier", label: "Imported earlier", value: readiness.alreadyImported, tone: "success", hideZero: true },
        { key: "skipped", label: "Skipped", value: readiness.skipped, tone: "default" },
        { key: "inbox", label: "Left for Inbox", value: readiness.inbox, tone: "default", hideZero: true },
        { key: "review-later", label: "Review later", value: readiness.reviewLater, tone: readiness.reviewLater > 0 ? "warning" : "default" },
        { key: "undecided", label: "Undecided", value: readiness.unresolved, tone: readiness.unresolved > 0 ? "warning" : "default" },
        { key: "blocked", label: "Blocked by rules", value: readiness.blocked, tone: readiness.blocked > 0 ? "danger" : "default" },
      ]
    : [];
  const open = readiness ? readiness.unresolved + readiness.reviewLater : 0;
  const hint = !hasAccount
    ? "Choose the statement account to start checking for matches. Nothing is written while you review."
    : !readiness
      ? "Waiting for your FlowFi records before anything can be compared."
      : canApprove
        ? readiness.proposedNew > 0
          ? `Final approval would add ${readiness.proposedNew} new transaction${readiness.proposedNew === 1 ? "" : "s"}; already-recorded, skipped and Inbox rows are never written. Nothing is written until you confirm in the next step.`
          : "Final approval would add nothing new — already-recorded, skipped and Inbox rows are never written."
        : `${open} row${open === 1 ? "" : "s"} still need${open === 1 ? "s" : ""} a decision before final approval. Nothing is written to FlowFi while you review.`;

  return (
    <div
      data-testid="status-bar"
      // Phones: one line (progress + approve) so the sticky bar never hides much of the screen; the per-outcome counts
      // and the explanation appear from the small breakpoint up.
      className={cn("z-[1] flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-border bg-card px-3 py-2 sm:px-4", desktop ? "shrink-0" : "sticky bottom-0 shadow-e4")}
    >
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-1 sm:basis-full">
        <p className="text-sm font-medium text-foreground">
          {summary ? (
            <>
              <span className="tabular-nums" data-testid="progress-count">
                {summary.decided}/{summary.included}
              </span>{" "}
              rows decided
            </>
          ) : (
            `${rowsCount} rows captured`
          )}
        </p>
        {items.length > 0 && (
          <dl className="hidden flex-wrap items-center gap-x-3 gap-y-0.5 text-xs sm:flex" data-testid="readiness-counts">
            {items
              .filter((i) => !(i.hideZero && i.value === 0))
              .map((i) => (
                <div key={i.key} className="flex items-baseline gap-1" data-testid={`readiness-${i.key}`}>
                  <dt className="text-muted-foreground">{i.label}</dt>
                  <dd className={cn("font-semibold tabular-nums", READINESS_TONE[i.tone])}>{i.value}</dd>
                </div>
              ))}
          </dl>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1.5 sm:flex-1 sm:basis-full">
        <p className="hidden min-w-0 flex-1 text-xs text-muted-foreground sm:block" data-testid="approval-hint">
          {hint}
        </p>
        {desktop && hasAccount && (
          <p className="hidden items-center gap-1.5 text-[11px] text-muted-foreground 2xl:flex">
            <Keyboard className="size-3.5" /> J/K move · Enter details · O compare · L already recorded · N add new · I skip · ? review later
          </p>
        )}
        {hasAccount && (
          <ClayButton size="sm" onClick={onApprove} disabled={!canApprove} data-testid="open-approval">
            Review &amp; approve
          </ClayButton>
        )}
      </div>
    </div>
  );
}
