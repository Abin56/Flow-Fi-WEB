"use client";

/**
 * Transaction Reconciliation Studio — an isolated, client-side review of statement rows against what FlowFi already
 * has. Matching is advisory; every decision is a draft kept in this tab. Nothing is written while reviewing. The only
 * write is the explicit final approval (Phase 4, approval-dialog.tsx → approval-commit.ts), which re-reads FlowFi,
 * revalidates, and imports only rows decided "Import as new" through the existing commit engine.
 *
 * Layout — a Git-merge-style dual-sheet studio. Desktop: the workspace fits the viewport; the New Statement sheet
 * (left) and the Existing FlowFi sheet (right) sit side by side, each scrolling on its own under a sticky header, with
 * a draggable spine between them. Selecting a statement row drives the FlowFi sheet; selecting a FlowFi transaction
 * drives the comparison dock below (field-by-field diff, Git-style resolutions, financial effect, Undo). The full
 * comparison (screenshot, notes, Inbox) opens in a drawer on request. Phones: the two sheets become two tabs with the
 * selected row pinned, a details/match sheet, and a sticky action bar.
 *
 * Focus Mode (header button, F) hides the app sidebar and topbar so the studio gets the whole viewport; Full screen
 * adds the browser's own fullscreen on top (see use-focus-mode.ts). Both are view-only.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { ArrowDownToLine, ArrowLeft, CheckCircle2, Expand, GitCompareArrows, History, Info, Loader2, Maximize2, Minimize2, RefreshCw, Shrink, Trash2, TriangleAlert, Undo2, X } from "lucide-react";
import { HeaderAction, WorkspaceHeader } from "@/features/smart-capture/components/workspace-header";
import { ClayButton } from "@/components/clay/clay-button";
import { cn } from "@/lib/utils";
import { ConfirmDialog } from "@/components/finance/confirm-dialog";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TransactionSheet } from "@/components/finance/transaction-sheet";
import { DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useMediaQuery } from "@/hooks/use-media-query";
import { FOCUS_TOGGLE_TESTID, useFocusMode } from "../hooks/use-focus-mode";
import { useReconciliationApproval } from "../hooks/use-reconciliation-approval";
import { useReconciliationSession } from "../hooks/use-reconciliation-session";
import { sourceLabel, type RecordsSync } from "../hooks/use-reconciliation-data";
import { consumePendingHandoff, declinePendingHandoff, getHandoffState, releaseReconciliationScreenshot, screenshotFor, subscribeHandoff } from "../lib/capture-handoff";
import { buildCycleResolver } from "../lib/card-cycle-status";
import { applyBulkLink, bulkLinkEligible, decisionErrors, decisionFor, importBlockReasons, ownTransferConfirmFor, rejectCandidate, reviewSummary, setDecision, type RowGateContext } from "../lib/decisions";
import { diffDecisions, pushHistory, undoLast, type HistoryEntry } from "../lib/decision-history";
import { calendarDayIndex } from "../lib/amounts-and-days";
import {
  defaultTargetId,
  existingEntries,
  fieldDiffs,
  financialEffect,
  hasPossibleMatch,
  linkedRowsByRecord,
  merchantHistory,
  resolutionOptions,
  rowsCandidateFor,
  type ExistingSheetMode,
} from "../lib/merge-studio";
import { buildExistingRecords } from "../lib/existing-records";
import { ownedAccountIdentities } from "../lib/internal-payment-guard";
import { computeMatches, siblingAccountIdsFor, type ReconciliationData } from "../lib/analyze";
import type { ApprovalDeps } from "../lib/approval-commit";
import { buildApprovalPlan } from "../lib/approval-plan";
import { readinessCounts, type ReadinessCounts } from "../lib/readiness";
import type { MatchState, ReconRow, RowDecision, RowMatch } from "../lib/types";
import { ApprovalDialog } from "./approval-dialog";
import { ExistingSheet } from "./existing-sheet";
import { MobileExistingList, MobileSheetSwitch, type MobileTab } from "./recon-mobile-compare";
import { ResolutionDock, type ImportPatch } from "./resolution-dock";
import { ResolutionPreviewDialog, type PreviewKind } from "./resolution-previews";
import { SheetDivider, useSheetSplit } from "./sheet-divider";
import { MatchPanel } from "./match-panel";
import type { QuickAction } from "./recon-decision-menu";
import { ReconAccountBar, type AccountOption } from "./recon-header";
import { ReconIntake } from "./recon-intake";
import { ReconMobileList } from "./recon-mobile-list";
import { ReconRowEditor, ReconRowSheet } from "./recon-row-editor";
import { ReconTable } from "./recon-table";
import { ReconToolbar, type ReconFilter, type ReconSort } from "./recon-toolbar";
import { DECISION_META, KEEP_BOTH_LABEL, SHEET_TITLE_BAR, accountIdentity, accountLabel, decisionShort } from "./recon-ui";

export type { ReconciliationData };

const DOCK_KEY = "flowfi.recon.dockCollapsed";

/** Whether the comparison dock starts collapsed — a per-viewer convenience; works the same without storage. */
function readDockCollapsed(): boolean {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(DOCK_KEY) === "1";
  } catch {
    return false;
  }
}

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

  const [filter, setFilter] = useState<ReconFilter>("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<ReconSort>("statement");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** The row's editor sheet (desktop). It always shows the selected row, so moving the selection moves it too. */
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);
  const [lastBulk, setLastBulk] = useState<{ id: string; count: number } | null>(null);
  const [pendingAccount, setPendingAccount] = useState<string | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);
  const existingGridRef = useRef<HTMLDivElement>(null);
  const dualRef = useRef<HTMLDivElement>(null);
  const { split, setSplit, bounds: splitRange } = useSheetSplit(dualRef);
  // ---- dual-sheet state (view-only, never saved) ----
  const [sheetMode, setSheetMode] = useState<ExistingSheetMode>("matches");
  const [existingQuery, setExistingQuery] = useState("");
  /** The FlowFi transaction picked in the right sheet — for one statement row; another row starts on its own default. */
  const [recordPick, setRecordPick] = useState<{ rowId: string; recordId: string } | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [undoNotice, setUndoNotice] = useState<string | null>(null);
  const [confirmFor, setConfirmFor] = useState<"keep_both" | "import_new" | null>(null);
  const [preview, setPreview] = useState<PreviewKind | null>(null);
  const [mobileTab, setMobileTab] = useState<MobileTab>("statement");
  const focusMode = useFocusMode();
  const [dockCollapsed, setDockCollapsed] = useState<boolean>(readDockCollapsed);
  const toggleDock = () => {
    const next = !dockCollapsed;
    setDockCollapsed(next);
    try {
      window.localStorage.setItem(DOCK_KEY, next ? "1" : "0");
    } catch {
      /* storage unavailable — the choice just isn't remembered */
    }
  };

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
  // P0 internal-payment gates — the approval re-derives the same from server-read data (analyze.ts).
  const ownedAccounts = useMemo(() => ownedAccountIdentities(data.accounts, data.creditCards, accountId), [data.accounts, data.creditCards, accountId]);
  const isTransferLeg = useCallback((recordId: string) => recordsById.get(recordId)?.isTransferLeg === true && !recordsById.get(recordId)?.deleted, [recordsById]);
  const gate = useCallback((row: ReconRow): RowGateContext => ({ isCardAccount, cycle: row.date ? cycleOf(row.date) : null, ownedAccounts, isTransferLeg }), [isCardAccount, cycleOf, ownedAccounts, isTransferLeg]);

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
  const activeDecision = activeId ? decisionFor(decisions, activeId) : null;
  const bulkPairs = useMemo(() => bulkLinkEligible(rows, matches, decisions), [rows, matches, decisions]);

  // ---- the Existing FlowFi sheet and the comparison dock (read-only views over the matcher's evidence) ----
  const linkedRows = useMemo(() => linkedRowsByRecord(rows, decisions), [rows, decisions]);
  const periodDays = useMemo(() => (period ? { fromDay: calendarDayIndex(period.from), toDay: calendarDayIndex(period.to) } : null), [period]);
  const sheetReady = matchStatus === "ready" && !!accountId;
  const rejectedIds = useMemo(() => (activeId ? decisions[activeId]?.rejectedRecordIds : undefined), [decisions, activeId]);
  const entries = useMemo(
    () =>
      activeRow && accountId && sheetReady
        ? existingEntries({ row: activeRow, match: activeMatch, records, accountId, period: periodDays, linkedRows, rejectedRecordIds: rejectedIds, rowNumberOf: numberOf, mode: sheetMode, query: existingQuery })
        : [],
    [activeRow, activeMatch, records, accountId, sheetReady, periodDays, linkedRows, rejectedIds, numberOf, sheetMode, existingQuery],
  );
  // Every record the row could be compared with (unfiltered), so a search never loses the picked transaction.
  const allEntries = useMemo(
    () => (activeRow && accountId && sheetReady ? existingEntries({ row: activeRow, match: activeMatch, records, accountId, period: periodDays, linkedRows, rejectedRecordIds: rejectedIds, rowNumberOf: numberOf, mode: "ledger" }) : []),
    [activeRow, activeMatch, records, accountId, sheetReady, periodDays, linkedRows, rejectedIds, numberOf],
  );
  const matchEntriesCount = activeMatch ? new Set([activeMatch.alreadyImportedId, ...activeMatch.candidates.map((c) => c.recordId), ...activeMatch.pendingSms.map((c) => c.recordId)].filter(Boolean)).size : 0;
  const targetId = recordPick && recordPick.rowId === activeId ? recordPick.recordId : defaultTargetId(activeMatch, activeDecision ?? undefined);
  const target = (targetId && allEntries.find((e) => e.record.id === targetId)) || null;
  const highlightIds = useMemo(() => {
    const ids = rowsCandidateFor(target?.record.id ?? null, matches);
    if (activeId) ids.delete(activeId);
    return ids;
  }, [target, matches, activeId]);

  // Keep the keyboard-selected row in view (the app scrolls <main>, so the browser finds the right scroller).
  useEffect(() => {
    if (activeId) document.getElementById(`recon-row-${activeId}`)?.scrollIntoView?.({ block: "nearest" });
  }, [activeId]);
  // While the row's sheet is open, keep the selected row in the part of the statement table still showing below it —
  // scrolling only the table's own body, once the sheet has slid in. View only.
  useEffect(() => {
    if (!inspectorOpen || !activeId) return;
    const settle = () => {
      const rowEl = document.getElementById(`recon-row-${activeId}`);
      const body = rowEl?.closest<HTMLElement>('[data-testid="recon-grid-body"]');
      const sheetEl = document.querySelector<HTMLElement>('[data-testid="row-editor-panel"]');
      if (!rowEl || !body || !sheetEl) return;
      const row = rowEl.getBoundingClientRect();
      const bodyBox = body.getBoundingClientRect();
      // The usable band of the table: below the sheet, above the table's own bottom edge (and the viewport's).
      const top = Math.max(bodyBox.top, sheetEl.getBoundingClientRect().bottom) + 8;
      const bottom = Math.min(bodyBox.bottom, window.innerHeight) - 4;
      if (row.top < top) body.scrollTop -= top - row.top;
      else if (row.bottom > bottom) body.scrollTop += row.bottom - bottom;
    };
    // Twice: the sheet slides in (≈200ms) and the dock folds away in the same moment, which changes the table's height.
    const timers = [window.setTimeout(settle, 240), window.setTimeout(settle, 520)];
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [inspectorOpen, activeId]);
  const targetRecordId = target?.record.id ?? null;
  // A confirmation belongs to the row it was opened for — selecting another row closes it.
  const [confirmRowId, setConfirmRowId] = useState<string | null>(null);
  if (confirmRowId !== activeId) {
    setConfirmRowId(activeId);
    if (confirmFor) setConfirmFor(null);
  }
  useEffect(() => {
    if (targetRecordId) document.getElementById(`existing-row-${targetRecordId}`)?.scrollIntoView?.({ block: "nearest" });
  }, [targetRecordId]);

  // ---- draft decisions, with Undo ----
  const remember = (label: string, next: Record<string, RowDecision>, rowIds: string[]) => {
    setHistory((h) => pushHistory(h, { id: `h_${Date.now()}_${h.length}`, label, changes: diffDecisions(decisions, next, rowIds) }));
    setUndoNotice(null);
  };
  /** Every decision made on this screen goes through here: one draft change, remembered for Undo. Never a write. */
  const decide = (rowId: string, patch: Partial<RowDecision>, label?: string) => {
    remember(label ?? `${patch.kind ? DECISION_META[patch.kind].short : "Change"} · row ${numberOf(rowId)}`, setDecision(decisions, rowId, patch), [rowId]);
    s.decide(rowId, patch);
  };
  const reject = (rowId: string, recordId: string) => {
    remember(`Not this one · row ${numberOf(rowId)}`, rejectCandidate(decisions, rowId, recordId), [rowId]);
    s.reject(rowId, recordId);
  };
  const undo = () => {
    const result = undoLast(history, decisions);
    if (!result.entry) return;
    setHistory(result.stack);
    if (result.restored > 0) s.replaceDecisions(result.decisions);
    const n = result.skipped;
    setUndoNotice(n > 0 ? `Undid “${result.entry.label}” — ${n} row${n === 1 ? "" : "s"} changed since, left as ${n === 1 ? "it is" : "they are"}.` : `Undid “${result.entry.label}”.`);
  };
  const resetView = () => {
    setSelectedId(null);
    setInspectorOpen(false);
    setLastBulk(null);
    setFilter("all");
    setHistory([]);
    setRecordPick(null);
    setUndoNotice(null);
  };

  // ---- actions ----
  const select = (rowId: string) => setSelectedId(rowId);
  /** Close the row's sheet (Done, X, Escape, a click outside it). Edits are already in the draft — nothing to discard. */
  const closeRowSheet = () => setInspectorOpen(false);
  /** Compare a row with FlowFi: desktop focuses the Existing FlowFi sheet; phones open the row's sheet. */
  const compare = (rowId: string) => {
    setSelectedId(rowId);
    if (isDesktop) requestAnimationFrame(() => existingGridRef.current?.focus());
    else setCompareOpen(true);
  };
  /** "Compare with FlowFi" from the row's sheet: one bottom workspace at a time — the sheet closes, the dock takes over. */
  const compareFromSheet = (rowId: string) => {
    setInspectorOpen(false);
    compare(rowId);
  };

  function chooseAccount(id: string) {
    const hasDecisions = Object.values(decisions).some((d) => d.kind === "link" || d.kind === "import_new" || d.kind === "inbox");
    if (accountId && id !== accountId && hasDecisions) setPendingAccount(id);
    else {
      s.setAccount(id);
      setHistory([]);
    }
    setLastBulk(null);
  }

  /** Keep existing: the row is already in FlowFi as `recordId` — a draft Link, nothing written, ever. */
  const keepExisting = (row: ReconRow, recordId: string) => decide(row.id, { kind: "link", linkedRecordId: recordId }, `Keep existing · row ${numberOf(row.id)}`);
  const importRow = (row: ReconRow, match: RowMatch, patch: ImportPatch) =>
    decide(row.id, { kind: "import_new", notSameAck: patch.notSameAck, category: patch.category, creditAs: patch.creditAs, notOwnTransferAck: patch.notOwnTransferAck }, `${hasPossibleMatch(match) ? KEEP_BOTH_LABEL : "Import new"} · row ${numberOf(row.id)}`);

  /** The FlowFi record "Keep existing" would use for `row`: the picked one for the row in focus, else the matcher's own target. */
  const keepTargetFor = (row: ReconRow, match: RowMatch): string | null => {
    if (row.id === activeId && target) return !target.viewOnly && target.record.kind === "transaction" ? target.record.id : null;
    const id = match.alreadyImportedId ?? match.suggestedRecordId;
    return id && !match.claimedBy[id] ? id : null;
  };

  /**
   * The one place a quick decision (keyboard shortcut or the row's menu) is applied — only ever this tab's draft.
   * Import on a row with possible matches is "Keep both": it opens the explicit acknowledgement, never decides
   * straight from a shortcut.
   */
  const quickDecide = (row: ReconRow, match: RowMatch, kind: "link" | "import_new" | "ignore" | "investigate" | "clear") => {
    if (match.state === "excluded") return;
    switch (kind) {
      case "link": {
        const keepId = keepTargetFor(row, match);
        if (keepId) keepExisting(row, keepId);
        return;
      }
      case "import_new": {
        if (importBlockReasons(row, match, gate(row)).length > 0) return;
        if (isDesktop) {
          setSelectedId(row.id);
          setConfirmRowId(row.id);
          setConfirmFor(hasPossibleMatch(match) ? "keep_both" : "import_new");
        } else if (hasPossibleMatch(match)) compare(row.id);
        else decide(row.id, { kind: "import_new" });
        return;
      }
      case "ignore":
        decide(row.id, { kind: "ignore" });
        return;
      case "investigate":
        decide(row.id, { kind: "investigate" });
        return;
      case "clear":
        decide(row.id, { kind: null }, `Clear · row ${numberOf(row.id)}`);
        return;
    }
  };

  const quickActionsFor = (row: ReconRow): QuickAction[] | null => {
    const match = matches.get(row.id);
    if (!match || match.state === "excluded" || !row.include) return null;
    const decision = decisionFor(decisions, row.id);
    const hasPossible = hasPossibleMatch(match);
    const blocked = importBlockReasons(row, match, gate(row));
    const out: QuickAction[] = [];
    if (keepTargetFor(row, match)) {
      out.push({ id: "link", kind: "link", label: "Keep existing", hint: "It's already in FlowFi, so this row won't be imported.", onSelect: () => quickDecide(row, match, "link") });
    }
    out.push({
      id: "import_new",
      kind: "import_new",
      label: hasPossible ? KEEP_BOTH_LABEL : "Import new",
      hint: hasPossible ? "Separate transactions — you confirm that first." : "Becomes a new transaction when you give final approval.",
      disabledReason: blocked[0],
      onSelect: () => quickDecide(row, match, "import_new"),
    });
    out.push({ id: "ignore", kind: "ignore", label: DECISION_META.ignore.label, hint: "Leaves it out. Nothing is written for this row.", onSelect: () => quickDecide(row, match, "ignore") });
    out.push({ id: "investigate", kind: "investigate", label: DECISION_META.investigate.label, hint: "Keeps the row open — final approval waits for it.", onSelect: () => quickDecide(row, match, "investigate") });
    if (hasPossible) out.push({ id: "compare", kind: null, label: "Compare with FlowFi…", hint: "See the possible matches side by side.", onSelect: () => compare(row.id) });
    if (decision.kind) out.push({ id: "clear", kind: null, label: "Clear my decision", hint: "Puts the row back to undecided.", onSelect: () => quickDecide(row, match, "clear") });
    return out;
  };

  // The next row that still needs a decision, after the one in focus (wrapping round), within the rows now showing.
  function goToNextOpen() {
    const isOpen = (r: ReconRow) => filterOf(r).includes("open");
    let pool = visible.filter(isOpen);
    if (pool.length === 0) {
      pool = rows.filter(isOpen);
      if (pool.length > 0) setFilter("all");
    }
    if (pool.length === 0) return;
    const at = visible.findIndex((r) => r.id === activeId);
    const after = pool.find((r) => visible.findIndex((v) => v.id === r.id) > at);
    const next = after ?? pool[0];
    if (isDesktop) setSelectedId(next.id);
    else compare(next.id);
  }

  /** Resolution keys shared by both sheets. */
  function resolutionKey(e: React.KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      undo();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "z" || e.key === "Z") {
      undo();
      return;
    }
    // View-only keys: fold the dock's field comparison, toggle Focus Mode.
    if (e.key === "d" || e.key === "D") {
      if (isDesktop) toggleDock();
      return;
    }
    if (e.key === "f" || e.key === "F") {
      focusMode.toggleFocus();
      return;
    }
    const row = activeRow;
    const match = activeMatch;
    if (!row || !match || match.state === "excluded") return;
    switch (e.key.toLowerCase()) {
      case "l":
      case "e":
        quickDecide(row, match, "link");
        return;
      case "b":
        if (isDesktop && hasPossibleMatch(match) && importBlockReasons(row, match, gate(row)).length === 0) setConfirmFor("keep_both");
        return;
      case "n":
        quickDecide(row, match, "import_new");
        return;
      case "i":
        quickDecide(row, match, "ignore");
        return;
      case "?":
        quickDecide(row, match, "investigate");
        return;
      case "u":
        goToNextOpen();
        return;
    }
  }

  function onGridKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (isTypingTarget(e.target)) return;
    const idx = visible.findIndex((r) => r.id === activeId);
    const move = (delta: number) => {
      const next = visible[Math.min(Math.max(idx + delta, 0), visible.length - 1)];
      if (next) setSelectedId(next.id);
    };
    if (!e.metaKey && !e.ctrlKey && !e.altKey) {
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
        case "ArrowRight":
          // Across the spine into the Existing FlowFi sheet.
          if (isDesktop) {
            e.preventDefault();
            existingGridRef.current?.focus();
          }
          return;
        case "Enter":
          if (activeRow) {
            e.preventDefault();
            setInspectorOpen((open) => !open);
          }
          return;
        case "Escape":
          setInspectorOpen(false);
          return;
        case "o":
          if (activeRow && activeMatch) {
            if (isDesktop) setCompareOpen(true);
            else compare(activeRow.id);
          }
          return;
      }
    }
    resolutionKey(e);
  }

  function onExistingKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (isTypingTarget(e.target)) return;
    const idx = entries.findIndex((en) => en.record.id === targetRecordId);
    const move = (delta: number) => {
      const next = entries[Math.min(Math.max(idx + delta, 0), entries.length - 1)];
      if (next && activeId) setRecordPick({ rowId: activeId, recordId: next.record.id });
    };
    if (!e.metaKey && !e.ctrlKey && !e.altKey) {
      switch (e.key) {
        case "ArrowDown":
        case "j":
          e.preventDefault();
          move(idx < 0 ? 0 : 1);
          return;
        case "ArrowUp":
        case "k":
          e.preventDefault();
          move(-1);
          return;
        case "ArrowLeft":
        case "Escape":
          e.preventDefault();
          gridRef.current?.focus();
          return;
        case "Enter":
          e.preventDefault();
          if (activeRow && activeMatch) quickDecide(activeRow, activeMatch, "link");
          return;
      }
    }
    resolutionKey(e);
  }

  // ---- render ----
  if (!s.ready) {
    return <div className="h-40 animate-pulse rounded-3xl bg-muted/60" aria-label="Loading" />;
  }

  const panelFor = (row: ReconRow, match: RowMatch) => {
    const at = visible.findIndex((r) => r.id === row.id);
    const go = (delta: number) => {
      const next = visible[at + delta];
      if (next) setSelectedId(next.id);
    };
    return (
    <MatchPanel
      nav={at >= 0 ? { position: at + 1, total: visible.length, onPrev: at > 0 ? () => go(-1) : undefined, onNext: at < visible.length - 1 ? () => go(1) : undefined } : undefined}
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
      onDecide={(patch) => decide(row.id, patch)}
      onReject={(recordId) => reject(row.id, recordId)}
      screenshot={screenshot}
      captureSource={session?.source ?? "text"}
    />
    );
  };
  const pendingLabel = matchStatus === "loading" ? "Loading FlowFi records…" : matchStatus === "error" ? "Can't compare — data didn't load" : "Choose the statement account";
  const editorFor = (row: ReconRow) => (
    <ReconRowEditor
      row={row}
      decision={decisionFor(decisions, row.id)}
      categories={data.categories}
      onPatch={(patch) => s.patchRow(row.id, patch)}
      onConfirmRow={() => s.confirmRow(row.id)}
      onConfirmField={(field) => s.confirmField(row.id, field)}
      onDecide={(patch) => decide(row.id, patch, `Details · row ${numberOf(row.id)}`)}
      accountLabel={accountId ? accountName(accountId) : null}
    />
  );
  /** The desktop editor sheet for the selected row. Its arrows move the selection, like J/K — they never decide or save. */
  const rowSheetFor = (row: ReconRow) => {
    const at = visible.findIndex((r) => r.id === row.id);
    const go = (delta: number) => {
      const next = visible[at + delta];
      if (next) setSelectedId(next.id);
    };
    const match = matches.get(row.id);
    const kind = decisionFor(decisions, row.id).kind;
    return (
      <ReconRowSheet
        open={inspectorOpen}
        row={row}
        rowNumber={numberOf(row.id)}
        stateLabel={!match ? null : kind ? decisionShort(kind, hasPossibleMatch(match)) : "Undecided"}
        nav={at >= 0 ? { position: at + 1, total: visible.length, onPrev: at > 0 ? () => go(-1) : undefined, onNext: at < visible.length - 1 ? () => go(1) : undefined } : undefined}
        onClose={closeRowSheet}
        onCompare={match ? compareFromSheet : undefined}
      >
        {editorFor(row)}
      </ReconRowSheet>
    );
  };

  const noticeText =
    s.notice === "restored"
      ? "Restored your review from earlier in this tab."
      : s.notice === "expired"
        ? "Your earlier review was more than 12 hours old, so it was removed."
        : s.notice === "corrupt"
          ? "A saved review couldn't be read, so it was removed."
          : null;

  // Desktop with a review open: fit the viewport so only the two sheets scroll. Very short windows fall back to the
  // page scrolling (min height), never to clipped controls.
  const fit = isDesktop && session != null;
  const statementAccount = accountId ? accountName(accountId) : "";
  const sheetPending = !accountId ? "Choose the statement account to see FlowFi's transactions." : matchStatus !== "ready" ? pendingLabel : null;

  const dockFor = (row: ReconRow, match: RowMatch) => {
    const decision = decisionFor(decisions, row.id);
    const errors = decisionErrors(row, match, decision, gate(row));
    const linked = decision.kind === "link" && decision.linkedRecordId ? (recordsById.get(decision.linkedRecordId) ?? null) : null;
    const record = target?.record ?? null;
    const notes = [
      ...match.conflicts,
      ...match.notes.map((n) => n.message),
      ...(gate(row).cycle && gate(row).cycle!.status !== "open" ? [`The card bill for this date is ${gate(row).cycle!.status === "paid" ? "already paid" : "closed"} — Import is blocked; Keep existing or Skip still work.`] : []),
    ];
    return (
      <ResolutionDock
        row={row}
        rowNumber={numberOf(row.id)}
        decision={decision}
        target={target}
        diffs={record ? fieldDiffs({ row, record, candidate: target?.candidate ?? null, statementAccount, existingAccount: record.accountId ? accountName(record.accountId) : "No account", captureSource: session?.source ?? "text" }) : null}
        options={resolutionOptions({ row, match, decision, gate: gate(row), target })}
        effect={financialEffect({ row, match, decision, errors, linked, accountLabel: statementAccount })}
        categories={data.categories}
        candidateCount={match.candidates.length}
        pendingSmsCount={match.pendingSms.length}
        history={record ? merchantHistory(record, records) : []}
        notes={notes}
        importBlocked={match.state === "excluded" ? null : (importBlockReasons(row, match, gate(row))[0] ?? null)}
        ownTransferConfirm={ownTransferConfirmFor(row, gate(row))}
        confirmFor={confirmFor}
        onConfirmFor={setConfirmFor}
        onKeepExisting={() => record && keepExisting(row, record.id)}
        onImport={(patch) => importRow(row, match, patch)}
        onReviewLater={() => decide(row.id, { kind: "investigate" })}
        onSkip={() => decide(row.id, { kind: "ignore" })}
        onInbox={() => decide(row.id, { kind: "inbox" })}
        onPreview={setPreview}
        onDetails={() => setCompareOpen(true)}
        undoLabel={history.at(-1)?.label ?? null}
        onUndo={undo}
        excluded={!row.include || match.state === "excluded"}
        collapsed={dockCollapsed}
        onToggleCollapsed={toggleDock}
      />
    );
  };

  return (
    <div
      className={cn("flex flex-col gap-3 px-1 pb-2", fit && "min-h-[36rem] gap-2 pb-0", fit && (focusMode.focus ? "h-[calc(100dvh-1.5rem)]" : "h-[calc(100dvh-6.5rem)]"))}
      data-testid="recon-workspace"
      data-focus={focusMode.focus ? "true" : "false"}
    >
      <WorkspaceHeader icon={GitCompareArrows} title="Reconciliation" current="reconcile" steps={{ capture: { href: "/smart-capture" }, review: { href: "/smart-capture" } }}>
        <Link
          href="/smart-capture"
          data-testid="back-to-capture"
          title="Back to Smart Capture"
          className="inline-flex h-7 items-center gap-1.5 rounded-full border border-white/10 px-2.5 text-xs font-medium text-hero-foreground/80 transition-colors hover:bg-white/10 hover:text-hero-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <ArrowLeft className="size-3.5" /> <span className="max-2xl:sr-only">Back to Smart Capture</span>
        </Link>
        <HeaderAction
          icon={focusMode.focus ? Minimize2 : Maximize2}
          tone={focusMode.focus ? "accent" : "default"}
          onClick={focusMode.toggleFocus}
          pressed={focusMode.focus}
          ariaLabel={focusMode.focus ? "Exit Focus Mode" : "Enter Focus Mode"}
          title={focusMode.focus ? "Exit Focus Mode (Esc or F)" : "Focus Mode — hide the sidebar and top bar (F)"}
          testId={FOCUS_TOGGLE_TESTID}
        >
          <span className="max-sm:sr-only">{focusMode.focus ? "Exit focus" : "Focus mode"}</span>
        </HeaderAction>
        {focusMode.canFullscreen && (
          <HeaderAction
            icon={focusMode.fullscreen ? Shrink : Expand}
            onClick={() => void focusMode.toggleFullscreen()}
            pressed={focusMode.fullscreen}
            ariaLabel={focusMode.fullscreen ? "Exit full screen" : "Full screen"}
            title={focusMode.fullscreen ? "Exit full screen (Esc)" : "Full screen — uses the whole display"}
            testId="fullscreen-toggle"
          >
            <span className="max-2xl:sr-only">{focusMode.fullscreen ? "Exit full screen" : "Full screen"}</span>
          </HeaderAction>
        )}
        {session && (
          <HeaderAction icon={Trash2} tone="danger" onClick={() => setDiscardOpen(true)} title="Discard this review">
            {/* Below 2xl: icon only (the name stays for screen readers and the tooltip) so the header stays one line. */}
            <span className="max-2xl:sr-only">Discard this review</span>
          </HeaderAction>
        )}
      </WorkspaceHeader>

      {noticeText && <Notice onDismiss={s.dismissNotice}>{noticeText}</Notice>}
      {handoffNotice && (
        <Notice onDismiss={() => setHandoffNotice(null)} testId="handoff-notice">
          {handoffNotice}
        </Notice>
      )}
      {focusMode.notice && (
        <Notice onDismiss={focusMode.dismissNotice} testId="fullscreen-notice" icon={Info}>
          {focusMode.notice}
        </Notice>
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
              showShortcuts={isDesktop}
              bulkCount={bulkPairs.length}
              onBulkLink={() => setBulkConfirmOpen(true)}
              undoCount={lastBulk?.count ?? 0}
              onUndo={() => {
                if (lastBulk) s.undoBulk(lastBulk.id);
                setLastBulk(null);
              }}
            />
          )}

          {undoNotice && (
            <p role="status" className="flex items-center gap-2 rounded-xl bg-muted/70 px-3 py-1.5 text-xs text-foreground" data-testid="undo-notice">
              <Undo2 className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">{undoNotice}</span>
              <button type="button" aria-label="Dismiss" onClick={() => setUndoNotice(null)} className="rounded-full p-0.5 text-muted-foreground hover:text-foreground">
                <X className="size-3.5" />
              </button>
            </p>
          )}

          {isDesktop ? (
            <>
              <div ref={dualRef} className="flex min-h-[12rem] min-w-0 flex-1" data-testid="dual-sheet">
                <div className="min-h-0 min-w-0 shrink-0" style={{ flexBasis: `${split}%` }}>
                  <ReconTable
                    ref={gridRef}
                    rows={visible}
                    numberOf={numberOf}
                    matches={matches}
                    decisions={decisions}
                    selectedId={activeId}
                    expandedId={inspectorOpen ? activeId : null}
                    onSelect={select}
                    onToggleExpand={(id) => {
                      const closing = inspectorOpen && id === activeId;
                      setSelectedId(id);
                      setInspectorOpen(!closing);
                    }}
                    onCompare={compare}
                    pendingLabel={pendingLabel}
                    onKeyDown={onGridKeyDown}
                    quickActions={quickActionsFor}
                    highlightIds={highlightIds}
                    header={<SheetTitleBar title="New statement" subtitle={`${session.source === "ocr" ? "Smart Capture screenshot" : "Pasted statement"} · ${rows.length} row${rows.length === 1 ? "" : "s"}`} />}
                  />
                </div>
                <SheetDivider split={split} onSplit={setSplit} bounds={splitRange} containerRef={dualRef} linkCount={activeMatch && sheetReady ? matchEntriesCount : null} />
                <div className="min-h-0 min-w-0 flex-1">
                  <ExistingSheet
                    ref={existingGridRef}
                    entries={entries}
                    mode={sheetMode}
                    onMode={setSheetMode}
                    query={existingQuery}
                    onQuery={setExistingQuery}
                    row={activeRow}
                    rowNumber={activeRow ? numberOf(activeRow.id) : null}
                    selectedRecordId={targetRecordId}
                    onSelect={(recordId) => activeId && setRecordPick({ rowId: activeId, recordId })}
                    accountLabel={statementAccount || "No account chosen"}
                    numberOf={numberOf}
                    onKeyDown={onExistingKeyDown}
                    pendingLabel={sheetPending}
                    matchCount={matchEntriesCount}
                  />
                </div>
              </div>
              {/* One workspace at a time: while the row's sheet is open the dock steps aside (hidden, not unmounted), so the two
                  tables get its height. It is back, exactly as it was, when the sheet closes. */}
              {sheetReady && activeRow && activeMatch && <div className={inspectorOpen ? "hidden" : "contents"}>{dockFor(activeRow, activeMatch)}</div>}
            </>
          ) : (
            <>
              {accountId && (
                <div className="flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <MobileSheetSwitch tab={mobileTab} onTab={setMobileTab} statementCount={visible.length} existingCount={activeMatch ? matchEntriesCount : null} />
                  </div>
                  {history.length > 0 && (
                    <ClayButton size="sm" variant="secondary" onClick={undo} aria-label={`Undo ${history.at(-1)!.label}`} data-testid="undo-decision">
                      <Undo2 className="size-3.5" /> Undo
                    </ClayButton>
                  )}
                </div>
              )}
              {mobileTab === "existing" && accountId ? (
                <MobileExistingList
                  row={activeRow}
                  rowNumber={activeRow ? numberOf(activeRow.id) : null}
                  decision={activeDecision}
                  keepBoth={!!activeMatch && hasPossibleMatch(activeMatch)}
                  entries={entries}
                  numberOf={numberOf}
                  pendingLabel={sheetPending}
                  onKeepExisting={(recordId) => activeRow && keepExisting(activeRow, recordId)}
                  onDecide={() => setCompareOpen(true)}
                  onPickRow={() => setMobileTab("statement")}
                />
              ) : (
                <ReconMobileList rows={visible} numberOf={numberOf} matches={matches} decisions={decisions} onOpen={compare} pendingLabel={pendingLabel} />
              )}
            </>
          )}

          <ReadinessBar
            rowsCount={rows.length}
            summary={summary}
            readiness={readiness}
            canApprove={approval.canOpen}
            hasAccount={!!accountId}
            onApprove={approval.open}
            onNextOpen={goToNextOpen}
            desktop={isDesktop}
          />
        </>
      )}

      {/* The row's draft editor and the full comparison (screenshot, notes, Inbox, every candidate) are top sheets over
          the viewport on desktop — never inside either sheet's scroll container. Phones use the row's own sheet below. */}
      {isDesktop && activeRow && rowSheetFor(activeRow)}
      {isDesktop && activeRow && activeMatch && (
        <TransactionSheet
          open={compareOpen}
          onRequestClose={() => setCompareOpen(false)}
          testId="compare-sheet"
          header={
            <div className="flex min-w-0 items-center gap-3.5">
              <span aria-hidden className="grid size-11 shrink-0 place-items-center rounded-[14px] bg-white/[0.08] text-hero-foreground ring-1 ring-white/12">
                <GitCompareArrows className="size-5" />
              </span>
              <div className="min-w-0">
                <p className="text-[11px] font-semibold tracking-[0.09em] text-hero-foreground/55 uppercase">Full comparison</p>
                <DialogTitle className="truncate font-heading text-[19px] leading-tight font-semibold tracking-tight text-hero-foreground">{`Compare row ${numberOf(activeRow.id)}`}</DialogTitle>
                <DialogDescription className="mt-0.5 text-[12.5px] text-hero-foreground/65">Statement row vs. FlowFi — nothing changes until you give the final approval.</DialogDescription>
              </div>
            </div>
          }
        >
          <div className="mx-auto max-w-3xl px-4 py-4 sm:px-6 lg:px-8 sm:py-5">{panelFor(activeRow, activeMatch)}</div>
        </TransactionSheet>
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

      {activeRow && (
        <ResolutionPreviewDialog
          key={`${activeRow.id}:${targetRecordId}`}
          kind={preview}
          onOpenChange={(open) => !open && setPreview(null)}
          row={activeRow}
          rowNumber={numberOf(activeRow.id)}
          record={target?.record.kind === "transaction" ? target.record : null}
        />
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
          resetView();
        }}
      />
      <ConfirmDialog
        open={bulkConfirmOpen}
        onOpenChange={setBulkConfirmOpen}
        title={`Keep existing for ${bulkPairs.length} exact match${bulkPairs.length === 1 ? "" : "es"}?`}
        description="Each of these rows has exactly one FlowFi transaction on this account with the same amount and day, and no other close match. They'll be skipped at import. This only changes your draft — nothing in FlowFi changes, and you can undo it."
        confirmLabel="Keep existing"
        onConfirm={() => {
          const id = `bulk_${Date.now()}`;
          remember(`Keep existing · ${bulkPairs.length} exact`, applyBulkLink(decisions, bulkPairs, id), bulkPairs.map((pair) => pair.rowId));
          s.bulkLink(bulkPairs, id);
          setLastBulk({ id, count: bulkPairs.length });
          setBulkConfirmOpen(false);
        }}
      />
      <ConfirmDialog
        open={pendingAccount != null}
        onOpenChange={(open) => !open && setPendingAccount(null)}
        title="Change the statement account?"
        description={`Possible matches are recalculated for ${pendingAccount ? accountName(pendingAccount) : "the new account"}. Keep existing, Keep both / Import new and Inbox decisions were made against ${accountId ? accountName(accountId) : "the current account"}'s transactions, so they'll be cleared — along with any "Not this one" choices. Skip and Review later stay.`}
        confirmLabel="Change account"
        onConfirm={() => {
          if (pendingAccount) s.setAccount(pendingAccount);
          setHistory([]);
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
          resetView();
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
          resetView();
        }}
      />
    </div>
  );
}

