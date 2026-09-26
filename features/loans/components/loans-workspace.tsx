"use client";

import { ArrowUpRight, Building2, Landmark, Search, Trash2 } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { ClayBadge } from "@/components/clay/clay-badge";
import { ClayButton } from "@/components/clay/clay-button";
import { Stagger } from "@/components/foundation/animated-container";
import {
  ChipRow,
  EmptyState,
  FLAT_INPUT,
  SectionedFormDialog,
  SectionLabel,
} from "@/components/finance";
import { Skeleton } from "@/components/ui/skeleton";
import type { InterestType } from "@/lib/engines/interest-calculator";
import type { Loan, LoanCategory, LoanDirection } from "@/lib/models/loan";
import type { Installment, ScheduleType } from "@/lib/models/payment-schedule";
import { LoanCard, loanDisplayName } from "@/features/loans/components/loan-card";
import { AmountInput, Field, FieldGroup, MoreOptions, RevealToggle } from "@/features/loans/components/loan-emi-ui";
import { LoanLumpSumDialog } from "@/features/loans/components/loan-lump-sum-dialog";
import { LoanScheduleDialog } from "@/features/loans/components/loan-schedule-dialog";
import { LoansTrashDialog } from "@/features/loans/components/loans-trash-dialog";
import { RecordLoanPaymentDialog } from "@/features/loans/components/record-loan-payment-dialog";
import { LoanAdjustmentDialog } from "@/features/loans/components/loan-adjustment-dialog";
import { ReverseOriginationDialog } from "@/features/loans/components/reverse-origination-dialog";
import {
  WhoIsThisForField,
  beneficiaryFromChoice,
  ownershipError,
  type OwnershipChoice,
} from "@/features/loans/components/who-is-this-for-field";
import { loanOriginationUi } from "@/features/loans/lib/loan-origination-ui";
import { originationIdsFor, originationKeyFromLoanId } from "@/lib/engines/loan-origination";
import { useTransactions } from "@/hooks/use-transactions";
import { useLoanActions, useLoanRows, useTrashedLoanRows, type LoanRow } from "@/features/loans/hooks/use-loans-data";
import { useLoanPersons } from "@/hooks/use-loans";
import { useAccounts } from "@/hooks/use-accounts";
import type { Person } from "@/lib/models/person";
import type { Account } from "@/lib/models/account";
import { friendlyLoanError } from "@/features/loans/lib/loan-live-state";
import { cn } from "@/lib/utils";
import { toast } from "@/store/toast-store";

type StatusFilter = "all" | "active" | "overdue" | "closed";
type DirectionFilter = "all" | LoanDirection;
type CategoryFilter = "all" | LoanCategory;

const STATUS_FILTER_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "overdue", label: "Missed payment" },
  { value: "closed", label: "Closed" },
];

const DIRECTION_FILTER_OPTIONS: { value: DirectionFilter; label: string }[] = [
  { value: "all", label: "Borrowed & lent" },
  { value: "taken", label: "I borrowed" },
  { value: "given", label: "I lent" },
];

const CATEGORY_FILTER_OPTIONS: { value: CategoryFilter; label: string }[] = [
  { value: "all", label: "Banks & people" },
  { value: "institutional", label: "From banks" },
  { value: "personal", label: "From people" },
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
  /** "Who is this for?" — borrowed loans only. See `Loan.beneficiaryPersonId`. */
  ownership: OwnershipChoice;
  beneficiaryPersonId: string;
  /** Create-only: whether the principal really moved through one of the user's Accounts. */
  recordMovement: boolean;
  movementAccountId: string;
  /** Create-only: one per Add action, so a retried save can't post the movement twice. */
  idempotencyKey: string;
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
    ownership: "me",
    beneficiaryPersonId: "",
    recordMovement: false,
    movementAccountId: "",
    idempotencyKey: crypto.randomUUID(),
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
    ownership: row.beneficiaryPersonId ? "someoneElse" : "me",
    beneficiaryPersonId: row.beneficiaryPersonId ?? "",
    recordMovement: false,
    movementAccountId: "",
    idempotencyKey: "",
  };
}

