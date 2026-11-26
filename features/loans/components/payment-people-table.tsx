"use client";

import { useCallback, useRef, useState } from "react";
import { CalendarClock, Check, ChevronRight, Loader2 } from "lucide-react";
import { TheyPaidPanel } from "@/features/loans/components/they-paid-panel";
import { useGlobalCycle } from "@/features/month-cycle/hooks/use-global-cycle";
import { usePeopleLedgerEntries } from "@/features/people/hooks/use-people-data";
import { isActualReceipt } from "@/features/loans/lib/received-history";
import { isInCycle } from "@/lib/engines/month-cycle-range";
import { usePaymentDeferralActions, usePeoplePaymentDeferrals } from "@/features/people/hooks/use-payment-deferrals";
import { useMonthCycleStartDay } from "@/features/settings/hooks/use-user-preferences";
import type { OwnershipSource } from "@/lib/engines/debt-ownership";
import type { InstallmentBreakdown, InstallmentParticipant, ShareLine } from "@/lib/engines/installment-participants";
import { PAYMENT_EPSILON, round2 } from "@/lib/engines/person-payment";
import { cycleContaining, formatCycleLabel, formatStatementDate } from "@/lib/engines/person-cycle-statement";
import { cycleName, deferralView, type DeferralView } from "@/lib/engines/person-payment-deferral";
import { projectDueNow, quickPostpone, type QuickPostpone } from "@/lib/engines/person-due-now";
import { formatCurrency, formatCurrencyExact } from "@/lib/format";
import type { Installment } from "@/lib/models/payment-schedule";
import type { PersonPaymentDeferral } from "@/lib/models/person-payment-deferral";
import { cn } from "@/lib/utils";
import styles from "./payment-contributions.module.css";
import { generateId } from "@/lib/utils/id-generator";
import { toast } from "@/store/toast-store";

/** The one receipt panel that can be open: whose share, of which installment. `n` gives each opening a fresh batch id. */
export interface ReceiptTarget {
  personId: string;
  personName: string;
  installmentId: string;
  line: ShareLine;
}

export interface OpenReceipt extends ReceiptTarget {
  n: number;
}

/**
 * "I pay" on a shared Loan / EMI: one compact table — my part, then each person's share · received · remaining · what can
 * be done — and under it the one summary. Every figure is read from its own source and nothing is netted:
 *  - To lender: this installment's unpaid lender amount;
 *  - People owe: the shares still open in People on this agreement, up to this installment;
 *  - Due now / Postponed: those same open shares against TODAY's cycle (`projectDueNow`, read-only).
 * "Me" is my part of the cost — never a receivable, so it has no received or remaining figure and no action.
 *
 * A person's earlier unpaid shares unfold under their row with the same two actions, each against that installment's
 * own People item. When the payment covers several installments (`coverageBreakdown`) the person's row totals them and
 * each covered installment has its own line and actions.
 *
 * "Receive" opens the existing People receipt panel for that one person and installment (a real receipt with its own
 * amount, date and account, or a held advance applied — never a tick-box). It saves on its own, at once: closing or
 * cancelling the lender payment doesn't undo it. While it is saving, no other receipt can be opened.
 *
 * "Postpone" is People's own postponement (`paymentDeferrals`) in one click: it moves only WHEN the money is expected —
 * no receipt, no account, no card, nothing new owed, and the lender's EMI stays as it is. Once a share is expected in a
 * later cycle it can't be pushed again until that cycle arrives (`quickPostpone`).
 */
