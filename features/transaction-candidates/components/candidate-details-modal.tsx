"use client";

/**
 * The "Transaction Details" popup for a single SMS candidate — laid out like the
 * Add Expense / Add Income drawer (`TransactionDetailsModal`): a single column of
 * flat sections (Details, Paid from / Received in, People & split, Notes & options)
 * built from the same `transaction-form-ui` primitives, a read-only amount hero,
 * and a "Still needed" bar above the footer. Category/account are picked inline
 * and Import commits in one step. SMS-derived fields (merchant, date, bank,
 * reference, ...) are shown read-only.
 *
 * The candidate document itself is never edited — only `importCandidate`
 * (create the real Transaction, then delete the candidate) and
 * `ignoreCandidate` (delete only) are ever called, exactly the two existing,
 * already-tested write paths every other SMS candidate surface uses. See
 * `sms-transaction-candidate.ts`'s module doc for why: this collection is
 * Android-owned and web-writable only via full delete.
 */

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import {
  AlertTriangle,
  CalendarDays,
  ArrowDownToLine,
  Check,
  CreditCard,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Info,
  Landmark,
  Loader2,
  MessageSquareText,
  Lock,
  NotebookPen,
  Plus,
  Save,
  Shapes,
  SlidersHorizontal,
  SplitSquareHorizontal,
  Trash2,
  UserPlus,
  Users,
  Wallet,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  TXN_KIND_HERO,
  TXN_KIND_META,
  TXN_KIND_SOLID,
  TXN_KIND_TEXT,
  TXN_KIND_WASH,
  TxnFieldRow,
  TxnSection,
  type TxnFormKind,
} from "@/features/transactions/components/transaction-form-ui";
import { focusInvalidField, type TxnFormField } from "@/features/transactions/lib/focus-invalid-field";
import { BankLogo } from "@/components/finance/bank-logo";
import { categoryIconFor } from "@/features/transactions/hooks/use-transactions-data";
import { WS_FIELD, WS_GHOST, WS_PRIMARY, WS_SELECT_TRIGGER } from "@/features/people/components/workspace/person-workspace-ui";
import { cn } from "@/lib/utils";
import { formatCurrencyExact, formatCurrencyPrecise } from "@/lib/format";
import { toast } from "@/store/toast-store";
import { DuplicateWarningDialog } from "@/lib/services/duplicate-detection/duplicate-warning-dialog";
import type { DuplicateDetectionResult, ExistingTransactionForDuplicateCheck } from "@/lib/services/duplicate-detection/duplicate-detection-service";
import type { Account } from "@/lib/models/account";
import type { Category } from "@/lib/models/category";
import type { CreditCardProfile } from "@/lib/models/credit-card";
import type { SplitType } from "@/lib/models/expense";
import type { Person } from "@/lib/models/person";
import type { Transaction } from "@/lib/models/transaction";
import type { ExpenseParticipantInput, ExpenseRepository } from "@/lib/repositories/expense-repository";
import type { SmsTransactionCandidateRepository } from "@/lib/repositories/sms-transaction-candidate-repository";
import type { TransactionRepository } from "@/lib/repositories/transaction-repository";
import { smsCandidateEventTypeLabel, type SmsTransactionCandidate } from "@/lib/models/sms-transaction-candidate";
import {
  candidateDestinationState,
  candidateLastFourSuggestions,
  explainAccountMatch,
  formatMatchedAccountLabel,
  formatUnresolvedAccountHint,
  resolveCandidateDestinationKey,
  resolveMatchedIdentity,
} from "../lib/candidate-account-matching";
import {
  buildDestinationOptions,
  categoryOptionsForDirection,
  importBlockedReason,
  importFieldErrors,
  initialImportDraft,
  isDraftDirty,
  isImportReady,
  isSplitReady,
  looksLikeRawReference,
  resolveImportDestination,
  type CandidateImportDraft,
} from "../lib/candidate-details-view";
import type { CandidateDuplicateResult } from "../lib/candidate-duplicate";
import { scheduleDelayedDismiss } from "../lib/delayed-dismiss";
import { ignoreCandidate, importCandidate, type CandidatePersonAssignment } from "../lib/import-candidate";
import { deriveCandidateStatus } from "../lib/candidate-status";
import type { CategorySuggestion } from "../lib/category-suggestions";
import { buildDuplicateComparison } from "../lib/duplicate-comparison";
import { describePartialImport, isRollbackIncomplete, type PartialImportNotice } from "../lib/import-messages";
import { DuplicateComparisonCard } from "./duplicate-comparison";
import { CandidateStatusBadge } from "./candidate-status-badge";
import { handleEnterKey, handleModEnterKey } from "@/components/ui/enter-key";

const DATE_DISPLAY_FORMAT = new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric" });
const TIME_DISPLAY_FORMAT = new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", hour12: true });
const SYNCED_DISPLAY_FORMAT = new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true });

/** "21 Oct 2026", plus the time when the candidate carries one (a date-only value sits at local midnight and shows no time). */
function dateAndTime(date: Date): string {
  const hasTime = date.getHours() !== 0 || date.getMinutes() !== 0;
  return hasTime ? `${DATE_DISPLAY_FORMAT.format(date)}, ${TIME_DISPLAY_FORMAT.format(date)}` : DATE_DISPLAY_FORMAT.format(date);
}

/** Same control sizing as the Add Expense form (`TransactionDetailsModal`'s `TXN_FIELD`). */
const TXN_FIELD = cn(WS_FIELD, "h-10 rounded-[8px] bg-card");
const TXN_SELECT_TRIGGER = cn(WS_SELECT_TRIGGER, "h-10 rounded-[8px]");

/** A value taken from the SMS — same locked look the Add form gives a field it won't let you change. */
function ReadOnlyField({ children, title, className }: { children: ReactNode; title?: string; className?: string }) {
  return (
    <div title={title} className={cn("flex h-10 min-w-0 items-center gap-1.5 rounded-[8px] border border-border-strong bg-secondary px-3 text-sm font-medium text-foreground/80", className)}>
      <Lock className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} aria-hidden />
      <span className="truncate">{children}</span>
    </div>
  );
}

const SPLIT_TYPE_OPTIONS: { value: SplitType; label: string }[] = [
  { value: "equal", label: "Split equally" },
  { value: "custom", label: "Custom amounts" },
  { value: "percentage", label: "By percentage" },
];

/** Same draft -> `ImportCandidateParams.personAssignment` mapping `TransactionDetailsModal`'s own
 *  save branch does for a brand-new expense — `null` when nothing was actually configured, so a
 *  plain import (no one assigned) never triggers a wasted `ExpenseRepository` round trip. */
function resolvePersonAssignment(draft: CandidateImportDraft, people: Person[]): CandidatePersonAssignment | null {
  if (draft.splitOpen) {
    const named = draft.participants.filter((p) => p.name.trim() !== "" || p.personId != null);
    if (named.length === 0) return null;
    const participantInputs: ExpenseParticipantInput[] = named.map((p) => ({
      personId: p.personId,
      name: p.personId ? (people.find((person) => person.id === p.personId)?.name ?? p.name) : p.name,
      value: draft.splitType === "equal" ? null : Number(p.value),
    }));
    return { kind: "split", splitType: draft.splitType, participantInputs };
  }
  if (draft.personId == null) return null;
  const personName = people.find((p) => p.id === draft.personId)?.name ?? "";
  return { kind: "assign", personId: draft.personId, personName, owesPersonToggle: draft.owesPersonToggle };
}

