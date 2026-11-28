"use client";

import { Check, ChevronDown, ReceiptText } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { TheyPaidForm } from "@/features/loans/components/they-paid-form";
import { useTheyPaidForm } from "@/features/loans/components/they-paid-dialog";
import { PaymentSavedMotion } from "@/features/loans/components/payment-awareness";
import { usePeopleActions, usePeopleAdvanceApplications, usePeopleLedgerEntries } from "@/features/people/hooks/use-people-data";
import { advanceSources } from "@/features/people/lib/person-payment-obligations";
import { usePeople } from "@/hooks/use-people";
import type { OwnershipSource } from "@/lib/engines/debt-ownership";
import type { InstallmentParticipant } from "@/lib/engines/installment-participants";
import { reimbursementLineKey } from "@/lib/engines/historical-reimbursement";
import { advanceRemaining, PAYMENT_EPSILON, planAdvanceApplication, round2 } from "@/lib/engines/person-payment";
import { formatCurrency, formatCurrencyExact } from "@/lib/format";
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
  personId,
  onBusyChange,
  onSaved,
  editor,
}: {
  /** True from the moment a receipt starts saving until the panel closes — a stable setter. */
  onBusyChange?: (busy: boolean) => void;
  onSaved?: () => void;
  /** Show only this person's share (a payment screen's row). Everyone else stays unanswered, so nothing is written for them. */
  personId?: string;
  sourceKind: "emi" | "loan";
  source: OwnershipSource;
  installments: readonly Installment[];
  installmentId: string;
  onClose: () => void;
  editor?: { amount: HTMLElement | null; remaining: HTMLElement | null; personName: string };
}) {
  const f = useTheyPaidForm({ sourceKind, source, installments, installmentId, onClosed: () => {
    onSaved?.();
    onClose();
  } });
  const { reconcile, accounts, saved, retrying, saving, success, confirmDisabled, confirmLabel, submit, installment } = f;
  const mine = <T extends { personId: string }>(list: readonly T[]) => (personId ? list.filter((x) => x.personId === personId) : [...list]);
  const openLines = useMemo(() => (personId ? f.openLines.filter((l) => l.personId === personId) : f.openLines), [f.openLines, personId]);
  const general = mine(f.general);
  const { data: people = [] } = usePeople();
  const { entriesByPersonId } = usePeopleLedgerEntries();
  const { applicationsByPersonId } = usePeopleAdvanceApplications();
  const actions = usePeopleActions();
  const [linking, setLinking] = useState<string | null>(null);
  const [linked, setLinked] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const busy = saving || success || linking != null;
  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);

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

  const participants = mine(f.reconcile.lines);
  const line = openLines[0];
  const key = line && reimbursementLineKey(line);
  const amount = (key && reconcile.draft[key]?.amount) || "";
  const typed = round2(Number(amount));
  const validAmount = line != null && Number.isFinite(typed) && typed > PAYMENT_EPSILON && typed <= line.remaining + PAYMENT_EPSILON;
  const projection = saved == null && validAmount ? round2(Math.max(0, line.remaining - typed)) : null;
  const amountError = saved == null && line && amount !== "" && !validAmount ? `Enter a receipt up to ${formatCurrencyExact(line.remaining)}.` : null;
  const savedIntoAccount = saved?.some((item) => !item.recordedEarlier);
  const panel = (
    <section aria-label="Their payment" data-testid="they-paid-panel" className={cn("flex flex-col gap-2", editor ? "@container gap-2.5" : "mt-2 rounded-[8px] border border-border bg-secondary/30 p-2.5")}>
      <div className={cn("flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5", editor && "border-b border-border pb-2.5")}>
        <div className="flex min-w-0 items-center gap-2">
          {editor && <span className="grid size-7 shrink-0 place-items-center rounded-[8px] bg-settle-receivable-tint text-settle-receivable-text"><ReceiptText className="size-4" aria-hidden /></span>}
          <p className={cn("min-w-0 font-semibold break-words text-foreground", editor ? "text-sm leading-tight" : "text-xs")}>
            {editor ? `Receipt from ${editor.personName}` : personId ? "Record receipt" : sourceKind === "loan" ? "Record or link a People receipt" : "They paid"}
            {installment && (editor || !personId) && <span className={cn(editor && "text-xs whitespace-nowrap text-muted-foreground")}>{` · #${installment.sequenceNumber}`}</span>}
          </p>
        </div>
        {editor && line && key && saved == null && (
          <button type="button" disabled={busy} className={cn(BTN, "min-h-7 h-auto rounded-[7px] border-settle-receivable-edge/30 bg-settle-receivable-tint/70 px-2 py-1 text-settle-receivable-text tabular-nums hover:bg-settle-receivable-tint")} onClick={() => reconcile.setLine(key, { choice: "some", amount: String(line.remaining) })}>
            Use remaining {formatCurrencyExact(line.remaining)}
          </button>
        )}
      </div>

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
          <button type="button" className={cn(BTN, "border-border-strong bg-card text-foreground hover:bg-secondary")} disabled={busy || !actions} onClick={() => void link(h.line.personId, h.line.obligationKey)}>
            {linking === h.line.personId ? "Linking…" : `Already received · link ${formatCurrency(h.usable)}`}
          </button>
        </div>
      ))}
      {!editor && general.map((p) => (
        <p key={p.personId} role="note" className="text-[11px] text-muted-foreground" data-testid={`they-paid-general-${p.personId}`}>
          {p.personName} also has {formatCurrency(p.generalCredit ?? 0)} in People that isn&apos;t linked to an installment, so it isn&apos;t counted here.
        </p>
      ))}

      <TheyPaidForm state={reconcile} accounts={accounts} locked={busy || saved != null} personId={personId} inlineAmount={Boolean(editor)} />
      {success && (
        <PaymentSavedMotion
          kind={savedIntoAccount ? "receive" : "recorded"}
          label={savedIntoAccount ? `Receipt saved into ${accounts.find((account) => account.id === reconcile.accountId)?.name ?? "the selected account"}` : "Receipt saved"}
        />
      )}
      {error && (
        <p role="alert" className="text-xs font-semibold text-expense">
          {error}
        </p>
      )}

      <div className={cn("flex flex-wrap items-center justify-end gap-2", editor && "border-t border-border pt-2.5")}>
        <button type="button" className={cn(BTN, "shrink-0 border-border-strong bg-card whitespace-nowrap text-foreground hover:bg-secondary", editor && "border-transparent bg-transparent text-muted-foreground hover:text-foreground")} onClick={onClose} disabled={saving || linking != null || (editor != null && success)}>
          {success || openLines.length === 0 ? "Close" : editor ? "Discard draft" : "Cancel"}
        </button>
        {(openLines.length > 0 || retrying) && !success && (
          <button type="button" className={cn(BTN, "h-auto min-h-8 max-w-full border-primary-accent-text bg-primary py-1 text-center leading-tight text-primary-foreground hover:bg-primary/85", editor && "rounded-[8px] disabled:border-border disabled:bg-secondary disabled:text-muted-foreground disabled:opacity-100")} disabled={confirmDisabled || linking != null} onClick={() => void submit()} data-testid="they-paid-save">
            {success ? "Saved" : confirmLabel}
          </button>
        )}
      </div>
    </section>
  );

  if (!editor) return panel;
  return (
    <>
      {editor.amount && createPortal(
        <div className="grid grid-cols-[minmax(0,6rem)_auto] items-center justify-start gap-x-1.5 gap-y-0.5" data-enter-skip>
          <label className={cn("flex h-8 min-w-0 items-center gap-1 rounded-[8px] border border-border-strong/80 bg-card px-2 focus-within:ring-2 focus-within:ring-ring", amountError && "border-expense")}>
            <span aria-hidden className="text-muted-foreground">₹</span>
            <input
              type="number"
              inputMode="decimal"
              step="0.01"
              autoFocus
              aria-label={`Amount received from ${editor.personName}`}
              aria-invalid={Boolean(amountError)}
              placeholder="Amount"
              className="min-w-0 flex-1 bg-transparent text-xs tabular-nums outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
              value={amount}
              disabled={busy || saved != null || !key}
              onChange={(event) => { if (key) reconcile.setLine(key, { choice: "some", amount: event.target.value }); }}
            />
          </label>
          <Popover open={detailsOpen} onOpenChange={(next) => { if (!busy) setDetailsOpen(next); }}>
            <PopoverTrigger asChild>
              <button type="button" className={cn(BTN, "gap-1 rounded-[8px] border-border-strong/80 bg-card px-2 text-foreground hover:bg-secondary data-[state=open]:border-settle-receivable-edge/55 data-[state=open]:bg-settle-receivable-tint data-[state=open]:text-settle-receivable-text")} aria-label={`Receipt details for ${editor.personName}`} disabled={busy}>
                Details
                <ChevronDown className="size-3 shrink-0" aria-hidden />
              </button>
            </PopoverTrigger>
            <PopoverContent
              aria-label={`Receipt details for ${editor.personName}`}
              align="end"
              side="top"
              sideOffset={8}
              collisionPadding={12}
              className="w-[min(25.5rem,calc(100vw-1.5rem))] max-h-(--radix-popover-content-available-height) overflow-y-auto overscroll-contain rounded-[14px] border border-border-strong/55 p-3"
              onEscapeKeyDown={(event) => { if (busy) event.preventDefault(); }}
              data-enter-skip
            >
              {panel}
            </PopoverContent>
          </Popover>
          {amountError ? (
            <span role="alert" className="col-span-full text-[11px] leading-tight text-expense">{amountError}</span>
          ) : (
            <span role="status" className="col-span-full flex items-center gap-1.5 text-[11px] leading-tight text-muted-foreground">
              <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", success ? "bg-success" : "bg-settle-receivable-edge")} />
              {success ? "Receipt saved" : saving ? "Saving receipt…" : retrying ? "Retry receipt" : "Editing · unsaved"}
            </span>
          )}
        </div>,
        editor.amount,
      )}
      {editor.remaining && projection != null && !success && createPortal(
        <span className="block text-[11px] leading-tight text-muted-foreground">After receipt {formatCurrencyExact(projection)}</span>,
        editor.remaining,
      )}
    </>
  );
}