type ReadinessTone = "default" | "success" | "primary" | "warning" | "danger";
/** Readiness counts read as quiet inline stats (label + coloured number), not a row of pills. */
const STAT_TONE: Record<ReadinessTone, string> = {
  default: "[&_dd]:text-foreground",
  success: "[&_dd]:text-success",
  primary: "[&_dd]:text-primary-accent-text",
  warning: "[&_dd]:text-warning",
  danger: "[&_dd]:text-danger",
};

/**
 * The draft-only readiness summary + the final approval entry point. It never says everything will be imported: it
 * names what final approval would add, and what it would leave alone. "Next undecided" jumps to the row that still
 * needs a decision, so the review is a short walk, not a hunt.
 */
function ReadinessBar({
  rowsCount,
  summary,
  readiness,
  canApprove,
  hasAccount,
  onApprove,
  onNextOpen,
  desktop,
}: {
  rowsCount: number;
  summary: ReturnType<typeof reviewSummary> | null;
  readiness: ReadinessCounts | null;
  canApprove: boolean;
  hasAccount: boolean;
  onApprove: () => void;
  onNextOpen: () => void;
  desktop: boolean;
}) {
  const items: { key: string; label: string; value: number; tone: ReadinessTone; hideZero?: boolean }[] = readiness
    ? [
        { key: "included", label: "Included", value: readiness.included, tone: "default" },
        { key: "already-recorded", label: "Keep existing", value: readiness.alreadyRecorded, tone: "success" },
        { key: "add-new", label: "Import new", value: readiness.proposedNew, tone: "primary" },
        { key: "imported-earlier", label: "Imported earlier", value: readiness.alreadyImported, tone: "success", hideZero: true },
        { key: "skipped", label: "Skipped", value: readiness.skipped, tone: "default" },
        { key: "inbox", label: "Left for Inbox", value: readiness.inbox, tone: "default", hideZero: true },
        { key: "review-later", label: "Review later", value: readiness.reviewLater, tone: readiness.reviewLater > 0 ? "warning" : "default" },
        { key: "undecided", label: "Undecided", value: readiness.unresolved, tone: readiness.unresolved > 0 ? "warning" : "default" },
        { key: "blocked", label: "Blocked by rules", value: readiness.blocked, tone: readiness.blocked > 0 ? "danger" : "default" },
      ]
    : [];
  const open = readiness ? readiness.unresolved + readiness.reviewLater : 0;
  const percent = summary && summary.included > 0 ? Math.round((summary.decided / summary.included) * 100) : 0;
  const hint = !hasAccount
    ? "Choose the statement account to start checking for matches. Nothing is written while you review."
    : !readiness
      ? "Waiting for your FlowFi records before anything can be compared."
      : canApprove
        ? readiness.proposedNew > 0
          ? `Final approval would add ${readiness.proposedNew} new transaction${readiness.proposedNew === 1 ? "" : "s"}; kept-existing, skipped and Inbox rows are never written. Nothing is written until you confirm in the next step.`
          : "Final approval would add nothing new — kept-existing, skipped and Inbox rows are never written."
        : `${open} row${open === 1 ? "" : "s"} still need${open === 1 ? "s" : ""} a decision before final approval. Nothing is written to FlowFi while you review.`;
  const HintIcon = canApprove ? CheckCircle2 : Info;

  return (
    <div
      data-testid="status-bar"
      // Phones: one line (progress + actions) so the sticky bar never hides much of the screen; the per-outcome counts
      // and the explanation appear from the small breakpoint up.
      className={cn("z-[1] flex flex-col gap-1.5 rounded-2xl border border-border bg-card px-3 py-2 sm:px-4", desktop ? "shrink-0 rounded-xl py-1.5" : "sticky bottom-0 shadow-e4")}
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-1 basis-24 items-center gap-3 sm:flex-none sm:basis-auto">
          <p className="shrink-0 text-sm font-medium whitespace-nowrap text-foreground">
            {summary ? (
              <>
                <span className="tabular-nums" data-testid="progress-count">
                  {summary.decided}/{summary.included}
                </span>{" "}
                <span className="max-sm:hidden">rows </span>decided
              </>
            ) : (
              `${rowsCount} rows captured`
            )}
          </p>
          {summary && summary.included > 0 && (
            <div role="progressbar" aria-label="Review progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="hidden h-1.5 w-28 overflow-hidden rounded-full bg-muted sm:block">
              <div className={cn("h-full rounded-full transition-[width] duration-300", percent === 100 ? "bg-success" : "bg-primary")} style={{ width: `${percent}%` }} />
            </div>
          )}
        </div>
        {items.length > 0 && (
          <dl className="hidden min-w-0 flex-1 flex-wrap items-center gap-x-3.5 gap-y-1 text-[11px] sm:flex" data-testid="readiness-counts">
            {items
              .filter((i) => !(i.hideZero && i.value === 0))
              .map((i) => (
                <div key={i.key} className={cn("flex items-baseline gap-1 text-muted-foreground", STAT_TONE[i.value === 0 ? "default" : i.tone], i.value === 0 && "opacity-60", i.value === 0 && "max-2xl:hidden")} data-testid={`readiness-${i.key}`}>
                  <dt>{i.label}</dt>
                  <dd className="text-xs font-semibold tabular-nums">{i.value}</dd>
                </div>
              ))}
          </dl>
        )}
        {hasAccount && (
          <div className="ml-auto flex shrink-0 flex-nowrap items-center gap-2">
            {open > 0 && (
              <ClayButton size="sm" variant="secondary" onClick={onNextOpen} data-testid="next-open" aria-label={`Go to next row that needs a decision (${open} left)`}>
                <ArrowDownToLine className="size-3.5" />
                <span className="sm:hidden">Next</span>
                <span className="hidden sm:inline">Next undecided</span>
              </ClayButton>
            )}
            <ClayButton size="sm" variant={canApprove ? "primary" : "secondary"} onClick={onApprove} disabled={!canApprove} data-testid="open-approval">
              Review &amp; approve
            </ClayButton>
          </div>
        )}
      </div>
      {/* Desktop: the comparison dock's effect line already says this (collapsed or not), so the bar stays one line. */}
      <p className={cn("hidden items-start gap-1.5 text-xs", !desktop && "sm:flex", canApprove ? "text-foreground" : "text-muted-foreground")} data-testid="approval-hint">
        <HintIcon className={cn("mt-px size-3.5 shrink-0", canApprove ? "text-success" : "text-muted-foreground")} aria-hidden />
        <span>{hint}</span>
      </p>
    </div>
  );
}

