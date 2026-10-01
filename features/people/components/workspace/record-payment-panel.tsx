"use client";

import { ArrowDownLeft, ArrowUpRight, Check, CircleAlert, CircleDashed, PiggyBank, ReceiptText } from "lucide-react";
import { useMemo, useState } from "react";
import { EmiBadge } from "@/features/people/components/cycle-statement/statement-parts";
import type { LedgerRow } from "@/features/people/lib/person-ledger-rows";
import { obligationSourceLabel, paymentLines, routeFor, settlementProjection, timingOf, type PayableObligation } from "@/features/people/lib/person-payment-obligations";
import { useCategories } from "@/hooks/use-categories";
import { formatStatementDate } from "@/lib/engines/person-cycle-statement";
import { money } from "@/lib/engines/person-cycle-statement-share";
import {
  allocatePayment,
  PAYMENT_EPSILON,
  paymentBlocker,
  reconcilePayment,
  round2,
  sideForDirection,
  type ExtraResolution,
  type PaymentDirection,
} from "@/lib/engines/person-payment";
import type { RecordPaymentInput } from "@/lib/repositories/person-payment-repository";
import { cn } from "@/lib/utils";
import { AccountField, CompactAmountInput, useAccountChoice } from "./ledger-ui";
import { WS_FIELD, WS_GHOST, WS_PRIMARY, WsCloseButton, WsField, WsLabel, WsSegmented } from "./person-workspace-ui";
import { DateInput } from "@/components/forms/date-input";

/** An existing payment, for editing: its lines per obligation key, advance, account and date. */
export interface RecordPaymentInitial {
  paymentId: string;
  direction: PaymentDirection;
  amount: number;
  accountId: string | null;
  date: Date;
  lines: Record<string, number>;
  advance: number;
}

const toInputDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const fromInputDate = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
};

/**
 * Record payment — one real payment between me and a person, allocated across the exact obligations it
 * pays. Every figure is `allocatePayment`'s (the one rule shared with Flutter); saving writes exactly
 * those lines atomically. Extra money is never classified silently: keep it as advance, record it as
 * income, or tick another obligation so it is applied there.
 */
