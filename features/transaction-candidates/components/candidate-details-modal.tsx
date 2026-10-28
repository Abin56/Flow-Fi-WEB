"use client";

/**
 * The "Transaction Details" editor for a single SMS candidate, in a full-width sheet that drops down from the top of
 * the viewport (`TransactionSheet`) so the inbox stays visible below it — on every screen size. A sticky top row
 * states the merchant, signed amount, status, source and queue position once; Category · Account · Whose expense
 * share one row on desktop; the person and split editors open inside the sheet only when chosen; Notes, the original
 * SMS, parsing evidence and technical details are small toggles; the sticky footer carries "Still needed" and the
 * actions. Warnings and blockers are never folded away. SMS-derived fields (merchant, date, bank, reference, ...) are
 * shown read-only.
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
  Check,
  CreditCard,
  ChevronRight,
  Hash,
  Landmark,
  Loader2,
  MessageSquareText,
  Lock,
  NotebookPen,
  Plus,
  Save,
  Shapes,
  ShieldCheck,
  SlidersHorizontal,
  SplitSquareHorizontal,
  Trash2,
  User,
  UserPlus,
  Users,
  Wallet,
  X,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  SHEET_AMOUNT_TONE,
  SHEET_BUTTON,
  SHEET_CHIPS,
  SHEET_FIELD,
  SHEET_TRIGGER,
  SheetAvatar,
  SheetChoice,
  SheetDisclosure,
  SheetNav,
  SheetPicker,
  SheetRail,
  SheetRailBlock,
  SheetSection,
  TransactionSheet,
  type SheetPickerOption,
} from "@/components/finance/transaction-sheet";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { TxnFieldRow, type TxnFormKind } from "@/features/transactions/components/transaction-form-ui";
import { focusInvalidField, type TxnFormField } from "@/features/transactions/lib/focus-invalid-field";
import { BankLogo } from "@/components/finance/bank-logo";
import { categoryIconFor } from "@/features/transactions/hooks/use-transactions-data";
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

type Ownership = "mine" | "person" | "split";
const OWNERSHIP_OPTIONS: { value: Ownership; label: string; aria: string; hint: string; icon: LucideIcon }[] = [
  { value: "mine", label: "Mine", aria: "My own expense", hint: "Just my spending", icon: User },
  { value: "person", label: "Someone else's", aria: "Someone else's expense", hint: "Link to a person", icon: Users },
  { value: "split", label: "Split", aria: "Split expense", hint: "Share with people", icon: SplitSquareHorizontal },
];

type PanelId = "notes" | "sms" | "evidence" | "tech";

/** The inline "new person" field the person picker swaps to. Enter adds the person — it must never import the transaction behind it. */
function AddPersonInline({ name, busy, onName, onSave, onCancel }: { name: string; busy: boolean; onName: (v: string) => void; onSave: () => void; onCancel: () => void }) {
  return (
    <div className="flex items-center gap-2">
      <Input
        autoFocus
        placeholder="Person's name"
        value={name}
        className={SHEET_FIELD}
        onChange={(e) => onName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onSave();
          }
        }}
      />
      <Button size="icon-sm" onClick={onSave} disabled={busy || !name.trim()} aria-label="Save person">
        <Check className="size-4" />
      </Button>
      <Button size="icon-sm" variant="ghost" onClick={onCancel} aria-label="Cancel">
        <X className="size-4" />
      </Button>
    </div>
  );
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * A display-only reading of the split being drafted, against the rules `ExpenseRepository` enforces when the import
 * writes it (that stays the authority, and nothing here gates the Import button): custom amounts must add up to the
 * total, percentages to 100%, an equal split divides the total by the people named, and nobody may be listed twice.
 */
