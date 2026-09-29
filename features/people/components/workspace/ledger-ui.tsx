"use client";

import { AlertCircle, Check, CircleDot, HandCoins, Landmark, MoreHorizontal, Pencil, Trash2, Undo2 } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAccounts } from "@/hooks/use-accounts";
import { singleUndoablePayment, type DeleteBlock, type LedgerRow, type LedgerRowState, type PaymentRecord } from "@/features/people/lib/person-ledger-rows";
import { formatStatementDate, type StatementCategory } from "@/lib/engines/person-cycle-statement";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";
import { WS_FIELD, WS_GHOST, WS_PRIMARY, WS_SELECT_TRIGGER, WsCloseButton, WsField } from "./person-workspace-ui";

/**
 * Shared pieces of the People Ledger's inline actions and transaction management — the inline
 * reveal, the settlement-state badge, a row's ⋯ menu, the per-entry settle form and the delete
 * confirmation. Presentation only; every write goes through the callbacks the workspace passes in.
 */

/**
 * The ledger grid — one header/cell treatment for the Person workspace's Activity and the expanded
 * transaction ledger, so both read as the same table: a solid header row, visible row lines, lighter
 * column separators, no outer border (the surrounding frame supplies it).
 */
export const LEDGER_TH =
  "sticky top-0 z-[2] border-r border-b border-r-border-strong/60 border-b-border-strong bg-secondary px-3 py-2 last:border-r-0 text-left text-[11px] font-semibold tracking-[0.06em] whitespace-nowrap text-muted-foreground uppercase";
export const LEDGER_TD = "border-r border-b border-r-border-strong/55 border-b-border-strong/60 px-3 py-2.5 align-middle last:border-r-0";

/** Compact Type — the description column already carries the long form, so this never repeats it. */
export const LEDGER_TYPE_SHORT: Record<StatementCategory | "loan", string> = {
  opening: "Opening",
  split: "Split",
  emi: "EMI",
  gave: "Given",
  borrowed: "Borrowed",
  adjustment: "Adjustment",
  received: "Settlement",
  repaid: "Settlement",
  loan: "Loan EMI",
};

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
    <div className={cn("mt-4 overflow-hidden rounded-[8px] border border-border-strong bg-card", className)}>
      <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h3 className="font-heading text-[15px] leading-tight font-semibold tracking-tight text-foreground">{title}</h3>
          {subtitle && <p className="mt-0.5 text-xs text-foreground/70">{subtitle}</p>}
        </div>
        <WsCloseButton onClick={onClose} className="-my-0.5" />
      </div>
      <div className="px-4 pt-3.5 pb-3">{children}</div>
      <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-2.5">{footer}</div>
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

const STATE_STYLE: Record<LedgerRowState, string> = {
  open: "border-warning/40 bg-warning/10 text-foreground",
  partial: "border-primary-accent-text/50 bg-primary/10 text-foreground",
  settled: "border-success/35 bg-success/10 text-success",
};

/**
 * "Pending" · "Partially settled · ₹200 left" · "Settled" — a small tag, never a coloured row. A Loan
 * installment reads "Overdue" when unpaid past its due date, "Partial" and "Paid" for its payment state.
 */
export function StatusBadge({
  row,
  compact = false,
  className,
}: {
  row: Pick<LedgerRow, "state" | "remaining"> & Partial<Pick<LedgerRow, "overdue" | "category">>;
  compact?: boolean;
  className?: string;
}) {
  if (row.state == null) return null;
  const isLoan = row.category === "loan";
  const overdue = row.overdue === true && row.state !== "settled";
  const Icon = row.state === "settled" ? Check : overdue ? AlertCircle : CircleDot;
  const left = formatCurrency(row.remaining ?? 0);
  const label = overdue
    ? row.state === "partial" && !compact
      ? `Overdue · ${left} left`
      : "Overdue"
    : row.state === "open"
      ? "Pending"
      : row.state === "settled"
        ? isLoan
          ? "Paid"
          : "Settled"
        : compact
          ? isLoan
            ? "Partial"
            : "Partially settled"
          : `${isLoan ? "Partial" : "Partially settled"} · ${left} left`;
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-[4px] border px-1.5 text-[10.5px] leading-none font-semibold whitespace-nowrap",
        overdue ? "border-expense/40 bg-expense/10 text-expense" : STATE_STYLE[row.state],
        className,
      )}
    >
      <Icon className="size-3" strokeWidth={2.25} aria-hidden />
      {label}
    </span>
  );
}

