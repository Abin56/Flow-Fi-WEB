"use client";

/**
 * Balance Control's outstanding / available-credit reconciliation guide (Part A, priority 2). Shows the bank
 * figure, FlowFi's figure, the difference and an as-of date; lists existing transactions already on this card
 * near that date (so the user doesn't duplicate one); lets the user pick what caused the gap; and for each
 * cause either:
 *  - links to the existing, already-safe workflow that resolves it (Add Expense on this card, or Pay bill —
 *    never a new write path here, and a card payment is ALWAYS routed to Pay bill, never Add Expense, so it
 *    can never be recorded as an ordinary expense);
 *  - explains a legitimate, non-correctable difference (card-EMI lock, shared limit, statement timing) with NO
 *    action — no transaction is invented to force the numbers to match;
 *  - or leaves an unexplained gap for manual review, unresolved, rather than guessing.
 *
 * This component writes nothing itself. The only write anywhere in Balance Control remains the Phase-1 credit
 * limit correction (`limit-correction-sheet.tsx`), reused here unchanged for the "opening outstanding" cause.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowRight, Check, ShieldCheck } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { cardStatementAmount, countsTowardCardStatement, isCardBillPaymentLeg } from "@/lib/repositories/credit-card-repository";
import {
  RECONCILIATION_CAUSE_LABEL,
  reconciliationCausesFor,
  type OutstandingReconciliationCause,
  type ReconciliationCauseOption,
} from "@/lib/engines/outstanding-reconciliation";
import type { Transaction } from "@/lib/models/transaction";
import type { VarianceMetric } from "@/lib/engines/balance-variance";
import { formatCurrencyPrecise } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ReconciliationCardContext } from "../lib/build-balance-control";

const AFFECTED_FOR_CHARGE = ["Total outstanding", "Available credit", "Utilization", "Dashboard", "Accounts", "Reports", "Net Worth"];
const AFFECTED_FOR_PAYMENT = ["Total outstanding", "Available credit", "Utilization", "Accounts", "Dashboard", "Reports", "Net Worth"];
const UNAFFECTED_ALWAYS = ["Transaction history", "People Ledger", "Loans", "EMI", "Month Cycle"];

function relevantTransactions(all: readonly Transaction[], cardAccountId: string, asOf: Date): Transaction[] {
  const windowStart = new Date(asOf.getTime() - 10 * 24 * 60 * 60 * 1000);
  const windowEnd = new Date(asOf.getTime() + 3 * 24 * 60 * 60 * 1000);
  return all
    .filter((t) => t.accountId === cardAccountId && t.deletedAt == null && t.dateTime >= windowStart && t.dateTime <= windowEnd)
    .sort((a, b) => b.dateTime.getTime() - a.dateTime.getTime())
    .slice(0, 8);
}

function describeTransaction(t: Transaction): { label: string; amount: number; kind: "charge" | "payment" | "credit" } {
  if (isCardBillPaymentLeg(t)) return { label: "Payment received", amount: t.amount, kind: "payment" };
  if (!countsTowardCardStatement(t)) return { label: t.description || "Excluded", amount: t.amount, kind: t.type === "income" ? "credit" : "charge" };
  const amount = cardStatementAmount(t);
  return { label: t.description || (amount >= 0 ? "Charge" : "Credit"), amount: Math.abs(amount), kind: amount >= 0 ? "charge" : "credit" };
}

const TX_KIND_CLASS: Record<"charge" | "payment" | "credit", string> = {
  charge: "text-foreground",
  payment: "text-success",
  credit: "text-success",
};

function CauseRow({ option, selected, onSelect }: { option: ReconciliationCauseOption; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      data-testid={`cause-${option.cause}`}
      aria-pressed={selected}
      className={cn(
        "w-full rounded-lg border px-3 py-2.5 text-left transition-colors",
        selected ? "border-primary/60 bg-primary/5" : "border-border hover:border-border-strong hover:bg-secondary/40",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-foreground">{option.label}</span>
        {selected && <Check className="size-4 shrink-0 text-primary" aria-hidden />}
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground">{option.hint}</p>
    </button>
  );
}

function ResolutionPanel({ option, cardAccountId }: { option: ReconciliationCauseOption; cardAccountId: string }) {
  const { resolution } = option;
  if (resolution.kind === "addExpense" || resolution.kind === "addPayment") {
    return (
      <div className="rounded-lg border border-border bg-secondary/30 p-3" data-testid="resolution-panel">
        <p className="text-sm text-foreground">{resolution.description}</p>
        <Link
          href={`/transactions?account=${cardAccountId}`}
          className="mt-2 inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
          data-testid="resolution-link-add-expense"
        >
          Go to Transactions for this card <ArrowRight className="size-3.5" />
        </Link>
        <p className="mt-1.5 text-xs text-muted-foreground">Opens with this card filtered. Use + Add there — existing transactions below are shown first so you don&rsquo;t duplicate one.</p>
      </div>
    );
  }
  if (resolution.kind === "payBill") {
    return (
      <div className="rounded-lg border border-border bg-secondary/30 p-3" data-testid="resolution-panel">
        <p className="text-sm text-foreground">{resolution.description}</p>
        <Link
          href={`/credit-cards?card=${cardAccountId}&pay=1`}
          className="mt-2 inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
          data-testid="resolution-link-pay-bill"
        >
          Open Pay bill for this card <ArrowRight className="size-3.5" />
        </Link>
      </div>
    );
  }
  if (resolution.kind === "correctLimit") {
    return (
      <div className="rounded-lg border border-border bg-secondary/30 p-3" data-testid="resolution-panel">
        <p className="text-sm text-foreground">{resolution.description}</p>
        <Link href="/financial-audit" className="mt-2 inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline">
          Open Financial Audit <ArrowRight className="size-3.5" />
        </Link>
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-border bg-secondary/30 p-3" data-testid="resolution-panel">
      <p className="text-sm text-foreground">{resolution.description}</p>
      <p className="mt-1 text-xs text-muted-foreground">Nothing is changed.</p>
    </div>
  );
}

export interface OutstandingReconciliationSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  productName: string;
  metric: Extract<VarianceMetric, "totalOutstanding" | "availableCredit">;
  flowfiValue: number;
  bankValue: number;
  asOfDate: Date;
  context: ReconciliationCardContext;
  transactions: readonly Transaction[];
}

export function OutstandingReconciliationSheet({
  open,
  onOpenChange,
  productName,
  metric,
  flowfiValue,
  bankValue,
  asOfDate,
  context,
  transactions,
}: OutstandingReconciliationSheetProps) {
  const [selectedCause, setSelectedCause] = useState<OutstandingReconciliationCause | null>(null);

  // availableCredit is the mirror of totalOutstanding: the bank reporting MORE available credit means it sees
  // LESS owed (the same "FlowFi missing a charge" direction totalOutstanding-higher means), so the sign used to
  // pick the cause list is flipped for this one metric.
  const rawDiff = bankValue - flowfiValue;
  const direction: "bankHigher" | "bankLower" = metric === "availableCredit" ? (rawDiff > 0 ? "bankLower" : "bankHigher") : rawDiff > 0 ? "bankHigher" : "bankLower";
  const amount = Math.round(Math.abs(rawDiff) * 100) / 100;

  const causes = useMemo(() => reconciliationCausesFor(direction, { ...context, amount }), [direction, context, amount]);
  const selected = causes.find((c) => c.cause === selectedCause) ?? null;
  const relevant = useMemo(() => relevantTransactions(transactions, context.cardAccountId, asOfDate), [transactions, context.cardAccountId, asOfDate]);
  const affected = selected?.resolution.kind === "payBill" ? AFFECTED_FOR_PAYMENT : AFFECTED_FOR_CHARGE;

  return (
    <Sheet open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) setSelectedCause(null); }}>
      <SheetContent side="bottom" className="mx-auto w-full sm:max-w-xl" data-testid="outstanding-reconciliation-sheet">
        <SheetHeader>
          <SheetTitle>Reconcile {RECONCILIATION_METRIC_LABEL[metric]} — {productName}</SheetTitle>
          <SheetDescription>Figure out what explains the gap. Nothing changes unless you follow a step below.</SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-4 overflow-y-auto px-4 pb-4">
          <div className="grid grid-cols-3 gap-3 rounded-lg border border-border bg-secondary/20 p-3">
            <div>
              <p className="text-[11px] font-medium text-muted-foreground uppercase">FlowFi</p>
              <p className="font-medium tabular-nums" data-testid="reconcile-flowfi-value">{formatCurrencyPrecise(flowfiValue)}</p>
            </div>
            <div>
              <p className="text-[11px] font-medium text-muted-foreground uppercase">Bank</p>
              <p className="font-medium tabular-nums" data-testid="reconcile-bank-value">{formatCurrencyPrecise(bankValue)}</p>
            </div>
            <div>
              <p className="text-[11px] font-medium text-muted-foreground uppercase">Difference</p>
              <p className="font-medium tabular-nums" data-testid="reconcile-difference">{formatCurrencyPrecise(amount)}</p>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">As of {asOfDate.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}</p>

          <section>
            <h3 className="text-sm font-semibold text-foreground">Existing transactions on this card nearby</h3>
            <p className="text-xs text-muted-foreground">Check here first — the difference may already be recorded.</p>
            <div className="mt-2 flex flex-col gap-1" data-testid="relevant-transactions">
              {relevant.length === 0 && <p className="text-xs text-muted-foreground">No transactions on this card in the nearby dates.</p>}
              {relevant.map((t) => {
                const d = describeTransaction(t);
                return (
                  <div key={t.id} className="flex items-center justify-between gap-2 rounded-md border border-border px-2.5 py-1.5 text-xs" data-testid="relevant-transaction-row">
                    <span className="min-w-0 truncate text-foreground">{d.label}</span>
                    <span className="shrink-0 text-muted-foreground">{t.dateTime.toLocaleDateString("en-IN", { day: "numeric", month: "short" })}</span>
                    <span className={cn("shrink-0 font-medium tabular-nums", TX_KIND_CLASS[d.kind])}>{formatCurrencyPrecise(d.amount)}</span>
                  </div>
                );
              })}
            </div>
          </section>

          <section>
            <h3 className="text-sm font-semibold text-foreground">What caused the difference?</h3>
            <div className="mt-2 flex flex-col gap-1.5" data-testid="cause-list">
              {causes.map((c) => (
                <CauseRow key={c.cause} option={c} selected={c.cause === selectedCause} onSelect={() => setSelectedCause(c.cause)} />
              ))}
            </div>
          </section>

          {selected && (
            <section data-testid="cause-detail">
              <h3 className="text-sm font-semibold text-foreground">{RECONCILIATION_CAUSE_LABEL[selected.cause]}</h3>
              <ResolutionPanel option={selected} cardAccountId={context.cardAccountId} />
              <div className="mt-3 rounded-xl border border-border p-3" data-testid="reconcile-impact-preview">
                <h4 className="text-sm font-semibold text-foreground">If this is confirmed and recorded</h4>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {affected.map((m) => <Badge key={m} variant="secondary">{m}</Badge>)}
                </div>
                <p className="mt-1.5 text-xs text-muted-foreground">Left untouched: {UNAFFECTED_ALWAYS.join(", ")}.</p>
              </div>
            </section>
          )}

          <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
            <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            This guide never writes a transaction itself. Outstanding and available credit are never set directly — they are always recalculated from your transactions.
          </p>
          {selected?.resolution.kind === "reviewOnly" && (
            <p className="flex items-start gap-1.5 rounded-lg border border-warning/50 bg-warning/10 p-2.5 text-xs text-foreground" data-testid="reconcile-review-notice">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              Left for manual review — no correction is applied here.
            </p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

const RECONCILIATION_METRIC_LABEL: Record<"totalOutstanding" | "availableCredit", string> = {
  totalOutstanding: "total outstanding",
  availableCredit: "available credit",
};
