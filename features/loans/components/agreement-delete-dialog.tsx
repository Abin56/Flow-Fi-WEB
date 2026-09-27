"use client";

import { useEffect, useState } from "react";
import { ConfirmDialog, DestructiveDeleteDialog, type DestructiveDeleteImpactRow } from "@/components/finance";
import { formatCurrency } from "@/lib/format";
import type { AgreementDeletionImpact } from "@/lib/repositories/agreement-deletion";

/**
 * "Delete permanently" for a Loan or EMI entered by mistake. The friction matches the risk, decided from a
 * fresh read of what the agreement owns (`previewAgreementDeletion`), never from the list's cached row:
 *   - nothing recorded against it → one plain confirmation;
 *   - payments, account movements or People entries → FlowFi's type-the-name destructive dialog, listing
 *     only the effects that actually exist ("₹1,00,000 taken back out of HDFC", "3 recorded payments").
 * Deleting is not closing: a real agreement that ended should be closed so it stays in history.
 */
export function AgreementDeleteDialog({
  open,
  onOpenChange,
  kind,
  name,
  loadImpact,
  onConfirm,
  busy,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: "loan" | "emi";
  name: string;
  loadImpact: () => Promise<AgreementDeletionImpact | null>;
  onConfirm: () => void | Promise<void>;
  busy: boolean;
}) {
  const [impact, setImpact] = useState<AgreementDeletionImpact | null | undefined>(undefined);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const label = kind === "loan" ? "loan" : "EMI";

  // Re-read every time the dialog opens — the confirmation must describe the current records.
  const openKey = open ? name : null;
  if (openKey !== loadedFor) {
    setLoadedFor(openKey);
    setImpact(undefined);
  }
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    loadImpact()
      .then((result) => !cancelled && setImpact(result))
      .catch(() => !cancelled && setImpact(null));
    return () => {
      cancelled = true;
    };
  }, [open, loadImpact]);

  if (open && impact && !impact.hasFinancialActivity) {
    return (
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title={`Delete ${name} permanently?`}
        description={`Nothing has been recorded against this ${label}. It and its ${impact.installmentCount} scheduled installment${impact.installmentCount === 1 ? "" : "s"} will be removed. This can't be undone.`}
        variant="destructive"
        confirmLabel={busy ? "Deleting…" : "Delete permanently"}
        loading={busy}
        onConfirm={onConfirm}
      />
    );
  }

  const rows: DestructiveDeleteImpactRow[] | null =
    impact === undefined
      ? null
      : impact === null
        ? [{ label: `Its installments, payments and linked money movements`, count: 1 }]
        : [
            { label: `${impact.installmentCount} installment${impact.installmentCount === 1 ? "" : "s"}, paid and upcoming`, count: impact.installmentCount },
            { label: `${impact.paymentCount} recorded payment${impact.paymentCount === 1 ? "" : "s"}`, count: impact.paymentCount },
            ...impact.accountEffects.map((e) => ({
              label: e.delta > 0 ? `${formatCurrency(e.delta)} goes back into ${e.accountName}` : `${formatCurrency(-e.delta)} is taken back out of ${e.accountName}`,
              count: 1,
            })),
            { label: `${impact.ledgerEntryCount} People ledger entr${impact.ledgerEntryCount === 1 ? "y" : "ies"} it created`, count: impact.ledgerEntryCount },
            { label: `Its dues, outstanding balance and any card credit it holds`, count: 1 },
          ];

  return (
    <DestructiveDeleteDialog
      open={open}
      onOpenChange={onOpenChange}
      entityLabel={label}
      entityName={name}
      impact={rows}
      onConfirm={onConfirm}
      confirming={busy}
    />
  );
}
