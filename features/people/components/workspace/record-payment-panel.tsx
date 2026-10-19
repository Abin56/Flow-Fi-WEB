"use client";

import { Bell, CalendarClock, CalendarDays, Check, ChevronDown, CircleAlert, Loader2, RotateCcw } from "lucide-react";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { EmiBadge } from "@/features/people/components/cycle-statement/statement-parts";
import type { LedgerRow } from "@/features/people/lib/person-ledger-rows";
import { obligationSourceLabel, paymentLines, routeFor, settlementProjection, timingOf, type PayableObligation } from "@/features/people/lib/person-payment-obligations";
import { useCategories } from "@/hooks/use-categories";
import { formatStatementDate } from "@/lib/engines/person-cycle-statement";
import { money } from "@/lib/engines/person-cycle-statement-share";
import { cycleName } from "@/lib/engines/person-payment-deferral";
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
import { isUnderfunded } from "@/components/finance/payment-source-summary";
import { AccountField, useAccountChoice, withRefund } from "./ledger-ui";
import { WS_FIELD, WS_GHOST, WS_PRIMARY, WsField } from "./person-workspace-ui";
import { usePurposeLinkOptions } from "./purpose-money";
import { draftsToAllocations, ExtraAllocationEditor, newAllocationDraft, type AllocationDraft } from "./extra-allocation-editor";
import { planExtraAllocation } from "@/lib/engines/extra-allocation";
import { DateInput } from "@/components/forms/date-input";
import { ReminderPicker, type ReminderWhen } from "./follow-up";
import { FlowSwitch, flowText, HeroAmount, PanelHeader, type FlowSwitchOption } from "./flow-switch";
import { canPostponeRow, DeferralContext, PostponeFields, usePostponeDraft, type PostponeItem } from "./payment-deferral";

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

type PayChoice = "full" | "part" | "skip";

/** The one top-level choice: money received, money paid, or "not paid yet" (an action that records no money). */
type IntentChoice = PaymentDirection | "postpone";

