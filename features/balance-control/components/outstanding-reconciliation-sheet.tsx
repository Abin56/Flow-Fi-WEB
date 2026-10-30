"use client";

/**
 * Balance Control's outstanding / available-credit reconciliation guide (Part A, priority 2). A compact dialog (a
 * bottom sheet on phones) that states the gap in one sentence, asks the user — in plain words — what most likely
 * caused it, and then shows ONE next step for that cause:
 *  - a link to the existing, already-safe workflow that resolves it (Add Expense on this card, or Pay bill — never a
 *    new write path here, and a card payment is ALWAYS routed to Pay bill, never Add Expense, so it can never be
 *    recorded as an ordinary expense);
 *  - an explanation of a legitimate, non-correctable difference (card-EMI lock, shared limit, statement timing) with
 *    NO action — no transaction is invented to force the numbers to match;
 *  - or a manual-review note for a gap nothing here can explain, left unresolved rather than guessed.
 * Nearby card transactions and the "what will change" preview sit in collapsible sections below.
 *
 * The plain-language choices are labels only: every option is still one of the engine's cause codes, offered under
 * the engine's own eligibility rules (`reconciliationCausesFor`).
 *
 * This component writes nothing itself. The only write anywhere in Balance Control remains the Phase-1 credit
 * limit correction (`limit-correction-sheet.tsx`).
 */

import { useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowRight, Check, ChevronDown, ShieldCheck } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cardStatementAmount, countsTowardCardStatement, isCardBillPaymentLeg } from "@/lib/repositories/credit-card-repository";
import {
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

/** The cause codes in everyday words — what the user did or saw, not the accounting term. */
const FRIENDLY_LABEL: Record<OutstandingReconciliationCause, string> = {
  missingPurchase: "I made a purchase FlowFi doesn't have",
  interestCharge: "The bank charged interest",
  gst: "The bank added GST",
  lateFee: "The bank charged a late fee",
  otherCharge: "Another bank fee or charge",
  missingPayment: "I made a payment",
  refundOrCredit: "I received a refund or credit",
  cardEmiOrSharedLimit: "This card has an EMI or a shared limit",
  statementTiming: "The bank hasn't updated yet",
  openingOutstanding: "An old balance from before FlowFi",
  unknown: "I'm not sure",
};

function friendlyLabel(cause: OutstandingReconciliationCause, context: ReconciliationCardContext): string {
  if (cause === "cardEmiOrSharedLimit") {
    if (context.onSharedLimit) return "This card shares a credit limit";
    if (context.lockedEmiPrincipal > 0) return "An EMI is locked on this card";
  }
  return FRIENDLY_LABEL[cause];
}

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
/** Debit (adds to what is owed on the card) vs credit (reduces it) — spelled out, not left to colour alone. */
const TX_KIND_TAG: Record<"charge" | "payment" | "credit", string> = { charge: "Debit", payment: "Payment · credit", credit: "Credit" };

const ACTION = "inline-flex h-10 items-center justify-center gap-1.5 rounded-lg px-4 text-sm font-semibold transition-[background-color,box-shadow] outline-none focus-visible:ring-3 focus-visible:ring-ring/40";
const PRIMARY_ACTION = cn(ACTION, "bg-primary text-primary-foreground shadow-e1 hover:bg-[var(--primary-hover)]");
const SECONDARY_ACTION = cn(ACTION, "border border-border-strong bg-card text-foreground hover:bg-muted");

function CauseRow({
  option,
  label,
  selected,
  anySelected,
  first,
  onSelect,
}: {
  option: ReconciliationCauseOption;
  label: string;
  selected: boolean;
  /** Roving tabindex: the group is one Tab stop — the chosen reason, or the first one before any is chosen. */
  anySelected: boolean;
  first: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      data-testid={`cause-${option.cause}`}
      tabIndex={selected || (!anySelected && first) ? 0 : -1}
      className={cn(
        "flex min-h-12 w-full items-start gap-3 rounded-xl px-3.5 py-3 text-left transition-colors duration-100 outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        selected ? "bg-accent ring-1 ring-primary-accent-text/25" : "hover:bg-muted",
      )}
    >
      {/* Radio marker: one reason at a time. */}
      <span
        className={cn(
          "mt-0.5 flex size-[18px] shrink-0 items-center justify-center rounded-full border transition-colors",
          selected ? "border-primary-accent-text bg-primary-accent-text text-white" : "border-border-strong bg-background",
        )}
        aria-hidden
      >
        {selected && <Check className="size-3" strokeWidth={3} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn("block text-sm text-foreground", selected ? "font-semibold" : "font-medium")}>{label}</span>
        {selected && <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{option.hint}</span>}
      </span>
    </button>
  );
}

/** The single next step for the chosen reason: what it means, and the one existing workflow (if any) that resolves it. */
function NextStep({ option, context }: { option: ReconciliationCauseOption; context: ReconciliationCardContext }) {
  const { resolution, cause } = option;
  const transactionsHref = `/transactions?account=${context.cardAccountId}`;
  let action: ReactNode = null;
  let tone: "action" | "explained" | "review" = "action";
  if (resolution.kind === "addExpense" || resolution.kind === "addPayment") {
    action = (
      <Link href={transactionsHref} className={PRIMARY_ACTION} data-testid="resolution-link-add-expense">
        {resolution.kind === "addPayment" ? "Add missing refund" : cause === "missingPurchase" ? "Add missing purchase" : "Add missing charge"}
        <ArrowRight className="size-4" aria-hidden />
      </Link>
    );
  } else if (resolution.kind === "payBill") {
    action = (
      <Link href={`/credit-cards?card=${context.cardAccountId}&pay=1`} className={PRIMARY_ACTION} data-testid="resolution-link-pay-bill">
        Record missing payment <ArrowRight className="size-4" aria-hidden />
      </Link>
    );
  } else if (resolution.kind === "correctLimit") {
    action = (
      <Link href="/financial-audit" className={SECONDARY_ACTION}>
        Open Financial Audit <ArrowRight className="size-4" aria-hidden />
      </Link>
    );
  } else if (resolution.kind === "explainedNoAction") {
    tone = "explained";
    if (cause === "cardEmiOrSharedLimit" && context.onSharedLimit) {
      action = (
        <Link href={`/credit-cards?card=${context.cardAccountId}`} className={SECONDARY_ACTION} data-testid="resolution-link-shared-limit">
          Review shared credit limit <ArrowRight className="size-4" aria-hidden />
        </Link>
      );
    }
  } else {
    tone = "review";
    action = (
      <Link href={transactionsHref} className={SECONDARY_ACTION} data-testid="resolution-link-view-transactions">
        View card transactions <ArrowRight className="size-4" aria-hidden />
      </Link>
    );
  }
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4" data-testid="resolution-panel">
      <p className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Next step</p>
      <p className="-mt-1.5 text-sm leading-relaxed text-foreground">{resolution.description}</p>
      {tone === "explained" && <p className="-mt-1.5 text-xs text-muted-foreground">Nothing is changed.</p>}
      {tone === "review" && (
        <p className="-mt-1 flex items-start gap-1.5 text-xs text-foreground" data-testid="reconcile-review-notice">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning-foreground dark:text-warning" aria-hidden />
          Left for manual review — no correction is applied here.
        </p>
      )}
      {action && <div className="flex flex-wrap gap-2">{action}</div>}
      {(resolution.kind === "addExpense" || resolution.kind === "addPayment" || resolution.kind === "payBill") && (
        <p className="text-xs text-muted-foreground">Opens the usual form for this card. Check the recent transactions below first so nothing is entered twice.</p>
      )}
    </div>
  );
}