export interface LoansWorkspaceProps {
  /** Incremented by the unified Loan & EMI chooser to open the Add Loan form. */
  addSignal?: number;
}

export function LoansWorkspace({ addSignal = 0 }: LoansWorkspaceProps = {}) {
  const searchParams = useSearchParams();
  const createHandoff = searchParams.get("create");
  const queryClient = useQueryClient();
  const { rows, isLoading } = useLoanRows();
  const { rows: trashedRows } = useTrashedLoanRows();
  const actions = useLoanActions();
  const { data: accounts = [] } = useAccounts();
  const { data: people = [] } = useLoanPersons();
  const { data: transactions = [] } = useTransactions();
  const originationUiFor = (loanId: string) =>
    loanOriginationUi(loanId, transactions, (accountId) => accounts.find((a) => a.id === accountId)?.name);
  /** The Account a wizard-created loan's money moved through, for the details view's Linked section. */
  const originationAccountName = (loanId: string): string | null => {
    const key = originationKeyFromLoanId(loanId);
    if (key == null) return null;
    const transactionId = originationIdsFor(key).transactionId;
    const origination = transactions.find((t) => t.id === transactionId && t.deletedAt == null);
    return origination ? (accounts.find((a) => a.id === origination.accountId)?.name ?? null) : null;
  };
  const [reverseTarget, setReverseTarget] = useState<{ loan: Loan; key: string; message: string } | null>(null);
  const [reversing, setReversing] = useState(false);

  const [activeRowId, setActiveRowId] = useState<string | null>(() => searchParams.get("agreement"));
  // Resolved live against `rows` on every render, instead of holding a snapshot of the row — `rows`
  // comes from a live Firestore subscription (see `hooks/use-loans.ts`), so re-deriving it here is what
  // makes edits/payments to the open loan show up in the schedule dialog without a manual refresh.
  const activeRow = useMemo(() => rows.find((r) => r.loan.id === activeRowId) ?? null, [rows, activeRowId]);
  const [scheduleOpen, setScheduleOpen] = useState(() => searchParams.has("agreement"));
  const [addOpen, setAddOpen] = useState(() => createHandoff === "borrowed" || createHandoff === "lent");
  const [editOpen, setEditOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [paymentTarget, setPaymentTarget] = useState<{ row: LoanRow; installment: Installment } | null>(null);
  const [lumpSumRow, setLumpSumRow] = useState<LoanRow | null>(null);
  const [adjustment, setAdjustment] = useState<{ row: LoanRow; kind: "prepayment" | "disbursement" } | null>(null);
  const [form, setForm] = useState<LoanFormState>(() => ({
    ...emptyForm(),
    direction: createHandoff === "lent" ? "given" : "taken",
  }));
  const [saving, setSaving] = useState(false);
  const [statusBusy, setStatusBusy] = useState(false);

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
    setActiveRowId(null);
    setForm(emptyForm());
    setAddOpen(true);
  }

  const [seenAddSignal, setSeenAddSignal] = useState(addSignal);
  if (addSignal !== seenAddSignal) {
    setSeenAddSignal(addSignal);
    openAdd();
  }

  function openEdit(row: LoanRow) {
    setActiveRowId(row.loan.id);
    setForm(formFromRow(row));
    setEditOpen(true);
  }

  async function handleSave(isEdit: boolean) {
    if (!actions) return;
    const forError = form.direction === "taken" ? ownershipError(form.ownership, form.beneficiaryPersonId) : null;
    if (forError) {
      toast.error(forError, "Pick the person this loan is for, or switch to For me.");
      return;
    }
    // "Who is this for?" only applies to money borrowed; a lent loan's person is its borrower.
    const beneficiaryPersonId = form.direction === "taken" ? beneficiaryFromChoice(form.ownership, form.beneficiaryPersonId) : null;
    setSaving(true);
    try {
      if (isEdit && activeRow) {
        // Each repository edit is a whole-document write, so every step below must start from the
        // Loan the previous step actually wrote. Passing the render-time `activeRow.loan` to a later
        // step silently reverted the earlier one (e.g. renaming a loan while also changing its rate
        // saved the new rate but put the old name back).
        let current = await actions.editLoan(activeRow.loan, {
          name: form.name,
          lenderName: form.lenderName,
          notes: form.notes,
          currentInstallments: activeRow.installments,
          loanType: form.loanType || null,
          loanNumber: form.loanNumber || null,
          accountNumber: form.accountNumber || null,
          branch: form.branch || null,
          payerPersonId: form.payerPersonId || null,
          beneficiaryPersonId,
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

        if (termsChanged) {
          current = await actions.editLoanTerms(current, {
            currentInstallments: activeRow.installments,
            loanAmount: Number.isFinite(newLoanAmount) && newLoanAmount > 0 ? newLoanAmount : undefined,
            interest: newInterest,
            installmentFrequency: form.installmentFrequency,
            newInstallmentCount,
          });
        }

        // Loan Date only moves before any payment exists — mirrors `LoanRepository.editLoanDate`'s own
        // guard. Runs against `current` so it re-amortizes with whatever terms were just saved above.
        const hasPayments = activeRow.installments.some((i) => i.amountPaid > 0);
        const originalLoanDate = activeRow.loan.loanDate.toISOString().slice(0, 10);
        if (!hasPayments && form.loanDate !== originalLoanDate) {
          await actions.editLoanDate(current, {
            newLoanDate: new Date(form.loanDate),
            hasPayments: false,
            currentInstallments: activeRow.installments,
          });
        }

        toast.success("Loan updated");
        setEditOpen(false);
        // Back to the same loan's detail view, which re-renders from the live listener — no need to
        // close and reopen it to see the saved values.
        setScheduleOpen(true);
        return;
      } else {
        if (form.recordMovement && !form.movementAccountId) {
          toast.error("Choose an account", "Pick the account the money moved through, or turn the option off.");
          return;
        }
        const ratePercent = Number(form.ratePercent);
        await actions.createLoan({
          movementAccountId: form.recordMovement ? form.movementAccountId : null,
          idempotencyKey: form.idempotencyKey,
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
          beneficiaryPersonId,
        });
        setAddOpen(false);
      }
      setActiveRowId(null);
    } catch (e) {
      toast.error(isEdit ? "Couldn't save changes" : "Couldn't add loan", friendlyLoanError(e));
    } finally {
      setSaving(false);
    }
  }

  // Soft-deletes to trash — reversible (mirrors `loans_screen.dart`'s swipe-to-delete), so this skips a
  // blocking confirm dialog and offers Undo on the toast instead, same UX as Flutter's snackbar.
  async function handleDelete(row: LoanRow) {
    if (!actions) return;
    // A unified-wizard Loan whose origination money is still active is never trashed on its own (its
    // cash would stay while the debt left Net Worth) — it goes through "Reverse & Delete".
    const origination = originationUiFor(row.loan.id);
    if (origination.moneyActive) {
      setReverseTarget({ loan: row.loan, key: origination.idempotencyKey!, message: origination.message });
      return;
    }
    try {
      await actions.deleteLoan(row.loan);
      setActiveRowId(null);
      toast.success("Loan moved to trash", undefined, {
        label: "Undo",
        onClick: () => actions.restoreLoan(row.loan).catch(() => toast.error("Couldn't restore loan")),
      });
    } catch (e) {
      toast.error("Couldn't delete loan", friendlyLoanError(e));
    }
  }

  async function handleToggleClose(row: LoanRow) {
    if (!actions || statusBusy) return;
    setStatusBusy(true);
    try {
      // No local status override: the write's own snapshot (Firestore fires it immediately for local
      // writes) flows through `rows` → `activeRow`, so the open dialog, card and Status filter all
      // flip together from the persisted value.
      if (row.status === "closed") {
        await actions.reopenLoan(row.loan);
        toast.success("Loan reopened");
      } else {
        await actions.closeLoan(row.loan);
        toast.success("Loan closed");
      }
    } catch (e) {
      toast.error("Couldn't update loan", friendlyLoanError(e));
    } finally {
      setStatusBusy(false);
    }
  }

  async function handleRestoreLoan(loan: Loan) {
    if (!actions) return;
    await actions.restoreLoan(loan);
  }

  async function handlePermanentlyDeleteLoan(loan: Loan) {
    if (!actions) return;
    // A Loan trashed (e.g. by an older app) while its origination money was still active must be
    // reversed, never hard-deleted out from under its Transaction.
    const origination = originationUiFor(loan.id);
    if (origination.moneyActive) {
      setTrashOpen(false);
      setReverseTarget({ loan, key: origination.idempotencyKey!, message: origination.message });
      return;
    }
    await actions.permanentlyDeleteLoan(loan);
  }

  async function handleReverseOrigination() {
    if (!actions || !reverseTarget || reversing) return;
    setReversing(true);
    try {
      await actions.reverseAgreementOrigination(reverseTarget.key);
      setActiveRowId(null);
      setReverseTarget(null);
      toast.success("Loan creation reversed");
    } catch (e) {
      toast.error("Couldn't reverse loan creation", friendlyLoanError(e));
    } finally {
      setReversing(false);
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

  const hasLent = rows.some((r) => r.direction === "given");
  const hasBothCategories = rows.some((r) => r.category === "personal") && rows.some((r) => r.category === "institutional");
  const filtersActive = search !== "" || statusFilter !== "all" || directionFilter !== "all" || categoryFilter !== "all";

  return (
    <div className="flex flex-col gap-4">
      {rows.length === 0 ? (
        <div className="flex flex-col gap-2">
          <EmptyState
            icon={Landmark}
            title="No loans yet"
            description="A Loan is money borrowed from a bank, lender or person. Add one to track its installments and what's left to repay."
            actionLabel="Add a Loan"
            onAction={openAdd}
          />
          {trashedRows.length > 0 && (
            <ClayButton variant="ghost" size="sm" className="gap-1.5 self-center" onClick={() => setTrashOpen(true)}>
              <Trash2 className="size-3.5" />
              Trash ({trashedRows.length})
            </ClayButton>
          )}
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-2.5">
            <div className="flex flex-wrap items-center gap-2">
              {rows.length > 4 && (
                <div className="relative w-full sm:w-64">
                  <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                  <input
                    className={cn(FLAT_INPUT, "pl-9")}
                    placeholder="Search loans"
                    aria-label="Search loans"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
              )}
              {rows.length > 1 && <ChipRow options={STATUS_FILTER_OPTIONS} value={statusFilter} onChange={setStatusFilter} />}
              <ClayButton variant="ghost" size="sm" className="ml-auto gap-1.5" onClick={() => setTrashOpen(true)}>
                <Trash2 className="size-3.5" />
                Trash{trashedRows.length > 0 ? ` (${trashedRows.length})` : ""}
              </ClayButton>
            </div>
            {(hasLent || hasBothCategories) && (
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                {hasLent && <ChipRow options={DIRECTION_FILTER_OPTIONS} value={directionFilter} onChange={setDirectionFilter} />}
                {hasBothCategories && <ChipRow options={CATEGORY_FILTER_OPTIONS} value={categoryFilter} onChange={setCategoryFilter} />}
              </div>
            )}
          </div>

          {visibleRows.length === 0 ? (
            <EmptyState
              icon={Search}
              title="No matching loans"
              description="Try a different search or filter."
              actionLabel={filtersActive ? "Clear filters" : undefined}
              onAction={() => {
                setSearch("");
                setStatusFilter("all");
                setDirectionFilter("all");
                setCategoryFilter("all");
              }}
            />
          ) : (
            <Stagger className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {visibleRows.map((row) => (
                <LoanCard
                  key={row.loan.id}
                  row={row}
                  onClick={() => {
                    setActiveRowId(row.loan.id);
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
          if (!open) setActiveRowId(null);
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
        deleteLabel={activeRow != null && originationUiFor(activeRow.loan.id).moneyActive ? "Reverse & Delete" : undefined}
        linkedAccountName={activeRow ? originationAccountName(activeRow.loan.id) : null}
        onRecordPayment={(row, installment) => setPaymentTarget({ row, installment })}
        onSettleLumpSum={(row) => setLumpSumRow(row)}
        onPrincipalPrepayment={(row) => setAdjustment({ row, kind: "prepayment" })}
        onAdditionalDisbursement={(row) => setAdjustment({ row, kind: "disbursement" })}
        onToggleClose={handleToggleClose}
        statusBusy={statusBusy}
      />

      <LoanAdjustmentDialog
        key={adjustment ? `${adjustment.kind}-${adjustment.row.loan.id}` : "adjustment-closed"}
        open={adjustment != null}
        onOpenChange={(open) => !open && setAdjustment(null)}
        kind={adjustment?.kind ?? "prepayment"}
        row={adjustment?.row ?? null}
        accounts={accounts}
        onConfirm={async (params) => {
          if (!actions || !adjustment) throw new Error("Not signed in");
          if (adjustment.kind === "disbursement") {
            const result = await actions.recordAdditionalDisbursement(adjustment.row.loan, adjustment.row.installments, params);
            await queryClient.invalidateQueries({ queryKey: ["loan-financial-history"], exact: false });
            return result;
          }
          const result = await actions.recordPayment(adjustment.row.loan, adjustment.row.installments, {
            ...params,
            amount: params.transactionAmount,
            includeUpcomingInstallments: false,
          });
          await queryClient.invalidateQueries({ queryKey: ["loan-financial-history"], exact: false });
          return result;
        }}
      />

      <RecordLoanPaymentDialog
        key={paymentTarget?.installment.id ?? "payment-closed"}
        open={paymentTarget != null}
        onOpenChange={(open) => !open && setPaymentTarget(null)}
        loan={paymentTarget?.row.loan ?? null}
        installment={paymentTarget?.installment ?? null}
        accounts={accounts}
        onRecord={async (loan, installments, params) => {
          if (!actions) return;
          await actions.recordPayment(loan, installments, params);
          toast.success("Payment recorded");
        }}
      />

      <LoanLumpSumDialog
        key={lumpSumRow?.loan.id ?? "lumpsum-closed"}
        open={lumpSumRow != null}
        onOpenChange={(open) => !open && setLumpSumRow(null)}
        row={lumpSumRow}
        accounts={accounts}
        onSettle={async (loan, installments, params) => {
          if (!actions) throw new Error("Not signed in");
          return actions.recordLumpSumSettlement(loan, installments, params);
        }}
      />

      <ReverseOriginationDialog
        open={reverseTarget != null}
        onOpenChange={(open) => { if (!open) setReverseTarget(null); }}
        loanName={reverseTarget?.loan.name?.trim() || "loan"}
        message={reverseTarget?.message ?? ""}
        busy={reversing}
        onConfirm={handleReverseOrigination}
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
        description="Money borrowed from a bank, lender or person. Only the basics are needed — the schedule is built for you."
        onConfirm={() => handleSave(false)}
        confirmLabel={saving ? "Saving…" : "Add Loan"}
        loading={saving}
        contentClassName="sm:max-w-2xl"
      >
        <LoanFormFields
          form={form}
          setForm={setForm}
          isEdit={false}
          people={people}
          accounts={accounts}
          onCreatePerson={actions?.createPerson}
        />
      </SectionedFormDialog>

      <SectionedFormDialog
        open={editOpen}
        onOpenChange={(open) => {
          setEditOpen(open);
          // Cancelling an edit returns to the loan it was opened from, like saving does.
          if (!open && activeRowId) setScheduleOpen(true);
        }}
        title={`Edit ${activeRow ? loanDisplayName(activeRow) : "Loan"}`}
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

/** Small "go create it there" link — sends the user to the page that owns that record instead of an inline form. */
export function AddElsewhereLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1 rounded-md text-xs font-semibold text-primary-accent-text outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
    >
      {label}
      <ArrowUpRight className="size-3.5" />
    </Link>
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
  { value: "taken", label: "I borrowed" },
  { value: "given", label: "I lent" },
];

const CATEGORY_OPTIONS: { value: LoanCategory; label: string }[] = [
  { value: "institutional", label: "Bank / lender" },
  { value: "personal", label: "Person" },
];

const ADD_NEW_PERSON_VALUE = "__add_new_person__";

/**
 * Person picker for a personal loan's lender/borrower — a native `<select>` (matching the People
 * picker pattern already used elsewhere on this form, e.g. "Who actually pays the EMIs?") plus an
 * inline "+ Add new person" option that reveals a name field and creates the Person on confirm, so
 * choosing a lender never requires leaving the loan form first.
 */
export function PersonPickerField({
  label,
  people,
  value,
  disabled,
  onChange,
  onCreatePerson,
  lockedHint,
}: {
  label: string;
  people: Person[];
  value: string;
  disabled: boolean;
  onChange: (personId: string) => void;
  onCreatePerson?: (name: string) => Promise<Person>;
  lockedHint?: string;
}) {
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCreate() {
    if (!onCreatePerson) return;
    const name = newName.trim();
    if (!name) {
      setError("Name is required.");
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const person = await onCreatePerson(name);
      onChange(person.id);
      setAdding(false);
      setNewName("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't add person.");
    } finally {
      setCreating(false);
    }
  }

  if (adding) {
    return (
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <div className="flex items-center gap-2">
          <input
            autoFocus
            className={FLAT_INPUT}
            placeholder="Person's name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void handleCreate();
              }
            }}
          />
          <ClayButton type="button" size="sm" onClick={() => void handleCreate()} disabled={creating}>
            {creating ? "Adding…" : "Add"}
          </ClayButton>
          <ClayButton
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              setAdding(false);
              setNewName("");
              setError(null);
            }}
          >
            Cancel
          </ClayButton>
        </div>
        {error && <span className="text-xs text-destructive">{error}</span>}
      </label>
    );
  }

  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <select
        className={FLAT_INPUT}
        value={value}
        disabled={disabled}
        onChange={(e) => {
          if (e.target.value === ADD_NEW_PERSON_VALUE) {
            setAdding(true);
            return;
          }
          onChange(e.target.value);
        }}
      >
        <option value="" disabled>
          Choose a person
        </option>
        {people.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
        {onCreatePerson && <option value={ADD_NEW_PERSON_VALUE}>+ Add new person</option>}
      </select>
      {lockedHint && <span className="text-xs text-muted-foreground">{lockedHint}</span>}
    </label>
  );
}

function LoanFormFields({
  form,
  setForm,
  isEdit,
  people,
  hasPayments = false,
  minInstallmentCount = 1,
  minLoanAmount = 0,
  onCreatePerson,
  accounts = [],
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
  /** Create-mode only — lets the person picker below add a brand-new lender/borrower inline. */
  onCreatePerson?: (name: string) => Promise<Person>;
  /** Create-mode only — the Accounts the principal may have moved through. */
  accounts?: Account[];
}) {
  const movementAccounts = accounts.filter((a) => a.type !== "card" && a.deletedAt == null);
  const received = form.direction === "taken";
  const hasRate = form.ratePercent.trim() !== "" && Number(form.ratePercent) > 0;
  const lenderLabel = received ? "Borrowed from" : "Lent to";
  return (
    <div className="flex flex-col gap-5">
      {/* 1 — what kind of loan. Decides the wording of everything below. */}
      {!isEdit ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FieldGroup label="Did you borrow or lend it?">
            <ChipRow options={DIRECTION_OPTIONS} value={form.direction} onChange={(v) => setForm((f) => ({ ...f, direction: v }))} />
          </FieldGroup>
          <FieldGroup label={received ? "Borrowed from a…" : "Lent to a…"}>
            <ChipRow options={CATEGORY_OPTIONS} value={form.category} onChange={(v) => setForm((f) => ({ ...f, category: v }))} />
          </FieldGroup>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <ClayBadge tone="neutral">{CATEGORY_OPTIONS.find((o) => o.value === form.category)?.label}</ClayBadge>
          <ClayBadge tone={form.direction === "given" ? "success" : "neutral"}>
            {DIRECTION_OPTIONS.find((o) => o.value === form.direction)?.label}
          </ClayBadge>
        </div>
      )}

      {/* 2 — who and how much. */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {form.category === "personal" ? (
          <PersonPickerField
            label={lenderLabel}
            people={people}
            value={form.personId}
            disabled={isEdit}
            onChange={(personId) => setForm((f) => ({ ...f, personId }))}
            onCreatePerson={isEdit ? undefined : onCreatePerson}
            lockedHint={isEdit ? "Person can't be changed after the loan is created." : undefined}
          />
        ) : (
          <Field label={lenderLabel}>
            <input
              className={FLAT_INPUT}
              placeholder={received ? "e.g. HDFC Bank" : "e.g. Rahul"}
              value={form.lenderName}
              onChange={(e) => setForm((f) => ({ ...f, lenderName: e.target.value }))}
            />
          </Field>
        )}
        <Field
          label="Loan amount"
          hint={
            isEdit
              ? `Re-amortizes the remaining balance${minLoanAmount > 0 ? ` — can't go below ₹${minLoanAmount.toLocaleString("en-IN")} already paid off` : ""}.`
              : undefined
          }
        >
          <AmountInput
            value={form.principal}
            min={isEdit ? minLoanAmount || undefined : undefined}
            onChange={(v) => setForm((f) => ({ ...f, principal: v }))}
          />
        </Field>
      </div>

      {/* 3 — repayment terms. */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Field
          label="Number of installments"
          hint={isEdit && minInstallmentCount > 0 ? `Can't go below ${minInstallmentCount} — already settled.` : undefined}
        >
          <input
            type="number"
            inputMode="numeric"
            min={isEdit ? minInstallmentCount || 1 : 1}
            className={FLAT_INPUT}
            value={form.installmentCount}
            onChange={(e) => setForm((f) => ({ ...f, installmentCount: e.target.value }))}
          />
        </Field>
        <FieldGroup label="Paid">
          <ChipRow
            options={FREQUENCY_OPTIONS}
            value={form.installmentFrequency}
            onChange={(v) => setForm((f) => ({ ...f, installmentFrequency: v }))}
          />
        </FieldGroup>
        <Field
          label="Loan date"
          hint={isEdit ? (hasPayments ? "Locked once a payment is recorded." : "Regenerates the schedule from this date.") : undefined}
        >
          <input
            type="date"
            disabled={isEdit && hasPayments}
            className={cn(FLAT_INPUT, isEdit && hasPayments && "text-muted-foreground opacity-70")}
            value={form.loanDate}
            onChange={(e) => setForm((f) => ({ ...f, loanDate: e.target.value }))}
          />
        </Field>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field
          label="Interest rate (% per year)"
          hint={isEdit ? "Re-amortizes the remaining balance over the unpaid installments." : "Leave empty if there's no interest."}
        >
          <input
            type="number"
            inputMode="decimal"
            className={FLAT_INPUT}
            placeholder="e.g. 8.65"
            value={form.ratePercent}
            onChange={(e) => setForm((f) => ({ ...f, ratePercent: e.target.value }))}
          />
        </Field>
        {hasRate && (
          <FieldGroup label="Interest type" hint="Most bank loans use reducing balance.">
            <ChipRow options={INTEREST_TYPE_OPTIONS} value={form.interestType} onChange={(v) => setForm((f) => ({ ...f, interestType: v }))} />
          </FieldGroup>
        )}
      </div>

      {/* 4 — linked Account. Its fields only appear once switched on. */}
      {!isEdit && (
        <RevealToggle
          checked={form.recordMovement}
          onChange={(checked) => setForm((f) => ({ ...f, recordMovement: checked }))}
          title={received ? "Money came into one of my accounts" : "Money went out of one of my accounts"}
          description="Leave off if it didn't pass through a FlowFi account — no balance changes."
        >
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-foreground/85">{received ? "Received into" : "Paid from"}</span>
              <AddElsewhereLink href="/accounts" label="Add Account" />
            </div>
            {movementAccounts.length === 0 ? (
              <p className="text-xs text-muted-foreground">No accounts yet — add one in Accounts, then come back.</p>
            ) : (
              <select
                className={FLAT_INPUT}
                value={form.movementAccountId}
                onChange={(e) => setForm((f) => ({ ...f, movementAccountId: e.target.value }))}
              >
                <option value="">Choose account</option>
                {movementAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Updates this account&apos;s balance. It isn&apos;t counted as income or spending — the amount stays tracked as a loan.
          </p>
        </RevealToggle>
      )}

      {/* 5 — everything optional. */}
      <MoreOptions
        defaultOpen={isEdit}
        summary={
          form.category === "institutional" ? "Name, who it's for, who pays, bank details, notes" : "Name, who it's for, who pays, notes"
        }
      >
        <Field label="Loan name">
          <input
            className={FLAT_INPUT}
            placeholder="e.g. Home Loan"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          />
        </Field>

        {form.direction === "taken" && (
          <WhoIsThisForField
            bare
            labelClassName="text-xs font-semibold text-foreground/85"
            people={people}
            choice={form.ownership}
            personId={form.beneficiaryPersonId}
            onChange={({ choice, personId }) => setForm((f) => ({ ...f, ownership: choice, beneficiaryPersonId: personId }))}
          />
        )}

        <Field label="Who pays the installments?" hint="Only if a friend or family member pays it for you.">
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
        </Field>

        {form.category === "institutional" && (
          <div className="flex flex-col gap-3">
            <SectionLabel icon={Building2}>Bank details</SectionLabel>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Type of loan">
                <input
                  className={FLAT_INPUT}
                  placeholder="e.g. Personal, Vehicle, Education"
                  value={form.loanType}
                  onChange={(e) => setForm((f) => ({ ...f, loanType: e.target.value }))}
                />
              </Field>
              <Field label="Loan account number">
                <input className={FLAT_INPUT} value={form.loanNumber} onChange={(e) => setForm((f) => ({ ...f, loanNumber: e.target.value }))} />
              </Field>
              <Field label="Bank account number">
                <input
                  className={FLAT_INPUT}
                  value={form.accountNumber}
                  onChange={(e) => setForm((f) => ({ ...f, accountNumber: e.target.value }))}
                />
              </Field>
              <Field label="Branch">
                <input className={FLAT_INPUT} value={form.branch} onChange={(e) => setForm((f) => ({ ...f, branch: e.target.value }))} />
              </Field>
            </div>
          </div>
        )}

        <Field label="Notes">
          <textarea
            className={cn(FLAT_INPUT, "min-h-20 resize-none py-2")}
            placeholder="Optional notes"
            rows={3}
            value={form.notes}
            onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
          />
        </Field>
      </MoreOptions>
    </div>
  );
}
