"use client";

/**
 * The "Transaction Details" popup for a single SMS candidate — built on the
 * same `TransactionDetailsShell` Transaction Studio's `TransactionManageModal`
 * uses, so both surfaces share one visual implementation instead of two
 * drifting copies (see that component's own doc comment). Replaces the
 * former docked `CandidateDetailDrawer` + separate `ImportCandidateDialog`
 * two-step flow for the row-click entry point: category/account are picked
 * inline here and Import commits in one step, matching the shell's
 * single-primary-action footer.
 *
 * The candidate document itself is never edited — only `importCandidate`
 * (create the real Transaction, then delete the candidate) and
 * `ignoreCandidate` (delete only) are ever called, exactly the two existing,
 * already-tested write paths every other SMS candidate surface uses. See
 * `sms-transaction-candidate.ts`'s module doc for why: this collection is
 * Android-owned and web-writable only via full delete.
 */

import { useState } from "react";
import {
  AlertTriangle,
  Check,
  Landmark,
  Layers,
  ListChecks,
  Loader2,
  MessageSquareText,
  Plus,
  SlidersHorizontal,
  SplitSquareHorizontal,
  Trash2,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Field, SectionCard, StatChip, TransactionDetailsShell } from "@/components/finance/transaction-details-shell";
import { cn } from "@/lib/utils";
import { formatCurrencyPrecise } from "@/lib/format";
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
import { formatMatchedAccountLabel, formatUnresolvedAccountHint } from "../lib/candidate-account-matching";
import {
  buildDestinationOptions,
  importBlockedReason,
  initialImportDraft,
  isImportReady,
  looksLikeRawReference,
  resolveImportDestination,
  type CandidateImportDraft,
} from "../lib/candidate-details-view";
import type { CandidateDuplicateResult } from "../lib/candidate-duplicate";
import { ignoreCandidate, importCandidate, type CandidatePersonAssignment } from "../lib/import-candidate";
import { CandidateStatusBadge } from "./candidate-status-badge";

const DATE_DISPLAY_FORMAT = new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric" });

/** Same reasoning as `TransactionManageModal`'s own `FIELD_BORDER` — a low-opacity slice of
 *  `--foreground` reads as an actually-visible hairline against this dialog's white surface. */
