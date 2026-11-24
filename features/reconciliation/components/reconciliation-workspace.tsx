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
import { ArrowDownToLine, ArrowLeft, ChevronsDown, CheckCircle2, Expand, GitCompareArrows, History, Info, Loader2, Maximize2, Minimize2, RefreshCw, Shrink, Trash2, TriangleAlert, Undo2, X } from "lucide-react";
import { HeaderAction, WorkspaceHeader } from "@/features/smart-capture/components/workspace-header";
import { ClayButton } from "@/components/clay/clay-button";
import { cn } from "@/lib/utils";
import { ConfirmDialog } from "@/components/finance/confirm-dialog";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SHEET_BUTTON, TransactionSheet } from "@/components/finance/transaction-sheet";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useMediaQuery } from "@/hooks/use-media-query";
import { isComplete, openIssues, reviewTotals, type ReviewTotals } from "@/features/smart-capture/lib/capture-review";
import { formatCurrencyPrecise } from "@/lib/format";
import { FOCUS_TOGGLE_TESTID, useFocusMode } from "../hooks/use-focus-mode";
import { useReconciliationApproval } from "../hooks/use-reconciliation-approval";
import { useReconciliationSession } from "../hooks/use-reconciliation-session";
import { sourceLabel, type RecordsSync } from "../hooks/use-reconciliation-data";
import { consumePendingHandoff, declinePendingHandoff, getHandoffState, releaseReconciliationScreenshot, screenshotFor, subscribeHandoff } from "../lib/capture-handoff";
import { buildCycleResolver } from "../lib/card-cycle-status";
import { applyBulkLink, attentionFieldOf, bulkLinkEligible, decisionErrors, decisionFor, importBlockReasons, ownTransferConfirmFor, rejectCandidate, reviewSummary, rowCheckLabel, setDecision, valueIssues, type RowGateContext } from "../lib/decisions";
import { bulkImportPlan, merchantCategoryIndex } from "../lib/bulk-import";
import { diffDecisions, pushHistory, undoLast, type HistoryEntry } from "../lib/decision-history";
import { calendarDayIndex } from "../lib/amounts-and-days";
import {
  defaultTargetId,
  existingEntries,
  hasPossibleMatch,
  linkedRowsByRecord,
} from "../lib/merge-studio";
import { buildExistingRecords } from "../lib/existing-records";
import { accountHintsByRow, suggestStatementAccounts, type AccountHint } from "../lib/account-hints";
import { ownedAccountIdentities } from "../lib/internal-payment-guard";
import { computeMatches, siblingAccountIdsFor, type ReconciliationData } from "../lib/analyze";
import type { ApprovalDeps } from "../lib/approval-commit";
import { buildApprovalPlan } from "../lib/approval-plan";
import { readinessCounts, type ReadinessCounts } from "../lib/readiness";
import type { MatchState, ReconRow, RowDecision, RowMatch } from "../lib/types";
import { ApprovalDialog } from "./approval-dialog";
import { InlineMatchReview } from "./inline-match-review";
import { MobileExistingList, MobileSheetSwitch, type MobileTab } from "./recon-mobile-compare";
import { ImportConfirm, type ImportPatch } from "./import-confirm";
import { MatchPanel } from "./match-panel";
import type { QuickAction } from "./recon-decision-menu";
import { ReconAccountBar, type AccountOption, type AccountSuggestionView } from "./recon-header";
import type { RowAccountHint } from "./recon-table";
import { ReconIntake } from "./recon-intake";
import { ReconMobileList } from "./recon-mobile-list";
import { categoriesForDirection, ReconRowEditor, ReconRowSheet } from "./recon-row-editor";
import { BulkImportDialog, Count, Figure, ReviewImportSummary, type SummaryCounts } from "./review-import-summary";
import { autoReadyDecisions, withAutoReady } from "../lib/auto-ready";
import { rowStatus, type RowStatus } from "../lib/row-status";
import { ReviewToolbar } from "./review-toolbar";
import { ReconTable } from "./recon-table";
import { ReconToolbar, type ReconFilter, type ReconSort } from "./recon-toolbar";
import { toast } from "@/store/toast-store";
import { readSelectedRow, selectionKey, writeSelectedRow } from "../lib/selected-row";
import { DECISION_META, KEEP_BOTH_LABEL, SHEET_TITLE_BAR, STATE_META, accountIdentity, accountLabel, decisionShort, pendingLabelFor } from "./recon-ui";

export type { ReconciliationData };

