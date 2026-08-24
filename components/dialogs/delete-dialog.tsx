"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

export interface DeleteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  itemName?: string;
  onConfirm: () => void;
  loading?: boolean;
}

/** Destructive confirmation — when `itemName` is provided, the user must retype it exactly before the
 *  delete button enables. Use for irreversible actions (delete account, remove connected bank, etc). */
export function DeleteDialog({ open, onOpenChange, title, description, itemName, onConfirm, loading }: DeleteDialogProps) {
  const [confirmText, setConfirmText] = React.useState("");
  const requiresTyping = !!itemName;
  const canDelete = !requiresTyping || confirmText === itemName;

  function handleOpenChange(next: boolean) {
    if (!next) setConfirmText("");
    onOpenChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {requiresTyping && (
          <div className="flex flex-col gap-1.5">
            <label className="text-sm text-muted-foreground">
              Type <span className="font-medium text-foreground">{itemName}</span> to confirm
            </label>
            <Input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoComplete="off" />
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={loading || !canDelete}>
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
