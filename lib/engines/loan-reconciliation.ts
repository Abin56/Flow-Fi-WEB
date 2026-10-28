/**
 * Loan / EMI reconciliation guide — PURE and READ-ONLY. Given the principal a lender reports (and optionally
 * their EMI / rate / remaining-installment figures) it compares them with FlowFi's schedule, ranks the likely
 * causes of any gap with the evidence found in the schedule and payment history, and — for every cause — names
 * either an EXISTING safe workflow (a direct hand-off with the agreement/installment already chosen), a
 * legitimate no-action explanation, or the exact atomic write that does not exist yet.
 *
 * It never writes, never overwrites principal / outstanding / schedules / paid installments, and never invents a
 * payment: FlowFi's remaining principal is always re-derived from installments (`loan-outstanding.ts`).
 * `impact` is a what-if preview of that derivation, not a stored figure.
 */

import { principalPaidFor } from "./loan-outstanding";

export type LoanReconKind = "loan" | "emi";

export interface ReconInstallment {
  id: string;
  sequenceNumber: number;
  dueDate: Date;
  amountDue: number;
  amountPaid: number;
  isSkipped: boolean;
  principalPortion: number | null;
  interestPortion: number | null;
}

export interface ReconPayment {
  id: string;
  installmentId: string;
  amount: number;
  date: Date;
  deletedAt: Date | null;
  allocationType?: string | null;
  prepaymentPrincipalAmount?: number | null;
}

export interface LenderFigures {
  /** Principal the lender reports as outstanding. */
  principal: number;
  emiAmount?: number | null;
  ratePercent?: number | null;
  remainingInstallments?: number | null;
}

export interface LoanReconInput {
  kind: LoanReconKind;
  /** Original principal (Loan.loanAmount / Emi.principalAmount). */
  principalAmount: number;
  ratePercent: number | null;
  installments: readonly ReconInstallment[];
  payments: readonly ReconPayment[];
  /** Extra principal already paid (Loans only; 0 for EMIs). */
  principalPrepaid: number;
  /** A card-funded Loan / card-linked EMI — its principal is locked against a card. */
  cardLinkedName: string | null;
  /** Whether "Pay extra principal" and "Additional disbursement" exist for this agreement type (Loans). */
  supportsPrepaymentAndDisbursement: boolean;
  asOf: Date;
  lender: LenderFigures;
}

export type LoanReconCauseId =
  | "missingPayment"
  | "partialPayment"
  | "missingPrepayment"
  | "paymentNotAppliedByLender"
  | "paymentTiming"
  | "unrecordedDisbursement"
  | "accruedInterestOrCharges"
  | "termsMismatch"
  | "unknown";

export type LoanReconResolution =
  /** Existing Record Payment dialog (or "Record past payments"), opened on `installmentId`. */
  | { kind: "recordPayment"; installmentId: string; view: "pay" | "past"; description: string }
  /** Existing Record Payment dialog — "Installment + extra towards principal". */
  | { kind: "payExtraPrincipal"; installmentId: string | null; description: string }
  /** Existing Additional disbursement dialog. */
  | { kind: "addDisbursement"; description: string }
  /** Existing agreement details (history, reverse/edit a payment, edit terms). */
  | { kind: "openAgreement"; description: string }
  | { kind: "explainedNoAction"; description: string }
  /** A correction that needs a write FlowFi does not have — the exact method is named and nothing is written. */
  | { kind: "needsApproval"; method: string; description: string }
  | { kind: "reviewOnly"; description: string };

export interface LoanReconImpact {
  outstandingBefore: number;
  outstandingAfter: number;
  /** lender − FlowFi after the correction (0 = reconciled). */
  gapAfter: number;
  installmentsPaidBefore: number;
  installmentsPaidAfter: number;
  remainingInstallmentsBefore: number;
  remainingInstallmentsAfter: number;
  /** Change to the linked card's available credit (principal restored on a payment, locked on a disbursement). */
  cardAvailableDelta: number | null;
}

export interface LoanReconCause {
  id: LoanReconCauseId;
  label: string;
  confidence: "strong" | "possible" | "none";
  /** Concrete facts from the schedule / history that support (or fail to support) this cause. */
  evidence: string[];
  resolution: LoanReconResolution;
  impact: LoanReconImpact | null;
}

export interface TermComparison {
  key: "emiAmount" | "ratePercent" | "remainingInstallments";
  label: string;
  flowfi: number | null;
  lender: number | null;
  status: "match" | "differs" | "notProvided";
}