export function describeSplitAllocation(
  draft: Pick<CandidateImportDraft, "splitType" | "participants">,
  total: number,
  people: Person[],
): { summary: string; hint: string | null; balanced: boolean | null; duplicate: string | null } {
  const named = draft.participants.filter((p) => p.name.trim() !== "" || p.personId != null);
  const nameOf = (p: CandidateImportDraft["participants"][number]) => (p.personId ? (people.find((x) => x.id === p.personId)?.name ?? p.name) : p.name).trim() || "Someone";
  const seen = new Set<string>();
  let duplicate: string | null = null;
  for (const p of named) {
    const key = p.personId ? `id:${p.personId}` : `name:${p.name.trim().toLowerCase()}`;
    if (seen.has(key)) {
      duplicate = nameOf(p);
      break;
    }
    seen.add(key);
  }
  if (named.length === 0) return { summary: "No one added yet", hint: null, balanced: null, duplicate };
  if (draft.splitType === "equal") {
    return { summary: `${formatCurrencyPrecise(round2(total / named.length))} each · ${named.length} ${named.length === 1 ? "person" : "people"}`, hint: null, balanced: true, duplicate };
  }
  const filled = named.every((p) => p.value.trim() !== "" && Number.isFinite(Number(p.value)));
  const sum = round2(named.reduce((s, p) => s + (Number.isFinite(Number(p.value)) ? Number(p.value) : 0), 0));
  if (draft.splitType === "percentage") {
    const left = round2(100 - sum);
    return {
      summary: left === 0 ? `${sum}% of 100% assigned` : `${sum}% of 100% · ${Math.abs(left)}% ${left > 0 ? "left to assign" : "over"}`,
      hint: filled && left === 0 ? null : "Percentages must add up to 100% — the import checks this.",
      balanced: filled && left === 0,
      duplicate,
    };
  }
  const left = round2(total - sum);
  return {
    summary: left === 0 ? `${formatCurrencyPrecise(sum)} of ${formatCurrencyPrecise(total)} assigned` : `${formatCurrencyPrecise(sum)} of ${formatCurrencyPrecise(total)} · ${formatCurrencyPrecise(Math.abs(left))} ${left > 0 ? "left to assign" : "over"}`,
    hint: filled && left === 0 ? null : "Amounts must add up to the total — the import checks this.",
    balanced: filled && left === 0,
    duplicate,
  };
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
  // View-only: which folded panels are open, and whether "Someone else's" was picked before a person was chosen.
  const [openPanel, setOpenPanel] = useState<PanelId | null>(null);
  const [personMode, setPersonMode] = useState(false);
  // Inline validation only appears once the reviewer actually tries to import (never as a wall of red on open).
  const [showErrors, setShowErrors] = useState(false);
  // The draft as it was seeded for this candidate — what "unsaved edits" is measured against.
  const [initialDraft, setInitialDraft] = useState<CandidateImportDraft | null>(null);
  // A move to another candidate that is waiting for the reviewer to decide what to do with their edits.
  const [pendingGoTo, setPendingGoTo] = useState<string | null>(null);
  // A close that is waiting for the reviewer to decide what to do with their edits.
  const [pendingClose, setPendingClose] = useState(false);
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
    setOpenPanel(null);
    setPendingClose(false);
    setPersonMode(false);
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
      if (result.status === "success" && result.tombstoneMismatched) {
        // Phase F2 (2026-10-24): a concurrent Dismiss (another tab/device) already won the tombstone
        // race — the Transaction above is real and money moved, but the durable record says
        // "dismissed." Tell the user plainly rather than a blanket "Imported" success toast.
        toast.info(
          "Imported, but flagged as dismissed elsewhere",
          `${currentCandidate.merchant ?? currentCandidate.bankName ?? "Transaction"} — ${formatCurrencyPrecise(currentCandidate.amount)} was saved, but this candidate was also dismissed in another tab or device at nearly the same time. The transaction is real; no further action is needed.`,
        );
      } else if (result.status === "success") {
        toast.success("Imported", `${currentCandidate.merchant ?? currentCandidate.bankName ?? "Transaction"} — ${formatCurrencyPrecise(currentCandidate.amount)}`);
      } else {
        toast.info(
          "Already imported",
          result.changed
            ? "This message was imported before and that transaction has since been edited, so nothing new was created. It's been removed from the queue."
            : result.personAssignmentSkipped
              ? "This message was already imported, so nothing new was created and the person/split you chose was NOT applied. It's been removed from the queue — open the transaction to assign or split it."
              : "This message was already imported, so nothing new was created. It's been removed from the queue — open the transaction to adjust its person or split.",
        );
      }
      onImported?.(currentCandidate.id);
      // "Import & next" moves on ONLY here, after a successful import — every other outcome leaves the reviewer on this candidate.
      if (advanceId) navigation?.onGoTo(advanceId);
      // Close only if the drawer still shows the candidate that was just imported (or nothing): never a different one opened meanwhile.
      else if (shownIdRef.current === importedId || shownIdRef.current == null) onOpenChange(false);
    } else if (result.status === "already_dismissed") {
      // Phase F2 (2026-10-24, importAtomically): a concurrent Dismiss (another tab/device) won the
      // race BEFORE this import's money could move — nothing was created, no balance changed, and
      // the candidate is already gone. Tell the user plainly; this is a clean, final outcome, not an
      // error to retry.
      toast.info(
        "Already dismissed elsewhere",
        `${currentCandidate.merchant ?? currentCandidate.bankName ?? "This transaction"} was dismissed in another tab or device before it could be imported — nothing was created.`,
      );
      onImported?.(currentCandidate.id);
      if (advanceId) navigation?.onGoTo(advanceId);
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
      commitDelete: async () => {
        const { tombstoneMismatched } = await ignoreCandidate(currentCandidate, candidateRepository);
        if (tombstoneMismatched) {
          // Phase F2 (2026-10-24): a concurrent Import (another tab/device) already won this race.
          toast.info(
            "Already imported elsewhere",
            `${currentCandidate.merchant ?? currentCandidate.bankName ?? "This transaction"} was imported in another tab or device while you were dismissing it — it wasn't dismissed.`,
          );
        }
      },
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
  const isExpense = kind === "expense";
  const sign = isExpense ? "−" : "+";
  const requiredChecks: { field: TxnFormField; label: string; done: boolean }[] = [
    { field: "category", label: "Category", done: currentDraft.categoryId != null },
    { field: "account", label: "Account", done: currentDraft.destinationKey != null },
    ...(currentDraft.splitOpen ? [{ field: "split" as const, label: "Split", done: isSplitReady(currentDraft) }] : []),
  ];
  const pendingChecks = requiredChecks.filter((c) => !c.done);
  const confidencePct = Math.round(currentCandidate.confidenceScore * 100);
  const accountChosen = currentDraft.destinationKey != null;
  const matchedUnchanged = matchedAccountLabel != null && currentDraft.destinationKey === matchedDestinationKey;
  const busy = importing || dismissing;
  const merchantName = currentCandidate.merchant ?? currentCandidate.bankName ?? "SMS transaction";
  const initials =
    merchantName
      .replace(/[^A-Za-z0-9 ]/g, " ")
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? "")
      .join("") || "₹";

  // Ownership is only a view over the existing draft fields — "Mine" is no person and no split, exactly like "No one" was.
  const ownership: Ownership = currentDraft.splitOpen ? "split" : currentDraft.personId != null || personMode ? "person" : "mine";
  function chooseOwnership(next: Ownership) {
    if (next === ownership) return;
    if (next === "mine") {
      setPersonMode(false);
      setDraft({ ...currentDraft, personId: null, owesPersonToggle: false, splitOpen: false });
    } else if (next === "person") {
      setPersonMode(true);
      setDraft({ ...currentDraft, splitOpen: false });
    } else {
      setDraft({ ...currentDraft, splitOpen: true });
    }
  }
  const allocation = currentDraft.splitOpen ? describeSplitAllocation(currentDraft, currentCandidate.amount, people) : null;

  /** Close (X, Escape, a click outside the sheet, Cancel). Unsaved edits are never discarded silently. Closing never writes. */
  function requestClose() {
    if (busy) return;
    if (dirty) {
      setPendingClose(true);
      return;
    }
    onOpenChange(false);
  }

  // Picker options. Category icons and bank logos make each choice recognisable at a glance.
  const categoryPickerOptions: SheetPickerOption[] = categoryOptions.map((category) => {
    const CategoryIcon = categoryIconFor(category.iconKey);
    return { value: category.id, label: category.name, icon: <CategoryIcon className="size-4" strokeWidth={2} /> };
  });
  const accountPickerOptions: SheetPickerOption[] = destinationOptions.map((opt) => {
    const [destKind, destId] = opt.key.split(":");
    const account = destKind === "account" ? accounts.find((a) => a.id === destId) : undefined;
    return {
      value: opt.key,
      label: opt.label,
      detail: destKind === "card" ? "Credit card" : "Account",
      icon: account?.bankId ? <BankLogo bankId={account.bankId} size={36} shape="square" className="rounded-[inherit]" /> : destKind === "card" ? <CreditCard className="size-4" /> : <Landmark className="size-4" />,
    };
  });
  const personPickerOptions: SheetPickerOption[] = people.map((p) => ({
    value: p.id,
    label: p.name,
    icon: <span className="text-[11px] font-bold text-foreground/75">{p.name.trim().slice(0, 1).toUpperCase() || "?"}</span>,
  }));
  const accountCaption: { text: ReactNode; tone: "success" | "warning" | "muted" } = matchedUnchanged
    ? { text: <span className="inline-flex items-center gap-1"><Check className="size-3" strokeWidth={3} /> Matched by your phone</span>, tone: "success" }
    : matchEvidence.androidLabel && accountChosen
      ? { text: "You changed Android's match", tone: "warning" }
      : accountChosen
        ? { text: "Chosen by you", tone: "muted" }
        : { text: "Required — pick where this was paid", tone: "warning" };
  const evidenceTone = !matchEvidence.androidLabel && !accountChosen ? "warning" : matchEvidence.lastFourCheck === "different" ? "warning" : matchedUnchanged || matchEvidence.lastFourCheck === "equal" ? "success" : "neutral";

  // Secondary account-match lines: always shown while no account is chosen (they guide the choice), folded once one is.
  const secondaryEvidence: ReactNode[] = [];
  if (matchEvidence.lastFourCheck === "destination-has-none")
    secondaryEvidence.push(<p key="dest-none">The SMS last-4 is •••• {matchEvidence.smsLastFour}, but this account has no last-4 saved, so it can&apos;t be confirmed.</p>);
  if (matchEvidence.lastFourCheck === "sms-has-none") secondaryEvidence.push(<p key="sms-none">The SMS shows no last-4, so the account can&apos;t be confirmed from the message.</p>);
  if (currentCandidate.rawLastFour == null && matchEvidence.androidLabel == null)
    secondaryEvidence.push(<p key="bank-only">With no last-4 in the message, no account is suggested — a bank name alone isn&apos;t enough to pick one.</p>);

  const header = (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
      <div className="flex min-w-0 flex-1 basis-72 items-center gap-3.5">
        <SheetAvatar tone={isExpense ? "debit" : "credit"}>{initials}</SheetAvatar>
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-[11px] font-semibold tracking-[0.1em] whitespace-nowrap text-hero-foreground/68 uppercase">
            <span>Transaction Details</span>
            <span aria-hidden>·</span>
            <span className="inline-flex items-center gap-1">
              <MessageSquareText className="size-3" aria-hidden /> SMS
            </span>
          </p>
          <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
            <DialogTitle className="max-w-full truncate font-heading text-[21px] leading-tight font-bold tracking-tight text-hero-foreground" title={currentCandidate.merchant ?? undefined}>
              {merchantName}
            </DialogTitle>
            <span className="shrink-0 rounded-full bg-card">
              <CandidateStatusBadge candidate={currentCandidate} duplicate={duplicate} destinationState={destinationState} compact />
            </span>
          </div>
          <DialogDescription className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3.5 gap-y-1 text-[12.5px] text-hero-foreground/70">
            <span className="inline-flex items-center gap-1.5 tabular-nums">
              <CalendarDays className="size-3.5 text-hero-foreground/68" aria-hidden />
              {dateAndTime(currentCandidate.transactionDate)}
            </span>
            <span>{smsCandidateEventTypeLabel(currentCandidate.eventType)}</span>
            {currentCandidate.bankName && (
              <span className="inline-flex min-w-0 items-center gap-1.5">
                <Landmark className="size-3.5 shrink-0 text-hero-foreground/68" aria-hidden />
                <span className="truncate">{currentCandidate.bankName}</span>
              </span>
            )}
          </DialogDescription>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-5">
        <div className="text-right">
          <p className="flex items-center justify-end gap-1 text-[11px] font-semibold tracking-[0.1em] text-hero-foreground/68 uppercase">
            <span aria-hidden>{isExpense ? "Debit" : "Credit"}</span>
            <Lock className="size-3" strokeWidth={2.25} aria-label="Read-only — taken from the SMS" />
          </p>
          <p
            aria-label={`${isExpense ? "Debit" : "Credit"} ${sign}${formatCurrencyPrecise(currentCandidate.amount)}`}
            className={cn("mt-1 font-heading text-[32px] leading-none font-bold tracking-tight whitespace-nowrap tabular-nums", isExpense ? SHEET_AMOUNT_TONE.debit : SHEET_AMOUNT_TONE.credit)}
          >
            {sign}
            {formatCurrencyPrecise(currentCandidate.amount)}
          </p>
        </div>
        {navigation && (
          <SheetNav
            label="Move between candidates"
            position={`${navigation.index + 1} of ${navigation.total}`}
            positionTestId="candidate-position"
            prevLabel="Previous candidate"
            nextLabel="Next candidate"
            disabled={busy}
            onPrev={navigation.prevId ? () => requestGoTo(navigation.prevId) : undefined}
            onNext={navigation.nextId ? () => requestGoTo(navigation.nextId) : undefined}
          />
        )}
      </div>
    </div>
  );

  const footer = (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5 px-4 py-3 sm:px-6 lg:px-8">
      {!committed && (
        <div className="flex min-w-0 flex-1 basis-64 items-center gap-2" aria-live="polite">
          {pendingChecks.length === 0 ? (
            <p className="flex min-w-0 items-center gap-2 text-[13px] font-semibold text-[oklch(0.44_0.13_149)] dark:text-success">
              <span className="grid size-5 shrink-0 place-items-center rounded-full bg-success text-success-foreground">
                <Check className="size-3" strokeWidth={3} />
              </span>
              <span className="truncate">Ready to import — Ctrl+Enter</span>
            </p>
          ) : (
            <div className="flex min-w-0 items-center gap-1.5 overflow-x-auto [scrollbar-width:none]">
              <span className="shrink-0 text-[12.5px] font-medium text-foreground/72">Still needed:</span>
              {requiredChecks.map((c) =>
                c.done ? (
                  <span key={c.field} className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full bg-success/12 px-2.5 text-[12px] font-semibold text-[oklch(0.44_0.13_149)] dark:text-success">
                    <Check className="size-3" strokeWidth={3} aria-hidden /> {c.label}
                  </span>
                ) : (
                  <button
                    key={c.field}
                    type="button"
                    tabIndex={-1}
                    onClick={() => focusInvalidField(bodyRef.current, c.field)}
                    className="inline-flex h-7 shrink-0 items-center rounded-full border border-dashed border-border-strong bg-card px-2.5 text-[12px] font-semibold text-foreground/80 transition-colors hover:border-solid hover:bg-secondary"
                  >
                    {c.label}
                  </button>
                ),
              )}
            </div>
          )}
          {navigation && (
            <p className="ml-2 hidden shrink-0 text-[11.5px] text-foreground/72 xl:block">
              <kbd className="rounded border border-border bg-secondary px-1 font-mono text-[10.5px]">J</kbd> <kbd className="rounded border border-border-subtle bg-secondary px-1 font-mono text-[10.5px]">K</kbd> move · never imports
            </p>
          )}
        </div>
      )}
      <div className="flex flex-1 basis-full flex-wrap items-center justify-end gap-2 sm:flex-none sm:basis-auto">
        <button type="button" className={cn(SHEET_BUTTON.danger, "mr-auto sm:mr-0")} onClick={() => setConfirmDismissOpen(true)} disabled={busy}>
          <Trash2 className="size-4" /> {committed ? "Remove from queue" : "Dismiss Candidate"}
        </button>
        <button type="button" className={SHEET_BUTTON.ghost} onClick={requestClose} disabled={busy}>
          {committed ? "Close" : "Cancel"}
        </button>
        {!committed && (
          <>
            <button
              type="button"
              className={cn(navigation?.advanceToId ? SHEET_BUTTON.secondary : ready ? SHEET_BUTTON.primary : SHEET_BUTTON.primaryIdle, "min-w-0")}
              onClick={() => attemptImport(false)}
              disabled={busy}
              aria-disabled={!ready || undefined}
              aria-label="Import as Transaction"
              title={blockedReason ?? undefined}
            >
              {importing ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
              <span className="truncate sm:hidden">Import</span>
              <span className="hidden truncate sm:inline">Import as Transaction</span>
            </button>
            {navigation?.advanceToId && (
              <button
                type="button"
                className={cn(ready ? SHEET_BUTTON.primary : SHEET_BUTTON.primaryIdle, "min-w-0 px-5 max-sm:flex-1")}
                onClick={() => attemptImport(true)}
                disabled={busy}
                aria-disabled={!ready || undefined}
                title={blockedReason ?? undefined}
              >
                <span className="truncate">Import &amp; next</span>
                <ChevronRight className="size-4" aria-hidden />
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );

  return (
    <>
      <TransactionSheet
        open={open}
        onRequestClose={requestClose}
        closeDisabled={busy}
        testId="candidate-sheet"
        progress={navigation ? { current: navigation.index + 1, total: navigation.total } : undefined}
        onKeyDown={(e) => {
          handleModEnterKey(e, () => attemptImport(false), { enabled: !busy && !committed });
          handleNavKey(e);
        }}
        header={header}
        footer={footer}
      >
        {/* `key`: a fresh form for each candidate — Radix Select otherwise keeps showing the previous candidate's chosen value. */}
        <div key={currentCandidate.id} ref={bodyRef} className="flex flex-col gap-4 px-4 py-4 sm:px-6 lg:px-8 sm:py-5">
          {partial && (
            <div role="alert" data-testid="drawer-partial-notice" className="flex flex-col gap-2 rounded-2xl border border-warning/70 bg-warning/12 p-4 text-sm text-foreground">
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

          {/* A possible duplicate is the first thing to see — never folded away. */}
          {isDuplicate &&
            !committed &&
            (comparison ? (
              <DuplicateComparisonCard comparison={comparison} />
            ) : (
              <div className="rounded-2xl border border-warning/60 bg-warning/8 p-4 text-xs text-foreground/90" data-testid="duplicate-comparison">
                <p className="font-bold uppercase">Possible duplicate</p>
                <p className="mt-1">{statusInfo.reasons[0] ?? statusInfo.explanation}</p>
                <p className="mt-1 text-muted-foreground">Importing will re-check this and ask for your confirmation before anything is created.</p>
              </div>
            ))}

          {/* Two bands, no dead space: the fields in one row (Category · Paid from · Whose expense), the context beneath. */}
          <div className="flex flex-col gap-5">
            <SheetSection title="Details" hint="Category and account are required">
              <div className={cn("grid items-start gap-x-4 gap-y-3", isExpense ? "md:grid-cols-2 lg:grid-cols-3" : "md:grid-cols-2")}>
              <div className="flex min-w-0 flex-col gap-2">
              <TxnFieldRow label="Category" field="category" error={errors.category}>
                <SheetPicker
                  value={currentDraft.categoryId}
                  onValueChange={(categoryId) => setDraft({ ...currentDraft, categoryId })}
                  options={categoryPickerOptions}
                  placeholder="Select a category"
                  emptyIcon={<Shapes className="size-4" />}
                  caption={currentDraft.categoryId ? (isExpense ? "Expense category" : "Income category") : "Required"}
                  captionTone={currentDraft.categoryId ? "muted" : errors.category ? "danger" : "muted"}
                  invalid={!!errors.category}
                />
              </TxnFieldRow>
              {categorySuggestions.length > 0 && (
                <div className="-mt-1 flex flex-wrap items-center gap-1.5" data-testid="category-suggestions">
                  <p className="basis-full text-[11.5px] font-medium text-foreground/72">From your history — suggestions only; nothing is selected for you</p>
                  {categorySuggestions.map((suggestion) => (
                    <button
                      key={suggestion.categoryId}
                      type="button"
                      aria-pressed={currentDraft.categoryId === suggestion.categoryId}
                      onClick={() => setDraft({ ...currentDraft, categoryId: suggestion.categoryId })}
                      className="inline-flex h-8 items-center gap-1.5 rounded-full border border-dashed border-border-strong bg-card px-3 text-[12px] font-semibold text-foreground transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none aria-pressed:border-solid aria-pressed:border-primary-accent-text/50 aria-pressed:bg-primary/12"
                    >
                      {suggestion.name}
                      <span className="font-normal text-foreground/72">
                        · used {suggestion.count} of {suggestion.total} earlier
                      </span>
                    </button>
                  ))}
                </div>
              )}
              </div>
              <div className="flex min-w-0 flex-col gap-2">
              <TxnFieldRow label={isExpense ? "Paid from" : "Received in"} field="account" error={errors.account}>
                <SheetPicker
                  value={currentDraft.destinationKey}
                  onValueChange={(destinationKey) => setDraft({ ...currentDraft, destinationKey })}
                  options={accountPickerOptions}
                  placeholder="Select an account or card"
                  emptyIcon={<Wallet className="size-4" />}
                  caption={accountCaption.text}
                  captionTone={errors.account ? "danger" : accountCaption.tone}
                  invalid={!!errors.account}
                />
              </TxnFieldRow>
              {currentCandidate.rawLastFour != null && lastFourOptions.length > 0 && (
                <div className="-mt-1 flex flex-wrap items-center gap-1.5" data-testid="last-four-suggestions">
                  <p className="basis-full text-[11.5px] font-medium text-foreground/72">
                    Accounts and cards ending in •••• {currentCandidate.rawLastFour} — suggestions only; nothing is selected for you
                  </p>
                  {lastFourOptions.map((option) => (
                    <button
                      key={option.key}
                      type="button"
                      onClick={() => setDraft({ ...currentDraft, destinationKey: option.key })}
                      className="inline-flex h-8 items-center gap-1.5 rounded-full border border-dashed border-border-strong bg-card px-3 text-[12px] font-semibold text-foreground transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    >
                      Use {option.label}
                    </button>
                  ))}
                </div>
              )}
              </div>
              {isExpense && (
                <div className="flex min-w-0 flex-col gap-1 md:col-span-2 lg:col-span-1">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-xs font-semibold text-foreground/80">Whose expense? (optional)</span>
                    <span className="truncate text-[11.5px] font-medium text-foreground/72" aria-live="polite">
                      {OWNERSHIP_OPTIONS.find((o) => o.value === ownership)?.hint}
                    </span>
                  </div>
                  <SheetChoice label="Whose expense" value={ownership} onChange={chooseOwnership} options={OWNERSHIP_OPTIONS} />
                </div>
              )}
              </div>

                {isExpense && ownership === "person" && (
                  <div className="grid gap-3 rounded-xl border border-border bg-secondary/60 p-3.5 md:grid-cols-2 md:items-end">
                    <TxnFieldRow label="Person">
                      {!addingPerson ? (
                        <SheetPicker
                          value={currentDraft.personId}
                          onValueChange={(v) => {
                            if (v === "add-new") {
                              setAddingPerson(true);
                              return;
                            }
                            setDraft({ ...currentDraft, personId: v });
                          }}
                          options={personPickerOptions}
                          placeholder="Choose a person"
                          emptyIcon={<UserPlus className="size-4" />}
                          caption={currentDraft.personId ? "From your People" : "Nothing is assigned until you choose"}
                          ariaLabel="Assign to a person"
                          extraItems={
                            <SelectItem value="add-new">
                              <span className="flex items-center gap-1.5">
                                <UserPlus className="size-3.5" /> Add new person
                              </span>
                            </SelectItem>
                          }
                        />
                      ) : (
                        <AddPersonInline name={newPersonName} busy={addingPersonBusy} onName={setNewPersonName} onSave={() => void handleAddPerson()} onCancel={() => setAddingPerson(false)} />
                      )}
                    </TxnFieldRow>
                    {currentDraft.personId && (
                      <label className="flex cursor-pointer items-start gap-3 rounded-xl bg-card px-3 py-2.5 shadow-e1">
                        <Switch checked={currentDraft.owesPersonToggle} onCheckedChange={(checked) => setDraft({ ...currentDraft, owesPersonToggle: checked })} className="mt-0.5" />
                        <span className="min-w-0">
                          <span className="block text-[13px] font-semibold text-foreground">This person owes me this expense</span>
                          <span className="block text-[11.5px] text-foreground/72">
                            {currentDraft.owesPersonToggle
                              ? `Adds ${formatCurrencyPrecise(currentCandidate.amount)} to what they owe you.`
                              : "Off: the expense is linked to them, but nothing is added to what they owe you."}
                          </span>
                        </span>
                      </label>
                    )}
                  </div>
                )}

                {isExpense && ownership === "split" && (
                  <div data-field="split" className="flex flex-col gap-3 rounded-xl border border-border bg-secondary/60 p-3.5" aria-label="Split" role="group">
                    <div className="flex flex-wrap items-center gap-2">
                      <Select value={currentDraft.splitType} onValueChange={(v) => setDraft({ ...currentDraft, splitType: v as SplitType })}>
                        <SelectTrigger className={cn(SHEET_TRIGGER, "h-9 w-auto min-w-40")} aria-label="Split type">
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
                      <span className="ml-auto text-[12px] font-medium text-foreground/72 tabular-nums">Total {formatCurrencyPrecise(currentCandidate.amount)}</span>
                    </div>

                    <ul className="grid gap-2 lg:grid-cols-2" aria-label="Split participants">
                      {currentDraft.participants.map((p, i) => (
                        <li key={i} className="flex items-center gap-1.5 rounded-xl bg-card p-1.5 shadow-e1">
                          <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-full bg-secondary text-[11px] font-bold text-foreground/70">
                            {i + 1}
                          </span>
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
                            <SelectTrigger className={cn(SHEET_TRIGGER, "h-9 w-36 shrink-0 shadow-none")} aria-label={`Participant ${i + 1}`}>
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
                          {p.personId == null ? (
                            <Input placeholder="Name" aria-label={`Participant ${i + 1} name`} value={p.name} className={cn(SHEET_FIELD, "h-9 min-w-0 flex-1 shadow-none")} onChange={(e) => updateParticipant(i, { name: e.target.value })} />
                          ) : (
                            <span className="min-w-0 flex-1" />
                          )}
                          {currentDraft.splitType !== "equal" && (
                            <Input
                              type="number"
                              inputMode="decimal"
                              placeholder={currentDraft.splitType === "percentage" ? "%" : "Amount"}
                              aria-label={`Participant ${i + 1} ${currentDraft.splitType === "percentage" ? "percentage" : "amount"}`}
                              value={p.value}
                              className={cn(SHEET_FIELD, "h-9 w-24 shrink-0 text-right tabular-nums shadow-none")}
                              onChange={(e) => updateParticipant(i, { value: e.target.value })}
                            />
                          )}
                          <button
                            type="button"
                            onClick={() => removeParticipantRow(i)}
                            className="grid size-8 shrink-0 place-items-center rounded-lg text-foreground/72 transition-colors hover:bg-danger/10 hover:text-danger"
                            aria-label="Remove participant"
                          >
                            <Trash2 className="size-3.5" />
                          </button>
                        </li>
                      ))}
                    </ul>

                    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
                      <button type="button" onClick={addParticipantRow} className={cn(SHEET_BUTTON.ghost, "h-8 px-2.5 text-[13px]")}>
                        <Plus className="size-3.5" />
                        Add person
                      </button>
                      {allocation && (
                        <p
                          data-testid="split-allocation"
                          aria-live="polite"
                          className={cn(
                            "rounded-full px-2.5 py-1 text-[12px] font-semibold tabular-nums",
                            allocation.balanced === true ? "bg-success/12 text-[oklch(0.44_0.13_149)] dark:text-success" : allocation.balanced === false ? "bg-warning/20 text-[oklch(0.45_0.11_70)] dark:text-warning" : "bg-card text-foreground/72",
                          )}
                        >
                          {allocation.summary}
                        </p>
                      )}
                    </div>
                    {allocation?.hint && <p className="text-[11.5px] text-foreground/72">{allocation.hint}</p>}
                    {allocation?.duplicate && (
                      <p className="flex items-start gap-1.5 text-[11.5px] text-foreground">
                        <AlertTriangle className="mt-px size-3.5 shrink-0 text-warning" aria-hidden />
                        {allocation.duplicate} is in this split twice — the import will refuse a split that lists someone twice.
                      </p>
                    )}
                    {errors.split && (
                      <p role="alert" className="text-[11.5px] font-medium text-[oklch(0.5_0.19_25)] dark:text-danger">
                        {errors.split}
                      </p>
                    )}
                  </div>
                )}
            </SheetSection>

            <SheetRail className="md:grid md:grid-cols-2 md:items-stretch">
              {/* Why this status: the plain-language meaning, then Android's own reasons verbatim. */}
              <SheetRailBlock
                icon={currentCandidate.needsReviewReasons.length > 0 || isDuplicate ? AlertTriangle : ShieldCheck}
                tone={currentCandidate.needsReviewReasons.length > 0 || isDuplicate ? "warning" : "success"}
                title="Review"
                data-testid="status-explanation"
                className={cn(committed && "hidden")}
              >
                <p>{statusInfo.explanation}</p>
                {currentCandidate.needsReviewReasons.length > 0 && (
                  <ul className="mt-1 list-disc space-y-0.5 pl-4 text-foreground/75">
                    {currentCandidate.needsReviewReasons.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                )}
                {looksLikeRawReference(currentCandidate.merchant) && (
                  <p className="mt-1 text-[11.5px] text-foreground/72">The parser couldn&apos;t isolate a merchant name — Parsing evidence and Technical details are more reliable here.</p>
                )}
              </SheetRailBlock>

              {/* Why this account: Android's match and the last-4 check. It never selects anything; warnings stay visible. */}
              <SheetRailBlock icon={evidenceTone === "warning" ? AlertTriangle : Wallet} tone={evidenceTone} title="Account match">
                <div data-testid="account-match-evidence" className="flex flex-col gap-1">
                  {matchedIdentity && matchedUnchanged ? (
                    // A VERIFIED match only (Android's id still resolves to a real account) — drawn with the account's own bank logo.
                    <p className="flex min-w-0 items-center gap-1.5" data-testid="matched-identity">
                      <BankLogo bankId={matchedIdentity.bankId} size={20} shape="square" />
                      <span className="min-w-0">
                        <span className="font-semibold text-foreground">Android matched this to {matchEvidence.androidLabel ?? matchedIdentity.name}.</span>
                      </span>
                    </p>
                  ) : matchEvidence.androidLabel ? (
                    matchEvidence.matchesAndroid ? (
                      <p>
                        <span className="font-semibold text-foreground">Android matched this to {matchEvidence.androidLabel}.</span>
                      </p>
                    ) : (
                      <p>
                        <span className="font-semibold text-foreground">You changed the account.</span> Android had matched {matchEvidence.androidLabel}.
                      </p>
                    )
                  ) : (
                    <p className="font-semibold text-foreground">{unresolvedHint} — pick the right one before importing.</p>
                  )}
                  {matchEvidence.lastFourCheck === "equal" && (
                    <p className="flex items-center gap-1.5">
                      <Check className="size-3.5 shrink-0 text-[oklch(0.44_0.13_149)] dark:text-success" strokeWidth={2.5} aria-hidden />
                      The SMS last-4 •••• <span className="tabular-nums">{matchEvidence.smsLastFour}</span>{" "}
                      equals this account&apos;s last-4.
                    </p>
                  )}
                  {matchEvidence.lastFourCheck === "different" && (
                    <p className="flex items-start gap-1.5 text-foreground">
                      <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
                      The SMS last-4 •••• {matchEvidence.smsLastFour} is not this account&apos;s last-4 (•••• {matchEvidence.destinationLastFour}). Check you picked the right one.
                    </p>
                  )}
                  {secondaryEvidence.length > 0 &&
                    (accountChosen ? (
                      <details className="group text-foreground/70">
                        <summary className="w-fit cursor-pointer list-none text-[11.5px] font-semibold text-foreground/72 select-none hover:text-foreground [&::-webkit-details-marker]:hidden">
                          <span className="inline-flex items-center gap-1">
                            <ChevronRight className="size-3 transition-transform group-open:rotate-90" aria-hidden /> Match details
                          </span>
                        </summary>
                        <div className="mt-1 space-y-0.5 pl-4">{secondaryEvidence}</div>
                      </details>
                    ) : (
                      <div className="space-y-0.5 text-foreground/70">{secondaryEvidence}</div>
                    ))}
                  {currentCandidate.rawLastFour != null && matchEvidence.androidLabel == null && lastFourOptions.length === 0 && currentDraft.destinationKey == null && (
                    <p className="text-foreground/70">No saved account or card ends in •••• {currentCandidate.rawLastFour}. Choose one yourself.</p>
                  )}
                </div>
              </SheetRailBlock>

              <div className={cn(SHEET_CHIPS, "col-span-full")} role="group" aria-label="More about this SMS">
                <SheetDisclosure id="candidate-panel-notes" icon={NotebookPen} title="Notes" hint={currentDraft.notes.trim() || "Optional"} open={openPanel === "notes"} onToggle={() => setOpenPanel(openPanel === "notes" ? null : "notes")}>
                  <Textarea
                    value={currentDraft.notes}
                    placeholder="Add a note (optional)"
                    aria-label="Notes"
                    rows={2}
                    className={cn(SHEET_FIELD, "h-auto min-h-16 resize-y py-2")}
                    onChange={(e) => setDraft({ ...currentDraft, notes: e.target.value })}
                  />
                </SheetDisclosure>
                <SheetDisclosure id="candidate-panel-sms" icon={MessageSquareText} title="Original SMS" hint="Stays on your phone" open={openPanel === "sms"} onToggle={() => setOpenPanel(openPanel === "sms" ? null : "sms")}>
                  <div className="flex flex-col gap-1 rounded-[10px] border border-dashed border-border-strong bg-secondary/40 px-3 py-2" data-testid="original-message-unavailable">
                    <p className="text-[11px] font-bold tracking-wide text-foreground uppercase">Original message unavailable</p>
                    <p className="text-[12px] text-foreground/80">
                      FlowFi never receives the SMS text — it stays on your phone (open the Android app&apos;s SMS Inbox to read it). What you see here is what the phone parsed from it.
                    </p>
                  </div>
                </SheetDisclosure>
                <SheetDisclosure
                  id="candidate-panel-evidence"
                  icon={SlidersHorizontal}
                  title="Parsing evidence"
                  hint={`${currentCandidate.confidenceLevel} · ${confidencePct}%`}
                  open={openPanel === "evidence"}
                  onToggle={() => setOpenPanel(openPanel === "evidence" ? null : "evidence")}
                >
                  <div className="flex flex-col gap-2.5">
                    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-[12px]">
                      <dt className="text-foreground/72">Bank</dt>
                      <dd className="truncate font-medium text-foreground">{currentCandidate.bankName ?? "—"}</dd>
                      <dt className="text-foreground/72">Event type</dt>
                      <dd className="font-medium text-foreground">{smsCandidateEventTypeLabel(currentCandidate.eventType)}</dd>
                      <dt className="text-foreground/72">Raw last 4 (from SMS)</dt>
                      <dd className="font-medium text-foreground tabular-nums">{currentCandidate.rawLastFour ? `•••• ${currentCandidate.rawLastFour}` : "—"}</dd>
                    </dl>
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center justify-between text-[12px] font-semibold text-foreground/75">
                        <span>Parser confidence</span>
                        <span className="tabular-nums capitalize">
                          {currentCandidate.confidenceLevel} · {confidencePct}%
                        </span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-border" role="img" aria-label={`Confidence ${confidencePct}%`}>
                        <div
                          className={cn("h-full rounded-full transition-[width]", currentCandidate.confidenceScore >= 0.8 ? "bg-success" : currentCandidate.confidenceScore >= 0.5 ? "bg-warning" : "bg-danger")}
                          style={{ width: `${confidencePct}%` }}
                        />
                      </div>
                    </div>
                    <p className="text-[11.5px] text-foreground/75" data-testid="confidence-explanation">
                      Android scores each message from how well it was parsed, whether an account matched, and whether the transaction type was recognised.{" "}
                      {currentCandidate.confidenceLevel === "high" ? "This one scored high." : currentCandidate.confidenceLevel === "medium" ? "This one scored medium, so Android asks for a look." : "This one scored low, so check every field."}
                    </p>
                    <div className="text-[11.5px] text-foreground/75">
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
                  </div>
                </SheetDisclosure>
                <SheetDisclosure id="candidate-panel-tech" icon={Hash} title="Technical details" hint={currentCandidate.referenceNumber ?? "Reference"} open={openPanel === "tech"} onToggle={() => setOpenPanel(openPanel === "tech" ? null : "tech")}>
                  <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-[12px]">
                    <dt className="text-foreground/72">Reference</dt>
                    <dd className="truncate font-mono text-foreground" title={currentCandidate.referenceNumber ?? undefined}>
                      {currentCandidate.referenceNumber ?? "—"}
                    </dd>
                    <dt className="text-foreground/72">Synced from your phone</dt>
                    <dd className="text-foreground tabular-nums">{SYNCED_DISPLAY_FORMAT.format(currentCandidate.createdAt)}</dd>
                  </dl>
                  <p className="mt-1.5 text-[11.5px] text-foreground/72">Detected from the SMS — these fields (and tags) aren&apos;t editable on an SMS candidate.</p>
                </SheetDisclosure>
              </div>
            </SheetRail>
          </div>
        </div>
      </TransactionSheet>

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

      <Dialog
        open={pendingGoTo != null || pendingClose}
        onOpenChange={(next) => {
          if (next) return;
          setPendingGoTo(null);
          setPendingClose(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discard your changes?</DialogTitle>
            <DialogDescription>
              You&apos;ve changed this candidate&apos;s category, account, notes or people. {pendingClose ? "Closing" : "Moving to another candidate"} discards those edits. Nothing has been imported.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              autoFocus
              variant="outline"
              onClick={() => {
                setPendingGoTo(null);
                setPendingClose(false);
              }}
            >
              Keep editing
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const target = pendingGoTo;
                const closing = pendingClose;
                setPendingGoTo(null);
                setPendingClose(false);
                if (closing) onOpenChange(false);
                else if (target) navigation?.onGoTo(target);
              }}
            >
              {pendingClose ? "Discard and close" : "Discard and continue"}
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
