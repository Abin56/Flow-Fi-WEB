"use client";

import { useState } from "react";
import { Copy, Lock, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { Category } from "@/lib/models/category";
import type { GridRow } from "../../lib/grid-types";

/**
 * Grid-agnostic row management, grouped in the Inspector now that Category/
 * Notes/Include/row-menu no longer have grid columns of their own (the grid
 * was simplified to No/Date/Merchant/Amount/Action/Status). Sits below
 * whichever action-specific panel `RightSidebar` renders (RowDetailsPanel/
 * TransferInspector/etc.) since these fields apply regardless of the row's
 * flow type.
 *
 * `onChangeCategory`/`onChangeNotes`/`onDelete` are committed-vs-staged-aware
 * in the caller (`RightSidebar`) — this component itself doesn't know or
 * care which write path they use, it just calls them.
 */
export function RowManagementPanel({
  row,
  categories,
  isCommitted,
  accountDisplay,
  onToggleInclude,
  onChangeCategory,
  onChangeNotes,
  onDuplicate,
  onDelete,
  deleteDisabled = false,
}: {
  row: GridRow;
  categories: Category[];
  /** Whether this row has already been committed to a real `transactions/{id}` doc — disables Include (a staging-only concept post-commit) and adjusts the delete-confirm copy. */
  isCommitted: boolean;
  /** The account to show — the real committed transaction's account for a committed row, the statement's import account otherwise. */
  accountDisplay: string;
  onToggleInclude: (include: boolean) => void;
  onChangeCategory: (category: string) => void;
  onChangeNotes: (notes: string) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  /** True while a committed row's real `Transaction` is still loading — Delete needs it to reverse the balance effect safely. */
  deleteDisabled?: boolean;
}) {
  const [notesDraft, setNotesDraft] = useState(row.notes);
  const [confirmOpen, setConfirmOpen] = useState(false);

  function commitNotes() {
    if (notesDraft !== row.notes) onChangeNotes(notesDraft);
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface px-4 py-3">
      <div>
        <Label className="mb-1.5 block text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">Category</Label>
        <Select value={row.category ?? undefined} onValueChange={onChangeCategory}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Uncategorized" />
          </SelectTrigger>
          <SelectContent>
            {categories
              .filter((category) => (row.direction === "credit" ? category.type !== "expense" : category.type !== "income"))
              .map((category) => (
                <SelectItem key={category.id} value={category.name}>
                  {category.name}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
      </div>

      <div>
        <Label className="mb-1.5 block text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">Account</Label>
        <div className="flex h-9 items-center justify-between rounded-md border border-input bg-muted/40 px-2.5 text-sm text-muted-foreground">
          <span className="truncate">{accountDisplay}</span>
          <Lock className="size-3 shrink-0 opacity-60" aria-hidden />
        </div>
      </div>

      <div>
        <Label className="mb-1.5 block text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">Notes</Label>
        <Textarea
          value={notesDraft}
          placeholder="Add a note… (markdown supported)"
          className="min-h-16 text-sm"
          onChange={(e) => setNotesDraft(e.target.value)}
          onBlur={commitNotes}
        />
      </div>

      <label className={cn("flex items-center gap-2 text-sm text-foreground", isCommitted && "opacity-50")}>
        <Checkbox checked={row.include} disabled={isCommitted} onCheckedChange={(checked) => onToggleInclude(checked === true)} />
        Include in totals
      </label>
      {isCommitted && (
        <p className="-mt-2 text-[11px] text-muted-foreground">
          Already imported — open transaction controls or the Transactions page to exclude it from totals instead.
        </p>
      )}

      <div className="flex items-center gap-2 border-t border-border pt-3">
        <Button variant="outline" size="sm" className="flex-1" onClick={onDuplicate}>
          <Copy /> Duplicate
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="flex-1 text-danger hover:bg-danger/10 hover:text-danger"
          disabled={deleteDisabled}
          onClick={() => setConfirmOpen(true)}
        >
          <Trash2 /> Delete
        </Button>
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this transaction?</DialogTitle>
            <DialogDescription>
              &ldquo;{row.counterpartyNormalized ?? row.counterpartyRaw}&rdquo; will be permanently removed.{" "}
              {isCommitted
                ? "This reverses its effect on your account balance — this can't be undone."
                : "It hasn't been imported yet, so no account balance or report is affected. This can't be undone from here."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmOpen(false);
                onDelete();
              }}
            >
              Delete row
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
