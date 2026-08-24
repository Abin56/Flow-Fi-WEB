"use client";

import { Landmark, Plus } from "lucide-react";
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
  SectionedFormDialog,
  SectionLabel,
  SmartToolbar,
} from "@/components/finance";
import { Skeleton } from "@/components/ui/skeleton";
import type { InterestType } from "@/lib/engines/interest-calculator";
import type { ScheduleType } from "@/lib/models/payment-schedule";
import { LoanCard } from "@/features/loans/components/loan-card";
import { LoansSummary } from "@/features/loans/components/loans-summary";
import { useLoanActions, useLoanRows, type LoanRow } from "@/features/loans/hooks/use-loans-data";
import { cn } from "@/lib/utils";
import { toast } from "@/store/toast-store";

interface LoanFormState {
  name: string;
  lenderName: string;
  principal: string;
  ratePercent: string;
  interestType: InterestType;
  installmentFrequency: ScheduleType;
  installmentCount: string;
  loanDate: string;
  notes: string;
}

function emptyForm(): LoanFormState {
  return {
    name: "",
    lenderName: "",
    principal: "",
    ratePercent: "",
    interestType: "reducingBalance",
    installmentFrequency: "monthly",
    installmentCount: "12",
    loanDate: new Date().toISOString().slice(0, 10),
    notes: "",
  };
}

function formFromRow(row: LoanRow): LoanFormState {
  return {
    name: row.loan.name ?? "",
    lenderName: row.lenderName,
    principal: String(row.loan.loanAmount),
    ratePercent: String(row.loan.interest?.ratePercent ?? ""),
    interestType: row.loan.interest?.type ?? "reducingBalance",
    installmentFrequency: row.loan.installmentFrequency ?? "monthly",
    installmentCount: String(row.loan.installmentCount ?? row.totalInstallments),
    loanDate: row.loan.loanDate.toISOString().slice(0, 10),
    notes: row.loan.notes,
  };
}

