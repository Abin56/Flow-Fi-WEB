"use client";

import { CalendarClock, Check, Ellipsis, HandCoins, Receipt, Wallet } from "lucide-react";
import Link from "next/link";
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Money } from "@/features/loans/components/loan-emi-ui";
import { HISTORICAL_PAYMENT_LABEL } from "@/features/loans/lib/historical-payment";
import { PERSON_STATUS_LABEL, type AgreementPeopleLine, type PersonShareStatus } from "@/features/loans/lib/agreement-people";
import { BANK_STATUS_TEXT, LENDER_STATUS_TEXT, type InstallmentTableRow } from "@/features/loans/lib/installment-table";
import { peoplePostponeHref, peopleSettleHref } from "@/lib/engines/linked-people-readiness";
import { useAccounts } from "@/hooks/use-accounts";
import { useTransactions } from "@/hooks/use-transactions";
import { formatCurrency } from "@/lib/format";
import type { Installment, InstallmentStatus } from "@/lib/models/payment-schedule";
import type { OwnershipSource } from "@/lib/engines/debt-ownership";
import { TheyPaidPanel } from "@/features/loans/components/they-paid-panel";
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
const PEOPLE_TONE: Record<PersonShareStatus, string> = {
  received: "text-[oklch(0.44_0.13_149)] dark:text-success",
  partial: "text-warning-foreground dark:text-warning",
  pending: "text-settle-receivable-text",
  postponed: "text-primary-accent-text",
};

type Filter = "all" | "unpaid";

/**
 * The schedule as a dense, spreadsheet-style table: one 30px row per installment, tabular numbers, a sticky header and a
 * totals row. Selecting a row (click, or ↑/↓) fills the strip beneath; nothing here writes anything. The Bank column is
 * the lender side, the "Their payment" column (shared agreements only) the people side — separate facts.
 */
