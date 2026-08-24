"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Landmark, Layers, Lock, ListChecks, Loader2, Save, Settings2, SlidersHorizontal, Trash2, Users, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Field, SectionCard, StatChip, TransactionDetailsShell } from "@/components/finance/transaction-details-shell";
import { cn } from "@/lib/utils";
import { formatCurrencyPrecise } from "@/lib/format";
import type { Account } from "@/lib/models/account";
import type { Bill } from "@/lib/models/bill";
import type { Category } from "@/lib/models/category";
import type { Emi } from "@/lib/models/emi";
import type { Loan } from "@/lib/models/loan";
import type { Person } from "@/lib/models/person";
import type { RecordAction, RecordActionDetail } from "@/lib/models/document-import";
import type { Transaction } from "@/lib/models/transaction";
import type { TransactionRepository } from "@/lib/repositories/transaction-repository";
import type { TransactionStudioMutations } from "@/hooks/use-transaction-studio-mutations";
import { toast } from "@/store/toast-store";
import { actionBadgeClassName, actionLabel, actionToAxesPatch, defaultActionForDirection, deriveRecordAction } from "../../lib/action-metadata";
import { deleteCommittedAwareRow, draftToEditTransactionParams, formatAccountDisplay } from "../../lib/committed-transaction-sync";
import type { GridRow } from "../../lib/grid-types";
import {
  draftFromRow,
  isDraftDirty,
  toDateInputValue,
  toMonthInputValue,
  validateDraft,
  type TransactionDetailsDraft,
} from "../../lib/transaction-manage-draft";
import { StatusCell } from "../spreadsheet/cells/status-cell";
import { ActionDetailPanel } from "./action-detail-panel";
import { CommittedClassificationNotice, CommittedPeopleNotice } from "./committed-transaction-notices";
import { FlowOwnershipHeader } from "./flow-ownership-header";

const DATE_DISPLAY_FORMAT = new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric" });

/** Same reasoning as `SectionCard`'s border — `border-input` is the same faint 14%-opacity primary
 *  tint as `--border`; a low-opacity slice of `--foreground` reads as an actually-visible hairline
 *  against this dialog's white surface without introducing a new color. Applied to every text
 *  input/select/textarea in this modal for one consistent field boundary. */
const FIELD_BORDER = "border-foreground/15";

/**
 * Once a row is committed (`row.committedTransactionId != null`), the staging `StagedRecord` it
 * came from is no longer the source of truth for Amount/Date/Merchant/Category/Notes/Exclude/Month
 * — the real `transactions/{id}` doc is. This overlays that live `Transaction` onto the staging
 * draft for the fields the two models actually share, so the form (and the dirty-check, and what
 * gets sent back on Save) reflects reality instead of a possibly-stale staging copy nobody's read
 * since commit. Tags/Reference/Include-in-totals have no equivalent on `Transaction` (see the
 * component doc comment) and stay staging-only.
 */
function draftForRow(row: GridRow, committedTransaction: Transaction | null, categories: Category[]): TransactionDetailsDraft {
  const base = draftFromRow(row);
  if (!committedTransaction) return base;
  return {
    ...base,
    amount: String(committedTransaction.amount),
    date: toDateInputValue(committedTransaction.dateTime),
    merchant: committedTransaction.description || base.merchant,
    category: categories.find((c) => c.id === committedTransaction.categoryId)?.name ?? base.category,
    notes: committedTransaction.notes,
    excludeFromCalculations: committedTransaction.excludeFromCalculations,
    accountingMonth: toMonthInputValue(committedTransaction.accountingMonth),
  };
}

