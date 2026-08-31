"use client";

import { CreditCard, Percent, Plus, StickyNote } from "lucide-react";
import { useMemo, useState } from "react";
import { ClayBadge } from "@/components/clay/clay-badge";
import { ClayButton } from "@/components/clay/clay-button";
import { Stagger } from "@/components/foundation/animated-container";
import {
  ChipRow,
  ConfirmDialog,
  CurrencyCell,
  DateCell,
  DetailDrawer,
  EmptyState,
  FLAT_INPUT,
  FormDialog,
  SectionedFormDialog,
  SectionLabel,
  SmartToolbar,
} from "@/components/finance";
import { Skeleton } from "@/components/ui/skeleton";
import { Landmark } from "lucide-react";
import { EmiCard } from "@/features/emi/components/emi-card";
import { EmisSummary } from "@/features/emi/components/emis-summary";
import { useEmiActions, useEmiRows, type EmiRow } from "@/features/emi/hooks/use-emi-data";
import { installmentStatus, remainingAmount, type ScheduleType } from "@/lib/models/payment-schedule";
import type { EmiLoanType } from "@/lib/models/emi";
import type { InterestType } from "@/lib/engines/interest-calculator";
import { toast } from "@/store/toast-store";
import { cn } from "@/lib/utils";

const LOAN_TYPE_OPTIONS: EmiLoanType[] = ["home", "personal", "vehicle", "education", "gold", "business", "creditCard", "other"];
const LOAN_TYPE_LABEL: Record<EmiLoanType, string> = {
  home: "Home",
  personal: "Personal",
  vehicle: "Vehicle",
  education: "Education",
  gold: "Gold",
  business: "Business",
  creditCard: "Credit Card Conversion",
  other: "Other",
};
const FREQUENCY_OPTIONS: ScheduleType[] = ["monthly", "weekly"];
const FREQUENCY_LABEL: Record<ScheduleType, string> = {
  monthly: "Monthly",
  weekly: "Weekly",
  custom: "Custom",
  oneTime: "One-time",
};

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

