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
import type { Account } from "@/lib/models/account";
import type { Category } from "@/lib/models/category";
import type { CreditCardProfile } from "@/lib/models/credit-card";
import type { Person } from "@/lib/models/person";
import { buildDestinationOptions, isSplitReady, resolveImportDestination, resolvePersonAssignment, type CandidateImportDraft } from "../lib/candidate-details-view";
import type { CandidatePersonAssignment } from "../lib/import-candidate";
import { CandidatePersonSplitEditor } from "./candidate-person-split-editor";

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
  selectedCount,
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
  selectedCount: number;
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
  const [destinationKey, setDestinationKey] = useState<string | null>(null);
  const [personSplitDraft, setPersonSplitDraft] = useState(EMPTY_PERSON_SPLIT_DRAFT);

  const destinationOptions = buildDestinationOptions(accounts, creditCards);
  const categoryOptions = categories.filter((c) => (direction === "credit" ? c.type !== "expense" : c.type !== "income"));
  const showPersonSplit = direction === "debit";
  const ready = categoryId != null && destinationKey != null && (!showPersonSplit || isSplitReady(personSplitDraft));

  function handleOpenChange(next: boolean) {
    if (!next) {
      setCategoryId(null);
      setDestinationKey(null);
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
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Import {selectedCount} transaction{selectedCount === 1 ? "" : "s"}</DialogTitle>
          <DialogDescription>
            Choose a category and destination account — every selected transaction will be imported with these.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">Category *</label>
            <Select value={categoryId ?? undefined} onValueChange={setCategoryId}>
              <SelectTrigger className="w-full">
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
            <Select value={destinationKey ?? undefined} onValueChange={setDestinationKey}>
              <SelectTrigger className="w-full">
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
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={busy || !ready}>
            {busy && <Loader2 className="size-3.5 animate-spin" />}
            Import
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
