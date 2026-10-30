"use client";

/**
 * "Record a lender charge" — the guided, READ-ONLY part of the lender-charge correction. It asks for the charge
 * type, amount, billed date, the lender's reference and the reason, then previews exactly what recording would do:
 * principal never changes, unpaid charges and total lender payoff move by the amount, Net Worth moves, one expense
 * is recognised in the billed month, and no cash or transaction is created. For a card-linked agreement it first
 * compares the charge with the linked card's transactions and requires an explicit review.
 *
 * The Record button is DISABLED and nothing here writes: the financial write path (atomic billing, settlement,
 * reversal) and the cross-client safety it depends on are not enabled yet. `lib/engines/lender-charges.ts` holds all
 * the rules, so enabling the write later cannot change a number this screen shows.
 */

import { useMemo, useState } from "react";
import { Ban, CreditCard, Landmark } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { formatCurrencyPrecise } from "@/lib/format";
import { useCreditCards } from "@/hooks/use-credit-cards";
import { useLenderCharges } from "@/hooks/use-lender-charges";
import { useTransactions } from "@/hooks/use-transactions";
import { cardFundedLoanCardId } from "@/lib/engines/credit-utilization";
import { LENDER_CHARGE_TYPES, type LenderChargeCardReview, type LenderChargeType } from "@/lib/models/lender-charge";
import { chargeStatus, lenderPayoff, previewBilling, unpaidAmount, type LenderChargeInput } from "@/lib/engines/lender-charges";
import { cardChargeGate, reviewCardRepresentation, type CardTransactionEvidence } from "@/lib/engines/lender-charge-card-review";
import { lenderChargeDescription, LENDER_CHARGE_CATEGORY_NAME } from "@/lib/engines/lender-charge-accounting";
import type { Transaction } from "@/lib/models/transaction";
import type { LoanReconciliationContext } from "../lib/build-balance-control";

export const CHARGE_TYPE_LABEL: Record<LenderChargeType, string> = {
  interest: "Billed interest",
  penalty: "Late-payment penalty",
  processingFee: "Processing fee",
  serviceFee: "Service fee",
  gst: "GST",
  other: "Other lender charge",
};

const INPUT = "mt-1 h-9 w-full rounded-[6px] border border-border-strong bg-card px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";
const todayInput = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const parseDay = (iso: string): Date | null => {
  const [y, m, d] = iso.split("-").map(Number);
  return y && m && d ? new Date(y, m - 1, d) : null;
};
const parseAmount = (raw: string): number | null => {
  const t = raw.replace(/[₹,\s]/g, "");
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};
const shortDate = (d: Date) => d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
const money = formatCurrencyPrecise;