export function PaymentPeopleTable({
  breakdown,
  loading,
  sourceKind,
  source,
  installments,
  installmentId,
  receiving,
  onReceiving,
  receiptBusy,
  onReceiptBusy,
  agreementName,
  cardEmi = false,
}: {
  /** The EMI's money sits on a credit card: what is unpaid is the card EMI, not a payment to a lender. */
  cardEmi?: boolean;
  breakdown: InstallmentBreakdown | null;
  loading: boolean;
  sourceKind: "emi" | "loan";
  source: OwnershipSource;
  installments: readonly Installment[];
  installmentId: string;
  receiving: OpenReceipt | null;
  onReceiving: (target: ReceiptTarget | null) => void;
  /** A receipt is being written: nothing may close or replace its panel until it finishes. */
  receiptBusy: boolean;
  onReceiptBusy: (busy: boolean) => void;
  /** Names a postponed item in People's own history. */
  agreementName: string;
}) {
  const startDay = useMonthCycleStartDay();
  const { cycleRange, label: selectedCycle } = useGlobalCycle();
  const { entriesByPersonId, isLoading: ledgerLoading } = usePeopleLedgerEntries();
  const participants = breakdown?.participants ?? [];
  const personIds = participants.map((p) => p.personId);
  const { deferralsByPerson } = usePeoplePaymentDeferrals(personIds);
  // Loaded = every person's records have actually arrived (they publish together). The watch's own flag turns off on its
  // empty placeholder, which would briefly offer Postpone on a share that is already postponed.
  const timingLoading = !personIds.every((id) => deferralsByPerson[id] != null);
  const deferralActions = usePaymentDeferralActions();
  const [saving, setSaving] = useState<ReadonlySet<string>>(() => new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [savedReceipts, setSavedReceipts] = useState<ReadonlySet<string>>(() => new Set());
  const [savedDeferrals, setSavedDeferrals] = useState<ReadonlySet<string>>(() => new Set());
  const [receiptAmount, setReceiptAmount] = useState<HTMLDivElement | null>(null);
  const [receiptRemaining, setReceiptRemaining] = useState<HTMLDivElement | null>(null);
  const table = useRef<HTMLTableElement>(null);
  // A ref, not state: a double click lands before the re-render that disables the button.
  const inFlight = useRef(new Set<string>());
  // One id per share and stored revision: a repeat of the same click is recognised as already applied, never a second move.
  const requestIds = useRef(new Map<string, string>());
  const idOf = (personId: string, line: ShareLine) => `${personId}|${line.key}`;
  const deferralOf = (personId: string, key: string): PersonPaymentDeferral | null => (deferralsByPerson[personId] ?? []).find((d) => d.obligationKey === key) ?? null;
  const viewOf = (personId: string, line: ShareLine): DeferralView | null => {
    const d = deferralOf(personId, line.key);
    return d ? deferralView(d, line.remaining, startDay) : null;
  };

  async function postpone(personId: string, line: ShareLine) {
    const id = idOf(personId, line);
    if (inFlight.current.has(id) || timingLoading) return;
    const now = new Date();
    const current = deferralOf(personId, line.key);
    const quick = quickPostpone({ deferral: current, obligationDate: line.dueDate, startDay, today: now });
    if (!quick.allowed || line.remaining <= PAYMENT_EPSILON) return;
    inFlight.current.add(id);
    setSaving((s) => new Set(s).add(id));
    setErrors((e) => ({ ...e, [id]: "" }));
    const intent = `${id}@${current?.revision ?? 0}`;
    let requestId = requestIds.current.get(intent);
    if (!requestId) requestIds.current.set(intent, (requestId = generateId()));
    try {
      const result = await deferralActions.apply({
        action: "postpone",
        requestId,
        expectedRevision: current?.revision ?? 0,
        personId,
        obligationKey: line.key,
        obligationTitle: `${agreementName} · Installment #${line.sequenceNumber}`,
        obligationDate: line.dueDate,
        remaining: line.remaining,
        target: quick.target,
        targetDate: null,
        reason: null,
        note: null,
        reminder: null,
        startDay,
        now,
      });
      if (result.outcome === "written") {
        setSavedDeferrals((s) => new Set(s).add(id));
        toast.success(`Payment moved to the ${cycleName(quick.target)} cycle`, "Still owed — no money moved, and the lender EMI is unchanged.");
      }
    } catch (e) {
      setErrors((prev) => ({ ...prev, [id]: e instanceof Error ? e.message : "Couldn't postpone it. Nothing was changed." }));
    } finally {
      inFlight.current.delete(id);
      setSaving((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
    }
  }

  if (participants.length === 0 && !receiving) {
    return loading ? (
      <p role="status" className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" aria-hidden /> Checking who shares this installment…
      </p>
    ) : null;
  }
  const th = "px-2 py-1.5 text-[10.5px] font-bold tracking-[0.06em] text-muted-foreground uppercase";
  const range = breakdown?.covered ?? null;
  const sequenceNumber = range ? range.last : installments.find((i) => i.id === installmentId)?.sequenceNumber;
  // A fully received earlier share can remove its person from the breakdown during the save refresh.
  const rows = receiving && !participants.some((p) => p.personId === receiving.personId)
    ? [...participants, { personId: receiving.personId, personName: receiving.personName, current: receiving.line, carried: [], outstanding: receiving.line.remaining }]
    : participants;
  const closeReceipt = () => {
    const row = receiptAmount?.closest("tr");
    const focusWasInEditor = row?.contains(document.activeElement) || document.activeElement?.closest('[data-testid="they-paid-panel"]');
    onReceiving(null);
    if (focusWasInEditor) requestAnimationFrame(() => {
      const yes = row?.querySelector<HTMLButtonElement>("[data-receipt-yes]");
      if (yes && !yes.disabled) yes.focus();
      else if (row instanceof HTMLElement && row.isConnected) row.focus();
      else table.current?.focus();
    });
  };
  // The open shares shown here against TODAY's cycle (read-only, `projectDueNow`). A share dated after it isn't due yet either.
  const thisCycle = cycleContaining(new Date(), startDay);
  const cycleEnd = new Date(thisCycle.end.getFullYear(), thisCycle.end.getMonth(), thisCycle.end.getDate(), 23, 59, 59, 999).getTime();
  const split = participants.reduce(
    (sum, p) => {
      const lines = [...p.carried, ...(p.covered ?? (p.current ? [p.current] : []))].filter((l) => l.remaining > PAYMENT_EPSILON && l.dueDate.getTime() <= cycleEnd);
      const projection = projectDueNow({
        total: lines.reduce((t, l) => t + l.remaining, 0),
        rows: lines.map((l) => ({ key: l.key, kind: "obligation" as const, date: l.dueDate, signedAmount: l.share, remainingNow: l.remaining })),
        deferrals: deferralsByPerson[p.personId] ?? [],
        cycle: thisCycle,
        startDay,
      });
      return { dueNow: sum.dueNow + (projection?.dueNow ?? 0), postponed: sum.postponed + (projection?.postponed ?? 0) };
    },
    { dueNow: 0, postponed: 0 },
  );
  const notYetDue = round2((breakdown?.othersOwe ?? 0) - split.dueNow - split.postponed);

  /** What a share line shows under "Remaining", and what can be done about it. */
  const lineState = (p: InstallmentParticipant, line: ShareLine) => {
    const id = idOf(p.personId, line);
    const datedReceipts = entriesByPersonId[p.personId]?.filter((e) =>
      isActualReceipt(e) && e.obligationRef === line.key && e.receivedDateKnown !== false && isInCycle(e.date, cycleRange),
    );
    return {
      cycleReceived: datedReceipts == null
        ? ledgerLoading ? "Cycle receipts loading…" : "Cycle receipts unavailable"
        : `${formatCurrencyExact(round2(datedReceipts.reduce((sum, receipt) => sum + receipt.amount, 0)))} this cycle`,
      receiptSaved: savedReceipts.has(`${p.personId}|${line.installmentId}`),
      postponementSaved: savedDeferrals.has(id),
      status: line.remaining > PAYMENT_EPSILON ? postponedText(viewOf(p.personId, line)) : null,
      quick: quickPostpone({ deferral: deferralOf(p.personId, line.key), obligationDate: line.dueDate, startDay }),
      timingLoading,
      postponing: saving.has(id),
      error: errors[id] || null,
      receivingOpen: receiving?.personId === p.personId && receiving.installmentId === line.installmentId,
      receiptBusy,
      amountAnchor: setReceiptAmount,
      remainingAnchor: setReceiptRemaining,
      onReceive: (isOpen: boolean) => onReceiving(isOpen ? null : { personId: p.personId, personName: p.personName, installmentId: line.installmentId, line }),
      onPostpone: () => void postpone(p.personId, line),
    };
  };

  return (
    <div className="flex flex-col gap-2">
      <div className={styles.container}>
        <table ref={table} tabIndex={-1} role="table" className={cn(styles.table, "text-xs")} aria-label="Who shares this installment">
          <thead role="rowgroup">
            <tr role="row" className="border-b border-border">
              <th scope="col" className={cn(th, "text-left")}>Person</th>
              <th scope="col" className={cn(th, styles.share, "text-right")}>Share</th>
              <th scope="col" className={cn(th, styles.received, "text-right")} title="Amount applied to this share, including advance">Received</th>
              <th scope="col" className={cn(th, styles.remaining, "text-right")}>Remaining</th>
              <th scope="col" className={cn(th, styles.paid, "text-left")}>Paid?</th>
              <th scope="col" className={cn(th, styles.action, "text-left")}>Amount / Action</th>
            </tr>
          </thead>
          {breakdown && breakdown.yourShare > PAYMENT_EPSILON && (
            <tbody role="rowgroup" className="border-b border-border/70">
              <tr role="row" className={styles.row} data-testid="share-row-me" title="Your part of this installment — your cost, not money anyone owes you.">
                <th role="rowheader" scope="row" className="px-2 py-1.5 text-left font-semibold text-foreground">
                  Me
                  {range && <span className={cn(NOTE, "block text-muted-foreground")}>#{range.first}–#{range.last}</span>}
                </th>
                <td role="cell" data-label="Share" className="px-2 py-2 text-right font-semibold text-foreground tabular-nums">{formatCurrency(breakdown.yourShare)}</td>
                <td role="cell" data-label="Received" className="px-2 py-1.5 text-right text-muted-foreground">—</td>
                <td role="cell" data-label="Remaining" className="px-2 py-2 text-right text-muted-foreground">—</td>
                <td role="cell" />
                <td role="cell" />
              </tr>
            </tbody>
          )}
          {rows.map((p) => {
            const mine = receiving?.personId === p.personId ? receiving : null;
            // A receipt open on an earlier share keeps that list unfolded.
            const unfolded = expanded.has(p.personId) || (mine != null && p.carried.some((l) => l.installmentId === mine.installmentId));
            const editingLineMissing = mine && ![p.current, ...(p.covered ?? []), ...p.carried].some((line) => line?.installmentId === mine.installmentId);
            return (
              <tbody role="rowgroup" key={p.personId} className="border-b border-border/70 last:border-b-0">
                <PersonRow
                  participant={p}
                  state={p.current ? lineState(p, p.current) : null}
                  unfolded={unfolded}
                  postponedEarlier={p.carried.filter((l) => viewOf(p.personId, l)?.status === "postponed").length}
                  // With several covered installments every line stays on screen — none is hidden behind a total.
                  onToggleEarlier={() =>
                    setExpanded((s) => {
                      const next = new Set(s);
                      if (next.has(p.personId)) next.delete(p.personId);
                      else next.add(p.personId);
                      return next;
                    })
                  }
                />
                {p.covered?.map((line) => (
                  <InstallmentRow key={line.key} personName={p.personName} line={line} state={lineState(p, line)} inPayment />
                ))}
                {unfolded &&
                  p.carried.map((line) => (
                    <InstallmentRow key={line.key} personName={p.personName} line={line} state={lineState(p, line)} />
                  ))}
                {/* A refreshed ledger can remove a fully received carried share before the receipt save finishes. */}
                {editingLineMissing && <InstallmentRow personName={p.personName} line={mine.line} state={lineState(p, mine.line)} />}
              </tbody>
            );
          })}
        </table>
      </div>
      {receiving && (
        <TheyPaidPanel
          key={receiving.n}
          sourceKind={sourceKind}
          source={source}
          installments={installments}
          installmentId={receiving.installmentId}
          personId={receiving.personId}
          editor={{ amount: receiptAmount, remaining: receiptRemaining, personName: receiving.personName }}
          onBusyChange={onReceiptBusy}
          onSaved={() => setSavedReceipts((s) => new Set(s).add(`${receiving.personId}|${receiving.installmentId}`))}
          onClose={closeReceipt}
        />
      )}

      {breakdown && (
        <dl className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border pt-2" aria-label="People summary" data-testid="people-summary">
          <Figure
            label="People owe"
            value={formatCurrency(breakdown.othersOwe)}
            note={notYetDue > PAYMENT_EPSILON ? `${formatCurrency(notYetDue)} not due yet` : sequenceNumber != null ? `Up to #${sequenceNumber}` : undefined}
          />
          <Figure label="Due now" value={timingLoading ? "…" : formatCurrency(round2(split.dueNow))} />
          <Figure label="Postponed" value={timingLoading ? "…" : formatCurrency(round2(split.postponed))} />
        </dl>
      )}
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span title="Includes dated receipts linked to each installment">Cycle receipts · {selectedCycle}</span>
        <span>People receipts save separately and stay saved if you cancel {cardEmi ? "this EMI" : "the lender payment"}.</span>
      </p>
    </div>
  );
}

const ACTION = "inline-flex h-7 items-center gap-1 rounded-[6px] border px-2 text-xs font-semibold whitespace-nowrap outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";
const NOTE = "text-[11px] leading-snug font-normal";

/** Short status under the amount: where the open share is expected now. */
function postponedText(view: DeferralView | null): string | null {
  if (!view || view.status === "resolved") return null;
  if (view.status === "postponed") return `Postponed to ${view.date ? formatStatementDate(view.date) : cycleName(view.cycle)}`;
  if (view.status === "expectedNow") return view.date ? "Expected today" : "Expected this cycle";
  return `Was due ${view.date ? formatStatementDate(view.date) : cycleName(view.cycle)}`;
}

interface LineState {
  cycleReceived: string;
  receiptSaved: boolean;
  postponementSaved: boolean;
  status: string | null;
  quick: QuickPostpone;
  timingLoading: boolean;
  postponing: boolean;
  error: string | null;
  receivingOpen: boolean;
  receiptBusy: boolean;
  amountAnchor: (node: HTMLDivElement | null) => void;
  remainingAnchor: (node: HTMLDivElement | null) => void;
  onReceive: (open: boolean) => void;
  onPostpone: () => void;
}

function Figure({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
      <dt className="text-[11px] font-medium text-muted-foreground">{label}</dt>
      <dd className="text-xs font-semibold text-foreground tabular-nums">{value}</dd>
      {note && <dd className="text-[11px] text-muted-foreground">· {note}</dd>}
    </div>
  );
}

/** Share · Received · Remaining of one People item — the item's own figures. */
function Amounts({ line, state, held }: { line: ShareLine | null; state: LineState | null; held?: React.ReactNode }) {
  const fromAdvance = line?.fromAdvance ?? 0;
  const owing = line != null && line.remaining > PAYMENT_EPSILON;
  const remainingAnchor = state?.remainingAnchor;
  const attachRemaining = useCallback((node: HTMLDivElement | null) => remainingAnchor?.(node), [remainingAnchor]);
  return (
    <>
      <td role="cell" data-label="Share" className="px-2 py-1.5 text-right font-semibold text-foreground tabular-nums">{line ? formatCurrencyExact(line.share) : "—"}</td>
      <td role="cell" data-label="Received" className={cn("px-2 py-1.5 text-right tabular-nums", line && line.received > PAYMENT_EPSILON ? "text-success" : "text-muted-foreground")}>
        {line ? formatCurrencyExact(line.received) : "—"}
        {line && state?.cycleReceived && <span className={cn(NOTE, "block text-muted-foreground")}>{state.cycleReceived}</span>}
        {fromAdvance > PAYMENT_EPSILON && (
          <span className={cn(NOTE, "block text-settle-advance-text")}>
            {line && line.received - fromAdvance > PAYMENT_EPSILON ? `${formatCurrency(fromAdvance)} of it from advance` : "from advance"}
          </span>
        )}
      </td>
      <td role="cell" data-label="Remaining" className="px-2 py-1.5 text-right tabular-nums" data-testid={line ? `share-line-${line.key}` : undefined}>
        <span className={cn("font-semibold", owing ? "text-foreground" : "text-muted-foreground")}>{line ? formatCurrencyExact(line.remaining) : "—"}</span>
        {state?.receivingOpen && <div ref={attachRemaining} />}
        {owing && state?.status && (
          <span className={cn(NOTE, "flex items-center justify-end gap-1 text-settle-receivable-text")}>
            <CalendarClock className="size-3 shrink-0" aria-hidden />
            {state.status}
          </span>
        )}
        {owing && held}
      </td>
    </>
  );
}

function Actions({ personName, line, state }: { personName: string; line: ShareLine | null; state: LineState | null }) {
  const [pendingAnswer, setPendingAnswer] = useState(false);
  const [keptPending, setKeptPending] = useState(false);
  const [postponeTarget, setPostponeTarget] = useState<number | null>(null);
  const owing = line != null && line.remaining > PAYMENT_EPSILON;
  const amountAnchor = state?.amountAnchor;
  const attachAmount = useCallback((node: HTMLDivElement | null) => amountAnchor?.(node), [amountAnchor]);
  return (
    <>
      <td role="cell" className="px-2 py-1.5">
        {line && state && (owing || state.receivingOpen) ? (
          <div className="inline-flex gap-1" role="group" aria-label={`Has ${personName} paid you?`}>
            <button
              type="button"
              disabled={state.receiptBusy || state.postponing}
              aria-pressed={state.receivingOpen}
              aria-label={`Yes, receive from ${personName} for installment ${line.sequenceNumber}`}
              data-receipt-yes
              onClick={() => {
                setPendingAnswer(false);
                setKeptPending(false);
                setPostponeTarget(null);
                state.onReceive(state.receivingOpen);
              }}
              className={cn(ACTION, state.receivingOpen ? "border-settle-receivable-text/50 bg-settle-receivable-tint text-settle-receivable-text" : "border-border bg-card text-foreground hover:bg-settle-receivable-tint")}
            >
              Yes
            </button>
            <button
              type="button"
              aria-label={`No, no new receipt from ${personName} for installment ${line.sequenceNumber}`}
              aria-pressed={pendingAnswer}
              disabled={state.receiptBusy || state.postponing || !owing}
              className={cn(ACTION, pendingAnswer ? "border-border-strong bg-secondary text-foreground" : "border-border bg-card text-foreground hover:bg-secondary")}
              onClick={() => {
                if (state.receivingOpen) state.onReceive(true);
                setPendingAnswer(!pendingAnswer || keptPending);
                setKeptPending(false);
                setPostponeTarget(null);
              }}
            >
              No
            </button>
          </div>
        ) : line ? (
          <span className="inline-flex h-7 items-center gap-1 font-semibold text-success">
            <Check className="size-3.5" aria-hidden /> Settled
          </span>
        ) : null}
      </td>
      <td role="cell" className="px-2 py-1.5">
        {state?.receivingOpen && <div ref={attachAmount} />}
        {owing && line && state && pendingAnswer && (
          <div className="flex flex-col gap-1">
            <span className="text-[11px] text-muted-foreground">₹0 received for this answer</span>
            {keptPending ? (
              <span role="status" className="text-xs text-muted-foreground">{state.quick.allowed ? "Kept pending" : "Existing postponement kept"}</span>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                <button type="button" disabled={state.postponing || state.receiptBusy} className={cn(ACTION, "border-border bg-card text-foreground")} onClick={() => { setKeptPending(true); setPostponeTarget(null); }}>
                  {state.quick.allowed ? "Keep pending" : "Keep as scheduled"}
                </button>
                <button
                  type="button"
                  disabled={!state.quick.allowed || state.timingLoading || state.postponing || state.receivingOpen || state.receiptBusy || state.postponementSaved}
                  aria-busy={state.postponing}
                  aria-label={
                    state.quick.allowed
                      ? `Postpone ${personName}'s ${formatCurrency(line.remaining)} for installment ${line.sequenceNumber} to the ${cycleName(state.quick.target)} cycle`
                      : `${personName}'s share of installment ${line.sequenceNumber} is already postponed`
                  }
                  title={
                    state.quick.allowed
                      ? `Expect it in the ${cycleName(state.quick.target)} cycle. No money moves; the lender EMI is unchanged. To undo, open ${personName} in People.`
                      : `Already expected in the ${cycleName(state.quick.cycle)} cycle. You can postpone again once that cycle starts.`
                  }
                  onClick={() => { if (state.quick.allowed) setPostponeTarget(state.quick.target.start.getTime()); }}
                  className={cn(ACTION, "border-border-strong bg-card text-foreground hover:bg-secondary")}
                >
                  {state.postponing ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <CalendarClock className="size-3.5" aria-hidden />}
                  {!state.quick.allowed || state.postponementSaved ? "Postponed" : "Postpone"}
                </button>
              </div>
            )}
            {state.quick.allowed && !state.postponementSaved && postponeTarget === state.quick.target.start.getTime() && (
              <div className="flex flex-wrap items-center gap-1.5 text-xs text-foreground">
                <span className="basis-full">{formatCurrencyExact(line.remaining)} · {formatCycleLabel(state.quick.target)}</span>
                <button type="button" disabled={state.timingLoading || state.postponing || state.receiptBusy} className={cn(ACTION, "border-border bg-secondary text-foreground")} onClick={state.onPostpone}>Confirm postponement</button>
                <button type="button" disabled={state.postponing} onClick={() => setPostponeTarget(null)} className="min-h-7 px-1 text-muted-foreground">Cancel</button>
              </div>
            )}
          </div>
        )}
        {state?.error && (
          <span role="alert" className="mt-1 block text-[11px] leading-snug font-medium text-expense">{state.error}</span>
        )}
        {state?.receiptSaved && !state.receivingOpen && <span role="status" className="block text-xs font-medium text-success">Receipt saved</span>}
        {state?.postponementSaved && (
          <span role="status" className="mt-1 flex items-center gap-1 text-xs text-settle-receivable-text motion-safe:animate-in motion-safe:fade-in-0">
            <CalendarClock className="size-3.5" aria-hidden /> Postponement saved
          </span>
        )}
      </td>
    </>
  );
}

function PersonRow({ participant: p, state, unfolded, postponedEarlier, onToggleEarlier }: { participant: InstallmentParticipant; state: LineState | null; unfolded: boolean; postponedEarlier: number; onToggleEarlier: () => void }) {
  const cur = p.current;
  const held = p.advanceHeld ?? 0;
  const general = p.generalCredit ?? 0;
  const carriedTotal = p.carried.reduce((t, l) => t + l.remaining, 0);
  const anyOpen = p.outstanding > PAYMENT_EPSILON;
  // Several covered installments: this row only totals them; each has its own line and actions beneath.
  const total = p.covered ? p.covered.reduce((t, l) => ({ share: t.share + l.share, received: t.received + l.received, remaining: t.remaining + l.remaining }), { share: 0, received: 0, remaining: 0 }) : null;
  return (
    <tr role="row" tabIndex={-1} className={cn(styles.row, "align-top")} data-testid={`share-row-${p.personId}`}>
      <th role="rowheader" scope="row" className="px-2 py-1.5 text-left font-semibold text-foreground">
        {p.personName}
        {p.carried.length > 0 && (
          <button
            type="button"
            aria-expanded={unfolded}
            onClick={onToggleEarlier}
            data-testid={`earlier-toggle-${p.personId}`}
            className={cn(NOTE, "flex items-center gap-0.5 rounded-[4px] text-left text-muted-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring")}
          >
            <ChevronRight className={cn("size-3 shrink-0", unfolded && "rotate-90")} aria-hidden />
            {formatCurrency(carriedTotal)} earlier unpaid ({p.carried.length}){postponedEarlier > 0 ? ` · ${postponedEarlier} postponed` : ""}
          </button>
        )}
        {anyOpen && general > PAYMENT_EPSILON && (
          <span className={cn(NOTE, "block text-settle-receivable-text")} data-testid={`general-${p.personId}`} title="Recorded in People toward their overall balance, not against an installment. Recording it again would count it twice.">
            {formatCurrency(general)} received, not linked to an installment
          </span>
        )}
      </th>
      {total ? (
        <>
          <td role="cell" data-label="Share" className="px-2 py-2 text-right font-semibold text-foreground tabular-nums">{formatCurrency(round2(total.share))}</td>
          <td role="cell" data-label="Received" className="px-2 py-1.5 text-right text-foreground tabular-nums">{formatCurrency(round2(total.received))}</td>
          <td role="cell" data-label="Remaining" className="px-2 py-2 text-right font-semibold text-foreground tabular-nums" data-testid={`share-total-${p.personId}`}>
            {formatCurrency(round2(total.remaining))}
            {anyOpen && held > PAYMENT_EPSILON && <span className={cn(NOTE, "block text-settle-advance-text")}>{formatCurrency(held)} advance held, not applied</span>}
          </td>
          <td role="cell" />
          <td role="cell" className="px-2 py-1.5 text-[11px] text-muted-foreground">Per installment below</td>
        </>
      ) : (
        <>
      <Amounts
        line={cur}
        state={state}
        held={
          held > PAYMENT_EPSILON ? (
            <span className={cn(NOTE, "block text-settle-advance-text")} data-testid={`advance-${p.personId}`}>
              {formatCurrency(held)} advance held, not applied
            </span>
          ) : null
        }
      />
      <Actions personName={p.personName} line={cur} state={state} />
        </>
      )}
    </tr>
  );
}

/** One installment's share — the same figures and actions, against its own People item. */
function InstallmentRow({ personName, line, state, inPayment = false }: { personName: string; line: ShareLine; state: LineState; inPayment?: boolean }) {
  return (
    <tr role="row" tabIndex={-1} className={cn(styles.row, "border-t border-border/70 bg-secondary/40 align-top")} data-testid={`earlier-row-${line.key}`}>
      <th role="rowheader" scope="row" className="py-1.5 pr-2 pl-5 text-left font-medium text-foreground/80">
        #{line.sequenceNumber}
        <span className={cn(NOTE, "block text-muted-foreground")}>
          Due {formatStatementDate(line.dueDate, true)}
          {inPayment ? " · in this payment" : ""}
        </span>
      </th>
      <Amounts line={line} state={state} />
      <Actions personName={personName} line={line} state={state} />
    </tr>
  );
}