/** A quiet, optional section: closed by default, one line when closed. */
function More({ title, meta, children, testId }: { title: string; meta?: string; children: ReactNode; testId?: string }) {
  return (
    <details className="group border-t border-border" data-testid={testId}>
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 py-2.5 text-sm font-medium text-foreground outline-none focus-visible:rounded-md focus-visible:ring-2 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 flex-1">{title}</span>
        {meta && <span className="text-xs font-normal text-muted-foreground">{meta}</span>}
        <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform duration-150 group-open:rotate-180" aria-hidden />
      </summary>
      <div className="pb-3">{children}</div>
    </details>
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
  const matches = amount === 0;

  const causes = useMemo(() => reconciliationCausesFor(direction, { ...context, amount }), [direction, context, amount]);
  const selected = causes.find((c) => c.cause === selectedCause) ?? null;
  const relevant = useMemo(() => relevantTransactions(transactions, context.cardAccountId, asOfDate), [transactions, context.cardAccountId, asOfDate]);
  const affected = selected?.resolution.kind === "payBill" ? AFFECTED_FOR_PAYMENT : AFFECTED_FOR_CHARGE;
  const changesSomething = selected != null && (selected.resolution.kind === "addExpense" || selected.resolution.kind === "addPayment" || selected.resolution.kind === "payBill");
  const noun = RECONCILIATION_METRIC_LABEL[metric];

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (!v) setSelectedCause(null);
      }}
    >
      <DialogContent
        data-testid="outstanding-reconciliation-sheet"
        className={cn(
          "flex flex-col gap-0 overflow-hidden p-0 sm:max-w-[640px]",
          "max-h-[min(88dvh,860px)]",
          // Phones: a bottom sheet, full width, its body scrolls.
          "max-sm:top-auto max-sm:bottom-0 max-sm:max-w-none max-sm:translate-y-0 max-sm:rounded-b-none max-sm:rounded-t-2xl",
        )}
      >
        <div className="shrink-0 px-5 pt-5 pb-4 sm:px-6">
          <p className="text-xs font-medium text-muted-foreground">Reconcile {noun}</p>
          <DialogTitle className="mt-0.5 truncate pr-8 font-heading text-lg font-semibold tracking-tight text-foreground" title={productName}>
            {productName}
          </DialogTitle>
          <DialogDescription className="sr-only">Compare FlowFi with your bank and pick what explains the difference. Nothing changes unless you follow a step.</DialogDescription>

          <dl className="mt-4 grid grid-cols-3 divide-x divide-border rounded-xl bg-muted/60">
            <div className="min-w-0 px-3 py-2.5">
              <dt className="text-[11px] text-muted-foreground">FlowFi</dt>
              <dd className="truncate text-[15px] font-semibold tabular-nums sm:text-base" data-testid="reconcile-flowfi-value">{formatCurrencyPrecise(flowfiValue)}</dd>
            </div>
            <div className="min-w-0 px-3 py-2.5">
              <dt className="text-[11px] text-muted-foreground">Bank shows</dt>
              <dd className="truncate text-[15px] font-semibold tabular-nums sm:text-base" data-testid="reconcile-bank-value">{formatCurrencyPrecise(bankValue)}</dd>
            </div>
            <div className="min-w-0 px-3 py-2.5">
              <dt className="text-[11px] text-muted-foreground">Difference</dt>
              <dd className={cn("truncate text-[15px] font-semibold tabular-nums sm:text-base", matches ? "text-success" : "text-warning-foreground dark:text-warning")} data-testid="reconcile-difference">
                {formatCurrencyPrecise(amount)}
              </dd>
            </div>
          </dl>
          <p className="mt-2.5 text-sm text-foreground" data-testid="reconcile-summary">
            {matches ? (
              <>Your bank and FlowFi show the same {noun}. Nothing to reconcile.</>
            ) : (
              <>
                Your bank shows <span className="font-semibold tabular-nums">{formatCurrencyPrecise(amount)}</span> {rawDiff > 0 ? "more" : "less"} {noun} than FlowFi.
              </>
            )}
          </p>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain border-t border-border px-5 pt-4 pb-2 sm:px-6">
          {!matches && (
            <section aria-labelledby="recon-why">
              <h3 id="recon-why" className="text-sm font-semibold text-foreground">What do you think happened?</h3>
              <div
                role="radiogroup"
                aria-labelledby="recon-why"
                className="mt-2 flex flex-col gap-0.5"
                data-testid="cause-list"
                // Arrow keys move between reasons and select, as in any radio group.
                onKeyDown={(e) => {
                  const step = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
                  if (step === 0) return;
                  e.preventDefault();
                  const current = causes.findIndex((c) => c.cause === selectedCause);
                  const next = causes[(Math.max(current, step > 0 ? -1 : 0) + step + causes.length) % causes.length];
                  setSelectedCause(next.cause);
                  e.currentTarget.querySelector<HTMLElement>(`[data-testid="cause-${next.cause}"]`)?.focus();
                }}
              >
                {causes.map((c, i) => (
                  <CauseRow
                    key={c.cause}
                    option={c}
                    label={friendlyLabel(c.cause, context)}
                    selected={c.cause === selectedCause}
                    anySelected={selectedCause != null}
                    first={i === 0}
                    onSelect={() => setSelectedCause(c.cause)}
                  />
                ))}
              </div>
            </section>
          )}

          {selected && (
            <div className="mt-3" data-testid="cause-detail">
              <NextStep option={selected} context={context} />
            </div>
          )}

          <div className="mt-4">
            <More title="Recent transactions on this card" meta={relevant.length === 0 ? "None nearby" : String(relevant.length)} testId="recon-more-transactions">
              <ul className={cn(relevant.length > 0 && "divide-y divide-border rounded-lg border border-border")} data-testid="relevant-transactions">
                {relevant.length === 0 && <li className="text-xs text-muted-foreground">None on this card from 10 days before to 3 days after {asOfDate.toLocaleDateString("en-IN", { day: "numeric", month: "short" })}.</li>}
                {relevant.map((t) => {
                  const d = describeTransaction(t);
                  return (
                    <li key={t.id} className="grid grid-cols-[3rem_minmax(0,1fr)_auto] items-center gap-3 px-3 py-2" data-testid="relevant-transaction-row">
                      <span className="text-xs text-muted-foreground tabular-nums">{t.dateTime.toLocaleDateString("en-IN", { day: "numeric", month: "short" })}</span>
                      <span className="min-w-0">
                        <span className="block truncate text-sm text-foreground">{d.label}</span>
                        <span className="block text-[11px] text-muted-foreground">{TX_KIND_TAG[d.kind]}</span>
                      </span>
                      <span className={cn("text-right text-sm font-medium tabular-nums", TX_KIND_CLASS[d.kind])}>
                        {d.kind !== "charge" ? "−" : ""}
                        {formatCurrencyPrecise(d.amount)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </More>
            {changesSomething && (
              <More title="What will change?" testId="recon-more-impact">
                <div className="flex flex-col gap-2 text-xs" data-testid="reconcile-impact-preview">
                  <p className="text-muted-foreground">Only once you record it in the form above:</p>
                  <p className="text-foreground">{affected.join(" · ")}</p>
                  <p className="text-muted-foreground">
                    <span className="font-medium text-foreground">Stays unchanged:</span> {UNAFFECTED_ALWAYS.join(", ")}.
                  </p>
                </div>
              </More>
            )}
          </div>
        </div>

        <p className="flex shrink-0 items-start gap-1.5 border-t border-border bg-muted/40 px-5 py-3 text-xs text-muted-foreground sm:px-6">
          <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden />
          This guide never records anything itself. {noun === "available credit" ? "Available credit" : "Outstanding"} is always recalculated from your transactions.
        </p>
      </DialogContent>
    </Dialog>
  );
}

const RECONCILIATION_METRIC_LABEL: Record<"totalOutstanding" | "availableCredit", string> = {
  totalOutstanding: "outstanding",
  availableCredit: "available credit",
};
