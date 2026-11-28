import { CalendarClock, FileText } from "lucide-react";
import type { CardBill } from "@/lib/engines/card-cycle-bills";
import { formatCurrencyExact } from "@/lib/format";
import type { CardStatementProgress } from "@/features/credit-cards/lib/card-usage-breakdown";
import { formatCardStatementDate, formatCardStatementPeriod, type cardStatementCycles } from "@/features/credit-cards/lib/card-statement-period";

type StatementCycles = ReturnType<typeof cardStatementCycles>;

export function CardStatementOverview({ cardName, cycles, progress }: {
  cardName: string;
  cycles: StatementCycles;
  progress: CardStatementProgress | null;
}) {
  const { bill, next, payable, statement } = cycles;
  const statementStatus = payable ? null : bill && bill.totalAmount > 0 ? "Paid" : "No bill due";
  return (
    <section aria-label="Card billing cycles" className="min-w-0 overflow-hidden rounded-[12px] border border-border-strong/60 bg-card shadow-e1">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-4 py-3">
        <h2 className="font-heading text-base font-semibold text-foreground">Billing cycles</h2>
        <span className="text-xs font-medium text-muted-foreground">{cardName}</span>
      </div>
      <div className="grid gap-px border-y border-border-strong/45 bg-border-strong/45 sm:grid-cols-2">
        <div className="flex min-w-0 items-start gap-2.5 bg-primary/10 bg-card px-4 py-3">
          <FileText aria-hidden className="mt-0.5 size-4 shrink-0 text-primary-accent-text" />
          <dl className="min-w-0">
            <dt className="text-xs font-medium text-muted-foreground">{payable ? "Statement to pay" : "Last closed cycle"}</dt>
            <dd className="mt-1 text-sm font-semibold text-foreground tabular-nums">{formatCardStatementPeriod(statement)}</dd>
            <dd className="mt-0.5 text-xs text-foreground/75 tabular-nums">
              {payable ? "Due" : "Scheduled due"} {formatCardStatementDate(statement.dueDate)}
              {statementStatus && <span className="font-semibold text-success"> · {statementStatus}</span>}
            </dd>
          </dl>
        </div>
        <div className="flex min-w-0 items-start gap-2.5 bg-card px-4 py-3">
          <CalendarClock aria-hidden className="mt-0.5 size-4 shrink-0 text-chart-2" />
          <dl className="min-w-0">
            <dt className="text-xs font-medium text-muted-foreground">Next statement · Open cycle</dt>
            <dd className="mt-1 text-sm font-semibold text-foreground tabular-nums">{formatCardStatementPeriod(next)}</dd>
            <dd className="mt-0.5 text-xs text-foreground/75 tabular-nums">Expected due {formatCardStatementDate(next.dueDate)}</dd>
          </dl>
        </div>
      </div>
      {bill ? (
        <div className="p-4">
          <StatementPaymentProgress bill={bill} progress={progress} />
        </div>
      ) : (
        <p className="px-4 py-3 text-sm text-muted-foreground">No statement activity recorded for the closed cycle.</p>
      )}
    </section>
  );
}

export function StatementPaymentProgress({ bill, progress }: {
  bill: CardBill;
  progress: CardStatementProgress | null;
}) {
  const applied = progress?.applied ?? Math.round((Math.max(0, bill.totalAmount) - bill.remaining) * 100) / 100;
  const activity = progress?.activity;
  const percentage = bill.totalAmount > 0 ? Math.min(100, Math.round(applied / bill.totalAmount * 100)) : 0;
  const charges = activity ? [
    { label: "Purchases & other charges", amount: activity.purchases },
    { label: "Loan / EMI charges", amount: activity.loanEmi },
    { label: "Fees / GST", amount: activity.fees },
    { label: "People credits on this card", amount: -activity.peopleCredits },
    { label: "Refunds & other credits", amount: -activity.otherCredits },
  ] : [];
  const payments = progress ? [
    { label: "Loan / EMI payments into card", amount: progress.loanEmiPayments },
    { label: "People payments into card", amount: progress.peoplePayments },
    { label: "Other card payments", amount: progress.otherPayments },
    { label: "Other statement adjustments", amount: progress.adjustments },
  ] : [{ label: "Amount applied", amount: applied }];
  return (
    <div className="min-w-0" data-testid="statement-payment-progress">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="text-sm font-semibold text-foreground">Statement breakdown</h3>
        {bill.totalAmount > 0 && <p className="text-xs font-medium text-muted-foreground tabular-nums">{formatCurrencyExact(applied)} of {formatCurrencyExact(bill.totalAmount)} applied</p>}
      </div>
      {bill.totalAmount > 0 && (
        <progress aria-label="Statement amount applied" value={percentage} max={100} className="mt-2 block h-1.5 w-full overflow-hidden rounded-full bg-secondary [&::-webkit-progress-bar]:rounded-full [&::-webkit-progress-bar]:bg-secondary [&::-webkit-progress-value]:rounded-full [&::-webkit-progress-value]:bg-success [&::-moz-progress-bar]:bg-success" />
      )}
      <table aria-label="Statement charges and payments" className="mt-2 w-full text-xs tabular-nums">
        <tbody className="divide-y divide-border/70">
          {charges.filter(({ amount }) => amount !== 0).map(({ label, amount }) => (
            <StatementAmountRow key={label} label={label} value={amount} />
          ))}
          <StatementAmountRow label="Statement total" value={bill.totalAmount} emphasis />
          {payments.filter(({ amount }) => amount > 0).map(({ label, amount }) => (
            <StatementAmountRow key={label} label={label} value={-amount} />
          ))}
          <StatementAmountRow label="Remaining to pay" value={bill.remaining} emphasis />
        </tbody>
      </table>
    </div>
  );
}

function StatementAmountRow({ label, value, emphasis = false }: { label: string; value: number; emphasis?: boolean }) {
  return (
    <tr>
      <th scope="row" className={`py-1.5 pr-3 text-left ${emphasis ? "font-semibold text-foreground" : "font-medium text-muted-foreground"}`}>{label}</th>
      <td className={`py-1.5 text-right font-semibold whitespace-nowrap ${value < 0 ? "text-success" : "text-foreground"}`}>
        {value < 0 ? "−" : ""}{formatCurrencyExact(Math.abs(value))}
      </td>
    </tr>
  );
}
