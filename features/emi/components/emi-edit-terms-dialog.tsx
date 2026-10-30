"use client";

/**
 * EMI "Edit terms" — a compact review-then-confirm screen over the EXISTING `EmiRepository.editEmiTerms`
 * (through `useEmiActions().editEmiTerms`). It supports exactly what that method supports: interest rate / type,
 * number of installments, payment frequency and the monthly due day. Terms apply from the first unpaid
 * installment; paid and part-paid installments, their payments and the principal are never touched.
 *
 * Nothing is written until the user confirms. Just before saving, the schedule is re-read from the server and
 * compared with what the preview was computed from — the repository replaces the installments it is HANDED, so a
 * stale list (a payment recorded in another tab) must never reach it. `planEmiTermsEdit` is the read-only preview
 * built from the repository's own maths; `emiTermsEditBlocker` explains, instead of hiding, when the edit is off.
 */

import { useMemo, useState } from "react";
import { AlertTriangle, ArrowRight, CreditCard, ShieldCheck } from "lucide-react";
import { useAuthStore } from "@/store/auth-store";
import { startOperation } from "@/store/operation-progress-store";
import { errorDetail } from "@/lib/operation-progress/operation-progress";
import { formatCurrencyPrecise } from "@/lib/format";
import { cn } from "@/lib/utils";
import { currentEmiTerms, emiTermsEditBlocker, planEmiTermsEdit, scheduleFingerprint, type EmiTermsInput, type PlannedInstallment } from "@/lib/engines/emi-terms-plan";
import type { ScheduleType } from "@/lib/models/payment-schedule";
import { createInstallmentRepositoryFor } from "@/lib/repositories/repository-factory";
import { useEmiActions, type EmiRow } from "@/features/emi/hooks/use-emi-data";
import { Field, LOAN_EMI_INPUT, LoanEmiFormDialog, SegmentedControl } from "@/features/loans/components/loan-emi-ui";

const FREQUENCY_OPTIONS: { value: ScheduleType; label: string }[] = [
  { value: "monthly", label: "Monthly" },
  { value: "weekly", label: "Weekly" },
];
const TYPE_OPTIONS = [
  { value: "reducingBalance" as const, label: "Reducing balance" },
  { value: "flat" as const, label: "Flat" },
];