const FIELD_BORDER = "border-foreground/15";

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
  // Same "reset once per open/candidate change" pattern `TransactionManageModal` uses for its own
  // draft — so switching to a different candidate (or reopening the same one) never resurrects a
  // previous, abandoned edit.
  const [draftSessionCandidateId, setDraftSessionCandidateId] = useState<string | null>(null);

  const open = candidate != null;

  if (open && candidate && draftSessionCandidateId !== candidate.id) {
    setDraftSessionCandidateId(candidate.id);
    setDraft(initialImportDraft(candidate));
    setPendingDuplicate(null);
    setConfirmDismissOpen(false);
  } else if (!open && draftSessionCandidateId !== null) {
    setDraftSessionCandidateId(null);
  }

  if (!candidate) return null;

  const currentCandidate = candidate;
  const currentDraft = draft;

  const destinationOptions = buildDestinationOptions(accounts, creditCards);
  const matchedAccountLabel = formatMatchedAccountLabel(currentCandidate, accounts, creditCards);
  const isDuplicate = duplicate?.duplicateOfTransactionId != null;
  const ready = isImportReady(currentDraft);
  const blockedReason = importBlockedReason(currentDraft);

  /**
   * `force` is only ever `true` when re-invoked from the `DuplicateWarningDialog`'s "Import anyway"
   * button below — the normal button click always runs the fresh check first. `importCandidate`
   * itself performs the actual (re-)check against `existingTransactions` immediately before writing
   * anything, so this never relies solely on the `duplicate` prop computed earlier for the banner.
   */
  async function handleImport(force = false) {
    if (importing || (!force && !ready)) return;
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
      return;
    }
    setPendingDuplicate(null);

    if (result.status === "success") {
      toast.success("Imported", `${currentCandidate.merchant ?? currentCandidate.bankName ?? "Transaction"} — ${formatCurrencyPrecise(currentCandidate.amount)}`);
      onOpenChange(false);
    } else if (result.status === "validation_failed") {
      toast.error("Can't import yet", result.reason);
    } else if (result.status === "transaction_create_failed") {
      toast.error("Import failed", "The transaction couldn't be created — this candidate is still pending, try again.");
    } else {
      toast.error(
        "Imported, but still showing",
        "The transaction was created but this candidate couldn't be removed — refresh; if it's still here, check for a duplicate before retrying.",
      );
      onOpenChange(false);
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

  async function handleDismiss() {
    if (dismissing) return;
    setDismissing(true);
    try {
      await ignoreCandidate(currentCandidate, candidateRepository);
      toast.success("Candidate dismissed");
      setConfirmDismissOpen(false);
      onOpenChange(false);
    } catch (error) {
      toast.error("Couldn't dismiss this candidate", error instanceof Error ? error.message : undefined);
    } finally {
      setDismissing(false);
    }
  }

  return (
    <>
      <TransactionDetailsShell
        open={open}
        onOpenChange={onOpenChange}
        busy={importing || dismissing}
        headerIcon={MessageSquareText}
        headerTitle="Transaction Details"
        headerDescription="Review this SMS-detected transaction before importing it"
        headerBadge={
          currentCandidate.referenceNumber && (
            <Badge variant="outline" className="hidden font-mono text-[10px] sm:inline-flex">
              {currentCandidate.referenceNumber}
            </Badge>
          )
        }
        identityAvatarName={currentCandidate.merchant ?? currentCandidate.bankName ?? "?"}
        identityCredit={currentCandidate.direction === "credit"}
        identityTitle={currentCandidate.merchant ?? currentCandidate.bankName ?? "SMS transaction"}
        identitySubtitle={`${DATE_DISPLAY_FORMAT.format(currentCandidate.transactionDate)} · ${matchedAccountLabel ?? formatUnresolvedAccountHint(currentCandidate)}`}
        statChips={
          <>
            <StatChip label="Amount">
              <span className={cn("text-base font-semibold tabular-nums", currentCandidate.direction === "credit" ? "text-success" : "text-expense")}>
                {currentCandidate.direction === "credit" ? "+" : "−"}
                {formatCurrencyPrecise(currentCandidate.amount)}
              </span>
            </StatChip>
            <StatChip label="Status">
              <CandidateStatusBadge candidate={currentCandidate} duplicate={duplicate} />
            </StatChip>
          </>
        }
        banner={
          (currentCandidate.needsReviewReasons.length > 0 || isDuplicate) && (
            <div className="flex flex-col gap-2">
              {currentCandidate.needsReviewReasons.length > 0 && (
                <div className="flex items-start gap-2 rounded-lg bg-warning/12 px-3 py-2.5 text-xs text-warning-foreground">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                  <p>{currentCandidate.needsReviewReasons.join(" ")}</p>
                </div>
              )}
              {isDuplicate && (
                <div className="flex flex-col gap-2 rounded-lg border border-warning/30 bg-warning/5 p-3">
                  <p className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-warning-foreground uppercase">
                    <Landmark className="size-3.5" />
                    Possible duplicate
                  </p>
                  <p className="text-xs text-muted-foreground">{duplicate?.reason}</p>
                  {matchedTransaction && (
                    <div className="rounded-lg border border-border/60 bg-card px-3 py-2.5 text-xs">
                      <p className="truncate font-medium text-foreground">{matchedTransaction.description || "Existing transaction"}</p>
                      <p className="text-muted-foreground">
                        {formatCurrencyPrecise(matchedTransaction.amount)} · {DATE_DISPLAY_FORMAT.format(matchedTransaction.dateTime)} · already imported
                      </p>
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground">Importing will re-check this and ask for confirmation before creating a transaction.</p>
                </div>
              )}
            </div>
          )
        }
        leftColumn={
          <SectionCard icon={ListChecks} title="Transaction Details">
            <Field label="Amount">
              <div className={cn("flex h-9 items-center rounded-md border bg-muted/40 px-2.5 text-sm text-muted-foreground tabular-nums", FIELD_BORDER)}>
                {currentCandidate.direction === "credit" ? "+" : "−"}
                {formatCurrencyPrecise(currentCandidate.amount)}
              </div>
            </Field>
            <Field label="Date">
              <div className={cn("flex h-9 items-center rounded-md border bg-muted/40 px-2.5 text-sm text-muted-foreground", FIELD_BORDER)}>
                {DATE_DISPLAY_FORMAT.format(currentCandidate.transactionDate)}
              </div>
            </Field>
            <Field label="Merchant">
              <div
                title={currentCandidate.merchant ?? undefined}
                className={cn("flex h-9 items-center truncate rounded-md border bg-muted/40 px-2.5 text-sm text-muted-foreground", FIELD_BORDER)}
              >
                {currentCandidate.merchant ?? "Unknown"}
              </div>
              {looksLikeRawReference(currentCandidate.merchant) && (
                <p className="text-[11px] text-muted-foreground">
                  The SMS parser couldn&apos;t isolate a merchant name here — Bank, Reference, and Confidence below are the more reliable fields for this one.
                </p>
              )}
            </Field>
            <Field label="Bank">
              <div
                title={currentCandidate.bankName ?? undefined}
                className={cn("flex h-9 items-center truncate rounded-md border bg-muted/40 px-2.5 text-sm text-muted-foreground", FIELD_BORDER)}
              >
                {currentCandidate.bankName ?? "—"}
              </div>
            </Field>
            <Field label="Reference">
              <div
                title={currentCandidate.referenceNumber ?? undefined}
                className={cn("flex h-9 items-center truncate rounded-md border bg-muted/40 px-2.5 text-sm text-muted-foreground", FIELD_BORDER)}
              >
                {currentCandidate.referenceNumber ?? "—"}
              </div>
            </Field>
            <Field label="Event Type">
              <div className={cn("flex h-9 items-center rounded-md border bg-muted/40 px-2.5 text-sm text-muted-foreground", FIELD_BORDER)}>
                {smsCandidateEventTypeLabel(currentCandidate.eventType)}
              </div>
            </Field>
            <Field label="Category *">
              <Select value={currentDraft.categoryId ?? undefined} onValueChange={(categoryId) => setDraft({ ...currentDraft, categoryId })}>
                <SelectTrigger className={cn("w-full", FIELD_BORDER)}>
                  <SelectValue placeholder="Select a category" />
                </SelectTrigger>
                <SelectContent>
                  {categories.map((category) => (
                    <SelectItem key={category.id} value={category.id}>
                      {category.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Account / Card *">
              <Select value={currentDraft.destinationKey ?? undefined} onValueChange={(destinationKey) => setDraft({ ...currentDraft, destinationKey })}>
                <SelectTrigger className={cn("w-full", FIELD_BORDER)}>
                  <SelectValue placeholder="Select an account or card" />
                </SelectTrigger>
                <SelectContent>
                  {destinationOptions.map((opt) => (
                    <SelectItem key={opt.key} value={opt.key}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {!matchedAccountLabel && (
                <p className="text-[11px] text-muted-foreground">{formatUnresolvedAccountHint(currentCandidate)} — pick the right one before importing.</p>
              )}
            </Field>
            <Field label="Notes">
              <Textarea
                value={currentDraft.notes}
                placeholder="Add a note (optional)"
                className={cn("min-h-12 text-sm", FIELD_BORDER)}
                onChange={(e) => setDraft({ ...currentDraft, notes: e.target.value })}
              />
            </Field>
          </SectionCard>
        }
        middleColumn={
          <>
            <SectionCard icon={Layers} title="Classification">
              <div className="flex flex-col gap-2">
                <Badge variant="outline" className="w-fit text-[11px]">
                  {currentCandidate.direction === "credit" ? "Income" : "Expense"} · {smsCandidateEventTypeLabel(currentCandidate.eventType)}
                </Badge>
                <p className="text-xs text-muted-foreground">Detected from SMS — classification follows the transaction type and isn&apos;t editable here.</p>
              </div>
            </SectionCard>

            <SectionCard icon={Users} title="People & Split">
              {currentCandidate.direction === "credit" ? (
                <div className="flex items-start gap-2 rounded-lg border border-dashed border-foreground/15 bg-muted/30 px-3 py-2.5">
                  <Users className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                  <p className="text-xs text-muted-foreground">Assigning to a person or splitting is only available for expenses.</p>
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  <Field label="Assign to a person">
                    {!addingPerson ? (
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
                        <SelectTrigger className={cn("w-full", FIELD_BORDER)}>
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
                    ) : (
                      <div className="flex items-center gap-2">
                        <Input
                          autoFocus
                          placeholder="Person's name"
                          value={newPersonName}
                          className={FIELD_BORDER}
                          onChange={(e) => setNewPersonName(e.target.value)}
                          onKeyDown={(e) => e.key === "Enter" && void handleAddPerson()}
                        />
                        <Button size="icon-sm" onClick={() => void handleAddPerson()} disabled={addingPersonBusy || !newPersonName.trim()} aria-label="Save person">
                          <Check className="size-4" />
                        </Button>
                        <Button size="icon-sm" variant="ghost" onClick={() => setAddingPerson(false)} aria-label="Cancel">
                          <X className="size-4" />
                        </Button>
                      </div>
                    )}
                  </Field>

                  {!currentDraft.splitOpen && (
                    <button
                      type="button"
                      onClick={() => setDraft({ ...currentDraft, splitOpen: true })}
                      className="inline-flex items-center gap-1.5 self-start text-xs font-medium text-primary hover:underline"
                    >
                      <SplitSquareHorizontal className="size-3.5" />
                      Split with more people instead
                    </button>
                  )}

                  {currentDraft.personId && !currentDraft.splitOpen && (
                    <label className="flex items-start gap-2 border-t border-foreground/10 pt-3 text-sm">
                      <Switch
                        checked={currentDraft.owesPersonToggle}
                        onCheckedChange={(checked) => setDraft({ ...currentDraft, owesPersonToggle: checked })}
                        className="mt-0.5"
                      />
                      <span>
                        <span className="block text-foreground">This person owes me this expense</span>
                        <span className="block text-xs text-muted-foreground">Adds this amount to what they owe you.</span>
                      </span>
                    </label>
                  )}

                  {currentDraft.splitOpen && (
                    <div className="flex flex-col gap-3 border-t border-foreground/10 pt-3">
                      <div className="flex items-center justify-between">
                        <p className="text-sm font-medium text-foreground">Split this expense</p>
                        <button
                          type="button"
                          onClick={() => setDraft({ ...currentDraft, splitOpen: false })}
                          className="text-xs text-muted-foreground hover:underline"
                        >
                          Hide split editor
                        </button>
                      </div>
                      <Select value={currentDraft.splitType} onValueChange={(v) => setDraft({ ...currentDraft, splitType: v as SplitType })}>
                        <SelectTrigger className={cn("w-full", FIELD_BORDER)}>
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
                          <div key={i} className="flex items-center gap-2">
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
                              <SelectTrigger className={cn("h-9 w-32 shrink-0", FIELD_BORDER)}>
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
                              <Input placeholder="Name" value={p.name} className={cn("h-9", FIELD_BORDER)} onChange={(e) => updateParticipant(i, { name: e.target.value })} />
                            )}
                            {currentDraft.splitType !== "equal" && (
                              <Input
                                type="number"
                                placeholder={currentDraft.splitType === "percentage" ? "%" : "Amount"}
                                value={p.value}
                                className={cn("h-9 w-24 shrink-0", FIELD_BORDER)}
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
                      </div>
                    </div>
                  )}
                </div>
              )}
            </SectionCard>
          </>
        }
        rightColumn={
          <>
            <SectionCard icon={SlidersHorizontal} title="Advanced Options">
              <Field label="Raw last 4 (from SMS)">
                <div className={cn("flex h-9 items-center rounded-md border bg-muted/40 px-2.5 text-sm text-muted-foreground", FIELD_BORDER)}>
                  {currentCandidate.rawLastFour ? `•••• ${currentCandidate.rawLastFour}` : "—"}
                </div>
              </Field>
              <Field label="Confidence">
                <div className={cn("flex h-9 items-center rounded-md border bg-muted/40 px-2.5 text-sm text-muted-foreground capitalize", FIELD_BORDER)}>
                  {currentCandidate.confidenceLevel} ({Math.round(currentCandidate.confidenceScore * 100)}%)
                </div>
              </Field>
              <p className="text-[11px] text-muted-foreground">Tags aren&apos;t applicable to SMS candidates.</p>
            </SectionCard>

            <SectionCard icon={AlertTriangle} title="Dismiss Candidate" tone="danger">
              <p className="text-xs text-muted-foreground">
                Removes this from the review queue without creating a transaction. This can&apos;t be undone from here.
              </p>
              <Button variant="destructive" size="sm" className="w-full" onClick={() => setConfirmDismissOpen(true)}>
                <Trash2 /> Dismiss Candidate
              </Button>
            </SectionCard>
          </>
        }
        footerLeft={blockedReason && !importing && <p className="text-xs text-muted-foreground">{blockedReason}</p>}
        footerActions={
          <>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={importing}>
              Cancel
            </Button>
            <Button onClick={() => void handleImport()} disabled={importing || !ready}>
              {importing && <Loader2 className="size-3.5 animate-spin" />}
              Import as Transaction
            </Button>
          </>
        }
      />

      <Dialog open={confirmDismissOpen} onOpenChange={setConfirmDismissOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Dismiss this candidate?</DialogTitle>
            <DialogDescription>
              &ldquo;{currentCandidate.merchant ?? currentCandidate.bankName ?? "This SMS transaction"}&rdquo; (
              {formatCurrencyPrecise(currentCandidate.amount)}) will be removed from the review queue without creating a transaction. This can&apos;t be
              undone from here.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDismissOpen(false)} disabled={dismissing}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void handleDismiss()} disabled={dismissing}>
              {dismissing ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
              Dismiss candidate
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
        onConfirm={() => void handleImport(true)}
      />
    </>
  );
}