/**
 * The Action column's "Open transaction controls" destination (brief: "I clicked one transaction
 * and now I have complete control over that transaction"). A centered modal rather than the docked
 * Inspector (`RightSidebar`, unchanged and still reachable from the validation bar/duplicate/preflight
 * "Review" links).
 *
 * Two very different write paths live here, chosen by whether the row has been committed yet
 * (`row.committedTransactionId`):
 *
 * - **Not yet committed** (still a staging draft, the common case while reviewing an import):
 *   Save/Delete write straight to the staging `documentImports/.../records/{id}` doc via
 *   `mutations` — exactly as before, and exactly correct, since no real `Transaction` exists yet.
 * - **Already committed** (Approve & Import already ran for this row, but Transaction Studio still
 *   shows it — nothing hides committed rows from the grid): Save/Delete now route through
 *   `transactionRepository.editTransaction`/`softDeleteTransaction` — the same balance-safe path
 *   `/transactions`'s own edit UI (`TransactionManagerSheet`) uses, so old/new balance effects are
 *   reversed and reapplied correctly instead of double-counted. Before this, "Save changes" here
 *   silently wrote only to the staging copy, which nothing but this grid reads once a row is
 *   committed — the edit looked like it worked (the grid cell changed, since the grid also reads
 *   that same staging doc) but never touched the real transaction, account balance, or reports.
 *   The staging copy is still written too (`mutations.updateFields`) purely so the grid — which
 *   reads the staging collection, not `transactions/` — shows the new value immediately.
 *
 * Classification and People & Split reuse `FlowOwnershipHeader`/`ActionDetailPanel` verbatim for
 * not-yet-committed rows. For committed rows they go **read-only**: there is no existing repository
 * operation to safely convert an already-committed Transaction/Expense's fundamental type after the
 * fact (no "turn this Transaction into a Transfer/EMI" method exists anywhere in the app), and
 * assigning/splitting a committed expense already has a complete, working implementation at
 * `/transactions` (`TransactionManagerSheet` → `applyOwesPersonChange`/`ExpenseRepository`) — this
 * modal links out to it rather than forking a second, partial copy of that logic.
 */
