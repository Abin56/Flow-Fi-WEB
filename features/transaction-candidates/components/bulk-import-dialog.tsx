"use client";

/**
 * The "Import selected" popup for the SMS candidates workspace's bulk-action bar — replaces the
 * old inline Category-only `Select` in `BulkActionsBar`, which silently sent every candidate
 * through with its OWN (often unresolved) `accountId`/`cardId`. A candidate whose destination
 * Android couldn't match then failed `importCandidate`'s validation with no way to fix it from the
 * bulk flow, surfacing only as the confusing "still pending, try again" toast. This popup asks for
 * one Category and one Account/Card up front — same fields `CandidateDetailsModal` asks for on a
 * single candidate — and applies both to the whole selection via `bulkImportCandidates`'s
 * `forcedDestination` param, so every selected row (e.g. "Food", "Travel") lands in the chosen
 * category/account in one action instead of failing on unresolved destinations.
 *
 * For an expense (debit) selection, also offers the same "Assign to a person" / "Split this
 * expense" editor `CandidateDetailsModal` offers a single candidate (`CandidatePersonSplitEditor`,
 * shared rather than duplicated) — the resolved `CandidatePersonAssignment` is applied to every
 * candidate in the batch via `bulkImportCandidates`'s `personAssignment` param. Never shown for an
 * income (credit) selection, same rule the single-candidate popup follows. Since bulk selection is
 * already locked to one direction (see the workspace's `selectionDirection`), there's no per-row
 * mixing to worry about here.
 */

import { useState } from "react";
import { Loader2, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SectionCard } from "@/components/finance/transaction-details-shell";
import { formatCurrencyPrecise } from "@/lib/format";
import { AlertTriangle } from "lucide-react";
import type { SmsTransactionCandidate } from "@/lib/models/sms-transaction-candidate";
import type { Account } from "@/lib/models/account";
import type { Category } from "@/lib/models/category";
import type { CreditCardProfile } from "@/lib/models/credit-card";
import type { Person } from "@/lib/models/person";
import {
  buildDestinationOptions,
  categoryOptionsForDirection,
  isSplitReady,
  resolveImportDestination,
  resolvePersonAssignment,
  type CandidateImportDraft,
} from "../lib/candidate-details-view";
import type { CandidatePersonAssignment } from "../lib/import-candidate";
import { CandidatePersonSplitEditor } from "./candidate-person-split-editor";
import { handleModEnterKey } from "@/components/ui/enter-key";

export interface BulkImportSelection {
  categoryId: string;
  accountId: string | null;
  matchedCard: CreditCardProfile | null;
  personAssignment: CandidatePersonAssignment | null;
}

const EMPTY_PERSON_SPLIT_DRAFT: Pick<CandidateImportDraft, "personId" | "owesPersonToggle" | "splitOpen" | "splitType" | "participants"> = {
  personId: null,
  owesPersonToggle: false,
  splitOpen: false,
  splitType: "equal",
  participants: [{ personId: null, name: "", value: "" }],
};

