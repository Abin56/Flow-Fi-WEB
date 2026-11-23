"use client";

import { Check } from "lucide-react";
import { useMemo, useState } from "react";
import { TheyPaidForm } from "@/features/loans/components/they-paid-form";
import { useTheyPaidForm } from "@/features/loans/components/they-paid-dialog";
import { usePeopleActions, usePeopleAdvanceApplications, usePeopleLedgerEntries } from "@/features/people/hooks/use-people-data";
import { advanceSources } from "@/features/people/lib/person-payment-obligations";
import { usePeople } from "@/hooks/use-people";
import type { OwnershipSource } from "@/lib/engines/debt-ownership";
import type { InstallmentParticipant } from "@/lib/engines/installment-participants";
import { advanceRemaining, PAYMENT_EPSILON, planAdvanceApplication } from "@/lib/engines/person-payment";
import { formatCurrency } from "@/lib/format";
import type { Installment } from "@/lib/models/payment-schedule";
import type { Person } from "@/lib/models/person";
import { cn } from "@/lib/utils";

const BTN = "inline-flex h-8 items-center justify-center gap-1.5 rounded-[6px] border px-3 text-xs font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

/** Paid · Partially paid · Pending — read from the People Ledger's own share figures. */
export function shareState(p: Pick<InstallmentParticipant, "current">): { label: string; tone: "ok" | "warn" | "open" } | null {
  const c = p.current;
  if (!c || c.share <= PAYMENT_EPSILON) return null;
  if (c.remaining <= PAYMENT_EPSILON) return { label: "Paid", tone: "ok" };
  if (c.received > PAYMENT_EPSILON) return { label: `Partially paid · ${formatCurrency(c.received)} of ${formatCurrency(c.share)}`, tone: "warn" };
  return { label: "Pending", tone: "open" };
}

/**
 * The selected installment's person-side payment, inline (no sheet, no navigation). Three things, all People-side only:
 *  - They paid: a new receipt — the same writer as the past-payment form (`useTheyPaidForm`), amount / date / account.
 *  - Already received: money People already holds from that person as an unapplied ADVANCE is applied to this installment
 *    with the supported `applyPersonAdvance` — it moves no cash and makes no bank transaction.
 *  - Pending: leave it; nothing is written.
 * The lender installment is never touched. Mount with a fresh `key` per open (one batch id per save).
 */
