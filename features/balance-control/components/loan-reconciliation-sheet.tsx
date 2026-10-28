"use client";

/**
 * Balance Control's Loan / EMI reconciliation guide. The user enters what the lender actually reports (principal,
 * as-of date, reason, and optionally EMI / rate / remaining installments); `reconcileLoan` compares it with
 * FlowFi's schedule and payment history, ranks the likely causes with their evidence and shows a before/after
 * preview. Every correction is a hand-off — a link that opens an EXISTING, already-safe workflow (Record Payment on
 * the right installment, Record past payments, Additional disbursement, the agreement's own history) — so this
 * sheet writes nothing, never overwrites principal / outstanding / schedules / paid installments and cannot create
 * a duplicate payment. A cause that would need a write FlowFi does not have names that exact method and stops.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowRight, Check, CreditCard, ShieldCheck } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { formatCurrencyPrecise } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  reconcileLoan,
  type LoanReconCause,
  type LoanReconInput,
  type LoanReconResolution,
  type ReconPayment,
} from "@/lib/engines/loan-reconciliation";
import { useEmiPaymentHistory, useLoanPaymentHistory } from "@/features/loans/hooks/use-payment-history";
import type { LoanReconciliationContext } from "../lib/build-balance-control";

export const RECON_REASONS = [
  { value: "statement", label: "Lender statement / app shows a different figure" },
  { value: "payment", label: "I paid or may have paid and it isn't reflected" },
  { value: "foreclosure", label: "Foreclosure or part-prepayment quote" },
  { value: "rescheduled", label: "Lender re-priced or re-scheduled the loan" },
  { value: "other", label: "Something else" },
] as const;

const todayInput = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const endOfDay = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return y && m && d ? new Date(y, m - 1, d, 23, 59, 59) : null;
};
const num = (raw: string): number | null => {
  const t = raw.replace(/[₹,\s]/g, "");
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const shortDate = (d: Date) => d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

const CONFIDENCE_LABEL = { strong: "Strong match", possible: "Possible", none: "Unconfirmed" } as const;

/** Hand-off URL for an existing workflow — the agreement (and installment) are already chosen. */
export function handoffHref(agreementId: string, resolution: LoanReconResolution): string | null {
  const base = `/loans?agreement=${encodeURIComponent(agreementId)}`;
  switch (resolution.kind) {
    case "recordPayment":
      return `${base}&pay=1&installment=${encodeURIComponent(resolution.installmentId)}${resolution.view === "past" ? "&view=past" : ""}`;
    case "payExtraPrincipal":
      return resolution.installmentId ? `${base}&pay=1&installment=${encodeURIComponent(resolution.installmentId)}` : base;
    case "addDisbursement":
      return `${base}&adjust=disbursement`;
    case "openAgreement":
      return base;
    default:
      return null;
  }
}

function Metric({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] font-medium text-muted-foreground uppercase">{label}</p>
      <p className="font-medium tabular-nums" data-testid={testId}>{value}</p>
    </div>
  );
}