export function EmiWorkspace() {
  const { rows, isLoading } = useEmiRows();
  const actions = useEmiActions();

  const [activeRow, setActiveRow] = useState<EmiRow | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
  const [form, setForm] = useState<EmiFormState>(emptyForm);
  const [paymentForm, setPaymentForm] = useState<PaymentFormState>(() => emptyPaymentForm(0));
  const [saving, setSaving] = useState(false);

  const activeRowFresh = useMemo(
    () => (activeRow ? (rows.find((r) => r.emi.id === activeRow.emi.id) ?? activeRow) : null),
    [rows, activeRow],
  );

  function openAdd() {
    setForm(emptyForm());
    setAddOpen(true);
  }

  function openPay(row: EmiRow) {
    setPaymentForm(emptyPaymentForm(row.nextInstallment?.amountDue ?? 0));
    setPayOpen(true);
  }

  async function handleCreate() {
    if (!actions) return;
    setSaving(true);
    try {
      await actions.createEmi({
        name: form.name,
        lenderName: form.lenderName || null,
        loanType: form.loanType,
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
    if (!actions || !activeRowFresh?.nextInstallment) return;
    setSaving(true);
    try {
      await actions.recordPayment(activeRowFresh.emi, activeRowFresh.nextInstallment, {
        amount: Number(paymentForm.amount),
        date: new Date(paymentForm.date),
        note: paymentForm.note,
        gst: paymentForm.gst ? Number(paymentForm.gst) : undefined,
        processingFee: paymentForm.processingFee ? Number(paymentForm.processingFee) : undefined,
      });
      setPayOpen(false);
    } catch (e) {
      toast.error("Couldn't record payment", e instanceof Error ? e.message : "Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function handleClose() {
    if (!actions || !activeRowFresh) return;
    try {
      await actions.closeEmi(activeRowFresh.emi);
    } catch (e) {
      toast.error("Couldn't close EMI", e instanceof Error ? e.message : "Please try again.");
    }
  }

  if (isLoading) {
    return (
      <div className="flex flex-col gap-6 px-1">
        <h1 className="font-heading text-xl font-semibold tracking-tight text-foreground">EMI</h1>
        <Skeleton className="h-24 rounded-3xl" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-52 rounded-3xl" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 px-1">
      <SmartToolbar
        left={
          <div className="flex items-baseline gap-2">
            <h1 className="font-heading text-xl font-semibold tracking-tight text-foreground">EMI</h1>
            <span className="text-sm text-muted-foreground">{rows.length} EMIs</span>
          </div>
        }
        actions={
          <ClayButton size="sm" onClick={openAdd} className="gap-1.5">
            <Plus className="size-3.5" />
            Add EMI
          </ClayButton>
        }
      />

      <EmisSummary rows={rows} />

      {rows.length === 0 ? (
        <EmptyState
          icon={Landmark}
          title="No EMIs yet"
          description="Add an EMI to start tracking its installment schedule, remaining balance, and payments."
          actionLabel="Add EMI"
          onAction={openAdd}
        />
      ) : (
        <Stagger className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((row) => (
            <EmiCard key={row.emi.id} row={row} onClick={() => setActiveRow(row)} />
          ))}
        </Stagger>
      )}

      <DetailDrawer
        open={activeRowFresh != null && !deleteOpen && !payOpen}
        onOpenChange={(open) => !open && setActiveRow(null)}
        title={activeRowFresh?.emi.name ?? ""}
        description={
          activeRowFresh
            ? `${activeRowFresh.emi.lenderName ?? LOAN_TYPE_LABEL[activeRowFresh.emi.loanType]}${
                activeRowFresh.emi.interest ? ` • ${activeRowFresh.emi.interest.ratePercent}% p.a.` : ""
              }`
            : undefined
        }
        footer={
          activeRowFresh && (
            <div className="flex flex-col gap-2">
              <div className="flex gap-2">
                <ClayButton
                  variant="secondary"
                  className="flex-1"
                  disabled={!activeRowFresh.nextInstallment}
                  onClick={() => openPay(activeRowFresh)}
                >
                  Record Payment
                </ClayButton>
                <ClayButton
                  variant="secondary"
                  className="flex-1"
                  disabled={activeRowFresh.status === "closed"}
                  onClick={handleClose}
                >
                  Close EMI
                </ClayButton>
              </div>
              <ClayButton variant="secondary" className={cn("text-expense")} onClick={() => setDeleteOpen(true)}>
                Delete
              </ClayButton>
            </div>
          )
        }
      >
        {activeRowFresh && (
          <div className="flex flex-col gap-5 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Remaining Balance</span>
              <CurrencyCell amount={activeRowFresh.remainingBalance} signed={false} className="text-base font-semibold" />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Original Principal</span>
              <CurrencyCell amount={activeRowFresh.emi.principalAmount} signed={false} />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Interest Terms</span>
              <span className="font-medium text-foreground">
                {activeRowFresh.emi.interest
                  ? `${activeRowFresh.emi.interest.ratePercent}% ${activeRowFresh.emi.interest.period} (${
                      activeRowFresh.emi.interest.type === "flat" ? "Flat" : "Reducing Balance"
                    })`
                  : "No interest"}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Installments Paid</span>
              <span className="font-medium text-foreground">
                {activeRowFresh.installmentsPaid} / {activeRowFresh.emi.installmentCount}
              </span>
            </div>
            {activeRowFresh.nextInstallment && (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Next Due Date</span>
                <DateCell date={activeRowFresh.nextInstallment.dueDate} />
              </div>
            )}
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Auto-Debit</span>
              <span className="font-medium text-foreground">
                {activeRowFresh.emi.isAutoDebitEnabled
                  ? activeRowFresh.emi.autoDebitAccount ?? "Enabled"
                  : "Not set up"}
              </span>
            </div>
            {activeRowFresh.linkedCard && (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Linked Credit Card</span>
                <span className="font-medium text-foreground">{activeRowFresh.linkedCard.lastFourDigits ?? "Card"}</span>
              </div>
            )}

            <div className="flex flex-col gap-2 border-t border-border/60 pt-4">
              <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Installments</span>
              <div className="flex flex-col gap-1">
                {activeRowFresh.installments.slice(0, 12).map((installment) => {
                  const status = installmentStatus(installment);
                  return (
                    <div key={installment.id} className={cn("flex items-center justify-between rounded-xl px-3 py-2.5", status === "paid" ? "bg-muted/50" : "clay-pressed")}>
                      <div className="flex flex-col gap-0.5">
                        <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                          Installment #{installment.sequenceNumber}
                          {status === "paid" && <ClayBadge tone="success">Paid</ClayBadge>}
                          {status === "overdue" && <ClayBadge tone="expense">Overdue</ClayBadge>}
                        </span>
                        <DateCell date={installment.dueDate} className="text-xs" />
                      </div>
                      <div className="flex flex-col items-end gap-0.5">
                        <CurrencyCell amount={installment.amountDue} signed={false} className="text-sm font-semibold" />
                        <span className="text-xs text-muted-foreground">
                          Bal. {remainingAmount(installment).toLocaleString("en-IN")}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </DetailDrawer>

      <SectionedFormDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        title="Add an EMI"
        description="Track an EMI's installment schedule, remaining balance, and payments."
        onConfirm={handleCreate}
        confirmLabel={saving ? "Saving…" : "Add EMI"}
        loading={saving}
        contentClassName="sm:max-w-2xl"
      >
        <div className="flex flex-col gap-3 bg-muted/30 p-4">
          <SectionLabel icon={CreditCard}>EMI Details</SectionLabel>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">EMI Name</span>
            <input
              className={FLAT_INPUT}
              placeholder="e.g. Car Loan"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Lender (optional)</span>
            <input
              className={FLAT_INPUT}
              placeholder="e.g. HDFC Bank"
              value={form.lenderName}
              onChange={(e) => setForm((f) => ({ ...f, lenderName: e.target.value }))}
            />
          </label>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Loan Type</span>
            <ChipRow
              options={LOAN_TYPE_OPTIONS.map((t) => ({ value: t, label: LOAN_TYPE_LABEL[t] }))}
              value={form.loanType}
              onChange={(v) => setForm((f) => ({ ...f, loanType: v }))}
            />
          </div>
        </div>

        <div className="flex flex-col gap-3 bg-muted/30 p-4">
          <SectionLabel icon={Percent}>Principal & Schedule</SectionLabel>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Principal</span>
              <div className="relative">
                <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm font-semibold text-primary">₹</span>
                <input
                  type="number"
                  className={cn(FLAT_INPUT, "border-primary/30 bg-primary/5 pl-7 text-base font-semibold focus:border-primary")}
                  placeholder="0.00"
                  value={form.principalAmount}
                  onChange={(e) => setForm((f) => ({ ...f, principalAmount: e.target.value }))}
                />
              </div>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">First EMI Date</span>
              <input
                type="date"
                className={FLAT_INPUT}
                value={form.startDate}
                onChange={(e) => setForm((f) => ({ ...f, startDate: e.target.value }))}
              />
            </label>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Frequency</span>
            <ChipRow
              options={FREQUENCY_OPTIONS.map((f) => ({ value: f, label: FREQUENCY_LABEL[f] }))}
              value={form.installmentFrequency}
              onChange={(v) => setForm((f) => ({ ...f, installmentFrequency: v }))}
            />
          </div>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground"># Installments</span>
            <input
              type="number"
              className={FLAT_INPUT}
              value={form.installmentCount}
              onChange={(e) => setForm((f) => ({ ...f, installmentCount: e.target.value }))}
            />
          </label>
        </div>

        <div className="flex flex-col gap-3 bg-muted/30 p-4">
          <SectionLabel icon={Percent}>Interest (optional)</SectionLabel>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={form.hasInterest}
              onChange={(e) => setForm((f) => ({ ...f, hasInterest: e.target.checked }))}
            />
            <span className="text-xs font-medium text-muted-foreground">This EMI carries interest</span>
          </label>
          {form.hasInterest && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-muted-foreground">Interest Type</span>
                <ChipRow
                  options={[
                    { value: "reducingBalance" as InterestType, label: "Reducing Balance" },
                    { value: "flat" as InterestType, label: "Flat" },
                  ]}
                  value={form.interestType}
                  onChange={(v) => setForm((f) => ({ ...f, interestType: v }))}
                />
              </div>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">Rate (% p.a.)</span>
                <input
                  type="number"
                  className={FLAT_INPUT}
                  placeholder="e.g. 8.65"
                  value={form.ratePercent}
                  onChange={(e) => setForm((f) => ({ ...f, ratePercent: e.target.value }))}
                />
              </label>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-2 bg-muted/30 p-4">
          <SectionLabel icon={StickyNote}>Notes</SectionLabel>
          <textarea
            className={cn(FLAT_INPUT, "min-h-20 resize-none py-2")}
            placeholder="Optional notes"
            rows={3}
            value={form.notes}
            onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
          />
        </div>
      </SectionedFormDialog>

      <FormDialog
        open={payOpen}
        onOpenChange={setPayOpen}
        title={`Record Payment — ${activeRowFresh?.emi.name ?? "EMI"}`}
        description="Records against the next-due installment. GST/processing fee are tracked for your records only."
        onConfirm={handleRecordPayment}
        confirmLabel={saving ? "Saving…" : "Record"}
        contentClassName="sm:max-w-lg"
      >
        <div className="flex flex-col gap-3 rounded-2xl bg-muted/30 p-4 text-sm">
          <SectionLabel icon={CreditCard}>Payment Details</SectionLabel>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Amount</span>
              <div className="relative">
                <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm font-semibold text-primary">₹</span>
                <input
                  type="number"
                  className="clay-pressed h-10 w-full rounded-xl border border-primary/20 bg-primary/5 pl-7 text-sm font-semibold outline-none"
                  value={paymentForm.amount}
                  onChange={(e) => setPaymentForm((f) => ({ ...f, amount: e.target.value }))}
                />
              </div>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Date</span>
              <input
                type="date"
                className="clay-pressed h-10 rounded-xl px-3 text-sm outline-none"
                value={paymentForm.date}
                onChange={(e) => setPaymentForm((f) => ({ ...f, date: e.target.value }))}
              />
            </label>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">GST (optional)</span>
              <input
                type="number"
                className="clay-pressed h-10 rounded-xl px-3 text-sm outline-none"
                value={paymentForm.gst}
                onChange={(e) => setPaymentForm((f) => ({ ...f, gst: e.target.value }))}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Processing Fee (optional)</span>
              <input
                type="number"
                className="clay-pressed h-10 rounded-xl px-3 text-sm outline-none"
                value={paymentForm.processingFee}
                onChange={(e) => setPaymentForm((f) => ({ ...f, processingFee: e.target.value }))}
              />
            </label>
          </div>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Note</span>
            <input
              className="clay-pressed h-10 rounded-xl px-3 text-sm outline-none"
              placeholder="Optional note"
              value={paymentForm.note}
              onChange={(e) => setPaymentForm((f) => ({ ...f, note: e.target.value }))}
            />
          </label>
        </div>
      </FormDialog>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete ${activeRowFresh?.emi.name ?? "EMI"}?`}
        description="This permanently removes the EMI, its schedule, installments, and payment breakdowns. This action cannot be undone."
        variant="destructive"
        confirmLabel="Delete"
        onConfirm={handleDelete}
      />
    </div>
  );
}