const money = formatCurrencyPrecise;
const date = (d: Date | null | undefined) => (d ? d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—");
const FREQUENCY_LABEL: Record<string, string> = { monthly: "Monthly", weekly: "Weekly" };
const PREVIEW_ROWS = 6;

function Delta({ before, after, testId }: { before: string; after: string; testId?: string }) {
  const changed = before !== after;
  return (
    <span className="inline-flex items-center gap-1.5 tabular-nums" data-testid={testId} data-changed={changed}>
      <span className={changed ? "text-muted-foreground" : "text-foreground"}>{before}</span>
      {changed && (
        <>
          <ArrowRight className="size-3 text-muted-foreground" aria-hidden />
          <span className="font-medium text-foreground">{after}</span>
        </>
      )}
    </span>
  );
}

function TermRow({ label, children, testId }: { label: string; children: React.ReactNode; testId?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-border px-3 py-1.5 text-xs first:border-t-0" data-testid={testId}>
      <span className="text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function ScheduleDiff({ before, after }: { before: PlannedInstallment[]; after: PlannedInstallment[] }) {
  const [all, setAll] = useState(false);
  const rows = Math.max(before.length, after.length);
  const shown = all ? rows : Math.min(rows, PREVIEW_ROWS);
  return (
    <div className="overflow-hidden rounded-lg border border-border" data-testid="emi-terms-schedule">
      <div className="grid grid-cols-[2.5rem_1fr_1fr] gap-x-3 bg-secondary/40 px-3 py-1.5 text-[11px] font-medium text-muted-foreground uppercase">
        <span>#</span>
        <span>Due date</span>
        <span className="text-right">Amount</span>
      </div>
      {Array.from({ length: shown }, (_, k) => {
        const b = before[k];
        const a = after[k];
        return (
          <div key={k} className="grid grid-cols-[2.5rem_1fr_1fr] items-center gap-x-3 border-t border-border px-3 py-1.5 text-xs" data-testid="emi-terms-schedule-row">
            <span className="tabular-nums text-muted-foreground">{(a ?? b)!.sequenceNumber}</span>
            <span>{b && a ? <Delta before={date(b.dueDate)} after={date(a.dueDate)} /> : a ? <span className="font-medium">{date(a.dueDate)} <em className="text-muted-foreground not-italic">new</em></span> : <span className="text-muted-foreground line-through">{date(b!.dueDate)}</span>}</span>
            <span className="text-right">{b && a ? <Delta before={money(b.amountDue)} after={money(a.amountDue)} /> : a ? <span className="font-medium tabular-nums">{money(a.amountDue)}</span> : <span className="text-muted-foreground tabular-nums line-through">{money(b!.amountDue)}</span>}</span>
          </div>
        );
      })}
      {rows > PREVIEW_ROWS && (
        <button type="button" onClick={() => setAll((v) => !v)} className="w-full border-t border-border px-3 py-1.5 text-left text-xs font-medium text-primary hover:bg-secondary/40" data-testid="emi-terms-schedule-toggle">
          {all ? "Show fewer" : `Show all ${rows} unpaid installments`}
        </button>
      )}
    </div>
  );
}

export interface EmiEditTermsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  row: EmiRow | null;
  /** Name of the linked card, when the EMI is card-linked. */
  cardName?: string | null;
}

export function EmiEditTermsDialog(props: EmiEditTermsDialogProps) {
  // A fresh mount per open: the form always starts from the saved terms.
  return props.open && props.row ? <EmiEditTermsBody key={`${props.row.emi.id}`} {...props} row={props.row} /> : null;
}

function EmiEditTermsBody({ onOpenChange, row, cardName }: EmiEditTermsDialogProps & { row: EmiRow }) {
  const actions = useEmiActions();
  const uid = useAuthStore((s) => s.user?.uid);
  const initial = useMemo(() => currentEmiTerms(row.emi, row.installments), [row.emi, row.installments]);
  const [rate, setRate] = useState(initial.ratePercent == null ? "" : String(initial.ratePercent));
  const [interestType, setInterestType] = useState(initial.interestType);
  const [count, setCount] = useState(String(initial.installmentCount));
  const [frequency, setFrequency] = useState<ScheduleType>(initial.frequency);
  const [dueDay, setDueDay] = useState(initial.dueDayOfMonth == null ? "" : String(initial.dueDayOfMonth));
  // The confirmation belongs to ONE exact preview (these terms over this schedule); any change to either — including a
  // payment arriving live from another tab — withdraws it, so the user never confirms one thing and saves another.
  const [confirmedKey, setConfirmedKey] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const blocker = emiTermsEditBlocker(row.emi, row.installments);
  const proposed: EmiTermsInput = useMemo(
    () => ({
      ratePercent: rate.trim() === "" ? null : Number(rate),
      interestType,
      period: row.emi.interest?.period ?? "yearly",
      installmentCount: count.trim() === "" ? NaN : Number(count),
      frequency,
      dueDayOfMonth: frequency === "monthly" && dueDay.trim() !== "" ? Number(dueDay) : null,
    }),
    [rate, interestType, count, frequency, dueDay, row.emi.interest?.period],
  );
  const plan = useMemo(() => planEmiTermsEdit(row.emi, row.installments, proposed), [row.emi, row.installments, proposed]);
  const hasRate = proposed.ratePercent != null && proposed.ratePercent > 0;
  const previewKey = `${scheduleFingerprint(row.installments)}#${JSON.stringify(proposed)}`;
  const confirmed = confirmedKey === previewKey;
  const canSave = blocker == null && plan.errors.length === 0 && !plan.unchanged && confirmed && !saving;
  const paidCount = plan.settledCount;
  const totalPaidMoney = row.installments.reduce((s, i) => s + i.amountPaid, 0);
  const ratePeriod = row.emi.interest?.period ?? "yearly";

  async function save() {
    if (!canSave || !actions || !uid) return;
    setSaving(true);
    const op = startOperation({ label: "Updating EMI terms", successLabel: "EMI terms updated", errorLabel: "Couldn't update EMI terms" });
    try {
      op.stage("submit", "Checking the schedule is unchanged");
      const fresh = (await createInstallmentRepositoryFor(uid, row.emi.scheduleId).getAll()).filter((i) => i.deletedAt == null);
      if (scheduleFingerprint(fresh) !== scheduleFingerprint(row.installments)) {
        throw new Error("The schedule changed since this screen opened (a payment was recorded or edited). Close and reopen it to review the new figures.");
      }
      op.stage("related", "Re-planning the unpaid installments");
      await actions.editEmiTerms(row.emi, {
        currentInstallments: fresh,
        interest: plan.interest,
        installmentFrequency: proposed.frequency,
        newInstallmentCount: proposed.installmentCount,
        dueDayOfMonth: proposed.dueDayOfMonth,
      });
      op.succeed();
      onOpenChange(false);
    } catch (e) {
      op.fail({ detail: errorDetail(e) ?? "Please try again." });
    } finally {
      setSaving(false);
    }
  }

  const cardLinked = row.linkedCard != null;
  return (
    <LoanEmiFormDialog
      open
      onOpenChange={(v) => !saving && onOpenChange(v)}
      title={`Edit terms — ${row.emi.name}`}
      description="Change the rate, tenure, frequency or due day of the unpaid installments. Paid installments and the principal stay exactly as they are."
      onConfirm={save}
      confirmLabel={saving ? "Saving…" : "Save new terms"}
      confirmDisabled={!canSave}
      loading={saving}
      size="wide"
    >
      <div className="flex flex-col gap-4" data-testid="emi-edit-terms">
        {blocker && (
          <p role="note" className="flex items-start gap-2 rounded-lg border border-warning/50 bg-warning/10 p-3 text-xs text-foreground" data-testid="emi-terms-blocked">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>{blocker}</span>
          </p>
        )}

        <fieldset disabled={blocker != null || saving} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={`Interest rate (% per ${ratePeriod === "monthly" ? "month" : "year"})`} hint="Leave empty for no interest.">
            <input aria-label="Interest rate" type="number" inputMode="decimal" min="0" max="100" step="0.01" className={LOAN_EMI_INPUT} value={rate} onChange={(e) => setRate(e.target.value)} data-testid="emi-terms-rate" />
          </Field>
          <Field label="Number of installments" hint={paidCount > 0 ? `Includes the ${paidCount} already settled.` : undefined}>
            <input aria-label="Number of installments" type="number" inputMode="numeric" min={paidCount + 1} step="1" className={LOAN_EMI_INPUT} value={count} onChange={(e) => setCount(e.target.value)} data-testid="emi-terms-count" />
          </Field>
          {hasRate && (
            <Field label="Interest type">
              <SegmentedControl ariaLabel="Interest type" size="sm" className="sm:w-full" options={TYPE_OPTIONS} value={interestType} onChange={setInterestType} />
            </Field>
          )}
          <Field label="Payment frequency">
            <SegmentedControl ariaLabel="Payment frequency" size="sm" className="sm:w-full" options={FREQUENCY_OPTIONS} value={frequency} onChange={setFrequency} />
          </Field>
          {frequency === "monthly" && (
            <Field label="Monthly due day" hint="Empty keeps the current due day.">
              <input aria-label="Monthly due day" type="number" inputMode="numeric" min="1" max="31" step="1" className={LOAN_EMI_INPUT} value={dueDay} onChange={(e) => setDueDay(e.target.value)} data-testid="emi-terms-dueday" />
            </Field>
          )}
        </fieldset>

        {plan.errors.length > 0 && (
          <ul role="alert" className="space-y-0.5 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive" data-testid="emi-terms-errors">
            {plan.errors.map((e) => <li key={e}>{e}</li>)}
          </ul>
        )}

        <section aria-label="Current and proposed terms" className="overflow-hidden rounded-lg border border-border" data-testid="emi-terms-compare">
          <div className="grid grid-cols-[1fr_auto] gap-3 bg-secondary/40 px-3 py-1.5 text-[11px] font-medium text-muted-foreground uppercase">
            <span>Term</span>
            <span>Current → proposed</span>
          </div>
          <TermRow label="Interest rate" testId="emi-terms-row-rate"><Delta before={initial.ratePercent == null ? "None" : `${initial.ratePercent}%`} after={plan.interest ? `${plan.interest.ratePercent}%` : "None"} /></TermRow>
          <TermRow label="Installments (total)" testId="emi-terms-row-count"><Delta before={String(initial.installmentCount)} after={String(plan.after.installmentCount)} /></TermRow>
          <TermRow label="Frequency"><Delta before={FREQUENCY_LABEL[initial.frequency] ?? initial.frequency} after={FREQUENCY_LABEL[frequency] ?? frequency} /></TermRow>
          <TermRow label="Next installment amount" testId="emi-terms-row-emi"><Delta before={plan.before.emiAmount == null ? "—" : money(plan.before.emiAmount)} after={plan.after.emiAmount == null ? "—" : money(plan.after.emiAmount)} /></TermRow>
          <TermRow label="Last installment" testId="emi-terms-row-end"><Delta before={date(plan.before.endDate)} after={date(plan.after.endDate)} /></TermRow>
        </section>

        <p className="text-xs text-muted-foreground" data-testid="emi-terms-effective">
          {plan.effectiveFrom
            ? `Applies from installment ${plan.effectiveFrom.sequenceNumber}, due ${date(plan.effectiveFrom.dueDate)}. `
            : "No unpaid installment is affected. "}
          {paidCount} settled installment{paidCount === 1 ? "" : "s"} ({money(totalPaidMoney)} paid) and their payment history are kept as they are.
        </p>

        <section aria-label="Unpaid installments before and after" className="space-y-1.5">
          <h3 className="text-sm font-semibold text-foreground">Unpaid installments</h3>
          <ScheduleDiff before={plan.currentTail} after={plan.errors.length > 0 ? plan.currentTail : plan.newTail} />
        </section>

        <section aria-label="Impact" className="space-y-1 rounded-lg border border-border p-3 text-xs" data-testid="emi-terms-impact">
          <h3 className="text-sm font-semibold text-foreground">Impact</h3>
          <TermRow label="Outstanding principal" testId="emi-terms-impact-principal"><span className="font-medium tabular-nums">{money(plan.outstandingPrincipal)} <span className="font-normal text-muted-foreground">— unchanged</span></span></TermRow>
          <TermRow label="Still to pay (principal + interest)" testId="emi-terms-impact-payable"><Delta before={money(plan.before.remainingPayable)} after={money(plan.after.remainingPayable)} /></TermRow>
          <TermRow label="Interest still to pay" testId="emi-terms-impact-interest"><Delta before={money(plan.before.remainingInterest)} after={money(plan.after.remainingInterest)} /></TermRow>
          {cardLinked ? (
            <p className="flex items-start gap-1.5 pt-1 text-muted-foreground" data-testid="emi-terms-card-impact">
              <CreditCard className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span>
                {cardName ?? "The linked card"}: nothing changes today — the {money(plan.outstandingPrincipal)} of principal locked on the card is the same, so its available credit and outstanding stay put. Future installments are funded as you choose when you pay each one (card or bank), at the new amounts above.
              </span>
            </p>
          ) : (
            <p className="pt-1 text-muted-foreground" data-testid="emi-terms-account-impact">No account balance changes: this only reshapes the unpaid installments.</p>
          )}
        </section>

        <label className={cn("flex items-start gap-2 text-xs text-foreground", (blocker != null || plan.errors.length > 0 || plan.unchanged) && "opacity-50")}>
          <input type="checkbox" className="mt-0.5" checked={confirmed} disabled={blocker != null || plan.errors.length > 0 || plan.unchanged || saving} onChange={(e) => setConfirmedKey(e.target.checked ? previewKey : null)} data-testid="emi-terms-confirm" />
          <span>I understand the unpaid installments above will be replaced with the new schedule. Paid installments, payments and principal are not changed.</span>
        </label>
        {plan.unchanged && blocker == null && <p className="text-xs text-muted-foreground" data-testid="emi-terms-unchanged">No change yet — edit a term above to preview it.</p>}
        <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
          <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          Just before saving, the schedule is re-checked; if a payment was recorded meanwhile, nothing is changed and you&rsquo;re asked to reopen this screen.
        </p>
      </div>
    </LoanEmiFormDialog>
  );
}
