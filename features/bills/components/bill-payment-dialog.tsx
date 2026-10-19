"use client";

import { useMemo, useState } from "react";
import { FormDialog } from "@/components/finance";
import { DateInput } from "@/components/forms/date-input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAccounts } from "@/hooks/use-accounts";
import { previewFunds } from "@/lib/engines/payment-funding";
import { formatCurrency } from "@/lib/format";
import { billOccurrenceRemainingAmount, type Bill, type BillOccurrence, type PaymentRecord } from "@/lib/models/bill";
import type { Account } from "@/lib/models/account";
import { isBillPayingAccount } from "@/lib/repositories/bill-payment-repository";
import { useBillActions } from "@/features/bills/hooks/use-bills-data";
import { toast } from "@/store/toast-store";
import { generateId } from "@/lib/utils/id-generator";

type Mode = "account" | "earlier";

const round2 = (v: number) => Math.round(v * 100) / 100;

/** A local calendar day as `YYYY-MM-DD` (not UTC — `toISOString` would show yesterday in the early hours east of UTC). */
const toDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Last moment of the local day containing `ms` — "today" is never in the future (same rule the repository enforces). */
const endOfDay = (ms: number) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).getTime();
};

/** `YYYY-MM-DD` → local noon, so the stored day never shifts with the time zone. */
const dayToDate = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1, 12);
};

/**
 * The ONLY way to mark a regular bill paid. Two explicit choices, no default: paying from an account posts a real
 * debit (funds checked in the write); "already paid earlier" records the status and date only, with no money moved.
 * With `editing` set, corrects an account-funded payment (amount / account / date) in one atomic write.
 */
export function BillPaymentDialog(props: DialogProps) {
  // Re-mounted on every open: a fresh form and a fresh idempotency key = one user action.
  return <BillPaymentForm key={props.open ? "open" : "closed"} {...props} />;
}

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bill: Bill;
  occurrence: BillOccurrence;
  editing?: PaymentRecord | null;
}