export interface LoanReconResult {
  flowfiPrincipal: number;
  lenderPrincipal: number;
  /** lender − FlowFi, rounded to paise. */
  difference: number;
  direction: "match" | "lenderHigher" | "lenderLower";
  /** What the schedule says should be outstanding on the as-of date if every due installment were paid. */
  scheduledPrincipal: number;
  terms: TermComparison[];
  causes: LoanReconCause[];
  /** Recorded payments nearest the as-of date, newest first — check here before recording anything. */
  history: ReconPayment[];
  cardLinkedName: string | null;
}

const TOLERANCE = 1; // ₹1 — lender figures are usually whole rupees
const DAY = 24 * 60 * 60 * 1000;
const round2 = (v: number) => Math.round(v * 100) / 100;
const near = (a: number, b: number) => Math.abs(a - b) <= TOLERANCE;
const money = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const shortDate = (d: Date) => d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
const clampPositive = (v: number) => (v < 0 ? 0 : v);

function principalShare(i: Pick<ReconInstallment, "principalPortion" | "amountDue">): number {
  return i.principalPortion ?? i.amountDue;
}

/** Principal still owed on one installment (a part-paid one is prorated, exactly like `principalPaidFor`). */
export function principalRemainingOn(i: ReconInstallment): number {
  if (i.isSkipped || i.amountDue <= 0) return 0;
  const paid = Math.min(1, Math.max(0, i.amountPaid / i.amountDue));
  return principalShare(i) * (1 - paid);
}

const isSettled = (i: ReconInstallment) => i.isSkipped || i.amountPaid >= i.amountDue;

export function flowfiPrincipal(input: Pick<LoanReconInput, "principalAmount" | "installments" | "principalPrepaid">): number {
  return round2(clampPositive(Math.min(input.principalAmount, input.principalAmount - principalPaidFor([...input.installments]) - input.principalPrepaid)));
}

/** Principal the schedule expects outstanding on `asOf` — every installment due by then counted as paid. */
export function scheduledPrincipalAt(input: Pick<LoanReconInput, "principalAmount" | "installments" | "principalPrepaid">, asOf: Date): number {
  const dueByThen = input.installments.filter((i) => !i.isSkipped && i.dueDate.getTime() <= asOf.getTime());
  const paid = dueByThen.reduce((s, i) => s + principalShare(i), 0);
  return round2(clampPositive(input.principalAmount - paid - input.principalPrepaid));
}

function remainingInstallmentCount(installments: readonly ReconInstallment[]): number {
  return installments.filter((i) => !isSettled(i)).length;
}

function nextEmiAmount(installments: readonly ReconInstallment[]): number | null {
  const sorted = [...installments].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  return (sorted.find((i) => !isSettled(i)) ?? sorted[sorted.length - 1])?.amountDue ?? null;
}

function compareTerms(input: LoanReconInput): TermComparison[] {
  const out: TermComparison[] = [];
  const add = (key: TermComparison["key"], label: string, flowfi: number | null, lender: number | null | undefined, tol: number) => {
    const l = lender ?? null;
    out.push({ key, label, flowfi, lender: l, status: l == null ? "notProvided" : flowfi != null && Math.abs(flowfi - l) <= tol ? "match" : "differs" });
  };
  add("emiAmount", "EMI amount", nextEmiAmount(input.installments), input.lender.emiAmount, 1);
  add("ratePercent", "Interest rate (%)", input.ratePercent, input.lender.ratePercent, 0.01);
  add("remainingInstallments", "Remaining installments", remainingInstallmentCount(input.installments), input.lender.remainingInstallments, 0);
  return out;
}

function paymentPrincipal(p: ReconPayment, byId: ReadonlyMap<string, ReconInstallment>): number {
  if (p.allocationType === "principalPrepayment") return p.prepaymentPrincipalAmount ?? p.amount;
  const i = byId.get(p.installmentId);
  if (!i || i.amountDue <= 0 || i.principalPortion == null) return p.amount;
  return p.amount * (i.principalPortion / i.amountDue);
}

function impactFor(input: LoanReconInput, before: number, delta: number, installmentsNowPaid: ReconInstallment[], cardSign: 1 | -1): LoanReconImpact {
  const after = round2(clampPositive(before + delta));
  const paidBefore = input.installments.filter(isSettled).length;
  const settledNow = installmentsNowPaid.length;
  return {
    outstandingBefore: before,
    outstandingAfter: after,
    gapAfter: round2(input.lender.principal - after),
    installmentsPaidBefore: paidBefore,
    installmentsPaidAfter: paidBefore + settledNow,
    remainingInstallmentsBefore: remainingInstallmentCount(input.installments),
    remainingInstallmentsAfter: remainingInstallmentCount(input.installments) - settledNow,
    cardAvailableDelta: input.cardLinkedName ? cardSign * Math.abs(delta) : null,
  };
}

