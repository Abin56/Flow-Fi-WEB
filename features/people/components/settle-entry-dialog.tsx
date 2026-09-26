"use client";

import { useState } from "react";
import { FormDialog, FLAT_INPUT } from "@/components/finance";
import { formatCurrency } from "@/lib/format";
import type { LedgerEntryType, Person } from "@/lib/models/person";
import type { PersonActivityItem } from "@/features/people/hooks/use-people-data";
import { cn } from "@/lib/utils";

/** "I borrowed X" settles by "I repaid"; "I gave X" settles by "Received back". */
function settlementTypeFor(entryType: LedgerEntryType): Extract<LedgerEntryType, "repaid" | "receivedBack"> {
  return entryType === "borrowed" ? "repaid" : "receivedBack";
}

/**
 * Settles a specific "gave"/"borrowed" ledger entry, partially or in full — opened by clicking that
 * individual transaction in the person's ledger (not from the general Add Transaction flow, where
 * "I repaid"/"Received back" no longer appear as choices). Records a new `LedgerEntry` of type
 * "repaid"/"receivedBack" with `parentEntryId` set to `entry.id`, so it settles only this one
 * transaction — every other "gave"/"borrowed" entry for the person is untouched.
 */
export function SettleEntryDialog({
  open,
  onOpenChange,
  person,
  entry,
  onSettle,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  person: Person | null;
  entry: PersonActivityItem | null;
  onSettle: (params: { type: "repaid" | "receivedBack"; amount: number; date: Date; parentEntryId: string }) => Promise<void>;
}) {
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open && entry?.remainingAmount != null) {
      setAmount(entry.remainingAmount.toFixed(2));
      setDate(new Date().toISOString().slice(0, 10));
      setError(null);
    }
  }

  if (!person || !entry || entry.remainingAmount == null) return null;

  const remaining = entry.remainingAmount;

  async function handleConfirm() {
    if (!person || !entry || entry.remainingAmount == null) return;
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) {
      setError("Enter an amount greater than 0.");
      return;
    }
    if (value > entry.remainingAmount) {
      setError(`Can't exceed the remaining ${formatCurrency(entry.remainingAmount)}.`);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await onSettle({ type: settlementTypeFor(entry.entryType), amount: value, date: new Date(date), parentEntryId: entry.id });
      onOpenChange(false);
    } catch {
      // toasted by caller
    } finally {
      setSaving(false);
    }
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Settle Transaction"
      description={`Settling ${entry.description} — ${formatCurrency(remaining)} remaining.`}
      onConfirm={() => void handleConfirm()}
      confirmLabel={saving ? "Recording…" : "Record Settlement"}
      loading={saving}
      contentClassName="sm:max-w-sm"
    >
      <div className="flex flex-col gap-3 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Amount</span>
          <div className="relative">
            <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm font-semibold text-primary-accent-text">₹</span>
            <input
              type="number"
              className={cn(FLAT_INPUT, "pl-7")}
              placeholder="0.00"
              max={remaining}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          <span className="text-xs text-muted-foreground">Up to {formatCurrency(remaining)} remaining on this transaction.</span>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Date</span>
          <input type="date" className={FLAT_INPUT} value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        {error && <p className="text-xs text-expense">{error}</p>}
      </div>
    </FormDialog>
  );
}
