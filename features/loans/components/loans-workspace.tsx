"use client";

import { Building2, CalendarClock, FileText, Landmark, Percent, Plus, Search, StickyNote, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { ClayBadge } from "@/components/clay/clay-badge";
import { ClayButton } from "@/components/clay/clay-button";
import { Stagger } from "@/components/foundation/animated-container";
import {
  ChipRow,
  EmptyState,
  FLAT_INPUT,
  SectionedFormDialog,
  SectionLabel,
  SmartToolbar,
} from "@/components/finance";
import { Skeleton } from "@/components/ui/skeleton";
import type { InterestType } from "@/lib/engines/interest-calculator";
import type { Loan, LoanCategory, LoanDirection } from "@/lib/models/loan";
import type { Installment, ScheduleType } from "@/lib/models/payment-schedule";
import { LoanCard } from "@/features/loans/components/loan-card";
import { LoanLumpSumDialog } from "@/features/loans/components/loan-lump-sum-dialog";
import { LoanScheduleDialog } from "@/features/loans/components/loan-schedule-dialog";
import { LoansSummary } from "@/features/loans/components/loans-summary";
import { LoansTrashDialog } from "@/features/loans/components/loans-trash-dialog";
import { RecordLoanPaymentDialog } from "@/features/loans/components/record-loan-payment-dialog";
import { useLoanActions, useLoanRows, useTrashedLoanRows, type LoanRow } from "@/features/loans/hooks/use-loans-data";
import { useLoanPersons } from "@/hooks/use-loans";
import type { Person } from "@/lib/models/person";
import { cn } from "@/lib/utils";
import { toast } from "@/store/toast-store";

type StatusFilter = "all" | "active" | "overdue" | "closed";
type DirectionFilter = "all" | LoanDirection;
type CategoryFilter = "all" | LoanCategory;

const STATUS_FILTER_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "overdue", label: "Missed Payment" },
  { value: "closed", label: "Closed" },
];

const DIRECTION_FILTER_OPTIONS: { value: DirectionFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "given", label: "I Gave" },
  { value: "taken", label: "I Borrowed" },
];

const CATEGORY_FILTER_OPTIONS: { value: CategoryFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "personal", label: "Personal" },
  { value: "institutional", label: "Institution" },
];

interface LoanFormState {
  name: string;
  category: LoanCategory;
  /** The chosen Person's id, when `category` is "personal". */
  personId: string;
  lenderName: string;
  direction: LoanDirection;
  principal: string;
  ratePercent: string;
  interestType: InterestType;
  installmentFrequency: ScheduleType;
  installmentCount: string;
  loanDate: string;
  notes: string;
  loanType: string;
  loanNumber: string;
  accountNumber: string;
  branch: string;
  /** Empty string means "I pay it myself" — see `Loan.payerPersonId`. */
  payerPersonId: string;
}

function emptyForm(): LoanFormState {
  return {
    name: "",
    category: "institutional",
    personId: "",
    lenderName: "",
    direction: "taken",
    principal: "",
    ratePercent: "",
    interestType: "reducingBalance",
    installmentFrequency: "monthly",
    installmentCount: "12",
    loanDate: new Date().toISOString().slice(0, 10),
    notes: "",
    loanType: "",
    loanNumber: "",
    accountNumber: "",
    branch: "",
    payerPersonId: "",
  };
}

function formFromRow(row: LoanRow): LoanFormState {
  return {
    name: row.loan.name ?? "",
    category: row.category,
    personId: row.loan.personId ?? "",
    lenderName: row.lenderName,
    direction: row.direction,
    principal: String(row.loan.loanAmount),
    ratePercent: String(row.loan.interest?.ratePercent ?? ""),
    interestType: row.loan.interest?.type ?? "reducingBalance",
    installmentFrequency: row.loan.installmentFrequency ?? "monthly",
    installmentCount: String(row.loan.installmentCount ?? row.totalInstallments),
    loanDate: row.loan.loanDate.toISOString().slice(0, 10),
    notes: row.loan.notes,
    loanType: row.loan.loanType ?? "",
    loanNumber: row.loan.loanNumber ?? "",
    accountNumber: row.loan.accountNumber ?? "",
    branch: row.loan.branch ?? "",
    payerPersonId: row.payerPersonId ?? "",
  };
}