export function reconcileLoan(input: LoanReconInput): LoanReconResult {
  const flowfi = flowfiPrincipal(input);
  const lenderPrincipal = round2(input.lender.principal);
  const difference = round2(lenderPrincipal - flowfi);
  const direction: LoanReconResult["direction"] = Math.abs(difference) <= TOLERANCE ? "match" : difference > 0 ? "lenderHigher" : "lenderLower";
  const scheduled = scheduledPrincipalAt(input, input.asOf);
  const terms = compareTerms(input);
  const asOfMs = input.asOf.getTime();
  const byId = new Map(input.installments.map((i) => [i.id, i]));
  const sorted = [...input.installments].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  const livePayments = input.payments.filter((p) => p.deletedAt == null);
  const history = [...livePayments].sort((a, b) => b.date.getTime() - a.date.getTime()).slice(0, 10);
  const D = Math.abs(difference);
  const causes: LoanReconCause[] = [];

  if (direction === "lenderLower") {
    // FlowFi shows MORE owed than the lender: a payment (or part-payment / extra principal) FlowFi hasn't recorded.
    const due = sorted.filter((i) => !isSettled(i) && i.dueDate.getTime() <= asOfMs + 5 * DAY);
    let cumulative = 0;
    let matched: ReconInstallment[] | null = null;
    const running: ReconInstallment[] = [];
    for (const i of due) {
      running.push(i);
      cumulative += principalRemainingOn(i);
      if (near(cumulative, D)) { matched = [...running]; break; }
    }
    const partial = due.find((i) => i.amountPaid > 0 && i.amountPaid < i.amountDue && near(principalRemainingOn(i), D));
    const scheduleAgrees = near(scheduled, lenderPrincipal);

    if (partial) {
      causes.push({
        id: "partialPayment",
        label: "Part-payment not fully recorded",
        confidence: "strong",
        evidence: [`Installment ${partial.sequenceNumber} shows ${money(partial.amountPaid)} of ${money(partial.amountDue)} paid; the unpaid principal on it is ${money(principalRemainingOn(partial))} — the same as the gap.`],
        resolution: { kind: "recordPayment", installmentId: partial.id, view: "pay", description: `Record the remaining ${money(partial.amountDue - partial.amountPaid)} on installment ${partial.sequenceNumber}.` },
        impact: impactFor(input, flowfi, -principalRemainingOn(partial), [partial], 1),
      });
    } else if (matched) {
      const first = matched[0]!;
      const last = matched[matched.length - 1]!;
      const range = matched.length === 1 ? `installment ${first.sequenceNumber}` : `installments ${first.sequenceNumber}–${last.sequenceNumber}`;
      // A Loan's Record Payment can pay "every unpaid one up to" the picked row; an EMI pays one at a time.
      const handoff = input.kind === "loan" ? last : first;
      causes.push({
        id: "missingPayment",
        label: "Payment not recorded in FlowFi",
        confidence: "strong",
        evidence: [
          `Unpaid principal on ${range} is ${money(cumulative)} — the same as the gap.`,
          ...(scheduleAgrees ? [`The lender's figure also matches what the schedule expects on ${shortDate(input.asOf)}.`] : []),
        ],
        resolution: {
          kind: "recordPayment",
          installmentId: handoff.id,
          view: "pay",
          description:
            input.kind === "loan" || matched.length === 1
              ? `Record the payment for ${range}. If it was paid before you tracked it (or is already in an account as another transaction), use Record past payments instead so no money is moved twice.`
              : `Record each of ${range}, one at a time (EMI payments are per installment), or use Record past payments if they were paid before tracking.`,
        },
        impact: impactFor(input, flowfi, -cumulative, matched, 1),
      });
    }

    if (input.supportsPrepaymentAndDisbursement) {
      const firstUnpaid = sorted.find((i) => !isSettled(i)) ?? null;
      causes.push({
        id: "missingPrepayment",
        label: "Extra principal paid but not recorded",
        confidence: "possible",
        evidence: [`A prepayment of ${money(D)} to the lender would lower principal by exactly the gap.`],
        resolution: { kind: "payExtraPrincipal", installmentId: firstUnpaid?.id ?? null, description: `Record ${money(D)} as extra principal (re-plans the remaining schedule). Skip if it was already recorded.` },
        impact: impactFor(input, flowfi, -D, [], 1),
      });
    }
    causes.push(termsCause(input, terms));
  } else if (direction === "lenderHigher") {
    // FlowFi shows LESS owed than the lender: FlowFi credited something the lender hasn't, or is missing principal.
    const paidNearAsOf = livePayments.filter((p) => p.date.getTime() >= asOfMs - 45 * DAY);
    const afterAsOf = paidNearAsOf.filter((p) => p.date.getTime() > asOfMs);
    const afterTotal = afterAsOf.reduce((s, p) => s + paymentPrincipal(p, byId), 0);
    if (afterAsOf.length > 0 && near(afterTotal, D)) {
      causes.push({
        id: "paymentTiming",
        label: "Payment made after the lender's as-of date",
        confidence: "strong",
        evidence: afterAsOf.map((p) => `${money(p.amount)} recorded on ${shortDate(p.date)} — after ${shortDate(input.asOf)}.`),
        resolution: { kind: "explainedNoAction", description: "A difference in timing, not an error. The lender will show the same figure once the payment posts." },
        impact: null,
      });
    }
    const exact = paidNearAsOf.filter((p) => p.date.getTime() <= asOfMs && near(paymentPrincipal(p, byId), D));
    if (exact.length > 0) {
      causes.push({
        id: "paymentNotAppliedByLender",
        label: "A recorded payment the lender hasn't applied",
        confidence: "strong",
        evidence: exact.map((p) => `${money(p.amount)} recorded on ${shortDate(p.date)} reduces principal by ${money(paymentPrincipal(p, byId))} — the same as the gap.`),
        resolution: { kind: "openAgreement", description: "Confirm with the lender whether it was received. If it was recorded by mistake, reverse or correct it from the agreement's payment history; if the lender is wrong, nothing changes in FlowFi." },
        impact: impactFor(input, flowfi, D, [], -1),
      });
    }
    if (input.supportsPrepaymentAndDisbursement) {
      causes.push({
        id: "unrecordedDisbursement",
        label: "Additional amount borrowed",
        confidence: "possible",
        evidence: [`A top-up / further disbursement of ${money(D)} would raise principal by exactly the gap.`],
        resolution: { kind: "addDisbursement", description: `Record the additional disbursement of ${money(D)} (re-plans the remaining schedule). Skip if no extra money was received.` },
        impact: impactFor(input, flowfi, D, [], -1),
      });
    }
    causes.push({
      id: "accruedInterestOrCharges",
      label: "Accrued interest, penal charges or fees in the lender's figure",
      confidence: "possible",
      evidence: ["Lender statements often include interest accrued since the last installment, penal interest and charges. FlowFi's figure is principal only."],
      resolution: {
        kind: "needsApproval",
        method: "recordLenderCharge(agreementId, amount, kind, asOf, reason, idempotencyKey)",
        description: "FlowFi has no way to record a lender fee or accrued charge against an agreement without altering principal. That write does not exist yet — it needs your approval to design. Until then the difference is explained, not corrected.",
      },
      impact: null,
    });
    causes.push(termsCause(input, terms));
  }

  if (direction !== "match" && !causes.some((c) => c.confidence === "strong")) {
    // Nothing matched exactly: say so plainly instead of guessing, and name the one write that could force the number.
    causes.push({
      id: "unknown",
      label: "Unexplained — needs review",
      confidence: "none",
      evidence: [`No single installment, payment or prepayment in FlowFi explains ${money(D)}.`],
      resolution: {
        kind: "needsApproval",
        method: "recordPrincipalAdjustment(agreementId, delta, asOf, reason, idempotencyKey)",
        description: "Forcing the principal to the lender's figure would need an audited adjustment event that re-plans the schedule atomically. FlowFi deliberately never overwrites principal, schedules or paid installments, and that write does not exist — it needs your approval before it is built.",
      },
      impact: null,
    });
  }

  const rank = { strong: 0, possible: 1, none: 2 } as const;
  causes.sort((a, b) => rank[a.confidence] - rank[b.confidence]);

  return { flowfiPrincipal: flowfi, lenderPrincipal, difference, direction, scheduledPrincipal: scheduled, terms, causes, history, cardLinkedName: input.cardLinkedName };
}

function termsCause(input: LoanReconInput, terms: TermComparison[]): LoanReconCause {
  const differing = terms.filter((t) => t.status === "differs");
  return {
    id: "termsMismatch",
    label: "Loan terms differ from the lender's",
    confidence: differing.length > 0 ? "possible" : "none",
    evidence:
      differing.length > 0
        ? differing.map((t) => `${t.label}: FlowFi ${t.flowfi ?? "—"} vs lender ${t.lender}.`)
        : ["No differing EMI, rate or tenure was entered — add the lender's figures above to check."],
    resolution: {
      kind: "openAgreement",
      description: input.kind === "loan"
        ? "If the lender re-priced or re-scheduled the loan, update the terms from the agreement (this re-amortizes only the unpaid installments)."
        : "If the lender re-scheduled this EMI, update its terms from the agreement (paid installments are kept).",
    },
    impact: null,
  };
}