export const DELETE_BLOCK_NOTE: Record<Exclude<DeleteBlock, null>, string> = {
  expense: "Part of a split expense — change it from the expense",
  loan: "Managed from the Loan",
  emi: "Comes from a linked EMI",
  opening: "Opening balance can't be deleted",
};

/** A row's ⋯ menu — offers only what this specific transaction supports. */
export function RowActionsMenu({
  row,
  onSettle,
  onEdit,
  onDelete,
  onUndo,
  className,
}: {
  row: LedgerRow;
  onSettle?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  /** Reverses a recorded payment (see `PaymentRecord.undo`). */
  onUndo?: (payment: PaymentRecord) => void;
  className?: string;
}) {
  const canSettle = row.settle != null && onSettle != null;
  const canDelete = row.deletable && onDelete != null;
  const canEdit = isEditable(row) && onEdit != null;
  const undoPayment = onUndo ? singleUndoablePayment(row) : null;
  const note = row.deleteBlock ? DELETE_BLOCK_NOTE[row.deleteBlock] : null;
  if (!canSettle && !canEdit && !canDelete && !undoPayment && !note) return <span className={cn("size-8 shrink-0", className)} aria-hidden />;
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Actions for ${row.title}`}
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-[6px] text-muted-foreground outline-none transition-colors hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-secondary data-[state=open]:text-foreground",
            className,
          )}
        >
          <MoreHorizontal className="size-4" strokeWidth={1.75} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-w-64 min-w-48 rounded-[8px]">
        {canSettle && (
          <DropdownMenuItem onSelect={onSettle}>
            <HandCoins strokeWidth={1.75} />
            Settle this entry
          </DropdownMenuItem>
        )}
        {canEdit && (
          <DropdownMenuItem onSelect={onEdit}>
            <Pencil strokeWidth={1.75} />
            Edit transaction
          </DropdownMenuItem>
        )}
        {undoPayment && (
          <DropdownMenuItem onSelect={() => onUndo!(undoPayment)}>
            <Undo2 strokeWidth={1.75} />
            Undo settlement
          </DropdownMenuItem>
        )}
        {canDelete && (
          <DropdownMenuItem variant="destructive" onSelect={onDelete}>
            <Trash2 strokeWidth={1.75} />
            Delete transaction
          </DropdownMenuItem>
        )}
        {!canDelete && note && <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">{note}</DropdownMenuLabel>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

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
    <form onSubmit={submit} className="rounded-[8px] border border-border-strong bg-card p-3">
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
          <input type="date" className={WS_FIELD} value={date} onChange={(e) => setDate(e.target.value)} />
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
 * Transaction alongside the LedgerEntry (`addLedgerEntryWithTransaction`). Until the user picks one,
 * the default account (else the first) is used, so `useAccountChoice` also works when accounts load
 * after mount.
 */
export function useAccountChoice() {
  const { data: allAccounts = [] } = useAccounts();
  const accounts = useMemo(() => allAccounts.filter((a) => a.deletedAt == null), [allAccounts]);
  const [picked, setPicked] = useState("");
  const accountId = picked || (accounts.find((a) => a.isDefault)?.id ?? accounts[0]?.id ?? "");
  return { accounts, accountId, setAccountId: setPicked };
}

export function AccountField({
  choice,
  className,
}: {
  choice: ReturnType<typeof useAccountChoice>;
  className?: string;
}) {
  return (
    <WsField label="Account" className={className}>
      <Select value={choice.accountId} onValueChange={choice.setAccountId}>
        <SelectTrigger className={WS_SELECT_TRIGGER}>
          <SelectValue placeholder="Select account" />
        </SelectTrigger>
        <SelectContent>
          {choice.accounts.map((a) => (
            <SelectItem key={a.id} value={a.id}>
              {a.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
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
  // Only a manual ledger entry posts a Transaction; a split-expense share settles through its own path.
  const needsAccount = row.settle?.kind === "entry";
  const account = useAccountChoice();
  const firstName = personName.split(" ")[0];
  const effect = row.direction === "iOwe" ? `Money you repay ${firstName}` : `Money ${firstName} pays you back`;

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
    <form onSubmit={submit} className="rounded-[8px] border border-border-strong bg-card p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <p className="text-sm font-semibold text-foreground">Settle this entry</p>
        <p className="text-xs text-muted-foreground">
          {effect} · <span className="font-medium text-foreground tabular-nums">{formatCurrency(max)}</span> open
        </p>
      </div>
      <div className={cn("mt-2.5 grid gap-3", needsAccount ? "sm:grid-cols-3" : "sm:grid-cols-2")}>
        <WsField label="Amount">
          <CompactAmountInput label="Settlement amount" value={amount} onChange={setAmount} invalid={!!error} autoFocus />
        </WsField>
        <WsField label="Date">
          <input type="date" className={WS_FIELD} value={date} onChange={(e) => setDate(e.target.value)} />
        </WsField>
        {needsAccount && <AccountField choice={account} />}
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
          {saving ? "Recording…" : "Record settlement"}
        </button>
      </div>
    </form>
  );
}

/**
 * A transaction's payment history — each payment recorded against it (across cycles), with an Undo
 * where the payment can be reversed through its own recording path, or the reason it can't.
 */
export function PaymentHistory({
  row,
  onUndo,
  className,
}: {
  row: LedgerRow;
  onUndo?: (payment: PaymentRecord) => void;
  className?: string;
}) {
  if (row.payments.length === 0) return null;
  return (
    <div className={className}>
      <p className="text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">Payment history</p>
      <ul className="mt-1.5 divide-y divide-border/70 border-y border-border">
        {row.payments.map((p) => (
          <li key={p.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5 text-sm">
            <span className="w-24 shrink-0 font-medium text-foreground tabular-nums">{formatStatementDate(p.date, true)}</span>
            <span className="min-w-0 flex-1 text-foreground">
              {p.direction === "youPaid" ? "Paid" : "Received"} <span className="font-semibold tabular-nums">{formatCurrency(p.amount)}</span>
              <span className="text-xs text-muted-foreground">
                {" · "}
                {p.remainingAfter > 0 ? `${formatCurrency(p.remainingAfter)} left after` : "cleared it"}
              </span>
            </span>
            {p.undo && onUndo ? (
              <button
                type="button"
                onClick={() => onUndo(p)}
                className="flex h-7 items-center gap-1 rounded-[6px] px-1.5 text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Undo2 className="size-3.5" strokeWidth={1.75} />
                Undo
              </button>
            ) : p.undoBlock ? (
              <span className="text-xs text-muted-foreground" title={p.undoBlock}>
                {p.undoBlock}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      <p className="mt-1.5 text-xs text-muted-foreground">
        {row.state === "settled" ? (
          <span className="font-semibold text-success">✓ Settled</span>
        ) : (
          <>
            Remaining <span className="font-semibold text-foreground tabular-nums">{formatCurrency(row.remaining ?? 0)}</span>
          </>
        )}
      </p>
    </div>
  );
}

/** "Received ₹500 · 28 Sep" — the latest payment on a transaction, for its status line. */
export function lastPaymentLine(row: LedgerRow): string | null {
  const last = row.payments[row.payments.length - 1];
  if (!last) return null;
  const total = row.payments.reduce((s, p) => s + p.amount, 0);
  const verb = last.direction === "youPaid" ? "Paid" : "Received";
  return `${verb} ${formatCurrency(total)} · ${formatStatementDate(last.date)}`;
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
