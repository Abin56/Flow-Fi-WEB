"use client";

import { ClayButton } from "@/components/clay/clay-button";
import { useGuardedAction } from "@/components/finance/use-guarded-submit";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatCurrency } from "@/lib/format";
import type { Bill, BillOccurrence, PaymentRecord } from "@/lib/models/bill";

export interface CancelTarget {
  payment: PaymentRecord;
  occurrence: BillOccurrence;
}

interface Props {
  bill: Bill;
  target: CancelTarget | null;
  /** Name of the account the payment debited, when known. */
  accountName: string | undefined;
  loading: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

const day = (d: Date) => d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

/** Spells out exactly what cancelling will do — which cycle, how much, which account gets what back. */
export function BillPaymentCancelDialog({ bill, target, accountName, loading, onOpenChange, onConfirm }: Props) {
  const confirm = useGuardedAction(onConfirm, loading);
  const funded = target?.payment.transactionId != null;
  const row = (label: string, value: React.ReactNode) => (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium text-foreground">{value}</dd>
    </div>
  );
  return (
    <Dialog open={target != null} onOpenChange={(o) => !loading && onOpenChange(o)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cancel payment — {bill.name}</DialogTitle>
          <DialogDescription>Review what will change before you confirm.</DialogDescription>
        </DialogHeader>
        {target && (
          <dl className="flex flex-col gap-2 rounded-2xl bg-muted/30 p-3 text-sm">
            {row("Bill", bill.name)}
            {row("Billing cycle", `Due ${day(target.occurrence.dueDate)}`)}
            {row("Payment", `${formatCurrency(target.payment.amount)} on ${day(target.payment.date)}`)}
            {funded ? (
              <>
                {row("Paid from", accountName ?? "Account no longer listed")}
                {row("Refund", <span className="font-mono text-success">+{formatCurrency(target.payment.amount)} to {accountName ?? "the original account"}</span>)}
              </>
            ) : (
              row("Refund", "None — this was recorded as already paid earlier, so no account balance changes")
            )}
          </dl>
        )}
        <p className="text-sm text-foreground">This cycle will become unpaid. Other billing cycles are not affected.</p>
        <DialogFooter>
          <ClayButton variant="ghost" onClick={() => onOpenChange(false)} disabled={loading}>
            Keep payment
          </ClayButton>
          <ClayButton variant="primary" onClick={confirm} disabled={loading} className="bg-danger text-danger-foreground">
            {loading ? "Cancelling..." : "Cancel payment"}
          </ClayButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
