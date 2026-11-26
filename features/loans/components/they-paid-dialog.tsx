"use client";

import { HandCoins } from "lucide-react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useHistoricalReconcile } from "@/features/loans/components/historical-people-reconcile";
import { TheyPaidForm } from "@/features/loans/components/they-paid-form";
import { PaymentSheet } from "@/features/loans/components/payment-sheet";
import { DERIVED_QUERY_PREFIXES } from "@/features/loans/lib/derived-query-prefixes";
import { useInstallmentBreakdown } from "@/features/loans/hooks/use-installment-breakdown";
import { useAccounts } from "@/hooks/use-accounts";
import type { OwnershipSource } from "@/lib/engines/debt-ownership";
import type { ReimbursementItem } from "@/lib/engines/historical-reimbursement";
import { PAYMENT_EPSILON } from "@/lib/engines/person-payment";
import { formatCurrency } from "@/lib/format";
import type { Installment } from "@/lib/models/payment-schedule";

const SUCCESS_HOLD_MS = 900;

const todayText = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/**
 * "They paid": the assigned person has already paid their share of ONE installment — record it from the schedule, without
 * leaving the screen. This is the People side only: it writes the same per-person People receipt as the past-payment form
 * (`useHistoricalReconcile` → `PersonPaymentRepository.recordPayment`, one idempotent write per person), and never touches
 * the lender installment — whether the BANK was paid is a separate fact (Pay / Record past payment).
 *
 * Nothing is duplicated: a share People already shows as received is listed as "Received earlier" and can't be answered
 * again; money People holds as a general payment (no installment chosen) is only pointed out, never assigned here.
 *
 * Mount with a fresh `key` per open — the batch id (and so every idempotency key) belongs to the mount, which is what makes
 * a retry after a lost response a no-op for what already committed.
 */
export function useTheyPaidForm({
  onClosed,
  sourceKind,
  source,
  installments,
  installmentId,
}: {
  /** Called a moment after everything saved (closes the dialog / folds the panel). */
  onClosed: () => void;
  sourceKind: "emi" | "loan";
  source: OwnershipSource;
  installments: readonly Installment[];
  installmentId: string;
}) {
  const queryClient = useQueryClient();
  const { data: allAccounts = [] } = useAccounts();
  const accounts = useMemo(() => allAccounts.filter((a) => a.deletedAt == null), [allAccounts]);
  const installment = installments.find((i) => i.id === installmentId) ?? null;
  const target = useMemo(() => ({ sourceKind, source, installments, installmentIds: [installmentId] }), [sourceKind, source, installments, installmentId]);
  const reconcile = useHistoricalReconcile({ target, defaultAccountId: "", defaultDateOf: () => todayText() });
  const { breakdown } = useInstallmentBreakdown({ sourceKind, source, installments, installmentId });
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  // Frozen at the first save: exactly what the user answered. A retry only re-sends what didn't commit.
  const [saved, setSaved] = useState<ReimbursementItem[] | null>(null);

  const items = reconcile.plan.ok ? reconcile.plan.items : [];
  const total = reconcile.plan.ok ? reconcile.plan.summary.total : 0;
  const retrying = saved != null && reconcile.failed.length > 0;
  const openLines = reconcile.lines.filter((l) => l.remaining > PAYMENT_EPSILON);
  // Paid toward their overall balance with no installment chosen — shown, never assigned (that is People's own explicit action).
  const general = (breakdown?.participants ?? []).filter((p) => (p.generalCredit ?? 0) > 0.005 && (p.current?.remaining ?? 0) > PAYMENT_EPSILON);

  const blocked = reconcile.loading || !reconcile.plan.ok || reconcile.blocker != null || items.length === 0;
  const confirmDisabled = saving || success || (retrying ? false : blocked);
  const confirmLabel = saving ? "Saving…" : success ? "Saved" : retrying ? "Retry what didn't save" : "Record Received";

  async function submit() {
    if (saving || success) return;
    if (!retrying && blocked) return;
    const todo = retrying ? reconcile.failed : items;
    if (!retrying) setSaved(items);
    setSaving(true);
    try {
      const r = await reconcile.run(todo);
      const failedNow = todo.filter((i) => r[i.key]?.status === "failed").length;
      await Promise.all(DERIVED_QUERY_PREFIXES.map((key) => queryClient.invalidateQueries({ queryKey: [key], exact: false })));
      if (failedNow === 0) {
        setSuccess(true);
        window.setTimeout(onClosed, SUCCESS_HOLD_MS);
      }
    } finally {
      setSaving(false);
    }
  }
  return { reconcile, accounts, installment, saving, success, saved, retrying, openLines, general, items, total, confirmDisabled, confirmLabel, submit };
}

export function TheyPaidDialog({
  open,
  onOpenChange,
  ...rest
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sourceKind: "emi" | "loan";
  source: OwnershipSource;
  installments: readonly Installment[];
  installmentId: string;
}) {
  const f = useTheyPaidForm({ ...rest, onClosed: () => onOpenChange(false) });
  const { reconcile, accounts, installment, saving, success, saved, retrying, openLines, general, confirmDisabled, confirmLabel, submit } = f;

  return (
    <PaymentSheet
      open={open}
      onOpenChange={onOpenChange}
      eyebrow="People ledger"
      icon={HandCoins}
      title="Record a People receipt"
      description={installment ? `Installment #${installment.sequenceNumber} · due ${installment.dueDate.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}` : undefined}
      onConfirm={submit}
      confirmLabel={confirmLabel}
      confirmDisabled={confirmDisabled}
      loading={saving}
      success={success}
      cancelLabel={saved != null && !retrying ? "Close" : "Cancel"}
    >
      <div className="mx-auto flex w-full max-w-[36rem] flex-col gap-2.5" data-testid="they-paid">
        <p className="text-xs text-muted-foreground">The receipt saves immediately and updates the person’s share.</p>
        {general.map((p) => (
          <p key={p.personId} role="note" className="rounded-[8px] border border-border bg-secondary/60 px-3 py-2 text-xs text-foreground" data-testid={`they-paid-general-${p.personId}`}>
            <span className="font-semibold">{p.personName}</span> has {formatCurrency(p.generalCredit ?? 0)} in People that isn&apos;t linked to an installment, so it isn&apos;t counted here. If it covers this one, apply it in{" "}
            <Link href={`/people?person=${encodeURIComponent(p.personId)}`} className="font-semibold underline underline-offset-2">
              People
            </Link>{" "}
            instead of recording it again.
          </p>
        ))}
        {!reconcile.loading && reconcile.lines.length > 0 && openLines.length === 0 && (
          <p role="status" className="rounded-[8px] border border-success/40 bg-success/10 px-3 py-2 text-xs font-semibold text-success" data-testid="they-paid-nothing-open">
            Everything for this installment is already received in People.
          </p>
        )}
        {!reconcile.loading && reconcile.lines.length === 0 && <p className="text-xs text-muted-foreground">Nobody has a share of this installment in People.</p>}
        <TheyPaidForm state={reconcile} accounts={accounts} locked={saved != null && !retrying} />
      </div>
    </PaymentSheet>
  );
}