function BillPaymentForm({
  open,
  onOpenChange,
  bill,
  occurrence,
  editing,
}: DialogProps) {
  const actions = useBillActions();
  const { data: allAccounts = [] } = useAccounts();
  const accounts = useMemo(() => (allAccounts as Account[]).filter(isBillPayingAccount), [allAccounts]);
  const owedNow = billOccurrenceRemainingAmount(occurrence) + (editing?.amount ?? 0);

  const [mode, setMode] = useState<Mode | null>(editing ? "account" : null);
  const [accountId, setAccountId] = useState(editing?.accountId ?? (bill.accountId && accounts.some((a) => a.id === bill.accountId) ? bill.accountId : ""));
  const [amountText, setAmountText] = useState(String(owedNow));
  const [date, setDate] = useState(toDay(editing?.date ?? new Date()));
  const [key] = useState(generateId);
  const [openedAt] = useState(() => Date.now());
  const [saving, setSaving] = useState(false);

  const amount = Number(amountText);
  const account = accounts.find((a) => a.id === accountId);
  // Editing refunds the original debit first when the account is unchanged.
  const effectiveAccount = account && editing && editing.accountId === account.id ? { ...account, currentBalance: account.currentBalance + editing.amount } : account;
  const fundsPreview = effectiveAccount && amount > 0 ? previewFunds(effectiveAccount, amount) : null;
  const originalAccount = editing ? (allAccounts as Account[]).find((a) => a.id === editing.accountId) : undefined;
  const sameAccount = !!editing && !!account && editing.accountId === account.id;
  // What the three figures mean: a new payment moves the stored balance by -amount; an edit by the NET of refunding the
  // original debit (same account only) and posting the corrected one. "stored" is always the account's balance as saved.
  const liveView =
    fundsPreview && account
      ? {
          status: fundsPreview.status,
          stored: round2(account.currentBalance),
          change: editing ? round2((sameAccount ? editing.amount : 0) - amount) : -fundsPreview.amount,
          after: fundsPreview.after,
        }
      : null;
  // The write lands before the dialog closes and the live balance then already includes it — keep showing what the user confirmed.
  const [confirmedView, setConfirmedView] = useState<typeof liveView>(null);
  const view = saving && confirmedView ? confirmedView : liveView;

  const preview = fundsPreview;
  const blocker =
    mode == null
      ? "Choose how this bill was paid."
      : !(amount > 0)
        ? "Enter an amount."
        : amount > owedNow + 0.005
          ? `Only ${formatCurrency(owedNow)} is still due.`
          : mode === "account" && !account
            ? "Choose the account you paid from."
            : mode === "account" && preview?.status === "insufficient"
              ? "That account doesn't have enough balance — choose another account or lower the amount."
              : mode === "earlier" && dayToDate(date).getTime() > endOfDay(openedAt)
                ? "A payment already made can't be dated in the future."
                : null;

  async function confirm() {
    if (blocker || saving || !actions || mode == null) return;
    setConfirmedView(liveView);
    setSaving(true);
    try {
      if (editing) {
        await actions.editBillPayment({ billId: bill.id, paymentId: editing.id, accountId, amount, date: dayToDate(date), idempotencyKey: key });
        toast.success("Payment updated");
      } else if (mode === "account") {
        await actions.payFromAccount({ billId: bill.id, occurrenceId: occurrence.id, accountId, amount, date: dayToDate(date), idempotencyKey: key });
        toast.success("Bill paid", `${formatCurrency(amount)} debited from ${account?.name ?? "your account"}.`);
      } else {
        await actions.recordPaidEarlier({ billId: bill.id, occurrenceId: occurrence.id, amount, date: dayToDate(date), idempotencyKey: key });
        toast.success("Marked as paid earlier", "No account balance changed.");
      }
      onOpenChange(false);
    } catch (e) {
      toast.error("Nothing was recorded", e instanceof Error ? e.message : "Please try again.");
    } finally {
      setSaving(false);
    }
  }

  const choice = (value: Mode, title: string, body: string) => (
    <button
      type="button"
      onClick={() => setMode(value)}
      aria-pressed={mode === value}
      className={`flex flex-col gap-0.5 rounded-2xl border p-3 text-left ${mode === value ? "border-primary bg-primary/10" : "border-border/60 bg-muted/30"}`}
    >
      <span className="text-sm font-semibold text-foreground">{title}</span>
      <span className="text-xs text-muted-foreground">{body}</span>
    </button>
  );

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? `Edit payment — ${bill.name}` : `Pay ${bill.name}`}
      description={editing ? "Correct the amount, account or date. The original debit is replaced, not stacked." : "Choose exactly what happened to the money."}
      onConfirm={confirm}
      confirmLabel={editing ? "Save changes" : mode === "earlier" ? "Record as paid" : "Pay now"}
      loading={saving}
      confirmDisabled={blocker != null}
      contentClassName="sm:max-w-lg"
    >
      <div className="flex flex-col gap-4 py-1 text-sm">
        {!editing && (
          <div className="grid grid-cols-1 gap-2">
            {choice("account", "Pay from my account now", "Debits the account you choose, once, and marks the bill paid.")}
            {choice("earlier", "Already paid earlier — included in my balance", "Only records that it was paid and when. Your balances don't change.")}
          </div>
        )}
        {mode != null && (
          <>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Amount (due {formatCurrency(owedNow)})</span>
              <input type="number" className="clay-pressed h-10 rounded-xl px-3 text-sm outline-none" value={amountText} onChange={(e) => setAmountText(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">{mode === "earlier" ? "Date it was paid" : "Payment date"}</span>
              <DateInput className="clay-pressed h-10 rounded-xl px-3 text-sm outline-none" value={date} onChange={(e) => setDate(e.target.value)} />
            </label>
          </>
        )}
        {mode === "account" && (
          <>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Paid from</span>
              <Select value={accountId || undefined} onValueChange={setAccountId}>
                <SelectTrigger className="h-10 w-full rounded-xl">
                  <SelectValue placeholder="Choose an account" />
                </SelectTrigger>
                <SelectContent>
                  {accounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name} · {formatCurrency(a.currentBalance)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            {view && (
              <div className="flex flex-col gap-2">
                <div className="grid grid-cols-3 gap-2 rounded-2xl bg-muted/30 p-3 text-xs">
                  <div><p className="text-muted-foreground">{editing ? "Stored balance now" : "Balance now"}</p><p className="font-mono font-semibold">{formatCurrency(view.stored)}</p></div>
                  <div><p className="text-muted-foreground">{editing ? "Net change from this edit" : "Payment"}</p><p className="font-mono font-semibold">{view.change < 0 ? "−" : view.change > 0 ? "+" : ""}{formatCurrency(Math.abs(view.change))}</p></div>
                  <div><p className="text-muted-foreground">{editing ? "Balance after edit" : "Balance after"}</p><p className={`font-mono font-semibold ${view.status === "insufficient" ? "text-expense" : ""}`}>{formatCurrency(view.after)}</p></div>
                </div>
                {editing && (
                  <p className="text-xs text-muted-foreground">
                    {sameAccount
                      ? `The original ${formatCurrency(editing.amount)} debit is refunded and the corrected ${formatCurrency(amount > 0 ? amount : 0)} debited, so this account moves by the net change only.`
                      : `${formatCurrency(editing.amount)} is refunded to ${originalAccount?.name ?? "the original account"}, and ${formatCurrency(amount > 0 ? amount : 0)} is debited from this account.`}
                  </p>
                )}
              </div>
            )}
          </>
        )}
        {blocker && mode != null && !saving && <p className="text-xs text-expense">{blocker}</p>}
      </div>
    </FormDialog>
  );
}
