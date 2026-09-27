"use client";

import { CreditCard, Percent, ShoppingBag } from "lucide-react";
import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Stagger } from "@/components/foundation/animated-container";
import { ChipRow, ConfirmDialog, EmptyState, FLAT_INPUT, FormDialog, SectionLabel } from "@/components/finance";
import { Skeleton } from "@/components/ui/skeleton";
import { EMI_TYPE_LABEL, EmiCard } from "@/features/emi/components/emi-card";
import { EmiScheduleDialog } from "@/features/emi/components/emi-schedule-dialog";
import { useEmiActions, useEmiRows, type EmiRow } from "@/features/emi/hooks/use-emi-data";
import {
  AmountInput,
  EMI_ICON,
  Field,
  FieldGroup,
  FormSection,
  LOAN_EMI_INPUT,
  LoanEmiFormDialog,
  MoreOptions,
  RevealToggle,
  SegmentedControl,
} from "@/features/loans/components/loan-emi-ui";
import type { Installment, ScheduleType } from "@/lib/models/payment-schedule";
import type { EmiLoanType } from "@/lib/models/emi";
import { formatCurrency } from "@/lib/format";
import type { InterestType } from "@/lib/engines/interest-calculator";
import type { CreditCardProfile } from "@/lib/models/credit-card";
import { useCreditCards } from "@/hooks/use-credit-cards";
import { AddElsewhereLink } from "@/features/loans/components/loans-workspace";
import { useAccounts } from "@/hooks/use-accounts";
import { useLoanPersons } from "@/hooks/use-loans";
import {
  WhoIsThisForField,
  beneficiaryFromChoice,
  ownershipError,
  type OwnershipChoice,
} from "@/features/loans/components/who-is-this-for-field";
import { toast } from "@/store/toast-store";
import { cn } from "@/lib/utils";

const LOAN_TYPE_OPTIONS: EmiLoanType[] = ["other", "personal", "vehicle", "home", "education", "gold", "business", "creditCard"];
const FREQUENCY_OPTIONS: ScheduleType[] = ["monthly", "weekly"];
const INSTALLMENT_PRESETS = [3, 6, 9, 12, 18, 24];
const FREQUENCY_LABEL: Record<ScheduleType, string> = {
  monthly: "Monthly",
  weekly: "Weekly",
  custom: "Custom",
  oneTime: "One-time",
};

/** How a card-linked EMI came about — picks the form wording; both lock the principal against the card. */
type CardEmiKind = "creditCardLoan" | "productPurchase";

interface EmiFormState {
  name: string;
  lenderName: string;
  loanType: EmiLoanType;
  principalAmount: string;
  startDate: string;
  installmentFrequency: ScheduleType;
  installmentCount: string;
  hasInterest: boolean;
  interestType: InterestType;
  ratePercent: string;
  notes: string;
  linkToCard: boolean;
  linkedCreditCardId: string;
  cardEmiKind: CardEmiKind;
  /** "Who is this for?" — see `Emi.beneficiaryPersonId`. */
  ownership: OwnershipChoice;
  beneficiaryPersonId: string;
}

function emptyForm(): EmiFormState {
  return {
    name: "",
    lenderName: "",
    loanType: "other",
    principalAmount: "",
    startDate: new Date().toISOString().slice(0, 10),
    installmentFrequency: "monthly",
    installmentCount: "12",
    hasInterest: false,
    interestType: "reducingBalance",
    ratePercent: "",
    notes: "",
    linkToCard: false,
    linkedCreditCardId: "",
    cardEmiKind: "productPurchase",
    ownership: "me",
    beneficiaryPersonId: "",
  };
}

interface PaymentFormState {
  amount: string;
  date: string;
  note: string;
  gst: string;
  processingFee: string;
}

function emptyPaymentForm(amount: number): PaymentFormState {
  return {
    amount: amount > 0 ? String(amount) : "",
    date: new Date().toISOString().slice(0, 10),
    note: "",
    gst: "",
    processingFee: "",
  };
}

