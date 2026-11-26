"use client";

import { ArrowUpRight, CalendarClock, ChevronDown, Ellipsis, HandCoins, Receipt, Wallet } from "lucide-react";
import Link from "next/link";
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Money } from "@/features/loans/components/loan-emi-ui";
import { HISTORICAL_PAYMENT_LABEL } from "@/features/loans/lib/historical-payment";
import type { AgreementPeopleLine } from "@/features/loans/lib/agreement-people";
import { BANK_STATUS_TEXT, type InstallmentTableRow } from "@/features/loans/lib/installment-table";
import type { ScheduleReceipts } from "@/features/loans/lib/schedule-receipts";
import { InstallmentReceiptHistory } from "@/features/loans/components/installment-receipt-history";
import { peoplePostponeHref, peopleSettleHref } from "@/lib/engines/linked-people-readiness";
import { PAYMENT_EPSILON } from "@/lib/engines/person-payment";
import { cycleContaining, formatCycleLabel } from "@/lib/engines/person-cycle-statement";
import { cycleTitle } from "@/lib/engines/person-payment-deferral";
import { peopleLedgerHref } from "@/features/people/lib/people-return-link";
import { useAccounts } from "@/hooks/use-accounts";
import { useTransactions } from "@/hooks/use-transactions";
import { formatCurrencyExact } from "@/lib/format";
import type { Installment, InstallmentStatus } from "@/lib/models/payment-schedule";
import type { OwnershipSource } from "@/lib/engines/debt-ownership";
import { TheyPaidPanel } from "@/features/loans/components/they-paid-panel";
import { DirectPaymentRecovery } from "@/features/loans/components/direct-payment-recovery";
import type { RecordedPaymentAction } from "@/features/loans/lib/recorded-payments";
import { cn } from "@/lib/utils";

const dateText = (d: Date) => d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

const BANK_TONE: Record<InstallmentStatus, string> = {
  paid: "text-[oklch(0.44_0.13_149)] dark:text-success",
  partiallyPaid: "text-warning-foreground dark:text-warning",
  overdue: "font-semibold text-expense",
  skipped: "text-muted-foreground",
  upcoming: "text-foreground/70",
};
const BANK_DOT: Record<InstallmentStatus, string> = {
  paid: "bg-success",
  partiallyPaid: "bg-warning",
  overdue: "bg-expense",
  skipped: "bg-muted-foreground/50",
  upcoming: "bg-foreground/25",
};
type Filter = "all" | "unpaid";

/**
 * Selecting a schedule row fills the detail below. The footer shows what People owe through the selected cycle.
 */
