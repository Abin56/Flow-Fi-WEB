"use client";

import { useState } from "react";
import { formatCurrency } from "@/lib/format";
import type { LedgerEntryType } from "@/lib/models/person";
import type { PersonActivityItem } from "@/features/people/hooks/use-people-data";
import { cn } from "@/lib/utils";
import { ModeFooter, ModeHeader, MoneyInput, WS_FIELD, WS_GHOST, WS_PAD, WS_PRIMARY, WsField, WsLabel } from "./person-workspace-ui";

/** "I borrowed X" settles by "I repaid"; "I gave X" settles by "Received back". */
function settlementTypeFor(entryType: LedgerEntryType): Extract<LedgerEntryType, "repaid" | "receivedBack"> {
  return entryType === "borrowed" ? "repaid" : "receivedBack";
}

export interface SettleEntryParams {
  type: "repaid" | "receivedBack";
  amount: number;
  date: Date;
  parentEntryId: string;
}

/**
 * Settles one specific "gave"/"borrowed" ledger entry, partially or in full — opened from that
 * transaction in the Person workspace's activity feed. Records a new `LedgerEntry` of type
 * "repaid"/"receivedBack" with `parentEntryId` set to `entry.id`, so it settles only this one
 * transaction — every other "gave"/"borrowed" entry for the person is untouched.
 */
export function SettleEntryMode({
  personName,
  entry,
  onBack,
  onSettle,
}: {
  personName: string;
  entry: PersonActivityItem;
  onBack: () => void;
  onSettle: (params: SettleEntryParams) => Promise<void>;
}) {
  const remaining = entry.remainingAmount ?? 0;
  const [amount, setAmount] = useState(() => remaining.toFixed(2));
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const firstName = personName.split(" ")[0];
  const direction = entry.entryType === "borrowed" ? `Money you repay ${firstName}` : `Money ${firstName} pays you back`;

  async function handleConfirm(e: React.FormEvent) {
    e.preventDefault();
    if (entry.remainingAmount == null || saving) return;
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
    } catch {
      // toasted by caller
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleConfirm} className="flex min-h-full flex-col">
      <ModeHeader backLabel={personName} onBack={onBack} title="Settle this entry" subtitle={`${entry.description} · ${entry.date}`} />

      <div className={cn(WS_PAD, "mt-5 flex-1")}>
        <div className="flex items-baseline justify-between gap-4 border-y border-border py-2.5 text-sm">
          <span className="text-muted-foreground">Original amount</span>
          <span className="font-medium text-foreground tabular-nums">{formatCurrency(entry.amount)}</span>
        </div>
        <div className="flex items-baseline justify-between gap-4 border-b border-border py-2.5 text-sm">
          <span className="text-muted-foreground">Still open</span>
          <span className="font-semibold text-foreground tabular-nums">{formatCurrency(remaining)}</span>
        </div>

        <WsLabel className="mt-5">Settlement amount</WsLabel>
        <p className="mt-0.5 text-xs text-muted-foreground">{direction}</p>
        <div className="mt-2">
          <MoneyInput label="Settlement amount" value={amount} onChange={setAmount} invalid={!!error} autoFocus />
        </div>
        {error ? (
          <p className="mt-1.5 text-xs font-medium text-expense">{error}</p>
        ) : (
          <p className="mt-1.5 text-xs text-muted-foreground">Up to {formatCurrency(remaining)} remaining on this transaction.</p>
        )}

        <WsField label="Date" className="mt-4 max-w-[11rem]">
          <input type="date" className={WS_FIELD} value={date} onChange={(e) => setDate(e.target.value)} />
        </WsField>
      </div>

      <ModeFooter>
        <button type="button" onClick={onBack} disabled={saving} className={WS_GHOST}>
          Cancel
        </button>
        <button type="submit" disabled={saving} className={WS_PRIMARY}>
          {saving ? "Recording…" : "Record Settlement"}
        </button>
      </ModeFooter>
    </form>
  );
}