export function InstallmentGrid({
  rows,
  selectedId,
  onSelect,
  total,
  lent,
  showPeople,
}: {
  rows: InstallmentTableRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  total: number;
  lent: boolean;
  showPeople: boolean;
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
        <span className="text-xs font-semibold text-foreground">
          {shown.length} <span className="font-medium text-muted-foreground">of {total > 0 ? total : rows.length} installments</span>
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
        <table className="w-full min-w-[40rem] border-separate border-spacing-0 text-[12.5px]">
          <thead>
            <tr>
              <th className={cn(th, "w-12 pl-3")}>#</th>
              <th className={th}>Due date</th>
              <th className={cn(th, num)}>{lent ? "Expected" : "Amount"}</th>
              <th className={cn(th, num)}>{lent ? "Received" : "Paid"}</th>
              <th className={cn(th, num)}>Left</th>
              <th className={th}>{lent ? "Status" : showPeople ? "Lender payment" : "Bank"}</th>
              {showPeople && <th className={cn(th, "pr-3")}>Person repayment</th>}
            </tr>
          </thead>
          <tbody ref={bodyRef} onKeyDown={onKeyDown}>
            {shown.length === 0 && (
              <tr>
                <td colSpan={showPeople ? 7 : 6} className="px-3 py-6 text-center text-xs text-muted-foreground">
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
                      {(lent || !showPeople ? BANK_STATUS_TEXT : LENDER_STATUS_TEXT)[r.status]}
                      {r.earlier && <span className="text-[10.5px] font-medium text-muted-foreground">· earlier</span>}
                    </span>
                  </td>
                  {showPeople && (
                    <td className={cn(cell, "pr-3")}>
                      {r.people ? <span className={cn("font-medium", PEOPLE_TONE[r.people])}>{PERSON_STATUS_LABEL[r.people]}</span> : <span className="text-muted-foreground">–</span>}
                    </td>
                  )}
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
                <td colSpan={showPeople ? 2 : 1} className="sticky bottom-0 border-t border-border-strong bg-secondary" />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
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
  total,
  lent,
  peopleLines,
  onPay,
  onViewPayment,
  onTheyPaid,
  peopleTarget,
  returnTo,
}: {
  row: InstallmentTableRow | null;
  total: number;
  lent: boolean;
  peopleLines: readonly AgreementPeopleLine[];
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
        Select an installment to see its details and actions.
      </div>
    );
  }
  const i = row.installment;
  const txn = row.recorded?.transactionId ? transactions.find((t) => t.id === row.recorded!.transactionId) : null;
  const account = txn?.accountId ? accounts.find((a) => a.id === txn.accountId) : null;
  const paidFrom = account ? (account.accountNumberLast4 ? `${account.name} ••${account.accountNumberLast4}` : account.name) : null;
  const sharing = peopleLines.filter((l) => l.share > 0.005);
  const loanDetail = peopleTarget?.sourceKind === "loan";
  const peopleAction = onTheyPaid && !lent && sharing.some((l) => l.remaining > 0.005) && (
    <button
      type="button"
      onClick={() => (peopleTarget ? setPanel((p) => (p?.id === i.id ? null : { id: i.id, n: (p?.n ?? 0) + 1 })) : onTheyPaid(i))}
      aria-expanded={peopleTarget ? panel?.id === i.id : undefined}
      data-testid="installment-they-paid"
      className={cn("inline-flex h-8 items-center gap-1.5 rounded-[6px] border border-border-strong bg-card px-2.5 text-xs font-semibold text-foreground outline-none transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring", loanDetail && "h-7 border-border")}
    >
      <HandCoins className="size-3.5" strokeWidth={1.75} aria-hidden />
      {loanDetail ? "Record or link" : "They paid"}
    </button>
  );
  const peopleList = sharing.length > 0 && (
    <ul className={cn("divide-y divide-border/70", !loanDetail && "mt-2 rounded-[6px] border border-border bg-card")} aria-label="People sharing this installment">
      {sharing.map((l, n) => (
        <PersonLine key={`${l.key}-${n}`} line={l} returnTo={returnTo} compact={loanDetail} />
      ))}
    </ul>
  );
  const receiptPanel = peopleTarget && panel?.id === i.id && (
    <TheyPaidPanel key={panel.n} {...peopleTarget} installmentId={i.id} onClose={() => setPanel(null)} />
  );
  const lenderDetails = (
      <div className={cn("flex flex-wrap items-start gap-x-6 gap-y-2", loanDetail && "items-center gap-x-3 rounded-[10px] border border-border bg-card px-3 py-2.5")}>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
            Installment {row.sequenceNumber}
            {total > 0 ? ` of ${total}` : ""}
          </span>
          <span className="text-[13px] font-semibold text-foreground">
            {dateText(row.dueDate)} · <span className={BANK_TONE[row.status]}>{(lent || sharing.length === 0 ? BANK_STATUS_TEXT : LENDER_STATUS_TEXT)[row.status]}</span>
          </span>
          {row.recorded ? (
            <span className="text-xs text-muted-foreground">
              {row.earlier ? (
                <>
                  {HISTORICAL_PAYMENT_LABEL} — {lent ? "no account credit" : "no account debit"}
                  {row.earlier.dateKnown && row.paidOn ? ` · ${dateText(row.paidOn)}` : " · date not known"}
                </>
              ) : (
                <>
                  {lent ? "Received" : "Paid"} {row.paidOn ? dateText(row.paidOn) : ""}
                  {paidFrom ? ` from ${paidFrom}` : ""}
                </>
              )}
            </span>
          ) : !loanDetail ? (
            <span className="text-xs text-muted-foreground">{row.canPay ? "Nothing recorded yet" : "Nothing to pay"}</span>
          ) : null}
        </div>

        <dl className={cn("flex flex-wrap items-start gap-x-5 gap-y-1 text-xs", loanDetail && "gap-x-3")}>
          <div>
            <dt className="text-muted-foreground">Amount</dt>
            <dd className="font-semibold text-foreground tabular-nums">{formatCurrency(i.amountDue)}</dd>
          </div>
          {i.principalPortion != null && i.interestPortion != null && (
            <div>
              <dt className="text-muted-foreground">Principal · interest</dt>
              <dd className="font-semibold text-foreground tabular-nums">
                {formatCurrency(i.principalPortion)} · {formatCurrency(i.interestPortion)}
              </dd>
            </div>
          )}
          <div>
            <dt className="text-muted-foreground">{lent ? "Received" : "Paid"}</dt>
            <dd className="font-semibold text-foreground tabular-nums">{formatCurrency(row.paid)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{loanDetail ? "Still due" : "Left"}</dt>
            <dd className={cn("font-semibold tabular-nums", row.status === "overdue" ? "text-expense" : "text-foreground")}>{formatCurrency(row.left)}</dd>
          </div>
        </dl>

        <div className={cn("ml-auto flex items-center gap-2", loanDetail ? "max-w-full flex-wrap justify-end" : "shrink-0")}>
          {row.recorded && (
            <button
              type="button"
              onClick={() => onViewPayment(row.recorded!)}
              className="inline-flex h-8 items-center gap-1.5 rounded-[6px] border border-border-strong bg-card px-2.5 text-xs font-semibold text-foreground outline-none transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Receipt className="size-3.5" strokeWidth={1.75} />
              {row.editable ? "Edit payment" : "Payment details"}
            </button>
          )}
          {!loanDetail && peopleAction}
          {row.canPay ? (
            <button
              type="button"
              onClick={() => onPay(i)}
              className="inline-flex h-8 items-center gap-1.5 rounded-[6px] border border-primary-accent-text bg-primary px-3 text-xs font-semibold text-primary-foreground outline-none transition-colors hover:bg-primary/85 focus-visible:ring-2 focus-visible:ring-ring"
            >
              {loanDetail && <Wallet className="size-3.5" aria-hidden />}
              {lent ? "Record" : loanDetail ? "Pay lender" : "Pay"} {formatCurrency(row.left)}
            </button>
          ) : row.status === "paid" ? (
            <span className="inline-flex h-8 items-center gap-1 text-xs font-semibold text-success">
              <Check className="size-4" strokeWidth={2.5} aria-hidden /> {lent ? "Received" : loanDetail ? "Paid to lender" : "Bank paid"}
            </span>
          ) : null}
        </div>
      </div>
  );

  if (loanDetail) return (
    <section aria-label={`Installment ${row.sequenceNumber}`} data-testid="installment-detail" className="max-h-[48%] shrink-0 overflow-y-auto overscroll-contain border-t border-border bg-secondary/30 px-3 py-2.5">
      <div className={cn("grid gap-2.5", peopleList && "@3xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]")}>
        {lenderDetails}
        {peopleList && <section aria-label="People reimbursements" className="min-w-0 overflow-hidden rounded-[10px] border border-settle-receivable-text/25 bg-card">
          <div className="flex flex-wrap items-center justify-between gap-1.5 border-b border-settle-receivable-text/20 bg-settle-receivable-tint/40 px-3 py-1.5">
            <h3 className="flex items-center gap-1.5 text-[11px] font-semibold tracking-[0.06em] text-settle-receivable-text uppercase"><HandCoins className="size-3.5" aria-hidden /> Reimbursements</h3>
            {peopleAction}
          </div>
          {peopleList}
        </section>}
      </div>
      {receiptPanel}
    </section>
  );

  return (
    <section aria-label={`Installment ${row.sequenceNumber}`} data-testid="installment-detail" className="shrink-0 border-t border-border-strong bg-secondary/40 px-4 py-2.5 duration-150 animate-in fade-in-0 motion-reduce:animate-none">
      {lenderDetails}
      {receiptPanel}
      {peopleList}
    </section>
  );
}

function PersonLine({ line, returnTo, compact = false }: { line: AgreementPeopleLine; returnTo: string; compact?: boolean }) {
  const open = line.remaining > 0.005;
  const settleHref = peopleSettleHref(line.personId, line.key, returnTo);
  const postponeHref = peoplePostponeHref(line.personId, line.key, returnTo);
  const status = (
    <span className={cn("font-medium", PEOPLE_TONE[line.status])}>
      {PERSON_STATUS_LABEL[line.status]}
      {line.status === "postponed" && line.postponedDate ? ` until ${dateText(line.postponedDate)}` : ""}
    </span>
  );
  if (compact) return (
    <li className="flex items-center gap-2 px-3 py-1.5 text-xs" data-testid="installment-person">
      <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
        <span className="font-semibold text-foreground">{line.personName}</span>
        <span className="text-muted-foreground tabular-nums">{formatCurrency(Math.min(line.received, line.share))} of {formatCurrency(line.share)} received</span>
        {status}
      </div>
      {open && <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label={`Reimbursement actions for ${line.personName}`} className="grid size-7 shrink-0 place-items-center rounded-[6px] text-muted-foreground outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
            <Ellipsis className="size-4" aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem asChild><Link href={settleHref}><HandCoins aria-hidden /> Record in People</Link></DropdownMenuItem>
          <DropdownMenuItem asChild><Link href={postponeHref}><CalendarClock aria-hidden /> Postpone collection</Link></DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>}
    </li>
  );
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-1.5 text-xs" data-testid="installment-person">
      <span className="min-w-[7rem] font-semibold text-foreground">{line.personName}</span>
      <span className="tabular-nums text-muted-foreground">
        {formatCurrency(Math.min(line.received, line.share))} of {formatCurrency(line.share)} received
      </span>
      {status}
      {open && (
        <span className="ml-auto flex items-center gap-1.5">
          <Link href={settleHref} aria-label={`Record money received from ${line.personName} in People`} className="rounded-[5px] border border-primary-accent-text bg-primary px-2 py-0.5 font-semibold text-primary-foreground hover:bg-primary/85">
            Record received
          </Link>
          <Link href={postponeHref} aria-label={`Postpone collecting ${line.personName}'s share in People`} className="rounded-[5px] border border-border-strong bg-card px-2 py-0.5 font-semibold text-foreground hover:bg-secondary">
            Postpone
          </Link>
        </span>
      )}
    </li>
  );
}
