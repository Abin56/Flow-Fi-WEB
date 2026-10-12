"use client";

/**
 * Add Transaction → Transfer between my own accounts: the optional fee / payment-app inputs, the "what this
 * will do" preview, and (for a saved transfer) the linked-records summary shown on either leg or its fee.
 * Display only — every figure comes from `transfer-effect.ts`, which previews exactly what
 * `TransactionRepository.createTransferPairAtomic` writes.
 */

import type { ReactNode } from "react";
import { AlertTriangle, ArrowRight, Link2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { formatCurrencyPrecise } from "@/lib/format";
import { choiceClass } from "@/features/loans/components/loan-emi-ui";
import type { Account } from "@/lib/models/account";
import type { Transaction } from "@/lib/models/transaction";
import type { TransferEffect, TransferFeeChargedTo } from "@/features/transactions/lib/transfer-effect";
import { TxnFieldRow as FormRow } from "./transaction-form-ui";

const FIELD = "h-10 rounded-[8px] bg-card";

const isCreditCard = (a: Account | undefined) => a?.type === "card";

/** Fee (optional) · Via app (optional); with a fee, who paid it and its category. */
export function TransferFeeFields({
  fee,
  onFeeChange,
  chargedTo,
  onChargedToChange,
  viaApp,
  onViaAppChange,
  feeCategoryPicker,
  source,
  feeError,
}: {
  fee: string;
  onFeeChange: (v: string) => void;
  chargedTo: TransferFeeChargedTo;
  onChargedToChange: (v: TransferFeeChargedTo) => void;
  viaApp: string;
  onViaAppChange: (v: string) => void;
  /** The modal's own category picker, already bound to the fee category. */
  feeCategoryPicker: ReactNode;
  source: Account | undefined;
  feeError: string | null;
}) {
  const hasFee = Number(fee) > 0;
  return (
    <div className="flex flex-col gap-2.5">
      <div className="grid grid-cols-2 gap-2.5">
        <FormRow label="Fee (optional)" field="fee" error={feeError}>
          <Input
            aria-label="Transfer fee"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            value={fee}
            onChange={(e) => {
              const next = e.target.value;
              if (next === "" || /^\d*\.?\d*$/.test(next)) onFeeChange(next);
            }}
            className={FIELD}
          />
        </FormRow>
        <FormRow label="Via app (optional)">
          <Input aria-label="Payment app" placeholder="e.g. CRED, PayZapp" value={viaApp} onChange={(e) => onViaAppChange(e.target.value)} className={FIELD} />
        </FormRow>
      </div>
      {hasFee && (
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-xs font-semibold text-foreground/80">How was the fee taken?</span>
            <div role="radiogroup" aria-label="How was the fee taken" className="grid grid-cols-2 gap-1.5">
              {(
                [
                  ["source", isCreditCard(source) ? "Added to card" : "Extra from source"],
                  ["destination", "Cut from amount received"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={chargedTo === value}
                  tabIndex={chargedTo === value ? 0 : -1}
                  onClick={() => onChargedToChange(value)}
                  className={cn("min-h-10 rounded-[6px] border px-2 py-1.5 text-left text-xs leading-tight", choiceClass(chargedTo === value))}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <FormRow label="Fee category *" field="feeCategory">
            {feeCategoryPicker}
          </FormRow>
        </div>
      )}
    </div>
  );
}

function PreviewLine({ label, value, tone }: { label: ReactNode; value: ReactNode; tone?: "out" | "in" | "muted" }) {
  return (
    <li className="flex items-baseline justify-between gap-3">
      <span className="min-w-0 truncate text-foreground/80">{label}</span>
      <span className={cn("shrink-0 font-semibold tabular-nums", tone === "out" ? "text-expense" : tone === "in" ? "text-success" : "text-foreground")}>{value}</span>
    </li>
  );
}

/** "What this will do" — each account's change, the fee, and what stays untouched. */
export function TransferEffectPreview({ effect, source, destination }: { effect: TransferEffect; source: Account | undefined; destination: Account | undefined }) {
  if (effect.sourceOut <= 0 || !source || !destination) return null;
  const fromCard = isCreditCard(source);
  const feeAccount = effect.feeAccount === "source" ? source : effect.feeAccount === "destination" ? destination : null;
  return (
    <div data-testid="transfer-preview" className="flex flex-col gap-2 rounded-[10px] border border-border bg-secondary/50 px-3 py-2.5 text-xs">
      <p className="font-semibold text-foreground">What this will record</p>
      <ul className="flex flex-col gap-1">
        <PreviewLine
          label={fromCard ? `${source.name} · added to card dues` : `${source.name} · sent`}
          value={`${fromCard ? "+" : "−"}${formatCurrencyPrecise(effect.sourceOut)}`}
          tone="out"
        />
        <PreviewLine label={`${destination.name} · received`} value={`+${formatCurrencyPrecise(effect.destinationIn)}`} tone="in" />
        {feeAccount && <PreviewLine label={`Fee · expense on ${feeAccount.name}`} value={formatCurrencyPrecise(effect.fee)} />}
        {fromCard && effect.availableAfter != null && (
          <PreviewLine label="Card available credit after" value={formatCurrencyPrecise(effect.availableAfter)} tone="muted" />
        )}
      </ul>
      <p className="text-[11px] leading-snug text-foreground/70">
        Not income and not spending — money moved between your own accounts.{" "}
        {effect.fee > 0 ? `Only the ${formatCurrencyPrecise(effect.fee)} fee counts in My Spend and lowers Net Worth.` : "Net Worth doesn't change."}
      </p>
      {effect.exceedsAvailableCredit && (
        <p role="status" className="flex items-start gap-1.5 rounded-[6px] bg-warning/10 px-2 py-1.5 text-[11px] font-medium text-foreground">
          <AlertTriangle className="mt-px size-3.5 shrink-0 text-warning" />
          This is more than the card&apos;s available credit. Check the amount — if the card really was charged this much, it will be saved as entered.
        </p>
      )}
    </div>
  );
}

/** On a saved transfer leg or its fee: where the money came from and went, and every linked record. */
export function LinkedTransferSummary({
  legs,
  fee,
  accounts,
  current,
}: {
  legs: Transaction[];
  fee: Transaction | null;
  accounts: Account[];
  current: Transaction;
}) {
  const out = legs.find((t) => t.type === "expense");
  const inn = legs.find((t) => t.type === "income");
  const name = (id: string | undefined) => accounts.find((a) => a.id === id)?.name ?? "Unknown account";
  if (!out && !inn) return null;
  const principal = (out ?? inn)!.amount;
  const date = (out ?? inn)!.dateTime;
  return (
    <div data-testid="linked-transfer" className="flex flex-col gap-1.5 rounded-[10px] border border-border bg-secondary/50 px-3 py-2.5 text-xs">
      <p className="flex items-center gap-1.5 font-semibold text-foreground">
        <Link2 className="size-3.5" /> {current.transferFeeForId != null ? "Fee for a transfer" : "Linked transfer"}
      </p>
      <p className="flex flex-wrap items-center gap-1.5 text-foreground/85">
        <span className="font-medium">{out ? name(out.accountId) : "—"}</span>
        <ArrowRight className="size-3" />
        <span className="font-medium">{inn ? name(inn.accountId) : "—"}</span>
        <span className="text-foreground/60">·</span>
        <span className="font-semibold tabular-nums">{formatCurrencyPrecise(principal)}</span>
        <span className="text-foreground/60">· {date.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}</span>
      </p>
      {fee && (
        <p className="text-foreground/75">
          Fee {formatCurrencyPrecise(fee.amount)} · expense on {name(fee.accountId)}
          {fee.deletedAt != null && " (reversed)"}
        </p>
      )}
      {legs.length < 2 && current.transferFeeForId == null && <p className="text-foreground/70">The other side of this transfer isn&apos;t in the loaded list.</p>}
    </div>
  );
}