function Field({ id, label, children, hint }: { id: string; label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="text-xs font-medium text-foreground">{label}</label>
      {children}
      {hint && <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

const INPUT = "mt-1 h-9 w-full rounded-[6px] border border-border-strong bg-card px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

function CauseDetail({ cause, agreementId, ready, cardLinkedName }: { cause: LoanReconCause; agreementId: string; ready: boolean; cardLinkedName: string | null }) {
  const { resolution, impact } = cause;
  const href = handoffHref(agreementId, resolution);
  const pastHref = resolution.kind === "recordPayment" && resolution.view === "pay" ? handoffHref(agreementId, { ...resolution, view: "past" }) : null;
  const linkClass = "inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline";
  return (
    <section data-testid="loan-cause-detail" className="flex flex-col gap-3">
      <h3 className="text-sm font-semibold text-foreground">{cause.label}</h3>
      <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground" data-testid="loan-cause-evidence">
        {cause.evidence.map((e) => <li key={e}>{e}</li>)}
      </ul>

      <div className="rounded-lg border border-border bg-secondary/30 p-3" data-testid="loan-resolution-panel" data-resolution={resolution.kind}>
        <p className="text-sm text-foreground">{resolution.description}</p>
        {resolution.kind === "needsApproval" && (
          <p className="mt-2 rounded-md border border-warning/50 bg-warning/10 p-2 text-xs text-foreground" data-testid="loan-needs-approval">
            <AlertTriangle className="mr-1 inline size-3.5 align-text-bottom" aria-hidden />
            <strong>Not executable yet.</strong> Missing write: <code className="break-all">{resolution.method}</code>. Nothing is changed.
          </p>
        )}
        {resolution.kind === "explainedNoAction" && <p className="mt-1 text-xs text-muted-foreground">Nothing is changed.</p>}
        {resolution.kind === "reviewOnly" && <p className="mt-1 text-xs text-muted-foreground">Left for review. Nothing is changed.</p>}
        {href && ready && (
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
            <Link href={href} className={linkClass} data-testid="loan-handoff-link">
              {resolution.kind === "recordPayment" ? "Open Record Payment, prefilled" : resolution.kind === "payExtraPrincipal" ? "Open Record Payment (extra principal)" : resolution.kind === "addDisbursement" ? "Open Additional disbursement" : "Open this agreement"} <ArrowRight className="size-3.5" />
            </Link>
            {pastHref && <Link href={pastHref} className={linkClass} data-testid="loan-handoff-past-link">Already paid earlier? Record past payments <ArrowRight className="size-3.5" /></Link>}
          </div>
        )}
        {href && !ready && <p className="mt-2 text-xs text-muted-foreground" data-testid="loan-handoff-locked">Enter the lender figure, as-of date and reason above to unlock this step.</p>}
      </div>

      {impact && (
        <div className="rounded-xl border border-border p-3" data-testid="loan-impact-preview">
          <h4 className="text-sm font-semibold text-foreground">If this is recorded</h4>
          <dl className="mt-1.5 grid grid-cols-[1fr_auto_auto] gap-x-4 gap-y-1 text-xs tabular-nums">
            <dt className="text-muted-foreground" />
            <dd className="text-right text-muted-foreground">Now</dd>
            <dd className="text-right text-muted-foreground">After</dd>
            <dt>Remaining principal</dt>
            <dd className="text-right">{formatCurrencyPrecise(impact.outstandingBefore)}</dd>
            <dd className="text-right font-medium" data-testid="loan-impact-after">{formatCurrencyPrecise(impact.outstandingAfter)}</dd>
            <dt>Installments paid</dt>
            <dd className="text-right">{impact.installmentsPaidBefore}</dd>
            <dd className="text-right font-medium">{impact.installmentsPaidAfter}</dd>
            <dt>Installments remaining</dt>
            <dd className="text-right">{impact.remainingInstallmentsBefore}</dd>
            <dd className="text-right font-medium">{impact.remainingInstallmentsAfter}</dd>
          </dl>
          <p className="mt-1.5 text-xs text-foreground" data-testid="loan-impact-gap">
            {Math.abs(impact.gapAfter) <= 1 ? "Matches the lender's figure afterwards." : `Still ${formatCurrencyPrecise(Math.abs(impact.gapAfter))} away from the lender's figure afterwards.`}
          </p>
          {impact.cardAvailableDelta != null && (
            <p className="mt-1 flex items-start gap-1.5 text-xs text-muted-foreground" data-testid="loan-impact-card">
              <CreditCard className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              {cardLinkedName ?? "The linked card"}: available credit {impact.cardAvailableDelta >= 0 ? "+" : "−"}{formatCurrencyPrecise(Math.abs(impact.cardAvailableDelta))} and utilization follow automatically.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

export interface LoanReconciliationSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  productName: string;
  context: LoanReconciliationContext;
  /** The lender figure already typed in the variance table, if any. */
  initialLenderFigure: number | null;
  /** Overridable for tests. */
  now?: Date;
}

export function LoanReconciliationSheet(props: LoanReconciliationSheetProps) {
  // Remount per open so each guide starts from the figure currently in the table.
  return props.open ? <LoanReconciliationBody key={String(props.initialLenderFigure)} {...props} /> : null;
}

function LoanReconciliationBody({ onOpenChange, productName, context, initialLenderFigure }: LoanReconciliationSheetProps) {
  const [lender, setLender] = useState(initialLenderFigure == null ? "" : String(initialLenderFigure));
  const [asOf, setAsOf] = useState(todayInput);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [lenderEmi, setLenderEmi] = useState("");
  const [lenderRate, setLenderRate] = useState("");
  const [lenderRemaining, setLenderRemaining] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const loanHistory = useLoanPaymentHistory(context.source.kind === "loan" ? context.source.row : null);
  const emiHistory = useEmiPaymentHistory(context.source.kind === "emi" ? context.source.row : null);
  const historyData = context.source.kind === "loan" ? loanHistory.data : emiHistory.data;
  const historyLoading = context.source.kind === "loan" ? loanHistory.isLoading : emiHistory.isLoading;

  const lenderPrincipal = num(lender);
  const asOfDate = endOfDay(asOf);
  const payments: ReconPayment[] = useMemo(
    () => (historyData?.payments ?? []).map((p) => ({ id: p.id, installmentId: p.installmentId, amount: p.amount, date: p.date, deletedAt: p.deletedAt ?? null, allocationType: (p as { allocationType?: string }).allocationType ?? null, prepaymentPrincipalAmount: (p as { prepaymentPrincipalAmount?: number | null }).prepaymentPrincipalAmount ?? null })),
    [historyData],
  );

  const result = useMemo(() => {
    if (lenderPrincipal == null || asOfDate == null) return null;
    const input: LoanReconInput = {
      kind: context.source.kind,
      principalAmount: context.principalAmount,
      ratePercent: context.ratePercent,
      installments: context.installments,
      payments,
      principalPrepaid: context.principalPrepaid,
      cardLinkedName: context.cardLinkedName,
      supportsPrepaymentAndDisbursement: context.supportsPrepaymentAndDisbursement,
      asOf: asOfDate,
      lender: { principal: lenderPrincipal, emiAmount: num(lenderEmi), ratePercent: num(lenderRate), remainingInstallments: num(lenderRemaining) },
    };
    return reconcileLoan(input);
  }, [lenderPrincipal, asOfDate, context, payments, lenderEmi, lenderRate, lenderRemaining]);

  const ready = result != null && reason !== "";
  const selected = result?.causes.find((c) => c.id === selectedId) ?? result?.causes[0] ?? null;
  const seqById = useMemo(() => new Map(context.installments.map((i) => [i.id, i.sequenceNumber])), [context.installments]);

  return (
    <Sheet open onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="mx-auto w-full sm:max-w-2xl" data-testid="loan-reconciliation-sheet">
        <SheetHeader>
          <SheetTitle>Reconcile remaining principal — {productName}</SheetTitle>
          <SheetDescription>
            {context.source.kind === "emi" ? (context.cardLinkedName ? "Card-linked EMI" : "Standalone EMI") : context.cardLinkedName ? "Card-funded loan" : "Standalone loan"}. Nothing changes unless you follow a step below.
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-4 overflow-y-auto px-4 pb-4">
          <section className="grid grid-cols-1 gap-3 rounded-lg border border-border bg-secondary/20 p-3 sm:grid-cols-2" aria-label="What the lender reports">
            <Field id="lr-lender" label="Lender's remaining principal (₹)">
              <input id="lr-lender" inputMode="decimal" autoComplete="off" value={lender} onChange={(e) => setLender(e.target.value)} className={INPUT} data-testid="loan-lender-input" aria-invalid={lender.trim() !== "" && lenderPrincipal == null} />
            </Field>
            <Field id="lr-asof" label="As-of date">
              <input id="lr-asof" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} className={INPUT} data-testid="loan-asof-input" />
            </Field>
            <Field id="lr-reason" label="Reason for checking">
              <select id="lr-reason" value={reason} onChange={(e) => setReason(e.target.value)} className={INPUT} data-testid="loan-reason-select">
                <option value="">Select a reason…</option>
                {RECON_REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
            </Field>
            <Field id="lr-note" label="Note (optional)" hint="Kept on this screen only — not saved.">
              <input id="lr-note" value={note} onChange={(e) => setNote(e.target.value)} className={INPUT} />
            </Field>
            <Field id="lr-emi" label="Lender's EMI (optional)">
              <input id="lr-emi" inputMode="decimal" value={lenderEmi} onChange={(e) => setLenderEmi(e.target.value)} className={INPUT} data-testid="loan-lender-emi" />
            </Field>
            <Field id="lr-rate" label="Lender's rate % (optional)">
              <input id="lr-rate" inputMode="decimal" value={lenderRate} onChange={(e) => setLenderRate(e.target.value)} className={INPUT} data-testid="loan-lender-rate" />
            </Field>
            <Field id="lr-rem" label="Lender's remaining installments (optional)">
              <input id="lr-rem" inputMode="numeric" value={lenderRemaining} onChange={(e) => setLenderRemaining(e.target.value)} className={INPUT} data-testid="loan-lender-remaining" />
            </Field>
          </section>

          {result == null && <p className="text-sm text-muted-foreground" data-testid="loan-recon-empty">Enter the lender&rsquo;s remaining principal and an as-of date to compare.</p>}

          {result && (
            <>
              <div className="grid grid-cols-2 gap-3 rounded-lg border border-border p-3 sm:grid-cols-4">
                <Metric label="FlowFi principal" value={formatCurrencyPrecise(result.flowfiPrincipal)} testId="loan-flowfi-value" />
                <Metric label="Lender principal" value={formatCurrencyPrecise(result.lenderPrincipal)} testId="loan-lender-value" />
                <Metric label="Difference" value={result.difference === 0 ? "₹0.00" : `${result.difference > 0 ? "+" : "−"}${formatCurrencyPrecise(Math.abs(result.difference))}`} testId="loan-difference" />
                <Metric label={`Schedule on ${shortDate(asOfDate!)}`} value={formatCurrencyPrecise(result.scheduledPrincipal)} testId="loan-scheduled-value" />
              </div>

              <section aria-label="Terms comparison">
                <h3 className="text-sm font-semibold text-foreground">Terms</h3>
                <div className="mt-1.5 flex flex-col gap-1" data-testid="loan-terms">
                  {result.terms.map((t) => (
                    <div key={t.key} className="flex items-center justify-between gap-2 rounded-md border border-border px-2.5 py-1.5 text-xs" data-testid={`loan-term-${t.key}`} data-status={t.status}>
                      <span className="text-foreground">{t.label}</span>
                      <span className="tabular-nums text-muted-foreground">FlowFi {t.flowfi ?? "—"}</span>
                      <span className="tabular-nums text-muted-foreground">Lender {t.lender ?? "—"}</span>
                      <Badge variant={t.status === "differs" ? "destructive" : "secondary"}>{t.status === "match" ? "Match" : t.status === "differs" ? "Differs" : "Not entered"}</Badge>
                    </div>
                  ))}
                </div>
              </section>

              <section aria-label="Payment history">
                <h3 className="text-sm font-semibold text-foreground">Recorded payments</h3>
                <p className="text-xs text-muted-foreground">Check here first — the difference may already be recorded, so nothing is duplicated.</p>
                <div className="mt-1.5 flex flex-col gap-1" data-testid="loan-history">
                  {historyLoading && <p className="text-xs text-muted-foreground">Loading payment history…</p>}
                  {!historyLoading && result.history.length === 0 && <p className="text-xs text-muted-foreground">No payments recorded yet.</p>}
                  {result.history.map((p) => (
                    <div key={p.id} className="flex items-center justify-between gap-2 rounded-md border border-border px-2.5 py-1.5 text-xs" data-testid="loan-history-row">
                      <span className="text-foreground">{p.allocationType === "principalPrepayment" ? "Extra principal" : `Installment ${seqById.get(p.installmentId) ?? "—"}`}</span>
                      <span className="text-muted-foreground">{shortDate(p.date)}</span>
                      <span className="font-medium tabular-nums">{formatCurrencyPrecise(p.amount)}</span>
                    </div>
                  ))}
                </div>
              </section>

              {result.direction === "match" ? (
                <p className="flex items-start gap-1.5 rounded-lg border border-success/40 bg-success/10 p-3 text-sm text-foreground" data-testid="loan-recon-match">
                  <Check className="mt-0.5 size-4 shrink-0" aria-hidden /> FlowFi matches the lender within ₹1 — nothing to correct.
                </p>
              ) : (
                <>
                  <section aria-label="Likely causes">
                    <h3 className="text-sm font-semibold text-foreground">Likely causes</h3>
                    <div className="mt-1.5 flex flex-col gap-1.5" data-testid="loan-cause-list">
                      {result.causes.map((c) => (
                        <button
                          key={c.id}
                          type="button"
                          onClick={() => setSelectedId(c.id)}
                          aria-pressed={selected?.id === c.id}
                          data-testid={`loan-cause-${c.id}`}
                          data-confidence={c.confidence}
                          className={cn("w-full rounded-lg border px-3 py-2.5 text-left transition-colors", selected?.id === c.id ? "border-primary/60 bg-primary/5" : "border-border hover:border-border-strong hover:bg-secondary/40")}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-sm font-medium text-foreground">{c.label}</span>
                            <Badge variant={c.confidence === "strong" ? "default" : "secondary"}>{CONFIDENCE_LABEL[c.confidence]}</Badge>
                          </div>
                        </button>
                      ))}
                    </div>
                  </section>
                  {selected && <CauseDetail cause={selected} agreementId={context.agreementId} ready={ready} cardLinkedName={context.cardLinkedName} />}
                </>
              )}
            </>
          )}

          <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
            <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            This guide never writes a payment, adjusts principal, or edits a schedule. Remaining principal is always recalculated from installments and payments.
          </p>
        </div>
      </SheetContent>
    </Sheet>
  );
}