/**
 * Record payment — one real payment between me and a person, allocated across the exact obligations it
 * pays. Every figure is `allocatePayment`'s (the one rule shared with Flutter); saving writes exactly
 * those lines atomically. Money not applied to bills is never classified silently: it is kept as advance
 * (the default), added as income, or set aside for a purpose — the user's choice, row by row.
 *
 * Presentation: one screen, top to bottom.
 *  A. Money received — amount, account, date, and the total outstanding.
 *  B. Choose what to pay now — every due item as a row with Full / Part / Skip and its own amount. Amounts fill
 *     oldest first until the user takes over a row; skipped items stay unpaid, and (only on request) the rest of
 *     an item can be postponed through the existing Postpone payment write after the receipt is saved.
 *  C. What to do with the money left — a short list of destinations.
 * The summary — the receipt's buckets, and separately what the person still owes — and the action stay pinned below.
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
  onComplete,
  onSetReminder,
  cycleStartDay = 1,
  initialIntent,
  advanceHeld = 0,
  onApplyAdvance,
}: {
  /** Open straight into "Postpone collection" (a lender payment's Postpone link). */
  initialIntent?: "received" | "postpone";
  /** Money this person gave earlier that is still held as advance (not applied) — offered before new money. */
  advanceHeld?: number;
  /** Opens the existing Apply advance panel instead (applying moves no money). */
  onApplyAdvance?: () => void;
  personName: string;
  /** The person's whole-history ledger rows — obligations are read from them. */
  rows: readonly LedgerRow[];
  preselectKey?: string | null;
  initial?: RecordPaymentInitial | null;
  /** The selected People cycle — decides what is brought forward, due now, or later. */
  cycle: { start: Date; end: Date };
  cycleLabel: string;
  onCancel: () => void;
  /**
   * Saves the payment. `keepOpen`: the panel still has follow-up work (postponing what stays unpaid) — the host
   * must not close it; the panel calls `onComplete` once that work is done.
   */
  onSubmit: (input: RecordPaymentInput, paymentId: string | null, options?: { keepOpen?: boolean }) => Promise<void>;
  /** After a `keepOpen` save: everything is done (or the user closed the result) — defaults to `onCancel`. */
  onComplete?: () => void;
  /** Saves a follow-up reminder on each item left open — called only after the payment itself is saved. */
  onSetReminder?: (targets: { key: string; title: string }[], when: ReminderWhen) => Promise<void>;
  /** Settings → Month Cycle start day — "Next cycle" resolves against it. */
  cycleStartDay?: number;
}) {
  const first = personName.split(" ")[0];
  const account = useAccountChoice(initial?.accountId);
  const { data: categories = [] } = useCategories();
  const incomeCategories = useMemo(() => categories.filter((c) => c.deletedAt == null && c.type !== "expense"), [categories]);

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
  const rowByKey = useMemo(() => new Map(rows.map((r) => [r.key, r])), [rows]);

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
  // "Already in my account balance": money received before FlowFi tracked it. It settles what they owe and moves
  // no account (the repository's `recordedEarlier`: money received only, settlement lines only, never future-dated).
  const [inBalance, setInBalance] = useState(false);
  const [dateUnknown, setDateUnknown] = useState(false);
  // Per-item amounts once the user takes over a row (Full / Part / typing). null = automatic, oldest first.
  // Editing shows the payment exactly as it was allocated (not re-allocated oldest first).
  const [manual, setManual] = useState<Record<string, string> | null>(() =>
    initial && Object.keys(initial.lines).length > 0 ? Object.fromEntries(Object.entries(initial.lines).map(([k, v]) => [k, String(v)])) : null,
  );
  // The money left, divided across destinations (purpose / income / advance). null = the default: all of it
  // kept as advance — following the money left as it changes, still shown before anything is recorded.
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
  // "Pay ₹X in total, oldest first" — typed into the list's total. null = the default (as much as the payment covers).
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
  const theyPaid = direction === "theyPaid";

  // ── Per item: what this payment does to it ──
  const lineByKey = new Map(allocation.lines.map((l) => [l.key, l]));
  const payingOf = (o: PayableObligation) => (selected.has(o.key) ? (lineByKey.get(o.key)?.amount ?? 0) : 0);
  const afterOf = (o: PayableObligation) => round2(Math.max(0, o.outstanding - payingOf(o)));
  const choiceOf = (o: PayableObligation): PayChoice | null => {
    if (!selected.has(o.key)) return "skip";
    const paying = payingOf(o);
    if (paying > PAYMENT_EPSILON && paying >= o.outstanding - PAYMENT_EPSILON) return "full";
    if (paying > PAYMENT_EPSILON || (manual != null && o.key in manual)) return "part";
    return null; // selected, but the money ran out before it (automatic order)
  };
  // What this person still owes after the payment: everything due now, plus any later item chosen to pay early.
  const owedRows = options.filter((o) => o.timing !== "later" || selected.has(o.key));
  const stillOwed = round2(owedRows.reduce((t, o) => t + afterOf(o), 0));
  // A selected item that vanished or changed while this was open (paid elsewhere, deleted) — never silently dropped.
  const vanished = [...selected].filter((k) => !options.some((o) => o.key === k && o.outstanding > PAYMENT_EPSILON));

  // ── Postpone what stays unpaid (optional) — the existing deferral write, after the receipt is saved ──
  const deferrals = useContext(DeferralContext);
  const canPostponeAfter = !!deferrals && !initial && theyPaid;
  const postponeRowOf = (o: PayableObligation) => {
    if (!canPostponeAfter || o.timing === "later") return null;
    const row = rowByKey.get(o.key);
    return row && canPostponeRow(row) ? row : null;
  };
  const [postponeAfter, setPostponeAfter] = useState<ReadonlySet<string>>(() => new Set());
  // Each item's live remaining after this payment — what the postponement will expect (never more than is owed).
  const liveAfterItems: PostponeItem[] = owedRows.flatMap((o) => {
    if (!postponeAfter.has(o.key)) return [];
    const row = postponeRowOf(o);
    const left = row ? round2((row.remaining ?? 0) - payingOf(o)) : 0;
    return row && left > PAYMENT_EPSILON ? [{ row: { ...row, remaining: left }, title: o.title }] : [];
  });
  // Frozen when the payment is saved: the live rows change under it, and a retry must re-send the same items.
  const [frozenAfter, setFrozenAfter] = useState<PostponeItem[] | null>(null);
  const afterItems = frozenAfter ?? liveAfterItems;
  const afterDraft = usePostponeDraft(afterItems);
  const postponeTotal = round2(afterItems.reduce((t, i) => t + (i.row.remaining ?? 0), 0));
  const [recorded, setRecorded] = useState(false);

  const earlier = theyPaid && inBalance && !initial;
  const todayInput = toInputDate(new Date());
  // An unknown receipt date is stored on the oldest item it settles (never later than today), flagged "date not known".
  const earlierPlaceholderDate = (() => {
    const today = fromInputDate(todayInput);
    const oldest = options.filter((o) => selected.has(o.key)).map((o) => o.date).sort((a, b) => a.getTime() - b.getTime())[0];
    return oldest && oldest.getTime() <= today.getTime() ? new Date(oldest.getFullYear(), oldest.getMonth(), oldest.getDate()) : today;
  })();
  const earlierBlocker = !earlier
    ? null
    : hasExtra
      ? `Money already in your balance can only settle what ${first} owes — lower the amount to ${money(allocation.allocated)}, or untick “Already in my account balance”.`
      : amount > PAYMENT_EPSILON && allocation.allocated <= PAYMENT_EPSILON
        ? "Choose what this money settled."
        : !dateUnknown && date > todayInput
          ? "A payment already received can't be dated in the future."
          : null;

  const blocker =
    (vanished.length > 0 ? "Some items changed while this was open — review the list." : null) ??
    earlierBlocker ??
    capped?.error ??
    (hasExtra ? extraPlan.error : null) ??
    paymentBlocker({ direction, amount, allocation, resolution, accountId }) ??
    // Money I pay out must be covered by the chosen account (an edit refunds its own payment first — the write checks that case).
    (direction === "iPaid" && account.selected && isUnderfunded(withRefund(account.selected, initial ? { accountId: initial.accountId, amount: initial.amount } : undefined), amount) ? "The chosen account doesn't have enough balance — choose another account or lower the amount." : null) ??
    (liveAfterItems.length > 0 && !afterDraft.ready ? "Choose a reminder date for the postponement." : null);
  // The items this payment leaves open — where a "remind me" goes (each keeps its own remaining). A postponed
  // item carries its own reminder choice instead.
  const reminderTargets = owedRows.filter((o) => afterOf(o) > PAYMENT_EPSILON && !liveAfterItems.some((i) => i.row.key === o.key)).map((o) => ({ key: o.key, title: o.title }));
  const [reminder, setReminder] = useState<ReminderWhen | null>(null);

  // "Hasn't paid yet": no money changes hands, so nothing is recorded — the open receivables are postponed
  // through the existing Postpone payment write (private timing metadata). Offered only inside a ledger.
  const postponable = useMemo<PostponeItem[]>(() => {
    if (!deferrals || initial) return [];
    const pick = preselected?.side === "theyOwe" ? [preselected] : projection.payable.filter((o) => o.side === "theyOwe" && o.timing !== "later");
    return pick.flatMap((o) => {
      const row = rowByKey.get(o.key);
      return row && canPostponeRow(row) ? [{ row, title: o.title }] : [];
    });
  }, [deferrals, initial, rowByKey, projection, preselected]);
  const [intent, setIntent] = useState<"received" | "postpone">(initialIntent ?? "received");
  const [postponeOff, setPostponeOff] = useState<ReadonlySet<string>>(() => new Set());
  const postponeItems = useMemo(() => postponable.filter((i) => !postponeOff.has(i.row.key)), [postponable, postponeOff]);
  const postponeDraft = usePostponeDraft(postponeItems);
  const canPostpone = theyPaid && postponable.length > 0;
  const postponing = canPostpone && intent === "postpone";
  // "Not paid yet" is offered beside Received / Paid whenever there is something to postpone. It is an action, not a
  // direction: choosing it keeps the receivable side (theyPaid) and only switches which form is shown.
  const postponeOffered = postponable.length > 0;
  function selectIntent(v: IntentChoice) {
    if (v === "postpone") {
      if (!theyPaid) switchDirection("theyPaid");
      setIntent("postpone");
      return;
    }
    setIntent("received");
    if (v !== direction) switchDirection(v);
  }
  // The optional follow-ups (postpone the unpaid rest, reminder) live in one collapsed section.
  const [afterOpen, setAfterOpen] = useState(false);
  async function submitPostpone() {
    if (!postponing) return;
    if (await postponeDraft.submit()) (onComplete ?? onCancel)();
  }

  /** One direction at a time — each side's obligations are settled on their own, never netted. */
  function switchDirection(d: PaymentDirection) {
    if (initial) return;
    setDirection(d);
    setSelected(new Set(obligations.filter((o) => o.side === sideForDirection(d) && o.timing !== "later").map((o) => o.key)));
    setManual(null);
    setSettleText(null);
    setExtraDrafts(null);
    setPostponeAfter(new Set());
  }
  // The opposite side, shown for information only — it never reduces this side's outstanding or Full payment.
  const otherSideTotal = theyPaid ? iOweTotal : theyOweTotal;

  // ── Row actions. A row the user takes over turns the whole list into per-item amounts (seeded from what is
  // shown), so a later change to the received amount never re-spreads the user's choices behind their back. ──
  const seedManual = () => manual ?? Object.fromEntries(allocation.lines.map((l) => [l.key, String(l.amount)]));
  const select = (key: string, on: boolean) =>
    setSelected((s) => {
      if (s.has(key) === on) return s;
      const next = new Set(s);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  const inputRefs = useRef(new Map<string, HTMLInputElement>());
  const focusKey = useRef<string | null>(null);
  useEffect(() => {
    const key = focusKey.current;
    if (!key) return;
    focusKey.current = null;
    const el = inputRefs.current.get(key);
    el?.focus();
    el?.select();
  });
  function payFull(o: PayableObligation) {
    // Already paid in full by the automatic order — nothing to change.
    if (manual == null && settleText == null && choiceOf(o) === "full") return;
    setManual({ ...seedManual(), [o.key]: String(o.outstanding) });
    setSettleText(null);
    select(o.key, true);
  }
  function payPart(o: PayableObligation) {
    const paying = payingOf(o);
    setManual({ ...seedManual(), [o.key]: paying > PAYMENT_EPSILON && paying < o.outstanding - PAYMENT_EPSILON ? String(paying) : "" });
    setSettleText(null);
    select(o.key, true);
    focusKey.current = o.key;
  }
  function skip(o: PayableObligation) {
    if (manual != null || settleText != null) {
      setManual(Object.fromEntries(Object.entries(seedManual()).filter(([k]) => k !== o.key)));
      setSettleText(null);
    }
    select(o.key, false);
  }
  function typeAmount(o: PayableObligation, value: string) {
    setManual({ ...seedManual(), [o.key]: value });
    setSettleText(null);
    select(o.key, true);
  }
  function payAllDue() {
    setManual(null);
    setSettleText(null);
    setSelected(new Set(options.filter((o) => o.timing !== "later").map((o) => o.key)));
  }
  function skipAll() {
    setManual(null);
    setSettleText(null);
    setSelected(new Set());
  }
  const togglePostpone = (key: string) =>
    setPostponeAfter((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const submittedRef = useRef(false);
  async function submit() {
    // A ref, not state: a double click lands before the re-render that disables the button. Once saved, the
    // payment is never sent again — a failed postponement afterwards is retried on its own.
    // A no-money postponement records nothing — this payment path never runs for it.
    if (postponing || recorded || blocker || saving || submittedRef.current) return;
    submittedRef.current = true;
    setSaving(true);
    setError(null);
    const toPostpone = liveAfterItems;
    // This render's postpone form (items, cycle, reminder as shown when the user pressed Record).
    const postponeNow = afterDraft.submit;
    const keepOpen = toPostpone.length > 0;
    try {
      const input: RecordPaymentInput = {
        direction,
        amount,
        date: earlier && dateUnknown ? earlierPlaceholderDate : fromInputDate(date),
        accountId: accountId!,
        lines: paymentLines(options, allocation.lines),
        ...(earlier ? { recordedEarlier: true, ...(dateUnknown ? { dateKnown: false } : {}) } : {}),
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
      if (keepOpen) setFrozenAfter(toPostpone);
      await onSubmit(input, initial?.paymentId ?? null, keepOpen ? { keepOpen: true } : undefined);
    } catch (e) {
      submittedRef.current = false;
      setFrozenAfter(null);
      setError(e instanceof Error ? e.message : "Couldn't record the payment.");
      setSaving(false);
      return;
    }
    if (keepOpen) setRecorded(true);
    // Metadata only, after the payment is safely recorded — a failed reminder never undoes the payment.
    if (reminder && onSetReminder && reminderTargets.length > 0) await onSetReminder(reminderTargets, reminder).catch(() => {});
    if (keepOpen && (await postponeNow())) (onComplete ?? onCancel)();
    setSaving(false);
  }
  /** After the receipt is saved: re-sends only the postponements not saved yet (same request ids). */
  async function retryPostpone() {
    if (await afterDraft.submit()) (onComplete ?? onCancel)();
  }

  // Every rupee of this payment, in exactly one bucket — the same reconciliation the history shows.
  const recon = reconcilePayment({
    received: amount,
    allocated: allocation.allocated,
    advance: hasExtra ? extraPlan.advance : 0,
    income: hasExtra ? (extraPlan.income?.amount ?? 0) : 0,
    purpose: hasExtra ? round2(extraPlan.purposes.reduce((t, x) => t + x.amount, 0)) : 0,
  });
  const accountName = account.accounts.find((a) => a.id === accountId)?.name ?? "The chosen account";
  const dueTotal = theyPaid ? theyOweTotal : iOweTotal;
  // The same Due, split by the timing it already has — brought forward vs added this cycle. Presentation only.
  const dueByTiming = (t: "carried" | "cycle") => round2(options.filter((o) => o.timing === t).reduce((sum, o) => sum + o.outstanding, 0));
  const duePrevious = dueByTiming("carried");
  const dueThisCycle = round2(dueTotal - duePrevious);

  // A single destination that held the whole money left keeps holding it when the amount or the bills change
  // (the user's choice of *where* is kept; only its size follows). Split amounts are the user's, left alone.
  const [extraSeen, setExtraSeen] = useState(allocation.extra);
  if (extraSeen !== allocation.extra) {
    setExtraSeen(allocation.extra);
    setExtraDrafts((ds) =>
      ds && ds.length === 1 && Math.abs((Number(ds[0].amount) || 0) - extraSeen) <= PAYMENT_EPSILON
        ? [{ ...ds[0], amount: allocation.extra > 0 ? String(round2(allocation.extra)) : "" }]
        : ds,
    );
  }
  const waiting = amount <= 0;
  const automatic = manual == null && settleText == null;
  const allSkipped = options.length > 0 && selected.size === 0;
  const dueKeys = options.filter((o) => o.timing !== "later").map((o) => o.key);
  const allDueAuto = automatic && dueKeys.length > 0 && dueKeys.every((k) => selected.has(k));
  const ready = amount > 0 && !blocker && recon.balanced;

  // Step 2's live summary: how much of what is owed (due now + any later item chosen early) this payment covers.
  const owedBefore = round2(owedRows.reduce((t, o) => t + o.outstanding, 0));
  // Step 4 (optional): items whose unpaid rest can be postponed, and whether a reminder can be set.
  const postponeRows = owedRows.filter((o) => postponeRowOf(o) && afterOf(o) > PAYMENT_EPSILON);
  const reminderOffered = !!onSetReminder && reminderTargets.length > 0 && amount > PAYMENT_EPSILON;
  const followUpOffered = postponeRows.length > 0 || reminderOffered;
  const followUpOpen = afterOpen || liveAfterItems.length > 0;
  // Presentation-only sanity hints (never block saving): a likely typo in the amount, and money left over while a
  // bill stays unpaid — the one-tap fix reuses the existing "Pay all due" action.
  const amountLooksHigh = dueTotal > PAYMENT_EPSILON && amount > dueTotal * 10 && amount - dueTotal >= 10_000;
  const leftoverWhileOwed = hasExtra && !earlier && stillOwed > PAYMENT_EPSILON && !(theyPaid && allSkipped && !initial);

  if (recorded) {
    return (
      <PostponeResult
        personName={personName}
        first={first}
        amount={amount}
        theyPaid={theyPaid}
        items={afterItems}
        draft={afterDraft}
        saving={saving}
        onRetry={() => void retryPostpone()}
        onDone={onComplete ?? onCancel}
      />
    );
  }

  const dueMeta = (due: number, tone: "in" | "out", active: boolean) =>
    due > PAYMENT_EPSILON ? (
      <>
        <span className={cn("font-semibold tabular-nums", active && flowText(tone))}>{money(due)}</span> due
      </>
    ) : (
      "Nothing due"
    );
  const intentOptions: FlowSwitchOption<IntentChoice>[] = [
    { value: "theyPaid", tone: "in", title: "Received", sub: `from ${first}`, label: `Money received from ${first}`, meta: dueMeta(theyOweTotal, "in", direction === "theyPaid" && !postponing) },
    { value: "iPaid", tone: "out", title: "Paid", sub: `to ${first}`, label: `Money paid to ${first}`, meta: dueMeta(iOweTotal, "out", direction === "iPaid") },
    ...(postponeOffered
      ? [{ value: "postpone", tone: "wait", title: "Not paid yet", label: `Not paid yet — postpone collection from ${first}`, meta: "Move to a later cycle" } satisfies FlowSwitchOption<IntentChoice>]
      : []),
  ];

  return (
    // A real <form>: Enter in a single-line field records through the same submit() as the primary button,
    // with the same gates (blocker / saving / unbalanced allocation) the button's disabled state applies.
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (e.target !== e.currentTarget) return;
        if (postponing) return void submitPostpone();
        if (!recon.balanced) return;
        void submit();
      }}
      aria-label={initial ? `Edit payment — ${personName}` : postponing ? `Postpone payment — ${personName}` : `Record payment — ${personName}`}
      // A column that fills its host (the drawer gives it full height): header pinned on top, footer on the bottom.
      className="mt-4 flex min-h-full flex-col rounded-[12px] border border-border-strong bg-card"
    >
      <PanelHeader
        title={initial ? "Edit payment" : postponing ? "Postpone collection" : "Record payment"}
        personName={personName}
        tone={postponing ? "wait" : theyPaid ? "in" : "out"}
        onClose={onCancel}
        context={
          <>
            <CalendarDays className="size-3 shrink-0" aria-hidden />
            <span className="truncate">{initial ? `Recorded ${formatStatementDate(initial.date, true)}` : cycleLabel}</span>
          </>
        }
      />

      <div className="flex-1 space-y-7 px-4 pt-4 pb-6 sm:px-6">
        {/* ── What happened: one top-level choice — money received, money paid, or "not paid yet" (postpone) ── */}
        <section aria-label="What happened" className="space-y-3">
          <FlowSwitch
            label={postponeOffered ? "What happened" : "Direction"}
            value={postponing ? "postpone" : direction}
            onChange={selectIntent}
            locked={!!initial}
            options={intentOptions}
          />
          {postponing && (
            <div className="overflow-hidden rounded-[12px] border border-border-strong" data-testid="rp-postpone">
              <div className="flex items-start gap-2.5 border-b border-border bg-secondary/40 px-4 py-2.5">
                <CalendarClock className="mt-0.5 size-4 shrink-0 text-foreground/70" aria-hidden />
                <div className="min-w-0">
                  <p className="text-[13px] font-bold text-foreground">Move when you expect {first}&apos;s payment</p>
                  <p className="text-xs text-foreground/70">Nothing is recorded — only the expected cycle changes.</p>
                </div>
              </div>
              <div className="px-4 py-3.5">
              {postponable.length > 1 && (
                <fieldset className="mb-3">
                  <legend className="mb-1 text-xs font-bold text-foreground/85">Items to postpone</legend>
                  <ul className="space-y-1">
                    {postponable.map(({ row, title }) => (
                      <li key={row.key}>
                        <label className="flex min-w-0 items-center gap-2 text-[13px] text-foreground">
                          <input
                            type="checkbox"
                            className="size-4 accent-[var(--color-primary)]"
                            checked={!postponeOff.has(row.key)}
                            // Already postponed in this attempt — stays ticked; a retry skips it.
                            disabled={postponeDraft.doneKeys.has(row.key) || postponeDraft.busy}
                            onChange={() =>
                              setPostponeOff((s) => {
                                const next = new Set(s);
                                if (next.has(row.key)) next.delete(row.key);
                                else next.add(row.key);
                                return next;
                              })
                            }
                          />
                          <span className="min-w-0 truncate font-medium">{title}</span>
                          {postponeDraft.doneKeys.has(row.key) ? (
                            <span className="shrink-0 text-[11px] font-semibold text-foreground/70">Postponed</span>
                          ) : postponeDraft.failures.some((f) => f.key === row.key) ? (
                            <span className="shrink-0 text-[11px] font-semibold text-expense">Not postponed</span>
                          ) : null}
                          <span className="ml-auto shrink-0 font-semibold tabular-nums">{money(row.remaining ?? 0)}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </fieldset>
              )}
              <PostponeFields draft={postponeDraft} noMoneyNote />
              </div>
            </div>
          )}
          {/* Money this person already gave is held as advance — applying it settles without recording new money. */}
          {theyPaid && !initial && !postponing && onApplyAdvance && advanceHeld > PAYMENT_EPSILON && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-[10px] border border-settle-advance-edge/70 bg-settle-advance-tint px-3 py-2 text-xs text-foreground" data-testid="rp-advance-held">
              <span className="min-w-0 flex-1">
                <span className="font-semibold">
                  {first} already gave you {money(advanceHeld)}
                </span>{" "}
                — it&apos;s held as an advance. Apply it to what {first} owes first: no new money is recorded and no account changes.
              </span>
              <button
                type="button"
                onClick={onApplyAdvance}
                className="h-7 shrink-0 rounded-full border border-settle-advance-edge px-2.5 font-semibold text-settle-advance-text outline-none hover:bg-card focus-visible:ring-2 focus-visible:ring-ring"
              >
                Apply advance instead
              </button>
            </div>
          )}
        </section>

        {!postponing && (
          <>
            {/* ── Step 1. Money details: amount, account, funding mode, date, what's outstanding ── */}
            <section aria-labelledby="rp-money-heading">
              <StepHeading id="rp-money-heading" n={1} title="Money details" hint={theyPaid ? "How much came in, where it went, and when." : "How much went out, from which account, and when."} />
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,12rem)]">
                <div className="min-w-0">
                  <HeroAmount label={theyPaid ? "Amount received" : "Amount paid"} value={amountText} onChange={setAmountText} />
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-foreground/75">
                    <span>
                      Total outstanding{" "}
                      <span className={cn("font-semibold tabular-nums", dueTotal > PAYMENT_EPSILON ? (theyPaid ? "text-settle-receivable-text" : "text-settle-payable-text") : "text-foreground")} data-testid="rp-due-total">
                        {money(dueTotal)}
                      </span>
                    </span>
                    {/* Convenience only: types the outstanding figure into the amount — the same as typing it. */}
                    {dueTotal > PAYMENT_EPSILON && amount !== dueTotal && (
                      <button
                        type="button"
                        onClick={() => setAmountText(String(dueTotal))}
                        className="h-6 rounded-full px-2 font-semibold text-foreground ring-1 ring-border-strong outline-none transition-[box-shadow] duration-150 hover:ring-settle-split-edge focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        Use {money(dueTotal)}
                      </button>
                    )}
                    {/* The typed number, grouped the Indian way — so ₹5,75,47,654 can't be mistaken for ₹57,547. */}
                    {amount >= 100_000 && (
                      <span className="ml-auto text-foreground/70">
                        <span aria-hidden>= </span>
                        <span className="font-semibold text-foreground tabular-nums" data-testid="rp-amount-readout">
                          {money(amount)}
                        </span>
                      </span>
                    )}
                    {amountLooksHigh && (
                      <p role="status" className="flex basis-full items-start gap-1.5 rounded-[8px] bg-warning/10 px-2.5 py-1.5 font-medium text-foreground" data-testid="rp-amount-high">
                        <CircleAlert className="mt-px size-3.5 shrink-0 text-warning" aria-hidden />
                        <span>
                          That&apos;s much more than the {money(dueTotal)} {theyPaid ? `${first} owes` : `you owe ${first}`} — check the amount. Anything not applied to bills goes to Remaining money.
                        </span>
                      </p>
                    )}
                    {duePrevious > PAYMENT_EPSILON && (
                      <details className="group basis-full">
                        <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded-[4px] font-semibold text-foreground/75 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                          <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" aria-hidden />
                          {money(duePrevious)} brought forward
                        </summary>
                        <dl className="mt-1.5 grid max-w-xs gap-0.5 rounded-[8px] bg-secondary/50 px-2.5 py-1.5" data-testid="rp-due-breakdown">
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
                            <dd className="font-semibold text-foreground tabular-nums">{money(dueTotal)}</dd>
                          </div>
                        </dl>
                      </details>
                    )}
                  </div>
                </div>
                <div className="flex min-w-0 flex-col gap-1.5">
                  <WsField label={earlier ? "Date received" : "Date"}>
                    <DateInput
                      className={WS_FIELD}
                      value={earlier && dateUnknown ? "" : date}
                      max={earlier ? todayInput : undefined}
                      disabled={earlier && dateUnknown}
                      aria-label={earlier ? "Date received" : undefined}
                      onChange={(e) => setDate(e.target.value)}
                    />
                  </WsField>
                  {earlier && (
                    <label className="flex items-center gap-2 text-xs text-foreground">
                      <input type="checkbox" className="size-3.5 shrink-0 accent-[var(--color-primary)]" checked={dateUnknown} onChange={(e) => setDateUnknown(e.target.checked)} />
                      I don&apos;t know the exact date
                    </label>
                  )}
                </div>
              </div>
              {/* Where the money went — the account and, beside it, the funding mode (through FlowFi, or already in the balance). */}
              <div className="mt-3 grid items-end gap-3 sm:grid-cols-2">
                <AccountField
                  choice={account}
                  label={earlier ? "Received into · for your records" : theyPaid ? "Receive into account" : "Pay from account"} outflow={theyPaid ? undefined : amount > 0 ? amount : null}
                  refund={initial && !theyPaid ? { accountId: initial.accountId, amount: initial.amount } : undefined}
                />
                {theyPaid && !initial && (
                  <label
                    className={cn(
                      "flex cursor-pointer items-start gap-2.5 rounded-[10px] border px-3 py-2 transition-[background-color,border-color] duration-150 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
                      inBalance ? "border-settle-split-edge bg-settle-split-tint/40" : "border-border-strong hover:bg-secondary/50",
                    )}
                    data-testid="rp-in-balance"
                  >
                    <input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-[var(--color-primary)]" checked={inBalance} onChange={(e) => setInBalance(e.target.checked)} />
                    <span className="min-w-0 text-xs text-foreground">
                      <span className="block text-[13px] font-semibold">Already in my account balance</span>
                      <span className="block text-[11.5px] text-foreground/75">Received before FlowFi — only lowers what {first} owes.</span>
                    </span>
                  </label>
                )}
              </div>
            </section>

            {/* ── Step 2. Apply to bills — every due item, decided on its own row ── */}
            <section aria-labelledby="rp-settle-heading">
              <StepHeading
                id="rp-settle-heading"
                n={2}
                title="Apply to bills"
                hint={
                  options.length === 0
                    ? theyPaid
                      ? `Nothing to receive from ${first} right now`
                      : `Nothing to give to ${first} right now`
                    : automatic
                      ? "Choose what to pay now — filled oldest first. Skip anything not being paid now."
                      : "Choose what to pay now — your amounts; the received amount no longer re-fills them."
                }
                right={
                  options.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1">
                      <span
                        aria-live="polite"
                        data-testid="rp-alloc-mode"
                        className={cn(
                          "inline-flex h-7 items-center rounded-full px-2.5 text-[11px] font-bold",
                          automatic ? "bg-secondary text-foreground/75" : "bg-settle-split-tint/70 text-settle-split-text ring-1 ring-settle-split-edge/60",
                        )}
                      >
                        {automatic ? "Auto · oldest first" : "Manual amounts"}
                      </span>
                      {!automatic && (
                        <button type="button" onClick={() => { setManual(null); setSettleText(null); }} className={LIST_ACTION}>
                          <RotateCcw className="size-3.5" aria-hidden />
                          Oldest first
                        </button>
                      )}
                      <button type="button" aria-pressed={allDueAuto} onClick={payAllDue} className={LIST_ACTION}>
                        Pay all due
                      </button>
                      <button type="button" aria-pressed={allSkipped} onClick={skipAll} className={LIST_ACTION}>
                        Skip all
                      </button>
                    </div>
                  )
                }
              />

              {options.length === 0 ? (
                <p className="rounded-[10px] bg-secondary/50 px-3 py-2 text-xs text-foreground/75">The whole amount is money left to use — choose what it is for below.</p>
              ) : (
                <div className={cn("overflow-hidden rounded-[10px] border border-border-strong transition-opacity duration-200", waiting && "opacity-70")}>
                  <ul className="divide-y divide-border" aria-label="Items to pay">
                    {visible.map((o) => (
                      <ObligationRow
                        key={o.key}
                        o={o}
                        first={first}
                        choice={choiceOf(o)}
                        paying={payingOf(o)}
                        after={afterOf(o)}
                        value={selected.has(o.key) ? (manual ? (manual[o.key] ?? "") : capped || payingOf(o) > PAYMENT_EPSILON ? String(payingOf(o)) : "") : ""}
                        inputRef={(el) => {
                          if (el) inputRefs.current.set(o.key, el);
                          else inputRefs.current.delete(o.key);
                        }}
                        onFull={() => payFull(o)}
                        onPart={() => payPart(o)}
                        onSkip={() => skip(o)}
                        onType={(v) => typeAmount(o, v)}
                      />
                    ))}
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
                  {/* The list's total — typing it pays that much in total, oldest first, across the chosen items — and the live result. */}
                  <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-border-strong bg-secondary/50 px-3 py-2">
                    {/* With a single bill the total is that row's amount — shown once, on the row. */}
                    {(visible.length > 1 || settleText != null) && (
                    <label className="flex items-center gap-2 text-xs font-semibold text-foreground">
                      Paying now
                      <span className="relative">
                        <span aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-xs font-semibold text-muted-foreground">
                          ₹
                        </span>
                        <input
                          type="number"
                          inputMode="decimal"
                          step="0.01"
                          min={0}
                          aria-label="Total paying now"
                          aria-invalid={capped?.error ? true : undefined}
                          value={settleText ?? String(allocation.allocated)}
                          onChange={(e) => {
                            setManual(null);
                            setSettleText(e.target.value);
                          }}
                          className={cn(WS_FIELD, "h-8 w-32 pl-6 text-right font-semibold tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none")}
                        />
                      </span>
                    </label>
                    )}
                    <div className="flex min-w-0 flex-wrap items-baseline justify-end gap-x-3 gap-y-1">
                      <p className="text-xs text-foreground/80 tabular-nums" data-testid="rp-bills-summary">
                        <span className="font-semibold text-foreground">{money(allocation.allocated)}</span> of {money(owedBefore)} applied to bills ·{" "}
                        <span className={cn("font-semibold", stillOwed > PAYMENT_EPSILON ? "text-warning" : "text-success")}>{money(stillOwed)}</span> still owed
                      </p>
                      {followUpOffered && !followUpOpen && stillOwed > PAYMENT_EPSILON && (
                        <button
                          type="button"
                          onClick={() => setAfterOpen(true)}
                          className="text-xs font-semibold text-primary-accent-text underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          Remind or postpone the rest ›
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {leftoverWhileOwed && (
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-[8px] bg-warning/10 px-2.5 py-1.5 text-xs text-foreground" data-testid="rp-leftover-while-owed">
                  <CircleAlert className="size-3.5 shrink-0 text-warning" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="font-semibold tabular-nums">{money(stillOwed)}</span> stays unpaid while <span className="font-semibold tabular-nums">{money(allocation.extra)}</span> goes to Remaining money.
                  </span>
                  <button type="button" onClick={payAllDue} className={cn(LIST_ACTION, "bg-card")}>
                    Apply to bills first
                  </button>
                </div>
              )}
              {capped?.error && <Notice tone="warning" role="alert">{capped.error}</Notice>}
              {vanished.length > 0 && (
                <Notice tone="warning" role="alert">
                  {vanished.length === 1 ? "An item you chose" : `${vanished.length} items you chose`} changed or got settled elsewhere while this was open.{" "}
                  <button
                    type="button"
                    onClick={() => {
                      setSelected((s) => new Set([...s].filter((k) => !vanished.includes(k))));
                      if (manual) setManual(Object.fromEntries(Object.entries(manual).filter(([k]) => !vanished.includes(k))));
                    }}
                    className="font-semibold underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    Review the list
                  </button>
                </Notice>
              )}
              {theyPaid && allSkipped && amount > PAYMENT_EPSILON && !initial && (
                <p className="mt-2 rounded-[8px] bg-warning/10 px-2.5 py-1.5 text-xs leading-snug text-foreground" data-testid="rp-settle-nothing-note">
                  <span className="font-semibold tabular-nums">{money(amount)}</span> will still be recorded as received from {first} — none of it reduces what {first} owes.{" "}
                  {canPostpone ? (
                    <>
                      If {first} hasn&apos;t paid,{" "}
                      <button
                        type="button"
                        onClick={() => selectIntent("postpone")}
                        className="font-semibold text-primary-accent-text underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        postpone instead
                      </button>
                      .
                    </>
                  ) : (
                    <>Only use this when money was actually received.</>
                  )}
                </p>
              )}

              {elsewhere.length > 0 && (
                <details className="group mt-2 text-xs">
                  <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded-[4px] font-semibold text-foreground/70 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                    <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" aria-hidden />
                    Also outstanding — settled at the source ({money(elsewhere.reduce((sum, e) => sum + e.outstanding, 0))})
                  </summary>
                  <ul className="mt-1 space-y-0.5 border-l-[3px] border-border-strong pl-3">
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
                </details>
              )}
            </section>

            {/* ── Step 3. Remaining money — always here: the editor when some is left, a calm state when not ── */}
            <section aria-labelledby="rp-remaining-heading">
              <StepHeading
                id="rp-remaining-heading"
                n={3}
                title="Remaining money"
                hint={hasExtra && !earlier ? "Not applied to bills — choose what it is for." : undefined}
                right={
                  hasExtra && !earlier ? (
                    <p className="text-xs text-foreground/70">
                      <span className="font-heading text-[15px] font-bold text-settle-advance-text tabular-nums" data-testid="rp-left-over">
                        {money(allocation.extra)}
                      </span>{" "}
                      left to use
                    </p>
                  ) : undefined
                }
              />
              {earlier ? (
                <p className="rounded-[10px] bg-secondary/50 px-3 py-2.5 text-xs text-foreground/80" data-testid="rp-remaining-none">
                  <span className="font-semibold text-foreground">Nothing to assign.</span> Money already in your balance only settles what {first} owes — it can&apos;t become advance, income or a purpose.
                </p>
              ) : hasExtra ? (
                <div className="duration-200 animate-in fade-in">
                  <ExtraAllocationEditor
                    extra={allocation.extra}
                    direction={direction}
                    firstName={first}
                    drafts={effectiveDrafts}
                    onChange={setExtraDrafts}
                    linkOptions={linkOptions}
                    incomeCategories={incomeCategories}
                  />
                  <p className="mt-1.5 text-[11.5px] text-foreground/70">
                    {accountName} {theyPaid ? "receives" : "pays"} {money(amount)} once — this only decides what the money is for.
                  </p>
                </div>
              ) : (
                <p className="flex items-center gap-2 rounded-[10px] bg-secondary/50 px-3 py-2.5 text-xs text-foreground/80" data-testid="rp-remaining-none">
                  <Check className="size-3.5 shrink-0 text-success" strokeWidth={3} aria-hidden />
                  <span>
                    <span className="font-semibold text-foreground">Nothing left to assign.</span>{" "}
                    {amount > PAYMENT_EPSILON ? `All ${money(amount)} goes to bills.` : "Enter an amount to see what is left."}
                  </span>
                </p>
              )}
            </section>

            {/* ── After recording (optional): postpone what stays unpaid, set a reminder. One collapsed section. ── */}
            {followUpOffered && (
              <section aria-label="After recording (optional)" className="rounded-[10px] border border-border-strong">
                <button
                  type="button"
                  aria-expanded={followUpOpen}
                  aria-controls="rp-after-body"
                  onClick={() => {
                    if (liveAfterItems.length === 0) setAfterOpen((v) => !v);
                  }}
                  className="flex w-full items-center gap-2 rounded-[10px] px-3 py-2.5 text-left outline-none hover:bg-secondary/40 focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <CalendarClock className="size-4 shrink-0 text-foreground/70" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-bold text-foreground">After recording (optional)</span>
                    <span className="block text-xs text-foreground/70">Postpone what stays unpaid, or set a reminder — moves no money.</span>
                  </span>
                  {reminder && reminderOffered && <span className="shrink-0 rounded-full bg-secondary px-2 py-0.5 text-[11px] font-bold text-foreground/80">Reminder set</span>}
                  {liveAfterItems.length > 0 && (
                    <span className="shrink-0 rounded-full bg-secondary px-2 py-0.5 text-[11px] font-bold text-foreground/80">
                      {liveAfterItems.length} to postpone
                    </span>
                  )}
                  <ChevronDown className={cn("size-4 shrink-0 text-foreground/70 transition-transform duration-200", followUpOpen && "rotate-180")} aria-hidden />
                </button>
                {followUpOpen && (
                  <div id="rp-after-body" className="space-y-3 border-t border-border px-3 py-3 duration-200 animate-in fade-in">
                    {postponeRows.length > 0 && (
                      <fieldset>
                        <legend className="text-xs font-bold text-foreground">Postpone what stays unpaid</legend>
                        <p className="mb-1.5 text-[11.5px] text-foreground/70">Moves the unpaid rest to a later cycle once this payment is recorded.</p>
                        <ul className="space-y-1">
                          {postponeRows.map((o) => (
                            <li key={o.key}>
                              <label className="flex min-w-0 cursor-pointer items-center gap-2 text-[13px] text-foreground">
                                <input
                                  type="checkbox"
                                  checked={postponeAfter.has(o.key)}
                                  onChange={() => togglePostpone(o.key)}
                                  aria-label={`Postpone the rest of ${o.title}`}
                                  className="size-4 shrink-0 accent-[var(--color-primary)]"
                                />
                                <span className="min-w-0 truncate font-medium">{o.title}</span>
                                <span className="ml-auto shrink-0 text-xs font-semibold tabular-nums text-foreground/80">
                                  {money(afterOf(o))}
                                  {postponeAfter.has(o.key) && liveAfterItems.length > 0 ? ` → ${cycleName(afterDraft.target)} cycle` : ""}
                                </span>
                              </label>
                            </li>
                          ))}
                        </ul>
                      </fieldset>
                    )}
                    {/* Postponing the unpaid rest — chosen above; its options appear only once one is chosen. */}
                    {liveAfterItems.length > 0 && (
                      <div className="rounded-[10px] border border-border-strong px-3 py-3 duration-200 animate-in fade-in" data-testid="rp-postpone-after">
                        <p className="mb-1.5 flex items-center gap-1.5 text-xs font-bold text-foreground">
                          <CalendarClock className="size-3.5 text-foreground/70" aria-hidden />
                          Postpone after recording · {liveAfterItems.length} {liveAfterItems.length === 1 ? "item" : "items"}
                        </p>
                        <PostponeFields draft={afterDraft} />
                      </div>
                    )}
                    {/* Optional follow-up on what is still owed — a reminder only, it moves no money */}
                    {reminderOffered && (
                      <div className={cn("flex flex-wrap items-center gap-x-2.5 gap-y-1.5", postponeRows.length > 0 && "border-t border-border pt-3")}>
                        <span className="flex items-center gap-1.5 text-xs font-semibold text-foreground" title="Personal only — doesn't change what is owed or appear on shared statements.">
                          <Bell className="size-3.5 text-foreground/70" aria-hidden />
                          Remind me about the {money(round2(reminderTargets.reduce((t, r) => t + afterOf(options.find((o) => o.key === r.key)!), 0)))} still owed
                        </span>
                        <ReminderPicker value={reminder} onChange={setReminder} cycleStartDay={cycleStartDay} />
                        <p className="basis-full text-[11.5px] text-foreground/70" data-testid="rp-reminder-note">
                          {reminder ? `You'll be reminded on ${formatStatementDate(reminder.remindOn)}, after this payment is recorded. ` : ""}
                          A reminder only — it doesn&apos;t postpone what is owed.
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </section>
            )}

            {otherSideTotal > PAYMENT_EPSILON && (
              <p className="text-xs text-foreground/75" title="Tracked separately — not subtracted from this payment.">
                {theyPaid ? `You also need to give ${first} ${money(otherSideTotal)}.` : `${first} also needs to give you ${money(otherSideTotal)}.`}{" "}
                {!initial && (
                  <button
                    type="button"
                    onClick={() => selectIntent(theyPaid ? "iPaid" : "theyPaid")}
                    className="font-semibold text-primary-accent-text underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {theyPaid ? "View amount to give →" : "View amount to receive →"}
                  </button>
                )}
              </p>
            )}
          </>
        )}
      </div>

      {/* ── Always-visible footer: where the money goes, what is still owed (separately), and the action ── */}
      <aside
        aria-label="Payment summary"
        className="sticky bottom-0 z-10 mt-auto border-t border-border-strong bg-card px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-[0_-8px_24px_-12px_rgb(0_0_0/0.18)] sm:px-6"
      >
        {postponing ? (
          <>
            <div className="flex items-center justify-between gap-3">
              <p className="min-w-0 truncate text-xs text-foreground/70">
                <span className="font-heading text-[15px] font-bold text-foreground tabular-nums" data-testid="rp-hero-amount">
                  {money(0)}
                </span>{" "}
                received · <span className="font-semibold text-foreground tabular-nums">{money(postponeDraft.remaining)}</span> still owed
              </p>
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-[11px] font-bold text-foreground/75">
                <CalendarClock className="size-3" aria-hidden />
                No money recorded
              </span>
            </div>
            {postponeDraft.error && (
              <p className="mt-2 flex items-center gap-1.5 text-xs font-semibold text-expense" role="alert">
                <CircleAlert className="size-3.5 shrink-0" aria-hidden />
                {postponeDraft.error}
              </p>
            )}
            {postponable.length > 1 && postponeDraft.failures.length > 0 && (
              <ul className="mt-1 space-y-0.5 pl-5 text-xs text-foreground/80" aria-label="Not postponed">
                {postponeDraft.failures.map((f) => (
                  <li key={f.key}>
                    <span className="font-semibold text-foreground">{f.title}</span> — {f.message}
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-3 flex items-center gap-2">
              <button type="button" onClick={onCancel} disabled={postponeDraft.busy} className={cn(WS_GHOST, "shrink-0")}>
                Cancel
              </button>
              <button
                type="submit"
                disabled={!postponeDraft.ready}
                aria-busy={postponeDraft.busy}
                className={cn(WS_PRIMARY, "h-10 min-w-0 flex-1 truncate whitespace-nowrap transition-[opacity,transform] duration-150 active:scale-[0.985]")}
              >
                {postponeDraft.busy && <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />}
                <span className="truncate">
                  {postponeDraft.busy
                    ? "Postponing…"
                    : postponeDraft.retrying
                      ? `Retry ${money(postponeDraft.pendingRemaining)}`
                      : `Postpone ${money(postponeDraft.pendingRemaining)}`}
                </span>
              </button>
            </div>
          </>
        ) : (
          <>
            {/* The receipt, every rupee in one bucket — received = applied + income + set aside + advance + unassigned. */}
            <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
              <dl className="flex flex-wrap items-baseline gap-x-3.5 gap-y-1 text-xs" aria-label="Where the money goes">
                <Figure label={theyPaid ? "Received" : "Paid"} value={money(recon.received)} testId="rp-hero-amount" strong />
                <Figure label="Applied to bills" value={money(recon.allocated)} testId="rp-applied" dot="bg-settle-split-edge" />
                {recon.income > PAYMENT_EPSILON && <Figure label="Income" value={money(recon.income)} testId="rp-income" dot="bg-success" />}
                {recon.purpose > PAYMENT_EPSILON && <Figure label="Set aside" value={money(recon.purpose)} testId="rp-set-aside" dot="bg-settle-emi-edge" />}
                {recon.advance > PAYMENT_EPSILON && <Figure label="Advance" value={money(recon.advance)} testId="rp-advance" dot="bg-settle-advance-edge" />}
                {/* Only worth a glance when something is off; when balanced it stays for screen readers only. */}
                <Figure
                  label="Not yet assigned"
                  value={money(recon.unallocated)}
                  testId="rp-unassigned"
                  tone={recon.balanced ? "text-foreground/60" : recon.unallocated < 0 ? "text-expense" : "text-warning"}
                  className={recon.balanced && Math.abs(recon.unallocated) <= PAYMENT_EPSILON ? "sr-only" : undefined}
                />
              </dl>
              {/* A different balance — what the person owes after this payment. Never added to the receipt beside it. */}
              {options.length > 0 && (
                <p className="flex flex-wrap items-baseline gap-x-2 text-xs text-foreground/75" title="Not part of this payment — what is still owed after it.">
                  <span className="font-semibold text-foreground">{theyPaid ? `Still owed by ${first}` : `Still owed to ${first}`}</span>
                  <span className={cn("font-heading text-[14px] font-bold tabular-nums", stillOwed > PAYMENT_EPSILON ? "text-warning" : "text-success")} data-testid="rp-still-owed">
                    {money(stillOwed)}
                  </span>
                  {postponeTotal > PAYMENT_EPSILON && (
                    <span data-testid="rp-postpone-total">
                      · {money(postponeTotal)} to be moved to the {cycleName(afterDraft.target)} cycle
                    </span>
                  )}
                </p>
              )}
            </div>

            {earlier && (
              <p className="mt-1.5 text-xs font-medium text-foreground/80" data-testid="rp-in-balance-effect">
                Already in your balance — no account changes. Only what {first} owes goes down.
              </p>
            )}
            {(error || (blocker && amount > 0)) && (
              <p
                className={cn("mt-2 flex items-center gap-1.5 text-xs font-semibold duration-200 animate-in fade-in slide-in-from-bottom-1", error ? "text-expense" : "text-warning")}
                role={error ? "alert" : undefined}
                data-testid="rp-blocker"
              >
                <CircleAlert className="size-3.5 shrink-0" aria-hidden />
                {error ?? blocker}
              </p>
            )}
            <div className="mt-2.5 flex items-center gap-2">
              <button type="button" onClick={onCancel} disabled={saving} className={cn(WS_GHOST, "shrink-0")}>
                Cancel
              </button>
              <button
                type="submit"
                disabled={!ready || saving}
                className={cn(WS_PRIMARY, "h-10 min-w-0 flex-1 truncate whitespace-nowrap transition-[opacity,transform,box-shadow] duration-150 active:scale-[0.985] enabled:hover:shadow-[0_6px_18px_-8px_var(--color-primary)]")}
              >
                {saving && <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />}
                <span className="truncate">
                  {saving
                    ? "Saving…"
                    : initial
                      ? "Save changes"
                      : `Record ${money(amount)} ${earlier ? "received earlier" : theyPaid ? "received" : "paid"}${postponeTotal > PAYMENT_EPSILON ? ` · postpone ${money(postponeTotal)}` : ""}`}
                </span>
              </button>
            </div>
          </>
        )}
      </aside>
    </form>
  );
}

const LIST_ACTION =
  "inline-flex h-7 items-center gap-1 rounded-full border border-border-strong px-2.5 text-xs font-semibold text-foreground/85 outline-none transition-colors duration-150 hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring aria-pressed:border-settle-split-edge aria-pressed:bg-settle-split-tint/60 aria-pressed:text-settle-split-text";

/**
 * One item to pay: what it is and what's due; Full / Part / Skip; the amount paying now (typed directly);
 * and what stays after. (Postponing the unpaid rest is chosen in "After recording (optional)".)
 */
function ObligationRow({
  o,
  first,
  choice,
  paying,
  after,
  value,
  inputRef,
  onFull,
  onPart,
  onSkip,
  onType,
}: {
  o: PayableObligation;
  first: string;
  choice: PayChoice | null;
  paying: number;
  after: number;
  value: string;
  inputRef: (el: HTMLInputElement | null) => void;
  onFull: () => void;
  onPart: () => void;
  onSkip: () => void;
  onType: (v: string) => void;
}) {
  const active = choice === "full" || choice === "part";
  const choices: { k: PayChoice; text: string; label: string; act: () => void }[] = [
    { k: "full", text: "Full", label: `Pay ${o.title} in full`, act: onFull },
    { k: "part", text: "Part", label: `Pay part of ${o.title}`, act: onPart },
    { k: "skip", text: "Skip", label: `Skip ${o.title}`, act: onSkip },
  ];
  return (
    <li
      data-choice={choice ?? "none"}
      className={cn(
        "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2.5 px-3 py-3 transition-colors sm:grid-cols-[minmax(0,1fr)_auto_7.5rem_8.5rem]",
        active ? "bg-settle-split-tint/20 shadow-[inset_3px_0_0_var(--color-settle-split-edge)]" : "",
      )}
    >
      <div className="col-span-2 min-w-0 sm:col-span-1">
        <p className={cn("flex min-w-0 items-center gap-1.5 text-sm font-semibold", choice === "skip" ? "text-foreground/70" : "text-foreground")}>
          <span className="truncate">{o.title}</span>
          {o.isEmi && <EmiBadge />}
          {o.timing === "carried" && (
            <span className="shrink-0 rounded-[4px] bg-settle-carried-badge px-1.5 text-[10px] leading-4 font-bold text-settle-carried-text uppercase">Carried forward</span>
          )}
          {o.timing === "later" && <span className="shrink-0 rounded-[4px] bg-secondary px-1.5 text-[10px] leading-4 font-bold text-foreground/75 uppercase">Upcoming</span>}
        </p>
        <p className="truncate text-xs text-foreground/70">
          {obligationSourceLabel(o, first)} · {formatStatementDate(o.date, true)} ·{" "}
          <span className="font-semibold text-foreground tabular-nums">{money(o.outstanding)}</span> due
          {o.amount > o.outstanding + PAYMENT_EPSILON && <span className="tabular-nums"> of {money(o.amount)}</span>}
        </p>
      </div>

      <div role="group" aria-label={`How much of ${o.title}`} className="inline-flex shrink-0 rounded-[8px] bg-secondary p-0.5">
        {choices.map(({ k, text, label, act }) => (
          <button
            key={k}
            type="button"
            aria-pressed={choice === k}
            aria-label={label}
            onClick={act}
            className={cn(
              "h-7 rounded-[6px] px-2.5 text-xs font-semibold outline-none transition-[background-color,color,box-shadow] duration-150 focus-visible:ring-2 focus-visible:ring-ring",
              choice === k
                ? k === "skip"
                  ? "bg-card text-foreground shadow-sm ring-1 ring-border-strong"
                  : "bg-card text-settle-split-text shadow-sm ring-1 ring-settle-split-edge"
                : "text-foreground/70 hover:text-foreground",
            )}
          >
            {text}
          </button>
        ))}
      </div>

      <div className="relative">
        <span aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-xs font-semibold text-muted-foreground">
          ₹
        </span>
        <input
          ref={inputRef}
          type="number"
          inputMode="decimal"
          step="0.01"
          min={0}
          aria-label={`Paying now for ${o.title}`}
          placeholder="0"
          value={value}
          onChange={(e) => onType(e.target.value)}
          className={cn(
            WS_FIELD,
            "h-8 pl-6 text-right font-semibold tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none",
            !active && "text-foreground/60",
          )}
        />
      </div>

      <div className="min-w-0 text-right">
        {choice === "full" ? (
          <span className="inline-flex items-center gap-1 text-xs font-bold text-success">
            <Check className="size-3.5" strokeWidth={3} aria-hidden />
            Paid in full
          </span>
        ) : (
          <span className={cn("block text-xs font-semibold tabular-nums", choice === "part" && paying > PAYMENT_EPSILON ? "text-warning" : "text-foreground/75")}>
            {choice === "skip" ? `${money(after)} unpaid` : choice === "part" ? `${money(after)} left` : `${money(after)} not covered`}
          </span>
        )}
      </div>
    </li>
  );
}

/** A step's heading: a "Step n" chip (decorative — the heading's name is just the title), the title, and a quiet hint. */
function StepHeading({ id, n, title, hint, right }: { id: string; n: number; title: string; hint?: string; right?: React.ReactNode }) {
  return (
    <div className="mb-2.5 flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5">
      <div className="min-w-0">
        <h4 id={id} className="flex items-center gap-2 text-[14px] font-bold text-foreground">
          <span aria-hidden className="inline-flex h-5 shrink-0 items-center rounded-full bg-secondary px-2 text-[10.5px] font-bold tracking-wide text-foreground/75 uppercase ring-1 ring-border-strong ring-inset">
            Step {n}
          </span>
          {title}
        </h4>
        {hint && <p className="mt-0.5 text-xs text-foreground/70">{hint}</p>}
      </div>
      {right}
    </div>
  );
}

function Notice({ tone, role, children }: { tone: "warning"; role?: "alert"; children: React.ReactNode }) {
  return (
    <p className={cn("mt-2 flex items-start gap-1.5 text-xs font-semibold duration-200 animate-in fade-in", tone === "warning" && "text-warning")} role={role}>
      <CircleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

/** One bucket of the receipt in the pinned summary — label, then amount. */
function Figure({ label, value, testId, tone, dot, strong, className }: { label: string; value: string; testId: string; tone?: string; dot?: string; strong?: boolean; className?: string }) {
  return (
    <div className={cn("flex items-baseline gap-1.5", className)}>
      <dt className="flex items-center gap-1.5 text-foreground/70">
        {dot && <span aria-hidden className={cn("size-2 shrink-0 rounded-full", dot)} />}
        {label}
      </dt>
      <dd className={cn("font-semibold tabular-nums", strong ? "font-heading text-[15px] font-bold text-foreground" : (tone ?? "text-foreground"))} data-testid={testId}>
        {value}
      </dd>
    </div>
  );
}

/**
 * After the receipt is saved, when postponing what stays unpaid didn't fully succeed: the payment is done (said
 * once, plainly); each item says whether it was postponed; Retry re-sends only the ones not saved yet.
 */
function PostponeResult({
  personName,
  first,
  amount,
  theyPaid,
  items,
  draft,
  saving,
  onRetry,
  onDone,
}: {
  personName: string;
  first: string;
  amount: number;
  theyPaid: boolean;
  items: readonly PostponeItem[];
  draft: ReturnType<typeof usePostponeDraft>;
  saving: boolean;
  onRetry: () => void;
  onDone: () => void;
}) {
  const busy = saving || draft.busy;
  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy && draft.ready) onRetry();
      }}
      aria-label={`Payment recorded — ${personName}`}
      className="mt-4 flex min-h-full flex-col rounded-[12px] border border-border-strong bg-card"
    >
      <PanelHeader title="Payment recorded" personName={personName} tone={theyPaid ? "in" : "out"} onClose={onDone} />
      <div className="flex-1 space-y-4 px-4 pt-4 pb-6 sm:px-6">
        <p role="status" className="flex items-center gap-2 rounded-[10px] bg-success/10 px-3 py-2 text-sm font-semibold text-foreground">
          <Check className="size-4 shrink-0 text-success" strokeWidth={3} aria-hidden />
          {money(amount)} {theyPaid ? `received from ${first}` : `paid to ${first}`} is recorded.
        </p>
        <section aria-labelledby="rp-result-postpone">
          <h4 id="rp-result-postpone" className="mb-1.5 text-[13px] font-bold text-foreground">
            Postponing what stays unpaid
          </h4>
          <ul className="divide-y divide-border rounded-[10px] border border-border-strong" aria-label="Postponements">
            {items.map(({ row, title }) => {
              const done = draft.doneKeys.has(row.key);
              const failure = draft.failures.find((f) => f.key === row.key);
              return (
                <li key={row.key} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-3 py-2 text-sm">
                  <span className="min-w-0 truncate font-medium text-foreground">{title}</span>
                  <span className="tabular-nums text-foreground/80">{money(row.remaining ?? 0)}</span>
                  <span className={cn("basis-full text-xs font-semibold", done ? "text-success" : failure ? "text-expense" : "text-foreground/70")}>
                    {done ? "Postponed" : failure ? `Not postponed — ${failure.message}` : busy ? "Postponing…" : "Not postponed yet"}
                  </span>
                </li>
              );
            })}
          </ul>
          {draft.error && (
            <p className="mt-2 flex items-center gap-1.5 text-xs font-semibold text-expense" role="alert">
              <CircleAlert className="size-3.5 shrink-0" aria-hidden />
              {draft.error}
            </p>
          )}
          {draft.doneKeys.size < items.length && (
            <div className="mt-3 rounded-[10px] border border-border px-3 py-3">
              <PostponeFields draft={draft} />
            </div>
          )}
        </section>
      </div>
      <div className="sticky bottom-0 z-10 mt-auto flex items-center gap-2 border-t border-border-strong bg-card px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6">
        <button type="button" onClick={onDone} disabled={busy} className={cn(WS_GHOST, "shrink-0")}>
          Close
        </button>
        <button type="submit" disabled={busy || !draft.ready} aria-busy={busy} className={cn(WS_PRIMARY, "h-10 min-w-0 flex-1 truncate whitespace-nowrap")}>
          {busy && <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />}
          <span className="truncate">{busy ? "Postponing…" : `Retry postponing ${money(draft.pendingRemaining)}`}</span>
        </button>
      </div>
    </form>
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