/** The New Statement sheet's title bar — the left page's heading, matching the Existing FlowFi sheet's. */
function SheetTitleBar({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <header className={SHEET_TITLE_BAR}>
      <div className="flex min-w-0 flex-1 items-baseline gap-2">
        <h2 className="shrink-0 text-[13px] leading-tight font-semibold text-foreground">{title}</h2>
        <p className="truncate text-[11px] text-muted-foreground">{subtitle}</p>
      </div>
      <span className="text-[10px] font-semibold tracking-[0.08em] text-primary-accent-text uppercase">Incoming</span>
    </header>
  );
}

/** A slim one-line status notice (restored review, handoff, fullscreen fallback) — never a banner card. */
function Notice({ children, onDismiss, testId, icon: Icon = History }: { children: React.ReactNode; onDismiss: () => void; testId?: string; icon?: typeof History }) {
  return (
    <div role="status" className="flex min-h-8 items-center gap-2 rounded-xl bg-primary/10 px-3 py-1 text-xs text-foreground" data-testid={testId}>
      <Icon className="size-3.5 shrink-0 text-primary-accent-text" />
      <span className="min-w-0 flex-1">{children}</span>
      <button type="button" aria-label="Dismiss" onClick={onDismiss} className="grid size-6 place-items-center rounded-full text-muted-foreground hover:bg-foreground/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
        <X className="size-3.5" />
      </button>
    </div>
  );
}