export function TransactionManageModal({
  row,
  committedTransaction,
  transactionRepository,
  open,
  onOpenChange,
  sourceAccountName,
  accounts,
  people,
  emis,
  loans,
  bills,
  categories,
  mutations,
}: {
  row: GridRow | null;
  /** The live `transactions/{committedTransactionId}` doc when `row.committedTransactionId` is set — `null` while it's still loading or the row was never committed. */
  committedTransaction: Transaction | null;
  /** `null` only while signed-out/loading — Save/Delete are disabled for committed rows until this and `committedTransaction` are both ready. */
  transactionRepository: TransactionRepository | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sourceAccountName: string;
  accounts: Account[];
  people: Person[];
  emis: Emi[];
  loans: Loan[];
  bills: Bill[];
  categories: Category[];
  mutations: TransactionStudioMutations;
}) {
  const [draft, setDraft] = useState<TransactionDetailsDraft | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ amount?: string; date?: string; category?: string }>({});
  const [tagDraft, setTagDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  // Tracks which row the Details draft was last derived for — `null` whenever the modal is closed,
  // so reopening (even for the same row, even right after a Cancel) always starts from a fresh
  // draft rather than resurrecting an abandoned edit.
  const [draftSessionRowId, setDraftSessionRowId] = useState<string | null>(null);

  const isCommitted = row?.committedTransactionId != null;
  // For a committed row, the real `Transaction` (fetched by the parent via `useTransactions()`) is
  // the source of truth; until it's loaded, treat the form as not-yet-ready rather than seeding it
  // from a possibly-stale staging copy.
  const committedDataReady = !isCommitted || committedTransaction != null;

  // Reset the Details draft when the modal opens (or switches to a different row) — adjusting state
  // during render (React's documented alternative to an effect here), guarded so it only fires once
  // per open/row change instead of looping. Gated on `committedDataReady` so a committed row's
  // draft is never seeded before its real `Transaction` has loaded (rather than seeding from a
  // possibly-stale staging copy and then silently swapping values out from under the user) — once
  // `draftSessionRowId` is set to this row's id it stays put, so it's keyed purely on `row.id`, not
  // on `committedTransaction` itself: neither its later live-listener updates (including the one
  // confirming *this modal's own* save) nor this panel's own Classification/People writes (immediate,
  // see `commitActionDetail` below) blow away in-progress, unsaved Details edits mid-session.
  if (open && row && committedDataReady && draftSessionRowId !== row.id) {
    setDraftSessionRowId(row.id);
    setDraft(draftForRow(row, committedTransaction, categories));
    setFieldErrors({});
    setTagDraft("");
    setConfirmDeleteOpen(false);
  } else if (!open && draftSessionRowId !== null) {
    setDraftSessionRowId(null);
  }

  // Defensive: the row this modal was opened for can vanish out from under it (deleted via the
  // docked Inspector, a bulk action, another tab) while it's still open — close rather than show a
  // modal with nothing in it. A genuine effect (notifying the parent, not adjusting local state).
  useEffect(() => {
    if (open && !row) onOpenChange(false);
  }, [open, row, onOpenChange]);

  if (!row || !draft) return null;

  // Rebind as fresh consts — `handleSave`/`handleDelete` below are closures that outlive this
  // render, and TS's non-null narrowing of the `row`/`draft` parameters doesn't survive into them.
  const currentRow = row;
  const currentDraft = draft;

  const commitActionDetail = (patch: { action?: RecordAction; actionDetail: RecordActionDetail | null }) =>
    void mutations.updateFields(currentRow.id, patch.action ? actionToAxesPatch(patch.action, patch.actionDetail) : { actionDetail: patch.actionDetail });
  const onChangeAction = (action: RecordAction) => void mutations.updateFields(currentRow.id, actionToAxesPatch(action));

  const dirty = isDraftDirty(draft, row);
  const action = deriveRecordAction(row);
  const linkedPerson = committedTransaction?.linkedPersonId ? (people.find((p) => p.id === committedTransaction.linkedPersonId) ?? null) : null;
  // Not-yet-committed rows have no accountId of their own yet — `sourceAccountName` (the account
  // chosen when the statement was imported) is already correct and shown directly below. Only a
  // committed row has a real `Transaction.accountId` to resolve an `Account` from.
  const accountDisplay = isCommitted && committedTransaction ? (accounts.find((a) => a.id === committedTransaction.accountId) ?? null) : null;

  function addTag() {
    const trimmed = tagDraft.trim();
    if (trimmed && !currentDraft.tags.includes(trimmed)) setDraft({ ...currentDraft, tags: [...currentDraft.tags, trimmed] });
    setTagDraft("");
  }

  function removeTag(tag: string) {
    setDraft({ ...currentDraft, tags: currentDraft.tags.filter((t) => t !== tag) });
  }

  async function handleSave() {
    if (saving || !committedDataReady) return; // prevent duplicate submissions
    const result = validateDraft(currentDraft);
    setFieldErrors(result.errors ?? {});
    if (!result.patch) return; // validation failed — draft (and the inline errors) stay exactly as typed
    // `needsReview` is stamped once by the parsing pipeline's Confidence Engine (low-confidence
    // extraction) and, per `deriveRowStatus`, outranks every other status check — a flagged row can
    // never read as "Ready" (and `validateRow` hard-blocks its commit) no matter how complete its
    // data is, until something actually clears the flag. Nothing else in the client ever did: saving
    // here *is* the human review that flag exists to require, so it's the one place that should
    // resolve it — not on every open (an unsaved, abandoned edit shouldn't clear it), and not via a
    // second explicit control the user has to know to look for.
    // Flow Type still `null` means the user never touched the Classification section's dropdowns
    // (which, unlike this Details save, commit instantly on change) — `FlowOwnershipHeader` shows a
    // real default there (`defaultActionForDirection`), not an empty picker, and this is the write
    // that makes that default real: a Details-only save (Amount/Category/etc.) now actually applies
    // it, instead of leaving `flowType: null` and the row stuck at "No Action Chosen" despite every
    // visible field looking filled in. Explicitly choosing a different Flow Type first (Transfer,
    // EMI/Loan, Shared, …) already set `currentRow.flowType` before Save ever runs, so this never
    // overwrites a real choice — only fills the gap nobody explicitly disagreed with.
    const defaultAxesPatch = isCommitted || currentRow.flowType != null ? {} : actionToAxesPatch(defaultActionForDirection(currentRow.direction));
    const patch = currentRow.needsReview ? { ...result.patch, ...defaultAxesPatch, needsReview: false } : { ...result.patch, ...defaultAxesPatch };

    if (isCommitted) {
      if (!transactionRepository || !committedTransaction) {
        toast.error("Couldn't save changes", "This transaction hasn't finished loading yet — try again in a moment.");
        return;
      }
      const mapped = draftToEditTransactionParams(currentDraft, categories);
      if (!mapped.params) {
        setFieldErrors((prev) => ({ ...prev, category: mapped.error }));
        return;
      }
      setSaving(true);
      try {
        // The balance-safe write — reverses the old amount/type/exclude effect and applies the new
        // one (see `TransactionRepository.editTransaction`), never double-counts.
        await transactionRepository.editTransaction(committedTransaction, mapped.params);
        // Keeps the grid's own display in sync — the grid reads the staging collection, not
        // `transactions/`, so without this the real transaction would be correct but the row
        // Transaction Studio shows would still read the old values until a full page reload.
        await mutations.updateFields(currentRow.id, patch);
        toast.success("Transaction updated");
      } catch (error) {
        toast.error("Couldn't save changes", error instanceof Error ? error.message : undefined);
        return;
      } finally {
        setSaving(false);
      }
    } else {
      setSaving(true);
      try {
        await mutations.updateFields(currentRow.id, patch);
        toast.success("Transaction updated");
      } catch (error) {
        toast.error("Couldn't save changes", error instanceof Error ? error.message : undefined);
        return;
      } finally {
        setSaving(false);
      }
    }

    // Closes on a successful save — back to the table, same as Cancel/X. `patch` is already applied
    // to both the real transaction (if committed) and the staging copy by this point, so there's
    // nothing left unsaved to show; re-deriving the draft here first (rather than just closing)
    // avoids a one-frame flash of the pre-save values while the dialog's close animation plays.
    setDraft(draftFromRow({ ...currentRow, ...patch }));
    onOpenChange(false);
  }

  async function handleDelete() {
    if (deleting || !committedDataReady) return;
    setDeleting(true);
    try {
      await deleteCommittedAwareRow({ row: currentRow, committedTransaction, transactionRepository, mutations });
      toast.success("Transaction deleted");
      setConfirmDeleteOpen(false);
      onOpenChange(false);
    } catch (error) {
      toast.error("Couldn't delete transaction", error instanceof Error ? error.message : undefined);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <TransactionDetailsShell
        open={open}
        onOpenChange={onOpenChange}
        busy={saving || deleting}
        headerIcon={Settings2}
        headerTitle="Transaction Details"
        headerDescription="Review and manage this transaction"
        headerBadge={
          row.referenceNumber && (
            <Badge variant="outline" className="hidden font-mono text-[10px] sm:inline-flex">
              {row.referenceNumber}
            </Badge>
          )
        }
        identityAvatarName={row.counterpartyNormalized ?? row.counterpartyRaw}
        identityCredit={row.direction === "credit"}
        identityTitle={row.counterpartyNormalized ?? row.counterpartyRaw}
        identitySubtitle={`${DATE_DISPLAY_FORMAT.format(row.date)} · ${sourceAccountName}`}
        statChips={
          <>
            <StatChip label="Current Amount">
              <span className={cn("text-base font-semibold tabular-nums", row.direction === "credit" ? "text-success" : "text-expense")}>
                {row.direction === "credit" ? "+" : "−"}
                {formatCurrencyPrecise(row.amount)}
              </span>
            </StatChip>
            <StatChip label="Status">
              <StatusCell row={row} />
            </StatChip>
            <StatChip label="Action">
              <Badge variant="outline" className={cn("w-fit text-[11px]", actionBadgeClassName(action))}>
                {actionLabel(action)}
              </Badge>
            </StatChip>
          </>
        }
        leftColumn={
          <SectionCard icon={ListChecks} title="Transaction Details">
            <Field label="Amount *" error={fieldErrors.amount}>
              <Input
                type="number"
                step="0.01"
                min="0"
                value={draft.amount}
                onChange={(e) => setDraft({ ...draft, amount: e.target.value })}
                aria-invalid={!!fieldErrors.amount}
                className={cn("tabular-nums", FIELD_BORDER)}
              />
            </Field>
            <Field label="Date *" error={fieldErrors.date}>
              <Input
                type="date"
                value={draft.date}
                onChange={(e) => setDraft({ ...draft, date: e.target.value })}
                aria-invalid={!!fieldErrors.date}
                className={FIELD_BORDER}
              />
            </Field>
            <Field label="Merchant">
              <Input value={draft.merchant} onChange={(e) => setDraft({ ...draft, merchant: e.target.value })} className={FIELD_BORDER} />
            </Field>
            <Field label="Category" error={fieldErrors.category}>
              <Select value={draft.category ?? undefined} onValueChange={(category) => setDraft({ ...draft, category })}>
                <SelectTrigger className={cn("w-full", FIELD_BORDER)}>
                  <SelectValue placeholder="Uncategorized" />
                </SelectTrigger>
                <SelectContent>
                  {categories.map((category) => (
                    <SelectItem key={category.id} value={category.name}>
                      {category.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Account">
              <div className={cn("flex h-9 items-center justify-between rounded-md border bg-muted/40 px-2.5 text-sm text-muted-foreground", FIELD_BORDER)}>
                <span className="truncate">
                  {accountDisplay ? formatAccountDisplay(accountDisplay) : isCommitted && !committedDataReady ? "Loading…" : sourceAccountName}
                </span>
                <Lock className="size-3 shrink-0 opacity-60" aria-hidden />
              </div>
            </Field>
            <Field label="Notes">
              <Textarea
                value={draft.notes}
                placeholder="Add a note (optional)"
                className={cn("min-h-12 text-sm", FIELD_BORDER)}
                onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
              />
            </Field>
            <label className={cn("flex items-center justify-between gap-2 border-t border-foreground/10 pt-3", isCommitted && "opacity-50")}>
              <span className="text-sm text-foreground">Include in totals</span>
              <Switch
                checked={draft.include}
                disabled={isCommitted}
                onCheckedChange={(checked) => setDraft({ ...draft, include: checked })}
              />
            </label>
            {isCommitted && (
              <p className="-mt-2 text-[11px] text-muted-foreground">
                Already imported — use &ldquo;Exclude from totals&rdquo; under Advanced Options to leave it out of reports instead.
              </p>
            )}
          </SectionCard>
        }
        middleColumn={
          <>
            <SectionCard icon={Layers} title="Classification">
              {isCommitted ? (
                <CommittedClassificationNotice action={action} />
              ) : (
                <FlowOwnershipHeader row={row} onCommitAction={onChangeAction} />
              )}
            </SectionCard>

            <SectionCard icon={Users} title="People & Split">
              {isCommitted ? (
                <CommittedPeopleNotice linkedPerson={linkedPerson} />
              ) : (
                <ActionDetailPanel
                  row={row}
                  accounts={accounts}
                  sourceAccountName={sourceAccountName}
                  people={people}
                  emis={emis}
                  loans={loans}
                  bills={bills}
                  onCommitActionDetail={commitActionDetail}
                  onClose={() => onOpenChange(false)}
                  embedded
                  fallback={
                    <div className="flex items-start gap-2 rounded-lg border border-dashed border-foreground/15 bg-muted/30 px-3 py-2.5">
                      <Users className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                      <p className="text-xs text-muted-foreground">
                        Personal transaction — no other people involved. Change Ownership above to split it or assign it to someone else.
                      </p>
                    </div>
                  }
                />
              )}
            </SectionCard>
          </>
        }
        rightColumn={
          <>
            <SectionCard icon={SlidersHorizontal} title="Advanced Options">
              <label className="flex items-start gap-2 border-b border-foreground/10 pb-3 text-sm">
                <Checkbox
                  checked={draft.excludeFromCalculations}
                  onCheckedChange={(checked) => setDraft({ ...draft, excludeFromCalculations: checked === true })}
                  className="mt-0.5"
                />
                <span>
                  <span className="block text-foreground">Exclude from totals</span>
                  <span className="block text-xs text-muted-foreground">This transaction will not be included in totals</span>
                </span>
              </label>

              <Field label="Tags">
                <div className={cn("flex flex-wrap gap-1.5", draft.tags.length > 0 && "mb-1.5")}>
                  {draft.tags.map((tag) => (
                    <Badge key={tag} variant="secondary" className="gap-1 text-[11px]">
                      {tag}
                      <button type="button" onClick={() => removeTag(tag)} aria-label={`Remove ${tag}`}>
                        <X className="size-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
                <Input
                  value={tagDraft}
                  placeholder="Add a tag…"
                  className={cn("h-8 text-sm", FIELD_BORDER)}
                  onChange={(e) => setTagDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addTag();
                    }
                  }}
                  onBlur={addTag}
                />
              </Field>

              <Field label="Reference / Bill No.">
                <Input
                  value={draft.referenceNumber}
                  onChange={(e) => setDraft({ ...draft, referenceNumber: e.target.value })}
                  className={FIELD_BORDER}
                />
              </Field>

              <Field label="Month attribution (optional)">
                <Input
                  type="month"
                  value={draft.accountingMonth}
                  onChange={(e) => setDraft({ ...draft, accountingMonth: e.target.value })}
                  className={FIELD_BORDER}
                />
              </Field>
              {isCommitted && (
                <p className="text-[11px] text-muted-foreground">Tags and Reference/Bill No. are internal to Transaction Studio&apos;s review record only.</p>
              )}
            </SectionCard>

            <SectionCard icon={AlertTriangle} title="Delete Transaction" tone="danger">
              <p className="text-xs text-muted-foreground">
                {isCommitted
                  ? "Permanently reverses this transaction's effect on your account balance and removes it."
                  : "This action cannot be undone."}
              </p>
              <Button
                variant="destructive"
                size="sm"
                className="w-full"
                disabled={!committedDataReady}
                onClick={() => setConfirmDeleteOpen(true)}
              >
                <Trash2 /> Delete Transaction
              </Button>
            </SectionCard>
          </>
        }
        footerLeft={
          row.committedTransactionId ? (
            <Button variant="ghost" size="sm" asChild>
              <Link href="/transactions">
                <Landmark /> View in ledger
              </Link>
            </Button>
          ) : (
            <span />
          )
        }
        footerActions={
          <>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={() => void handleSave()} disabled={saving || !dirty || !committedDataReady}>
              {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
              Save changes
            </Button>
          </>
        }
      />

      <Dialog open={confirmDeleteOpen} onOpenChange={setConfirmDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this transaction?</DialogTitle>
            <DialogDescription>
              &ldquo;{row.counterpartyNormalized ?? row.counterpartyRaw}&rdquo; ({formatCurrencyPrecise(row.amount)}) will be permanently
              removed.{" "}
              {isCommitted
                ? "This reverses its effect on your account balance — this can't be undone."
                : "It hasn't been imported yet, so no account balance or report is affected. This can't be undone from here."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDeleteOpen(false)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void handleDelete()} disabled={deleting}>
              {deleting ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
              Delete transaction
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
