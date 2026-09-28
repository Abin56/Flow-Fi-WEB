"use client";

import { ArrowDownLeft, ArrowUpRight } from "lucide-react";
import { useRef, useState } from "react";
import type { LedgerEntryType } from "@/lib/models/person";
import { cn } from "@/lib/utils";
import { AccountField, CompactAmountInput, InlinePanel, useAccountChoice } from "./ledger-ui";
import { WS_FIELD, WS_GHOST, WS_PRIMARY, WsField, WsSegmented } from "./person-workspace-ui";

export type AddEntryType = Extract<LedgerEntryType, "gave" | "borrowed">;

export interface AddEntryParams {
  type: AddEntryType;
  amount: number;
  date: Date;
  note?: string;
  /** The account the entry's cash leg posts to (a real Transaction — see `addLedgerEntryWithTransaction`). */
  accountId: string;
}

/**
 * Add transaction — expands inline in the Person workspace, right under its actions. Only the two
 * debt-opening types: "I repaid"/"Received back" are settlements, reached from Settle or from an
 * individual transaction. Also posts a real Transaction on the chosen account, so the entry shows up in
 * Transactions, Accounts, Month Cycle and Dashboard.
 */
export function AddEntryPanel({
  personName,
  onCancel,
  onSave,
  saveLabel = "Save",
}: {
  personName: string;
  onCancel: () => void;
  onSave: (params: AddEntryParams) => Promise<void>;
  saveLabel?: string;
}) {
  const [type, setType] = useState<AddEntryType | null>(null);
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const account = useAccountChoice();
  const amountRef = useRef<HTMLInputElement>(null);
  const firstName = personName.split(" ")[0];

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    if (!type) {
      setError("Choose “I gave” or “I borrowed”.");
      return;
    }
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) {
      setError("Amount must be greater than 0.");
      return;
    }
    if (!account.accountId) {
      setError("Select an account.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave({ type, amount: value, date: new Date(date), note: note || undefined, accountId: account.accountId });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="max-w-3xl">
      <InlinePanel
        title="Add transaction"
        subtitle={type === "gave" ? `${firstName} will owe you this` : type === "borrowed" ? `You will owe ${firstName} this` : `What happened with ${firstName}?`}
        onClose={onCancel}
        footer={
          <>
            <button type="button" onClick={onCancel} disabled={saving} className={WS_GHOST}>
              Cancel
            </button>
            <button type="submit" disabled={saving} className={WS_PRIMARY}>
              {saving ? "Saving…" : saveLabel}
            </button>
          </>
        }
      >
        <WsSegmented
          label="Transaction type"
          value={type ?? ("" as AddEntryType)}
          onChange={(next) => {
            setType(next);
            if (error) setError(null);
            requestAnimationFrame(() => amountRef.current?.focus());
          }}
          options={[
            { value: "gave", label: "I gave", icon: ArrowUpRight },
            { value: "borrowed", label: "I borrowed", icon: ArrowDownLeft },
          ]}
          className="max-w-sm"
        />
        {!type && <p className="mt-1.5 text-xs text-muted-foreground">Choose one to continue.</p>}

        {/* Amount · Date · Account on one row, Description full width below — no single stretched field */}
        <div className="mt-3.5 grid gap-3 sm:grid-cols-[9rem_10rem_minmax(0,1fr)] sm:items-end">
          <WsField label="Amount">
            <CompactAmountInput
              inputRef={amountRef}
              label="Amount"
              value={amount}
              onChange={(v) => {
                setAmount(v);
                if (error) setError(null);
              }}
              invalid={!!error && !!type}
            />
          </WsField>
          <WsField label="Date">
            <input type="date" className={WS_FIELD} value={date} onChange={(e) => setDate(e.target.value)} />
          </WsField>
          <AccountField choice={account} />
          <WsField label="Description" className="sm:col-span-3">
            <input className={WS_FIELD} placeholder="e.g. Dinner, cab" value={note} onChange={(e) => setNote(e.target.value)} />
          </WsField>
        </div>
        <p className={cn("mt-1.5 min-h-4 text-xs font-medium text-expense", !error && "invisible")} role="alert">
          {error}
        </p>
      </InlinePanel>
    </form>
  );
}
