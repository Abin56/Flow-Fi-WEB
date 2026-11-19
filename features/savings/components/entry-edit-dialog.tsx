"use client";

import { useState } from "react";
import { FormDialog } from "@/components/finance";
import { formatCurrency } from "@/lib/format";
import { SAVINGS_EPSILON, UNLINKED, round2, type EntryView, type GoalView } from "@/lib/engines/savings-goals";
import { userFacingMessage } from "@/features/transactions/lib/error-toast";

const FIELD = "clay-pressed h-10 w-full rounded-xl px-3 text-sm outline-none";

/** Edit one entry: its note always; the amount only for a set-aside (a real transfer's legs stay locked). */
function EntryEditInner({
  open,
  onOpenChange,
  view,
  entry,
  accountFree,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  view: GoalView | null;
  entry: EntryView | null;
  /** Free money in the entry's account (for raising a set-aside). */
  accountFree: number;
  onSubmit: (patch: { note?: string; amount?: number }) => Promise<void>;
}) {
  const [amount, setAmount] = useState(entry ? String(entry.entry.amount) : "");
  const [note, setNote] = useState(entry?.entry.note ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const earmark = entry?.entry.mode === "earmark";

  if (!view || !entry) return null;

  async function submit() {
    if (!view || !entry) return;
    const next = Number(amount);
    const patch: { note?: string; amount?: number } = {};
    if (note.trim() !== entry.entry.note) patch.note = note.trim();
    if (earmark && Number.isFinite(next) && Math.abs(next - entry.entry.amount) > SAVINGS_EPSILON) {
      if (!(next > 0) || Math.abs(round2(next) - next) > 1e-9) return setError("Enter an amount greater than 0 with at most 2 decimals.");
      const delta = next - entry.entry.amount;
      if (entry.entry.direction === "in") {
        if (delta > 0 && delta > accountFree + SAVINGS_EPSILON) return setError(`Only ${formatCurrency(accountFree)} more is free in this account.`);
        if (delta < 0) {
          const held = view.heldByAccount.get(entry.entry.accountId ?? UNLINKED) ?? 0;
          if (held + delta < -SAVINGS_EPSILON || view.saved + delta < -SAVINGS_EPSILON) return setError("A later withdrawal already used this money.");
        }
      } else {
        const held = view.heldByAccount.get(entry.entry.accountId ?? UNLINKED) ?? 0;
        if (delta > 0 && (delta > held + SAVINGS_EPSILON || delta > view.saved + SAVINGS_EPSILON)) return setError("The goal doesn't hold that much.");
      }
      patch.amount = round2(next);
    }
    if (Object.keys(patch).length === 0) return onOpenChange(false);
    setBusy(true);
    setError(null);
    try {
      await onSubmit(patch);
      onOpenChange(false);
    } catch (e) {
      setError(userFacingMessage(e) ?? "Couldn't save — please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <FormDialog open={open} onOpenChange={onOpenChange} title="Edit entry" description={earmark ? "Changing a set-aside amount moves no money." : "This entry is backed by a real transfer, so only the note can change. To change the amount, undo it and add it again."} onConfirm={submit} loading={busy} confirmLabel="Save" contentClassName="sm:max-w-sm">
      <div className="flex flex-col gap-3 text-sm" data-testid="savings-entry-edit">
        {earmark && (
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Amount</span>
            <input aria-label="Entry amount" className={`${FIELD} font-mono font-semibold`} inputMode="decimal" value={amount} onChange={(e) => (e.target.value === "" || /^\d*\.?\d{0,2}$/.test(e.target.value)) && setAmount(e.target.value)} />
          </label>
        )}
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Note</span>
          <input aria-label="Entry note" className={FIELD} maxLength={120} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        {error && <p role="alert" className="rounded-xl bg-expense/10 px-3 py-2 text-xs font-medium text-expense">{error}</p>}
      </div>
    </FormDialog>
  );
}

export function EntryEditDialog(props: Parameters<typeof EntryEditInner>[0]) {
  return props.open && props.entry ? <EntryEditInner key={props.entry.entry.id} {...props} /> : null;
}
