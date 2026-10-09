"use client";

import { AccountSelect } from "@/components/finance/account-label";
import { ArrowUpRight, Building2, UserRound, Wallet } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { ClayBadge } from "@/components/clay/clay-badge";
import { ClayButton } from "@/components/clay/clay-button";
import { useOperation } from "@/components/feedback/operation-progress";
import { SUCCESS_HOLD_MS, type OperationHandle } from "@/lib/operation-progress/operation-progress";
import { startOperation } from "@/store/operation-progress-store";
import type { InterestType } from "@/lib/engines/interest-calculator";
import type { Loan, LoanCategory, LoanDirection } from "@/lib/models/loan";
import type { ScheduleType } from "@/lib/models/payment-schedule";
import { loanDisplayName } from "@/features/loans/components/loan-card";
import {
  AmountInput,
  Field,
  FieldGroup,
  FormSection,
  LOAN_EMI_INPUT,
  LOAN_ICON,
  LoanEmiFormDialog,
  MoreOptions,
  RevealToggle,
  SegmentedControl,
} from "@/features/loans/components/loan-emi-ui";
import { LoanScheduleDialog } from "@/features/loans/components/loan-schedule-dialog";
import { LoansTrashDialog } from "@/features/loans/components/loans-trash-dialog";
import { RecordPaymentDialog } from "@/features/loans/components/record-payment-dialog";
import { RecordedPaymentDialog } from "@/features/loans/components/recorded-payment-dialog";
import { useLoanPaymentHistory } from "@/features/loans/hooks/use-payment-history";
import { groupRecordedPayments, type RecordedPaymentAction } from "@/features/loans/lib/recorded-payments";
import { LoanAdjustmentDialog } from "@/features/loans/components/loan-adjustment-dialog";
import { AgreementDeleteDialog } from "@/features/loans/components/agreement-delete-dialog";
import { runPermanentDeletion } from "@/features/loans/lib/permanent-deletion";
import {
  WhoIsThisForField,
  beneficiaryFromChoice,
  ownershipError,
  type OwnershipChoice,
} from "@/features/loans/components/who-is-this-for-field";
import { loanOriginationUi } from "@/features/loans/lib/loan-origination-ui";
import { recordKindForLoan } from "@/features/loans/lib/loan-emi-add";
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
import { DateInput } from "@/components/forms/date-input";

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
  firstEmiDate: string;
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
    firstEmiDate: new Date().toISOString().slice(0, 10),
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
    firstEmiDate: (row.installments[0]?.dueDate ?? row.loan.loanDate).toISOString().slice(0, 10),
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
  /** Opens this Loan's detail view — sent by the unified Loan & EMI list; `seq` makes repeat clicks count. */
  openRequest?: { id: string; seq: number } | null;
  /** Incremented to open the Loan trash. */
  trashRequest?: number;
}

/**
 * Every Loan dialog — details, edit, payments, adjustments, reversal, trash — for the unified Loan & EMI
 * workspace, which owns the list and the single Add flow. Renders no list of its own.
 */
