"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { HistoricalPeopleReconcile, useHistoricalReconcile } from "@/features/loans/components/historical-people-reconcile";
import { DERIVED_QUERY_PREFIXES } from "@/features/loans/lib/derived-query-prefixes";
import { useHistoricalReimbursement } from "@/features/loans/hooks/use-historical-reimbursement";
import type { RecordedPaymentAction } from "@/features/loans/lib/recorded-payments";
import { usePeopleLedgerEntries } from "@/features/people/hooks/use-people-data";
import { useAccounts } from "@/hooks/use-accounts";
import type { OwnershipSource } from "@/lib/engines/debt-ownership";
import { directSettlementError, directSettlementStatus, isDirectLenderPayment, type DirectSettlementStatus } from "@/lib/engines/direct-lender-settlement";
import type { ReimbursementItem } from "@/lib/engines/historical-reimbursement";
import { formatCurrencyExact } from "@/lib/format";
import type { Installment } from "@/lib/models/payment-schedule";

type Target = { sourceKind: "emi" | "loan"; source: OwnershipSource; installments: readonly Installment[] };

const BUTTON =
  "inline-flex h-8 items-center justify-center rounded-[6px] border border-border-strong bg-card px-3 text-xs font-semibold text-foreground outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

const dayText = (d: Date | null) => (d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` : "");

/**
 * What survives closing a payment screen after "paid directly to the lender": the installment's lender records and its
 * People receipts are compared (`directSettlementStatus`), and a missing People record can be added from here. It only
 * ever writes People receipts — never a lender payment, and never money into or out of an account.
 */
export function DirectPaymentRecovery({ sourceKind, source, installments, installmentId, actions }: Target & { installmentId: string; actions: readonly RecordedPaymentAction[] }) {
  const target = useMemo(() => ({ sourceKind, source, installments, installmentIds: [installmentId] }), [sourceKind, source, installments, installmentId]);
  const { lines, isLoading } = useHistoricalReimbursement(target);
  const { entriesByPersonId, isLoading: entriesLoading } = usePeopleLedgerEntries();
  const [open, setOpen] = useState<number | null>(null);
  const [opened, setOpened] = useState(0);
  const payments = useMemo(() => actions.filter((a) => !a.reversed).flatMap((a) => a.portions), [actions]);
  // Never a claim about what is missing before both sides have been read.
  if (isLoading || entriesLoading) return null;
  const status = directSettlementStatus({
    installmentId,
    obligationKey: `${sourceKind}-inst:${installmentId}`,
    payments,
    entries: Object.values(entriesByPersonId).flat(),
    lines,
  });
  // No share and nothing recorded for anyone: this installment isn't shared, so there is no People side to finish.
  if (!status || status.state === "complete" || (lines.length === 0 && status.state !== "overCredited")) return null;
  const canFinish = status.state !== "overCredited" && payments.some((p) => p.installmentId === installmentId && isDirectLenderPayment(p));
  const money = formatCurrencyExact;
  return (
    <section aria-label="Direct payment and People" className="mt-2 flex flex-col gap-2 rounded-[8px] border border-warning/50 bg-warning/10 p-2.5 text-xs text-foreground" data-testid="direct-recovery" data-state={status.state}>
      <p>
        {status.state === "overCredited" ? (
          <>
            <span className="font-semibold">People and the lender record don&apos;t match.</span> People credit {money(status.credited)} as paid directly to the lender, but {money(status.lenderDirect)} is recorded as paid that way. If that lender payment was undone, revert the receipt in People.
          </>
        ) : status.state === "notCredited" ? (
          <>
            <span className="font-semibold">Lender paid, People not updated.</span> {money(status.lenderDirect)} is recorded as paid directly to the lender, but nobody is credited for it and {money(status.openShare)} still shows as owed.
          </>
        ) : (
          <>
            <span className="font-semibold">People partly credited.</span> Of {money(status.lenderDirect)} paid directly to the lender, {money(status.credited)} is credited in People. If someone else also paid, add it. If not, leave it as it is.
          </>
        )}
      </p>
      {canFinish && open == null && (
        <button
          type="button"
          className={`${BUTTON} self-start`}
          onClick={() => {
            setOpen(opened);
            setOpened((n) => n + 1);
          }}
        >
          Finish People record
        </button>
      )}
      {canFinish && open != null && <FinishPeopleRecord key={open} target={target} status={status} installmentId={installmentId} onClose={() => setOpen(null)} />}
    </section>
  );
}

/** Mounted per attempt: one batch id, so retrying after a lost response never writes a receipt twice. */
function FinishPeopleRecord({
  target,
  status,
  installmentId,
  onClose,
}: {
  target: Target & { installmentIds: string[] };
  status: DirectSettlementStatus;
  installmentId: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { data: allAccounts = [] } = useAccounts();
  const accounts = useMemo(() => allAccounts.filter((a) => a.deletedAt == null), [allAccounts]);
  const reconcile = useHistoricalReconcile({ target, defaultAccountId: "", paidDirectly: true, noBalanceChange: true, defaultDateOf: () => dayText(status.paidOn) });
  const [saved, setSaved] = useState<ReimbursementItem[] | null>(null);
  const [saving, setSaving] = useState(false);
  const items = reconcile.plan.ok ? reconcile.plan.items : [];
  const sequenceNumber = target.installments.find((i) => i.id === installmentId)?.sequenceNumber ?? 0;
  const retrying = saved != null && reconcile.failed.length > 0;
  const invalid =
    saved != null || !reconcile.plan.ok || items.length === 0
      ? null
      : directSettlementError({ lender: [{ installmentId, sequenceNumber, amount: status.uncredited }], items, lines: reconcile.lines, requirePayer: false });
  const blocked = reconcile.loading || !reconcile.plan.ok || items.length === 0 || invalid != null || reconcile.blocker != null;

  async function submit() {
    if (saving || (!retrying && (saved != null || blocked))) return;
    const todo = retrying ? reconcile.failed : items;
    if (!retrying) setSaved(items);
    setSaving(true);
    try {
      const results = await reconcile.run(todo);
      await Promise.all(DERIVED_QUERY_PREFIXES.map((key) => queryClient.invalidateQueries({ queryKey: [key], exact: false })));
      if (todo.every((i) => results[i.key]?.status === "recorded")) onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-[8px] border border-border bg-card p-2.5">
      <p className="font-semibold">Who paid the lender? Up to {formatCurrencyExact(status.uncredited)} can be credited. The lender payment isn&apos;t recorded again.</p>
      <HistoricalPeopleReconcile compact directPaymentLabels noBalanceChange showInstallment={false} state={reconcile} accounts={accounts} locked={saved != null} />
      {invalid != null && (
        <p role="alert" className="font-semibold text-expense">
          {invalid}
        </p>
      )}
      {retrying && !saving && (
        <p role="alert" className="font-semibold text-expense">
          Not saved — retry. Nothing is recorded twice.
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" className={BUTTON} onClick={onClose} disabled={saving}>
          Cancel
        </button>
        <button type="button" className={BUTTON} onClick={() => void submit()} disabled={saving || (retrying ? false : saved != null || blocked)}>
          {saving ? "Saving…" : retrying ? "Retry People record" : "Save People record"}
        </button>
      </div>
    </div>
  );
}