const AUTO_NEXT_KEY = "flowfi.recon.autoNext";
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
  const loadingActive = !!accountId && (matchStatus === "loading" || (matchStatus === "ready" && (sync.bills ?? "ready") === "loading"));
  const loadingKey = loadingActive ? `${sync.loading.join(",")}|${sync.bills ?? ""}` : "";
  // "Slow" is a real state, not an animation: after 8s of waiting the loading line says so and offers Retry.
  const [slowKey, setSlowKey] = useState<string | null>(null);
  useEffect(() => {
    if (!loadingActive) return;
    const t = window.setTimeout(() => setSlowKey(loadingKey), 8000);
    return () => {
      window.clearTimeout(t);
      setSlowKey(null);
    };
  }, [loadingActive, loadingKey]);
  const slowLoading = loadingActive && slowKey === loadingKey;
  const errorKey = `${sync.failed.join(",")}|${sync.bills ?? ""}`;
  const [errorDismissedKey, setErrorDismissedKey] = useState<string | null>(null);
  const screenshot = screenshotFor(session?.fingerprint)?.capture ?? null;
  const isDesktop = useMediaQuery("(min-width: 1024px)");

  const [filter, setFilter] = useState<ReconFilter>("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<ReconSort>("statement");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** The row's editor sheet (desktop). It always shows the selected row, so moving the selection moves it too. */
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  /** The row most recently removed from the review (so Z / Undo can put it back); any later decision supersedes it. */
  const [lastRemoved, setLastRemoved] = useState<string | null>(null);
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);
  const [bulkImportOpen, setBulkImportOpen] = useState(false);
  const [lastBulk, setLastBulk] = useState<{ id: string; count: number } | null>(null);
  const [pendingAccount, setPendingAccount] = useState<string | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);
  /** The row whose inline match review is open under it (desktop). Always the selected row — see `inlineOpenId`. */
  const [inlineId, setInlineId] = useState<string | null>(null);
  // ---- inline review state (view-only, never saved) ----
  /** The FlowFi transaction picked in the inline comparison — for one statement row; another row starts on its own default. */
  const [recordPick, setRecordPick] = useState<{ rowId: string; recordId: string } | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [undoNotice, setUndoNotice] = useState<string | null>(null);
  const [mobileTab, setMobileTab] = useState<MobileTab>("statement");
  const focusMode = useFocusMode();
  /** After a decision on the row in focus, move on to the next row still waiting (a view choice; Undo brings the row back). */
  const [autoNext, setAutoNext] = useState<boolean>(() => {
    try {
      return typeof window === "undefined" || window.localStorage.getItem(AUTO_NEXT_KEY) !== "0";
    } catch {
      return true;
    }
  });
  const toggleAutoNext = () => {
    const next = !autoNext;
    setAutoNext(next);
    try {
      window.localStorage.setItem(AUTO_NEXT_KEY, next ? "1" : "0");
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

  // ---- cross-account evidence (account-hints.ts): never a match, never a decision ----
  // Records must have loaded first, or "nothing similar" would be a guess.
  const recordsReady = sync.loading.length === 0 && sync.failed.length === 0;
  const accountMissing = !!session && !accountId;
  const hintsByRow = useMemo(
    () => (session && !accountId && recordsReady ? accountHintsByRow(session.rows, records, null) : new Map<string, AccountHint[]>()),
    [session, accountId, recordsReady, records],
  );
  const accountSuggestion: AccountSuggestionView | null = useMemo(() => {
    if (!session || accountId) return null;
    const top = suggestStatementAccounts(hintsByRow, 1)[0];
    const compared = session.rows.filter((r) => r.include && !r.captureExcluded && isComplete(r)).length;
    // Only worth offering when a real share of the statement points there (and the account still exists).
    if (!top || top.rows < Math.max(2, Math.ceil(compared * 0.3)) || !data.accounts.some((a) => a.id === top.accountId && a.deletedAt == null)) return null;
    return { id: top.accountId, label: accountName(top.accountId), rows: top.rows, total: compared };
  }, [session, accountId, hintsByRow, data.accounts, accountName]);
  const accountHintOf = useCallback(
    (rowId: string): RowAccountHint | null => {
      const hints = hintsByRow.get(rowId) ?? [];
      return { count: hints.length, account: hints[0]?.record.accountId ? accountName(hints[0].record.accountId) : null };
    },
    [hintsByRow, accountName],
  );

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
        setHandoffNotice(handoffNoticeText(taken.rows));
      }
      return;
    }
    if (session.fingerprint === pending.fingerprint) {
      const taken = consumePendingHandoff();
      const outcome = taken ? s.applySameCaptureHandoff(taken) : null;
      if (outcome) {
        const parts = [outcome.changed && `${outcome.changed} changed (their decisions were cleared)`, outcome.added && `${outcome.added} added`, outcome.removed && `${outcome.removed} removed`].filter(Boolean);
        setHandoffNotice(parts.length ? `Updated from Smart Capture: ${parts.join(", ")}. Your other decisions are kept.` : null);
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
  /** The user's own decisions (what is saved in the draft). */
  const userDecisions = useMemo(() => session?.decisions ?? {}, [session]);
  const categoryIndex = useMemo(() => merchantCategoryIndex(data.transactions, data.categories), [data.transactions, data.categories]);
  // Card bills decide the closed-bill rule only; until they have loaded no row is called Ready (or imported).
  const billsState = account?.type === "card" ? (sync.bills ?? "ready") : "ready";
  const statusReady = matchStatus === "ready" && billsState === "ready";
  /** Clean rows with no possible match are Ready by default — derived, never saved; an explicit decision always wins. */
  const autoDecisions = useMemo(
    () => (session && accountId && statusReady ? autoReadyDecisions({ rows, matches, decisions: userDecisions, gate, categoryIndex, categories: data.categories }) : {}),
    [session, accountId, statusReady, rows, matches, userDecisions, gate, categoryIndex, data.categories],
  );
  const decisions = useMemo(() => withAutoReady(userDecisions, autoDecisions), [userDecisions, autoDecisions]);
  /** Removes the derived default rows from a decisions map before it is saved, so only the user's own choices are stored. */
  const userOnly = (d: Record<string, RowDecision>) => {
    const out = { ...d };
    for (const k of Object.keys(autoDecisions)) if (out[k] === autoDecisions[k]) delete out[k];
    return out;
  };
  const approvalSession = useMemo(() => (session ? { ...session, decisions } : null), [session, decisions]);
  const numberOf = useCallback((rowId: string) => rows.findIndex((r) => r.id === rowId) + 1, [rows]);
  const summary = useMemo(() => (session && statusReady ? reviewSummary(rows, matches, decisions, gate) : null), [session, statusReady, rows, matches, decisions, gate]);
  const readiness = useMemo(() => (session && statusReady ? readinessCounts(rows, matches, decisions, gate) : null), [session, statusReady, rows, matches, decisions, gate]);
  const plan = useMemo(() => (session && accountId && statusReady ? buildApprovalPlan({ rows, matches, decisions, gate }) : null), [session, accountId, statusReady, rows, matches, decisions, gate]);
  const approval = useReconciliationApproval({ uid, session: approvalSession, plan, account, liveData: data, dataReady: statusReady, deps: approvalDeps });
  const period = useMemo(() => {
    const dates = rows.filter((r) => r.include && r.date).map((r) => r.date!.getTime());
    return dates.length ? { from: new Date(Math.min(...dates)), to: new Date(Math.max(...dates)) } : null;
  }, [rows]);

  /** The row's one status — null until matching AND card bills have loaded (never claimed early). */
  const statusFor = useCallback(
    (row: ReconRow): RowStatus | null => {
      if (matchStatus !== "ready") return null;
      const st = rowStatus(row, matches.get(row.id), decisions, gate(row));
      // Ready / Possible duplicate / Fix required could still change with the card bills; "skipped" cannot.
      return statusReady || st?.kind === "skipped" ? st : null;
    },
    [matchStatus, statusReady, matches, decisions, gate],
  );

  const filterOf = useCallback(
    (row: ReconRow): ReconFilter[] => {
      // A row the user removed from this review is out of the list — only the "Excluded" filter shows it (to restore it).
      if (row.removedFromReview) return ["excluded"];
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
      if (match.state !== "excluded" && match.state !== "already_imported" && (match.candidates.length > 0 || match.pendingSms.length > 0)) out.push("possible");
      if (match.state !== "excluded") {
        const valid = decision.kind != null && decision.kind !== "investigate" && decisionErrors(row, match, decision, gate(row)).length === 0;
        out.push(valid ? "decided" : "open");
      }
      const st = statusFor(row);
      if (st) out.push(st.kind);
      return out;
    },
    [matches, decisions, gate, statusFor],
  );

  // ---- Review & Import summary + bulk "Import new rows" (draft only) ----
  const moneyTotals = useMemo(() => reviewTotals(rows.filter((r) => !r.captureExcluded)), [rows]);
  const summaryCounts = useMemo(() => {
    const included = rows.filter((r) => r.include && !r.captureExcluded && matches.get(r.id)?.state !== "excluded");
    const possibleDuplicates = included.filter((r) => {
      const m = matches.get(r.id);
      return !!m && m.state !== "already_imported" && (m.candidates.length > 0 || m.pendingSms.length > 0 || m.notes.some((n) => n.kind === "possible_repeat") || openIssues(r).some((i) => i.code === "possible_repeat"));
    }).length;
    return { included: included.length, possibleDuplicates, toCheck: included.filter((r) => rowCheckLabel(r) != null).length, willImport: readiness?.proposedNew ?? 0 };
  }, [rows, matches, readiness]);
  const bulkPlan = useMemo(
    () => (session && accountId && matchStatus === "ready" ? bulkImportPlan(rows, matches, decisions, gate, categoryIndex) : { rows: [], creditsLeft: 0 }),
    [session, accountId, matchStatus, rows, matches, decisions, gate, categoryIndex],
  );
  const rowsById = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const expenseCategoryNames = useMemo(() => categoriesForDirection(data.categories, "debit").map((c) => c.name), [data.categories]);

  const counts = useMemo(() => {
    const c = { all: 0, ready: 0, duplicate: 0, fix: 0, skipped: 0, open: 0, possible: 0, exact: 0, near: 0, multiple: 0, no_match: 0, in_inbox: 0, conflict: 0, imported: 0, decided: 0, excluded: 0 } satisfies Record<ReconFilter, number>;
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

  /**
   * Every row FlowFi has a possible match for that is still undecided, in statement order (view only — nothing here is
   * decided, linked or imported). Feeds the "possible matches found" strip, the jump list, and the row a review opens on.
   */
  const foundMatches = useMemo(() => {
    if (matchStatus !== "ready" || !accountId) return [];
    return rows
      .filter((r) => r.include && decisionFor(decisions, r.id).kind == null)
      .flatMap((r) => {
        const m = matches.get(r.id);
        if (!m || m.state === "excluded" || m.state === "already_imported" || m.candidates.length === 0) return [];
        return [{ rowId: r.id, number: numberOf(r.id), description: r.description, amount: r.amount, direction: r.direction, date: r.date, label: STATE_META[m.state].label, exact: m.state === "exact_candidate" }];
      });
  }, [matchStatus, accountId, rows, decisions, matches, numberOf]);

  // When a review first becomes comparable, open it on the row the user was last on (this tab), else on the first row that
  // has a possible match — so a detected match is on screen instead of behind a click. Only moves the selection; never
  // decides anything. Runs once per capture + account (set during render, like confirmRowId below).
  const reviewKey = session && accountId ? selectionKey(session.fingerprint, accountId) : null;
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  if (reviewKey && matchStatus === "ready" && openedFor !== reviewKey) {
    setOpenedFor(reviewKey);
    if (!selectedId) {
      const remembered = readSelectedRow(reviewKey);
      const pick = remembered && rows.some((r) => r.id === remembered) ? remembered : (foundMatches[0]?.rowId ?? null);
      if (pick) setSelectedId(pick);
    }
  }

  // The row in focus is always one the statement sheet is SHOWING: if a filter or search hides the selected row (e.g.
  // deciding it under "Pending"), focus moves to the next shown row in statement order — the FlowFi sheet and the review
  // strip must never describe a row the user can't see.
  const activeId = useMemo(() => {
    if (selectedId && visible.some((r) => r.id === selectedId)) return selectedId;
    if (selectedId) {
      const order = new Map(rows.map((r, i) => [r.id, i]));
      const at = order.get(selectedId);
      if (at != null) {
        const next = visible.find((r) => order.get(r.id)! > at);
        if (next) return next.id;
      }
    }
    return visible[0]?.id ?? null;
  }, [selectedId, visible, rows]);
  const activeRow = rows.find((r) => r.id === activeId) ?? null;
  // The inline review belongs to the selected row: moving the selection closes it (set during render, like openedFor).
  if (inlineId && inlineId !== activeId) setInlineId(null);
  const inlineOpenId = inlineId && inlineId === activeId ? inlineId : null;
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
        ? existingEntries({ row: activeRow, match: activeMatch, records, accountId, period: periodDays, linkedRows, rejectedRecordIds: rejectedIds, rowNumberOf: numberOf, mode: "matches" })
        : [],
    [activeRow, activeMatch, records, accountId, sheetReady, periodDays, linkedRows, rejectedIds, numberOf],
  );
  // Every record the row could be compared with (unfiltered), so a search never loses the picked transaction.
  const allEntries = useMemo(
    () => (activeRow && accountId && sheetReady ? existingEntries({ row: activeRow, match: activeMatch, records, accountId, period: periodDays, linkedRows, rejectedRecordIds: rejectedIds, rowNumberOf: numberOf, mode: "ledger" }) : []),
    [activeRow, activeMatch, records, accountId, sheetReady, periodDays, linkedRows, rejectedIds, numberOf],
  );
  const matchEntriesCount = activeMatch ? new Set([activeMatch.alreadyImportedId, ...activeMatch.candidates.map((c) => c.recordId), ...activeMatch.pendingSms.map((c) => c.recordId)].filter(Boolean)).size : 0;
  const targetId = recordPick && recordPick.rowId === activeId ? recordPick.recordId : defaultTargetId(activeMatch, activeDecision ?? undefined);
  const target = (targetId && allEntries.find((e) => e.record.id === targetId)) || null;

  // Remember the row in focus for this tab — but only once the opening selection above has been settled, so a not-yet-ready
  // review never overwrites what it is about to restore.
  useEffect(() => {
    if (reviewKey && openedFor === reviewKey && activeId) writeSelectedRow(reviewKey, activeId);
  }, [reviewKey, openedFor, activeId]);
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
  // When the inline review opens (or its candidate / decision list changes height), keep the row and the panel's decision
  // buttons inside the table's own scroll body — scrolling only that body, never the page, and never past the row's top.
  useEffect(() => {
    if (!inlineOpenId) return;
    const settle = () => {
      const rowEl = document.getElementById(`recon-row-${inlineOpenId}`);
      const panel = document.querySelector<HTMLElement>('[data-testid="inline-review"]');
      const body = rowEl?.closest<HTMLElement>('[data-testid="recon-grid-body"]');
      if (!rowEl || !panel || !body) return;
      const b = body.getBoundingClientRect();
      const r = rowEl.getBoundingClientRect();
      const pn = panel.getBoundingClientRect();
      if (pn.bottom > b.bottom) body.scrollTop += Math.min(pn.bottom - b.bottom + 4, Math.max(r.top - b.top, 0));
      else if (r.top < b.top) body.scrollTop -= b.top - r.top;
    };
    const t = window.setTimeout(settle, 30);
    return () => window.clearTimeout(t);
  }, [inlineOpenId]);

  // ---- draft decisions, with Undo ----
  const remember = (label: string, next: Record<string, RowDecision>, rowIds: string[]) => {
    setLastRemoved(null);
    setHistory((h) => pushHistory(h, { id: `h_${Date.now()}_${h.length}`, label, changes: diffDecisions(decisions, next, rowIds) }));
    setUndoNotice(null);
  };
  /** Every decision made on this screen goes through here: one draft change, remembered for Undo. Never a write. */
  const decide = (rowId: string, patch: Partial<RowDecision>, label?: string) => {
    remember(label ?? `${patch.kind ? DECISION_META[patch.kind].short : "Change"} · row ${numberOf(rowId)}`, setDecision(decisions, rowId, patch), [rowId]);
    s.decide(rowId, patch);
    if (patch.kind !== undefined) setInlineId((id) => (id === rowId ? null : id));
    if (patch.kind && autoNext && isDesktop && rowId === activeId && !inspectorOpen && !label?.startsWith("Details")) advanceAfter(rowId, patch.kind);
  };
  /** The next row still waiting for a decision after `rowId`, in statement order — wrapping round to the start. */
  const nextWaitingAfter = (rowId: string): ReconRow | null => {
    const at = visible.findIndex((r) => r.id === rowId);
    const waiting = (r: ReconRow) => r.id !== rowId && r.include && !r.captureExcluded && decisionFor(decisions, r.id).kind == null && matches.get(r.id)?.state !== "excluded" && matches.get(r.id)?.state !== "already_imported";
    return [...visible.slice(at + 1), ...visible.slice(0, Math.max(at, 0))].find(waiting) ?? null;
  };
  /** One line of feedback (with Undo) and the next row still waiting — the review keeps moving. */
  const advanceAfter = (rowId: string, kind: NonNullable<RowDecision["kind"]>) => {
    const next = nextWaitingAfter(rowId);
    const said = { link: "Kept existing", import_new: "Marked to import", ignore: "Skipped", investigate: "Saved for later", inbox: "Left for Inbox" }[kind];
    toast.success(`${said} · Row ${numberOf(rowId)}`, next ? `Next: Row ${numberOf(next.id)}` : "Nothing else is waiting", { label: "Undo", onClick: () => undoRef.current() });
    if (next) setSelectedId(next.id);
  };
  /**
   * Remove from review: the captured row leaves this review (the existing "Include this row" switch, turned off). It is
   * never imported, and nothing in FlowFi is deleted or changed — no transaction, no balance. Undo (toast, Z, or Restore
   * under the Excluded filter) puts it back exactly as it was.
   */
  const removeFromReview = (row: ReconRow) => {
    const next = nextWaitingAfter(row.id);
    setLastRemoved(row.id);
    s.setRemoved(row.id, true);
    toast.success(`Removed from review · Row ${numberOf(row.id)}`, "Nothing was imported or changed in FlowFi.", { label: "Undo", onClick: () => restoreToReview(row.id) });
    if (row.id === activeId && next) setSelectedId(next.id);
  };
  const restoreToReview = (rowId: string) => {
    setLastRemoved((id) => (id === rowId ? null : id));
    s.setRemoved(rowId, false);
    setFilter("all");
    setSelectedId(rowId);
  };
  const reject = (rowId: string, recordId: string) => {
    remember(`Not this one · row ${numberOf(rowId)}`, rejectCandidate(decisions, rowId, recordId), [rowId]);
    s.reject(rowId, recordId);
  };
  const undo = () => {
    if (lastRemoved) {
      restoreToReview(lastRemoved);
      return;
    }
    const result = undoLast(history, decisions);
    if (!result.entry) return;
    setHistory(result.stack);
    if (result.restored > 0) s.replaceDecisions(userOnly(result.decisions));
    // Back to the row that was undone, so the decision can be revisited.
    const undone = result.entry.changes[0]?.rowId;
    if (undone && rows.some((r) => r.id === undone)) setSelectedId(undone);
    const n = result.skipped;
    setUndoNotice(n > 0 ? `Undid “${result.entry.label}” — ${n} row${n === 1 ? "" : "s"} changed since, left as ${n === 1 ? "it is" : "they are"}.` : `Undid “${result.entry.label}”.`);
  };
  const undoRef = useRef(undo);
  useEffect(() => {
    undoRef.current = undo;
  });
  const resetView = () => {
    setSelectedId(null);
    setInlineId(null);
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
  /**
   * A row's warning / "Fix details": open its editor, and once the sheet has slid in put the cursor on the value that needs
   * attention (date, amount or Debit/Credit). View state only — the editor's own confirm rules are unchanged.
   */
  const [attention, setAttention] = useState<{ rowId: string; field: "amount" | "date" | "direction" | "description" } | null>(null);
  const fixRow = (rowId: string) => {
    const row = rows.find((r) => r.id === rowId);
    setSelectedId(rowId);
    setInspectorOpen(true);
    const field = row ? attentionFieldOf(row) : null;
    setAttention(field ? { rowId, field } : null);
  };
  useEffect(() => {
    if (!inspectorOpen || !attention) return;
    const t = window.setTimeout(() => {
      const panel = document.querySelector<HTMLElement>('[data-testid="row-editor-panel"]');
      const label = { amount: "Amount", date: "Date", direction: "Debit or credit", description: "Description" }[attention.field];
      const target = panel?.querySelector<HTMLElement>(`input[aria-label="${label}"]`) ?? panel?.querySelector<HTMLElement>(`[aria-label="${label}"] [role="radio"], [aria-label="${label}"] button, [aria-label="${label}"]`);
      target?.focus?.();
      target?.scrollIntoView?.({ block: "center" });
      setAttention(null);
    }, 360);
    return () => window.clearTimeout(t);
  }, [inspectorOpen, attention]);
  /** Compare a row with FlowFi: desktop focuses the Existing FlowFi sheet; phones open the row's sheet. */
  const compare = (rowId: string) => {
    setSelectedId(rowId);
    if (isDesktop) {
      // One workspace at a time: the editor sheet closes, the row's inline review opens (or closes on a second click).
      setInspectorOpen(false);
      setInlineId((id) => (id === rowId ? null : rowId));
    } else setCompareOpen(true);
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
        // A financial rule (closed bill, own-card payment…) blocks Import outright — a value that needs fixing does not: it is fixed in the editor.
        if (importBlockReasons(row, match, gate(row)).some((r) => !valueIssues(row).includes(r))) return;
        // Import as transaction: the row's editor opens (date, description, amount, category, notes, Mine / Someone else's /
        // Split) with the import button in its footer — the decision itself is only recorded from there.
        if (isDesktop) {
          setSelectedId(row.id);
          setInspectorOpen(true);
          setAttention(null);
        } else if (hasPossibleMatch(match)) compare(row.id);
        else if (importBlockReasons(row, match, gate(row)).length === 0) decide(row.id, { kind: "import_new" });
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
    // A row the user removed can only be put back.
    if (row.removedFromReview) return [{ id: "restore", kind: null, label: "Restore to review", hint: "Puts the row back in this review.", onSelect: () => restoreToReview(row.id) }];
    const match = matches.get(row.id);
    if (!match || match.state === "excluded" || !row.include) return null;
    const decision = decisionFor(decisions, row.id);
    const out: QuickAction[] = [];
    if (keepTargetFor(row, match)) out.push({ id: "keep_existing", kind: "link", label: "Keep existing", hint: "It's already in FlowFi, so this row won't be imported.", onSelect: () => quickDecide(row, match, "link") });
    else if (match.candidates.length > 0 || match.pendingSms.length > 0) {
      // Shown but disabled, with the reason — never a silent gap (the picked transaction can't be this row, or is already kept).
      const reason = row.id === activeId && target?.viewOnly ? target.viewOnly.message : "No FlowFi transaction is left to keep for this row (it may already be kept by another row).";
      out.push({ id: "keep_existing", kind: "link", label: "Keep existing", hint: reason, disabledReason: reason, onSelect: () => undefined });
    }
    // Import is blocked only by financial rules (closed bill…); a value that needs fixing is fixed in the editor it opens.
    const ruleBlock = importBlockReasons(row, match, gate(row)).filter((r) => !valueIssues(row).includes(r))[0];
    out.push({ id: "import", kind: "import_new", label: "Import as transaction", hint: "Opens the details to confirm, then adds it when you give final approval.", disabledReason: ruleBlock, onSelect: () => quickDecide(row, match, "import_new") });
    out.push({ id: "review_later", kind: "investigate", label: DECISION_META.investigate.label, hint: "Keeps the row open — final approval waits for it.", onSelect: () => quickDecide(row, match, "investigate") });
    if (match.candidates.length > 0 && keepTargetFor(row, match)) {
      out.push({ id: "ignore_match", kind: null, label: "Not a match — ignore", hint: "Drops this FlowFi suggestion for the row. Nothing is imported or deleted.", onSelect: () => ignoreSuggestion(row) });
    }
    if (match.pendingSms.length > 0) out.push({ id: "inbox", kind: "inbox", label: DECISION_META.inbox.label, hint: "Leaves it to the Transaction Inbox.", onSelect: () => decide(row.id, { kind: "inbox" }) });
    out.push({ id: "details", kind: null, label: "View details", hint: "Edit the captured values, or compare with FlowFi.", onSelect: () => (isDesktop ? fixRow(row.id) : compare(row.id)) });
    if (decision.kind) out.push({ id: "clear", kind: null, label: "Clear my decision", hint: "Puts the row back to needs review.", onSelect: () => quickDecide(row, match, "clear") });
    out.push({ id: "remove", kind: null, label: "Remove from review", hint: "Takes this row out of the review. Nothing in FlowFi changes.", danger: true, onSelect: () => removeFromReview(row) });
    return out;
  };
  /** "Not a match": drop the suggested FlowFi transaction for this row (a draft "Not this one", undoable). */
  const ignoreSuggestion = (row: ReconRow) => {
    const rec = keepTargetFor(row, matches.get(row.id)!);
    if (!rec) return;
    reject(row.id, rec);
    setRecordPick(null);
  };

  /** Records the bulk "Import new" as ordinary draft decisions — one Undo step. */
  function applyBulkImport(choices: { rowId: string; category: string }[]) {
    let next = decisions;
    for (const c of choices) next = setDecision(next, c.rowId, { kind: "import_new", category: c.category, notSameAck: false });
    remember(`Import new · ${choices.length} row${choices.length === 1 ? "" : "s"}`, next, choices.map((c) => c.rowId));
    s.replaceDecisions(userOnly(next));
    setBulkImportOpen(false);
  }

  /** The next row whose captured values still need a check or a correction — opened in its editor. */
  function goToNextCheck() {
    const pool = rows.filter((r) => rowCheckLabel(r) != null);
    if (pool.length === 0) return;
    if (!visible.some((r) => r.id === pool[0].id)) setFilter("all");
    const at = rows.findIndex((r) => r.id === activeId);
    const next = pool.find((r) => rows.indexOf(r) > at) ?? pool[0];
    setSelectedId(next.id);
    if (isDesktop) setInspectorOpen(true);
    else setCompareOpen(true);
  }

  // The next row that still needs a decision, after the one in focus (wrapping round), within the rows now showing.
  function goToNextOpen() {
    const isOpen = (r: ReconRow) => (statusReady ? filterOf(r).includes("duplicate") || filterOf(r).includes("fix") : filterOf(r).includes("open"));
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
    // View-only key: toggle Focus Mode.
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
    // Enter / Space on a button inside a row (the ⋯ menu, the warning, the pencil) activates that button — never the grid's own Enter.
    if ((e.key === "Enter" || e.key === " ") && (e.target as HTMLElement).closest?.("button")) return;
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
        case "Enter":
          if (activeRow) {
            e.preventDefault();
            setInlineId(null);
            setInspectorOpen((open) => !open);
          }
          return;
        case "Escape":
          setInspectorOpen(false);
          setInlineId(null);
          return;
        case "o":
          if (activeRow && activeMatch) compare(activeRow.id);
          return;
      }
    }
    resolutionKey(e);
  }

  // ---- render ----
  if (!s.ready) {
    return <div className="h-40 animate-pulse rounded-3xl bg-muted/60" aria-label="Loading" />;
  }

  /** The inline match review under a row (desktop): the matcher's candidates for THIS row, one comparison, four decisions. */
  const inlineFor = (row: ReconRow) => {
    const match = matches.get(row.id);
    if (!match || !accountId || row.id !== activeId) return null;
    const keepBoth = (patch: ImportPatch) => importRow(row, match, patch);
    return (
      <InlineMatchReview
        row={row}
        rowNumber={numberOf(row.id)}
        match={match}
        decision={decisionFor(decisions, row.id)}
        gate={gate(row)}
        entries={entries}
        targetId={targetId}
        onPick={(recordId) => setRecordPick({ rowId: row.id, recordId })}
        accountName={accountName}
        statementAccount={statementAccount}
        captureSource={session?.source ?? "text"}
        categories={data.categories}
        onKeepExisting={(recordId) => keepExisting(row, recordId)}
        onKeepBoth={keepBoth}
        onImportNew={keepBoth}
        onReviewLater={() => quickDecide(row, match, "investigate")}
        onNotThisOne={(recordId) => {
          reject(row.id, recordId);
          setRecordPick(null);
        }}
        onClearDecision={() => quickDecide(row, match, "clear")}
        onClose={() => setInlineId(null)}
        onFullDetails={() => setCompareOpen(true)}
      />
    );
  };
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
      screenshot={screenshot}
      people={data.people}
    />
  );
  /**
   * "Import as transaction" in the row editor's footer: the confirmation (acknowledgement when FlowFi has something similar,
   * category, refund/income, own-account check) opens from the button. It records the same draft decision as before — the
   * final approval is still the only thing that writes a transaction (keyed, exactly once).
   */
  const importSlotFor = (row: ReconRow, match: RowMatch) => {
    const blocked = importBlockReasons(row, match, gate(row))[0] ?? null;
    const decision = decisionFor(decisions, row.id);
    const done = decision.kind === "import_new";
    return (
      <Popover open={importOpen && !blocked} onOpenChange={(o) => setImportOpen(o && !blocked)}>
        <PopoverAnchor asChild>
          <button
            type="button"
            disabled={!!blocked}
            onClick={() => setImportOpen(true)}
            title={blocked ?? "Record this row as a new transaction (added at final approval)"}
            data-testid="import-as-transaction"
            className={cn(SHEET_BUTTON.primary, "h-9 px-4 disabled:opacity-50")}
          >
            {done ? "✓ Importing as new" : "Import as transaction"}
          </button>
        </PopoverAnchor>
        <PopoverContent side="top" align="end" className="z-[80] w-80 p-3">
          <ImportConfirm
            row={row}
            decision={decision}
            categories={data.categories}
            needsAck={hasPossibleMatch(match)}
            ownTransferConfirm={ownTransferConfirmFor(row, gate(row))}
            label="Import as transaction"
            onCancel={() => setImportOpen(false)}
            onConfirm={(patch) => {
              setImportOpen(false);
              importRow(row, match, patch);
              setInspectorOpen(false);
              if (autoNext) advanceAfter(row.id, "import_new");
            }}
          />
        </PopoverContent>
      </Popover>
    );
  };
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
        stateLabel={!match ? null : kind ? decisionShort(kind, hasPossibleMatch(match)) : pendingLabelFor(hasPossibleMatch(match))}
        nav={at >= 0 ? { position: at + 1, total: visible.length, onPrev: at > 0 ? () => go(-1) : undefined, onNext: at < visible.length - 1 ? () => go(1) : undefined } : undefined}
        onClose={closeRowSheet}
        onCompare={match ? compareFromSheet : undefined}
        importSlot={match && match.state !== "excluded" && row.include ? importSlotFor(row, match) : undefined}
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

  return (
    <div
      className={cn("flex flex-col gap-3 px-1 pb-2", fit && "min-h-[32rem] gap-1.5 px-0 pb-0", fit && (focusMode.focus ? "h-[calc(100dvh-1rem)] sm:h-[calc(100dvh-1.5rem)]" : "h-[calc(100dvh-6.5rem)]"))}
      data-testid="recon-workspace"
      data-focus={focusMode.focus ? "true" : "false"}
    >
      {isDesktop ? (
        <ReviewToolbar
          account={
            session ? (
              <ReconAccountBar
                variant="inline"
                options={accountOptions}
                accountId={accountId}
                onChange={chooseAccount}
                status={accountsStatus}
                onRetry={sync.retry}
                period={period}
                expiresAt={s.expiresAt}
                storageFailed={s.storageFailed}
                suggestion={accountSuggestion}
              />
            ) : null
          }
          ready={!!session && !!accountId && matchStatus === "ready"}
          filter={filter}
          onFilter={setFilter}
          counts={counts}
          query={query}
          onQuery={setQuery}
          sort={sort}
          onSort={setSort}
          summary={session && accountId && matchStatus === "ready" ? summaryCounts : null}
          onNextCheck={goToNextCheck}
          bulkImportCount={bulkPlan.rows.length}
          onBulkImport={() => setBulkImportOpen(true)}
          bulkLinkCount={bulkPairs.length}
          onBulkLink={() => setBulkConfirmOpen(true)}
          undoBulkCount={lastBulk?.count ?? 0}
          onUndoBulk={() => {
            if (lastBulk) s.undoBulk(lastBulk.id);
            setLastBulk(null);
          }}
          focus={{ on: focusMode.focus, toggle: focusMode.toggleFocus, canFullscreen: focusMode.canFullscreen, fullscreen: focusMode.fullscreen, toggleFullscreen: () => void focusMode.toggleFullscreen() }}
          onDiscard={session ? () => setDiscardOpen(true) : undefined}
        />
      ) : (
        <WorkspaceHeader icon={GitCompareArrows} title="Review & Import" current="reconcile" steps={{ capture: { href: "/smart-capture" } }}>
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
      )}

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

      {session && accountId && (matchStatus === "loading" || (matchStatus === "ready" && billsState === "loading")) && (
        <div role="status" data-testid="records-loading" data-phase={slowLoading ? "slow" : "loading"} className="flex shrink-0 items-center gap-2 rounded-lg bg-muted/60 px-3 py-1 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 shrink-0 animate-spin" />
          <span className="min-w-0 flex-1 truncate">
            {matchStatus === "loading" ? `Loading your FlowFi ${sync.loading.map(sourceLabel).join(", ")}… Your rows are shown; matches fill in as soon as these load.` : "Matches are ready. Checking card bills before statuses and import are shown…"}
            {slowLoading ? " This is taking longer than usual." : ""}
          </span>
          {slowLoading && (
            <button type="button" onClick={sync.retry} data-testid="records-retry" className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-2 font-medium text-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
              <RefreshCw className="size-3" /> Retry
            </button>
          )}
        </div>
      )}
      {session && accountId && (matchStatus === "error" || billsState === "failed") && errorDismissedKey !== errorKey && (
        <div role="alert" className="flex shrink-0 items-center gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-1.5 text-xs text-danger" data-testid="records-error">
          <TriangleAlert className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1">
            {matchStatus === "error"
              ? `Couldn't load your FlowFi ${sync.failed.map(sourceLabel).join(", ")}, so rows can't be compared — nothing is shown as "No match" until this works.`
              : "Couldn't load your card bills — matches are shown, but statuses and import are paused until they load."}
          </span>
          <button type="button" onClick={sync.retry} data-testid="records-retry" className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-2 font-medium hover:bg-danger/10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
            <RefreshCw className="size-3" /> Retry
          </button>
          <button type="button" aria-label="Dismiss" onClick={() => setErrorDismissedKey(errorKey)} className="grid size-5 shrink-0 place-items-center rounded-full hover:bg-danger/10">
            <X className="size-3" />
          </button>
        </div>
      )}

      {!session ? (
        <ReconIntake onStart={s.startFromText} />
      ) : (
        <>
          {!isDesktop && (
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
          )}

          {!isDesktop && accountId && (
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

          {!isDesktop && accountId && matchStatus === "ready" && (
            <ReviewImportSummary totals={moneyTotals} counts={summaryCounts} bulkCount={bulkPlan.rows.length} onBulk={() => setBulkImportOpen(true)} onNextCheck={goToNextCheck} />
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
              {accountId && matchStatus === "ready" && <ReviewFilterStrip filter={filter} onFilter={setFilter} captured={rows.length} counts={counts} checking={!statusReady} />}
              <div className="flex min-h-[12rem] min-w-0 flex-1" data-testid="review-sheet">
                <div className="min-h-0 min-w-0 flex-1">
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
                      setInlineId(null);
                      setInspectorOpen(!closing);
                    }}
                    onFixRow={fixRow}
                    onCompare={compare}
                    pendingLabel={pendingLabel}
                    onKeyDown={onGridKeyDown}
                    quickActions={quickActionsFor}
                    accountMissing={accountMissing && recordsReady}
                    accountHintOf={accountHintOf}
                    statusOf={statusFor}
                    onRemove={(id) => {
                      const r = rowsById.get(id);
                      if (r) removeFromReview(r);
                    }}
                    inlineId={inlineOpenId}
                    renderInline={inlineFor}
                    header={
                      <SheetTitleBar
                        title="Statement review"
                        subtitle={`${session.source === "ocr" ? "Smart Capture screenshot" : "Pasted statement"} · ${rows.length} row${rows.length === 1 ? "" : "s"}${visible.length !== rows.length ? ` · ${visible.length} shown` : ""}`}
                      />
                    }
                  />
                </div>
              </div>
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
            onApprove={() => void approval.importNow()}
            onNextOpen={goToNextOpen}
            onUndo={undo}
            undoLabel={lastRemoved ? `Removed row ${numberOf(lastRemoved)}` : (history.at(-1)?.label ?? null)}
            autoNext={autoNext}
            onToggleAutoNext={toggleAutoNext}
            desktop={isDesktop}
            totals={isDesktop && accountId && matchStatus === "ready" ? moneyTotals : null}
            summaryCounts={summaryCounts}
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
      <BulkImportDialog
        open={bulkImportOpen}
        onOpenChange={setBulkImportOpen}
        plan={bulkPlan}
        rowsById={rowsById}
        numberOf={numberOf}
        categoryNames={expenseCategoryNames}
        onApply={applyBulkImport}
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
            setHandoffNotice(handoffNoticeText(taken.rows));
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
  onUndo,
  undoLabel = null,
  autoNext = true,
  onToggleAutoNext,
  desktop,
  totals = null,
  summaryCounts,
}: {
  onUndo?: () => void;
  undoLabel?: string | null;
  autoNext?: boolean;
  onToggleAutoNext?: () => void;
  rowsCount: number;
  summary: ReturnType<typeof reviewSummary> | null;
  readiness: ReadinessCounts | null;
  canApprove: boolean;
  hasAccount: boolean;
  onApprove: () => void;
  onNextOpen: () => void;
  desktop: boolean;
  /** Desktop: the included rows' money, shown in this bar (the phone layout keeps its own summary strip). */
  totals?: ReviewTotals | null;
  summaryCounts?: SummaryCounts;
}) {
  const items: { key: string; label: string; value: number; tone: ReadinessTone; hideZero?: boolean }[] = readiness
    ? [
        { key: "included", label: "Included", value: readiness.included, tone: "default" },
        { key: "already-recorded", label: "Keep existing", value: readiness.alreadyRecorded, tone: "success" },
        { key: "add-new", label: "Ready", value: readiness.proposedNew, tone: "primary" },
        { key: "imported-earlier", label: "Imported earlier", value: readiness.alreadyImported, tone: "success", hideZero: true },
        { key: "skipped", label: "Skipped", value: readiness.skipped, tone: "default" },
        { key: "inbox", label: "Left for Inbox", value: readiness.inbox, tone: "default", hideZero: true },
        { key: "review-later", label: "Review later", value: readiness.reviewLater, tone: readiness.reviewLater > 0 ? "warning" : "default" },
        { key: "undecided", label: "To resolve", value: readiness.unresolved, tone: "default" },
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
          ? `Import adds ${readiness.proposedNew} new transaction${readiness.proposedNew === 1 ? "" : "s"}; kept-existing, skipped and Inbox rows are never written. Every row is re-checked against FlowFi first.`
          : "Nothing to import — kept-existing, skipped and Inbox rows are never written."
        : `${open} row${open === 1 ? "" : "s"} still need${open === 1 ? "s" : ""} a decision before importing. Nothing is written to FlowFi while you review.`;
  const HintIcon = canApprove ? CheckCircle2 : Info;

  if (desktop) {
    const net = totals?.net ?? 0;
    return (
      <div data-testid="status-bar" className="z-[1] flex h-9 shrink-0 items-center gap-3 rounded-lg border border-border-strong/60 bg-card px-2.5">
        <div className="flex shrink-0 items-center gap-2">
          <p className="text-xs font-medium whitespace-nowrap text-foreground">
            {summary ? (
              <>
                <span className="tabular-nums" data-testid="progress-count">
                  {summary.decided}/{summary.included}
                </span>{" "}
                reviewed
              </>
            ) : (
              `${rowsCount} rows captured`
            )}
          </p>
          {summary && summary.included > 0 && (
            <div role="progressbar" aria-label="Review progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="flex h-1.5 w-24 overflow-hidden rounded-full bg-muted">
              {readiness &&
                (
                  [
                    ["bg-success", readiness.alreadyRecorded + readiness.alreadyImported],
                    ["bg-primary", readiness.proposedNew],
                    ["bg-muted-foreground/50", readiness.skipped + readiness.inbox],
                  ] as const
                ).map(([color, n]) => (n > 0 ? <div key={color} className={cn("h-full transition-[width] duration-300", color)} style={{ width: `${(n / summary.included) * 100}%` }} /> : null))}
            </div>
          )}
        </div>
        {totals && (
          <section aria-label="Import summary" data-testid="import-summary" className="flex min-w-0 shrink items-center gap-3 border-l border-border pl-3 [&_dd]:text-xs [&_dt]:text-[10px]">
            <dl className="flex min-w-0 items-baseline gap-3 [&>div]:flex-row [&>div]:items-baseline [&>div]:gap-1">
              <Figure label="Debits" value={`${totals.debits > 0 ? "−" : ""}${formatCurrencyPrecise(totals.debits)}`} testId="total-debits" amount={totals.debits} />
              <Figure label="Credits" value={`${totals.credits > 0 ? "+" : ""}${formatCurrencyPrecise(totals.credits)}`} testId="total-credits" amount={totals.credits} tone={totals.credits > 0 ? "success" : undefined} />
              <Figure label={net < 0 ? "Net out" : net > 0 ? "Net in" : "Net"} value={formatCurrencyPrecise(Math.abs(net))} testId="total-net" amount={net} />
            </dl>
            {summaryCounts && (
              <dl className="hidden items-baseline gap-2.5 text-[11px] text-muted-foreground 2xl:flex">
                <Count label="Included" value={summaryCounts.included} testId="summary-included" />
                <Count label="Will import" value={summaryCounts.willImport} testId="summary-will-import" tone={summaryCounts.willImport > 0 ? "primary" : undefined} />
              </dl>
            )}
            {totals.uncounted > 0 && (
              <span className="text-[11px] whitespace-nowrap text-warning" title="Included rows without an amount or Debit/Credit aren't counted yet. Totals use included rows' current values.">
                +{totals.uncounted} uncounted
              </span>
            )}
          </section>
        )}
        {items.length > 0 && (
          <dl className="hidden min-w-0 flex-1 items-center gap-x-3 overflow-hidden text-[11px] whitespace-nowrap xl:flex" data-testid="readiness-counts">
            {items.map((i) => (
              <div
                key={i.key}
                // Zero counts and "Included" (already beside the totals) stay in the DOM but out of this one line.
                className={cn("flex items-baseline gap-1 text-muted-foreground", STAT_TONE[i.value === 0 ? "default" : i.tone], (i.value === 0 || i.key === "included") && "hidden")}
                data-testid={`readiness-${i.key}`}
              >
                <dt>{i.label}</dt>
                <dd className="text-xs font-semibold tabular-nums">{i.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {hasAccount && (
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {onToggleAutoNext && (
              <button
                type="button"
                onClick={onToggleAutoNext}
                aria-pressed={autoNext}
                data-testid="auto-next"
                title={autoNext ? "After each decision, jump to the next row waiting (on)" : "Stay on the row after a decision (off)"}
                className={cn("inline-flex h-7 shrink-0 items-center gap-1 rounded px-2 text-[11.5px] font-medium transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none", autoNext ? "text-primary-accent-text" : "text-muted-foreground")}
              >
                <ChevronsDown className="size-3.5" aria-hidden /> Auto-next
              </button>
            )}
            {onUndo && (
              <ClayButton size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={onUndo} disabled={!undoLabel} title={undoLabel ? `Undo: ${undoLabel}` : "Nothing to undo"} data-testid="undo-decision" aria-label={undoLabel ? `Undo ${undoLabel}` : "Undo"}>
                <Undo2 className="size-3.5" /> Undo
                <kbd className="rounded bg-muted px-1 font-mono text-[10px] text-muted-foreground">Z</kbd>
              </ClayButton>
            )}
            {open > 0 && (
              <ClayButton size="sm" variant="secondary" className="h-7 px-2 text-xs" onClick={onNextOpen} data-testid="next-open" aria-label={`Go to next row that needs a decision (${open} left)`} title="Next row that still needs a decision (U)">
                <ArrowDownToLine className="size-3.5" /> Next to resolve
              </ClayButton>
            )}
            <ClayButton size="sm" className="h-7 px-2.5 text-xs" variant={canApprove ? "primary" : "secondary"} onClick={onApprove} disabled={!canApprove || !readiness || readiness.proposedNew === 0} data-testid="open-approval" title={hint}>
              {`Import ${readiness?.proposedNew ?? 0} transaction${readiness?.proposedNew === 1 ? "" : "s"}`}
            </ClayButton>
          </div>
        )}
        <p className="sr-only" data-testid="approval-hint">
          {hint}
        </p>
      </div>
    );
  }

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
            // Segments show WHAT was decided (kept / new / skipped), not just how much — same counts as the stats beside it.
            <div role="progressbar" aria-label="Review progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="hidden h-2 w-32 overflow-hidden rounded-full bg-muted sm:flex">
              {readiness &&
                (
                  [
                    ["bg-success", readiness.alreadyRecorded + readiness.alreadyImported],
                    ["bg-primary", readiness.proposedNew],
                    ["bg-muted-foreground/50", readiness.skipped + readiness.inbox],
                  ] as const
                ).map(([color, n]) => (n > 0 ? <div key={color} className={cn("h-full transition-[width] duration-300", color)} style={{ width: `${(n / summary.included) * 100}%` }} /> : null))}
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
            <ClayButton size="sm" variant={canApprove ? "primary" : "secondary"} onClick={onApprove} disabled={!canApprove || !readiness || readiness.proposedNew === 0} data-testid="open-approval">
              {`Import ${readiness?.proposedNew ?? 0} transaction${readiness?.proposedNew === 1 ? "" : "s"}`}
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
        <h2 className="shrink-0 text-[12.5px] leading-tight font-semibold text-foreground">{title}</h2>
        <p className="truncate text-[11px] text-muted-foreground">{subtitle}</p>
      </div>
      <span className="text-[10px] font-semibold tracking-[0.08em] text-primary-accent-text uppercase" title="Rows read from your statement — nothing here is in FlowFi yet">Incoming</span>
    </header>
  );
}

/** A slim one-line status notice (restored review, handoff, fullscreen fallback) — never a banner card. */
function Notice({ children, onDismiss, testId, icon: Icon = History }: { children: React.ReactNode; onDismiss: () => void; testId?: string; icon?: typeof History }) {
  // Informational only: it goes away by itself after a few seconds (the X still works).
  const dismissRef = useRef(onDismiss);
  useEffect(() => {
    dismissRef.current = onDismiss;
  });
  useEffect(() => {
    const t = window.setTimeout(() => dismissRef.current(), 6000);
    return () => window.clearTimeout(t);
  }, []);
  return (
    <div role="status" className="flex min-h-7 shrink-0 items-center gap-2 rounded-lg bg-primary/10 px-2.5 py-0.5 text-xs text-foreground" data-testid={testId}>
      <Icon className="size-3.5 shrink-0 text-primary-accent-text" />
      <span className="min-w-0 flex-1">{children}</span>
      <button type="button" aria-label="Dismiss" onClick={onDismiss} className="grid size-6 place-items-center rounded-full text-muted-foreground hover:bg-foreground/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
        <X className="size-3.5" />
      </button>
    </div>
  );
}

/** "20 rows arrived from Smart Capture — 3 need a check before import." */
function handoffNoticeText(rows: ReconRow[]): string {
  const included = rows.filter((r) => r.include);
  const toCheck = included.filter((r) => !isComplete(r) || openIssues(r).length > 0).length;
  return `${included.length} row${included.length === 1 ? "" : "s"} arrived from Smart Capture${toCheck > 0 ? ` — ${toCheck} need${toCheck === 1 ? "s" : ""} a check before import` : ", all read clearly"}.`;
}

/**
 * One compact line above the statement table: the review summary AND the focus filters in a single control, so the
 * counts and the filter can never disagree (both come from the same `filterOf`). Captured is every captured row;
 * the rest are the live match / decision states.
 */
function ReviewFilterStrip({ filter, onFilter, captured, counts, checking }: { filter: ReconFilter; onFilter: (f: ReconFilter) => void; captured: number; counts: Record<ReconFilter, number>; checking: boolean }) {
  const items: { key: ReconFilter; label: string; value: number; testId: string }[] = [
    { key: "all", label: "All", value: captured, testId: "rf-all" },
    { key: "duplicate", label: "Possible duplicates", value: counts.duplicate, testId: "rf-duplicate" },
    { key: "fix", label: "Fix required", value: counts.fix, testId: "rf-fix" },
    { key: "ready", label: "Ready", value: counts.ready, testId: "rf-ready" },
    { key: "skipped", label: "Skipped", value: counts.skipped, testId: "rf-skipped" },
  ];
  return (
    <div role="group" aria-label="Review summary and filter" data-testid="review-filter-strip" className="flex shrink-0 flex-wrap items-center gap-1 px-0.5 text-xs">
      <span className="mr-1 text-[11px] text-muted-foreground">
        Captured <span className="font-semibold text-foreground tabular-nums" data-testid="rf-captured">{captured}</span>
      </span>
      {items.map((i) => (
        <button
          key={i.key}
          type="button"
          aria-pressed={filter === i.key}
          onClick={() => onFilter(filter === i.key && i.key !== "all" ? "all" : i.key)}
          data-testid={i.testId}
          className={cn(
            "inline-flex h-6 items-center gap-1.5 rounded-md border px-2 font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
            filter === i.key ? "border-foreground bg-foreground text-background" : "border-border-strong/60 bg-card text-foreground/80 hover:bg-muted",
          )}
        >
          {i.label}
          <span className={cn("tabular-nums", filter === i.key ? "text-background/80" : "text-muted-foreground")} data-testid={`${i.testId}-count`}>
            {i.key === "all" || !checking ? i.value : "…"}
          </span>
        </button>
      ))}
    </div>
  );
}