export function LoansWorkspace() {
  const { rows, isLoading } = useLoanRows();
  const actions = useLoanActions();

  const [activeRow, setActiveRow] = useState<LoanRow | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [form, setForm] = useState<LoanFormState>(emptyForm);
  const [saving, setSaving] = useState(false);

  const timelineRows = useMemo(() => {
    if (!activeRow) return [];
    const paid = activeRow.installmentsPaid;
    // Two most recent paid installments + the next four upcoming — a readable slice of a schedule that
    // could otherwise run to 240+ rows.
    const start = Math.max(0, paid - 2);
    const end = Math.min(activeRow.installments.length, paid + 4);
    return activeRow.installments.slice(start, end);
  }, [activeRow]);

  function openAdd() {
    setActiveRow(null);
    setForm(emptyForm());
    setAddOpen(true);
  }

  function openEdit(row: LoanRow) {
    setActiveRow(row);
    setForm(formFromRow(row));
    setEditOpen(true);
  }

  async function handleSave(isEdit: boolean) {
    if (!actions) return;
    setSaving(true);
    try {
      if (isEdit && activeRow) {
        await actions.editLoan(activeRow.loan, {
          name: form.name,
          lenderName: form.lenderName,
          notes: form.notes,
          currentInstallments: activeRow.installments,
        });
        setEditOpen(false);
      } else {
        const ratePercent = Number(form.ratePercent);
        await actions.createLoan({
          name: form.name,
          lenderName: form.lenderName,
          loanAmount: Number(form.principal),
          loanDate: new Date(form.loanDate),
          interest: Number.isFinite(ratePercent) && ratePercent >= 0
            ? { type: form.interestType, ratePercent, period: "yearly" }
            : null,
          installmentFrequency: form.installmentFrequency,
          installmentCount: Number(form.installmentCount) || 1,
          notes: form.notes,
        });
        setAddOpen(false);
      }
      setActiveRow(null);
    } catch (e) {
      toast.error(isEdit ? "Couldn't save changes" : "Couldn't add loan", e instanceof Error ? e.message : "Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!actions || !activeRow) return;
    try {
      await actions.deleteLoan(activeRow.loan);
      setDeleteOpen(false);
      setActiveRow(null);
    } catch (e) {
      toast.error("Couldn't delete loan", e instanceof Error ? e.message : "Please try again.");
    }
  }

  if (isLoading) {
    return (
      <div className="flex flex-col gap-6 px-1">
        <h1 className="font-heading text-xl font-semibold tracking-tight text-foreground">Loans</h1>
        <Skeleton className="h-24 rounded-3xl" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-56 rounded-3xl" />
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
            <h1 className="font-heading text-xl font-semibold tracking-tight text-foreground">Loans</h1>
            <span className="text-sm text-muted-foreground">{rows.length} loans</span>
          </div>
        }
        actions={
          <ClayButton size="sm" onClick={openAdd} className="gap-1.5">
            <Plus className="size-3.5" />
            Add Loan
          </ClayButton>
        }
      />

      <LoansSummary rows={rows} />

      {rows.length === 0 ? (
        <EmptyState
          icon={Landmark}
          title="No loans yet"
          description="Add a bank or institutional loan to start tracking its repayment schedule."
          actionLabel="Add Loan"
          onAction={openAdd}
        />
      ) : (
        <Stagger className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((row) => (
            <LoanCard key={row.loan.id} row={row} onClick={() => setActiveRow(row)} />
          ))}
        </Stagger>
      )}

      <DetailDrawer
        open={activeRow != null && !editOpen && !deleteOpen}
        onOpenChange={(open) => !open && setActiveRow(null)}
        title={activeRow?.loan.name ?? ""}
        description={
          activeRow
            ? `${activeRow.lenderName}${activeRow.loan.interest ? ` • ${activeRow.loan.interest.ratePercent}% p.a.` : ""}`
            : undefined
        }
        footer={
          activeRow && (
            <div className="flex gap-2">
              <ClayButton variant="secondary" className="flex-1" onClick={() => openEdit(activeRow)}>
                Edit
              </ClayButton>
              <ClayButton variant="secondary" className={cn("flex-1 text-expense")} onClick={() => setDeleteOpen(true)}>
                Delete
              </ClayButton>
            </div>
          )
        }
      >
        {activeRow && (
          <div className="flex flex-col gap-5 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Outstanding Principal</span>
              <CurrencyCell amount={activeRow.outstandingPrincipal} signed={false} className="text-base font-semibold" />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Original Principal</span>
              <CurrencyCell amount={activeRow.loan.loanAmount} signed={false} />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">EMI Amount</span>
              <CurrencyCell amount={activeRow.emiAmount} signed={false} />
            </div>
            {activeRow.loan.interest && (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Interest Type</span>
                <ClayBadge tone="neutral">
                  {activeRow.loan.interest.type === "flat" ? "Flat" : "Reducing Balance"}
                </ClayBadge>
              </div>
            )}
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Installments Paid</span>
              <span className="font-medium text-foreground">
                {activeRow.installmentsPaid} / {activeRow.totalInstallments}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Next Due Date</span>
              {activeRow.nextDueDate ? <DateCell date={activeRow.nextDueDate} /> : <span className="text-muted-foreground">—</span>}
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Status</span>
              <ClayBadge tone={activeRow.status === "overdue" ? "expense" : activeRow.status === "closed" ? "neutral" : "success"}>
                {activeRow.status}
              </ClayBadge>
            </div>

            <div className="flex flex-col gap-2 border-t border-border/60 pt-4">
              <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                Repayment Timeline
              </span>
              <div className="flex flex-col gap-1">
                {timelineRows.map((installment) => {
                  const isPaid = installment.amountPaid >= installment.amountDue;
                  return (
                    <div
                      key={installment.id}
                      className={cn(
                        "flex items-center justify-between rounded-xl px-3 py-2.5",
                        isPaid ? "bg-muted/50" : "clay-pressed",
                      )}
                    >
                      <div className="flex flex-col gap-0.5">
                        <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                          Installment #{installment.sequenceNumber}
                          {isPaid && <ClayBadge tone="success">Paid</ClayBadge>}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {installment.dueDate.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
                          {installment.principalPortion != null && (
                            <>
                              {" · "}
                              Principal {installment.principalPortion.toLocaleString("en-IN")} / Interest{" "}
                              {(installment.interestPortion ?? 0).toLocaleString("en-IN")}
                            </>
                          )}
                        </span>
                      </div>
                      <div className="flex flex-col items-end gap-0.5">
                        <CurrencyCell amount={installment.amountDue} signed={false} className="text-sm font-semibold" />
                        <span className="text-xs text-muted-foreground">
                          Paid {installment.amountPaid.toLocaleString("en-IN")}
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
        title="Add a Loan"
        description="Track a bank or institutional loan and its repayment schedule."
        onConfirm={() => handleSave(false)}
        confirmLabel={saving ? "Saving…" : "Add Loan"}
        loading={saving}
      >
        <LoanFormFields form={form} setForm={setForm} isEdit={false} />
      </SectionedFormDialog>

      <SectionedFormDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        title={`Edit ${activeRow?.loan.name ?? "Loan"}`}
        onConfirm={() => handleSave(true)}
        confirmLabel={saving ? "Saving…" : "Save Changes"}
        loading={saving}
      >
        <LoanFormFields form={form} setForm={setForm} isEdit />
      </SectionedFormDialog>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete ${activeRow?.loan.name ?? "loan"}?`}
        description="This action cannot be undone."
        variant="destructive"
        confirmLabel="Delete"
        onConfirm={handleDelete}
      />
    </div>
  );
}

const INTEREST_TYPE_OPTIONS: { value: InterestType; label: string }[] = [
  { value: "reducingBalance", label: "Reducing Balance" },
  { value: "flat", label: "Flat" },
];

const FREQUENCY_OPTIONS: { value: ScheduleType; label: string }[] = [
  { value: "monthly", label: "Monthly" },
  { value: "weekly", label: "Weekly" },
];

function LoanFormFields({
  form,
  setForm,
  isEdit,
}: {
  form: LoanFormState;
  setForm: React.Dispatch<React.SetStateAction<LoanFormState>>;
  isEdit: boolean;
}) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <SectionLabel>Loan Details</SectionLabel>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Loan Name</span>
          <input
            className={FLAT_INPUT}
            placeholder="e.g. Home Loan"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Lender</span>
          <input
            className={FLAT_INPUT}
            placeholder="e.g. HDFC Bank"
            value={form.lenderName}
            onChange={(e) => setForm((f) => ({ ...f, lenderName: e.target.value }))}
          />
        </label>
      </div>

      {!isEdit && (
        <>
          <div className="flex flex-col gap-3 border-t border-border pt-5">
            <SectionLabel>Principal & Interest</SectionLabel>
            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">Principal</span>
                <div className="relative">
                  <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-muted-foreground">₹</span>
                  <input
                    type="number"
                    className={cn(FLAT_INPUT, "pl-7")}
                    placeholder="0.00"
                    value={form.principal}
                    onChange={(e) => setForm((f) => ({ ...f, principal: e.target.value }))}
                  />
                </div>
              </label>
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
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">Interest Type</span>
              <ChipRow
                options={INTEREST_TYPE_OPTIONS}
                value={form.interestType}
                onChange={(v) => setForm((f) => ({ ...f, interestType: v }))}
              />
            </div>
          </div>

          <div className="flex flex-col gap-3 border-t border-border pt-5">
            <SectionLabel>Repayment Schedule</SectionLabel>
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">Frequency</span>
              <ChipRow
                options={FREQUENCY_OPTIONS}
                value={form.installmentFrequency}
                onChange={(v) => setForm((f) => ({ ...f, installmentFrequency: v }))}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground"># Installments</span>
                <input
                  type="number"
                  className={FLAT_INPUT}
                  value={form.installmentCount}
                  onChange={(e) => setForm((f) => ({ ...f, installmentCount: e.target.value }))}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">Loan Date</span>
                <input
                  type="date"
                  className={FLAT_INPUT}
                  value={form.loanDate}
                  onChange={(e) => setForm((f) => ({ ...f, loanDate: e.target.value }))}
                />
              </label>
            </div>
          </div>
        </>
      )}

      <label className="flex flex-col gap-1 border-t border-border pt-5">
        <span className="text-xs font-medium text-muted-foreground">Notes</span>
        <input
          className={FLAT_INPUT}
          placeholder="Optional notes"
          value={form.notes}
          onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
        />
      </label>
    </div>
  );
}
