"use client";

import { ArrowDownLeft, ArrowUpRight, Check, CircleAlert, CircleDashed } from "lucide-react";
import { useMemo, useRef, useState } from "react";
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
  settleCapLines,
  sideForDirection,
  type ExtraResolution,
  type PaymentDirection,
} from "@/lib/engines/person-payment";
import type { PaymentExtraInput, RecordPaymentInput } from "@/lib/repositories/person-payment-repository";
import { cn } from "@/lib/utils";
import { AccountField, CompactAmountInput, useAccountChoice } from "./ledger-ui";
import { WS_FIELD, WS_GHOST, WS_PRIMARY, WsCloseButton, WsField, WsSegmented } from "./person-workspace-ui";
import { usePurposeLinkOptions } from "./purpose-money";
import { draftsToAllocations, ExtraAllocationEditor, newAllocationDraft, type AllocationDraft } from "./extra-allocation-editor";
import { planExtraAllocation } from "@/lib/engines/extra-allocation";
import { DateInput } from "@/components/forms/date-input";
import { ReminderPicker, type ReminderWhen } from "./follow-up";

/** An existing payment, for editing: its lines per obligation key, advance, account and date. */
export interface RecordPaymentInitial {
  paymentId: string;
  direction: PaymentDirection;
  amount: number;
  accountId: string | null;
  date: Date;
  lines: Record<string, number>;
  advance: number;
  /** The extra recorded as separate income, if any — editable to advance (and back) like any extra. */
  income?: { amount: number; categoryId: string; description: string } | null;
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
  onSetReminder,
  cycleStartDay = 1,
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
  /** Saves a follow-up reminder on each item left open — called only after the payment itself is saved. */
  onSetReminder?: (targets: { key: string; title: string }[], when: ReminderWhen) => Promise<void>;
  /** Settings → Month Cycle start day — "Next cycle" resolves against it. */
  cycleStartDay?: number;
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
  // Editing shows the payment exactly as it was allocated (not re-allocated oldest first).
  const [manual, setManual] = useState<Record<string, string> | null>(() =>
    initial && Object.keys(initial.lines).length > 0 ? Object.fromEntries(Object.entries(initial.lines).map(([k, v]) => [k, String(v)])) : null,
  );
  // The extra, divided across destinations (purpose / income / advance). null = the default: all of it
  // kept as advance (recommended) — following the extra as it changes, still shown before anything is recorded.
  const linkOptions = usePurposeLinkOptions();
  const [extraDrafts, setExtraDrafts] = useState<AllocationDraft[] | null>(() => {
    if (!initial || (!(initial.advance > 0) && !initial.income)) return null;
    const out: AllocationDraft[] = [];
    if (initial.advance > 0) out.push(newAllocationDraft("advance", initial.advance));
    if (initial.income)
      out.push(newAllocationDraft("income", initial.income.amount, { categoryId: initial.income.categoryId, description: initial.income.description }));
    return out;
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const accountId = account.accountId;

  const amount = Number(amountText) || 0;
  // "Use only ₹X to settle" — null = the default (settle as much as the payment covers, or the per-line amounts).
  const [settleText, setSettleText] = useState<string | null>(null);
  const capped =
    settleText == null
      ? null
      : settleCapLines({ obligations: options, selectedKeys: [...selected], amount, settle: settleText.trim() === "" ? NaN : Number(settleText) });
  const allocation = allocatePayment({
    obligations: options,
    selectedKeys: [...selected],
    amount,
    manual: capped ? capped.manual : manual ? Object.fromEntries(Object.entries(manual).map(([k, v]) => [k, Number(v) || 0])) : null,
  });
  const hasExtra = allocation.extra > PAYMENT_EPSILON;
  const effectiveDrafts = extraDrafts ?? [{ ...newAllocationDraft("advance", allocation.extra), key: "auto-advance" }];
  const extraPlan = planExtraAllocation({ extra: allocation.extra, direction, allocations: draftsToAllocations(effectiveDrafts, linkOptions), money });
  // The shared gate still checks amount / account / one-side / "pays something"; the divided extra is checked by its plan.
  const resolution: ExtraResolution | null = !hasExtra
    ? null
    : extraPlan.advance > PAYMENT_EPSILON || extraPlan.purposes.length > 0
      ? { kind: "advance" }
      : { kind: "income", categoryId: extraPlan.income?.categoryId ?? "", description: extraPlan.income?.description ?? "" };
  const blocker = capped?.error ?? (hasExtra ? extraPlan.error : null) ?? paymentBlocker({
    direction,
    amount,
    allocation,
    resolution,
    accountId,
  });
  const lineByKey = new Map(allocation.lines.map((l) => [l.key, l]));
  // The selected items this payment leaves open — where a "remind me" goes (each keeps its own remaining).
  const reminderTargets = allocation.unpaid > PAYMENT_EPSILON
    ? options
        .filter((o) => selected.has(o.key) && (lineByKey.get(o.key)?.remainingAfter ?? o.outstanding) > PAYMENT_EPSILON)
        .map((o) => ({ key: o.key, title: o.title }))
    : [];
  const [reminder, setReminder] = useState<ReminderWhen | null>(null);
  const allSelected = options.some((o) => o.timing !== "later") && options.filter((o) => o.timing !== "later").every((o) => selected.has(o.key));
  const unselected = options.filter((o) => !selected.has(o.key));
  const theyPaid = direction === "theyPaid";

  /** One direction at a time — each side's obligations are settled on their own, never netted. */
  function switchDirection(d: PaymentDirection) {
    if (initial) return;
    setDirection(d);
    setSelected(new Set(obligations.filter((o) => o.side === sideForDirection(d) && o.timing !== "later").map((o) => o.key)));
    setManual(null);
    setSettleText(null);
    setExtraDrafts(null);
  }
  // The opposite side, shown for information only — it never reduces this side's outstanding or Full payment.
  const otherSideTotal = theyPaid ? iOweTotal : theyOweTotal;

  const toggle = (key: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const submittedRef = useRef(false);
  async function submit() {
    // A ref, not state: a double click lands before the re-render that disables the button. Once saved, the
    // panel closes — it never records the same payment twice.
    if (blocker || saving || submittedRef.current) return;
    submittedRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const input: RecordPaymentInput = {
        direction,
        amount,
        date: fromInputDate(date),
        accountId: accountId!,
        lines: paymentLines(options, allocation.lines),
        ...(() => {
          if (!hasExtra) return { extra: null };
          // One receipt, each part through its existing path: advance entry, Income transaction, purpose docs.
          const parts: PaymentExtraInput[] = [];
          if (extraPlan.advance > PAYMENT_EPSILON) parts.push({ kind: "advance", amount: extraPlan.advance });
          if (extraPlan.income)
            parts.push({ kind: "income", ...extraPlan.income, description: extraPlan.income.description || `Extra amount from ${first}` });
          return {
            extra: parts[0] ?? null,
            ...(parts.length > 1 ? { extras: parts.slice(1) } : {}),
            ...(extraPlan.purposes.length > 0 ? { purposes: extraPlan.purposes } : {}),
          };
        })(),
      };
      await onSubmit(input, initial?.paymentId ?? null);
      // Metadata only, after the payment is safely recorded — a failed reminder never undoes the payment.
      if (reminder && onSetReminder && reminderTargets.length > 0) await onSetReminder(reminderTargets, reminder).catch(() => {});
    } catch (e) {
      submittedRef.current = false;
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
    advance: hasExtra ? extraPlan.advance : 0,
    income: hasExtra ? (extraPlan.income?.amount ?? 0) : 0,
    purpose: hasExtra ? round2(extraPlan.purposes.reduce((t, x) => t + x.amount, 0)) : 0,
  });
  const accountName = account.accounts.find((a) => a.id === accountId)?.name ?? "the chosen account";
  const seedManual = () => Object.fromEntries(allocation.lines.map((l) => [l.key, String(l.amount)]));
  const dueTotal = theyPaid ? theyOweTotal : iOweTotal;
  // The same Due, split by the timing it already has — brought forward vs added this cycle. Presentation only.
  const dueByTiming = (t: "carried" | "cycle") => round2(options.filter((o) => o.timing === t).reduce((sum, o) => sum + o.outstanding, 0));
  const duePrevious = dueByTiming("carried");
  const dueThisCycle = round2(dueTotal - duePrevious);

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
      aria-label={initial ? `Edit payment — ${personName}` : `Record payment — ${personName}`}
      className="mt-4 overflow-hidden rounded-[8px] border border-border-strong bg-card"
    >
      {/* Hero — the one question: how much came in, from whom; then what it's against */}
      <div className="border-b border-border-strong px-4 pt-3 pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-[11px] font-bold tracking-[0.07em] text-foreground/75 uppercase">
              {initial ? "Edit payment" : "Record payment"} — {personName}
            </h3>
            <p className="mt-0.5 flex flex-wrap items-baseline gap-x-2">
              <span className="font-heading text-[26px] leading-tight font-bold tracking-tight text-foreground tabular-nums" data-testid="rp-hero-amount">
                {money(amount)}
              </span>
              <span className="text-sm font-semibold text-foreground/85">{theyPaid ? `received from ${personName}` : `paid to ${personName}`}</span>
            </p>
            <p className="mt-0.5 text-xs font-medium text-foreground/75">
              {initial ? `Recorded ${formatStatementDate(initial.date, true)}` : `Cycle · ${cycleLabel}`}
              <span aria-hidden> · </span>
              {theyPaid ? "Into" : "From"} {accountName}
              <span aria-hidden> · </span>
              {date ? formatStatementDate(fromInputDate(date), true) : "No date"}
            </p>
            {initial && <p className="mt-0.5 text-xs font-medium text-foreground/75">Changes will update the existing payment and its linked allocations.</p>}
          </div>
          <WsCloseButton onClick={onCancel} className="shrink-0" />
        </div>

        {/* Live figures — every number here is `allocatePayment`'s */}
        <dl className="mt-2.5 grid grid-cols-3 gap-2 sm:max-w-xl">
          <Indicator label={theyPaid ? `Due from ${first}` : `Due to ${first}`} value={money(dueTotal)} tone={dueTotal > PAYMENT_EPSILON ? (theyPaid ? "text-settle-receivable-text" : "text-settle-payable-text") : undefined} />
          <Indicator label="Settles balance" value={money(allocation.allocated)} tone={allocation.allocated > PAYMENT_EPSILON ? "text-settle-split-text" : undefined} />
          <Indicator label="Money left to decide" value={money(allocation.extra)} emphasis={hasExtra} />
        </dl>
        {/* Only when Due includes brought-forward money — otherwise the single Due figure says it all. */}
        {duePrevious > PAYMENT_EPSILON && (
          <dl className="mt-2 grid max-w-xs gap-0.5 rounded-[6px] border border-border-strong px-2.5 py-1.5 text-xs" data-testid="rp-due-breakdown">
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-foreground/80">Previous pending</dt>
              <dd className="font-semibold text-foreground tabular-nums">{money(duePrevious)}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-foreground/80">Added this cycle</dt>
              <dd className="font-semibold text-foreground tabular-nums">{money(dueThisCycle)}</dd>
            </div>
            <div className="mt-0.5 flex items-baseline justify-between gap-3 border-t border-border-strong pt-1">
              <dt className="font-semibold text-foreground">Due through this cycle</dt>
              <dd className="font-heading text-[13px] font-bold text-foreground tabular-nums">{money(dueTotal)}</dd>
            </div>
          </dl>
        )}
      </div>

      <div className="grid lg:grid-cols-[minmax(0,1fr)_19rem]">
        <div className="min-w-0 px-4 pt-3 pb-4">
          {/* Who paid whom, how much, where it moved, when */}
          <WsSegmented
            label="Direction"
            value={direction}
            onChange={switchDirection}
            className="sm:max-w-md"
            options={[
              { value: "theyPaid", label: `Money received from ${first}`, icon: ArrowDownLeft },
              { value: "iPaid", label: `Money paid to ${first}`, icon: ArrowUpRight },
            ]}
          />
          <div className="mt-2.5 grid gap-2.5 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)_minmax(0,10rem)] sm:items-end">
            <WsField label={theyPaid ? "Amount received" : "Amount paid"}>
              <CompactAmountInput label={theyPaid ? "Amount received" : "Amount paid"} value={amountText} onChange={setAmountText} autoFocus />
            </WsField>
            <AccountField choice={account} label={theyPaid ? "Receive into account" : "Pay from account"} />
            <WsField label="Date">
              <DateInput className={WS_FIELD} value={date} onChange={(e) => setDate(e.target.value)} />
            </WsField>
          </div>

          {/* 1. The money decision first: how much settles the balance… */}
          {options.length > 0 && (
            <section aria-labelledby="rp-decide-heading" className="mt-4">
              <h4 id="rp-decide-heading" className="text-sm font-bold text-foreground">
                {theyPaid ? `Settle what ${first} owes you` : `Settle what you owe ${first}`}
              </h4>
              <p className="text-xs font-medium text-foreground/70">
                How much of the {money(amount)} {theyPaid ? "received" : "paid"} should settle {theyPaid ? `${first}'s balance` : `what you owe ${first}`}? Applied oldest first.
              </p>
              <div className="mt-2 grid gap-2.5 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)] sm:items-end">
                <WsField label={theyPaid ? `Apply to ${first}'s balance` : `Apply to what you owe`}>
                  <input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    aria-label="Apply to balance"
                    aria-invalid={capped?.error ? true : undefined}
                    value={settleText ?? String(allocation.allocated)}
                    onChange={(e) => {
                      setManual(null);
                      setSettleText(e.target.value);
                    }}
                    className={cn(WS_FIELD, "h-9 w-full text-right font-semibold tabular-nums")}
                  />
                </WsField>
                <div className="flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    aria-pressed={settleText == null && manual == null}
                    onClick={() => {
                      setManual(null);
                      setSettleText(null);
                    }}
                    className="h-8 rounded-[6px] border border-border-strong px-2.5 text-xs font-semibold text-foreground outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring aria-pressed:border-settle-split-edge aria-pressed:bg-settle-split-tint/50"
                  >
                    Settle full {money(Math.min(amount, allocation.selectedTotal))}
                  </button>
                  <button
                    type="button"
                    aria-pressed={settleText != null && Number(settleText) === 0 && settleText.trim() !== ""}
                    onClick={() => {
                      setManual(null);
                      setSettleText("0");
                    }}
                    className="h-8 rounded-[6px] border border-border-strong px-2.5 text-xs font-semibold text-foreground outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring aria-pressed:border-settle-split-edge aria-pressed:bg-settle-split-tint/50"
                  >
                    Settle nothing now
                  </button>
                </div>
              </div>
              {capped?.error && (
                <p className="mt-1 text-xs font-semibold text-warning" role="alert">
                  {capped.error}
                </p>
              )}
              {/* Two different "remaining" numbers — never mixed: a debt still owed vs money still to classify. */}
              <dl className="mt-2.5 grid gap-2 sm:max-w-xl sm:grid-cols-2">
                <div className="rounded-[6px] border border-border-strong px-2.5 py-1.5">
                  <dt className="text-[10.5px] font-bold tracking-[0.06em] text-foreground/75 uppercase">{theyPaid ? `Still owed by ${first}` : `Still owed to ${first}`}</dt>
                  <dd className={cn("font-heading text-[15px] font-semibold tabular-nums", allocation.unpaid > PAYMENT_EPSILON ? "text-warning" : "text-success")} data-testid="rp-still-owed">
                    {money(allocation.unpaid)}
                  </dd>
                  <p className="text-[11px] text-foreground/65">Stays open on the same items — not advance, not income.</p>
                </div>
                <div className="rounded-[6px] border border-border-strong px-2.5 py-1.5">
                  <dt className="text-[10.5px] font-bold tracking-[0.06em] text-foreground/75 uppercase">{theyPaid ? "Remaining received money" : "Remaining paid money"}</dt>
                  <dd className="font-heading text-[15px] font-semibold text-foreground tabular-nums" data-testid="rp-left-over">
                    {money(allocation.extra)}
                  </dd>
                  <p className="text-[11px] text-foreground/65">{hasExtra ? "Decide what it is below." : "Nothing left to decide."}</p>
                </div>
              </dl>
            </section>
          )}

          {/* 2. …then what the rest of the money is — a first-class decision, never silently classified */}
          {hasExtra && (
            <section aria-labelledby="rp-remaining-heading" className="mt-4 border-t border-border-strong pt-3.5">
              <p className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-heading text-[20px] leading-tight font-bold text-foreground tabular-nums">{money(allocation.extra)}</span>
                <span className="text-sm font-semibold text-foreground/85">{allocation.allocated > PAYMENT_EPSILON ? "left after settling" : "remaining"}</span>
              </p>
              <h4 id="rp-remaining-heading" className="text-sm font-bold text-foreground">
                What should happen to this money?
              </h4>
              <p className="text-xs font-medium text-foreground/70">
                {accountName} still {theyPaid ? "receives" : "pays"} {money(amount)} once — this only decides what the money means.
              </p>
              <ExtraAllocationEditor
                extra={allocation.extra}
                direction={direction}
                firstName={first}
                drafts={effectiveDrafts}
                onChange={setExtraDrafts}
                linkOptions={linkOptions}
                incomeCategories={incomeCategories}
                accountName={accountName}
              />
              {unselected.length > 0 && (
                <div className="mt-2.5">
                  <p className="text-xs font-semibold text-foreground/80">Or use it to settle another item:</p>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {unselected.map((o) => (
                      <button
                        key={o.key}
                        type="button"
                        onClick={() => {
                          setManual(null);
                          setSettleText(null);
                          toggle(o.key);
                        }}
                        className="h-8 rounded-full border border-border-strong bg-card px-2.5 text-xs font-semibold text-foreground outline-none hover:border-settle-split-edge hover:bg-settle-split-tint/50 focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        + {o.title} · {formatStatementDate(o.date, true)} · {money(o.outstanding)}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </section>
          )}

          {/* 3. Optional follow-up on what is still owed — a reminder only, it moves no money */}
          {onSetReminder && reminderTargets.length > 0 && (
            <section aria-labelledby="rp-reminder-heading" className="mt-4 border-t border-border-strong pt-3.5">
              <h4 id="rp-reminder-heading" className="text-sm font-bold text-foreground">
                Remind me about the {money(allocation.unpaid)} still owed
              </h4>
              <p className="text-xs font-medium text-foreground/70">A personal reminder — it doesn&apos;t change what is owed and isn&apos;t shown on shared statements.</p>
              <ReminderPicker value={reminder} onChange={setReminder} cycleStartDay={cycleStartDay} className="mt-2" />
            </section>
          )}

          {/* 4. The detail: exactly which items this payment settles */}
          <section aria-labelledby="rp-settle-heading" className="mt-4 border-t border-border-strong pt-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 id="rp-settle-heading" className="text-sm font-bold text-foreground">
                Payment allocation
              </h4>
              <div className="flex items-center gap-1">
                {manual && (
                  <button
                    type="button"
                    onClick={() => setManual(null)}
                    className="h-8 rounded-[6px] px-2 text-xs font-semibold text-foreground/80 outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring"
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
                    className="h-8 rounded-[6px] border border-border-strong px-2.5 text-xs font-semibold text-foreground outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {allSelected ? "Clear selection" : "Select all due"}
                  </button>
                )}
              </div>
            </div>
            {options.length === 0 ? (
              <p className="mt-1.5 flex items-center gap-1.5 text-sm font-semibold text-foreground">
                <Check className="size-4 shrink-0 text-success" strokeWidth={2.75} aria-hidden />
                {theyPaid ? `Nothing to receive from ${first} right now` : `Nothing to give to ${first} right now`}
                <span className="font-medium text-foreground/70">— decide what happens to the money below.</span>
              </p>
            ) : (
              <div className="mt-2 overflow-hidden rounded-[6px] border border-border-strong">
                <div
                  aria-hidden
                  className="hidden grid-cols-[1.25rem_minmax(0,1fr)_7rem_7.5rem_8rem] gap-x-3 border-b border-border-strong bg-secondary px-3 py-1.5 text-[11px] font-bold tracking-[0.05em] text-foreground/75 uppercase sm:grid"
                >
                  <span />
                  <span>Item</span>
                  <span className="text-right">Due</span>
                  <span className="text-right">Paying now</span>
                  <span className="text-right">After</span>
                </div>
                <ul className="divide-y divide-border">
                  {visible.map((o) => {
                    const on = selected.has(o.key);
                    const line = lineByKey.get(o.key);
                    const paying = line?.amount ?? 0;
                    const remaining = on ? (line?.remainingAfter ?? o.outstanding) : o.outstanding;
                    const result = !on || paying <= PAYMENT_EPSILON ? null : remaining <= PAYMENT_EPSILON ? "full" : "partial";
                    return (
                      <li
                        key={o.key}
                        data-selected={on || undefined}
                        className={cn(
                          "grid grid-cols-[1.25rem_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5 px-3 py-2 transition-colors sm:grid-cols-[1.25rem_minmax(0,1fr)_7rem_7.5rem_8rem]",
                          on ? "bg-settle-split-tint/50 shadow-[inset_3px_0_0_var(--color-settle-split-edge)]" : "hover:bg-secondary/60",
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() => {
                            setManual(null);
                            toggle(o.key);
                          }}
                          aria-label={`Apply to ${o.title}`}
                          className="size-4 accent-[var(--color-settle-split-edge)]"
                        />
                        <div className="min-w-0">
                          <p className="flex min-w-0 items-center gap-1.5 text-sm font-semibold text-foreground">
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
                          </p>
                          <p className="truncate text-xs font-medium text-foreground/75">
                            {obligationSourceLabel(o, first)} · {formatStatementDate(o.date, true)}
                          </p>
                        </div>
                        {/* On phones the three figures sit in a row under the title; from sm they're grid columns. */}
                        <div className="col-start-2 grid grid-cols-3 items-center gap-2 sm:contents">
                          <div className="text-left sm:text-right">
                            <span className="block text-[10px] font-bold tracking-[0.05em] text-foreground/65 uppercase sm:hidden">Due</span>
                            <span className="block text-sm font-semibold text-foreground tabular-nums">{money(o.outstanding)}</span>
                            {o.amount > o.outstanding + PAYMENT_EPSILON && <span className="block text-[11px] text-foreground/65 tabular-nums">of {money(o.amount)}</span>}
                          </div>
                          <div className="sm:text-right">
                            <span className="block text-[10px] font-bold tracking-[0.05em] text-foreground/65 uppercase sm:hidden">Paying now</span>
                            {on ? (
                              <input
                                type="number"
                                inputMode="decimal"
                                min={0}
                                aria-label={`Paying now for ${o.title}`}
                                value={manual ? (manual[o.key] ?? "") : String(paying)}
                                onChange={(e) => {
                                  // Per-item amounts take over from "Apply to balance" (seeded from its lines).
                                  const seed = seedManual();
                                  setSettleText(null);
                                  setManual((m) => ({
                                    ...(m ?? seed),
                                    [o.key]: e.target.value,
                                  }));
                                }}
                                className={cn(WS_FIELD, "h-8 w-full text-right font-semibold tabular-nums sm:w-28 sm:justify-self-end")}
                              />
                            ) : (
                              <span className="block text-sm text-foreground/55">—</span>
                            )}
                          </div>
                          <div className="text-right">
                            <span className="block text-[10px] font-bold tracking-[0.05em] text-foreground/65 uppercase sm:hidden">After</span>
                            <span
                              className={cn(
                                "block text-sm font-semibold tabular-nums",
                                result === "partial" ? "text-warning" : result === "full" ? "text-success" : "text-foreground",
                              )}
                            >
                              {money(remaining)}
                            </span>
                            {result === "full" ? (
                              <span className="inline-flex items-center gap-1 text-[11px] font-bold text-success">
                                <Check className="size-3" strokeWidth={3} aria-hidden />
                                Paid in full
                              </span>
                            ) : result === "partial" ? (
                              <span className="inline-flex items-center gap-1 text-[11px] font-bold text-warning">
                                <CircleDashed className="size-3" strokeWidth={2.75} aria-hidden />
                                Partially paid
                              </span>
                            ) : (
                              <span className="text-[11px] font-medium text-foreground/60">{on ? "Nothing applied" : "Not selected"}</span>
                            )}
                          </div>
                        </div>
                      </li>
                    );
                  })}
                  {laterCount > 0 && (
                    <li className="px-3 py-1.5">
                      <button
                        type="button"
                        onClick={() => setShowLater((v) => !v)}
                        className="text-xs font-semibold text-foreground/80 underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {showLater ? "Hide upcoming items" : `Show ${laterCount} upcoming ${laterCount === 1 ? "item" : "items"} after this cycle`}
                      </button>
                    </li>
                  )}
                </ul>
                <div className="flex flex-wrap items-center justify-end gap-x-5 gap-y-1 border-t border-border-strong bg-secondary/60 px-3 py-1.5 text-xs font-semibold text-foreground">
                  <span>
                    Selected <span className="tabular-nums">{money(allocation.selectedTotal)}</span>
                  </span>
                  <span>
                    Paying <span className="tabular-nums">{money(allocation.allocated)}</span>
                  </span>
                  <span className={allocation.unpaid > PAYMENT_EPSILON ? "text-warning" : "text-success"}>
                    Still open <span className="tabular-nums">{money(allocation.unpaid)}</span>
                  </span>
                </div>
              </div>
            )}

            {elsewhere.length > 0 && (
              <div className="mt-2 border-l-[3px] border-border-strong pl-3">
                <p className="text-xs font-bold text-foreground/85">
                  Also outstanding — settled at the source ({money(elsewhere.reduce((sum, e) => sum + e.outstanding, 0))})
                </p>
                <ul className="mt-0.5 space-y-0.5 text-xs">
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
          </section>
        </div>

        {/* Sticky payment summary + the action */}
        <aside aria-label="Payment summary" className="border-t border-border-strong bg-secondary/40 px-4 py-3.5 lg:border-t-0 lg:border-l">
          <div className="lg:sticky lg:top-3">
            <p className="text-[11px] font-bold tracking-[0.08em] text-foreground/80 uppercase">Payment summary</p>
            <dl className="mt-2 space-y-1 text-sm">
              <SummaryLine label={theyPaid ? "Received" : "Paid"} value={money(recon.received)} strong />
              <div className="my-1.5 border-t border-border-strong" />
              <SummaryLine label="Settled obligations" value={money(recon.allocated)} dot="bg-settle-split-edge" muted={recon.allocated <= PAYMENT_EPSILON} />
              {theyPaid && (
                <>
                  <SummaryLine label="Set aside" value={money(recon.purpose)} dot="bg-settle-emi-edge" muted={recon.purpose <= PAYMENT_EPSILON} />
                  {hasExtra && extraPlan.purposes.length > 0 && (
                    <div className="ml-4 space-y-0.5 border-l border-border-strong pl-2.5 text-xs">
                      {extraPlan.purposes.map((p, i) => (
                        <div key={i} className="flex items-baseline justify-between gap-3">
                          <dt className="truncate text-foreground/80">{p.title || "Unnamed purpose"}</dt>
                          <dd className="font-semibold text-foreground tabular-nums">{money(p.amount)}</dd>
                        </div>
                      ))}
                    </div>
                  )}
                  <SummaryLine label="Income" value={money(recon.income)} dot="bg-success" muted={recon.income <= PAYMENT_EPSILON} />
                </>
              )}
              <SummaryLine label="Advance" value={money(recon.advance)} dot="bg-settle-advance-edge" muted={recon.advance <= PAYMENT_EPSILON} />
              <div className="my-1.5 border-t border-border-strong" />
              <div className="flex items-baseline justify-between gap-3">
                <dt className="font-semibold text-foreground">Unassigned</dt>
                <dd
                  className={cn(
                    "flex items-center gap-1 font-heading text-[15px] font-bold tabular-nums",
                    recon.balanced ? "text-success" : recon.unallocated < 0 ? "text-expense" : "text-warning",
                  )}
                >
                  {money(recon.unallocated)}
                  {recon.balanced ? <Check className="size-4" strokeWidth={3} aria-label="Balanced" /> : <CircleAlert className="size-4" aria-label="Not balanced" />}
                </dd>
              </div>
              {selected.size > 0 && (
                <SummaryLine
                  label={theyPaid ? `Still owed by ${first}` : `Still owed to ${first}`}
                  value={money(allocation.unpaid)}
                  tone={allocation.unpaid > PAYMENT_EPSILON ? "text-warning" : "text-success"}
                />
              )}
            </dl>
            {outcomeLabel && <p className={cn("mt-2 text-xs font-bold", outcomeLabel.tone)}>{outcomeLabel.text}</p>}
            <p className="mt-1.5 text-xs leading-relaxed text-foreground/75">
              {theyPaid ? `${accountName} goes up` : `${accountName} goes down`} by exactly {money(amount)} — one payment, never counted twice.
            </p>
            {otherSideTotal > PAYMENT_EPSILON && (
              <div className="mt-2 border-l-[3px] border-border-strong pl-2.5 text-xs">
                <p className="font-semibold text-foreground">
                  {theyPaid ? `You also need to give ${first} ${money(otherSideTotal)}` : `${first} also needs to give you ${money(otherSideTotal)}`}
                </p>
                <p className="text-foreground/70">Tracked separately — not subtracted from this payment.</p>
                {!initial && (
                  <button
                    type="button"
                    onClick={() => switchDirection(theyPaid ? "iPaid" : "theyPaid")}
                    className="mt-0.5 font-semibold text-primary-accent-text underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {theyPaid ? "View amount to give →" : "View amount to receive →"}
                  </button>
                )}
              </div>
            )}
            {(error || blocker) && (
              <p className={cn("mt-2 text-xs font-semibold", error ? "text-expense" : "text-foreground/85")} role={error ? "alert" : undefined}>
                {error ?? blocker}
              </p>
            )}
            <div className="mt-3 flex items-center gap-2">
              <button type="button" onClick={onCancel} disabled={saving} className={cn(WS_GHOST, "shrink-0")}>
                Cancel
              </button>
              <button type="submit" disabled={!!blocker || saving || !recon.balanced} className={cn(WS_PRIMARY, "min-w-0 flex-1 truncate whitespace-nowrap")}>
                {saving ? "Saving…" : initial ? "Save changes" : theyPaid ? `Record ${money(amount)} received` : `Record ${money(amount)} paid`}
              </button>
            </div>
          </div>
        </aside>
      </div>
    </form>
  );
}

function Indicator({ label, value, tone, emphasis }: { label: string; value: string; tone?: string; emphasis?: boolean }) {
  return (
    <div
      className={cn(
        "min-w-0 rounded-[6px] border px-2.5 py-1.5",
        emphasis ? "border-primary-accent-text bg-primary/10 shadow-[inset_3px_0_0_var(--color-primary-accent-text)]" : "border-border-strong",
      )}
    >
      <dt className="truncate text-[10.5px] font-bold tracking-[0.06em] text-foreground/75 uppercase">{label}</dt>
      <dd className={cn("truncate font-heading tabular-nums", emphasis ? "text-[17px] font-bold text-foreground" : "text-[15px] font-semibold", !emphasis && (tone ?? "text-foreground"))}>
        {value}
      </dd>
    </div>
  );
}

function SummaryLine({ label, value, tone, strong, dot, muted }: { label: string; value: string; tone?: string; strong?: boolean; dot?: string; muted?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className={cn("flex items-center gap-2", strong ? "font-semibold text-foreground" : "text-foreground/80")}>
        {dot && <span aria-hidden className={cn("size-2 shrink-0 rounded-full", dot, muted && "opacity-40")} />}
        {label}
      </dt>
      <dd className={cn("tabular-nums", strong ? "font-heading text-[16px] font-bold" : "font-semibold", muted ? "text-foreground/55" : (tone ?? "text-foreground"))}>{value}</dd>
    </div>
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
  /** Payments that kept money for a purpose — changed by revert + record. */
  purposePaymentIds?: ReadonlySet<string>,
  /** The separate Income transaction of a payment, by id — without it a payment with an income part isn't editable here. */
  incomeOf?: (transactionId: string) => { amount: number; categoryId: string; description: string } | null,
): RecordPaymentInitial | null {
  const group = entries.filter((e) => e.deletedAt == null && e.paymentId === paymentId);
  if (group.length === 0 || purposePaymentIds?.has(paymentId)) return null;
  // A split-share line is changed by reverting and recording again (its tracking lives on the expense).
  if (group.some((e) => e.installmentPaymentRef != null)) return null;
  const incomeRef = group.find((e) => e.incomeTransactionRef != null)?.incomeTransactionRef ?? null;
  const income = incomeRef ? (incomeOf?.(incomeRef) ?? null) : null;
  if (incomeRef && !income) return null;
  const lines: Record<string, number> = {};
  let advance = 0;
  for (const e of group) {
    if (e.sourceKind === "advance") advance = round2(advance + e.amount);
    else lines[e.obligationRef ?? `ledger:${e.parentEntryId}`] = e.amount;
  }
  return {
    paymentId,
    direction: group[0].type === "repaid" ? "iPaid" : "theyPaid",
    amount: round2(group.reduce((s, e) => s + e.amount, 0) + (income?.amount ?? 0)),
    accountId: group[0].transactionRef ? accountIdOf(group[0].transactionRef) : null,
    date: group[0].date,
    lines,
    advance,
    income,
  };
}

export { routeFor };