export function BulkImportDialog({
  open,
  onOpenChange,
  candidates,
  groupLabel,
  defaultDestinationKey,
  categories,
  accounts,
  creditCards,
  people,
  onCreatePerson,
  busy,
  onConfirm,
  direction,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Exactly the rows this import will write — the visible, compatible selection, never a hidden or stale id. */
  candidates: SmsTransactionCandidate[];
  /** Where Android matched these rows (or the raw hint when it matched nothing) — shown so the destination is never a surprise. */
  groupLabel: string;
  /** Android’s own resolved destination for these rows, pre-selected (and visible) so the reviewer confirms it; `null` when unresolved — then nothing is pre-selected. */
  defaultDestinationKey: string | null;
  categories: Category[];
  accounts: Account[];
  creditCards: CreditCardProfile[];
  people: Person[];
  onCreatePerson: (name: string) => Promise<Person>;
  busy: boolean;
  onConfirm: (selection: BulkImportSelection) => void;
  /** The selection's locked direction (see the workspace's `selectionDirection`) — `null` only when
   *  nothing is selected, in which case every category is offered since there's nothing to scope to yet. */
  direction: "debit" | "credit" | null;
}) {
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [destinationOverride, setDestinationOverride] = useState<string | null>(null);
  const destinationKey = destinationOverride ?? defaultDestinationKey;
  const selectedCount = candidates.length;
  const total = candidates.reduce((sum, c) => sum + c.amount, 0);
  const [personSplitDraft, setPersonSplitDraft] = useState(EMPTY_PERSON_SPLIT_DRAFT);

  const destinationOptions = buildDestinationOptions(accounts, creditCards);
  const categoryOptions = categoryOptionsForDirection(categories, direction);
  const overridesAndroidMatch = defaultDestinationKey != null && destinationKey !== defaultDestinationKey;
  const destinationLabel = destinationOptions.find((o) => o.key === destinationKey)?.label ?? "the chosen destination";
  const showPersonSplit = direction === "debit";
  const ready = categoryId != null && destinationKey != null && (!showPersonSplit || isSplitReady(personSplitDraft));

  function handleOpenChange(next: boolean) {
    if (!next) {
      setCategoryId(null);
      setDestinationOverride(null);
      setPersonSplitDraft(EMPTY_PERSON_SPLIT_DRAFT);
    }
    onOpenChange(next);
  }

  function handleConfirm() {
    if (!ready) return;
    const { accountId, matchedCard } = resolveImportDestination(destinationKey, creditCards);
    const personAssignment = showPersonSplit ? resolvePersonAssignment(personSplitDraft, people) : null;
    onConfirm({ categoryId, accountId, matchedCard, personAssignment });
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent onKeyDown={(e) => handleModEnterKey(e, handleConfirm, { enabled: !busy && ready })}>
        <DialogHeader>
          <DialogTitle>Import {selectedCount} transaction{selectedCount === 1 ? "" : "s"}</DialogTitle>
          <DialogDescription>
            Every transaction listed below is imported with the category and account you confirm here. Nothing else is touched.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          <div className="rounded-lg border border-foreground/12 bg-muted/30 p-3 text-xs" data-testid="bulk-import-rows">
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-medium text-foreground">
                {selectedCount} {direction === "credit" ? "income" : "expense"} transaction{selectedCount === 1 ? "" : "s"} · {formatCurrencyPrecise(total)}
              </span>
              <span className="truncate text-muted-foreground">{groupLabel}</span>
            </div>
            <ul className="mt-2 max-h-32 space-y-1 overflow-y-auto">
              {candidates.map((c) => (
                <li key={c.id} className="flex justify-between gap-3 text-muted-foreground">
                  <span className="truncate">
                    {c.transactionDate.toLocaleDateString("en-IN", { day: "2-digit", month: "short" })} · {c.merchant ?? c.bankName ?? "Unknown"}
                  </span>
                  <span className="shrink-0 tabular-nums">{formatCurrencyPrecise(c.amount)}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">Category *</label>
            <Select value={categoryId ?? undefined} onValueChange={setCategoryId}>
              <SelectTrigger className="h-11 w-full lg:h-9">
                <SelectValue placeholder="Select a category" />
              </SelectTrigger>
              <SelectContent>
                {categoryOptions.map((category) => (
                  <SelectItem key={category.id} value={category.id}>
                    {category.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">Account / Card *</label>
            <Select value={destinationKey ?? undefined} onValueChange={setDestinationOverride}>
              <SelectTrigger className="h-11 w-full lg:h-9">
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
            {overridesAndroidMatch && (
              <p className="flex items-start gap-1.5 text-[11px] text-warning-foreground" role="alert">
                <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                Android matched these messages to {groupLabel}. Importing them into {destinationLabel} overrides that for all {selectedCount}.
              </p>
            )}
          </div>

          {showPersonSplit && (
            <SectionCard icon={Users} title="People & Split">
              <CandidatePersonSplitEditor
                draft={personSplitDraft}
                onChange={(patch) => setPersonSplitDraft({ ...personSplitDraft, ...patch })}
                people={people}
                onCreatePerson={onCreatePerson}
              />
            </SectionCard>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" className="h-11 lg:h-9" onClick={() => handleOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button className="h-11 lg:h-9" onClick={handleConfirm} disabled={busy || !ready}>
            {busy && <Loader2 className="size-3.5 animate-spin" />}
            Import {selectedCount}
            <kbd className="ml-1 hidden rounded border border-current/30 px-1 font-mono text-[10px] opacity-70 sm:inline">Ctrl+Enter</kbd>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
