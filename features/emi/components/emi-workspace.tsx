"use client";

import { useCallback, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { EmiScheduleDialog } from "@/features/emi/components/emi-schedule-dialog";
import { useEmiActions, useEmiRows, type EmiRow } from "@/features/emi/hooks/use-emi-data";
import { AgreementDeleteDialog } from "@/features/loans/components/agreement-delete-dialog";
import { runPermanentDeletion } from "@/features/loans/lib/permanent-deletion";
import { RecordPaymentDialog } from "@/features/loans/components/record-payment-dialog";
import { RecordedPaymentDialog } from "@/features/loans/components/recorded-payment-dialog";
import { EMI_PAYMENT_HISTORY_KEY, useEmiPaymentHistory } from "@/features/loans/hooks/use-payment-history";
import { groupRecordedPayments, type RecordedPaymentAction } from "@/features/loans/lib/recorded-payments";
import type { Installment } from "@/lib/models/payment-schedule";
import { errorDetail } from "@/lib/operation-progress/operation-progress";
import { startOperation } from "@/store/operation-progress-store";

export interface EmiWorkspaceProps {
  /** Opens this EMI's detail view — sent by the unified Loan & EMI list; `seq` makes repeat clicks count. */
  openRequest?: { id: string; seq: number } | null;
}

/**
 * Every EMI dialog — schedule/details, record payment, close/reopen, delete — for the unified Loan & EMI
 * workspace, which owns the list and the single Add flow. Renders no list of its own.
 */
export function EmiWorkspace({ openRequest = null }: EmiWorkspaceProps = {}) {
  const searchParams = useSearchParams();
  const { rows } = useEmiRows();
  const actions = useEmiActions();
  const queryClient = useQueryClient();
  const [activeRow, setActiveRow] = useState<EmiRow | null>(null);
  const [handoffDetailId, setHandoffDetailId] = useState<string | null>(() => searchParams.get("agreement"));
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Incremented per open so each Record Payment gets a fresh mount (clean form, new guard state).
  const [paySeq, setPaySeq] = useState(0);
  const [payTarget, setPayTarget] = useState<Installment | null>(null);
  const [statusBusy, setStatusBusy] = useState(false);

  const activeRowFresh = useMemo(() => {
    const id = activeRow?.emi.id ?? handoffDetailId;
    if (!id) return null;
    return rows.find((row) => row.emi.id === id) ?? activeRow;
  }, [rows, activeRow, handoffDetailId]);

  const [seenOpenRequest, setSeenOpenRequest] = useState(openRequest);
  if (openRequest !== seenOpenRequest) {
    setSeenOpenRequest(openRequest);
    const target = openRequest ? rows.find((r) => r.emi.id === openRequest.id) : undefined;
    if (target) setActiveRow(target);
  }

  function openPay(installment: Installment) {
    setPaySeq((n) => n + 1);
    setPayTarget(installment);
  }

  const deleteId = activeRowFresh?.emi.id ?? null;
  const loadDeleteImpact = useCallback(
    () => (actions && deleteId ? actions.previewPermanentDeletion({ id: deleteId }) : Promise.resolve(null)),
    [actions, deleteId],
  );

  // Permanent: the EMI, its schedule and breakdowns go, and its card charges are reversed on the card
  // account — card locked credit, dues and outstanding follow from the EMI being gone.
  async function handleDelete() {
    if (!actions || !activeRowFresh || deleting) return;
    const emi = activeRowFresh.emi;
    setDeleting(true);
    const ok = await runPermanentDeletion({
      kind: "emi",
      run: (onStage) => actions.deleteEmi(emi, { onStage }),
      refresh: () =>
        Promise.all(["cardLinkedEmiPayments", EMI_PAYMENT_HISTORY_KEY].map((key) => queryClient.invalidateQueries({ queryKey: [key], exact: false }))),
      retry: () => setDeleteOpen(true),
    });
    setDeleting(false);
    if (ok) {
      setDeleteOpen(false);
      setActiveRow(null);
      setHandoffDetailId(null);
    }
  }

  async function handleToggleClose(row: EmiRow) {
    if (!actions) return;
    setStatusBusy(true);
    const reopening = row.status === "closed";
    const op = startOperation({
      label: reopening ? "Reopening EMI" : "Closing EMI",
      successLabel: reopening ? "EMI reopened" : "EMI closed",
      errorLabel: "Couldn't update EMI status",
    });
    try {
      op.stage("submit", "Updating status");
      if (reopening) await actions.reopenEmi(row.emi);
      else await actions.closeEmi(row.emi);
      op.succeed();
    } catch (e) {
      op.fail({ detail: errorDetail(e) ?? "Please try again." });
    } finally {
      setStatusBusy(false);
    }
  }

  const detail = activeRowFresh;
  // Recorded payments of the open EMI, grouped per payment action — live-keyed, see `useEmiPaymentHistory`.
  const historyQuery = useEmiPaymentHistory(detail);
  const paymentActions = useMemo(
    () => (detail && historyQuery.data ? groupRecordedPayments(historyQuery.data.payments, detail.installments, "emi") : []),
    [detail, historyQuery.data],
  );
  // Snapshot of the payment opened, with a fresh mount (and idempotency key) per open.
  const [viewPayment, setViewPayment] = useState<{ action: RecordedPaymentAction; all: RecordedPaymentAction[]; seq: number } | null>(null);

  return (
    <>
      <EmiScheduleDialog
        open={detail != null && !deleteOpen && payTarget == null && viewPayment == null}
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
        paymentActions={paymentActions}
        historyLoading={historyQuery.isLoading}
        onViewPayment={(action) => setViewPayment({ action, all: paymentActions, seq: (viewPayment?.seq ?? 0) + 1 })}
      />

      <RecordedPaymentDialog
        key={viewPayment ? `emi-payment-${viewPayment.action.id}-${viewPayment.seq}` : "emi-payment-closed"}
        target={viewPayment && detail ? { source: "emi", row: detail, action: viewPayment.action, all: viewPayment.all, breakdowns: historyQuery.data?.breakdowns ?? [] } : null}
        open={viewPayment != null && detail != null}
        onOpenChange={(open) => !open && setViewPayment(null)}
        onPayRemaining={(installment) => {
          setViewPayment(null);
          openPay(installment);
        }}
      />

      <RecordPaymentDialog
        key={`emi-pay-${paySeq}`}
        target={payTarget && detail ? { kind: "emi", row: detail, installment: payTarget } : null}
        open={payTarget != null && detail != null}
        onOpenChange={(open) => !open && setPayTarget(null)}
      />

      <AgreementDeleteDialog
        open={deleteOpen}
        onOpenChange={(open) => { if (!deleting) setDeleteOpen(open); }}
        kind="emi"
        name={detail?.emi.name?.trim() || "this EMI"}
        loadImpact={loadDeleteImpact}
        onConfirm={handleDelete}
        busy={deleting}
      />
    </>
  );
}