export function CandidateDetailsModal({
  candidate,
  onOpenChange,
  duplicate,
  matchedTransaction,
  existingTransactions,
  accounts,
  creditCards,
  categories,
  people,
  transactionRepository,
  candidateRepository,
  expenseRepository,
  onCreatePerson,
  onHide,
  onUnhide,
  navigation,
  categorySuggestions = [],
  onImported,
  onPartialImport,
}: {
  candidate: SmsTransactionCandidate | null;
  onOpenChange: (open: boolean) => void;
  /** Precomputed list-level flag, used only for the informational preview banner below — the actual import gate re-checks freshly against `existingTransactions` at the moment of import (see `handleImport`), not this snapshot. */
  duplicate: CandidateDuplicateResult | null;
  /** The live `transactions/{duplicate.duplicateOfTransactionId}` doc, when resolved — `null` if there's no duplicate or it hasn't loaded yet. */
  matchedTransaction: Transaction | null;
  /** Every already-loaded existing transaction (manual entry, PDF import, and prior SMS imports alike — source-agnostic) — passed straight through to `importCandidate`'s own duplicate gate. */
  existingTransactions: ExistingTransactionForDuplicateCheck[];
  accounts: Account[];
  creditCards: CreditCardProfile[];
  categories: Category[];
  people: Person[];
  transactionRepository: TransactionRepository;
  candidateRepository: SmsTransactionCandidateRepository;
  expenseRepository: ExpenseRepository;
  onCreatePerson: (name: string) => Promise<Person>;
  /** Hides this candidate from every list view right away, before the real delayed delete runs. */
  onHide: (candidateId: string) => void;
  /** Restores visibility — called when the toast's Undo is clicked, or if the delayed delete itself fails. */
  onUnhide: (candidateId: string) => void;
  /**
   * Position in the list the reviewer is looking at, and where the arrows go. Absent when the open candidate isn't in the
   * visible list. Moving never writes anything; `advanceToId` is only used by "Import & next", after a successful import.
   */
  navigation?: {
    index: number;
    total: number;
    prevId: string | null;
    nextId: string | null;
    advanceToId: string | null;
    onGoTo: (candidateId: string) => void;
  };
  /** Categories the user already used for this merchant — offered as suggestions only, never applied automatically. */
  categorySuggestions?: CategorySuggestion[];
  /** The transaction now exists (a clean import, or one that needs attention) — feeds the session's "handled" count. */
  onImported?: (candidateId: string) => void;
  /** The transaction exists but a follow-up step didn't finish — the workspace keeps showing this until it's closed. */
  onPartialImport?: (notice: PartialImportNotice) => void;
}) {
  // Never `null` — unlike `TransactionManageModal`'s own `draft`, this one is read unconditionally
  // in the very first render pass below (see the reset block right after `open`), and a `null`
  // starting value used to force a `return null` bailout on every fresh candidate open until the
  // render-phase `setDraft` call below caught up on the *next* render. That "renders nothing, then
  // immediately re-renders" gap is where the whole popup — including the Import button — could visibly
  // fail to appear for a candidate, especially on the first click after a parent re-render. Seeding
  // with an empty-but-valid draft (never dereferenced before the reset block replaces it with the
  // real one) means the shell — and its footer — always renders on the very first pass.
  const [draft, setDraft] = useState<CandidateImportDraft>({
    categoryId: null,
    destinationKey: null,
    notes: "",
    personId: null,
    owesPersonToggle: false,
    splitOpen: false,
    splitType: "equal",
    participants: [{ personId: null, name: "", value: "" }],
  });
  const [pendingDuplicate, setPendingDuplicate] = useState<DuplicateDetectionResult | null>(null);
  const [importing, setImporting] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const [confirmDismissOpen, setConfirmDismissOpen] = useState(false);
  const [addingPerson, setAddingPerson] = useState(false);
  const [newPersonName, setNewPersonName] = useState("");
  const [addingPersonBusy, setAddingPersonBusy] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  // Inline validation only appears once the reviewer actually tries to import (never as a wall of red on open).
  const [showErrors, setShowErrors] = useState(false);
  // The draft as it was seeded for this candidate — what "unsaved edits" is measured against.
  const [initialDraft, setInitialDraft] = useState<CandidateImportDraft | null>(null);
  // A move to another candidate that is waiting for the reviewer to decide what to do with their edits.
  const [pendingGoTo, setPendingGoTo] = useState<string | null>(null);
  // `true` once the transaction exists (a partial import): the form is locked so nothing can be imported a second time.
  const [committed, setCommitted] = useState(false);
  const [partial, setPartial] = useState<PartialImportNotice | null>(null);
  // Whether the import that is waiting behind the duplicate warning was "Import & next".
  const [pendingAdvance, setPendingAdvance] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  // The id of the candidate the drawer is showing RIGHT NOW. An import finishes asynchronously — after the candidate's deletion
  // has already reached the list — so by the time it wants to close the drawer the reviewer may have opened the NEXT candidate;
  // closing then would dismiss the wrong one. See `handleImport`.
  const shownIdRef = useRef<string | null>(null);
  useEffect(() => {
    shownIdRef.current = candidate?.id ?? null;
  }, [candidate?.id]);
  // Same "reset once per open/candidate change" pattern `TransactionManageModal` uses for its own
  // draft — so switching to a different candidate (or reopening the same one) never resurrects a
  // previous, abandoned edit.
  const [draftSessionCandidateId, setDraftSessionCandidateId] = useState<string | null>(null);

  const open = candidate != null;

  if (open && candidate && draftSessionCandidateId !== candidate.id) {
    setDraftSessionCandidateId(candidate.id);
    const seeded = initialImportDraft(candidate, accounts, creditCards);
    setDraft(seeded);
    setInitialDraft(seeded);
    setShowErrors(false);
    setPendingGoTo(null);
    setCommitted(false);
    setPartial(null);
    setPendingAdvance(false);
    setPendingDuplicate(null);
    setConfirmDismissOpen(false);
    setDismissing(false);
    setMoreOpen(false);
    setAddingPerson(false);
  } else if (!open && draftSessionCandidateId !== null) {
    setDraftSessionCandidateId(null);
  }

  if (!candidate) return null;

  const currentCandidate = candidate;
  const currentDraft = draft;

  const destinationOptions = buildDestinationOptions(accounts, creditCards);
  const matchedAccountLabel = formatMatchedAccountLabel(currentCandidate, accounts, creditCards);
  const matchedIdentity = resolveMatchedIdentity(currentCandidate, accounts, creditCards);
  const destinationState = candidateDestinationState(currentCandidate, accounts, creditCards);
  const matchedDestinationKey = resolveCandidateDestinationKey(currentCandidate, accounts, creditCards);
  const unresolvedHint = formatUnresolvedAccountHint(currentCandidate, destinationState);
  const categoryOptions = categoryOptionsForDirection(categories, currentCandidate.direction);
  const isDuplicate = duplicate?.duplicateOfTransactionId != null;
  const ready = isImportReady(currentDraft);
  const blockedReason = importBlockedReason(currentDraft);
  const statusInfo = deriveCandidateStatus(currentCandidate, duplicate, destinationState);
  const errors = showErrors ? importFieldErrors(currentDraft, destinationState) : {};
  const dirty = !committed && initialDraft != null && isDraftDirty(currentDraft, initialDraft);
  // Evidence for the account section. It describes the reviewer's CURRENT choice and Android's own match; it never selects anything.
  const matchEvidence = explainAccountMatch(currentCandidate, currentDraft.destinationKey, accounts, creditCards);
  const lastFourOptions = candidateLastFourSuggestions(currentCandidate, accounts, creditCards).filter((o) => o.key !== currentDraft.destinationKey);
  const comparison =
    isDuplicate && matchedTransaction && duplicate
      ? buildDuplicateComparison({
          candidate: currentCandidate,
          candidateAccountKey: currentDraft.destinationKey ?? matchedDestinationKey,
          existing: matchedTransaction,
          duplicate,
          accounts,
          creditCards,
        })
      : null;

  /**
   * `force` is only ever `true` when re-invoked from the `DuplicateWarningDialog`'s "Import anyway"
   * button below — the normal button click always runs the fresh check first. `importCandidate`
   * itself performs the actual (re-)check against `existingTransactions` immediately before writing
   * anything, so this never relies solely on the `duplicate` prop computed earlier for the banner.
   */
  async function handleImport(force = false, advance = false) {
    if (importing || committed || (!force && !ready)) return;
    // Where "Import & next" lands, captured BEFORE the write: once the candidate is deleted the list no longer contains it.
    const advanceId = advance ? (navigation?.advanceToId ?? null) : null;
    const importedId = currentCandidate.id;
    const { accountId, matchedCard } = resolveImportDestination(currentDraft.destinationKey, creditCards);
    // Person/split assignment only ever applies to expenses (a debit candidate) — same rule
    // `TransactionDetailsModal`'s own People & Split card enforces for a plain "income" kind.
    const personAssignment = currentCandidate.direction === "debit" ? resolvePersonAssignment(currentDraft, people) : null;
    setImporting(true);
    const result = await importCandidate(
      {
        candidate: currentCandidate,
        accountId,
        matchedCard,
        categoryId: currentDraft.categoryId,
        notes: currentDraft.notes,
        personAssignment,
        existingTransactions,
        skipDuplicateCheck: force,
      },
      transactionRepository,
      candidateRepository,
      expenseRepository,
    );
    setImporting(false);

    if (result.status === "duplicate_detected") {
      setPendingDuplicate(result.result);
      setPendingAdvance(advance);
      return;
    }
    setPendingDuplicate(null);
    setPendingAdvance(false);

    if (result.status === "success" || result.status === "already_imported") {
      if (result.status === "success") {
        toast.success("Imported", `${currentCandidate.merchant ?? currentCandidate.bankName ?? "Transaction"} — ${formatCurrencyPrecise(currentCandidate.amount)}`);
      } else {
        toast.info(
          "Already imported",
          result.changed
            ? "This message was imported before and that transaction has since been edited, so nothing new was created. It's been removed from the queue."
            : "This message was already imported, so nothing new was created. It's been removed from the queue — open the transaction to adjust its person or split.",
        );
      }
      onImported?.(currentCandidate.id);
      // "Import & next" moves on ONLY here, after a successful import — every other outcome leaves the reviewer on this candidate.
      if (advanceId) navigation?.onGoTo(advanceId);
      // Close only if the drawer still shows the candidate that was just imported (or nothing): never a different one opened meanwhile.
      else if (shownIdRef.current === importedId || shownIdRef.current == null) onOpenChange(false);
    } else if (result.status === "validation_failed") {
      toast.error("Can't import yet", result.reason);
    } else if (result.status === "transaction_create_failed") {
      toast.error("Import failed", "The transaction couldn't be created — this candidate is still pending, try again.");
    } else {
      // imported_not_deleted: the transaction EXISTS. Say so persistently (no toast, no raw error text), lock the form so it can't
      // be imported twice, and keep the drawer open on the explanation.
      const notice: PartialImportNotice = {
        id: currentCandidate.id,
        merchant: currentCandidate.merchant ?? currentCandidate.bankName ?? "This transaction",
        amountText: formatCurrencyExact(currentCandidate.amount),
        failedStep: result.failedStep,
        peopleRequested: personAssignment != null,
        reusedExisting: result.reusedExisting === true,
        rollbackIncomplete: isRollbackIncomplete(result.error),
      };
      setPartial(notice);
      setCommitted(true);
      onImported?.(currentCandidate.id);
      onPartialImport?.(notice);
    }
  }

  async function handleAddPerson() {
    if (!newPersonName.trim()) return;
    setAddingPersonBusy(true);
    try {
      const person = await onCreatePerson(newPersonName.trim());
      setDraft({ ...currentDraft, personId: person.id });
      setAddingPerson(false);
      setNewPersonName("");
    } catch (e) {
      toast.error("Couldn't add person", e instanceof Error ? e.message : undefined);
    } finally {
      setAddingPersonBusy(false);
    }
  }

  function updateParticipant(index: number, patch: Partial<CandidateImportDraft["participants"][number]>) {
    setDraft({ ...currentDraft, participants: currentDraft.participants.map((p, i) => (i === index ? { ...p, ...patch } : p)) });
  }
  function addParticipantRow() {
    setDraft({ ...currentDraft, participants: [...currentDraft.participants, { personId: null, name: "", value: "" }] });
  }
  function removeParticipantRow(index: number) {
    setDraft({ ...currentDraft, participants: currentDraft.participants.filter((_, i) => i !== index) });
  }

  /**
   * Same delayed "Dismiss with Undo" as the list's `IgnoreCandidateButton` (`scheduleDelayedDismiss`):
   * hides the candidate right away, deletes only after the undo window, and the toast's Undo cancels it.
   * `dismissing` guards against scheduling a second dismissal (e.g. a repeated Enter) for this open.
   */
  function handleDismiss() {
    if (dismissing) return;
    setDismissing(true);
    const { cancel } = scheduleDelayedDismiss({
      candidateId: currentCandidate.id,
      hide: onHide,
      unhide: onUnhide,
      commitDelete: () => ignoreCandidate(currentCandidate, candidateRepository),
      onDeleteFailed: (error) => {
        toast.error("Couldn't dismiss this candidate", error instanceof Error ? error.message : undefined);
      },
    });
    toast.success("Candidate dismissed", `${currentCandidate.merchant ?? currentCandidate.bankName ?? "Transaction"} won't show in the review queue.`, {
      label: "Undo",
      onClick: cancel,
    });
    setConfirmDismissOpen(false);
    onOpenChange(false);
  }

  /**
   * Import button / Ctrl+Enter. With a complete form it imports; with an incomplete one it writes NOTHING — it shows the inline
   * errors and moves focus to the first problem field.
   */
  function attemptImport(advance = false) {
    if (importing || dismissing || committed) return;
    if (!ready) {
      setShowErrors(true);
      const fieldErrors = importFieldErrors(currentDraft, destinationState);
      const first = (["category", "account", "split"] as const).find((f) => fieldErrors[f]);
      if (first) focusInvalidField(bodyRef.current, first);
      return;
    }
    void handleImport(false, advance);
  }

  /** Previous / next. Unsaved edits are never discarded silently: a dirty draft asks first. Moving never writes anything. */
  function requestGoTo(candidateId: string | null) {
    if (!candidateId || !navigation || importing || dismissing) return;
    if (dirty) {
      setPendingGoTo(candidateId);
      return;
    }
    navigation.onGoTo(candidateId);
  }

  /** J / K = next / previous, only when no field or menu has focus and no modifier is held. Navigation only — never imports. */
  function handleNavKey(e: ReactKeyboardEvent<HTMLElement>) {
    if (!navigation || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    if (e.key !== "j" && e.key !== "k") return;
    const target = e.target as HTMLElement;
    if (!e.currentTarget.contains(target)) return;
    if (target.closest('input, textarea, select, [contenteditable="true"], [role="combobox"], [role="listbox"], [role="option"], [role="menu"], [role="switch"], [role="checkbox"]')) return;
    e.preventDefault();
    requestGoTo(e.key === "j" ? navigation.nextId : navigation.prevId);
  }

  const kind: TxnFormKind = currentCandidate.direction === "credit" ? "income" : "expense";
  const KindIcon = TXN_KIND_META[kind].icon;
  const isExpense = kind === "expense";
  const sign = isExpense ? "−" : "+";
  const requiredChecks: { field: TxnFormField; label: string; done: boolean }[] = [
    { field: "category", label: "Category", done: currentDraft.categoryId != null },
    { field: "account", label: "Account", done: currentDraft.destinationKey != null },
    ...(currentDraft.splitOpen ? [{ field: "split" as const, label: "Split", done: isSplitReady(currentDraft) }] : []),
  ];
  const pendingChecks = requiredChecks.filter((c) => !c.done);

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => !(importing || dismissing) && onOpenChange(next)}>
        <DialogContent
          showCloseButton={false}
          // Same light scrim + right-side drawer as the Add Expense form — the page behind stays in context.
          overlayClassName="bg-black/20 backdrop-blur-none dark:bg-black/45"
          onKeyDown={(e) => {
            handleModEnterKey(e, () => attemptImport(false), { enabled: !importing && !dismissing && !committed });
            handleNavKey(e);
          }}
          className="top-0 right-0 left-auto flex h-dvh max-h-dvh w-full max-w-full translate-x-0 translate-y-0 flex-col gap-0 overflow-visible rounded-none border-0 border-l border-border-strong bg-card p-0 shadow-[-24px_0_60px_-20px_rgba(0,0,0,0.45)] duration-300 ease-out sm:max-w-[560px] sm:rounded-l-[16px] data-open:slide-in-from-right data-closed:slide-out-to-right data-closed:duration-200"
        >
          <div className={cn("h-1 w-full shrink-0 sm:rounded-tl-[16px]", TXN_KIND_SOLID[kind].split(" ")[0])} />

          <div className={cn("flex shrink-0 items-center justify-between gap-3 bg-gradient-to-b to-transparent px-4 pt-4 pb-2 sm:px-6", TXN_KIND_WASH[kind])}>
            <div className="flex min-w-0 items-center gap-3">
              <span className={cn("hidden size-10 shrink-0 items-center justify-center rounded-[10px] shadow-[0_6px_14px_-6px_rgba(0,0,0,0.35)] sm:flex", TXN_KIND_SOLID[kind])}>
                <KindIcon className="size-[18px]" strokeWidth={2.25} aria-hidden />
              </span>
              <div className="min-w-0">
                <DialogTitle className="truncate font-heading text-base leading-tight font-semibold tracking-tight text-foreground">Transaction Details</DialogTitle>
                <DialogDescription className="truncate text-xs text-foreground/70">
                  SMS-detected {isExpense ? "expense" : "income"} · {DATE_DISPLAY_FORMAT.format(currentCandidate.transactionDate)} · {matchedAccountLabel ?? unresolvedHint}
                </DialogDescription>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {navigation && (
                <div className="flex items-center gap-0.5" role="group" aria-label="Move between candidates">
                  <button
                    type="button"
                    aria-label="Previous candidate"
                    disabled={!navigation.prevId || importing || dismissing}
                    onClick={() => requestGoTo(navigation.prevId)}
                    className="flex size-11 items-center justify-center rounded-[8px] text-foreground hover:bg-secondary disabled:opacity-40 lg:size-9 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  >
                    <ChevronLeft className="size-4" aria-hidden />
                  </button>
                  <span data-testid="candidate-position" aria-live="polite" className="min-w-[4.25rem] text-center text-xs font-semibold text-foreground tabular-nums">
                    {navigation.index + 1} of {navigation.total}
                  </span>
                  <button
                    type="button"
                    aria-label="Next candidate"
                    disabled={!navigation.nextId || importing || dismissing}
                    onClick={() => requestGoTo(navigation.nextId)}
                    className="flex size-11 items-center justify-center rounded-[8px] text-foreground hover:bg-secondary disabled:opacity-40 lg:size-9 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  >
                    <ChevronRight className="size-4" aria-hidden />
                  </button>
                </div>
              )}
              <kbd
                className="hidden h-6 items-center gap-1 rounded-[5px] border border-border bg-card/80 px-1.5 font-mono text-[10px] font-semibold text-foreground/75 shadow-[0_1px_0_var(--color-border)] lg:inline-flex"
                title="Ctrl/⌘ + Enter: import"
              >
                Ctrl ↵
              </kbd>
              {currentCandidate.referenceNumber && (
                <Badge variant="outline" className="hidden font-mono text-[10px] xl:inline-flex">
                  {currentCandidate.referenceNumber}
                </Badge>
              )}
              <Button variant="ghost" size="icon-sm" className="size-11 lg:size-9" aria-label="Close" onClick={() => onOpenChange(false)} disabled={importing || dismissing}>
                <X className="size-4" />
              </Button>
            </div>
          </div>

          {/* `key`: a fresh form (and scroll position) for each candidate — Radix Select otherwise keeps showing the previous candidate's chosen value. */}
          <div key={currentCandidate.id} ref={bodyRef} className="flex min-h-0 flex-1 flex-col divide-y divide-border overflow-x-hidden overflow-y-auto overscroll-contain scroll-smooth scroll-pt-4 scroll-pb-28">
            {partial && (
              <div role="alert" data-testid="drawer-partial-notice" className="mx-4 mt-3 flex flex-col gap-2 rounded-[12px] border border-warning/70 bg-warning/12 p-3 text-sm text-foreground sm:mx-6">
                <p className="flex items-start gap-2 font-bold">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
                  {describePartialImport(partial).title}
                </p>
                <ul className="list-disc space-y-0.5 pl-9 text-[13px] text-foreground/90">
                  {describePartialImport(partial).facts.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
                <p className="pl-6 text-[13px] font-semibold">What to do</p>
                <ol className="list-decimal space-y-0.5 pl-10 text-[13px] text-foreground/90">
                  {describePartialImport(partial).steps.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>
                <p className="pl-6 text-[12px] text-foreground/75">This notice stays on the list page until you close it.</p>
              </div>
            )}

            <div className="flex flex-col gap-2.5 px-4 pt-3 pb-4 sm:px-6">
              {/* Compact hero: merchant, read-only amount, status and the SMS facts in one card. */}
              <div className={cn("relative flex flex-col gap-2 overflow-hidden rounded-[14px] border border-border px-4 py-3", TXN_KIND_HERO[kind])}>
                <KindIcon aria-hidden strokeWidth={1.5} className={cn("pointer-events-none absolute -right-3 -bottom-5 size-24 opacity-[0.07]", TXN_KIND_TEXT[kind])} />
                <div className="relative flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex items-center gap-1.5 text-[11px] font-bold tracking-[0.1em] text-foreground/70 uppercase">
                      <MessageSquareText className="size-3" aria-hidden /> From your SMS
                    </p>
                    <p className="truncate text-[15px] font-semibold text-foreground" title={currentCandidate.merchant ?? undefined}>
                      {currentCandidate.merchant ?? currentCandidate.bankName ?? "SMS transaction"}
                    </p>
                  </div>
                  <CandidateStatusBadge candidate={currentCandidate} duplicate={duplicate} destinationState={destinationState} compact className="shrink-0" />
                </div>
                <div className="relative flex items-baseline gap-1.5">
                  <span
                    aria-label={`${isExpense ? "Debit" : "Credit"} ${sign}${formatCurrencyPrecise(currentCandidate.amount)}`}
                    className={cn("font-heading text-[36px] leading-none font-bold tracking-tight whitespace-nowrap tabular-nums", TXN_KIND_TEXT[kind])}
                  >
                    {sign}
                    {formatCurrencyPrecise(currentCandidate.amount)}
                  </span>
                  <span aria-hidden className="text-[11px] font-bold tracking-[0.1em] text-foreground/70 uppercase">
                    {isExpense ? "Debit" : "Credit"}
                  </span>
                  <Lock className="size-3 self-center text-foreground/60" strokeWidth={2} aria-label="Read-only — taken from the SMS" />
                </div>
                <div className="relative flex flex-wrap items-center gap-1.5">
                  <span className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5 text-[11px] font-medium text-foreground/85">
                    <CalendarDays className="size-3" aria-hidden /> {dateAndTime(currentCandidate.transactionDate)}
                  </span>
                  {currentCandidate.bankName && (
                    <span className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5 text-[11px] font-medium text-foreground/85">
                      <Landmark className="size-3" aria-hidden /> {currentCandidate.bankName}
                    </span>
                  )}
                  <span className="inline-flex items-center rounded-full border border-border bg-card px-2 py-0.5 text-[11px] font-medium text-foreground/85">
                    {smsCandidateEventTypeLabel(currentCandidate.eventType)}
                  </span>
                  <span className="inline-flex items-center rounded-full border border-border bg-card px-2 py-0.5 text-[11px] font-medium text-foreground/85">{isExpense ? "Debit" : "Credit"}</span>
                </div>
              </div>
              {looksLikeRawReference(currentCandidate.merchant) && (
                <p className="text-[11px] text-foreground/75">
                  The SMS parser couldn&apos;t isolate a merchant name here — Bank, Reference and Confidence under SMS details are the more reliable fields for this one.
                </p>
              )}

              {/* Why this status: the plain-language meaning, then Android's own reasons verbatim. */}
              <div data-testid="status-explanation" className={cn("flex items-start gap-2 rounded-[10px] border border-border bg-secondary/50 px-3 py-2.5 text-xs text-foreground/90", committed && "hidden")}>
                <Info className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <div className="min-w-0 space-y-1">
                  <p>{statusInfo.explanation}</p>
                  {currentCandidate.needsReviewReasons.length > 0 && (
                    <ul className="list-disc space-y-0.5 pl-4 text-foreground/80">
                      {currentCandidate.needsReviewReasons.map((reason) => (
                        <li key={reason}>{reason}</li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>

              {/* Once the transaction exists the 'duplicate' it matches IS that transaction, so the comparison is hidden and the notice above explains. */}
              {isDuplicate &&
                !committed &&
                (comparison ? (
                  <DuplicateComparisonCard comparison={comparison} />
                ) : (
                  <div className="rounded-[12px] border border-warning/60 bg-warning/8 p-3 text-xs text-foreground/90" data-testid="duplicate-comparison">
                    <p className="font-bold uppercase">Possible duplicate</p>
                    <p className="mt-1">{statusInfo.reasons[0] ?? statusInfo.explanation}</p>
                    <p className="mt-1 text-muted-foreground">Importing will re-check this and ask for your confirmation before anything is created.</p>
                  </div>
                ))}
            </div>

            <TxnSection accent={kind} icon={Shapes} title="Details">
              <TxnFieldRow label="Category *" field="category" error={errors.category}>
                <Select value={currentDraft.categoryId ?? undefined} onValueChange={(categoryId) => setDraft({ ...currentDraft, categoryId })}>
                  <SelectTrigger className={TXN_SELECT_TRIGGER} aria-invalid={errors.category ? true : undefined}>
                    <SelectValue placeholder="Select a category" />
                  </SelectTrigger>
                  <SelectContent>
                    {categoryOptions.map((category) => {
                      const CategoryIcon = categoryIconFor(category.iconKey);
                      return (
                        <SelectItem key={category.id} value={category.id}>
                          <span className="flex items-center gap-2">
                            <span className="flex size-6 shrink-0 items-center justify-center rounded-[6px] bg-secondary text-foreground/80">
                              <CategoryIcon className="size-3.5" strokeWidth={2} />
                            </span>
                            {category.name}
                          </span>
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              </TxnFieldRow>
              {categorySuggestions.length > 0 && (
                <div className="flex flex-col gap-1.5" data-testid="category-suggestions">
                  <p className="text-[11px] font-medium text-foreground/75">From your history — suggestions only; nothing is selected for you</p>
                  <div className="flex flex-wrap gap-1.5">
                    {categorySuggestions.map((suggestion) => (
                      <button
                        key={suggestion.categoryId}
                        type="button"
                        aria-pressed={currentDraft.categoryId === suggestion.categoryId}
                        onClick={() => setDraft({ ...currentDraft, categoryId: suggestion.categoryId })}
                        className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-dashed border-border-strong bg-card px-3 text-xs font-semibold text-foreground hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none aria-pressed:border-solid aria-pressed:bg-secondary"
                      >
                        {suggestion.name}
                        <span className="font-normal text-foreground/75">
                          · used {suggestion.count} of {suggestion.total} earlier
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </TxnSection>

            <TxnSection
              accent={kind}
              icon={isExpense ? Wallet : ArrowDownToLine}
              title={isExpense ? "Paid from" : "Received in"}
              aside={
                matchedAccountLabel && currentDraft.destinationKey === matchedDestinationKey ? (
                  <span className="inline-flex items-center gap-1 rounded-full border border-success/50 bg-success/12 px-2 py-0.5 text-[11px] font-semibold text-foreground">
                    <Check className="size-3 text-success" strokeWidth={2.5} aria-hidden /> Matched from SMS
                  </span>
                ) : undefined
              }
            >
              {matchedIdentity && (
                // A VERIFIED match only (Android's id still resolves to a real account) — drawn with the account's own bank logo.
                <div className="flex items-center gap-3 rounded-[10px] border border-border bg-secondary/40 p-2.5" data-testid="matched-identity">
                  <BankLogo bankId={matchedIdentity.bankId} size={36} shape="square" />
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate text-sm font-semibold text-foreground">{matchedIdentity.name}</span>
                    <span className="text-xs text-foreground/75 tabular-nums">
                      {matchedIdentity.kind === "card" ? "Credit card" : "Account"}
                      {matchedIdentity.last4 ? ` •••• ${matchedIdentity.last4}` : ""} · matched by your phone
                    </span>
                  </div>
                </div>
              )}
              <TxnFieldRow label="Account / Card *" field="account" error={errors.account}>
                <Select value={currentDraft.destinationKey ?? undefined} onValueChange={(destinationKey) => setDraft({ ...currentDraft, destinationKey })}>
                  <SelectTrigger className={TXN_SELECT_TRIGGER} aria-invalid={errors.account ? true : undefined}>
                    <SelectValue placeholder="Select an account or card" />
                  </SelectTrigger>
                  <SelectContent>
                    {destinationOptions.map((opt) => {
                      const [destKind, destId] = opt.key.split(":");
                      const account = destKind === "account" ? accounts.find((a) => a.id === destId) : undefined;
                      return (
                        <SelectItem key={opt.key} value={opt.key}>
                          <span className="flex items-center gap-2">
                            {account?.bankId ? (
                              <BankLogo bankId={account.bankId} size={20} />
                            ) : (
                              <span className="flex size-5 shrink-0 items-center justify-center rounded-[5px] bg-secondary text-foreground/80">
                                {destKind === "card" ? <CreditCard className="size-3" /> : <Landmark className="size-3" />}
                              </span>
                            )}
                            {opt.label}
                          </span>
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              </TxnFieldRow>

              {/* Why this account: Android's match, the last-4 check, and — when nothing matched — suggestions the reviewer may pick. */}
              <div data-testid="account-match-evidence" className="flex flex-col gap-1.5 text-[12px] text-foreground/90">
                {matchEvidence.androidLabel ? (
                  matchEvidence.matchesAndroid ? (
                    <p>
                      <span className="font-semibold">Android matched this to {matchEvidence.androidLabel}.</span>
                    </p>
                  ) : (
                    <p>
                      <span className="font-semibold">You changed the account.</span> Android had matched {matchEvidence.androidLabel}.
                    </p>
                  )
                ) : (
                  <p className="flex items-start gap-1.5 rounded-[8px] border border-warning/60 bg-warning/12 px-3 py-2 text-foreground">
                    <AlertTriangle className="mt-px size-3.5 shrink-0 text-warning" aria-hidden />
                    {unresolvedHint} — pick the right one before importing.
                  </p>
                )}
                {matchEvidence.lastFourCheck === "equal" && (
                  <p className="flex items-center gap-1.5">
                    <Check className="size-3.5 shrink-0 text-success" strokeWidth={2.5} aria-hidden />
                    The SMS last-4 •••• {matchEvidence.smsLastFour} equals this account&apos;s last-4.
                  </p>
                )}
                {matchEvidence.lastFourCheck === "different" && (
                  <p className="flex items-start gap-1.5 text-foreground">
                    <AlertTriangle className="mt-px size-3.5 shrink-0 text-warning" aria-hidden />
                    The SMS last-4 •••• {matchEvidence.smsLastFour} is not this account&apos;s last-4 (•••• {matchEvidence.destinationLastFour}). Check you picked the right one.
                  </p>
                )}
                {matchEvidence.lastFourCheck === "destination-has-none" && (
                  <p className="text-foreground/80">The SMS last-4 is •••• {matchEvidence.smsLastFour}, but this account has no last-4 saved, so it can&apos;t be confirmed.</p>
                )}
                {matchEvidence.lastFourCheck === "sms-has-none" && <p className="text-foreground/80">The SMS shows no last-4, so the account can&apos;t be confirmed from the message.</p>}
                {currentCandidate.rawLastFour == null && matchEvidence.androidLabel == null && (
                  <p className="text-foreground/80">With no last-4 in the message, no account is suggested — a bank name alone isn&apos;t enough to pick one.</p>
                )}
                {currentCandidate.rawLastFour != null && lastFourOptions.length > 0 && (
                  <div className="flex flex-col gap-1.5" data-testid="last-four-suggestions">
                    <p className="text-[11px] font-medium text-foreground/75">
                      Accounts and cards ending in •••• {currentCandidate.rawLastFour} — suggestions only; nothing is selected for you
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {lastFourOptions.map((option) => (
                        <button
                          key={option.key}
                          type="button"
                          onClick={() => setDraft({ ...currentDraft, destinationKey: option.key })}
                          className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-dashed border-border-strong bg-card px-3 text-xs font-semibold text-foreground hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                        >
                          Use {option.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {currentCandidate.rawLastFour != null && matchEvidence.androidLabel == null && lastFourOptions.length === 0 && currentDraft.destinationKey == null && (
                  <p className="text-foreground/80">No saved account or card ends in •••• {currentCandidate.rawLastFour}. Choose one yourself.</p>
                )}
              </div>
            </TxnSection>

            {isExpense && (
              <TxnSection
                accent={kind}
                icon={Users}
                title="People & split"
                aside={<span className="text-[11px] font-medium text-foreground/70">Optional · lend, borrow or split</span>}
              >
                <div className="flex flex-col gap-3">
                  <TxnFieldRow label="Assign to a person">
                    {!addingPerson ? (
                      <div className="flex items-center gap-2">
                        <Select
                          value={currentDraft.personId ?? "none"}
                          onValueChange={(v) => {
                            if (v === "add-new") {
                              setAddingPerson(true);
                              return;
                            }
                            setDraft({ ...currentDraft, personId: v === "none" ? null : v, owesPersonToggle: v === "none" ? false : currentDraft.owesPersonToggle });
                          }}
                        >
                          <SelectTrigger className={TXN_SELECT_TRIGGER}>
                            <SelectValue placeholder="No one" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">No one</SelectItem>
                            {people.map((p) => (
                              <SelectItem key={p.id} value={p.id}>
                                {p.name}
                              </SelectItem>
                            ))}
                            <SelectItem value="add-new">
                              <span className="flex items-center gap-1.5">
                                <UserPlus className="size-3.5" /> Add new person
                              </span>
                            </SelectItem>
                          </SelectContent>
                        </Select>
                        {!currentDraft.splitOpen && (
                          <button
                            type="button"
                            onClick={() => setDraft({ ...currentDraft, splitOpen: true })}
                            className="flex h-10 shrink-0 items-center gap-1.5 rounded-[8px] border border-border-strong bg-card px-3 text-xs font-semibold whitespace-nowrap text-foreground transition-colors hover:bg-secondary"
                          >
                            <SplitSquareHorizontal className="size-3.5" strokeWidth={2} />
                            Split with more people
                          </button>
                        )}
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <Input
                          autoFocus
                          placeholder="Person's name"
                          value={newPersonName}
                          className={TXN_FIELD}
                          onChange={(e) => setNewPersonName(e.target.value)}
                          onKeyDown={(e) => {
                            // Enter adds the person — it must not also import the transaction behind this dialog.
                            if (e.key === "Enter") {
                              e.preventDefault();
                              void handleAddPerson();
                            }
                          }}
                        />
                        <Button size="icon-sm" onClick={() => void handleAddPerson()} disabled={addingPersonBusy || !newPersonName.trim()} aria-label="Save person">
                          <Check className="size-4" />
                        </Button>
                        <Button size="icon-sm" variant="ghost" onClick={() => setAddingPerson(false)} aria-label="Cancel">
                          <X className="size-4" />
                        </Button>
                      </div>
                    )}
                  </TxnFieldRow>

                  {currentDraft.personId && !currentDraft.splitOpen && (
                    <label className="flex items-start gap-3 rounded-[10px] border border-border bg-card p-3 text-sm">
                      <Switch
                        checked={currentDraft.owesPersonToggle}
                        onCheckedChange={(checked) => setDraft({ ...currentDraft, owesPersonToggle: checked })}
                        className="mt-0.5"
                      />
                      <span>
                        <span className="block font-semibold text-foreground">This person owes me this expense</span>
                        <span className="block text-[11px] text-foreground/70">Adds this amount to what they owe you.</span>
                      </span>
                    </label>
                  )}

                  {currentDraft.splitOpen && (
                    <div data-field="split" className="flex flex-col gap-3 rounded-[10px] border border-border bg-secondary/40 p-3">
                      <div className="flex items-center justify-between">
                        <p className="text-sm font-semibold text-foreground">Split this expense</p>
                        <button
                          type="button"
                          onClick={() => setDraft({ ...currentDraft, splitOpen: false })}
                          className="flex h-7 items-center gap-1 rounded-[6px] px-2 text-xs font-semibold text-danger transition-colors hover:bg-danger/10"
                        >
                          <X className="size-3.5" /> Remove split
                        </button>
                      </div>
                      <Select value={currentDraft.splitType} onValueChange={(v) => setDraft({ ...currentDraft, splitType: v as SplitType })}>
                        <SelectTrigger className={TXN_SELECT_TRIGGER}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {SPLIT_TYPE_OPTIONS.map((o) => (
                            <SelectItem key={o.value} value={o.value}>
                              {o.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>

                      <div className="flex flex-col gap-2">
                        {currentDraft.participants.map((p, i) => (
                          <div key={i} className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
                            <Select
                              value={p.personId ?? "custom"}
                              onValueChange={(v) => {
                                if (v === "custom") {
                                  updateParticipant(i, { personId: null });
                                  return;
                                }
                                const person = people.find((person) => person.id === v);
                                updateParticipant(i, { personId: v, name: person?.name ?? p.name });
                              }}
                            >
                              <SelectTrigger className={cn(TXN_SELECT_TRIGGER, "w-36 shrink-0")}>
                                <SelectValue placeholder="Person" />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="custom">Custom name</SelectItem>
                                {people.map((person) => (
                                  <SelectItem key={person.id} value={person.id}>
                                    {person.name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            {p.personId == null && (
                              <Input placeholder="Name" value={p.name} className={cn(TXN_FIELD, "min-w-0 flex-1")} onChange={(e) => updateParticipant(i, { name: e.target.value })} />
                            )}
                            {currentDraft.splitType !== "equal" && (
                              <Input
                                type="number"
                                placeholder={currentDraft.splitType === "percentage" ? "%" : "Amount"}
                                value={p.value}
                                className={cn(TXN_FIELD, "w-24 shrink-0")}
                                onChange={(e) => updateParticipant(i, { value: e.target.value })}
                              />
                            )}
                            <button
                              type="button"
                              onClick={() => removeParticipantRow(i)}
                              className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-expense"
                              aria-label="Remove participant"
                            >
                              <Trash2 className="size-3.5" />
                            </button>
                          </div>
                        ))}
                        <Button type="button" variant="ghost" size="sm" onClick={addParticipantRow} className="w-fit gap-1.5">
                          <Plus className="size-3.5" />
                          Add person
                        </Button>
                        {errors.split && (
                          <p role="alert" className="text-[11px] font-medium text-danger">
                            {errors.split}
                          </p>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </TxnSection>
            )}

            <TxnSection accent={kind} icon={NotebookPen} title="Notes & options">
              <Textarea
                value={currentDraft.notes}
                placeholder="Add a note (optional)"
                aria-label="Notes"
                rows={1}
                className={cn(TXN_FIELD, "h-auto min-h-10 resize-y py-2.5")}
                onChange={(e) => setDraft({ ...currentDraft, notes: e.target.value })}
              />

              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  onClick={() => setMoreOpen((v) => !v)}
                  aria-expanded={moreOpen}
                  className={cn(
                    "flex min-h-12 w-full items-center gap-3 rounded-[10px] border px-3 py-2 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    moreOpen ? "border-border-strong bg-secondary/70" : "border-border bg-card hover:border-border-strong hover:bg-secondary/50",
                  )}
                >
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-[8px] bg-secondary text-foreground/80 ring-1 ring-border">
                    <SlidersHorizontal className="size-4" strokeWidth={2} aria-hidden />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="text-sm font-semibold text-foreground">SMS details &amp; evidence</span>
                    <span className="text-[11px] text-foreground/75">original message · bank · reference · last-4 · confidence · reasons</span>
                  </span>
                  <ChevronDown className={cn("size-4 shrink-0 text-foreground/60 transition-transform duration-200", moreOpen && "rotate-180")} strokeWidth={2} />
                </button>

                {moreOpen && (
                  <div className="grid grid-cols-2 gap-2.5 rounded-[10px] border border-border bg-secondary/40 p-3">
                    <div className="col-span-2 flex flex-col gap-1 rounded-[8px] border border-dashed border-border-strong bg-card px-3 py-2.5" data-testid="original-message-unavailable">
                      <p className="text-xs font-bold tracking-wide text-foreground uppercase">Original message unavailable</p>
                      <p className="text-xs text-foreground/85">
                        FlowFi never receives the SMS text — it stays on your phone (open the Android app&apos;s SMS Inbox to read it). Nothing below is the
                        original message; it is what the phone parsed from it.
                      </p>
                    </div>
                    <p className="col-span-2 text-xs font-bold tracking-wide text-foreground/80 uppercase">Parsed evidence</p>
                    <TxnFieldRow label="Bank">
                      <ReadOnlyField title={currentCandidate.bankName ?? undefined}>{currentCandidate.bankName ?? "—"}</ReadOnlyField>
                    </TxnFieldRow>
                    <TxnFieldRow label="Event type">
                      <ReadOnlyField>{smsCandidateEventTypeLabel(currentCandidate.eventType)}</ReadOnlyField>
                    </TxnFieldRow>
                    <TxnFieldRow label="Reference">
                      <ReadOnlyField title={currentCandidate.referenceNumber ?? undefined}>{currentCandidate.referenceNumber ?? "—"}</ReadOnlyField>
                    </TxnFieldRow>
                    <TxnFieldRow label="Raw last 4 (from SMS)">
                      <ReadOnlyField>{currentCandidate.rawLastFour ? `•••• ${currentCandidate.rawLastFour}` : "—"}</ReadOnlyField>
                    </TxnFieldRow>
                    <TxnFieldRow label="Synced from your phone">
                      <ReadOnlyField>{SYNCED_DISPLAY_FORMAT.format(currentCandidate.createdAt)}</ReadOnlyField>
                    </TxnFieldRow>
                    <div className="col-span-2 flex flex-col gap-1.5">
                      <div className="flex items-center justify-between text-xs font-semibold text-foreground/80">
                        <span>Parser confidence</span>
                        <span className="tabular-nums capitalize">
                          {currentCandidate.confidenceLevel} · {Math.round(currentCandidate.confidenceScore * 100)}%
                        </span>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-border-strong/40" role="img" aria-label={`Confidence ${Math.round(currentCandidate.confidenceScore * 100)}%`}>
                        <div
                          className={cn("h-full rounded-full transition-[width]", currentCandidate.confidenceScore >= 0.8 ? "bg-success" : currentCandidate.confidenceScore >= 0.5 ? "bg-warning" : "bg-danger")}
                          style={{ width: `${Math.round(currentCandidate.confidenceScore * 100)}%` }}
                        />
                      </div>
                    </div>
                    <p className="col-span-2 text-[11px] text-foreground/85" data-testid="confidence-explanation">
                      Android scores each message from how well it was parsed, whether an account matched, and whether the transaction type was recognised.{" "}
                      {currentCandidate.confidenceLevel === "high" ? "This one scored high." : currentCandidate.confidenceLevel === "medium" ? "This one scored medium, so Android asks for a look." : "This one scored low, so check every field."}
                    </p>
                    <div className="col-span-2 text-[11px] text-foreground/85">
                      <p className="font-semibold">Android&apos;s reasons</p>
                      {currentCandidate.needsReviewReasons.length > 0 ? (
                        <ul className="list-disc space-y-0.5 pl-4">
                          {currentCandidate.needsReviewReasons.map((reason) => (
                            <li key={reason}>{reason}</li>
                          ))}
                        </ul>
                      ) : (
                        <p>None given.</p>
                      )}
                    </div>
                    <p className="col-span-2 text-[11px] text-foreground/75">
                      Detected from the SMS — these fields (and tags) aren&apos;t editable on an SMS candidate. The original message text stays on your phone: FlowFi never receives or stores it, so it can&apos;t be shown here.
                    </p>
                  </div>
                )}
              </div>
            </TxnSection>
          </div>

          {requiredChecks.length > 0 && !committed && (
            <div className="flex shrink-0 items-center gap-3 border-t border-border bg-secondary/40 px-4 py-2 sm:px-6" aria-live="polite">
              <div className="flex shrink-0 gap-1" aria-hidden>
                {requiredChecks.map((c) => (
                  <span key={c.field} className={cn("h-1.5 w-5 rounded-full transition-colors duration-300", c.done ? TXN_KIND_SOLID[kind].split(" ")[0] : "bg-border-strong/60")} />
                ))}
              </div>
              {pendingChecks.length === 0 ? (
                <p className="flex items-center gap-1.5 text-xs font-semibold text-success">
                  <Check className="size-3.5" strokeWidth={2.5} /> Ready to import — press Ctrl+Enter
                </p>
              ) : (
                <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto [scrollbar-width:none]">
                  <span className="shrink-0 text-xs font-medium text-foreground/70">Still needed:</span>
                  {pendingChecks.map((c) => (
                    <button
                      key={c.field}
                      type="button"
                      tabIndex={-1}
                      onClick={() => focusInvalidField(bodyRef.current, c.field)}
                      className="h-6 shrink-0 rounded-[6px] border border-dashed border-border-strong bg-card px-2 text-[11px] font-semibold text-foreground/85 transition-colors hover:border-solid hover:bg-secondary"
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <DialogFooter className="shrink-0 flex-row flex-wrap items-center justify-between gap-2 border-t border-border bg-card px-4 py-2.5 sm:justify-between sm:rounded-bl-[16px] sm:px-6">
            <div className="order-2 flex min-w-0 items-center gap-2 sm:order-none">
              <Button
                variant="ghost"
                size="sm"
                className="h-11 shrink-0 text-danger hover:bg-danger/10 hover:text-danger lg:h-10"
                onClick={() => setConfirmDismissOpen(true)}
                disabled={importing || dismissing}
              >
                <Trash2 className="size-3.5" /> {committed ? "Remove from queue" : "Dismiss Candidate"}
              </Button>
            </div>
            <div className="order-1 flex basis-full items-center justify-end gap-2 sm:order-none sm:min-w-[13.5rem] sm:flex-1 sm:basis-auto">
              <button type="button" className={cn(WS_GHOST, "h-11 lg:h-10")} onClick={() => onOpenChange(false)} disabled={importing || dismissing}>
                {committed ? "Close" : "Cancel"}
              </button>
              {!committed && (
                <>
                  <button
                    type="button"
                    className={cn(navigation?.advanceToId ? WS_GHOST : WS_PRIMARY, "h-11 min-w-0 rounded-[8px] lg:h-10", navigation?.advanceToId ? "sm:min-w-32" : "flex-1 sm:min-w-40 sm:flex-none", !ready && "opacity-60")}
                    onClick={() => attemptImport(false)}
                    disabled={importing || dismissing}
                    aria-disabled={!ready || undefined}
                    aria-label="Import as Transaction"
                    title={blockedReason ?? undefined}
                  >
                    {importing ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
                    <span className="truncate sm:hidden">Import</span>
                    <span className="hidden truncate sm:inline">Import as Transaction</span>
                  </button>
                  {navigation?.advanceToId && (
                    <button
                      type="button"
                      className={cn(WS_PRIMARY, "h-11 min-w-0 flex-1 rounded-[8px] lg:h-10 sm:min-w-36 sm:flex-none", !ready && "opacity-60")}
                      onClick={() => attemptImport(true)}
                      disabled={importing || dismissing}
                      aria-disabled={!ready || undefined}
                      title={blockedReason ?? undefined}
                    >
                      <span className="truncate">Import &amp; next</span>
                    </button>
                  )}
                </>
              )}
            </div>
          </DialogFooter>
          {navigation && (
            <p className="hidden shrink-0 border-t border-border bg-secondary/40 px-6 py-1 text-[11px] text-foreground/75 md:block">
              <kbd className="font-mono">J</kbd> / <kbd className="font-mono">K</kbd> next / previous · moving never imports anything
            </p>
          )}
        </DialogContent>
      </Dialog>


      <Dialog open={confirmDismissOpen} onOpenChange={setConfirmDismissOpen}>
        <DialogContent onKeyDown={(e) => handleEnterKey(e, handleDismiss, { enabled: !dismissing, fromButtons: true })}>
          <DialogHeader>
            <DialogTitle>Dismiss this candidate?</DialogTitle>
            <DialogDescription>
              &ldquo;{currentCandidate.merchant ?? currentCandidate.bankName ?? "This SMS transaction"}&rdquo; (
              {formatCurrencyPrecise(currentCandidate.amount)}) will be removed from the review queue without creating a transaction. You&apos;ll get a
              few seconds to undo from the confirmation toast.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDismissOpen(false)} disabled={dismissing}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDismiss} disabled={dismissing}>
              {dismissing ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
              Dismiss candidate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={pendingGoTo != null} onOpenChange={(next) => !next && setPendingGoTo(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discard your changes?</DialogTitle>
            <DialogDescription>
              You&apos;ve changed this candidate&apos;s category, account, notes or people. Moving to another candidate discards those edits. Nothing has been imported.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button autoFocus variant="outline" onClick={() => setPendingGoTo(null)}>
              Keep editing
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const target = pendingGoTo;
                setPendingGoTo(null);
                if (target) navigation?.onGoTo(target);
              }}
            >
              Discard and continue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <DuplicateWarningDialog
        open={pendingDuplicate != null}
        onOpenChange={(open) => {
          if (!open) setPendingDuplicate(null);
        }}
        result={pendingDuplicate}
        busy={importing}
        confirmLabel="Import anyway"
        onConfirm={() => void handleImport(true, pendingAdvance)}
      />
    </>
  );
}
