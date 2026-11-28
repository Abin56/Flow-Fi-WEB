import type { CardBill, CardStatementPaymentScope } from "@/lib/engines/card-cycle-bills";
import { formatCurrencyExact } from "@/lib/format";
import { settleCardPayments } from "@/lib/repositories/credit-card-repository";
import { cn } from "@/lib/utils";
import { formatCardStatementPeriod } from "@/features/credit-cards/lib/card-statement-period";
import type { CardBillBreakdown } from "@/features/credit-cards/lib/card-usage-breakdown";
import { CardBillParts } from "./card-activity-views";

const date = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" });
const label = "text-muted-foreground";
const figure = "shrink-0 font-semibold text-foreground tabular-nums";
const row = "flex items-baseline justify-between gap-3";

export function PayBillDialogScope({
  scope,
  bills,
  amount,
  breakdown,
}: {
  scope: CardStatementPaymentScope;
  bills: readonly CardBill[];
  amount: number;
  breakdown?: CardBillBreakdown;
}) {
  const bill = scope.current;
  const payment = Number.isFinite(amount) && amount > 0 && amount === Math.round(amount * 100) / 100 ? amount : 0;
  const balances = bills
    .filter((b) => b.remaining > 0)
    .map((bill) => ({ bill, dueDate: bill.dueDate, totalAmount: bill.remaining, amountPaid: 0 }));
  // Apply the same due-date order as recording a payment, starting from the already-settled balances.
  const allocations = settleCardPayments(balances, 0, payment).statements.filter((b) => b.amountPaid > 0.005);
  const extra = Math.round((payment - scope.cardOutstanding) * 100) / 100;
  const singleStatement = bill != null && (payment === 0 || (extra <= 0 && allocations.length === 1 && allocations[0].bill.id === bill.id));
  const partial = singleStatement && payment > 0 && payment < bill.remaining;
  const laterDue = Math.round((scope.closedDue - scope.statementDue) * 100) / 100;

  return (
    <section aria-label="Bill payment details" className="overflow-hidden rounded-[8px] border border-border-strong text-xs" data-testid="pay-bill-scope">
      {singleStatement ? (
        <>
          <div className={cn("px-3.5 py-2.5", scope.currentOverdue ? "bg-expense/8" : "bg-primary/10")}>
            <div className={row}>
              <h3 className="font-semibold text-foreground">Statement bill</h3>
              <p className={cn(figure, "text-base")}>{formatCurrencyExact(bill.remaining)}</p>
            </div>
            <p className="font-semibold text-foreground tabular-nums">{formatCardStatementPeriod(bill)}</p>
            <dl className="mt-1 space-y-0.5">
              <div className={row}>
                <dt className={label}>{scope.currentOverdue ? "Was due" : "Payment due"}</dt>
                <dd className={cn(figure, scope.currentOverdue && "text-expense")}>{date.format(bill.dueDate)}</dd>
              </div>
              {bill.amountPaid > 0.005 && (
                <>
                  <div className={row}>
                    <dt className={label}>Original bill</dt>
                    <dd className={figure}>{formatCurrencyExact(bill.totalAmount)}</dd>
                  </div>
                  <div className={row}>
                    <dt className={label}>Already paid</dt>
                    <dd className={figure}>{formatCurrencyExact(bill.amountPaid)}</dd>
                  </div>
                </>
              )}
              {partial && (
                <>
                  <div className={row}>
                    <dt className={label}>This payment</dt>
                    <dd className={figure}>{formatCurrencyExact(payment)}</dd>
                  </div>
                  <div className={row}>
                    <dt className={label}>Remaining after payment</dt>
                    <dd className={figure}>{formatCurrencyExact(bill.remaining - payment)}</dd>
                  </div>
                </>
              )}
            </dl>
            {breakdown && <div className="mt-2"><CardBillParts split={breakdown} /></div>}
          </div>
          {(laterDue > 0 || scope.unbilled > 0) && (
            <dl className="space-y-0.5 border-t border-border-strong/70 px-3.5 py-2">
              {laterDue > 0 && <div className={row}><dt className={label}>Other unpaid statements</dt><dd className={figure}>{formatCurrencyExact(laterDue)}</dd></div>}
              {scope.unbilled > 0 && <div className={row}><dt className={label}>Unbilled spending</dt><dd className={figure}>{formatCurrencyExact(scope.unbilled)}</dd></div>}
            </dl>
          )}
        </>
      ) : (
        <div className="bg-secondary/40 px-3.5 py-2.5">
          {bill == null && (
            <p className="font-medium text-foreground">No bill is due on this card.</p>
          )}
          {payment > 0 ? (
            <>
              <h3 className={cn("font-semibold text-foreground", bill == null && "mt-2")}>Payment breakdown</h3>
              <dl className="mt-1 divide-y divide-border-strong/60">
                {allocations.map(({ bill: appliedBill, amountPaid }) => (
                  <div key={appliedBill.id} className={cn(row, "py-1")}>
                    <dt className="min-w-0">
                      <span className="block font-medium text-foreground tabular-nums">{formatCardStatementPeriod(appliedBill)}</span>
                      <span className={label}>{appliedBill.isClosed ? `Statement bill · Due ${date.format(appliedBill.dueDate)}` : "Open cycle · Advance payment"}</span>
                    </dt>
                    <dd className={figure}>{formatCurrencyExact(amountPaid)}</dd>
                  </div>
                ))}
                {extra > 0 && (
                  <div className={cn(row, "py-1")}>
                    <dt className={label}>Above current outstanding</dt>
                    <dd className={figure}>{formatCurrencyExact(extra)}</dd>
                  </div>
                )}
              </dl>
            </>
          ) : scope.unbilled > 0 && (
            <p className="mt-1 text-muted-foreground">Unbilled spending {formatCurrencyExact(scope.unbilled)}</p>
          )}
        </div>
      )}
    </section>
  );
}
