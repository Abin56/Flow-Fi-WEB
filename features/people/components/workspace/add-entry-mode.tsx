"use client";

import { ArrowDownLeft, ArrowUpRight, type LucideIcon } from "lucide-react";
import { useRef, useState } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Account } from "@/lib/models/account";
import type { LedgerEntryType } from "@/lib/models/person";
import { cn } from "@/lib/utils";
import { ChoiceCard, ModeFooter, ModeHeader, MoneyInput, WS_FIELD, WS_GHOST, WS_PAD, WS_PRIMARY, WS_SELECT_TRIGGER, WsField, WsLabel } from "./person-workspace-ui";

export type AddEntryType = Extract<LedgerEntryType, "gave" | "borrowed">;

export interface AddEntryParams {
  type: AddEntryType;
  amount: number;
  date: Date;
  note?: string;
  accountId: string;
}

/**
 * Only the two debt-opening types — "I repaid"/"Received back" are settlement actions, reachable only
 * from an individual "gave"/"borrowed" transaction (see `SettleEntryMode`), not from the general Add flow.
 */
const OPTIONS: { value: AddEntryType; label: string; description: (name: string) => string; icon: LucideIcon; iconClassName: string }[] = [
  {
    value: "gave",
    label: "I gave",
    description: (name) => `Money I gave to ${name}`,
    icon: ArrowUpRight,
    iconClassName: "bg-success/12 text-success",
  },
  {
    value: "borrowed",
    label: "I borrowed",
    description: (name) => `Money I borrowed from ${name}`,
    icon: ArrowDownLeft,
    iconClassName: "bg-expense/10 text-expense",
  },
];

/**
 * Add mode — "What happened with {name}?" → Amount → Date → Save. Same validation and the same
 * `addLedgerEntry` payload the old Add Transaction dialog used; only the surface changed.
 */
export function AddEntryMode({
  personName,
  initialType,
  accounts,
  onBack,
  onSave,
}: {
  personName: string;
  initialType?: AddEntryType;
  accounts: Account[];
  onBack: () => void;
  onSave: (params: AddEntryParams) => Promise<void>;
}) {
  const [type, setType] = useState<AddEntryType | null>(initialType ?? null);
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState("");
  const [accountId, setAccountId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const amountRef = useRef<HTMLInputElement>(null);
  const firstName = personName.split(" ")[0];

  function pick(next: AddEntryType) {
    setType(next);
    requestAnimationFrame(() => amountRef.current?.focus());
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!type || saving) return;
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) {
      setError("Amount must be greater than 0.");
      return;
    }
    if (!accountId) {
      setError("Select an account.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave({ type, amount: value, date: new Date(date), note: note || undefined, accountId });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex min-h-full flex-col">
      <ModeHeader backLabel={personName} onBack={onBack} title={`What happened with ${firstName}?`} />

      <div className={cn(WS_PAD, "mt-5 flex-1")}>
        <div role="radiogroup" aria-label="Transaction type" className="grid gap-2 sm:grid-cols-2">
          {OPTIONS.map((o) => (
            <ChoiceCard
              key={o.value}
              selected={type === o.value}
              onSelect={() => pick(o.value)}
              icon={o.icon}
              iconClassName={o.iconClassName}
              title={o.label}
              description={o.description(firstName)}
            />
          ))}
        </div>

        <div
          className={cn(
            "grid transition-[grid-template-rows,opacity] duration-200 ease-out",
            type ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
          )}
          aria-hidden={!type}
        >
          <div className="overflow-hidden">
            <div className="pt-5">
              <WsLabel>Amount</WsLabel>
              <div className="mt-2">
                <MoneyInput
                  inputRef={amountRef}
                  label="Amount"
                  value={amount}
                  onChange={(v) => {
                    setAmount(v);
                    if (error) setError(null);
                  }}
                  invalid={!!error}
                />
              </div>
              {error && <p className="mt-1 text-xs font-medium text-expense">{error}</p>}

              <div className="mt-4 grid gap-3 sm:grid-cols-[11rem_1fr]">
                <WsField label="Date">
                  <input type="date" className={WS_FIELD} value={date} onChange={(e) => setDate(e.target.value)} tabIndex={type ? 0 : -1} />
                </WsField>
                <WsField label="Account">
                  <Select value={accountId} onValueChange={setAccountId}>
                    <SelectTrigger className={WS_SELECT_TRIGGER}>
                      <SelectValue placeholder="Select account" />
                    </SelectTrigger>
                    <SelectContent>
                      {accounts.map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          {a.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </WsField>
                <WsField label="Note (optional)" className="sm:col-span-2">
                  <input
                    className={WS_FIELD}
                    placeholder="e.g. Dinner, cab"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    tabIndex={type ? 0 : -1}
                  />
                </WsField>
              </div>
            </div>
          </div>
        </div>
      </div>

      <ModeFooter>
        <button type="button" onClick={onBack} className={WS_GHOST}>
          Cancel
        </button>
        <button type="submit" disabled={!type || saving} className={WS_PRIMARY}>
          {saving ? "Saving…" : "Save"}
        </button>
      </ModeFooter>
    </form>
  );
}
