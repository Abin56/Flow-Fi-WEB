"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { startOperation } from "@/store/operation-progress-store";
import type { Loan } from "@/lib/models/loan";
import { outstandingOf } from "@/lib/models/payment-schedule";
import { StackProvider } from "@/components/finance/stack-layer";
import { LoanEmiAddDialog } from "@/features/loans/components/loan-emi-add-dialog";
import { LoanScheduleDialog } from "@/features/loans/components/loan-schedule-dialog";
import { LoansTrashDialog } from "@/features/loans/components/loans-trash-dialog";
import { RecordPaymentDialog } from "@/features/loans/components/record-payment-dialog";
import { RecordedPaymentDialog } from "@/features/loans/components/recorded-payment-dialog";
import { useLoanPaymentHistory } from "@/features/loans/hooks/use-payment-history";
import {
  groupRecordedPayments,
  type RecordedPaymentAction,
} from "@/features/loans/lib/recorded-payments";
import { LoanAdjustmentDialog } from "@/features/loans/components/loan-adjustment-dialog";
import { AgreementDeleteDialog } from "@/features/loans/components/agreement-delete-dialog";
import { runPermanentDeletion } from "@/features/loans/lib/permanent-deletion";
import { loanOriginationUi } from "@/features/loans/lib/loan-origination-ui";
import {
  originationIdsFor,
  originationKeyFromLoanId,
} from "@/lib/engines/loan-origination";
import { useTransactions } from "@/hooks/use-transactions";
import {
  useLoanActions,
  useLoanRows,
  useTrashedLoanRows,
  type LoanRow,
} from "@/features/loans/hooks/use-loans-data";
import { useAccounts } from "@/hooks/use-accounts";
import { friendlyLoanError } from "@/features/loans/lib/loan-live-state";
import { toast } from "@/store/toast-store";

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
export function LoansWorkspace({
  openRequest = null,
  trashRequest = 0,
}: LoansWorkspaceProps = {}) {
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const { rows } = useLoanRows();
  const { rows: trashedRows } = useTrashedLoanRows();
  const actions = useLoanActions();
  const { data: accounts = [] } = useAccounts();
  const { data: transactions = [] } = useTransactions();
  const originationUiFor = (loanId: string) =>
    loanOriginationUi(
      loanId,
      transactions,
      (accountId) => accounts.find((a) => a.id === accountId)?.name,
    );
  /** The Account a wizard-created loan's money moved through, for the details view's Linked section. */
  const originationAccountName = (loanId: string): string | null => {
    const key = originationKeyFromLoanId(loanId);
    if (key == null) return null;
    const transactionId = originationIdsFor(key).transactionId;
    const origination = transactions.find(
      (t) => t.id === transactionId && t.deletedAt == null,
    );
    return origination
      ? (accounts.find((a) => a.id === origination.accountId)?.name ?? null)
      : null;
  };
  // The Loan being permanently deleted (the confirmation is open) and whether that deletion is running.
  const [deleteTarget, setDeleteTarget] = useState<Loan | null>(null);
  const [purging, setPurging] = useState(false);
  const purgeInFlight = useRef(false);
  // Finish any permanent Loan/EMI deletion whose cleanup was interrupted after its money step committed.
  useEffect(() => {
    actions?.resumePendingDeletions().catch(() => undefined);
  }, [actions]);

  const [activeRowId, setActiveRowId] = useState<string | null>(() =>
    searchParams.get("agreement"),
  );
  // Resolved live against `rows` on every render, instead of holding a snapshot of the row — `rows`
  // comes from a live Firestore subscription (see `hooks/use-loans.ts`), so re-deriving it here is what
  // makes edits/payments to the open loan show up in the schedule dialog without a manual refresh.
  const activeRow = useMemo(
    () => rows.find((r) => r.loan.id === activeRowId) ?? null,
    [rows, activeRowId],
  );
  const [scheduleOpen, setScheduleOpen] = useState(() =>
    searchParams.has("agreement"),
  );
  const [editOpen, setEditOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  // Record Payment resolves its loan live from `rows` (like `activeRow`), so the open surface shows the
  // balance the listener just delivered; `seq` gives each open a fresh mount + idempotency key.
  // `installmentId`: the schedule row the user pressed Pay on; `view: "past"` opens "Record past payments".
  const [payment, setPayment] = useState<{
    loanId: string;
    seq: number;
    installmentId?: string | null;
    view?: "pay" | "past";
  } | null>(null);
  const [paymentSeq, setPaymentSeq] = useState(0);
  const paymentRow = useMemo(
    () =>
      payment ? (rows.find((r) => r.loan.id === payment.loanId) ?? null) : null,
    [rows, payment],
  );
  // Back from People (`?agreement=<id>&pay=1[&installment=<id>]`): reopen Record Payment for that loan once, when it has loaded.
  const payHandoffRef = useRef(
    searchParams.get("pay") === "1"
      ? {
          loanId: searchParams.get("agreement"),
          installmentId: searchParams.get("installment"),
          view:
            searchParams.get("view") === "past"
              ? ("past" as const)
              : ("pay" as const),
        }
      : null,
  );
  useEffect(() => {
    const handoff = payHandoffRef.current;
    if (!handoff?.loanId || !rows.some((r) => r.loan.id === handoff.loanId))
      return;
    payHandoffRef.current = null;
    const params = new URLSearchParams(window.location.search);
    params.delete("pay");
    params.delete("installment");
    params.delete("view");
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}?${params.toString()}`,
    );
    requestAnimationFrame(() =>
      setPayment({
        loanId: handoff.loanId!,
        seq: 0,
        installmentId: handoff.installmentId,
        view: handoff.view,
      }),
    );
  }, [rows]);
  const [adjustment, setAdjustment] = useState<{
    row: LoanRow;
    kind: "disbursement";
  } | null>(null);
  // From Balance Control's reconciliation guide (`?agreement=<id>&adjust=disbursement`): open Additional disbursement once.
  const adjustHandoffRef = useRef(
    searchParams.get("adjust") === "disbursement"
      ? searchParams.get("agreement")
      : null,
  );
  useEffect(() => {
    const loanId = adjustHandoffRef.current;
    const row = loanId ? rows.find((r) => r.loan.id === loanId) : undefined;
    if (!row) return;
    adjustHandoffRef.current = null;
    const params = new URLSearchParams(window.location.search);
    params.delete("adjust");
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}?${params.toString()}`,
    );
    requestAnimationFrame(() => setAdjustment({ row, kind: "disbursement" }));
  }, [rows]);
  // Recorded payments of the open loan, grouped per payment action — live-keyed, see `useLoanPaymentHistory`.
  const historyQuery = useLoanPaymentHistory(activeRow);
  const paymentActions = useMemo(
    () =>
      activeRow && historyQuery.data
        ? groupRecordedPayments(
            historyQuery.data.payments,
            activeRow.installments,
            "loan",
          )
        : [],
    [activeRow, historyQuery.data],
  );
  // A snapshot of the payment opened (so a half-finished correction keeps its original), with a fresh mount per open.
  const [viewPayment, setViewPayment] = useState<{
    action: RecordedPaymentAction;
    all: RecordedPaymentAction[];
    seq: number;
  } | null>(null);
  // Edit reuses the Add screen; `editSeq` gives every open a fresh mount so the form re-fills from the saved loan.
  const [editSeq, setEditSeq] = useState(0);
  const [editId, setEditId] = useState<string | null>(null);
  const editRow = useMemo(
    () => rows.find((r) => r.loan.id === editId) ?? null,
    [rows, editId],
  );
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
    // Edit is the creation screen itself, not a layer over the details: close the details, open the form,
    // and saving or cancelling lands back on the Loan & EMI main page (like Add does).
    setScheduleOpen(false);
    setActiveRowId(null);
    setEditId(row.loan.id);
    setEditSeq((n) => n + 1);
    setEditOpen(true);
  }

  // A Loan with nothing recorded against it soft-deletes to Trash — reversible (mirrors `loans_screen.dart`'s
  // swipe-to-delete), so no blocking confirm, just Undo on the toast. A Loan with financial activity (its
  // creation moved money, or a payment / Borrow More was recorded) can't just go to Trash — its money would
  // stay while the debt left — so it opens the permanent delete, which reverses what the Loan owns.
  async function handleDelete(row: LoanRow) {
    if (!actions) return;
    const history =
      activeRow?.loan.id === row.loan.id ? historyQuery.data : undefined;
    const hasActivity =
      originationUiFor(row.loan.id).moneyActive ||
      row.installments.some((i) => i.amountPaid > 0) ||
      (history != null &&
        (history.payments.length > 0 || history.disbursements.length > 0));
    if (hasActivity) {
      setDeleteTarget(row.loan);
      return;
    }
    const op = startOperation({
      label: "Deleting loan",
      successLabel: "Loan moved to trash",
      errorLabel: "Couldn't delete loan",
    });
    try {
      op.stage("submit", "Moving to trash");
      await actions.deleteLoan(row.loan);
      setScheduleOpen(false);
      setActiveRowId(null);
      op.succeed({
        toast: {
          title: "Loan moved to trash",
          action: {
            label: "Undo",
            onClick: () =>
              actions
                .restoreLoan(row.loan)
                .catch(() => toast.error("Couldn't restore loan")),
          },
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
      op.succeed({
        toast: { title: reopening ? "Loan reopened" : "Loan closed" },
      });
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
    () =>
      actions && deleteTargetId
        ? actions.previewPermanentDeletion({ id: deleteTargetId })
        : Promise.resolve(null),
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
          [
            "loan-financial-history",
            "loanPrincipalPrepaid",
            "loanScheduledPayments",
            "cardLinkedEmiPayments",
          ].map((key) =>
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
      <StackProvider>
        <LoanScheduleDialog
          open={scheduleOpen}
          onOpenChange={(open) => {
            setScheduleOpen(open);
            if (!open) setActiveRowId(null);
          }}
          row={activeRow}
          // Edit and the payment flows open as layers beside the details; the details stay put underneath.
          onEdit={openEdit}
          onDelete={handleDelete}
          deleteLabel={
            activeRow != null && originationUiFor(activeRow.loan.id).moneyActive
              ? "Reverse & Delete"
              : undefined
          }
          linkedAccountName={
            activeRow ? originationAccountName(activeRow.loan.id) : null
          }
          onRecordPayment={(row, installment) => {
            setPaymentSeq((n) => n + 1);
            setPayment({
              loanId: row.loan.id,
              seq: paymentSeq + 1,
              installmentId: installment?.id ?? null,
            });
          }}
          onRecordPastPayments={(row) => {
            setPaymentSeq((n) => n + 1);
            setPayment({
              loanId: row.loan.id,
              seq: paymentSeq + 1,
              view: "past",
            });
          }}
          onAdditionalDisbursement={(row) =>
            setAdjustment({ row, kind: "disbursement" })
          }
          onToggleClose={handleToggleClose}
          statusBusy={statusBusy}
          history={historyQuery.data}
          historyLoading={historyQuery.isLoading}
          paymentActions={paymentActions}
          onViewPayment={(action) =>
            setViewPayment({
              action,
              all: paymentActions,
              seq: (viewPayment?.seq ?? 0) + 1,
            })
          }
        />

        <RecordedPaymentDialog
          key={
            viewPayment
              ? `payment-${viewPayment.action.id}-${viewPayment.seq}`
              : "payment-closed"
          }
          target={
            viewPayment && activeRow
              ? {
                  source: "loan",
                  row: activeRow,
                  action: viewPayment.action,
                  all: viewPayment.all,
                }
              : null
          }
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
          key={
            adjustment
              ? `${adjustment.kind}-${adjustment.row.loan.id}`
              : "adjustment-closed"
          }
          open={adjustment != null}
          onOpenChange={(open) => !open && setAdjustment(null)}
          kind="disbursement"
          row={adjustment?.row ?? null}
          accounts={accounts}
          onConfirm={async (params) => {
            if (!actions || !adjustment) throw new Error("Not signed in");
            const result = await actions.recordAdditionalDisbursement(
              adjustment.row.loan,
              adjustment.row.installments,
              params,
            );
            await queryClient.invalidateQueries({
              queryKey: ["loan-financial-history"],
              exact: false,
            });
            return result;
          }}
        />

        <RecordPaymentDialog
          key={payment ? `pay-${payment.loanId}-${payment.seq}` : "pay-closed"}
          target={
            paymentRow
              ? {
                  kind: "loan",
                  row: paymentRow,
                  installment:
                    paymentRow.installments.find(
                      (i) => i.id === payment?.installmentId,
                    ) ?? null,
                }
              : null
          }
          initialView={payment?.view}
          open={payment != null && paymentRow != null}
          onOpenChange={(open) => !open && setPayment(null)}
        />

        <AgreementDeleteDialog
          open={deleteTarget != null}
          onOpenChange={(open) => {
            if (!open && !purging) setDeleteTarget(null);
          }}
          kind="loan"
          name={deleteTarget?.name?.trim() || "this loan"}
          loadImpact={loadDeleteImpact}
          onConfirm={confirmPermanentDelete}
          busy={purging}
          outstanding={outstandingOf(
            rows.find((r) => r.loan.id === deleteTarget?.id)?.installments,
          )}
        />

        <LoansTrashDialog
          open={trashOpen}
          onOpenChange={setTrashOpen}
          rows={trashedRows}
          onRestore={handleRestoreLoan}
          onPermanentlyDelete={handlePermanentlyDeleteLoan}
        />
      </StackProvider>
      {/* Edit is the very same screen as Add, pre-filled — see `LoanEmiAddDialog`'s `editRow`. Kept outside the
          StackProvider so it opens exactly like Add (not as a layer over the details). */}
      {editSeq > 0 && editRow && (
        <LoanEmiAddDialog
          key={`edit-${editRow.loan.id}-${editSeq}`}
          open={editOpen}
          editRow={editRow}
          onOpenChange={setEditOpen}
        />
      )}
    </>
  );
}

// Kept importable from here for the other Loan/EMI dialogs that already use them.
export {
  AddElsewhereLink,
  PersonPickerField,
} from "@/features/loans/components/person-picker-field";
