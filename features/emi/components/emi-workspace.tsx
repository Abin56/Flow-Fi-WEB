"use client";

import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ConfirmDialog } from "@/components/finance";
import { EmiScheduleDialog } from "@/features/emi/components/emi-schedule-dialog";
import { useEmiActions, useEmiRows, type EmiRow } from "@/features/emi/hooks/use-emi-data";
import { RecordPaymentDialog } from "@/features/loans/components/record-payment-dialog";
import type { Installment } from "@/lib/models/payment-schedule";
import { toast } from "@/store/toast-store";

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
  const [activeRow, setActiveRow] = useState<EmiRow | null>(null);
  const [handoffDetailId, setHandoffDetailId] = useState<string | null>(() => searchParams.get("agreement"));
  const [deleteOpen, setDeleteOpen] = useState(false);
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

  const detail = activeRowFresh;

  return (
    <>
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

      <RecordPaymentDialog
        key={`emi-pay-${paySeq}`}
        target={payTarget && detail ? { kind: "emi", row: detail, installment: payTarget } : null}
        open={payTarget != null && detail != null}
        onOpenChange={(open) => !open && setPayTarget(null)}
      />

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete ${detail?.emi.name ?? "EMI"}?`}
        description="This permanently removes the EMI, its schedule, installments, and payment breakdowns. This action cannot be undone."
        variant="destructive"
        confirmLabel="Delete"
        onConfirm={handleDelete}
      />
    </>
  );
}