export function TheyPaidPanel({
  sourceKind,
  source,
  installments,
  installmentId,
  onClose,
}: {
  sourceKind: "emi" | "loan";
  source: OwnershipSource;
  installments: readonly Installment[];
  installmentId: string;
  onClose: () => void;
}) {
  const f = useTheyPaidForm({ sourceKind, source, installments, installmentId, onClosed: onClose });
  const { reconcile, accounts, saved, retrying, saving, success, confirmDisabled, confirmLabel, submit, openLines, general, installment } = f;
  const { data: people = [] } = usePeople();
  const { entriesByPersonId } = usePeopleLedgerEntries();
  const { applicationsByPersonId } = usePeopleAdvanceApplications();
  const actions = usePeopleActions();
  const [linking, setLinking] = useState<string | null>(null);
  const [linked, setLinked] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  // Held advance per open person (their advance settles what they owe me) — the only existing way to reuse money already received.
  const held = useMemo(
    () =>
      openLines.map((l) => {
        const available = advanceRemaining(advanceSources(entriesByPersonId[l.personId] ?? []), applicationsByPersonId[l.personId] ?? []);
        const obligation = { key: l.obligationKey, title: `Installment #${l.sequenceNumber}`, date: l.dueDate, createdAt: l.dueDate, amount: l.share, outstanding: l.remaining, side: "theyOwe" as const };
        const plan = planAdvanceApplication({ available, obligations: [obligation], side: "theyOwe", selectedKeys: [l.obligationKey] });
        return { line: l, plan, usable: plan.error == null ? plan.allocation.allocated : 0 };
      }),
    [openLines, entriesByPersonId, applicationsByPersonId],
  );

  async function link(personId: string, obligationKey: string) {
    const h = held.find((x) => x.line.personId === personId && x.line.obligationKey === obligationKey);
    const person = (people as Person[]).find((p) => p.id === personId);
    if (!h || !person || !actions || h.plan.error || linking) return;
    setLinking(personId);
    setError(null);
    try {
      await actions.applyPersonAdvance(person, { targets: h.plan.targets, date: new Date() });
      setLinked((m) => ({ ...m, [`${personId}|${obligationKey}`]: true }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't link it. Nothing was changed.");
    } finally {
      setLinking(null);
    }
  }

  const participants = f.reconcile.lines;
  return (
    <section aria-label="Their payment" data-testid="they-paid-panel" className="mt-2 flex flex-col gap-2 rounded-[8px] border border-border bg-secondary/30 p-2.5">
      <p className="text-xs font-semibold text-foreground">
        {sourceKind === "loan" ? "Record or link a People receipt" : "They paid"}{installment ? ` · Installment #${installment.sequenceNumber}` : ""}
        {sourceKind !== "loan" && <span className="ml-2 font-normal text-muted-foreground">Lender payment is not changed.</span>}
      </p>

      {!reconcile.loading && participants.length === 0 && <p className="text-xs text-muted-foreground">Nobody has a share of this installment in People.</p>}
      {!reconcile.loading && participants.length > 0 && openLines.length === 0 && (
        <p role="status" className="flex items-center gap-1 text-xs font-medium text-success" data-testid="they-paid-nothing-open">
          <Check className="size-3.5" aria-hidden /> Fully received in People.
        </p>
      )}

      {held.filter((h) => h.usable > PAYMENT_EPSILON && !linked[`${h.line.personId}|${h.line.obligationKey}`]).map((h) => (
        <div key={`held-${h.line.personId}`} className="flex flex-wrap items-center justify-between gap-2 rounded-[6px] bg-card px-2.5 py-1.5 text-xs" data-testid={`they-paid-held-${h.line.personId}`}>
          <span className="min-w-0 text-foreground">
            <span className="font-semibold">{h.line.personName}</span> has {formatCurrency(h.usable)} held in People — link it, no new transaction.
          </span>
          <button type="button" className={cn(BTN, "border-border-strong bg-card text-foreground hover:bg-secondary")} disabled={linking != null || !actions} onClick={() => void link(h.line.personId, h.line.obligationKey)}>
            {linking === h.line.personId ? "Linking…" : `Already received · link ${formatCurrency(h.usable)}`}
          </button>
        </div>
      ))}
      {general.map((p) => (
        <p key={p.personId} role="note" className="text-[11px] text-muted-foreground" data-testid={`they-paid-general-${p.personId}`}>
          {p.personName} also has {formatCurrency(p.generalCredit ?? 0)} in People that isn&apos;t linked to an installment, so it isn&apos;t counted here.
        </p>
      ))}

      <TheyPaidForm state={reconcile} accounts={accounts} locked={saved != null && !retrying} />
      {error && (
        <p role="alert" className="text-xs font-semibold text-expense">
          {error}
        </p>
      )}

      <div className="flex items-center justify-end gap-2">
        <button type="button" className={cn(BTN, "border-border-strong bg-card text-foreground hover:bg-secondary")} onClick={onClose} disabled={saving}>
          {success || openLines.length === 0 ? "Close" : "Cancel"}
        </button>
        {openLines.length > 0 && (
          <button type="button" className={cn(BTN, "border-primary-accent-text bg-primary text-primary-foreground hover:bg-primary/85")} disabled={confirmDisabled} onClick={() => void submit()} data-testid="they-paid-save">
            {success ? "Saved" : confirmLabel}
          </button>
        )}
      </div>
    </section>
  );
}
