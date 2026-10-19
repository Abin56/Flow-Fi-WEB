"use client";

import { AccountLabel } from "@/components/finance/account-label";
import { PaymentSourceSummary, isUnderfunded } from "@/components/finance/payment-source-summary";
import { Landmark, Trash2, Undo2 } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAccounts } from "@/hooks/use-accounts";
import type { DeleteBlock, LedgerRow } from "@/features/people/lib/person-ledger-rows";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";
import { WS_FIELD, WS_GHOST, WS_PRIMARY, WS_SELECT_TRIGGER, WsCloseButton, WsField } from "./person-workspace-ui";
import { DateInput } from "@/components/forms/date-input";
import { handleEnterAdvance } from "@/components/finance/enter-advance";

/**
 * Shared pieces of the People Ledger's inline actions and transaction management — the inline
 * reveal, the per-entry record-payment and edit forms, and the delete confirmation. Presentation only; every write goes through the callbacks the workspace passes in.
 */

/**
 * A Loan installment's action — opens that Loan, where its existing payment flow lives. People never
 * records a Loan payment itself (one payment path, so every view reads the same installment state).
 */
export function LoanPayLink({ loanId, className }: { loanId: string; className?: string }) {
  return (
    <Link
      href={`/loans?agreement=${encodeURIComponent(loanId)}`}
      onClick={(e) => e.stopPropagation()}
      className={cn(
        "flex h-7 items-center gap-1.5 rounded-full border border-border-strong bg-card px-2.5 text-xs font-semibold whitespace-nowrap text-foreground outline-none transition-colors hover:border-primary-accent-text hover:bg-primary/10 focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      <Landmark className="size-3.5 text-primary-accent-text" strokeWidth={2} />
      Pay
    </Link>
  );
}

/**
 * Expands its content in place (height + fade, ~220ms), pushing what follows down; collapses the same
 * way. Content stays mounted while collapsing and unmounts afterwards, so a reopened form starts fresh.
 * Reduced motion is honoured by the global `prefers-reduced-motion` override in `globals.css`.
 */
export function InlineReveal({ open, children, className }: { open: boolean; children: React.ReactNode; className?: string }) {
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);
  return (
    <div
      className={cn(
        "grid transition-[grid-template-rows,opacity] duration-[220ms] ease-out",
        open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        className,
      )}
      inert={!open}
      onTransitionEnd={(e) => {
        if (e.target === e.currentTarget && !open) setMounted(false);
      }}
    >
      <div className="min-h-0 overflow-hidden">{mounted && children}</div>
    </div>
  );
}

const PEOPLE_DRAWER_WIDTH = { md: "sm:max-w-[640px]", lg: "sm:max-w-[920px]", xl: "sm:max-w-[1040px]" } as const;

/**
 * Right-side drawer for a person's actions (Record payment, Add, Split, Share) — the same slide-in experience as
 * Add Transaction / Account / Card / Loan. The panel inside keeps its own header, close button and footer; the
 * drawer flattens its outer card (no margin, border or radius) so the panel *is* the drawer surface.
 */
export function PeopleDrawer({
  open,
  onOpenChange,
  title,
  width = "md",
  id,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Screen-reader title (the panel shows its own visible heading). */
  title: string;
  width?: keyof typeof PEOPLE_DRAWER_WIDTH;
  id?: string;
  children: React.ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        id={id}
        showCloseButton={false}
        overlayClassName="bg-black/20 backdrop-blur-none dark:bg-black/45"
        className={cn(
          "flex flex-col gap-0 overflow-hidden bg-card p-0",
          // One hairline all round (a ring follows the rounded corner evenly; a left-only border thins out on the curve).
          "top-0 right-0 left-auto h-dvh max-h-dvh w-full max-w-full translate-x-0 translate-y-0 rounded-none border-0 ring-1 ring-black/[0.06] dark:ring-white/10",
          "shadow-[-24px_0_60px_-20px_rgba(0,0,0,0.45)] duration-300 ease-out data-open:slide-in-from-right data-closed:slide-out-to-right data-closed:duration-200",
          "sm:rounded-l-[16px]",
          PEOPLE_DRAWER_WIDTH[width],
        )}
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <DialogDescription className="sr-only">{title}</DialogDescription>
        {/* No accent strip: each panel's own header is the top edge, so the drawer reads as one calm surface. */}
        <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain scroll-smooth scroll-pt-4 scroll-pb-24 [&>*]:mt-0! [&>*]:min-h-full [&>*]:overflow-visible! [&>*]:rounded-none! [&>*]:border-0!">
          {children}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The frame of an inline action panel — title, one line of context, a close button. */
export function InlinePanel({
  title,
  subtitle,
  onClose,
  children,
  footer,
  className,
}: {
  title: string;
  subtitle?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  footer: React.ReactNode;
  /** e.g. a max width, so a compact form stays compact on a wide workspace. */
  className?: string;
}) {
  return (
    <div className={cn("mt-4 flex flex-col overflow-hidden rounded-[8px] border border-border-strong bg-card", className)}>
      <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-border bg-card bg-gradient-to-b from-primary/20 to-card px-4 py-3.5 sm:px-5">
        <div className="min-w-0">
          <h3 className="font-heading text-base leading-tight font-semibold tracking-tight text-foreground">{title}</h3>
          {subtitle && <p className="mt-0.5 text-xs text-foreground/70">{subtitle}</p>}
        </div>
        <WsCloseButton onClick={onClose} className="-my-0.5" />
      </div>
      <div className="flex-1 px-4 pt-4 pb-4 sm:px-5">{children}</div>
      <div className="sticky bottom-0 z-10 flex items-center justify-end gap-2 border-t border-border bg-card px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-5">{footer}</div>
    </div>
  );
}

/** A 36px "₹ 0" amount field — the compact counterpart of `MoneyInput` for inline panels. */
export function CompactAmountInput({
  value,
  onChange,
  invalid,
  autoFocus,
  label,
  inputRef,
  placeholder = "0",
}: {
  value: string;
  onChange: (v: string) => void;
  invalid?: boolean;
  autoFocus?: boolean;
  label: string;
  inputRef?: React.Ref<HTMLInputElement>;
  placeholder?: string;
}) {
  return (
    <div className="relative">
      <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm font-semibold text-muted-foreground">₹</span>
      <input
        ref={inputRef}
        type="number"
        inputMode="decimal"
        step="0.01"
        min="0"
        aria-label={label}
        aria-invalid={invalid || undefined}
        autoFocus={autoFocus}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          WS_FIELD,
          "pl-7 font-semibold tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none",
        )}
      />
    </div>
  );
}

export const DELETE_BLOCK_NOTE: Record<Exclude<DeleteBlock, null>, string> = {
  expense: "Part of a split expense — change it from the expense",
  loan: "Managed from the Loan",
  emi: "Comes from a linked EMI",
  opening: "Opening balance can't be deleted",
  payment: "Paid by a recorded payment — revert that payment first",
};

/** A manual ledger entry (given/borrowed/payment/adjustment) — expense, Loan, EMI and opening rows are edited where they come from. */
export function isEditable(row: LedgerRow): boolean {
  return row.entryId != null && row.deletable;
}

export interface EntryEditValues {
  amount?: number;
  date?: Date;
  note?: string;
}

/**
 * Edit one transaction's amount, date and description in place. A given/borrowed amount can't drop
 * below what has already been settled on it; a payment's amount is fixed (undo and re-record it
 * instead) so it can never over-settle the transaction it applies to.
 */
export function EntryEditForm({
  row,
  onCancel,
  onSubmit,
}: {
  row: LedgerRow;
  onCancel: () => void;
  onSubmit: (values: EntryEditValues) => Promise<void>;
}) {
  const settled = row.state != null ? row.amount - (row.remaining ?? 0) : 0;
  const amountLocked = row.direction === "theyPaid" || row.direction === "youPaid";
  const [amount, setAmount] = useState(() => row.amount.toFixed(2));
  const [date, setDate] = useState(() => toDateInput(row.date));
  const [note, setNote] = useState(row.title);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    const value = Number(amount);
    if (!amountLocked) {
      if (!Number.isFinite(value) || value <= 0) return setError("Enter an amount greater than 0.");
      if (value < settled - 0.005) return setError(`Can't go below the ${formatCurrency(settled)} already settled.`);
    }
    if (!date) return setError("Pick a date.");
    const nextDate = new Date(`${date}T${row.date.toTimeString().slice(0, 8)}`);
    const patch: EntryEditValues = {};
    if (!amountLocked && Math.abs(value - row.amount) > 0.005) patch.amount = value;
    if (toDateInput(row.date) !== date) patch.date = nextDate;
    if (note.trim() !== row.title) patch.note = note.trim();
    if (Object.keys(patch).length === 0) return onCancel();
    setError(null);
    setSaving(true);
    try {
      await onSubmit(patch);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the changes. Please try again.");
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} onKeyDown={handleEnterAdvance} className="rounded-[8px] border border-border-strong bg-card p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <p className="text-sm font-semibold text-foreground">Edit transaction</p>
        <p className="text-xs text-muted-foreground">{row.typeLabel}{settled > 0 && ` · ${formatCurrency(settled)} already settled`}</p>
      </div>
      <div className="mt-2.5 grid gap-3 sm:grid-cols-[minmax(0,1fr)_9rem_9rem]">
        <WsField label="Description">
          <input className={WS_FIELD} value={note} onChange={(e) => setNote(e.target.value)} maxLength={120} autoFocus />
        </WsField>
        <WsField label="Amount">
          {amountLocked ? (
            <input className={cn(WS_FIELD, "opacity-60")} value={formatCurrency(row.amount)} disabled title="Undo the payment and record it again to change its amount" />
          ) : (
            <CompactAmountInput label="Amount" value={amount} onChange={setAmount} invalid={!!error} />
          )}
        </WsField>
        <WsField label="Date">
          <DateInput className={WS_FIELD} value={date} onChange={(e) => setDate(e.target.value)} />
        </WsField>
      </div>
      {error && (
        <p className="mt-1.5 text-xs font-medium text-expense" role="alert">
          {error}
        </p>
      )}
      <div className="mt-3 flex items-center justify-end gap-2">
        <button type="button" onClick={onCancel} disabled={saving} className={cn(WS_GHOST, "h-8")}>
          Cancel
        </button>
        <button type="submit" disabled={saving} className={cn(WS_PRIMARY, "h-8")}>
          {saving ? "Saving…" : "Save changes"}
        </button>
      </div>
    </form>
  );
}