export function LoansWorkspace() {
  const { rows, isLoading } = useLoanRows();
  const { rows: trashedRows } = useTrashedLoanRows();
  const actions = useLoanActions();
  const { data: people = [] } = useLoanPersons();

  const [activeRow, setActiveRow] = useState<LoanRow | null>(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [paymentTarget, setPaymentTarget] = useState<{ row: LoanRow; installment: Installment } | null>(null);
  const [lumpSumRow, setLumpSumRow] = useState<LoanRow | null>(null);
  const [form, setForm] = useState<LoanFormState>(emptyForm);
  const [saving, setSaving] = useState(false);

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [directionFilter, setDirectionFilter] = useState<DirectionFilter>("all");
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>("all");

  const visibleRows = useMemo(() => {
    const query = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (statusFilter !== "all" && row.status !== statusFilter) return false;
      if (directionFilter !== "all" && row.direction !== directionFilter) return false;
      if (categoryFilter !== "all" && row.category !== categoryFilter) return false;
      if (query.length === 0) return true;
      return (
        (row.loan.name ?? "").toLowerCase().includes(query) ||
        row.lenderName.toLowerCase().includes(query) ||
        (row.loan.loanNumber ?? "").toLowerCase().includes(query)
      );
    });
  }, [rows, search, statusFilter, directionFilter, categoryFilter]);

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
          loanType: form.loanType || null,
          loanNumber: form.loanNumber || null,
          accountNumber: form.accountNumber || null,
          branch: form.branch || null,
          payerPersonId: form.payerPersonId || null,
        });

        // Loan amount/interest/frequency/tenure live outside `editLoan` — changing any of them
        // re-amortizes the outstanding balance over the unpaid installments
        // (`LoanRepository.editLoanTerms`), so this only fires when one actually changed, not on every
        // save.
        const rate = form.ratePercent.trim() === "" ? null : Number(form.ratePercent);
        const newInterest =
          rate != null && Number.isFinite(rate) && rate >= 0 ? { type: form.interestType, ratePercent: rate, period: "yearly" as const } : null;
        const newInstallmentCount = Number(form.installmentCount) || activeRow.totalInstallments;
        const newLoanAmount = Number(form.principal);
        const originalInterest = activeRow.loan.interest;
        const termsChanged =
          (Number.isFinite(newLoanAmount) && newLoanAmount !== activeRow.loan.loanAmount) ||
          (newInterest?.ratePercent ?? null) !== (originalInterest?.ratePercent ?? null) ||
          (newInterest?.type ?? null) !== (originalInterest?.type ?? null) ||
          form.installmentFrequency !== (activeRow.loan.installmentFrequency ?? "monthly") ||
          newInstallmentCount !== activeRow.totalInstallments;

        let loanForDateEdit = activeRow.loan;
        if (termsChanged) {
          await actions.editLoanTerms(activeRow.loan, {
            currentInstallments: activeRow.installments,
            loanAmount: Number.isFinite(newLoanAmount) && newLoanAmount > 0 ? newLoanAmount : undefined,
            interest: newInterest,
            installmentFrequency: form.installmentFrequency,
            newInstallmentCount,
          });
          loanForDateEdit = {
            ...activeRow.loan,
            loanAmount: Number.isFinite(newLoanAmount) && newLoanAmount > 0 ? newLoanAmount : activeRow.loan.loanAmount,
            interest: newInterest,
            installmentFrequency: form.installmentFrequency,
            installmentCount: newInstallmentCount,
          };
        }

        // Loan Date only moves before any payment exists — mirrors `LoanRepository.editLoanDate`'s own
        // guard. Runs against `loanForDateEdit` so it re-amortizes with whatever terms were just saved
        // above, not the stale pre-edit interest/frequency/count.
        const hasPayments = activeRow.installments.some((i) => i.amountPaid > 0);
        const originalLoanDate = activeRow.loan.loanDate.toISOString().slice(0, 10);
        if (!hasPayments && form.loanDate !== originalLoanDate) {
          await actions.editLoanDate(loanForDateEdit, {
            newLoanDate: new Date(form.loanDate),
            hasPayments: false,
            currentInstallments: activeRow.installments,
          });
        }

        setEditOpen(false);
      } else {
        const ratePercent = Number(form.ratePercent);
        await actions.createLoan({
          name: form.name,
          category: form.category,
          personId: form.category === "personal" ? form.personId || null : null,
          lenderName: form.lenderName,
          direction: form.direction,
          loanAmount: Number(form.principal),
          loanDate: new Date(form.loanDate),
          interest: Number.isFinite(ratePercent) && ratePercent >= 0
            ? { type: form.interestType, ratePercent, period: "yearly" }
            : null,
          installmentFrequency: form.installmentFrequency,
          installmentCount: Number(form.installmentCount) || 1,
          notes: form.notes,
          loanType: form.loanType || null,
          loanNumber: form.loanNumber || null,
          accountNumber: form.accountNumber || null,
          branch: form.branch || null,
          payerPersonId: form.payerPersonId || null,
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

  // Soft-deletes to trash — reversible (mirrors `loans_screen.dart`'s swipe-to-delete), so this skips a
  // blocking confirm dialog and offers Undo on the toast instead, same UX as Flutter's snackbar.
  async function handleDelete(row: LoanRow) {
    if (!actions) return;
    try {
      await actions.deleteLoan(row.loan);
      setActiveRow(null);
      toast.success("Loan moved to trash", undefined, {
        label: "Undo",
        onClick: () => actions.restoreLoan(row.loan).catch(() => toast.error("Couldn't restore loan")),
      });
    } catch (e) {
      toast.error("Couldn't delete loan", e instanceof Error ? e.message : "Please try again.");
    }
  }

  async function handleToggleClose(row: LoanRow) {
    if (!actions) return;
    try {
      if (row.status === "closed") {
        await actions.reopenLoan(row.loan);
      } else {
        await actions.closeLoan(row.loan);
      }
    } catch (e) {
      toast.error("Couldn't update loan", e instanceof Error ? e.message : "Please try again.");
    }
  }

  async function handleRestoreLoan(loan: Loan) {
    if (!actions) return;
    await actions.restoreLoan(loan);
  }

  async function handlePermanentlyDeleteLoan(loan: Loan) {
    if (!actions) return;
    await actions.permanentlyDeleteLoan(loan);
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
          <div className="flex items-center gap-2">
            <ClayButton variant="secondary" size="sm" className="gap-1.5" onClick={() => setTrashOpen(true)}>
              <Trash2 className="size-3.5" />
              Trash{trashedRows.length > 0 ? ` (${trashedRows.length})` : ""}
            </ClayButton>
            <ClayButton size="sm" onClick={openAdd} className="gap-1.5">
              <Plus className="size-3.5" />
              Add Loan
            </ClayButton>
          </div>
        }
      />

      <LoansSummary rows={rows} />

      {rows.length === 0 ? (
        <EmptyState
          icon={Landmark}
          title="No loans yet"
          description="Add a loan you've borrowed or lent to start tracking its repayment schedule."
          actionLabel="Add Loan"
          onAction={openAdd}
        />
      ) : (
        <>
          <div className="flex flex-col gap-3">
            <div className="relative max-w-sm">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <input
                className={cn(FLAT_INPUT, "pl-9")}
                placeholder="Search loans…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <ChipRow options={CATEGORY_FILTER_OPTIONS} value={categoryFilter} onChange={setCategoryFilter} />
              <ChipRow options={DIRECTION_FILTER_OPTIONS} value={directionFilter} onChange={setDirectionFilter} />
              <ChipRow options={STATUS_FILTER_OPTIONS} value={statusFilter} onChange={setStatusFilter} />
            </div>
          </div>

          {visibleRows.length === 0 ? (
            <EmptyState icon={Search} title="No matching loans" description="Try a different search or filter." />
          ) : (
            <Stagger className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {visibleRows.map((row) => (
                <LoanCard
                  key={row.loan.id}
                  row={row}
                  onClick={() => {
                    setActiveRow(row);
                    setScheduleOpen(true);
                  }}
                />
              ))}
            </Stagger>
          )}
        </>
      )}

      <LoanScheduleDialog
        open={scheduleOpen}
        onOpenChange={(open) => {
          setScheduleOpen(open);
          if (!open) setActiveRow(null);
        }}
        row={activeRow}
        onEdit={(row) => {
          setScheduleOpen(false);
          openEdit(row);
        }}
        onDelete={(row) => {
          setScheduleOpen(false);
          handleDelete(row);
        }}
        onRecordPayment={(row, installment) => setPaymentTarget({ row, installment })}
        onSettleLumpSum={(row) => setLumpSumRow(row)}
        onToggleClose={handleToggleClose}
      />

      <RecordLoanPaymentDialog
        key={paymentTarget?.installment.id ?? "payment-closed"}
        open={paymentTarget != null}
        onOpenChange={(open) => !open && setPaymentTarget(null)}
        loan={paymentTarget?.row.loan ?? null}
        installment={paymentTarget?.installment ?? null}
        onRecord={async (loan, installment, params) => {
          if (!actions) return;
          await actions.recordPayment(loan, installment, params);
          toast.success("Payment recorded");
        }}
      />

      <LoanLumpSumDialog
        key={lumpSumRow?.loan.id ?? "lumpsum-closed"}
        open={lumpSumRow != null}
        onOpenChange={(open) => !open && setLumpSumRow(null)}
        row={lumpSumRow}
        onSettle={async (loan, installments, params) => {
          if (!actions) throw new Error("Not signed in");
          return actions.recordLumpSumSettlement(loan, installments, params);
        }}
      />

      <LoansTrashDialog
        open={trashOpen}
        onOpenChange={setTrashOpen}
        rows={trashedRows}
        onRestore={handleRestoreLoan}
        onPermanentlyDelete={handlePermanentlyDeleteLoan}
      />

      <SectionedFormDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        title="Add a Loan"
        description="Track money you've borrowed or lent, and its repayment schedule."
        onConfirm={() => handleSave(false)}
        confirmLabel={saving ? "Saving…" : "Add Loan"}
        loading={saving}
        contentClassName="sm:max-w-2xl"
      >
        <LoanFormFields form={form} setForm={setForm} isEdit={false} people={people} />
      </SectionedFormDialog>

      <SectionedFormDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        title={`Edit ${activeRow?.loan.name ?? "Loan"}`}
        onConfirm={() => handleSave(true)}
        confirmLabel={saving ? "Saving…" : "Save Changes"}
        loading={saving}
        contentClassName="sm:max-w-2xl"
      >
        <LoanFormFields
          form={form}
          setForm={setForm}
          isEdit
          people={people}
          hasPayments={activeRow ? activeRow.installments.some((i) => i.amountPaid > 0) : false}
          minInstallmentCount={activeRow ? activeRow.installments.filter((i) => i.amountPaid > 0 || i.isSkipped).length : 0}
          minLoanAmount={activeRow ? activeRow.loan.loanAmount - activeRow.outstandingPrincipal : 0}
        />
      </SectionedFormDialog>
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

const DIRECTION_OPTIONS: { value: LoanDirection; label: string }[] = [
  { value: "taken", label: "Money I Borrowed" },
  { value: "given", label: "Money I Lent" },
];

const CATEGORY_OPTIONS: { value: LoanCategory; label: string }[] = [
  { value: "personal", label: "Personal" },
  { value: "institutional", label: "Bank / Institution" },
];

function LoanFormFields({
  form,
  setForm,
  isEdit,
  people,
  hasPayments = false,
  minInstallmentCount = 1,
  minLoanAmount = 0,
}: {
  form: LoanFormState;
  setForm: React.Dispatch<React.SetStateAction<LoanFormState>>;
  isEdit: boolean;
  people: Person[];
  /** Edit mode only — whether any installment already carries a payment. Locks the Loan Date once true
   *  (mirrors `LoanRepository.editLoanDate`'s own guard). */
  hasPayments?: boolean;
  /** Edit mode only — the floor for # Installments (already-settled installments can't be un-settled). */
  minInstallmentCount?: number;
  /** Edit mode only — the floor for Loan Amount (can't drop below principal already paid off). */
  minLoanAmount?: number;
}) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 bg-muted/30 p-4">
        <SectionLabel icon={FileText}>Loan Details</SectionLabel>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Loan Name (optional)</span>
          <input
            className={FLAT_INPUT}
            placeholder="e.g. Home Loan"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          />
        </label>
        {!isEdit ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">Personal loan, or from a bank?</span>
              <ChipRow
                options={CATEGORY_OPTIONS}
                value={form.category}
                onChange={(v) => setForm((f) => ({ ...f, category: v }))}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">Which is it?</span>
              <ChipRow
                options={DIRECTION_OPTIONS}
                value={form.direction}
                onChange={(v) => setForm((f) => ({ ...f, direction: v }))}
              />
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <ClayBadge tone="neutral">
              {CATEGORY_OPTIONS.find((o) => o.value === form.category)?.label}
            </ClayBadge>
            <ClayBadge tone={form.direction === "given" ? "success" : "neutral"}>
              {DIRECTION_OPTIONS.find((o) => o.value === form.direction)?.label}
            </ClayBadge>
          </div>
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {form.category === "personal" ? (
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">
                {form.direction === "given" ? "Who did you lend it to?" : "Who did you borrow it from?"}
              </span>
              <select
                className={FLAT_INPUT}
                value={form.personId}
                disabled={isEdit}
                onChange={(e) => setForm((f) => ({ ...f, personId: e.target.value }))}
              >
                <option value="" disabled>
                  Choose a person
                </option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              {isEdit && <span className="text-xs text-muted-foreground">Person can&apos;t be changed after the loan is created.</span>}
            </label>
          ) : (
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">
                {form.direction === "given" ? "Who did you lend it to?" : "Who did you borrow it from?"}
              </span>
              <input
                className={FLAT_INPUT}
                placeholder={form.direction === "given" ? "e.g. Rahul" : "e.g. HDFC Bank"}
                value={form.lenderName}
                onChange={(e) => setForm((f) => ({ ...f, lenderName: e.target.value }))}
              />
            </label>
          )}
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Who actually pays the EMIs? (optional)</span>
            <select
              className={FLAT_INPUT}
              value={form.payerPersonId}
              onChange={(e) => setForm((f) => ({ ...f, payerPersonId: e.target.value }))}
            >
              <option value="">I pay it myself</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <span className="text-xs text-muted-foreground">Only if a friend or family member pays it for you.</span>
          </label>
        </div>
      </div>

      {form.category === "institutional" && (
        <div className="flex flex-col gap-3 bg-muted/30 p-4">
          <SectionLabel icon={Building2}>Bank Details (optional)</SectionLabel>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Type of Loan</span>
              <input
                className={FLAT_INPUT}
                placeholder="e.g. Personal, Vehicle, Education"
                value={form.loanType}
                onChange={(e) => setForm((f) => ({ ...f, loanType: e.target.value }))}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Loan Account Number</span>
              <input
                className={FLAT_INPUT}
                value={form.loanNumber}
                onChange={(e) => setForm((f) => ({ ...f, loanNumber: e.target.value }))}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Bank Account Number</span>
              <input
                className={FLAT_INPUT}
                value={form.accountNumber}
                onChange={(e) => setForm((f) => ({ ...f, accountNumber: e.target.value }))}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Branch</span>
              <input
                className={FLAT_INPUT}
                value={form.branch}
                onChange={(e) => setForm((f) => ({ ...f, branch: e.target.value }))}
              />
            </label>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-3 bg-muted/30 p-4">
        <SectionLabel icon={Percent}>Loan Amount &amp; Interest</SectionLabel>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Loan Amount</span>
            <div className="relative">
              <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm font-semibold text-primary">₹</span>
              <input
                type="number"
                min={isEdit ? minLoanAmount || undefined : undefined}
                className={cn(FLAT_INPUT, "border-primary/30 bg-primary/5 pl-7 text-base font-semibold focus:border-primary")}
                placeholder="0.00"
                value={form.principal}
                onChange={(e) => setForm((f) => ({ ...f, principal: e.target.value }))}
              />
            </div>
            {isEdit && (
              <span className="text-xs text-muted-foreground">
                Re-amortizes the remaining balance{minLoanAmount > 0 ? ` — can't go below ₹${minLoanAmount.toLocaleString("en-IN")} already paid off` : ""}.
              </span>
            )}
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Interest Rate (% per year)</span>
            <input
              type="number"
              className={FLAT_INPUT}
              placeholder="e.g. 8.65"
              value={form.ratePercent}
              onChange={(e) => setForm((f) => ({ ...f, ratePercent: e.target.value }))}
            />
            {isEdit && <span className="text-xs text-muted-foreground">Re-amortizes the remaining balance over the unpaid installments.</span>}
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

      <div className="flex flex-col gap-3 bg-muted/30 p-4">
        <SectionLabel icon={CalendarClock}>Repayment Schedule</SectionLabel>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">Frequency</span>
          <ChipRow
            options={FREQUENCY_OPTIONS}
            value={form.installmentFrequency}
            onChange={(v) => setForm((f) => ({ ...f, installmentFrequency: v }))}
          />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground"># Installments (Tenure)</span>
            <input
              type="number"
              min={isEdit ? minInstallmentCount || 1 : 1}
              className={FLAT_INPUT}
              value={form.installmentCount}
              onChange={(e) => setForm((f) => ({ ...f, installmentCount: e.target.value }))}
            />
            {isEdit && minInstallmentCount > 0 && (
              <span className="text-xs text-muted-foreground">Can&apos;t go below {minInstallmentCount} — installments already settled.</span>
            )}
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Loan Date</span>
            <input
              type="date"
              disabled={isEdit && hasPayments}
              className={cn(FLAT_INPUT, isEdit && hasPayments && "text-muted-foreground opacity-70")}
              value={form.loanDate}
              onChange={(e) => setForm((f) => ({ ...f, loanDate: e.target.value }))}
            />
            {isEdit && (
              <span className="text-xs text-muted-foreground">
                {hasPayments ? "Can't be changed once a payment has been recorded." : "Regenerates the full schedule from this date."}
              </span>
            )}
          </label>
        </div>
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
    </div>
  );
}