export function LoansWorkspace({ openRequest = null, trashRequest = 0 }: LoansWorkspaceProps = {}) {
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const { rows } = useLoanRows();
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
  // The Loan being permanently deleted (the confirmation is open) and whether that deletion is running.
  const [deleteTarget, setDeleteTarget] = useState<Loan | null>(null);
  const [purging, setPurging] = useState(false);
  const purgeInFlight = useRef(false);
  // Finish any permanent Loan/EMI deletion whose cleanup was interrupted after its money step committed.
  useEffect(() => {
    actions?.resumePendingDeletions().catch(() => undefined);
  }, [actions]);

  const [activeRowId, setActiveRowId] = useState<string | null>(() => searchParams.get("agreement"));
  // Resolved live against `rows` on every render, instead of holding a snapshot of the row — `rows`
  // comes from a live Firestore subscription (see `hooks/use-loans.ts`), so re-deriving it here is what
  // makes edits/payments to the open loan show up in the schedule dialog without a manual refresh.
  const activeRow = useMemo(() => rows.find((r) => r.loan.id === activeRowId) ?? null, [rows, activeRowId]);
  const [scheduleOpen, setScheduleOpen] = useState(() => searchParams.has("agreement"));
  const [editOpen, setEditOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  // Record Payment resolves its loan live from `rows` (like `activeRow`), so the open surface shows the
  // balance the listener just delivered; `seq` gives each open a fresh mount + idempotency key.
  const [payment, setPayment] = useState<{ loanId: string; seq: number } | null>(null);
  const [paymentSeq, setPaymentSeq] = useState(0);
  const paymentRow = useMemo(() => (payment ? (rows.find((r) => r.loan.id === payment.loanId) ?? null) : null), [rows, payment]);
  const [adjustment, setAdjustment] = useState<{ row: LoanRow; kind: "disbursement" } | null>(null);
  // Recorded payments of the open loan, grouped per payment action — live-keyed, see `useLoanPaymentHistory`.
  const historyQuery = useLoanPaymentHistory(activeRow);
  const paymentActions = useMemo(
    () => (activeRow && historyQuery.data ? groupRecordedPayments(historyQuery.data.payments, activeRow.installments, "loan") : []),
    [activeRow, historyQuery.data],
  );
  // A snapshot of the payment opened (so a half-finished correction keeps its original), with a fresh mount per open.
  const [viewPayment, setViewPayment] = useState<{ action: RecordedPaymentAction; all: RecordedPaymentAction[]; seq: number } | null>(null);
  const [form, setForm] = useState<LoanFormState>(emptyForm);
  const [saving, setSaving] = useState(false);
  const editOperation = useOperation();
  const saveInFlight = useRef(false);
  const [statusBusy, setStatusBusy] = useState(false);

  const [seenOpenRequest, setSeenOpenRequest] = useState(openRequest);
  if (openRequest !== seenOpenRequest) {
    setSeenOpenRequest(openRequest);
    if (openRequest) {
      setActiveRowId(openRequest.id);
      setScheduleOpen(true);
    }
  }
  const [seenTrashRequest, setSeenTrashRequest] = useState(trashRequest);
  if (trashRequest !== seenTrashRequest) {
    setSeenTrashRequest(trashRequest);
    setTrashOpen(true);
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
    // Synchronous guard — `saving` is async state, so two fast clicks could both get past it.
    if (saveInFlight.current) return;
    saveInFlight.current = true;
    setSaving(true);
    let op: OperationHandle | null = null;
    try {
      if (isEdit && activeRow) {
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

        // Loan Date only moves before any payment exists — mirrors `LoanRepository.editLoanDate`'s own
        // guard. Runs against `current` so it re-amortizes with whatever terms were just saved above.
        const hasPayments = activeRow.installments.some((i) => i.amountPaid > 0);
        const originalLoanDate = activeRow.loan.loanDate.toISOString().slice(0, 10);
        const dateChanged = !hasPayments && form.loanDate !== originalLoanDate;
        const originalFirstEmiDate = (activeRow.installments[0]?.dueDate ?? activeRow.loan.loanDate).toISOString().slice(0, 10);
        const firstEmiDateChanged = !hasPayments && form.firstEmiDate !== originalFirstEmiDate;
        // The real, sequential writes this save performs: details first, then any schedule re-plan / date move.
        op = editOperation.start({ label: "Updating loan", successLabel: "Loan updated", errorLabel: "Couldn't save changes", detail: "Checking changes" });
        op.stage("submit", "Saving details");

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

        if (termsChanged) {
          op.stage("related", "Re-planning schedule");
          current = await actions.editLoanTerms(current, {
            currentInstallments: activeRow.installments,
            loanAmount: Number.isFinite(newLoanAmount) && newLoanAmount > 0 ? newLoanAmount : undefined,
            interest: newInterest,
            installmentFrequency: form.installmentFrequency,
            newInstallmentCount,
          });
        }

        if (dateChanged) {
          op.stage("related", "Updating dates");
          current = await actions.editLoanDate(current, {
            newLoanDate: new Date(form.loanDate),
            hasPayments: false,
            currentInstallments: activeRow.installments,
          });
        }

        if (firstEmiDateChanged) {
          op.stage("related", "Updating repayment schedule");
          await actions.editFirstDueDate(current, {
            newFirstDueDate: new Date(form.firstEmiDate),
            hasPayments: false,
            currentInstallments: activeRow.installments,
          });
        }

        op.succeed({ toast: { title: "Loan updated successfully" } });
        await new Promise((resolve) => window.setTimeout(resolve, SUCCESS_HOLD_MS));
        setEditOpen(false);
        // Back to the same loan's detail view, which re-renders from the live listener — no need to
        // close and reopen it to see the saved values.
        setScheduleOpen(true);
      }
      // New Loans are created by the unified Add flow (`LoanEmiAddDialog`), not here.
    } catch (e) {
      // Stays open with everything entered; "Try again" re-runs the save.
      if (op) op.fail({ detail: friendlyLoanError(e), retry: () => handleSave(isEdit) });
      else toast.error(isEdit ? "Couldn't save changes" : "Couldn't add loan", friendlyLoanError(e));
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  }

  // A Loan with nothing recorded against it soft-deletes to Trash — reversible (mirrors `loans_screen.dart`'s
  // swipe-to-delete), so no blocking confirm, just Undo on the toast. A Loan with financial activity (its
  // creation moved money, or a payment / Borrow More was recorded) can't just go to Trash — its money would
  // stay while the debt left — so it opens the permanent delete, which reverses what the Loan owns.
  async function handleDelete(row: LoanRow) {
    if (!actions) return;
    const history = activeRow?.loan.id === row.loan.id ? historyQuery.data : undefined;
    const hasActivity =
      originationUiFor(row.loan.id).moneyActive ||
      row.installments.some((i) => i.amountPaid > 0) ||
      (history != null && (history.payments.length > 0 || history.disbursements.length > 0));
    if (hasActivity) {
      setDeleteTarget(row.loan);
      return;
    }
    const op = startOperation({ label: "Deleting loan", successLabel: "Loan moved to trash", errorLabel: "Couldn't delete loan" });
    try {
      op.stage("submit", "Moving to trash");
      await actions.deleteLoan(row.loan);
      setActiveRowId(null);
      op.succeed({
        toast: {
          title: "Loan moved to trash",
          action: { label: "Undo", onClick: () => actions.restoreLoan(row.loan).catch(() => toast.error("Couldn't restore loan")) },
        },
      });
    } catch (e) {
      op.fail({ detail: friendlyLoanError(e), retry: () => handleDelete(row) });
    }
  }

  async function handleToggleClose(row: LoanRow) {
    if (!actions || statusBusy) return;
    setStatusBusy(true);
    const reopening = row.status === "closed";
    const op = startOperation({
      label: reopening ? "Reopening loan" : "Closing loan",
      successLabel: reopening ? "Loan reopened" : "Loan closed",
      errorLabel: "Couldn't update loan",
    });
    try {
      // No local status override: the write's own snapshot (Firestore fires it immediately for local
      // writes) flows through `rows` → `activeRow`, so the open dialog, card and Status filter all
      // flip together from the persisted value.
      op.stage("submit", "Updating status");
      if (reopening) await actions.reopenLoan(row.loan);
      else await actions.closeLoan(row.loan);
      op.succeed({ toast: { title: reopening ? "Loan reopened" : "Loan closed" } });
    } catch (e) {
      op.fail({ detail: friendlyLoanError(e) });
    } finally {
      setStatusBusy(false);
    }
  }

  async function handleRestoreLoan(loan: Loan) {
    if (!actions) return;
    await actions.restoreLoan(loan);
  }

  // Trash's "Delete forever" goes through the same permanent delete, with its own risk-matched confirmation.
  async function handlePermanentlyDeleteLoan(loan: Loan) {
    setTrashOpen(false);
    setDeleteTarget(loan);
  }

  const deleteTargetId = deleteTarget?.id ?? null;
  const loadDeleteImpact = useCallback(
    () => (actions && deleteTargetId ? actions.previewPermanentDeletion({ id: deleteTargetId }) : Promise.resolve(null)),
    [actions, deleteTargetId],
  );

  async function confirmPermanentDelete() {
    if (!actions || !deleteTarget || purgeInFlight.current) return;
    const loan = deleteTarget;
    purgeInFlight.current = true;
    setPurging(true);
    const ok = await runPermanentDeletion({
      kind: "loan",
      run: (onStage) => actions.permanentlyDeleteLoan(loan, { onStage }),
      refresh: () =>
        Promise.all(
          ["loan-financial-history", "loanPrincipalPrepaid", "loanScheduledPayments", "cardLinkedEmiPayments"].map((key) =>
            queryClient.invalidateQueries({ queryKey: [key], exact: false }),
          ),
        ),
      retry: () => setDeleteTarget(loan),
    });
    purgeInFlight.current = false;
    setPurging(false);
    if (ok) {
      setDeleteTarget(null);
      if (activeRowId === loan.id) {
        setScheduleOpen(false);
        setActiveRowId(null);
      }
    }
  }

  return (
    <>
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
        onRecordPayment={(row) => {
          setPaymentSeq((n) => n + 1);
          setPayment({ loanId: row.loan.id, seq: paymentSeq + 1 });
        }}
        onAdditionalDisbursement={(row) => setAdjustment({ row, kind: "disbursement" })}
        onToggleClose={handleToggleClose}
        statusBusy={statusBusy}
        history={historyQuery.data}
        historyLoading={historyQuery.isLoading}
        paymentActions={paymentActions}
        onViewPayment={(action) => setViewPayment({ action, all: paymentActions, seq: (viewPayment?.seq ?? 0) + 1 })}
      />

      <RecordedPaymentDialog
        key={viewPayment ? `payment-${viewPayment.action.id}-${viewPayment.seq}` : "payment-closed"}
        target={viewPayment && activeRow ? { source: "loan", row: activeRow, action: viewPayment.action, all: viewPayment.all } : null}
        open={viewPayment != null && activeRow != null}
        onOpenChange={(open) => !open && setViewPayment(null)}
        onPayRemaining={() => {
          if (!activeRow) return;
          setViewPayment(null);
          setPaymentSeq((n) => n + 1);
          setPayment({ loanId: activeRow.loan.id, seq: paymentSeq + 1 });
        }}
      />

      <LoanAdjustmentDialog
        key={adjustment ? `${adjustment.kind}-${adjustment.row.loan.id}` : "adjustment-closed"}
        open={adjustment != null}
        onOpenChange={(open) => !open && setAdjustment(null)}
        kind="disbursement"
        row={adjustment?.row ?? null}
        accounts={accounts}
        onConfirm={async (params) => {
          if (!actions || !adjustment) throw new Error("Not signed in");
          const result = await actions.recordAdditionalDisbursement(adjustment.row.loan, adjustment.row.installments, params);
          await queryClient.invalidateQueries({ queryKey: ["loan-financial-history"], exact: false });
          return result;
        }}
      />

      <RecordPaymentDialog
        key={payment ? `pay-${payment.loanId}-${payment.seq}` : "pay-closed"}
        target={paymentRow ? { kind: "loan", row: paymentRow } : null}
        open={payment != null && paymentRow != null}
        onOpenChange={(open) => !open && setPayment(null)}
      />

      <AgreementDeleteDialog
        open={deleteTarget != null}
        onOpenChange={(open) => { if (!open && !purging) setDeleteTarget(null); }}
        kind="loan"
        name={deleteTarget?.name?.trim() || "this loan"}
        loadImpact={loadDeleteImpact}
        onConfirm={confirmPermanentDelete}
        busy={purging}
      />

      <LoansTrashDialog
        open={trashOpen}
        onOpenChange={setTrashOpen}
        rows={trashedRows}
        onRestore={handleRestoreLoan}
        onPermanentlyDelete={handlePermanentlyDeleteLoan}
      />

      <LoanEmiFormDialog
        open={editOpen}
        onOpenChange={(open) => {
          setEditOpen(open);
          // Cancelling an edit returns to the loan it was opened from, like saving does.
          if (!open && activeRowId) setScheduleOpen(true);
        }}
        title={`Edit ${activeRow ? loanDisplayName(activeRow) : "Loan"}`}
        onConfirm={() => handleSave(true)}
        icon={LOAN_ICON}
        confirmLabel={saving ? "Updating loan…" : "Save Changes"}
        loading={saving}
        success={editOperation.snapshot?.status === "success"}
        operation={editOperation.snapshot}
      >
        <LoanFormFields
          form={form}
          setForm={setForm}
          isEdit
          kindLabel={activeRow ? recordKindForLoan(activeRow.loan).label : undefined}
          people={people}
          hasPayments={activeRow ? activeRow.installments.some((i) => i.amountPaid > 0) : false}
          minInstallmentCount={activeRow ? activeRow.installments.filter((i) => i.amountPaid > 0 || i.isSkipped).length : 0}
          minLoanAmount={activeRow ? activeRow.loan.loanAmount - activeRow.outstandingPrincipal : 0}
        />
      </LoanEmiFormDialog>
    </>
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
  { value: "taken", label: "Loan I Took" },
  { value: "given", label: "Loan I Gave" },
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
      <label className="flex min-w-0 flex-col gap-1.5">
        <span className="text-xs font-semibold text-foreground">{label}</span>
        <div className="flex items-center gap-2">
          <input
            autoFocus
            className={LOAN_EMI_INPUT}
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
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="text-xs font-semibold text-foreground">{label}</span>
      <select
        className={LOAN_EMI_INPUT}
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
  kindLabel,
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
  /** Edit mode only — the unified record type ("Bank Loan", "Lent", …) derived from the existing Loan. */
  kindLabel?: string;
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
  return (
    <>
      {/* 1 — Basics: what kind of loan, who, how much. Decides the wording of everything below. */}
      <FormSection title="Basics">
        {!isEdit ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FieldGroup label="What kind of loan is this?">
              <SegmentedControl
                ariaLabel="What kind of loan is this?"
                size="sm"
                className="sm:w-full"
                options={DIRECTION_OPTIONS}
                value={form.direction}
                onChange={(v) => setForm((f) => ({ ...f, direction: v }))}
              />
            </FieldGroup>
            <FieldGroup label={received ? "Loan taken from" : "Loan given to"}>
              <SegmentedControl
                ariaLabel={received ? "Loan taken from" : "Loan given to"}
                size="sm"
                className="sm:w-full"
                options={CATEGORY_OPTIONS.map((o) => ({ ...o, icon: o.value === "institutional" ? Building2 : UserRound }))}
                value={form.category}
                onChange={(v) => setForm((f) => ({ ...f, category: v }))}
              />
            </FieldGroup>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <ClayBadge tone={form.direction === "given" ? "success" : "neutral"}>
              {kindLabel ?? DIRECTION_OPTIONS.find((o) => o.value === form.direction)?.label}
            </ClayBadge>
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {form.category === "personal" ? (
            <PersonPickerField
              label={received ? "Lender" : "Borrower"}
              people={people}
              value={form.personId}
              disabled={isEdit}
              onChange={(personId) => setForm((f) => ({ ...f, personId }))}
              onCreatePerson={isEdit ? undefined : onCreatePerson}
              lockedHint={isEdit ? "Person can't be changed after the loan is created." : undefined}
            />
          ) : (
            <Field label={received ? "Lender" : "Loan given to"}>
              <input
                className={cn(LOAN_EMI_INPUT, "h-12 text-base")}
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
      </FormSection>

      {/* 2 — Repayment plan. */}
      <FormSection title="Repayment plan">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field
            label="Number of installments"
            hint={isEdit && minInstallmentCount > 0 ? `Can't go below ${minInstallmentCount} — already settled.` : undefined}
          >
            <input
              type="number"
              inputMode="numeric"
              min={isEdit ? minInstallmentCount || 1 : 1}
              className={LOAN_EMI_INPUT}
              value={form.installmentCount}
              onChange={(e) => setForm((f) => ({ ...f, installmentCount: e.target.value }))}
            />
          </Field>
          <FieldGroup label="Payment frequency">
            <SegmentedControl
              ariaLabel="Payment frequency"
              size="sm"
              className="sm:w-full"
              options={FREQUENCY_OPTIONS}
              value={form.installmentFrequency}
              onChange={(v) => setForm((f) => ({ ...f, installmentFrequency: v }))}
            />
          </FieldGroup>
          <Field
            label="Interest rate (% per year)"
            hint={isEdit ? "Re-amortizes the remaining balance over the unpaid installments." : "Leave empty if there's no interest."}
          >
            <input
              type="number"
              inputMode="decimal"
              className={LOAN_EMI_INPUT}
              placeholder="e.g. 8.65"
              value={form.ratePercent}
              onChange={(e) => setForm((f) => ({ ...f, ratePercent: e.target.value }))}
            />
          </Field>
          <Field
            label="Loan taken on"
            hint={isEdit ? (hasPayments ? "Locked once a payment is recorded." : "Does not change the repayment schedule.") : undefined}
          >
            <DateInput
              disabled={isEdit && hasPayments}
              className={cn(LOAN_EMI_INPUT, isEdit && hasPayments && "text-muted-foreground")}
              value={form.loanDate}
              onChange={(e) => setForm((f) => ({ ...f, loanDate: e.target.value }))}
            />
          </Field>
          <Field
            label="First EMI Date"
            hint={isEdit ? (hasPayments ? "Locked once a payment is recorded." : "Regenerates the repayment schedule from this date.") : undefined}
          >
            <DateInput
              disabled={isEdit && hasPayments}
              className={cn(LOAN_EMI_INPUT, isEdit && hasPayments && "text-muted-foreground")}
              value={form.firstEmiDate}
              onChange={(e) => setForm((f) => ({ ...f, firstEmiDate: e.target.value }))}
            />
          </Field>
          {hasRate && (
            <FieldGroup label="Interest type" hint="Most bank loans use reducing balance." className="sm:col-span-2">
              <SegmentedControl
                ariaLabel="Interest type"
                size="sm"
                options={INTEREST_TYPE_OPTIONS}
                value={form.interestType}
                onChange={(v) => setForm((f) => ({ ...f, interestType: v }))}
              />
            </FieldGroup>
          )}
        </div>
      </FormSection>

      {/* 3 — optional linked Account. Its fields only appear once switched on. */}
      {!isEdit && (
        <RevealToggle
          icon={Wallet}
          checked={form.recordMovement}
          onChange={(checked) => setForm((f) => ({ ...f, recordMovement: checked }))}
          title={received ? "Add money to an account" : "Take money from an account"}
          description={
            received
              ? "Did the money you received enter one of your FlowFi accounts?"
              : "Did the money you gave leave one of your FlowFi accounts?"
          }
        >
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-foreground/80">{received ? "Received into" : "Paid from"}</span>
              <AddElsewhereLink href="/accounts" label="Add account" />
            </div>
            {movementAccounts.length === 0 ? (
              <p className="text-xs text-muted-foreground">No accounts yet — add one in Accounts, then come back.</p>
            ) : (
              <AccountSelect
                className={LOAN_EMI_INPUT}
                accounts={movementAccounts}
                value={form.movementAccountId}
                onChange={(id) => setForm((f) => ({ ...f, movementAccountId: id }))}
              />
            )}
          </div>
          <p className="text-[11px] text-muted-foreground">This updates the account balance. It isn&apos;t treated as income.</p>
        </RevealToggle>
      )}

      {/* 4 — ownership: materially changes what the loan represents, so it's never hidden. */}
      {form.direction === "taken" && (
        <WhoIsThisForField
          variant="section"
          people={people}
          choice={form.ownership}
          personId={form.beneficiaryPersonId}
          onChange={({ choice, personId }) => setForm((f) => ({ ...f, ownership: choice, beneficiaryPersonId: personId }))}
        />
      )}

      {/* 5 — genuinely optional metadata. */}
      <MoreOptions
        defaultOpen={isEdit}
        summary={form.category === "institutional" ? "Name, who pays, bank details, notes" : "Name, who pays, notes"}
      >
        <Field label="Loan name">
          <input
            className={LOAN_EMI_INPUT}
            placeholder="e.g. Home Loan"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          />
        </Field>

        <Field label="Who pays the installments?" hint="Only if a friend or family member pays it for you.">
          <select
            className={LOAN_EMI_INPUT}
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
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Type of loan">
              <input
                className={LOAN_EMI_INPUT}
                placeholder="e.g. Personal, Vehicle, Education"
                value={form.loanType}
                onChange={(e) => setForm((f) => ({ ...f, loanType: e.target.value }))}
              />
            </Field>
            <Field label="Loan account number">
              <input className={LOAN_EMI_INPUT} value={form.loanNumber} onChange={(e) => setForm((f) => ({ ...f, loanNumber: e.target.value }))} />
            </Field>
            <Field label="Bank account number">
              <input
                className={LOAN_EMI_INPUT}
                value={form.accountNumber}
                onChange={(e) => setForm((f) => ({ ...f, accountNumber: e.target.value }))}
              />
            </Field>
            <Field label="Branch">
              <input className={LOAN_EMI_INPUT} value={form.branch} onChange={(e) => setForm((f) => ({ ...f, branch: e.target.value }))} />
            </Field>
          </div>
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
    </>
  );
}