export function InstallmentGrid({
  rows,
  selectedId,
  onSelect,
  total,
  lent,
  cycleBalance,
}: {
  rows: InstallmentTableRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  total: number;
  lent: boolean;
  cycleBalance: { remaining: number; label: string } | null;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  const shown = useMemo(() => (filter === "unpaid" ? rows.filter((r) => r.left > 0.005 && r.status !== "skipped") : rows), [rows, filter]);
  const sums = useMemo(() => shown.reduce((t, r) => ({ amount: t.amount + r.amount, paid: t.paid + r.paid, left: t.left + r.left }), { amount: 0, paid: 0, left: 0 }), [shown]);
  const unpaidCount = rows.filter((r) => r.left > 0.005 && r.status !== "skipped").length;

  function onKeyDown(e: KeyboardEvent<HTMLTableSectionElement>) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const i = shown.findIndex((r) => r.id === selectedId);
    const next = shown[Math.min(shown.length - 1, Math.max(0, i + (e.key === "ArrowDown" ? 1 : -1)))];
    if (!next) return;
    onSelect(next.id);
    requestAnimationFrame(() => bodyRef.current?.querySelector<HTMLElement>(`[data-row="${next.id}"]`)?.focus());
  }

  const th = "sticky top-0 z-[1] border-b border-border-strong bg-secondary px-2.5 py-1.5 text-left text-[10.5px] font-bold tracking-[0.06em] whitespace-nowrap text-foreground/60 uppercase";
  const num = "text-right tabular-nums";
  return (
    <div className="flex min-h-0 flex-col" data-testid="installment-grid">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
        <span className="text-xs font-semibold text-foreground" title={total > rows.length ? `${total} scheduled` : undefined}>
          {shown.length} <span className="font-medium text-muted-foreground">{shown.length === 1 ? "EMI" : "EMIs"}</span>
        </span>
        <div role="radiogroup" aria-label="Show" className="ml-auto flex rounded-[6px] border border-border bg-secondary/60 p-0.5">
          {(["all", "unpaid"] as const).map((f) => (
            <button
              key={f}
              type="button"
              role="radio"
              aria-checked={filter === f}
              onClick={() => setFilter(f)}
              className={cn(
                "h-6 rounded-[4px] px-2.5 text-[11.5px] font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                filter === f ? "bg-card text-foreground shadow-e1" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {f === "all" ? "All" : `Unpaid ${unpaidCount}`}
            </button>
          ))}
        </div>
      </div>
      <div className="min-h-0 overflow-auto">
        <table className="w-full min-w-[30rem] border-separate border-spacing-0 text-[12.5px]">
          <thead>
            <tr>
              <th className={cn(th, "w-12 pl-3")}>#</th>
              <th className={th}>Due date</th>
              <th className={cn(th, num)}>{lent ? "Expected" : "Amount"}</th>
              <th className={cn(th, num)}>{lent ? "Received" : "Paid"}</th>
              <th className={cn(th, num)}>Due</th>
              <th className={th}>{!lent && cycleBalance != null ? "Lender status" : "Status"}</th>
            </tr>
          </thead>
          <tbody ref={bodyRef} onKeyDown={onKeyDown}>
            {shown.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-xs text-muted-foreground">
                  {filter === "unpaid" ? "Nothing left to pay." : "No installments yet."}
                </td>
              </tr>
            )}
            {shown.map((r) => {
              const on = r.id === selectedId;
              const cell = cn("border-b border-border/70 px-2.5 py-0 h-[30px] whitespace-nowrap transition-colors duration-100");
              return (
                <tr
                  key={r.id}
                  data-row={r.id}
                  data-testid={`installment-row-${r.sequenceNumber}`}
                  aria-selected={on}
                  tabIndex={on || (selectedId == null && r === shown[0]) ? 0 : -1}
                  onClick={() => onSelect(r.id)}
                  className={cn(
                    "cursor-pointer outline-none",
                    on ? "bg-primary/20 shadow-[inset_3px_0_0_var(--color-primary-accent-text)]" : "hover:bg-secondary/70 focus-visible:bg-secondary/70",
                    r.status === "skipped" && !on && "text-muted-foreground",
                  )}
                >
                  <td className={cn(cell, "pl-3 font-semibold text-foreground tabular-nums")}>{r.sequenceNumber}</td>
                  <td className={cn(cell, "tabular-nums", r.status === "overdue" ? "font-semibold text-expense" : "text-foreground")}>{dateText(r.dueDate)}</td>
                  <td className={cn(cell, num, r.status === "skipped" && "line-through decoration-1")}>
                    <Money amount={r.amount} className="text-[12.5px] font-semibold text-foreground" />
                  </td>
                  <td className={cn(cell, num)}>{r.paid > 0 ? <Money amount={r.paid} className="text-[12.5px] font-medium text-foreground/85" /> : <span className="text-muted-foreground">–</span>}</td>
                  <td className={cn(cell, num)}>{r.left > 0.005 ? <Money amount={r.left} className={cn("text-[12.5px] font-semibold", r.status === "overdue" ? "text-expense" : "text-foreground")} /> : <span className="text-muted-foreground">–</span>}</td>
                  <td className={cell}>
                    <span className={cn("inline-flex items-center gap-1.5", BANK_TONE[r.status])}>
                      <span aria-hidden className={cn("size-1.5 rounded-full", BANK_DOT[r.status])} />
                      {BANK_STATUS_TEXT[r.status]}
                      {r.earlier && <span className="text-[10.5px] font-medium text-muted-foreground">· earlier</span>}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
          {shown.length > 1 && (
            <tfoot>
              <tr className="font-semibold">
                <td colSpan={2} className="sticky bottom-0 border-t border-border-strong bg-secondary px-2.5 py-1.5 pl-3 text-[11px] tracking-[0.06em] text-foreground/60 uppercase">
                  Total
                </td>
                <td className={cn("sticky bottom-0 border-t border-border-strong bg-secondary px-2.5 py-1.5", num)}>
                  <Money amount={sums.amount} className="text-[12.5px] text-foreground" />
                </td>
                <td className={cn("sticky bottom-0 border-t border-border-strong bg-secondary px-2.5 py-1.5", num)}>
                  <Money amount={sums.paid} className="text-[12.5px] text-foreground" />
                </td>
                <td className={cn("sticky bottom-0 border-t border-border-strong bg-secondary px-2.5 py-1.5", num)}>
                  <Money amount={sums.left} className="text-[12.5px] text-foreground" />
                </td>
                <td className="sticky bottom-0 border-t border-border-strong bg-secondary" />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {cycleBalance != null && (
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-border bg-card px-3 py-1.5 text-xs" data-testid="schedule-people-balance">
          <Link href="/people" className="inline-flex items-center gap-1 rounded font-semibold text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
            People Ledger <ArrowUpRight className="size-3 text-muted-foreground" aria-hidden />
          </Link>
          <dl className="flex items-baseline gap-2">
            <dt className="text-muted-foreground" title="Shares and receipts linked to this agreement">Remaining to receive <span className="whitespace-nowrap">· {cycleBalance.label}</span></dt>
            <dd className={cn("font-semibold tabular-nums", cycleBalance.remaining > PAYMENT_EPSILON ? "text-settle-receivable-text" : "text-foreground")}>{formatCurrencyExact(cycleBalance.remaining)}</dd>
          </dl>
        </div>
      )}
    </div>
  );
}

/**
 * The selected installment: its figures, where it was paid from, each person's share of it, and the actions that are
 * available for it — Pay (the existing Record Payment, opened on this installment), the recorded payment's details, and
 * the People Ledger's own "Record received" / "Postpone". Display only; every action is a handler or link the page has.
 */
export function InstallmentDetail({
  row,
  lent,
  cycleStartDay,
  peopleLines,
  receiptsByPerson,
  receiptsLoading,
  onPay,
  onViewPayment,
  onTheyPaid,
  peopleTarget,
  actions,
  returnTo,
}: {
  /** Every recorded payment of the agreement — with `peopleTarget`, shows a direct payment whose People record is missing. */
  actions?: readonly RecordedPaymentAction[];
  row: InstallmentTableRow | null;
  lent: boolean;
  cycleStartDay: number;
  peopleLines: readonly AgreementPeopleLine[];
  receiptsByPerson: ReadonlyMap<string, ScheduleReceipts>;
  receiptsLoading: boolean;
  onPay: (installment: InstallmentTableRow["installment"]) => void;
  onViewPayment: (action: NonNullable<InstallmentTableRow["recorded"]>) => void;
  /** "They paid" — records that a person already paid their share (People side only). Offered while someone still owes one. */
  onTheyPaid?: (installment: InstallmentTableRow["installment"]) => void;
  /** With this, "They paid" opens the person's payment panel right here (inline) instead of a sheet. */
  peopleTarget?: { sourceKind: "emi" | "loan"; source: OwnershipSource; installments: readonly Installment[] };
  returnTo: string;
}) {
  const [panel, setPanel] = useState<{ id: string; n: number } | null>(null);
  const { data: accounts = [] } = useAccounts();
  const { data: transactions = [] } = useTransactions();
  if (!row) {
    return (
      <div className="flex h-12 shrink-0 items-center border-t border-border bg-secondary/40 px-4 text-xs text-muted-foreground" data-testid="installment-detail-empty">
        Select an EMI.
      </div>
    );
  }
  const i = row.installment;
  const txn = row.recorded?.transactionId ? transactions.find((t) => t.id === row.recorded!.transactionId) : null;
  const account = txn?.accountId ? accounts.find((a) => a.id === txn.accountId) : null;
  const paidFrom = account ? (account.accountNumberLast4 ? `${account.name} ••${account.accountNumberLast4}` : account.name) : null;
  const sharing = peopleLines.filter((l) => l.share > PAYMENT_EPSILON);
  const loanDetail = peopleTarget?.sourceKind === "loan";
  const peopleAction = onTheyPaid && !lent && sharing.some((l) => l.remaining > PAYMENT_EPSILON) && (
    <button
      type="button"
      onClick={() => (peopleTarget ? setPanel((p) => (p?.id === i.id ? null : { id: i.id, n: (p?.n ?? 0) + 1 })) : onTheyPaid(i))}
      aria-expanded={peopleTarget ? panel?.id === i.id : undefined}
      data-testid="installment-they-paid"
      className="inline-flex h-8 items-center gap-1.5 rounded-[6px] border border-border-strong bg-card px-2.5 text-xs font-semibold text-foreground outline-none transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring"
    >
      <HandCoins className="size-3.5" strokeWidth={1.75} aria-hidden />
      Receive
    </button>
  );
  const peopleList = sharing.length > 0 && (
    <ul className="divide-y divide-border/70 rounded-[6px] border border-border bg-card" aria-label="People sharing this EMI">
      {sharing.map((line) => (
        <PersonLine key={`${line.key}-${line.personId}`} line={line} cycleStartDay={cycleStartDay} receipts={receiptsByPerson.get(line.personId)} receiptsLoading={receiptsLoading} returnTo={returnTo} />
      ))}
    </ul>
  );
  const receiptPanel = peopleTarget && panel?.id === i.id && (
    <TheyPaidPanel key={panel.n} {...peopleTarget} installmentId={i.id} onClose={() => setPanel(null)} />
  );
  const directRecovery = peopleTarget && actions && !lent && sharing.length > 0 && (
    <DirectPaymentRecovery key={i.id} {...peopleTarget} installmentId={i.id} actions={actions} />
  );
  return (
    <section aria-label={`EMI ${row.sequenceNumber}`} data-testid="installment-detail" className={cn("shrink-0 space-y-2 overflow-y-auto overscroll-contain border-t border-border bg-secondary/30 px-3 py-2.5", peopleList ? "max-h-[60%]" : "max-h-[48%]")}>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-[13px] font-semibold text-foreground">{dateText(row.dueDate)}</span>
            <span className={cn("inline-flex items-center gap-1 text-xs", BANK_TONE[row.status])}>
              <span aria-hidden className={cn("size-1.5 rounded-full", BANK_DOT[row.status])} />
              {row.status === "paid" && lent ? "Received" : BANK_STATUS_TEXT[row.status]}
            </span>
          </div>
          {row.recorded && (
            <div className="text-[11px] text-muted-foreground" title={row.earlier ? (lent ? "No account credit" : "No account debit") : undefined}>
              {row.earlier ? HISTORICAL_PAYMENT_LABEL : lent ? "Received" : "Paid"}
              {row.paidOn ? ` · ${dateText(row.paidOn)}` : row.earlier ? " · Date unknown" : ""}
              {paidFrom ? ` · ${paidFrom}` : ""}
            </div>
          )}
        </div>
        <dl aria-label={sharing.length > 0 ? "Lender payment" : undefined} className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          <ShareFigure label="Amount" amount={row.amount} />
          <ShareFigure label={lent ? "Received" : "Paid"} amount={row.paid} />
          {row.left > PAYMENT_EPSILON && <ShareFigure label="Due" amount={row.left} tone={row.status === "overdue" ? "text-expense" : undefined} />}
        </dl>
        <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-2">
          {row.recorded && (
            <button type="button" onClick={() => onViewPayment(row.recorded!)} className="inline-flex h-8 items-center gap-1.5 rounded-[6px] border border-border-strong bg-card px-2.5 text-xs font-semibold text-foreground outline-none transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring">
              <Receipt className="size-3.5" strokeWidth={1.75} aria-hidden />
              {row.editable ? "Edit payment" : "Payment details"}
            </button>
          )}
          {peopleAction}
          {row.canPay && (
            <button type="button" onClick={() => onPay(i)} className="inline-flex h-8 items-center gap-1.5 rounded-[6px] border border-primary-accent-text bg-primary px-3 text-xs font-semibold text-primary-foreground outline-none transition-colors hover:bg-primary/85 focus-visible:ring-2 focus-visible:ring-ring">
              {loanDetail && <Wallet className="size-3.5" aria-hidden />}
              {lent ? "Record" : loanDetail && sharing.length > 0 ? "Pay lender" : "Pay Now"} {formatCurrencyExact(row.left)}
            </button>
          )}
        </div>
      </div>
      {peopleList}
      {directRecovery}
      {receiptPanel}
    </section>
  );
}

function PersonLine({ line, cycleStartDay, receipts, receiptsLoading, returnTo }: {
  line: AgreementPeopleLine;
  cycleStartDay: number;
  receipts?: ScheduleReceipts;
  receiptsLoading: boolean;
  returnTo: string;
}) {
  const open = line.remaining > PAYMENT_EPSILON;
  const fromAdvance = line.fromAdvance ?? 0;
  const available = receipts?.availableAdvance ?? 0;
  const earlier = receipts?.earlierAdvance ?? 0;
  const cycle = line.expectedCycle ?? cycleContaining(line.dueDate, cycleStartDay);
  const postponed = line.status === "postponed";
  const hasReceiptDetails = !!receipts?.recent.length || available > PAYMENT_EPSILON || fromAdvance > PAYMENT_EPSILON || line.paidDirectly;
  const settleHref = peopleSettleHref(line.personId, line.key, returnTo);
  const postponeHref = peoplePostponeHref(line.personId, line.key, returnTo);
  return (
    <li className="px-3 py-1.5 text-xs" data-testid="installment-person">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Link href={peopleLedgerHref({ personId: line.personId, cycle })} className="inline-flex min-h-7 min-w-0 items-center gap-1 rounded font-semibold text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
          <span className="wrap-anywhere">{line.personName}</span>
          <ArrowUpRight className="size-3 shrink-0 text-muted-foreground" aria-hidden />
        </Link>
        {open && (
          <span className={cn("text-[11px]", postponed ? "text-primary-accent-text" : "text-muted-foreground")} title={formatCycleLabel(cycle)}>
            {postponed ? `Postponed to ${line.postponedDate ? dateText(line.postponedDate) : `${cycleTitle(cycle)} cycle`}` : `${cycleTitle(cycle)} cycle`}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {open ? (
            <dl><ShareFigure label="Pending" amount={line.remaining} tone={postponed ? "text-primary-accent-text" : "text-settle-receivable-text"} /></dl>
          ) : <span className="font-semibold text-success">Settled</span>}
          {open && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" aria-label={`Reimbursement actions for ${line.personName}`} className="grid size-7 shrink-0 place-items-center rounded-[6px] text-muted-foreground outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
                  <Ellipsis className="size-4" aria-hidden />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem asChild><Link href={settleHref}><HandCoins aria-hidden /> Receive in People</Link></DropdownMenuItem>
                <DropdownMenuItem asChild><Link href={postponeHref}><CalendarClock aria-hidden /> Postpone in People</Link></DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>
      {hasReceiptDetails && (
        <details className="group/receipts">
          <summary className="inline-flex min-h-6 cursor-pointer list-none items-center gap-1 rounded text-[11px] font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
            <ChevronDown className="size-3 group-open/receipts:rotate-180" aria-hidden />
            Receipts
          </summary>
          {(fromAdvance > PAYMENT_EPSILON || line.paidDirectly) && (
            <p className="text-[11px] text-muted-foreground">
              {fromAdvance > PAYMENT_EPSILON && <span>{formatCurrencyExact(fromAdvance)} applied from advance</span>}
              {fromAdvance > PAYMENT_EPSILON && line.paidDirectly && " · "}
              {line.paidDirectly && <span>Includes direct lender payment</span>}
            </p>
          )}
          {available > PAYMENT_EPSILON && (
            <p className="text-[11px] text-settle-advance-text">
              <strong>{formatCurrencyExact(available)}</strong> available advance
              {earlier > PAYMENT_EPSILON && <span className="text-muted-foreground"> · {earlier < available ? `${formatCurrencyExact(earlier)} from earlier cycles` : "From earlier cycles"}</span>}
            </p>
          )}
          <InstallmentReceiptHistory personName={line.personName} obligationKey={line.key} receipts={receipts} loading={receiptsLoading} />
        </details>
      )}
    </li>
  );
}

function ShareFigure({ label, amount, tone }: { label: string; amount: number; tone?: string }) {
  return (
    <div className="flex items-baseline gap-1 whitespace-nowrap">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("font-semibold tabular-nums", tone ?? "text-foreground")}>{formatCurrencyExact(amount)}</dd>
    </div>
  );
}