function toDateInput(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * The account a manual People entry's cash leg posts to — Add and per-entry Settle post a real
 * Transaction alongside the LedgerEntry (`addLedgerEntryWithTransaction`). The account is always the user's
 * explicit choice — never a silent default — so the form stays blocked until one is picked.
 */
export function useAccountChoice(initialAccountId?: string | null) {
  const { data: allAccounts = [] } = useAccounts();
  const accounts = useMemo(() => allAccounts.filter((a) => a.deletedAt == null), [allAccounts]);
  const [picked, setPicked] = useState(initialAccountId ?? "");
  const accountId = accounts.some((a) => a.id === picked) ? picked : "";
  const selected = accounts.find((a) => a.id === accountId) ?? null;
  return { accounts, accountId, selected, setAccountId: setPicked };
}

/** The account as it will stand once an edited payment's original debit is given back (same account only). */
export function withRefund<T extends { id: string; currentBalance: number }>(account: T, refund?: { accountId: string | null; amount: number }): T {
  return refund && refund.accountId === account.id ? { ...account, currentBalance: Math.round((account.currentBalance + refund.amount) * 100) / 100 } : account;
}

export function AccountField({
  choice,
  label = "Account",
  className,
  outflow,
  refund,
}: {
  choice: ReturnType<typeof useAccountChoice>;
  label?: string;
  className?: string;
  /** Money that LEAVES this account (a payment): shows each balance and the balance after. `null` = amount not entered yet. Omit for money received. */
  outflow?: number | null;
  /** Editing a payment I made: its original debit on `accountId` is refunded first, so only the net extra is previewed. */
  refund?: { accountId: string | null; amount: number };
}) {
  const paying = outflow !== undefined;
  return (
    <WsField label={label} className={className}>
      <Select value={choice.accountId} onValueChange={choice.setAccountId}>
        <SelectTrigger className={WS_SELECT_TRIGGER}>
          <SelectValue placeholder="Select account" />
        </SelectTrigger>
        <SelectContent>
          {choice.accounts.map((a) => (
            <SelectItem key={a.id} value={a.id}>
              <AccountLabel
                account={a}
                suffix={[a.accountNumberLast4 ? `•••• ${a.accountNumberLast4}` : null, paying && a.type !== "card" ? formatCurrency(a.currentBalance) : null].filter(Boolean).join(" · ") || undefined}
              />
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {paying && choice.selected && choice.selected.type !== "card" && (
        <PaymentSourceSummary
          className="mt-1.5"
          account={withRefund(choice.selected, refund)}
          amount={outflow}
          paymentLabel={refund && refund.accountId === choice.selected.id ? "Edited payment (original refunded)" : undefined}
        />
      )}
    </WsField>
  );
}

export interface EntrySettleValues {
  amount: number;
  date: Date;
  /** Set when settling a manual ledger entry — the account its cash leg posts to. */
  accountId?: string;
}

/**
 * Settle one transaction — partially or in full, up to what is still open on it. Opens inside the
 * row itself (compact list and expanded ledger alike).
 */
export function EntrySettleForm({
  row,
  personName,
  onCancel,
  onSubmit,
}: {
  row: LedgerRow;
  personName: string;
  onCancel: () => void;
  onSubmit: (values: EntrySettleValues) => Promise<void>;
}) {
  const max = row.settle?.max ?? 0;
  const [amount, setAmount] = useState(() => max.toFixed(2));
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Every settlement is real money — ledger entries, installment shares, split shares and an opening balance all
  // post a cash leg, so each needs an account (an opening row without one always failed: WFI-P2-08).
  const needsAccount = row.settle?.kind === "entry" || row.settle?.kind === "derivedInstallment" || row.settle?.kind === "split" || row.settle?.kind === "opening";
  const account = useAccountChoice();
  const firstName = personName.split(" ")[0];
  const effect = row.direction === "iOwe" ? `You pay ${firstName}` : `${firstName} pays you`;
  // When I pay (I owe them) the money leaves the chosen account; when they pay me it is received into it.
  const paysOut = needsAccount && row.direction === "iOwe";
  const enteredAmount = Number(amount);
  const outflow = Number.isFinite(enteredAmount) && enteredAmount > 0 ? enteredAmount : null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) {
      setError("Enter an amount greater than 0.");
      return;
    }
    if (value > max + 0.005) {
      setError(`Can't exceed the ${formatCurrency(max)} still open.`);
      return;
    }
    if (needsAccount && !account.accountId) {
      setError("Select an account.");
      return;
    }
    if (paysOut && isUnderfunded(account.selected, value)) {
      setError("Not enough balance in the chosen account — choose another account or lower the amount.");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await onSubmit({ amount: value, date: new Date(date), accountId: needsAccount ? account.accountId : undefined });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't record the settlement. Please try again.");
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} onKeyDown={handleEnterAdvance} className="rounded-[8px] border border-border-strong bg-card p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <p className="text-sm font-semibold text-foreground">Record payment</p>
        <p className="text-xs text-muted-foreground">
          {effect} · <span className="font-medium text-foreground tabular-nums">{formatCurrency(max)}</span> remaining
        </p>
      </div>
      <div className={cn("mt-2.5 grid gap-3", needsAccount ? "sm:grid-cols-3" : "sm:grid-cols-2")}>
        <WsField label="Amount">
          <CompactAmountInput label="Settlement amount" value={amount} onChange={setAmount} invalid={!!error} autoFocus />
        </WsField>
        <WsField label="Date">
          <DateInput className={WS_FIELD} value={date} onChange={(e) => setDate(e.target.value)} />
        </WsField>
        {needsAccount && <AccountField choice={account} label={row.direction === "iOwe" ? "Paid from" : "Received into"} outflow={paysOut ? outflow : undefined} />}
      </div>
      {error && (
        <p className="mt-1.5 text-xs font-medium text-expense" role="alert">
          {error}
        </p>
      )}
      <div className="mt-3 flex items-center justify-end gap-2">
        <button type="button" onClick={onCancel} disabled={saving} className={cn(WS_GHOST, "h-8")}>
          Cancel
        </button>
        <button type="submit" disabled={saving || (paysOut && isUnderfunded(account.selected, outflow))} className={cn(WS_PRIMARY, "h-8")}>
          {saving ? "Recording…" : "Record payment"}
        </button>
      </div>
    </form>
  );
}

/**
 * Confirmation for a destructive ledger action. Guards against double submission: the confirm button
 * is disabled while the action runs, and the dialog can't be dismissed mid-write.
 */
export function LedgerConfirmDialog({
  open,
  onOpenChange,
  title,
  children,
  confirmLabel,
  busyLabel,
  onConfirm,
  disabled,
  variant = "destructive",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: React.ReactNode;
  confirmLabel: string;
  busyLabel: string;
  onConfirm: () => Promise<void>;
  disabled?: boolean;
  /** "reverse": undoing a settlement — a correction, not a deletion, so it isn't styled as one. */
  variant?: "destructive" | "reverse";
}) {
  const [busy, setBusy] = useState(false);
  async function confirm() {
    if (busy) return;
    setBusy(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch {
      // The caller surfaces the error; keep the dialog open so the user can retry or cancel.
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={(e) => busy && e.preventDefault()}
        onPointerDownOutside={(e) => busy && e.preventDefault()}
        className="gap-0 rounded-[10px] border border-border bg-card p-0 ring-0 sm:max-w-md"
      >
        <div className="px-5 pt-5">
          <DialogTitle className="font-heading text-lg leading-tight font-semibold tracking-tight text-foreground">{title}</DialogTitle>
          <DialogDescription asChild>
            <div className="mt-2 space-y-2 text-sm leading-relaxed text-muted-foreground">{children}</div>
          </DialogDescription>
        </div>
        <div className="mt-5 flex items-center justify-end gap-2 border-t border-border px-5 py-3">
          <button type="button" onClick={() => onOpenChange(false)} disabled={busy} className={WS_GHOST}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={busy || disabled}
            className={
              variant === "destructive"
                ? "flex h-9 items-center justify-center gap-1.5 rounded-[6px] bg-danger px-4 text-sm font-semibold text-danger-foreground outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
                : WS_PRIMARY
            }
          >
            {variant === "destructive" ? <Trash2 className="size-4" strokeWidth={1.75} /> : <Undo2 className="size-4" strokeWidth={1.75} />}
            {busy ? busyLabel : confirmLabel}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