function Metric({ label, value, testId, hint }: { label: string; value: string; testId: string; hint?: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] font-medium text-muted-foreground uppercase">{label}</p>
      <p className="font-medium tabular-nums" data-testid={testId}>{value}</p>
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
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

export function LenderChargeSection({ context, now }: { context: LoanReconciliationContext; now?: Date }) {
  const kind = context.source.kind;
  const { charges } = useLenderCharges();
  const { data: cards = [] } = useCreditCards();
  const { data: transactions = [] } = useTransactions();

  const [type, setType] = useState<LenderChargeType | "">("");
  const [amount, setAmount] = useState("");
  const [billed, setBilled] = useState(todayInput);
  const [reference, setReference] = useState("");
  const [reason, setReason] = useState("");
  const [decision, setDecision] = useState<LenderChargeCardReview["decision"] | "">("");
  const [reviewed, setReviewed] = useState<string[]>([]);

  const principal = context.outstandingPrincipal;
  const agreementCharges = useMemo(() => charges.filter((c) => c.agreementKind === kind && c.agreementId === context.agreementId), [charges, kind, context.agreementId]);
  const payoff = useMemo(() => lenderPayoff({ principal, charges: agreementCharges }), [principal, agreementCharges]);

  const cardAccountId = useMemo(() => {
    if (context.source.kind === "emi") return context.source.row.linkedCard?.accountId ?? null;
    const loan = context.source.row.loan;
    const cardId = loan ? cardFundedLoanCardId(loan) : null;
    return cardId == null ? null : (cards.find((c) => c.id === cardId)?.accountId ?? null);
  }, [context.source, cards]);

  const billedDate = parseDay(billed);
  const amountValue = parseAmount(amount);
  const input: LenderChargeInput | null =
    type !== "" && billedDate != null
      ? { agreementKind: kind, agreementId: context.agreementId, type, amount: amountValue ?? Number.NaN, billedDate, lenderReference: reference.trim(), reason }
      : null;
  const preview = useMemo(
    () => (input ? previewBilling({ input, principal, existing: charges, now }) : null),
    // `input` is rebuilt from the fields below on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [type, amountValue, billed, reference, reason, principal, charges, kind, context.agreementId, now],
  );

  // Card-linked: compare with what the card already shows. Evidence only ever raises a review.
  const cardReview = useMemo(() => {
    if (cardAccountId == null || input == null || amountValue == null || amountValue <= 0 || type === "") return null;
    const evidence: CardTransactionEvidence[] = (transactions as Transaction[])
      .filter((t) => t.accountId === cardAccountId)
      .map((t) => ({ id: t.id, accountId: t.accountId, type: t.type === "income" ? "income" : "expense", amount: t.amount, dateTime: t.dateTime, notes: `${t.description} ${t.notes}`, merchant: null, deletedAt: t.deletedAt }));
    return reviewCardRepresentation({ candidate: { type, amount: amountValue, billedDate: input.billedDate, lenderReference: reference.trim() }, cardTransactions: evidence });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardAccountId, transactions, type, amountValue, billed, reference]);
  const confirmation: LenderChargeCardReview | null = decision === "" ? null : { decision, reviewedTransactionIds: reviewed, confirmedAt: new Date() };
  const gate = cardReview ? cardChargeGate(cardReview, confirmation) : null;
  const txById = useMemo(() => new Map((transactions as Transaction[]).map((t) => [t.id, t])), [transactions]);

  const unpaidList = agreementCharges.filter((c) => c.reversedAt == null);

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border p-3" aria-label="Record a lender charge" data-testid="lender-charge-section">
      <div>
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
          <Landmark className="size-4" aria-hidden /> Lender charges
        </h3>
        <p className="text-xs text-muted-foreground">A charge the lender has billed that FlowFi does not show — interest, a penalty, a fee or GST. It is tracked separately and never added to principal.</p>
      </div>

      <div className="grid grid-cols-3 gap-3 rounded-lg border border-border bg-secondary/20 p-3" data-testid="lender-payoff">
        <Metric label="Outstanding principal" value={money(payoff.principal)} testId="payoff-principal" />
        <Metric label="Unpaid lender charges" value={money(payoff.unpaidCharges)} testId="payoff-charges" />
        <Metric label="Total lender payoff" value={money(payoff.totalPayoff)} testId="payoff-total" hint="Principal + unpaid charges. Interest accrued but not yet billed is not included." />
      </div>

      {unpaidList.length > 0 && (
        <div className="flex flex-col gap-1" data-testid="lender-charge-list">
          {unpaidList.map((c) => (
            <div key={c.id} className="flex items-center justify-between gap-2 rounded-md border border-border px-2.5 py-1.5 text-xs" data-testid="lender-charge-row" data-status={chargeStatus(c)}>
              <span className="min-w-0 truncate text-foreground">{lenderChargeDescription(c)}</span>
              <span className="text-muted-foreground">{shortDate(c.billedDate)}</span>
              <span className="font-medium tabular-nums">{money(c.amount)}</span>
              <Badge variant={chargeStatus(c) === "paid" ? "secondary" : "default"}>{chargeStatus(c) === "paid" ? "Paid" : chargeStatus(c) === "partlyPaid" ? `Unpaid ${money(unpaidAmount(c))}` : "Unpaid"}</Badge>
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field id="lc-type" label="Charge type">
          <select id="lc-type" value={type} onChange={(e) => setType(e.target.value as LenderChargeType | "")} className={INPUT} data-testid="lender-charge-type">
            <option value="">Select a type…</option>
            {LENDER_CHARGE_TYPES.map((t) => <option key={t} value={t}>{CHARGE_TYPE_LABEL[t]}</option>)}
          </select>
        </Field>
        <Field id="lc-amount" label="Billed amount (₹)">
          <input id="lc-amount" inputMode="decimal" autoComplete="off" value={amount} onChange={(e) => setAmount(e.target.value)} className={INPUT} data-testid="lender-charge-amount" />
        </Field>
        <Field id="lc-date" label="Billed / effective date" hint="The date the lender billed it — the expense is recognised in this month.">
          <input id="lc-date" type="date" value={billed} onChange={(e) => setBilled(e.target.value)} className={INPUT} data-testid="lender-charge-date" />
        </Field>
        <Field id="lc-ref" label="Lender reference" hint="Statement, invoice or charge id. Helps stop the same charge being recorded twice.">
          <input id="lc-ref" value={reference} onChange={(e) => setReference(e.target.value)} className={INPUT} data-testid="lender-charge-reference" />
        </Field>
        <div className="sm:col-span-2">
          <Field id="lc-reason" label="Reason / what the lender says it is for">
            <input id="lc-reason" value={reason} onChange={(e) => setReason(e.target.value)} className={INPUT} data-testid="lender-charge-reason" />
          </Field>
        </div>
      </div>

      {preview && (
        <div className="rounded-lg border border-border p-3" data-testid="lender-charge-preview" data-blocked={preview.blocked}>
          <h4 className="text-sm font-semibold text-foreground">If this were recorded</h4>
          {preview.errors.length > 0 && (
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-destructive" data-testid="lender-charge-errors">
              {preview.errors.map((e) => <li key={e}>{e}</li>)}
            </ul>
          )}
          {preview.duplicate.verdict === "possibleDuplicate" && (
            <p className="mt-1 rounded-md border border-warning/50 bg-warning/10 p-2 text-xs" data-testid="lender-charge-possible-duplicate">
              Looks like {preview.duplicate.matches.length === 1 ? "a charge" : "charges"} already recorded: {preview.duplicate.matches.map((m) => `${lenderChargeDescription(m)} on ${shortDate(m.billedDate)}`).join("; ")}. You would have to confirm it is a separate charge.
            </p>
          )}
          <dl className="mt-1.5 grid grid-cols-[1fr_auto_auto] gap-x-4 gap-y-1 text-xs tabular-nums">
            <dt className="text-muted-foreground" />
            <dd className="text-right text-muted-foreground">Now</dd>
            <dd className="text-right text-muted-foreground">After</dd>
            <dt>Outstanding principal</dt>
            <dd className="text-right">{money(preview.principal.before)}</dd>
            <dd className="text-right font-medium" data-testid="preview-principal-after">{money(preview.principal.after)} <span className="font-normal text-muted-foreground">(unchanged)</span></dd>
            <dt>Unpaid lender charges</dt>
            <dd className="text-right">{money(preview.unpaidCharges.before)}</dd>
            <dd className="text-right font-medium" data-testid="preview-charges-after">{money(preview.unpaidCharges.after)}</dd>
            <dt>Total lender payoff</dt>
            <dd className="text-right">{money(preview.payoff.before)}</dd>
            <dd className="text-right font-medium" data-testid="preview-payoff-after">{money(preview.payoff.after)}</dd>
          </dl>
          <ul className="mt-2 list-disc space-y-0.5 pl-4 text-xs text-muted-foreground" data-testid="lender-charge-effects">
            <li>Net Worth: {preview.netWorthDelta === 0 ? "no change" : `−${money(Math.abs(preview.netWorthDelta))} on ${billedDate ? shortDate(billedDate) : "the billed date"}`} (a liability, no cash).</li>
            <li>Expense: {money(preview.expense.amount)} recognised once, in {preview.expense.month.toLocaleDateString("en-IN", { month: "long", year: "numeric" })}, under “{LENDER_CHARGE_CATEGORY_NAME}”. Paying it later is not a second expense.</li>
            <li>No cash moves and no transaction is created when a charge is recorded.</li>
          </ul>
        </div>
      )}

      {cardAccountId != null && (
        <div className="rounded-lg border border-border p-3" data-testid="lender-charge-card-review">
          <h4 className="flex items-center gap-1.5 text-sm font-semibold text-foreground"><CreditCard className="size-4" aria-hidden /> Is it already on {context.cardLinkedName ?? "the credit card"}?</h4>
          <p className="text-xs text-muted-foreground">A card owns its own balance. A charge already on the card must not also become a Loan/EMI liability. Finding nothing is not proof — you always confirm.</p>
          {cardReview == null ? (
            <p className="mt-1 text-xs text-muted-foreground">Enter the type and amount to compare with the card.</p>
          ) : (
            <>
              {cardReview.matches.length > 0 ? (
                <div className="mt-2 flex flex-col gap-1" data-testid="lender-charge-card-matches">
                  {cardReview.matches.map((m) => {
                    const t = txById.get(m.id);
                    return (
                      <label key={m.id} className="flex items-start gap-2 rounded-md border border-warning/50 bg-warning/10 p-2 text-xs" data-testid="lender-charge-card-match" data-strength={m.strength}>
                        <input type="checkbox" checked={reviewed.includes(m.id)} onChange={(e) => setReviewed((prev) => (e.target.checked ? [...prev, m.id] : prev.filter((x) => x !== m.id)))} className="mt-0.5" />
                        <span>
                          <strong>{m.strength === "strong" ? "Strong match" : "Possible match"}:</strong> {t ? `${t.description || "Card transaction"} · ${money(t.amount)} · ${shortDate(t.dateTime)}` : m.id} — {m.reasons.join(", ")}.
                          <br />Tick once you have checked this is <em>not</em> the same charge.
                        </span>
                      </label>
                    );
                  })}
                </div>
              ) : (
                <p className="mt-2 text-xs text-muted-foreground" data-testid="lender-charge-card-nomatch">No matching card transaction was found. Statement lines were not available to compare.</p>
              )}
              <div className="mt-2 flex flex-wrap gap-4 text-xs" role="radiogroup" aria-label="Where is this charge?">
                <label className="flex items-center gap-1.5"><input type="radio" name="lc-card" checked={decision === "notOnCard"} onChange={() => setDecision("notOnCard")} data-testid="lender-charge-not-on-card" /> It is not on the card</label>
                <label className="flex items-center gap-1.5"><input type="radio" name="lc-card" checked={decision === "alreadyOnCard"} onChange={() => setDecision("alreadyOnCard")} data-testid="lender-charge-on-card" /> It is already on the card</label>
              </div>
              {gate && <p className={`mt-1.5 text-xs ${gate.allowed ? "text-foreground" : "text-destructive"}`} data-testid="lender-charge-card-gate" data-allowed={gate.allowed}>{gate.allowed ? "Card check complete — this charge is not on the card." : gate.reason}</p>}
            </>
          )}
        </div>
      )}

      <div className="rounded-lg border border-dashed border-border-strong p-3">
        <button type="button" disabled className="inline-flex h-9 cursor-not-allowed items-center gap-1.5 rounded-[6px] bg-secondary px-3 text-sm font-medium text-muted-foreground" data-testid="lender-charge-record-disabled" aria-describedby="lc-disabled-why">
          <Ban className="size-4" aria-hidden /> Record this charge
        </button>
        <p id="lc-disabled-why" className="mt-1.5 text-xs text-muted-foreground" data-testid="lender-charge-disabled-reason">
          Recording is not enabled yet. The atomic write, payment settlement and reversal, and the check that the mobile app handles these records correctly, must all be finished and verified first. This screen is a preview only — nothing is saved.
        </p>
      </div>
    </section>
  );
}