/** Rough per-installment figure for the Add EMI preview — the real schedule is built on save. */
function previewInstallment(form: EmiFormState): { perInstallment: number; interest: number } | null {
  const principal = Number(form.principalAmount);
  const count = Math.floor(Number(form.installmentCount));
  if (!(principal > 0) || !(count > 0)) return null;
  const annual = form.hasInterest ? Number(form.ratePercent) / 100 : 0;
  if (!(annual > 0)) return { perInstallment: principal / count, interest: 0 };
  const periodsPerYear = form.installmentFrequency === "weekly" ? 52 : 12;
  if (form.interestType === "flat") {
    const interest = principal * annual * (count / periodsPerYear);
    return { perInstallment: (principal + interest) / count, interest };
  }
  const r = annual / periodsPerYear;
  const per = (principal * r) / (1 - Math.pow(1 + r, -count));
  return { perInstallment: per, interest: per * count - principal };
}

export interface EmiWorkspaceProps {
  /** Incremented by the unified Loan & EMI chooser to open the Add EMI form. */
  addSignal?: number;
}

export function EmiWorkspace({ addSignal = 0 }: EmiWorkspaceProps = {}) {
  const searchParams = useSearchParams();
  const createHandoff = searchParams.get("create");
  const { rows, isLoading } = useEmiRows();
  const actions = useEmiActions();
  const { data: cards = [] } = useCreditCards();
  const { data: accounts = [] } = useAccounts();
  const { data: people = [] } = useLoanPersons();
  const cardOptions = useMemo(
    () =>
      (cards as CreditCardProfile[])
        .filter((c) => c.status !== "closed" && c.status !== "cancelled")
        .map((c) => {
          const accountName = accounts.find((a) => a.id === c.accountId)?.name ?? "Credit Card";
          return { id: c.id, label: c.lastFourDigits ? `${accountName} ••${c.lastFourDigits}` : accountName };
        }),
    [cards, accounts],
  );

  const [activeRow, setActiveRow] = useState<EmiRow | null>(null);
  const [handoffDetailId, setHandoffDetailId] = useState<string | null>(() => searchParams.get("agreement"));
  const [addOpen, setAddOpen] = useState(() => createHandoff === "installmentPurchase");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [payTarget, setPayTarget] = useState<Installment | null>(null);
  const [form, setForm] = useState<EmiFormState>(emptyForm);
  const [paymentForm, setPaymentForm] = useState<PaymentFormState>(() => emptyPaymentForm(0));
  const [saving, setSaving] = useState(false);
  const [statusBusy, setStatusBusy] = useState(false);

  const activeRowFresh = useMemo(() => {
    const id = activeRow?.emi.id ?? handoffDetailId;
    if (!id) return null;
    return rows.find((row) => row.emi.id === id) ?? activeRow;
  }, [rows, activeRow, handoffDetailId]);

  function openAdd() {
    setForm(emptyForm());
    setAddOpen(true);
  }

  const [seenAddSignal, setSeenAddSignal] = useState(addSignal);
  if (addSignal !== seenAddSignal) {
    setSeenAddSignal(addSignal);
    openAdd();
  }

  function openPay(installment: Installment) {
    setPaymentForm(emptyPaymentForm(installment.amountDue));
    setPayTarget(installment);
  }

  async function handleCreate() {
    if (!actions) return;
    if (form.linkToCard && !form.linkedCreditCardId) {
      toast.error("Select a credit card", "Choose the card this EMI is on, or turn off the credit card option.");
      return;
    }
    const forError = ownershipError(form.ownership, form.beneficiaryPersonId);
    if (forError) {
      toast.error(forError, "Pick the person this EMI is for, or switch to For me.");
      return;
    }
    setSaving(true);
    try {
      await actions.createEmi({
        name: form.name,
        lenderName: form.lenderName || null,
        loanType: form.linkToCard ? "creditCard" : form.loanType,
        // No purchaseTransactionId: the EMI's remaining principal is what locks the card's limit.
        linkedCreditCardId: form.linkToCard ? form.linkedCreditCardId : null,
        // Association only — a card-linked EMI still locks the card's credit exactly as before.
        beneficiaryPersonId: beneficiaryFromChoice(form.ownership, form.beneficiaryPersonId),
        principalAmount: Number(form.principalAmount),
        startDate: new Date(form.startDate),
        installmentFrequency: form.installmentFrequency,
        installmentCount: Number(form.installmentCount),
        interest: form.hasInterest
          ? { type: form.interestType, ratePercent: Number(form.ratePercent), period: "yearly" }
          : null,
        notes: form.notes,
      });
      setAddOpen(false);
    } catch (e) {
      toast.error("Couldn't add EMI", e instanceof Error ? e.message : "Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!actions || !activeRowFresh) return;
    try {
      await actions.deleteEmi(activeRowFresh.emi);
      setDeleteOpen(false);
      setActiveRow(null);
    } catch (e) {
      toast.error("Couldn't delete EMI", e instanceof Error ? e.message : "Please try again.");
    }
  }

  async function handleRecordPayment() {
    if (!actions || !activeRowFresh || !payTarget) return;
    setSaving(true);
    try {
      await actions.recordPayment(activeRowFresh.emi, payTarget, {
        amount: Number(paymentForm.amount),
        date: new Date(paymentForm.date),
        note: paymentForm.note,
        gst: paymentForm.gst ? Number(paymentForm.gst) : undefined,
        processingFee: paymentForm.processingFee ? Number(paymentForm.processingFee) : undefined,
      });
      setPayTarget(null);
    } catch (e) {
      toast.error("Couldn't record payment", e instanceof Error ? e.message : "Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleClose(row: EmiRow) {
    if (!actions) return;
    setStatusBusy(true);
    try {
      if (row.status === "closed") {
        await actions.reopenEmi(row.emi);
      } else {
        await actions.closeEmi(row.emi);
      }
    } catch (e) {
      toast.error("Couldn't update EMI status", e instanceof Error ? e.message : "Please try again.");
    } finally {
      setStatusBusy(false);
    }
  }

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="h-48 rounded-2xl" />
        ))}
      </div>
    );
  }

  const detail = activeRowFresh;
  const isProductPurchase = !form.linkToCard || form.cardEmiKind === "productPurchase";
  const preview = previewInstallment(form);

  return (
    <div className="flex flex-col gap-4">
      {rows.length === 0 ? (
        <EmptyState
          icon={ShoppingBag}
          title="No active EMIs yet"
          description="Track purchases, card EMIs and other installment plans."
          actionLabel="Add EMI"
          onAction={openAdd}
        />
      ) : (
        <Stagger className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((row) => (
            <EmiCard key={row.emi.id} row={row} onClick={() => setActiveRow(row)} />
          ))}
        </Stagger>
      )}

      <EmiScheduleDialog
        open={detail != null && !deleteOpen && payTarget == null}
        onOpenChange={(open) => {
          if (!open) {
            setActiveRow(null);
            setHandoffDetailId(null);
          }
        }}
        row={detail}
        onDelete={() => setDeleteOpen(true)}
        onRecordPayment={(_row, installment) => openPay(installment)}
        onToggleClose={handleToggleClose}
        statusBusy={statusBusy}
      />

      <LoanEmiFormDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        icon={EMI_ICON}
        title="Add EMI"
        description="The installment schedule is built for you."
        onConfirm={handleCreate}
        confirmLabel={saving ? "Saving…" : "Add EMI"}
        loading={saving}
      >
        {/* Hero: what + how much, with a live per-installment preview. */}
        <section className="flex flex-col gap-4 rounded-2xl border border-border bg-gradient-to-br from-primary/10 via-card to-card p-4 sm:p-5">
          <input
            className="w-full border-0 bg-transparent p-0 font-heading text-lg font-semibold tracking-tight outline-none placeholder:text-muted-foreground/50"
            placeholder={isProductPurchase ? "What did you buy? e.g. iPhone 16" : "Name this card loan"}
            aria-label="What did you buy or finance?"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          />
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Amount being paid off</span>
            <AmountInput value={form.principalAmount} onChange={(v) => setForm((f) => ({ ...f, principalAmount: v }))} />
          </div>
          <div className="flex items-center justify-between gap-3 rounded-xl bg-card/80 px-3.5 py-3 shadow-[var(--shadow-e1)]">
            <div className="flex flex-col">
              <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                Per {form.installmentFrequency === "weekly" ? "week" : "month"}
              </span>
              <span className="font-heading text-xl font-semibold tabular-nums">
                {preview ? `≈ ${formatCurrency(preview.perInstallment)}` : "—"}
              </span>
            </div>
            <div className="flex flex-col items-end text-right text-xs text-muted-foreground">
              <span>
                {Number(form.installmentCount) > 0 ? `${form.installmentCount} installments` : "Set installments"}
              </span>
              {preview && preview.interest > 0 && <span>+ {formatCurrency(preview.interest)} interest</span>}
              {preview && preview.interest === 0 && <span className="text-primary-accent-text">No-cost</span>}
            </div>
          </div>
        </section>

        <FormSection title="Schedule" description="When and how often you pay.">
          <FieldGroup label="Number of installments">
            <div className="flex flex-wrap items-center gap-2">
              {INSTALLMENT_PRESETS.map((n) => {
                const active = form.installmentCount === String(n);
                return (
                  <button
                    key={n}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setForm((f) => ({ ...f, installmentCount: String(n) }))}
                    className={cn(
                      "h-9 min-w-11 rounded-full border px-3 text-sm font-medium tabular-nums transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      active
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-card text-foreground/80 hover:border-foreground/25",
                    )}
                  >
                    {n}
                  </button>
                );
              })}
              <input
                type="number"
                inputMode="numeric"
                min={1}
                aria-label="Custom number of installments"
                placeholder="Other"
                className={cn(LOAN_EMI_INPUT, "h-9 w-24 rounded-full text-center")}
                value={INSTALLMENT_PRESETS.includes(Number(form.installmentCount)) ? "" : form.installmentCount}
                onChange={(e) => setForm((f) => ({ ...f, installmentCount: e.target.value }))}
              />
            </div>
          </FieldGroup>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="First EMI date">
              <input
                type="date"
                className={LOAN_EMI_INPUT}
                value={form.startDate}
                onChange={(e) => setForm((f) => ({ ...f, startDate: e.target.value }))}
              />
            </Field>
            <FieldGroup label="Payment frequency">
              <SegmentedControl
                ariaLabel="Payment frequency"
                size="sm"
                className="sm:w-full"
                options={FREQUENCY_OPTIONS.map((f) => ({ value: f, label: FREQUENCY_LABEL[f] }))}
                value={form.installmentFrequency}
                onChange={(v) => setForm((f) => ({ ...f, installmentFrequency: v }))}
              />
            </FieldGroup>
          </div>
        </FormSection>

        <FormSection title="Details" description="Turn on only what applies.">
        <div className="flex flex-col gap-3">
          {/* Credit card controls stay hidden until the user says it's on a card. */}
          <RevealToggle
            icon={CreditCard}
            checked={form.linkToCard}
            onChange={(checked) => setForm((f) => ({ ...f, linkToCard: checked }))}
            title="Paid with a credit card"
            description="Link this EMI to one of your FlowFi credit cards."
          >
            {cardOptions.length === 0 ? (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">No credit cards yet — add one, then come back.</p>
                <AddElsewhereLink href="/credit-cards" label="Go to Credit Cards" />
              </div>
            ) : (
              <>
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-foreground/80">Which card?</span>
                    <AddElsewhereLink href="/credit-cards" label="Add Credit Card" />
                  </div>
                  <select
                    className={LOAN_EMI_INPUT}
                    value={form.linkedCreditCardId}
                    onChange={(e) => setForm((f) => ({ ...f, linkedCreditCardId: e.target.value }))}
                  >
                    <option value="">Select a card</option>
                    {cardOptions.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </div>
                <FieldGroup label="What kind?" hint="The amount is held against the card's limit and released as you pay.">
                  <SegmentedControl
                    ariaLabel="Card EMI kind"
                    size="sm"
                    options={[
                      { value: "productPurchase" as CardEmiKind, label: "Product purchase" },
                      { value: "creditCardLoan" as CardEmiKind, label: "Credit card loan" },
                    ]}
                    value={form.cardEmiKind}
                    onChange={(v) => setForm((f) => ({ ...f, cardEmiKind: v }))}
                  />
                </FieldGroup>
              </>
            )}
          </RevealToggle>

          <RevealToggle
            icon={Percent}
            checked={form.hasInterest}
            onChange={(checked) => setForm((f) => ({ ...f, hasInterest: checked }))}
            title="Has interest?"
            description="Leave off for a no-cost EMI."
          >
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Interest rate (% per year)">
                <input
                  type="number"
                  inputMode="decimal"
                  className={LOAN_EMI_INPUT}
                  placeholder="e.g. 14"
                  value={form.ratePercent}
                  onChange={(e) => setForm((f) => ({ ...f, ratePercent: e.target.value }))}
                />
              </Field>
              <FieldGroup label="Interest type">
                <SegmentedControl
                  ariaLabel="Interest type"
                  size="sm"
                  className="sm:w-full"
                  options={[
                    { value: "reducingBalance" as InterestType, label: "Reducing" },
                    { value: "flat" as InterestType, label: "Flat" },
                  ]}
                  value={form.interestType}
                  onChange={(v) => setForm((f) => ({ ...f, interestType: v }))}
                />
              </FieldGroup>
            </div>
          </RevealToggle>
        </div>
        </FormSection>

        <WhoIsThisForField
          variant="section"
          people={people}
          choice={form.ownership}
          personId={form.beneficiaryPersonId}
          onChange={({ choice, personId }) => setForm((f) => ({ ...f, ownership: choice, beneficiaryPersonId: personId }))}
        />

        <MoreOptions summary={form.linkToCard ? "Lender, notes" : "Lender, type, notes"}>
          <Field label="Lender / store">
            <input
              className={LOAN_EMI_INPUT}
              placeholder="e.g. Bajaj Finance, HDFC Bank"
              value={form.lenderName}
              onChange={(e) => setForm((f) => ({ ...f, lenderName: e.target.value }))}
            />
          </Field>
          {!form.linkToCard && (
            <FieldGroup label="Type">
              <ChipRow
                options={LOAN_TYPE_OPTIONS.map((t) => ({ value: t, label: EMI_TYPE_LABEL[t] }))}
                value={form.loanType}
                onChange={(v) => setForm((f) => ({ ...f, loanType: v }))}
              />
            </FieldGroup>
          )}
          <Field label="Notes">
            <textarea
              className={cn(LOAN_EMI_INPUT, "h-auto min-h-20 resize-none py-2")}
              placeholder="Optional notes"
              rows={3}
              value={form.notes}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
            />
          </Field>
        </MoreOptions>
      </LoanEmiFormDialog>

      <FormDialog
        open={payTarget != null}
        onOpenChange={(open) => !open && setPayTarget(null)}
        title={`Record Payment — ${detail?.emi.name ?? "EMI"}`}
        description="GST/processing fee are tracked for your records only."
        onConfirm={handleRecordPayment}
        confirmLabel={saving ? "Saving…" : "Record"}
        contentClassName="sm:max-w-lg"
      >
        <div className="flex flex-col gap-4 text-sm">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Amount">
              <AmountInput value={paymentForm.amount} onChange={(v) => setPaymentForm((f) => ({ ...f, amount: v }))} autoFocus />
            </Field>
            <Field label="Date">
              <input
                type="date"
                className={cn(FLAT_INPUT, "h-12")}
                value={paymentForm.date}
                onChange={(e) => setPaymentForm((f) => ({ ...f, date: e.target.value }))}
              />
            </Field>
          </div>
          <div className="flex flex-col gap-3 border-t border-border pt-4">
            <SectionLabel>Optional</SectionLabel>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="GST">
                <input
                  type="number"
                  inputMode="decimal"
                  className={FLAT_INPUT}
                  value={paymentForm.gst}
                  onChange={(e) => setPaymentForm((f) => ({ ...f, gst: e.target.value }))}
                />
              </Field>
              <Field label="Processing fee">
                <input
                  type="number"
                  inputMode="decimal"
                  className={FLAT_INPUT}
                  value={paymentForm.processingFee}
                  onChange={(e) => setPaymentForm((f) => ({ ...f, processingFee: e.target.value }))}
                />
              </Field>
            </div>
            <Field label="Note">
              <input
                className={FLAT_INPUT}
                placeholder="Optional note"
                value={paymentForm.note}
                onChange={(e) => setPaymentForm((f) => ({ ...f, note: e.target.value }))}
              />
            </Field>
          </div>
        </div>
      </FormDialog>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete ${detail?.emi.name ?? "EMI"}?`}
        description="This permanently removes the EMI, its schedule, installments, and payment breakdowns. This action cannot be undone."
        variant="destructive"
        confirmLabel="Delete"
        onConfirm={handleDelete}
      />
    </div>
  );
}