export function RecordPaymentPanel({
  personName,
  rows,
  preselectKey,
  initial,
  cycle,
  cycleLabel,
  onCancel,
  onSubmit,
}: {
  personName: string;
  /** The person's whole-history ledger rows — obligations are read from them. */
  rows: readonly LedgerRow[];
  preselectKey?: string | null;
  initial?: RecordPaymentInitial | null;
  /** The selected People cycle — decides what is brought forward, due now, or later. */
  cycle: { start: Date; end: Date };
  cycleLabel: string;
  onCancel: () => void;
  onSubmit: (input: RecordPaymentInput, paymentId: string | null) => Promise<void>;
}) {
  const first = personName.split(" ")[0];
  const account = useAccountChoice(initial?.accountId);
  const { data: categories = [] } = useCategories();
  const incomeCategories = categories.filter((c) => c.deletedAt == null && c.type !== "expense");

  // When editing, this payment's own lines count as open again — the edit reverts it in the same write.
  const projection = useMemo(() => settlementProjection(rows, cycle), [rows, cycle]);
  const obligations = useMemo<PayableObligation[]>(() => {
    const open = projection.payable;
    if (!initial) return open;
    const byKey = new Map(open.map((o) => [o.key, o]));
    for (const [key, paid] of Object.entries(initial.lines)) {
      const current = byKey.get(key);
      if (current) {
        byKey.set(key, {
          ...current,
          outstanding: round2(current.outstanding + paid),
        });
        continue;
      }
      const row = rows.find((r) => r.key === key);
      if (!row || (row.direction !== "theyOwe" && row.direction !== "iOwe")) continue;
      const entry = row.statementRow;
      if (!entry) continue;
      const target = key.startsWith("opening:")
        ? ({ kind: "opening", obligationRef: key, max: paid } as const)
        : key.startsWith("ledger:")
        ? row.category === "split"
          ? null
          : ({
              kind: "entry",
              entry: { id: key.slice("ledger:".length) },
              max: paid,
            } as never)
        : ({
            kind: "derivedInstallment",
            obligationRef: key,
            sourceKind: key.startsWith("loan-inst:") ? "loanInstallment" : "emiInstallment",
            max: paid,
          } as const);
      if (!target) continue;
      byKey.set(key, {
        key,
        title: row.title,
        date: row.date,
        createdAt: row.createdAt,
        amount: row.amount,
        outstanding: round2((row.remaining ?? 0) + paid),
        side: row.direction,
        typeLabel: row.typeLabel,
        category: row.category,
        target,
        isEmi: row.category === "emi",
        timing: timingOf(row.date, cycle),
      });
    }
    return [...byKey.values()].sort((a, b) => a.date.getTime() - b.date.getTime() || a.createdAt.getTime() - b.createdAt.getTime());
  }, [rows, initial, projection, cycle]);

  const preselected = obligations.find((o) => o.key === preselectKey);
  // "Due now" = brought forward + this cycle; later items (e.g. upcoming EMIs) stay available but aren't due yet.
  const dueNow = (sd: "theyOwe" | "iOwe") => round2(obligations.filter((o) => o.side === sd && o.timing !== "later").reduce((s, o) => s + o.outstanding, 0));
  const theyOweTotal = dueNow("theyOwe");
  const iOweTotal = dueNow("iOwe");
  const [direction, setDirection] = useState<PaymentDirection>(
    initial?.direction ?? (preselected ? (preselected.side === "iOwe" ? "iPaid" : "theyPaid") : iOweTotal > theyOweTotal ? "iPaid" : "theyPaid"),
  );
  const side = sideForDirection(direction);
  const options = obligations.filter((o) => o.side === side);
  const [selected, setSelected] = useState<Set<string>>(() =>
    initial
      ? new Set(Object.keys(initial.lines))
      : preselected
        ? new Set([preselected.key])
        : new Set(options.filter((o) => o.timing !== "later").map((o) => o.key)),
  );
  const [showLater, setShowLater] = useState(false);
  const laterCount = options.filter((o) => o.timing === "later" && !selected.has(o.key)).length;
  const visible = options.filter((o) => o.timing !== "later" || showLater || selected.has(o.key));
  const elsewhere = projection.elsewhere.filter((o) => o.side === side && o.timing !== "later");
  const [amountText, setAmountText] = useState(() => (initial ? String(initial.amount) : preselected ? String(preselected.outstanding) : ""));
  const [date, setDate] = useState(() => toInputDate(initial?.date ?? new Date()));
  const [manual, setManual] = useState<Record<string, string> | null>(null);
  // Extra money defaults to advance (recommended) — still shown and explained before anything is recorded.
  const [extraChoice, setExtraChoice] = useState<"advance" | "income" | null>("advance");
  const [incomeCategoryId, setIncomeCategoryId] = useState("");
  const [incomeDescription, setIncomeDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const accountId = account.accountId;

  const amount = Number(amountText) || 0;
  const allocation = allocatePayment({
    obligations: options,
    selectedKeys: [...selected],
    amount,
    manual: manual ? Object.fromEntries(Object.entries(manual).map(([k, v]) => [k, Number(v) || 0])) : null,
  });
  const resolution: ExtraResolution | null =
    allocation.extra > PAYMENT_EPSILON
      ? extraChoice === "advance"
        ? { kind: "advance" }
        : extraChoice === "income"
          ? {
              kind: "income",
              categoryId: incomeCategoryId,
              description: incomeDescription,
            }
          : null
      : null;
  const blocker = paymentBlocker({
    direction,
    amount,
    allocation,
    resolution,
    accountId,
  });
  const lineByKey = new Map(allocation.lines.map((l) => [l.key, l]));
  const allSelected = options.some((o) => o.timing !== "later") && options.filter((o) => o.timing !== "later").every((o) => selected.has(o.key));
  const unselected = options.filter((o) => !selected.has(o.key));
  const theyPaid = direction === "theyPaid";

  const toggle = (key: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  async function submit() {
    if (blocker || saving) return;
    setSaving(true);
    setError(null);
    try {
      const input: RecordPaymentInput = {
        direction,
        amount,
        date: fromInputDate(date),
        accountId: accountId!,
        lines: paymentLines(options, allocation.lines),
        extra:
          allocation.extra <= PAYMENT_EPSILON || !resolution
            ? null
            : resolution.kind === "advance"
              ? { kind: "advance", amount: allocation.extra }
              : {
                  kind: "income",
                  amount: allocation.extra,
                  categoryId: resolution.categoryId,
                  description: resolution.description.trim() || `Extra amount from ${first}`,
                },
      };
      await onSubmit(input, initial?.paymentId ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't record the payment.");
    } finally {
      setSaving(false);
    }
  }

  const outcomeLabel =
    allocation.outcome === "full"
      ? { text: "Settles everything selected", tone: "text-success" }
      : allocation.outcome === "partial"
        ? { text: "Partial payment", tone: "text-warning" }
        : allocation.outcome === "over"
          ? {
              text: "More than selected — decide the extra below",
              tone: "text-settle-advance-text",
            }
          : null;

  // Every rupee of this payment, in exactly one bucket — the same reconciliation the history shows.
  const recon = reconcilePayment({
    received: amount,
    allocated: allocation.allocated,
    advance: resolution?.kind === "advance" ? allocation.extra : 0,
    income: resolution?.kind === "income" ? allocation.extra : 0,
  });
  const accountName = account.accounts.find((a) => a.id === accountId)?.name ?? "the chosen account";
  const hasExtra = allocation.extra > PAYMENT_EPSILON;
  const seedManual = () => Object.fromEntries(allocation.lines.map((l) => [l.key, String(l.amount)]));

  return (
    // A real <form>: Enter in a single-line field records through the same submit() as the primary button,
    // with the same gates (blocker / saving / unbalanced allocation) the button's disabled state applies.
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (e.target !== e.currentTarget || !recon.balanced) return;
        void submit();
      }}
      className="mt-4 overflow-hidden rounded-[8px] border border-border-strong bg-card"
    >
      {/* Title */}
      <div className="flex items-center justify-between gap-3 border-b border-border-strong px-4 py-2.5">
        <h3 className="font-heading text-[15px] leading-tight font-semibold tracking-tight text-foreground">
          {initial ? "Edit payment" : "Record payment"} — {personName}
          <span className="ml-2 text-xs font-semibold text-foreground/70">Cycle: {cycleLabel}</span>
        </h3>
        <WsCloseButton onClick={onCancel} className="-my-0.5" />
      </div>

      {/* Live figures — every number here is `allocatePayment`'s */}
      <dl className="grid grid-cols-2 divide-border-strong/70 border-b border-border-strong bg-secondary/50 sm:grid-cols-5 sm:divide-x">
        <Kpi label="Person" value={personName} />
        <Kpi
          label={theyPaid ? `${first} owes you` : `You owe ${first}`}
          value={money(theyPaid ? theyOweTotal : iOweTotal)}
          tone={theyPaid ? "text-settle-receivable-text" : "text-settle-payable-text"}
        />
        <Kpi label={theyPaid ? "Payment received" : "Payment made"} value={money(amount)} strong />
        <Kpi label="Allocated" value={money(allocation.allocated)} tone={allocation.allocated > PAYMENT_EPSILON ? "text-success" : undefined} />
        <Kpi
          label="Extra / unallocated"
          value={money(allocation.extra)}
          tone={hasExtra ? "text-settle-advance-text" : "text-foreground/70"}
          strong={hasExtra}
          className={hasExtra ? "bg-settle-advance-tint" : undefined}
        />
      </dl>

      <div className="grid lg:grid-cols-[minmax(0,1fr)_19rem]">
        <div className="min-w-0 px-4 pt-3.5 pb-4">
          {/* Who paid whom, how much, where it moved, when */}
          <div className="grid gap-3 sm:grid-cols-[minmax(0,15rem)_minmax(0,9rem)_minmax(0,1fr)_minmax(0,9.5rem)] sm:items-end">
            <WsField label="Direction">
              <WsSegmented
                label="Direction"
                value={direction}
                onChange={(d) => {
                  if (initial) return;
                  setDirection(d);
                  setSelected(new Set(obligations.filter((o) => o.side === sideForDirection(d) && o.timing !== "later").map((o) => o.key)));
                  setManual(null);
                  setExtraChoice("advance");
                }}
                options={[
                  {
                    value: "theyPaid",
                    label: `Money received from ${first}`,
                    icon: ArrowDownLeft,
                  },
                  {
                    value: "iPaid",
                    label: `Money paid to ${first}`,
                    icon: ArrowUpRight,
                  },
                ]}
              />
            </WsField>
            <WsField label={theyPaid ? "Amount received" : "Amount paid"}>
              <CompactAmountInput label={theyPaid ? "Amount received" : "Amount paid"} value={amountText} onChange={setAmountText} autoFocus />
            </WsField>
            <AccountField choice={account} label={theyPaid ? "Receive into account" : "Pay from account"} />
            <WsField label="Date">
              <DateInput className={WS_FIELD} value={date} onChange={(e) => setDate(e.target.value)} />
            </WsField>
          </div>

          {/* Allocation table */}
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
            <WsLabel>Apply payment to</WsLabel>
            <div className="flex items-center gap-1">
              {manual && (
                <button
                  type="button"
                  onClick={() => setManual(null)}
                  className="h-7 rounded-[6px] px-2 text-xs font-semibold text-foreground/80 hover:bg-secondary"
                >
                  Allocate automatically (oldest first)
                </button>
              )}
              {options.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setManual(null);
                    setSelected(allSelected ? new Set() : new Set(options.filter((o) => o.timing !== "later").map((o) => o.key)));
                  }}
                  className="h-7 rounded-[6px] border border-border-strong px-2.5 text-xs font-semibold text-foreground hover:bg-secondary"
                >
                  {allSelected ? "Clear selection" : "Select all due"}
                </button>
              )}
            </div>
          </div>
          {options.length === 0 ? (
            <p className="mt-2 rounded-[6px] border border-dashed border-border-strong px-3 py-2.5 text-sm text-foreground/80">
              {theyPaid ? `${first} owes you nothing right now` : `You owe ${first} nothing right now`} — anything recorded is held as advance.
            </p>
          ) : (
            <div className="mt-2 overflow-x-auto rounded-[6px] border border-border-strong">
              <table className="w-full min-w-[46rem] border-collapse text-sm">
                <thead>
                  <tr className="bg-secondary text-left text-[11px] font-semibold tracking-[0.05em] text-foreground/75 uppercase">
                    <th className="w-9 border-b border-border-strong px-2 py-1.5">
                      <span className="sr-only">Select</span>
                    </th>
                    <th className="border-b border-border-strong px-2 py-1.5">Date</th>
                    <th className="border-b border-border-strong px-2 py-1.5">Description</th>
                    <th className="border-b border-border-strong px-2 py-1.5">Source</th>
                    <th className="border-b border-border-strong px-2 py-1.5 text-right">Due</th>
                    <th className="border-b border-border-strong px-2 py-1.5 text-right">Paying now</th>
                    <th className="border-b border-border-strong px-2 py-1.5 text-right">Remaining</th>
                    <th className="border-b border-border-strong px-2 py-1.5">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((o) => {
                    const on = selected.has(o.key);
                    const line = lineByKey.get(o.key);
                    const paying = line?.amount ?? 0;
                    const remaining = on ? (line?.remainingAfter ?? o.outstanding) : o.outstanding;
                    const result = !on || paying <= PAYMENT_EPSILON ? null : remaining <= PAYMENT_EPSILON ? "full" : "partial";
                    return (
                      <tr
                        key={o.key}
                        className={cn(
                          "transition-colors",
                          on ? "bg-primary/[0.07] shadow-[inset_3px_0_0_var(--color-primary-accent-text)]" : "hover:bg-secondary/60",
                        )}
                      >
                        <td className="border-b border-border px-2 py-1.5 text-center align-middle">
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={() => {
                              setManual(null);
                              toggle(o.key);
                            }}
                            aria-label={`Apply to ${o.title}`}
                            className="size-4 accent-[var(--color-primary-accent-text)]"
                          />
                        </td>
                        <td className="border-b border-border px-2 py-1.5 whitespace-nowrap text-foreground tabular-nums">
                          {formatStatementDate(o.date, true)}
                        </td>
                        <td className="border-b border-border px-2 py-1.5">
                          <span className="flex min-w-0 items-center gap-1.5 font-semibold text-foreground">
                            <span className="truncate">{o.title}</span>
                            {o.isEmi && <EmiBadge />}
                            {o.timing === "carried" && (
                              <span className="shrink-0 rounded-[4px] bg-settle-carried-badge px-1.5 text-[10px] leading-4 font-bold text-settle-carried-text uppercase">
                                Carried forward
                              </span>
                            )}
                            {o.timing === "later" && (
                              <span className="shrink-0 rounded-[4px] bg-secondary px-1.5 text-[10px] leading-4 font-bold text-foreground/75 uppercase">Upcoming</span>
                            )}
                          </span>
                        </td>
                        <td className="border-b border-border px-2 py-1.5 text-xs font-medium text-foreground/80">{obligationSourceLabel(o, first)}</td>
                        <td className="border-b border-border px-2 py-1.5 text-right font-semibold text-foreground tabular-nums">{money(o.outstanding)}</td>
                        <td className="border-b border-border px-2 py-1.5 text-right tabular-nums">
                          {on ? (
                            <input
                              type="number"
                              inputMode="decimal"
                              min={0}
                              aria-label={`Paying now for ${o.title}`}
                              value={manual ? (manual[o.key] ?? "") : String(paying)}
                              onChange={(e) =>
                                setManual((m) => ({
                                  ...(m ?? seedManual()),
                                  [o.key]: e.target.value,
                                }))
                              }
                              className={cn(WS_FIELD, "h-8 w-28 text-right font-semibold tabular-nums")}
                            />
                          ) : (
                            <span className="text-foreground/55">—</span>
                          )}
                        </td>
                        <td
                          className={cn(
                            "border-b border-border px-2 py-1.5 text-right font-semibold tabular-nums",
                            result === "partial" ? "text-warning" : result === "full" ? "text-success" : "text-foreground",
                          )}
                        >
                          {money(remaining)}
                        </td>
                        <td className="border-b border-border px-2 py-1.5">
                          {result === "full" ? (
                            <span className="inline-flex items-center gap-1 text-xs font-bold text-success">
                              <Check className="size-3.5" strokeWidth={2.75} aria-hidden />
                              Paid in full
                            </span>
                          ) : result === "partial" ? (
                            <span className="inline-flex items-center gap-1 text-xs font-bold text-warning">
                              <CircleDashed className="size-3.5" strokeWidth={2.5} aria-hidden />
                              Partially paid
                            </span>
                          ) : (
                            <span className="text-xs font-medium text-foreground/60">{on ? "Nothing applied" : "Not selected"}</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {laterCount > 0 && (
                    <tr>
                      <td colSpan={8} className="border-b border-border px-2 py-1.5">
                        <button type="button" onClick={() => setShowLater((v) => !v)} className="text-xs font-semibold text-foreground/80 underline underline-offset-2 hover:text-foreground">
                          {showLater ? "Hide upcoming items" : `Show ${laterCount} upcoming ${laterCount === 1 ? "item" : "items"} after this cycle`}
                        </button>
                      </td>
                    </tr>
                  )}
                </tbody>
                <tfoot>
                  <tr className="bg-secondary/70 font-semibold text-foreground">
                    <td colSpan={4} className="px-2 py-1.5 text-right text-xs tracking-[0.04em] uppercase">
                      Selected
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{money(allocation.selectedTotal)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{money(allocation.allocated)}</td>
                    <td className={cn("px-2 py-1.5 text-right tabular-nums", allocation.unpaid > PAYMENT_EPSILON ? "text-warning" : "text-success")}>
                      {money(allocation.unpaid)}
                    </td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

          {elsewhere.length > 0 && (
            <div className="mt-3 rounded-[6px] border border-border-strong bg-secondary/50 px-3 py-2">
              <p className="text-[11px] font-bold tracking-[0.06em] text-foreground/80 uppercase">
                Also outstanding — settled at the source ({money(elsewhere.reduce((sum, e) => sum + e.outstanding, 0))})
              </p>
              <ul className="mt-1 space-y-0.5 text-xs">
                {elsewhere.map((e) => (
                  <li key={e.key} className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span className="font-semibold text-foreground">
                      {formatStatementDate(e.date, true)} · {e.title} · {money(e.outstanding)}
                    </span>
                    <span className="text-foreground/75">
                      {e.reason}
                      {e.loanId && (
                        <>
                          {" · "}
                          <a href={`/loans?agreement=${encodeURIComponent(e.loanId)}`} className="font-semibold text-foreground underline underline-offset-2">
                            Open Loan
                          </a>
                        </>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Overpayment — a first-class decision, never silently classified */}
          {hasExtra && (
            <div className="mt-4 rounded-[8px] border border-settle-advance-edge/70 bg-settle-advance-tint/50 p-3.5">
              <p className="flex items-center gap-2 text-sm font-bold text-foreground">
                <CircleAlert className="size-4 text-settle-advance-text" strokeWidth={2.25} aria-hidden />
                {money(allocation.extra)} is left after settling the selected items.
              </p>
              <p className="mt-0.5 text-xs font-medium text-foreground/80">What should happen to this money?</p>
              <div role="radiogroup" aria-label="What the extra amount is" className="mt-2.5 grid gap-2 sm:grid-cols-2">
                <ExtraOption
                  active={extraChoice === "advance"}
                  onSelect={() => setExtraChoice("advance")}
                  icon={PiggyBank}
                  title={theyPaid ? `Keep as advance from ${first}` : `Keep as advance paid to ${first}`}
                  badge="Recommended"
                  detail={
                    theyPaid
                      ? `${first} has already paid you ${money(allocation.extra)} toward future obligations. Not income — carried forward until you apply it.`
                      : `You have already paid ${first} ${money(allocation.extra)} toward what you'll owe. Carried forward until you apply it.`
                  }
                />
                {theyPaid && (
                  <ExtraOption
                    active={extraChoice === "income"}
                    onSelect={() => setExtraChoice("income")}
                    icon={ReceiptText}
                    title="Record as income"
                    detail={`The extra ${money(allocation.extra)} is really yours — a normal income, no longer toward what ${first} owes.`}
                  />
                )}
              </div>
              {extraChoice === "income" && theyPaid && (
                <div className="mt-2.5 grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                  <WsField label="Income category">
                    <select className={WS_FIELD} value={incomeCategoryId} onChange={(e) => setIncomeCategoryId(e.target.value)}>
                      <option value="">Choose…</option>
                      {incomeCategories.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </WsField>
                  <WsField label="Description / note">
                    <input
                      className={WS_FIELD}
                      value={incomeDescription}
                      onChange={(e) => setIncomeDescription(e.target.value)}
                      placeholder={`Extra amount from ${first}`}
                    />
                  </WsField>
                  <p className="text-xs text-foreground/75 sm:col-span-2">
                    Recorded into <span className="font-semibold text-foreground">{accountName}</span> on{" "}
                    <span className="font-semibold text-foreground">{formatStatementDate(fromInputDate(date), true)}</span> — the same receipt, so the account
                    still goes up by {money(amount)} in total, never more.
                  </p>
                </div>
              )}
              {unselected.length > 0 && (
                <div className="mt-2.5 border-t border-settle-advance-edge/40 pt-2.5">
                  <p className="text-xs font-semibold text-foreground/80">Or apply it to another outstanding item:</p>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {unselected.map((o) => (
                      <button
                        key={o.key}
                        type="button"
                        onClick={() => {
                          setManual(null);
                          toggle(o.key);
                        }}
                        className="h-7 rounded-full border border-border-strong bg-card px-2.5 text-xs font-semibold text-foreground hover:border-primary-accent-text hover:bg-primary/10"
                      >
                        + {o.title} · {formatStatementDate(o.date, true)} · {money(o.outstanding)}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Sticky reconciliation + the action */}
        <aside className="border-t border-border-strong bg-secondary/60 px-4 py-3.5 lg:border-t-0 lg:border-l">
          <div className="lg:sticky lg:top-3">
            <WsLabel>Where the money goes</WsLabel>
            <dl className="mt-2 space-y-1.5 text-sm">
              <SummaryLine label={theyPaid ? "Payment received" : "Payment made"} value={money(recon.received)} strong />
              <div className="my-2 border-t border-border-strong" />
              <SummaryLine
                label="Allocated to obligations"
                value={money(recon.allocated)}
                tone={recon.allocated > PAYMENT_EPSILON ? "text-success" : undefined}
              />
              {recon.advance > PAYMENT_EPSILON && <SummaryLine label="Advance created" value={money(recon.advance)} tone="text-settle-advance-text" />}
              {recon.income > PAYMENT_EPSILON && <SummaryLine label="Recorded as income" value={money(recon.income)} />}
              {recon.unallocated > PAYMENT_EPSILON && <SummaryLine label="Not yet decided" value={money(recon.unallocated)} tone="text-warning" />}
              <div className="my-2 border-t border-border-strong" />
              <SummaryLine
                label="Still open on selected"
                value={money(allocation.unpaid)}
                tone={allocation.unpaid > PAYMENT_EPSILON ? "text-warning" : "text-success"}
              />
            </dl>
            {outcomeLabel && <p className={cn("mt-2 text-xs font-bold", outcomeLabel.tone)}>{outcomeLabel.text}</p>}
            <p className="mt-2 text-xs leading-relaxed text-foreground/75">
              {theyPaid ? `${accountName} goes up` : `${accountName} goes down`} by exactly {money(amount)} — one payment, never counted twice.
            </p>
            {(error || blocker) && (
              <p className={cn("mt-2 text-xs font-medium", error ? "text-expense" : "text-foreground/80")} role={error ? "alert" : undefined}>
                {error ?? blocker}
              </p>
            )}
            <div className="mt-3 flex items-center gap-2">
              <button type="button" onClick={onCancel} disabled={saving} className={WS_GHOST}>
                Cancel
              </button>
              <button type="submit" disabled={!!blocker || saving || !recon.balanced} className={cn(WS_PRIMARY, "flex-1")}>
                {saving ? "Saving…" : initial ? "Save changes" : theyPaid ? `Record ${money(amount)} received` : `Record ${money(amount)} paid`}
              </button>
            </div>
          </div>
        </aside>
      </div>
    </form>
  );
}

function Kpi({ label, value, tone, strong, className }: { label: string; value: string; tone?: string; strong?: boolean; className?: string }) {
  return (
    <div className={cn("min-w-0 px-4 py-2", className)}>
      <dt className="text-[10.5px] font-bold tracking-[0.07em] text-foreground/70 uppercase">{label}</dt>
      <dd className={cn("truncate font-heading tabular-nums", strong ? "text-[18px] font-bold" : "text-[16px] font-semibold", tone ?? "text-foreground")}>
        {value}
      </dd>
    </div>
  );
}

function SummaryLine({ label, value, tone, strong }: { label: string; value: string; tone?: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-foreground/75">{label}</dt>
      <dd className={cn("tabular-nums", strong ? "font-heading text-[15px] font-bold" : "font-semibold", tone ?? "text-foreground")}>{value}</dd>
    </div>
  );
}

function ExtraOption({
  active,
  onSelect,
  icon: Icon,
  title,
  detail,
  badge,
}: {
  badge?: string;
  active: boolean;
  onSelect: () => void;
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  title: string;
  detail: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onSelect}
      className={cn(
        "flex items-start gap-2.5 rounded-[6px] border bg-card px-3 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
        active ? "border-primary-accent-text ring-1 ring-primary-accent-text" : "border-border-strong hover:bg-secondary",
      )}
    >
      <span
        className={cn(
          "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border-2",
          active ? "border-primary-accent-text" : "border-foreground/40",
        )}
      >
        {active && <span className="size-2 rounded-full bg-primary-accent-text" />}
      </span>
      <span className="min-w-0">
        <span className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
          <Icon className="size-3.5" strokeWidth={2} />
          {title}
          {badge && (
            <span className="rounded-[4px] bg-settle-advance-badge px-1.5 py-px text-[10px] font-bold tracking-[0.05em] text-settle-advance-text uppercase">
              {badge}
            </span>
          )}
        </span>
        <span className="block text-xs text-foreground/70">{detail}</span>
      </span>
    </button>
  );
}

/** The inputs to edit one recorded payment, read from its ledger entries (null when it can't be edited here). */
export function paymentInitialFor(
  paymentId: string,
  entries: readonly {
    id: string;
    paymentId?: string | null;
    deletedAt: Date | null;
    sourceKind?: string;
    type: string;
    amount: number;
    date: Date;
    parentEntryId: string | null;
    obligationRef?: string | null;
    installmentPaymentRef?: string | null;
    incomeTransactionRef?: string | null;
    transactionRef: string | null;
  }[],
  accountIdOf: (transactionId: string) => string | null,
): RecordPaymentInitial | null {
  const group = entries.filter((e) => e.deletedAt == null && e.paymentId === paymentId);
  if (group.length === 0) return null;
  // A split-share line or a separate income part is changed by reverting and recording again.
  if (group.some((e) => e.installmentPaymentRef != null || e.incomeTransactionRef != null)) return null;
  const lines: Record<string, number> = {};
  let advance = 0;
  for (const e of group) {
    if (e.sourceKind === "advance") advance = round2(advance + e.amount);
    else lines[e.obligationRef ?? `ledger:${e.parentEntryId}`] = e.amount;
  }
  return {
    paymentId,
    direction: group[0].type === "repaid" ? "iPaid" : "theyPaid",
    amount: round2(group.reduce((s, e) => s + e.amount, 0)),
    accountId: group[0].transactionRef ? accountIdOf(group[0].transactionRef) : null,
    date: group[0].date,
    lines,
    advance,
  };
}

export { routeFor };
