"use client";

import { ArrowDownLeft, ArrowUpRight, Bell, CalendarClock, CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, CircleAlert, Info, Loader2, RotateCcw } from "lucide-react";
import { useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { EmiBadge } from "@/features/people/components/cycle-statement/statement-parts";
import type { LedgerRow } from "@/features/people/lib/person-ledger-rows";
import {
  GENERAL_PAYMENT_KEY,
  obligationSourceLabel,
  overallDue,
  paymentLines,
  routeFor,
  settlementProjection,
  timingOf,
  type PayableObligation,
} from "@/features/people/lib/person-payment-obligations";
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
import { SHEET_AMOUNT_TONE, SHEET_BUTTON, SheetAvatar, TransactionSheet } from "@/components/finance/transaction-sheet";
import { useWideBox } from "@/components/finance/use-wide-box";
import { PanelSection } from "@/components/finance/context-panel";
import { DialogDescription, DialogTitle } from "@/components/ui/dialog";
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
  /** Per obligation key; a general payment (tied to no item) is the `GENERAL_PAYMENT_KEY` line. */
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

/**
 * How the money is applied. "general" (the default): it lowers the overall balance and is tied to no item — no
 * transaction is marked paid or part paid. "items": the user says which items it pays (Full / Part / Skip).
 */
type ApplyMode = "general" | "items";

/** The sheet's pages: 1 Money details, 2 Apply to the balance / bills, 3 Finish (money left over + follow-ups). */
type PaymentStep = 1 | 2 | 3;

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
 *  B. How to apply it. By default the money lowers the overall balance and is tied to no item (a general payment:
 *     no transaction is marked paid or part paid). "Choose specific items" instead shows
 *     every due item as a row with Full / Part / Skip and its own amount. Amounts fill
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
  initialInBalance = false,
  advanceHeld = 0,
  onApplyAdvance,
  sheet = false,
}: {
  /**
   * Open as the Transaction Details top sheet (dark header, body, "Still needed" footer) instead of filling a drawer —
   * the body then shows one step page at a time (Money → Apply → Finish).
   */
  sheet?: boolean;
  /** Start with "Already in my account balance" ticked (the row's "Already received" action) — still the user's to untick. */
  initialInBalance?: boolean;
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
  // A row's own "Record payment" (or a lender gate's link to one share) is an explicit choice of item; otherwise
  // the money lowers the overall balance. An edit keeps the payment's own kind.
  const [mode, setMode] = useState<ApplyMode>(() =>
    initial ? (GENERAL_PAYMENT_KEY in initial.lines ? "general" : "items") : preselected ? "items" : "general",
  );
  const formId = useId();
  const general = mode === "general";
  // The overall balance on this side, earlier general payments included — an edit counts its own general part as open again.
  const overall = useMemo(() => overallDue(rows, cycle), [rows, cycle]);
  const generalDue = round2((side === "theyOwe" ? overall.theyOwe : overall.iOwe) + (initial?.lines[GENERAL_PAYMENT_KEY] ?? 0));
  const [selected, setSelected] = useState<Set<string>>(() =>
    initial
      ? new Set(Object.keys(initial.lines).filter((k) => k !== GENERAL_PAYMENT_KEY))
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
  const [inBalance, setInBalance] = useState(initialInBalance);
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
    settleText == null || general
      ? null
      : settleCapLines({ obligations: options, selectedKeys: [...selected], amount, settle: settleText.trim() === "" ? NaN : Number(settleText) });
  // General: the same allocation rule against ONE line — the overall balance — so the money beyond it is the
  // payment's extra (advance / income / purpose), decided explicitly like any extra. No item is touched.
  const allocation = general
    ? allocatePayment({
        obligations: [{ key: GENERAL_PAYMENT_KEY, title: "Overall balance", date: cycle.start, createdAt: cycle.start, amount: generalDue, outstanding: generalDue, side }],
        selectedKeys: [GENERAL_PAYMENT_KEY],
        amount,
      })
    : allocatePayment({
        obligations: options,
        selectedKeys: [...selected],
        amount,
        manual: capped ? capped.manual : manual ? Object.fromEntries(Object.entries(manual).filter(([k]) => k !== GENERAL_PAYMENT_KEY).map(([k, v]) => [k, Number(v) || 0])) : null,
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
  // General: the overall balance less this payment — no item's own remaining changes.
  const stillOwed = general ? round2(Math.max(0, generalDue - allocation.allocated)) : round2(owedRows.reduce((t, o) => t + afterOf(o), 0));
  // A selected item that vanished or changed while this was open (paid elsewhere, deleted) — never silently dropped.
  const vanished = general ? [] : [...selected].filter((k) => !options.some((o) => o.key === k && o.outstanding > PAYMENT_EPSILON));

  // ── Postpone what stays unpaid (optional) — the existing deferral write, after the receipt is saved ──
  // Item by item only: a general payment leaves every item's remaining as it was, so postponing items after it
  // would read as postponing the whole of each one.
  const deferrals = useContext(DeferralContext);
  const canPostponeAfter = !!deferrals && !initial && theyPaid && !general;
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
    const oldest = options.filter((o) => (general ? o.timing !== "later" : selected.has(o.key))).map((o) => o.date).sort((a, b) => a.getTime() - b.getTime())[0];
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
  const reminderTargets = general ? [] : owedRows.filter((o) => afterOf(o) > PAYMENT_EPSILON && !liveAfterItems.some((i) => i.row.key === o.key)).map((o) => ({ key: o.key, title: o.title }));
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
        lines: general
          ? allocation.lines.map((l) => ({ key: GENERAL_PAYMENT_KEY, amount: l.amount, route: { kind: "general" as const } }))
          : paymentLines(options, allocation.lines),
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
  // What "Total outstanding" shows: the overall balance for a general payment, the due items' sum otherwise.
  const shownDue = general ? generalDue : dueTotal;
  const owesSomething = options.length > 0 || generalDue > PAYMENT_EPSILON;
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
  const allSkipped = !general && options.length > 0 && selected.size === 0;
  const dueKeys = options.filter((o) => o.timing !== "later").map((o) => o.key);
  const allDueAuto = automatic && dueKeys.length > 0 && dueKeys.every((k) => selected.has(k));
  const ready = amount > 0 && !blocker && recon.balanced;

  // Step 2's live summary: how much of what is owed (due now + any later item chosen early) this payment covers.
  const owedBefore = general ? generalDue : round2(owedRows.reduce((t, o) => t + o.outstanding, 0));
  // Step 4 (optional): items whose unpaid rest can be postponed, and whether a reminder can be set.
  const postponeRows = owedRows.filter((o) => postponeRowOf(o) && afterOf(o) > PAYMENT_EPSILON);
  const reminderOffered = !!onSetReminder && reminderTargets.length > 0 && amount > PAYMENT_EPSILON;
  const followUpOffered = postponeRows.length > 0 || reminderOffered;
  const followUpOpen = afterOpen || liveAfterItems.length > 0;
  // Presentation-only sanity hints (never block saving): a likely typo in the amount, and money left over while a
  // bill stays unpaid — the one-tap fix reuses the existing "Pay all due" action.
  const amountLooksHigh = shownDue > PAYMENT_EPSILON && amount > shownDue * 10 && amount - shownDue >= 10_000;
  function switchMode(next: ApplyMode) {
    if (initial || next === mode) return;
    setMode(next);
    setManual(null);
    setSettleText(null);
    setPostponeAfter(new Set());
  }
  const leftoverWhileOwed = hasExtra && !earlier && stillOwed > PAYMENT_EPSILON && !(theyPaid && allSkipped && !initial);
  // Presentation only — each step's badge turns into a check once the figures it shows are settled, and the summary's
  // meter shows how much of the total this payment covers. Nothing here gates saving (the blocker above does).
  const step1Done = amount > PAYMENT_EPSILON && (earlier || !!account.selected);
  const step2Done = amount > PAYMENT_EPSILON && (allocation.allocated > PAYMENT_EPSILON || !owesSomething) && !capped?.error && vanished.length === 0;
  const step3Done = amount > PAYMENT_EPSILON && (!hasExtra || (!earlier && !extraPlan.error));
  const summaryTotal = general ? generalDue : shownDue;
  const coverage = summaryTotal > PAYMENT_EPSILON ? Math.min(1, Math.max(0, (summaryTotal - stillOwed) / summaryTotal)) : 0;
  const step2Warn = !!capped?.error || vanished.length > 0 || leftoverWhileOwed;
  const step3Warn = (hasExtra && !earlier && !!extraPlan.error) || (liveAfterItems.length > 0 && !afterDraft.ready);

  // ── The sheet's step pages (presentation only: every control keeps its state while its page is hidden) ──
  const [step, setStep] = useState<PaymentStep>(1);
  const [stepDir, setStepDir] = useState<"forward" | "back">("forward");
  // A wide sheet has room for everything at once (Money and Apply side by side), so it needs no pages; a narrow one pages.
  const [bodyBox, wideSheet] = useWideBox(880);
  const paged = sheet && !wideSheet;
  const stickyRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  function goToStep(next: PaymentStep) {
    if (next === step) return;
    setStepDir(next > step ? "forward" : "back");
    setStep(next);
  }
  // A new page starts at its top: when the sheet is scrolled past it, scroll back so the page begins right under the
  // pinned summary + step bar (never further down than the user already is).
  const stepSeen = useRef(step);
  useEffect(() => {
    if (stepSeen.current === step) return;
    stepSeen.current = step;
    const page = pageRef.current;
    const scroller = page?.closest<HTMLElement>('[data-testid="sheet-body"]');
    if (!page || !scroller) return;
    const pinned = stickyRef.current?.offsetHeight ?? 0;
    const target = page.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - pinned - 12;
    if (scroller.scrollTop > target) scroller.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
  }, [step]);

  if (recorded) {
    return (
      <PostponeResult
        sheet={sheet}
        formId={formId}
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

  // A real <form>: Enter in a single-line field records through the same submit() as the primary button,
  // with the same gates (blocker / saving / unbalanced allocation) the button's disabled state applies.
  const formProps = {
    noValidate: true,
    onSubmit: (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      if (e.target !== e.currentTarget) return;
      if (postponing) return void submitPostpone();
      if (paged && step < 3) return void goToStep((step + 1) as PaymentStep);
      if (!recon.balanced) return;
      void submit();
    },
    "aria-label": initial ? `Edit payment — ${personName}` : postponing ? `Postpone payment — ${personName}` : `Record payment — ${personName}`,
  };
  const heroTitle = initial ? "Edit payment" : postponing ? "Postpone collection" : "Record payment";
  const heroTone = postponing ? "wait" : theyPaid ? "in" : "out";
  const heroAmount = !postponing && amount > PAYMENT_EPSILON ? money(amount) : undefined;
  const heroStatus = initial ? undefined : postponing ? "Not paid yet" : theyPaid ? "Receiving" : "Paying";
  const heroContext = (
    <>
      <CalendarDays className="size-3 shrink-0" aria-hidden />
      <span className="truncate">{initial ? `Recorded ${formatStatementDate(initial.date, true)}` : cycleLabel}</span>
    </>
  );

  // One line per step for the step bar — what each page currently says, read from the figures above.
  const step1Summary =
    amount > PAYMENT_EPSILON ? `${money(amount)} · ${earlier ? "already in balance" : account.selected ? accountName : "choose account"}` : "Amount, date, account";
  const step2Summary = !owesSomething
    ? "Nothing owed"
    : general
      ? `${money(allocation.allocated)} · overall balance`
      : `${money(allocation.allocated)} · ${selected.size} of ${options.length} ${options.length === 1 ? "item" : "items"}`;
  const step3Summary = [
    hasExtra && !earlier ? `${money(allocation.extra)} left to assign` : "Nothing left over",
    liveAfterItems.length > 0 ? `${liveAfterItems.length} to postpone` : null,
    reminder && reminderOffered ? "reminder" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  // The body's pieces. Inline (the expanded ledger) shows them one under another; the sheet shows the intent and the
  // summary, then one step page at a time (Money → Apply → Finish) — the same controls, never a second copy.
  const intentSection = (
      <>
        {/* ── What happened: one top-level choice — money received, money paid, or "not paid yet" (postpone) ── */}
        <section aria-label="What happened" className="space-y-3">
          {sheet ? (
            <div className="space-y-1.5 @4xl:grid @4xl:grid-cols-[minmax(0,1fr)_17rem] @4xl:items-center @4xl:gap-x-5 @4xl:space-y-0">
              <IntentPicker
                label={postponeOffered ? "What happened" : "Direction"}
                value={postponing ? "postpone" : direction}
                onChange={selectIntent}
                locked={!!initial}
                options={[
                  { value: "theyPaid", tone: "in", title: "Received", sub: `${first} paid me`, label: intentOptions[0].label, meta: theyOweTotal > PAYMENT_EPSILON ? `${money(theyOweTotal)} due` : "Nothing due" },
                  { value: "iPaid", tone: "out", title: "Paid", sub: `I paid ${first}`, label: intentOptions[1].label, meta: iOweTotal > PAYMENT_EPSILON ? `${money(iOweTotal)} you owe` : "You owe nothing" },
                  ...(postponeOffered
                    ? [{ value: "postpone" as const, tone: "wait" as const, title: "Not paid yet", sub: "Move to later", label: intentOptions[2].label, meta: `${money(postponeDraft.remaining)} expected` }]
                    : []),
                ]}
              />
              {/* What the choice means, in one line — the toolbar's labels are short. */}
              <p key={postponing ? "postpone" : direction} className={cn("flex items-start gap-1.5 px-1 text-[11.5px] leading-snug text-foreground/70 duration-200 animate-in fade-in")} data-testid="rp-intent-help">
                <Info className="mt-px size-3.5 shrink-0 text-foreground/45" aria-hidden />
                <span>
                  {initial
                    ? "Editing a recorded payment — its direction can't change."
                    : postponing
                      ? `${first} hasn't paid yet. Choose when you now expect it — nothing is recorded and no balance changes.`
                      : theyPaid
                        ? `Money ${first} gave you. It lowers what ${first} owes you.`
                        : iOweTotal > PAYMENT_EPSILON
                          ? `Money you gave ${first}. It lowers what you owe ${first}.`
                          : `Money you gave ${first}. You owe ${first} nothing right now, so you'll choose what it is for on the Finish step.`}
                </span>
              </p>
            </div>
          ) : (
          <FlowSwitch
            label={postponeOffered ? "What happened" : "Direction"}
            value={postponing ? "postpone" : direction}
            onChange={selectIntent}
            locked={!!initial}
            options={intentOptions}
          />
          )}
          {postponing && sheet && (
            <div className={cn("duration-300 animate-in fade-in slide-in-from-bottom-1", wideSheet ? "grid items-start gap-4 grid-cols-[minmax(0,5fr)_minmax(0,6fr)]" : "space-y-2.5")} data-testid="rp-postpone">
              <div className="overflow-hidden rounded-[14px] border border-border bg-card shadow-e1">
                <div className="flex items-center gap-3 bg-gradient-to-r from-secondary/80 to-card px-3 py-2.5">
                  <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-[11px] bg-foreground text-card shadow-e1">
                    <CalendarClock className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-bold text-foreground">Move when you expect {first}&apos;s payment</p>
                    <p className="truncate text-[11.5px] text-foreground/65">
                      {postponable.length === 1 ? postponable[0].title : `${postponeItems.length} of ${postponable.length} items selected`}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-[10px] font-bold tracking-[0.08em] text-foreground/55 uppercase">Still owed</p>
                    <p className="font-heading text-[17px] leading-tight font-bold tabular-nums text-foreground">{money(postponeDraft.remaining)}</p>
                  </div>
                </div>
                {postponable.length > 1 && (
                  <fieldset className="border-t border-border">
                    <legend className="sr-only">Items to postpone</legend>
                    <div className="flex items-center justify-between gap-2 px-3 pt-2 pb-1">
                      <span aria-hidden className="text-[11px] font-bold tracking-[0.06em] text-foreground/60 uppercase">Items to postpone</span>
                      <button
                        type="button"
                        disabled={postponeDraft.busy}
                        onClick={() =>
                          // Items already postponed in this attempt stay ticked either way (a retry skips them).
                          setPostponeOff(postponeOff.size === 0 ? new Set(postponable.filter((i) => !postponeDraft.doneKeys.has(i.row.key)).map((i) => i.row.key)) : new Set())
                        }
                        className="rounded-[6px] px-1.5 text-[11.5px] font-semibold text-primary-accent-text outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                      >
                        {postponeOff.size === 0 ? "Clear all" : "Select all"}
                      </button>
                    </div>
                    <ul className={cn("divide-y divide-border overflow-y-auto overscroll-contain", wideSheet ? "max-h-72" : "max-h-48")}>
                      {postponable.map(({ row, title }) => {
                        const on = !postponeOff.has(row.key);
                        return (
                          <li key={row.key}>
                            <label className={cn("flex min-w-0 cursor-pointer items-center gap-2.5 px-3 py-2 transition-colors duration-150 hover:bg-secondary/50", !on && "opacity-60")}>
                              <input
                                type="checkbox"
                                className="size-4 shrink-0 accent-[var(--color-primary)]"
                                checked={on}
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
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-[13px] font-semibold text-foreground">{title}</span>
                                <span className="block truncate text-[11px] text-foreground/60">{formatStatementDate(row.date, true)}</span>
                              </span>
                              {postponeDraft.doneKeys.has(row.key) ? (
                                <span className="shrink-0 rounded-full bg-success/12 px-2 py-0.5 text-[10.5px] font-bold text-success">Postponed</span>
                              ) : postponeDraft.failures.some((f) => f.key === row.key) ? (
                                <span className="shrink-0 rounded-full bg-expense/10 px-2 py-0.5 text-[10.5px] font-bold text-expense">Not postponed</span>
                              ) : null}
                              <span className="shrink-0 text-[13px] font-semibold tabular-nums text-foreground">{money(row.remaining ?? 0)}</span>
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                  </fieldset>
                )}
              </div>
              <div className="rounded-[14px] border border-border bg-card p-3 shadow-e1">
                <PostponeFields draft={postponeDraft} noMoneyNote compact />
              </div>
            </div>
          )}
          {postponing && !sheet && (
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

      </>
  );
  const summaryStrip = (
          <>
            {/* ── Money summary: total · receiving/paying now · remaining — the same figures, shown once, up top ── */}
            {(general && owesSomething) || (!general && options.length > 0) ? (
              <div className={cn("overflow-hidden rounded-[12px] border border-border-strong bg-card shadow-e1 transition-opacity duration-200", waiting && "opacity-70")}>
                <dl aria-label="Money summary" className="grid grid-cols-3 divide-x divide-border" data-testid={general ? "rp-general" : "rp-summary"}>
                  <GeneralFigure label="Total" value={money(summaryTotal)} testId={general ? "rp-general-due" : "rp-due-total"} />
                  <GeneralFigure label={theyPaid ? "Receiving now" : "Paying now"} value={money(general ? allocation.allocated : amount)} testId={general ? "rp-general-paying" : "rp-sum-now"} />
                  <GeneralFigure label="Remaining" value={money(stillOwed)} testId={general ? "rp-general-left" : "rp-sum-left"} tone={stillOwed > PAYMENT_EPSILON ? "text-warning" : "text-success"} />
                </dl>
                {/* How much of the total this payment covers — the same figures as above, drawn. */}
                <div aria-hidden className="h-1 bg-secondary">
                  <div
                    className={cn("h-full rounded-r-full transition-[width,background-color] duration-300 ease-out motion-reduce:transition-none", coverage >= 1 ? "bg-success" : "bg-primary")}
                    style={{ width: `${coverage * 100}%` }}
                  />
                </div>
              </div>
            ) : null}

          </>
  );
  const showSummary = (general && owesSomething) || (!general && options.length > 0);
  const moneyStep = (
          <>
            {/* ── Step 1. Money details: amount, account, funding mode, date, what's outstanding ── */}
            <section aria-labelledby="rp-money-heading" className={RP_CARD}>
              <StepHeading id="rp-money-heading" n={1} title="Money details" done={step1Done} />
              <div className="grid gap-3 @md:grid-cols-[minmax(0,1fr)_minmax(0,12rem)]">
                <div className="min-w-0 rounded-xl bg-secondary/60 p-3">
                  <HeroAmount label={theyPaid ? "Amount received" : "Amount paid"} value={amountText} onChange={setAmountText} />
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-foreground/75">
                    {/* With the summary strip above, the total is shown there once; otherwise (nothing itemised) it stays here. */}
                    {(general || options.length === 0) && (
                      <span className={general && owesSomething ? "sr-only" : undefined}>
                        Total outstanding{" "}
                        <span className={cn("font-semibold tabular-nums", shownDue > PAYMENT_EPSILON ? (theyPaid ? "text-settle-receivable-text" : "text-settle-payable-text") : "text-foreground")} data-testid="rp-due-total">
                          {money(shownDue)}
                        </span>
                      </span>
                    )}
                    {/* Convenience only: types the outstanding figure into the amount — the same as typing it. */}
                    {shownDue > PAYMENT_EPSILON && amount !== shownDue && (
                      <button
                        type="button"
                        onClick={() => setAmountText(String(shownDue))}
                        className="h-6 rounded-full bg-primary/25 px-2.5 font-semibold text-foreground ring-1 ring-primary-accent-text/40 outline-none transition-[box-shadow,background-color] duration-150 hover:bg-primary/40 focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        Use {money(shownDue)}
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
                          That&apos;s much more than the {money(shownDue)} {theyPaid ? `${first} owes` : `you owe ${first}`} — check the amount. Anything not applied to bills goes to Remaining money.
                        </span>
                      </p>
                    )}
                    {/* The items' breakdown — only while it adds up to the figure shown (a general payment earlier lowers the balance, not an item). */}
                    {duePrevious > PAYMENT_EPSILON && Math.abs(shownDue - dueTotal) <= PAYMENT_EPSILON && (
                      <details className="group">
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
                <div className="flex min-w-0 flex-col gap-1.5 @md:pt-3">
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
              <div className="mt-3 grid items-end gap-3 border-t border-border pt-3 @md:grid-cols-2">
                <AccountField
                  choice={account}
                  label={earlier ? "Received into · for your records" : theyPaid ? "Receive into account" : "Pay from account"} outflow={theyPaid ? undefined : amount > 0 ? amount : null}
                  refund={initial && !theyPaid ? { accountId: initial.accountId, amount: initial.amount } : undefined}
                />
                {theyPaid && !initial && (
                  <label
                    className={cn(
                      "flex cursor-pointer items-center gap-3 rounded-[12px] border px-3 py-2.5 transition-[background-color,border-color] duration-150 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
                      inBalance ? "border-settle-split-edge bg-settle-split-tint/40" : "border-border-strong hover:bg-secondary/50",
                    )}
                    data-testid="rp-in-balance"
                  >
                    <input type="checkbox" className="peer sr-only" checked={inBalance} onChange={(e) => setInBalance(e.target.checked)} />
                    <span
                      aria-hidden
                      className="relative h-5 w-9 shrink-0 rounded-full bg-border-strong transition-colors duration-200 peer-checked:bg-primary-accent-text after:absolute after:top-0.5 after:left-0.5 after:size-4 after:rounded-full after:bg-white after:shadow-sm after:transition-transform after:duration-200 peer-checked:after:translate-x-4"
                    />
                    <span className="min-w-0 text-xs text-foreground">
                      <span className="block text-[13px] font-semibold">Already in my account balance</span>
                      <span className="block text-[11.5px] text-foreground/75">Received before FlowFi — only lowers what {first} owes.</span>
                    </span>
                  </label>
                )}
              </div>
            </section>

          </>
  );
  const applyStep = (
          <>
            {/* ── Step 2. Apply to bills — every due item, decided on its own row ── */}
            <section aria-labelledby="rp-settle-heading" className={RP_CARD}>
              <StepHeading
                id="rp-settle-heading"
                n={2}
                done={step2Done}
                title={general && owesSomething ? "Apply to balance" : "Apply to bills"}
                hint={
                  wideSheet || (general && owesSomething)
                    ? undefined
                    : options.length === 0
                    ? theyPaid
                      ? `Nothing to receive from ${first} right now`
                      : `Nothing to give to ${first} right now`
                    : automatic
                      ? "Filled oldest first — skip what isn't paid now."
                      : "Your amounts — the received amount no longer re-fills them."
                }
                right={
                  !general && options.length > 0 && (
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

              {owesSomething && <ApplyModeSwitch mode={mode} onChange={switchMode} locked={!!initial} itemCount={options.length} />}
              {general && owesSomething ? (
                <p className="flex items-start gap-1.5 rounded-[8px] bg-secondary/40 px-3 py-2 text-[11.5px] leading-snug text-foreground/80" data-testid="rp-general-note">
                  <Info className="mt-px size-3.5 shrink-0 text-foreground/55" aria-hidden />
                  <span>
                    Not tied to any item — no transaction is marked paid or part paid.
                    {theyPaid && options.some((o) => o.isEmi) && " For one EMI share, choose specific items."}
                  </span>
                </p>
              ) : options.length === 0 ? (
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
                      <p className={cn("text-xs text-foreground/80 tabular-nums", wideSheet && sheet && "sr-only")} data-testid="rp-bills-summary">
                        <span className="font-semibold text-foreground">{money(allocation.allocated)}</span> of {money(owedBefore)} applied to bills ·{" "}
                        <span className={cn("font-semibold", stillOwed > PAYMENT_EPSILON ? "text-warning" : "text-success")}>{money(stillOwed)}</span> still owed
                      </p>
                      {followUpOffered && !followUpOpen && stillOwed > PAYMENT_EPSILON && (
                        <button
                          type="button"
                          onClick={() => {
                            setAfterOpen(true);
                            if (paged) goToStep(3);
                          }}
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

              {!general && allocation.allocated > generalDue + PAYMENT_EPSILON && generalDue < dueTotal - PAYMENT_EPSILON && (
                <Notice tone="warning" role="status">
                  {money(allocation.allocated)} is more than the {money(generalDue)} still owed overall — earlier payments not tied to an item already lowered the balance.
                  The rest would count as {theyPaid ? `money you owe ${first}` : `money ${first} owes you`}.
                </Notice>
              )}
              {!general && elsewhere.length > 0 && (
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

          </>
  );
  const finishStep = (
          <>
            {/* ── Step 3. Remaining money — always here: the editor when some is left, one calm line when not ── */}
            {hasExtra && !earlier ? (
              <section aria-labelledby="rp-remaining-heading" className={cn(RP_CARD, "duration-200 animate-in fade-in")}>
                <StepHeading
                  id="rp-remaining-heading"
                  n={3}
                  done={step3Done}
                  title="Remaining money"
                  hint="Choose what it is for."
                  right={
                    <p className="text-xs text-foreground/70">
                      <span className="font-heading text-[15px] font-bold text-settle-advance-text tabular-nums" data-testid="rp-left-over">
                        {money(allocation.extra)}
                      </span>{" "}
                      left to use
                    </p>
                  }
                />
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
              </section>
            ) : (
              <section aria-labelledby="rp-remaining-heading" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-border bg-card px-3 py-2.5 shadow-e1">
                <h4 id="rp-remaining-heading" className="flex shrink-0 items-center gap-2 text-[13px] font-bold text-foreground">
                  <StepBadge n={3} done={step3Done} />
                  Remaining money
                </h4>
                {earlier ? (
                  <p className="min-w-0 flex-1 text-xs text-foreground/80" data-testid="rp-remaining-none">
                    <span className="font-semibold text-foreground">Nothing to assign.</span> Money already in your balance only settles what {first} owes — it can&apos;t become advance, income or a purpose.
                  </p>
                ) : (
                  <p className="min-w-0 flex-1 text-xs text-foreground/80" data-testid="rp-remaining-none">
                    <span className="font-semibold text-foreground">Nothing left to assign.</span>{" "}
                    {amount > PAYMENT_EPSILON ? `All ${money(amount)} goes to ${general ? "the balance" : "bills"}.` : "Enter an amount to see what is left."}
                  </p>
                )}
              </section>
            )}

            {/* ── After recording (optional): postpone what stays unpaid, set a reminder. One collapsed section,
                held open while a postponement is chosen. ── */}
            {followUpOffered && (
              <PanelSection
                className="shadow-e1"
                open={followUpOpen}
                onOpenChange={(next) => {
                  if (liveAfterItems.length === 0) setAfterOpen(next);
                }}
                title={
                  <span className="inline-flex items-center gap-2">
                    <CalendarClock className="size-4 shrink-0 text-foreground/70" aria-hidden />
                    After recording (optional)
                  </span>
                }
                summary={
                  reminder && reminderOffered ? (
                    <span className="rounded-full bg-secondary px-2 py-0.5 text-[11px] font-bold text-foreground/80">Reminder set</span>
                  ) : (
                    wideSheet ? undefined : "Postpone the rest or set a reminder"
                  )
                }
              >
                <div className="space-y-3">
                  {postponeRows.length > 0 && (
                    <fieldset>
                      <legend className="flex w-full items-center justify-between gap-2 text-xs font-bold text-foreground">
                        Postpone what stays unpaid
                        {liveAfterItems.length > 0 && (
                          <span className="shrink-0 rounded-full bg-secondary px-2 py-0.5 text-[11px] font-bold text-foreground/80">
                            {liveAfterItems.length} to postpone
                          </span>
                        )}
                      </legend>
                      <p className="mb-1.5 text-[11.5px] text-foreground/70">Moves the unpaid rest to a later cycle once this payment is recorded.</p>
                      <ul className="divide-y divide-border overflow-hidden rounded-[10px] border border-border">
                        {postponeRows.map((o) => (
                          <li key={o.key}>
                            <label
                              className={cn(
                                "flex min-w-0 cursor-pointer items-center gap-2 px-2.5 py-2 text-[13px] text-foreground transition-colors duration-150 hover:bg-secondary/50",
                                postponeAfter.has(o.key) && "bg-settle-split-tint/25",
                              )}
                            >
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
                    <div className="rounded-[10px] border border-border-strong px-3 py-3 duration-200 animate-in fade-in slide-in-from-top-1" data-testid="rp-postpone-after">
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
              </PanelSection>
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
  );

  // The sheet's last page ends with what Record will do, line by line — the same figures the pages and footer show.
  const paidLines = general
    ? []
    : allocation.lines.flatMap((l) => {
        const o = options.find((x) => x.key === l.key);
        return o && l.amount > PAYMENT_EPSILON && selected.has(l.key) ? [{ key: l.key, title: o.title, amount: l.amount, full: l.amount >= o.outstanding - PAYMENT_EPSILON }] : [];
      });
  const leftoverParts = [
    recon.advance > PAYMENT_EPSILON ? `${money(recon.advance)} advance` : null,
    recon.income > PAYMENT_EPSILON ? `${money(recon.income)} income` : null,
    recon.purpose > PAYMENT_EPSILON ? `${money(recon.purpose)} set aside` : null,
  ].filter((x): x is string => x != null);
  const reviewCard = (
    <section aria-labelledby="rp-review-heading" className={cn(RP_CARD, "bg-gradient-to-b from-card to-secondary/30")} data-testid="rp-review">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h4 id="rp-review-heading" className="flex items-center gap-2 text-[13px] font-bold text-foreground">
          <span aria-hidden className={cn("grid size-5 place-items-center rounded-full", ready ? "bg-success text-success-foreground" : "bg-secondary text-foreground/70 ring-1 ring-border-strong ring-inset")}>
            {ready ? <Check className="size-3" strokeWidth={3} /> : <Info className="size-3" strokeWidth={2.5} />}
          </span>
          Review before recording
        </h4>
        <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-bold", ready ? "bg-success/12 text-[oklch(0.44_0.13_149)] dark:text-success" : "bg-warning/15 text-foreground/80")}>
          {ready ? "Ready" : "Not ready yet"}
        </span>
      </div>
      <dl className="divide-y divide-border text-[13px]">
        <ReviewRow label={theyPaid ? "Received" : "Paid"} onEdit={() => goToStep(1)} editLabel="Edit amount">
          {amount > PAYMENT_EPSILON ? (
            <>
              <span className="font-heading text-[15px] font-bold tabular-nums">{money(amount)}</span> {theyPaid ? "from" : "to"} {first}
            </>
          ) : (
            <span className="text-warning">No amount yet</span>
          )}
        </ReviewRow>
        <ReviewRow label="Date" onEdit={() => goToStep(1)} editLabel="Edit date">
          {earlier && dateUnknown ? "Exact date not known" : formatStatementDate(fromInputDate(date), true)}
        </ReviewRow>
        <ReviewRow label="Account" onEdit={() => goToStep(1)} editLabel="Edit account">
          {earlier ? "Already in your balance — no account changes" : account.selected ? accountName : <span className="text-warning">Not chosen yet</span>}
        </ReviewRow>
        <ReviewRow label={general ? "Lowers balance" : "Applied to bills"} onEdit={() => goToStep(2)} editLabel="Edit how it is applied">
          <span className="font-semibold tabular-nums">{money(allocation.allocated)}</span>
          {general ? (
            <span className="text-foreground/70"> · not tied to any item</span>
          ) : paidLines.length > 0 ? (
            <ul className="mt-1 space-y-0.5 text-xs text-foreground/80">
              {paidLines.slice(0, 4).map((l) => (
                <li key={l.key} className="flex min-w-0 items-baseline justify-between gap-3">
                  <span className="min-w-0 truncate">{l.title}</span>
                  <span className="shrink-0 tabular-nums">
                    {money(l.amount)}
                    <span className={cn("ml-1.5 font-semibold", l.full ? "text-success" : "text-warning")}>{l.full ? "Full" : "Part"}</span>
                  </span>
                </li>
              ))}
              {paidLines.length > 4 && <li className="text-foreground/65">+ {paidLines.length - 4} more</li>}
            </ul>
          ) : null}
        </ReviewRow>
        {leftoverParts.length > 0 && (
          <ReviewRow label="Money left" onEdit={() => goToStep(3)} editLabel="Edit money left">
            {leftoverParts.join(" · ")}
          </ReviewRow>
        )}
        {(general ? generalDue > PAYMENT_EPSILON : options.length > 0) && (
          <ReviewRow label={theyPaid ? `${first} still owes` : `You still owe ${first}`}>
            <span className={cn("font-semibold tabular-nums", stillOwed > PAYMENT_EPSILON ? "text-warning" : "text-success")}>{money(stillOwed)}</span>
            {postponeTotal > PAYMENT_EPSILON && <span className="text-foreground/70"> · {money(postponeTotal)} moves to the {cycleName(afterDraft.target)} cycle</span>}
            {reminder && reminderOffered && <span className="text-foreground/70"> · reminder {formatStatementDate(reminder.remindOn)}</span>}
          </ReviewRow>
        )}
      </dl>
    </section>
  );

  const needs = [amount <= PAYMENT_EPSILON ? "Amount" : null, !earlier && !account.selected ? "Account" : null, amount > PAYMENT_EPSILON && blocker && account.selected ? (blocker.includes("enough balance") ? "Enough balance" : "Fix what's flagged") : null].filter(
    (c): c is string => c != null,
  );
  // Wide sheet: the outcome of what is entered, always in view — what is received, where it goes, what it settles, what is left.
  const dateText = earlier && dateUnknown ? "date not known" : formatStatementDate(fromInputDate(date), true);
  const receiptCard = (
    <aside aria-label="Receipt" data-testid="rp-receipt" className="overflow-hidden rounded-2xl border border-border-strong bg-card shadow-e2">
      <div className={cn("px-4 py-3.5", theyPaid ? "bg-primary/20" : "bg-settle-payable-tint")}>
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-bold tracking-[0.1em] text-foreground/65 uppercase">{theyPaid ? "You receive" : "You pay"}</span>
          <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-bold", ready ? "bg-success/15 text-[oklch(0.44_0.13_149)] dark:text-success" : "bg-warning/20 text-foreground/80")}>
            {ready ? "Ready" : "Not ready yet"}
          </span>
        </div>
        <p className={cn("mt-1 font-heading text-[34px] leading-none font-bold tracking-tight tabular-nums", amount > PAYMENT_EPSILON ? "text-foreground" : "text-foreground/35")}>{money(amount)}</p>
        <p className="mt-1.5 text-xs text-foreground/70">
          {theyPaid ? "from" : "to"} <span className="font-semibold text-foreground">{first}</span> · {dateText}
        </p>
      </div>
      {!ready && needs.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-border bg-warning/10 px-4 py-2 text-xs" data-testid="rp-receipt-needs">
          <span className="font-semibold text-foreground/80">Still needed</span>
          {needs.map((c) => (
            <span key={c} className="inline-flex h-6 items-center rounded-full border border-dashed border-border-strong bg-card px-2 text-[11.5px] font-semibold text-foreground/85">
              {c}
            </span>
          ))}
        </div>
      )}
      <dl className="divide-y divide-dashed divide-border-strong px-4 text-[13px]">
        <ReceiptRow label={earlier ? "Account" : theyPaid ? "Into account" : "From account"}>
          {earlier ? "Already in your balance" : account.selected ? accountName : <span className="font-semibold text-warning">Choose an account</span>}
        </ReceiptRow>
        <ReceiptRow label={general ? "Lowers balance" : "Settles"}>
          <span className="font-semibold tabular-nums">{money(allocation.allocated)}</span>
          {general ? (
            <span className="text-foreground/65"> · no item</span>
          ) : paidLines.length > 0 ? (
            <ul className="mt-1 space-y-0.5 text-xs text-foreground/80">
              {paidLines.slice(0, 4).map((l) => (
                <li key={l.key} className="flex min-w-0 items-baseline justify-between gap-3">
                  <span className="min-w-0 truncate">{l.title}</span>
                  <span className="shrink-0 tabular-nums">
                    {money(l.amount)}
                    <span className={cn("ml-1.5 font-semibold", l.full ? "text-success" : "text-warning")}>{l.full ? "Full" : "Part"}</span>
                  </span>
                </li>
              ))}
              {paidLines.length > 4 && <li className="text-foreground/65">+ {paidLines.length - 4} more</li>}
            </ul>
          ) : null}
        </ReceiptRow>
        {leftoverParts.length > 0 && <ReceiptRow label="Money left">{leftoverParts.join(" · ")}</ReceiptRow>}
        {!recon.balanced && Math.abs(recon.unallocated) > PAYMENT_EPSILON && (
          <ReceiptRow label="Not yet assigned">
            <span className={cn("font-semibold tabular-nums", recon.unallocated < 0 ? "text-expense" : "text-warning")}>{money(recon.unallocated)}</span>
          </ReceiptRow>
        )}
      </dl>
      {(general ? generalDue > PAYMENT_EPSILON : options.length > 0) && (
        <div className="border-t border-border bg-secondary/50 px-4 py-3">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-[13px] font-medium text-foreground/80">{theyPaid ? `${first} still owes` : `You still owe ${first}`}</span>
            <span className={cn("font-heading text-[19px] font-bold tabular-nums", stillOwed > PAYMENT_EPSILON ? "text-warning" : "text-success")}>{money(stillOwed)}</span>
          </div>
          <div aria-hidden className="mt-2 h-1.5 overflow-hidden rounded-full bg-border">
            <div className={cn("h-full rounded-full transition-[width,background-color] duration-300 ease-out motion-reduce:transition-none", coverage >= 1 ? "bg-success" : "bg-primary")} style={{ width: `${coverage * 100}%` }} />
          </div>
          {postponeTotal > PAYMENT_EPSILON && <p className="mt-2 text-xs text-foreground/70">{money(postponeTotal)} moves to the {cycleName(afterDraft.target)} cycle</p>}
          {reminder && reminderOffered && <p className="mt-1 text-xs text-foreground/70">Reminder {formatStatementDate(reminder.remindOn)}</p>}
        </div>
      )}
    </aside>
  );

  const body = (
      <div ref={bodyBox} className={cn("@container flex-1", sheet ? "space-y-2.5 px-3 pt-3 pb-4 sm:space-y-3 sm:px-5 sm:pt-4 sm:pb-5" : "space-y-3 px-4 pt-4 pb-5 sm:px-5")}>
        {intentSection}
        {!postponing &&
          (paged ? (
            <>
              {/* Pinned while a page scrolls: the money so far and where you are. */}
              <div ref={stickyRef} className="sticky top-0 z-20 -mx-3 space-y-2 border-b border-border/70 bg-card/90 px-3 py-2 backdrop-blur-md sm:-mx-5 sm:px-5">
              {summaryStrip}
              <StepNav
                idBase={formId}
                current={step}
                onSelect={goToStep}
                steps={[
                  { n: 1, label: "Money", summary: step1Summary, done: step1Done, warn: amountLooksHigh },
                  { n: 2, label: "Apply", summary: step2Summary, done: step2Done, warn: step2Warn },
                  { n: 3, label: "Finish", summary: step3Summary, done: step3Done, warn: step3Warn },
                ]}
              />
              </div>
              <div
                ref={pageRef}
                key={step}
                role="tabpanel"
                id={`${formId}-panel-${step}`}
                aria-labelledby={`${formId}-tab-${step}`}
                className={cn(
                  "space-y-3 duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] animate-in fade-in motion-reduce:animate-none",
                  stepDir === "back" ? "slide-in-from-left-6" : "slide-in-from-right-6",
                )}
              >
                {step === 1 ? (
                  moneyStep
                ) : step === 2 ? (
                  applyStep
                ) : (
                  <>
                    {finishStep}
                    {reviewCard}
                  </>
                )}
              </div>
            </>
          ) : sheet ? (
            // Wide sheet: no pages. Money (and what is left over) on the left; the summary and how it is applied on the right.
            <div className="grid items-start gap-4 @4xl:grid-cols-[minmax(0,1fr)_19.5rem]" data-testid="rp-workspace">
              <div className="@container flex min-w-0 flex-col gap-3">
                {moneyStep}
                {applyStep}
              </div>
              {/* The outcome stays in view beside the form; what is left over and the follow-ups sit right under it. */}
              <div className="@container flex min-w-0 flex-col gap-3 @4xl:sticky @4xl:top-0">
                {receiptCard}
                {finishStep}
              </div>
            </div>
          ) : (
            <>
              {summaryStrip}
              {moneyStep}
              {applyStep}
              {finishStep}
            </>
          ))}
      </div>
  );

  // ── Always-visible footer: where the money goes, what is still owed (separately), and the action ──
  const footer = (
      <aside
        aria-label="Payment summary"
        className={cn("bg-card px-3 py-2 sm:px-5 sm:py-2.5", sheet ? "pb-2 sm:pb-2.5" : "sticky bottom-0 z-10 mt-auto border-t border-border-strong pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-[0_-8px_24px_-12px_rgb(0_0_0/0.18)]")}
      >
        {postponing ? (
          // Wide sheet: what is recorded (nothing) on the left, Cancel + Postpone on the right — one row, like the other views.
          <div className={cn(sheet && wideSheet && "grid grid-cols-[minmax(0,1fr)_28rem] items-center gap-x-4")}>
            <div className={cn("flex items-center justify-between gap-3", sheet && wideSheet && "col-start-1 row-start-1 justify-start")}>
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
              <p className={cn("mt-2 flex items-center gap-1.5 text-xs font-semibold text-expense", sheet && wideSheet && "col-span-2 row-start-2")} role="alert">
                <CircleAlert className="size-3.5 shrink-0" aria-hidden />
                {postponeDraft.error}
              </p>
            )}
            {postponable.length > 1 && postponeDraft.failures.length > 0 && (
              <ul className={cn("mt-1 space-y-0.5 pl-5 text-xs text-foreground/80", sheet && wideSheet && "col-span-2 row-start-3")} aria-label="Not postponed">
                {postponeDraft.failures.map((f) => (
                  <li key={f.key}>
                    <span className="font-semibold text-foreground">{f.title}</span> — {f.message}
                  </li>
                ))}
              </ul>
            )}
            <div className={cn("flex items-center gap-2", sheet && wideSheet ? "col-start-2 row-start-1" : sheet ? "mt-2 sm:mt-2.5" : "mt-3")}>
              <button type="button" onClick={onCancel} disabled={postponeDraft.busy} className={cn(sheet ? SHEET_BUTTON.ghost : WS_GHOST, "shrink-0")}>
                Cancel
              </button>
              <button
                type="submit" form={formId}
                disabled={!postponeDraft.ready}
                aria-busy={postponeDraft.busy}
                className={cn(sheet ? SHEET_BUTTON.primary : cn(WS_PRIMARY, "h-10"), "min-w-0 flex-1 truncate whitespace-nowrap transition-[opacity,transform] duration-150 active:scale-[0.985]")}
              >
                {postponeDraft.busy && <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />}
                <span className="truncate">
                  {postponeDraft.busy
                    ? "Postponing…"
                    : postponeDraft.retrying
                      ? `Retry ${money(postponeDraft.pendingRemaining)}`
                      : `Postpone ${money(postponeDraft.pendingRemaining)}${sheet ? ` → ${cycleName(postponeDraft.target)}` : ""}`}
                </span>
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* The receipt, every rupee in one bucket — received = applied + income + set aside + advance + unassigned. */}
            <div className={cn("flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1", sheet && wideSheet && "sr-only")}>
              <dl className={cn("flex items-baseline gap-x-3.5 gap-y-1 text-xs", sheet ? "min-w-0 flex-nowrap overflow-x-auto whitespace-nowrap [scrollbar-width:none] sm:flex-wrap" : "flex-wrap")} aria-label="Where the money goes">
                <Figure label={theyPaid ? "Received" : "Paid"} value={money(recon.received)} testId="rp-hero-amount" strong />
                <Figure label={general ? "Lowers balance" : "Applied to bills"} value={money(recon.allocated)} testId="rp-applied" dot="bg-settle-split-edge" />
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
              {(general ? generalDue > PAYMENT_EPSILON : options.length > 0) && (
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
            {!(sheet && wideSheet) && (error || (blocker && amount > 0)) && (
              <p
                className={cn("mt-2 flex items-center gap-1.5 text-xs font-semibold duration-200 animate-in fade-in slide-in-from-bottom-1", error ? "text-expense" : "text-warning", !error && !earlier && !account.selected && "sr-only")}
                role={error ? "alert" : undefined}
                data-testid="rp-blocker"
              >
                <CircleAlert className="size-3.5 shrink-0" aria-hidden />
                {error ?? blocker}
              </p>
            )}
            {/* Still needed (what is missing, or "Ready") beside the actions — one row on a wide popup. */}
            <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
            {sheet && wideSheet && (
              <div className="min-w-0 flex-1 text-[12.5px]">
                {error || (blocker && amount > 0) ? (
                  <p className={cn("flex items-center gap-1.5 font-semibold", error ? "text-expense" : "text-warning", !error && !earlier && !account.selected && "sr-only")} role={error ? "alert" : undefined} data-testid="rp-blocker">
                    <CircleAlert className="size-3.5 shrink-0" aria-hidden />
                    {error ?? blocker}
                  </p>
                ) : ready ? (
                  <p aria-hidden className="flex items-center gap-2 font-semibold text-[oklch(0.44_0.13_149)] dark:text-success">
                    <span className="grid size-5 shrink-0 place-items-center rounded-full bg-success text-success-foreground">
                      <Check className="size-3" strokeWidth={3} />
                    </span>
                    Ready to record
                  </p>
                ) : null}
              </div>
            )}
            <div className={cn("flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto text-[12.5px] [scrollbar-width:none]", sheet && wideSheet && "sr-only")} aria-live="polite" data-testid="rp-still-needed">
              {ready ? (
                <p className="flex min-w-0 items-center gap-2 font-semibold text-[oklch(0.44_0.13_149)] dark:text-success">
                  <span className="grid size-5 shrink-0 place-items-center rounded-full bg-success text-success-foreground">
                    <Check className="size-3" strokeWidth={3} aria-hidden />
                  </span>
                  <span className="truncate">Ready to record</span>
                </p>
              ) : (
                <>
                  <span className="shrink-0 font-medium text-foreground/72">Still needed:</span>
                  {needs.map((c) => (
                      <span key={c} className="inline-flex h-6 shrink-0 items-center rounded-full border border-dashed border-border-strong bg-card px-2 text-[11.5px] font-semibold text-foreground/80">
                        {c}
                      </span>
                    ))}
                </>
              )}
            </div>
            <div className={cn("flex min-w-0 items-center gap-2", sheet && wideSheet ? "sm:ml-auto sm:w-[28rem]" : "sm:max-w-[65%] sm:shrink-0")}>
              {paged && step > 1 ? (
                <button type="button" onClick={() => goToStep((step - 1) as PaymentStep)} disabled={saving} className={cn(SHEET_BUTTON.ghost, "shrink-0")}>
                  <ChevronLeft className="size-4" aria-hidden />
                  Back
                </button>
              ) : (
                <button type="button" onClick={onCancel} disabled={saving} className={cn(SHEET_BUTTON.ghost, "shrink-0")}>
                  Cancel
                </button>
              )}
              {paged && step < 3 ? (
                <button
                  type="button"
                  onClick={() => goToStep((step + 1) as PaymentStep)}
                  className={cn(
                    step === 1 ? (step1Done ? SHEET_BUTTON.primary : SHEET_BUTTON.secondary) : step2Done ? SHEET_BUTTON.primary : SHEET_BUTTON.secondary,
                    "min-w-0 flex-1 truncate whitespace-nowrap transition-[opacity,transform,background-color] duration-150 active:scale-[0.985] sm:px-5",
                  )}
                  data-testid="rp-step-next"
                >
                  <span className="truncate">Next · {step === 1 ? "Apply" : "Finish"}</span>
                  <ChevronRight className="size-4 shrink-0" aria-hidden />
                </button>
              ) : (
              <button
                type="submit" form={formId}
                disabled={!ready || saving}
                className={cn(ready || saving ? SHEET_BUTTON.primary : SHEET_BUTTON.primaryIdle, "min-w-0 flex-1 truncate whitespace-nowrap transition-[opacity,transform,background-color] duration-150 active:scale-[0.985] sm:px-5")}
              >
                {saving && <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />}
                <span className="truncate">
                  {saving
                    ? "Saving…"
                    : initial
                      ? "Save changes"
                      : sheet && wideSheet && amount <= PAYMENT_EPSILON
                        ? "Enter an amount to record"
                        : `Record ${money(amount)} ${earlier ? "received earlier" : theyPaid ? "received" : "paid"}${postponeTotal > PAYMENT_EPSILON ? ` · postpone ${money(postponeTotal)}` : ""}`}
                </span>
              </button>
              )}
            </div>
            </div>
          </>
        )}
      </aside>
  );

  if (sheet) {
    return (
      <TransactionSheet
        open
        compact
        onRequestClose={onCancel}
        closeDisabled={saving}
        testId="payment-sheet"
        className="max-sm:max-h-[84dvh]"
        header={
          <SheetHero
            title={heroTitle}
            personName={personName}
            tone={heroTone}
            status={heroStatus}
            // Wide: the hero states what is owed (a fixed fact); the live figures are in the receipt beside the form.
            amount={wideSheet && !postponing && showSummary ? money(summaryTotal) : heroAmount}
            amountLabel={wideSheet && !postponing && showSummary ? (theyPaid ? `${first} owes you` : `You owe ${first}`) : undefined}
            context={heroContext}
          />
        }
        footer={footer}
      >
        <form id={formId} {...formProps} className="flex flex-col">
          {body}
        </form>
      </TransactionSheet>
    );
  }
  return (
    <form id={formId} {...formProps} className="mt-4 flex min-h-full flex-col bg-secondary/55">
      <PanelHeader title={heroTitle} personName={personName} tone={heroTone} onClose={onCancel} amount={heroAmount} status={heroStatus} context={heroContext} />
      {body}
      {footer}
    </form>
  );
}

/** The sheet's hero: the person and what is being recorded on the left; the live amount and, on a wide sheet, the three figures (total · now · remaining) on the right. */
function SheetHero({
  title,
  personName,
  tone,
  status,
  amount,
  amountLabel,
  context,
}: {
  title: string;
  personName: string;
  tone: "in" | "out" | "wait";
  status?: string;
  amount?: string;
  amountLabel?: string;
  context?: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-2">
      <div className="flex min-w-0 flex-1 basis-64 items-center gap-3">
        <SheetAvatar compact tone={tone === "in" ? "credit" : tone === "out" ? "debit" : "neutral"}>
          {personName.slice(0, 1).toUpperCase()}
        </SheetAvatar>
        <div className="min-w-0 flex-1">
          <p className="hidden text-[10.5px] font-bold tracking-[0.1em] text-hero-foreground/65 uppercase sm:block">People · {personName}</p>
          <DialogTitle className="flex min-w-0 items-center gap-2 text-base leading-tight font-semibold tracking-tight text-hero-foreground">
            <span className="truncate">
              {title}
              <span className="sr-only"> · {personName}</span>
            </span>
            {status && <span className="shrink-0 rounded-full bg-white/10 px-2 py-0.5 text-[11px] font-semibold text-hero-foreground ring-1 ring-white/12">{status}</span>}
          </DialogTitle>
          <DialogDescription className="sr-only">{title}</DialogDescription>
          {context && (
            <p className="mt-0.5 flex min-w-0 items-center gap-1 truncate text-[11px] font-medium text-hero-foreground/70">
              <span className="shrink-0 font-semibold text-hero-foreground/85 sm:hidden">{personName} ·</span>
              {context}
            </p>
          )}
        </div>
      </div>
      {amount && (
        <div className="flex min-w-0 flex-col items-start gap-1 sm:items-end">
          {amount && (
            <div className="flex flex-col sm:items-end">
              {amountLabel && <span className="text-[10.5px] font-bold tracking-[0.1em] whitespace-nowrap text-hero-foreground/65 uppercase">{amountLabel}</span>}
              <span className={cn("font-heading text-[26px] leading-none font-bold tracking-tight tabular-nums sm:text-[32px]", tone === "in" ? SHEET_AMOUNT_TONE.credit : tone === "out" ? SHEET_AMOUNT_TONE.debit : SHEET_AMOUNT_TONE.unknown)}>
                {amount}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** One line of the receipt: a quiet label, the value right-aligned. */
function ReceiptRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[6.75rem_minmax(0,1fr)] items-baseline gap-x-3 py-2.5">
      <dt className="text-xs font-medium text-foreground/70">{label}</dt>
      <dd className="min-w-0 text-right font-medium text-foreground [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

/** A step's card — the same surface as the Transaction Details sections. */
const RP_CARD = "rounded-2xl border border-border bg-card p-3.5 shadow-e1";

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
        // Sized by the popup, not the window: stacked when narrow, title over the controls, then one line when wide.
        "grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2 px-3 py-2.5 transition-[background-color,box-shadow] duration-200 @lg:grid-cols-[auto_minmax(0,1fr)_8.5rem] @[36rem]:grid-cols-[minmax(0,1fr)_auto_7rem_7.25rem]",
        active ? "bg-settle-split-tint/20 shadow-[inset_3px_0_0_var(--color-settle-split-edge)]" : "hover:bg-secondary/30",
      )}
    >
      <div className="col-span-2 min-w-0 @lg:col-span-3 @[36rem]:col-span-1">
        <p className={cn("flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm font-semibold", choice === "skip" ? "text-foreground/70" : "text-foreground")}>
          <span className="max-w-full truncate">{o.title}</span>
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
              "h-7 rounded-[6px] px-2 text-xs font-semibold outline-none transition-[background-color,color,box-shadow] duration-150 focus-visible:ring-2 focus-visible:ring-ring",
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

      <div className="col-span-2 min-w-0 text-right @lg:col-span-1">
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

/**
 * A step's number: a check once its figures are complete, an amber "!" when it shows a note to look at, filled while
 * it is the open page (decorative — the heading's name is the title).
 */
function StepBadge({ n, done, warn, active, large }: { n: number; done?: boolean; warn?: boolean; active?: boolean; large?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid shrink-0 place-items-center rounded-full font-bold tabular-nums transition-[background-color,color,box-shadow] duration-200",
        large ? "size-7 text-xs" : "size-5 text-[10.5px]",
        warn
          ? "bg-warning text-warning-foreground"
          : done
            ? "bg-success text-success-foreground"
            : active
              ? "bg-primary text-primary-foreground"
              : "bg-secondary text-foreground/75 ring-1 ring-border-strong ring-inset",
      )}
    >
      {warn ? "!" : done ? <Check key="done" className={cn(large ? "size-3.5" : "size-3", "duration-200 animate-in zoom-in-50")} strokeWidth={3} /> : n}
    </span>
  );
}

/**
 * The sheet's step bar: three pages, each with its badge, name and a live one-line summary. Any page can be opened
 * at any time — the pages only split the form, they never gate it (saving is gated by the same checks as before).
 */
function StepNav({
  steps,
  current,
  onSelect,
  idBase,
}: {
  steps: { n: PaymentStep; label: string; summary: string; done: boolean; warn: boolean }[];
  current: PaymentStep;
  onSelect: (n: PaymentStep) => void;
  idBase: string;
}) {
  const index = steps.findIndex((s) => s.n === current);
  return (
    <div
      role="tablist"
      aria-label="Payment steps"
      className="relative grid grid-cols-3 rounded-[14px] bg-secondary p-1 ring-1 ring-black/[0.05] ring-inset dark:ring-white/[0.06]"
      data-testid="rp-steps"
      // Arrow keys move between the pages, like the intent switch above.
      onKeyDown={(e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        const next = (index + (e.key === "ArrowRight" ? 1 : steps.length - 1)) % steps.length;
        onSelect(steps[next].n);
        e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
      }}
    >
      {/* The sliding selection — one card that moves under the open page. */}
      <span
        aria-hidden
        className="absolute inset-y-1 left-1 rounded-[11px] bg-card shadow-[0_1px_2px_rgb(0_0_0/0.06),0_6px_16px_-8px_rgb(0_0_0/0.22)] ring-1 ring-primary-accent-text/30 transition-transform duration-300 ease-[var(--ease-spring)] motion-reduce:transition-none"
        style={{ width: `calc((100% - 8px) / ${steps.length})`, transform: `translateX(${Math.max(0, index) * 100}%)` }}
      />
      {steps.map((s, i) => {
        const active = s.n === current;
        return (
          <button
            key={s.n}
            type="button"
            role="tab"
            id={`${idBase}-tab-${s.n}`}
            aria-selected={active}
            aria-controls={active ? `${idBase}-panel-${s.n}` : undefined}
            tabIndex={active ? 0 : -1}
            onClick={() => onSelect(s.n)}
            data-testid={`rp-step-${s.n}`}
            className={cn(
              "relative z-10 flex min-w-0 items-center gap-2 rounded-[11px] px-2 py-1.5 text-left outline-none transition-[background-color,transform] duration-150 focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.98] @md:gap-2.5 @md:px-2.5 @md:py-2",
              !active && "hover:bg-card/50",
            )}
          >
            <StepBadge n={s.n} done={s.done && !active} warn={s.warn} active={active} large />
            <span className="min-w-0 flex-1">
              <span className={cn("block truncate text-[13px] leading-tight transition-colors", active ? "font-bold text-foreground" : "font-semibold text-foreground/75")}>
                <span className="sr-only">Step {s.n}: </span>
                {s.label}
              </span>
              <span className={cn("hidden truncate text-[11px] leading-tight tabular-nums @md:block", active ? "text-foreground/70" : "text-foreground/55")}>{s.summary}</span>
            </span>
            {i < steps.length - 1 && <ChevronRight aria-hidden className="hidden size-3.5 shrink-0 text-foreground/30 @lg:block" />}
          </button>
        );
      })}
    </div>
  );
}

const INTENT_TONE = {
  in: { icon: ArrowDownLeft, solid: "bg-settle-receivable-text text-white", text: "text-settle-receivable-text", ring: "ring-settle-receivable-text/40", tint: "bg-settle-receivable-tint" },
  out: { icon: ArrowUpRight, solid: "bg-settle-payable-text text-white", text: "text-settle-payable-text", ring: "ring-settle-payable-text/40", tint: "bg-settle-payable-tint" },
  wait: { icon: CalendarClock, solid: "bg-foreground text-card", text: "text-foreground", ring: "ring-foreground/30", tint: "bg-secondary" },
} as const;

/**
 * The sheet's "what happened" toolbar: three plain-language choices ("Dad paid me" / "I paid Dad" / "Move to later")
 * on a track with one card that slides under the chosen one. Icon over text on a narrow sheet, one row when wide.
 * Same radios, names and keyboard behaviour as the shared switch — presentation only.
 */
function IntentPicker({
  value,
  onChange,
  options,
  label,
  locked,
}: {
  value: IntentChoice;
  onChange: (v: IntentChoice) => void;
  options: { value: IntentChoice; tone: keyof typeof INTENT_TONE; title: string; sub: string; label: string; meta: string }[];
  label: string;
  locked: boolean;
}) {
  const index = Math.max(0, options.findIndex((o) => o.value === value));
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  return (
    <div
      role="radiogroup"
      aria-label={label}
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
      className="relative grid rounded-[18px] border border-border-strong bg-card p-1 shadow-e1"
      data-testid="rp-intent"
    >
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-1 left-1 rounded-[14px] shadow-[0_1px_2px_rgb(0_0_0/0.06),0_8px_18px_-10px_rgb(0_0_0/0.3)] ring-1 transition-[transform,box-shadow,background-color] duration-300 ease-[var(--ease-spring)] motion-reduce:transition-none",
          INTENT_TONE[options[index]?.tone ?? "in"].ring,
          INTENT_TONE[options[index]?.tone ?? "in"].tint,
        )}
        style={{ width: `calc((100% - 8px) / ${options.length})`, transform: `translateX(${index * 100}%)` }}
      />
      {options.map((o, i) => {
        const active = o.value === value;
        const disabled = locked && !active;
        const tone = INTENT_TONE[o.tone];
        const Icon = tone.icon;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={o.label}
            aria-disabled={disabled || undefined}
            tabIndex={active ? 0 : -1}
            title={disabled ? "This can't change while editing" : undefined}
            onClick={() => !disabled && onChange(o.value)}
            onKeyDown={(e) => {
              if (locked || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
              e.preventDefault();
              const next = (i + (e.key === "ArrowLeft" || e.key === "ArrowUp" ? options.length - 1 : 1)) % options.length;
              onChange(options[next].value);
              refs.current[next]?.focus();
            }}
            className={cn(
              "relative z-10 flex min-w-0 flex-col items-center gap-1 rounded-[12px] px-1.5 py-2 text-center outline-none transition-[opacity,transform] duration-150 focus-visible:ring-2 focus-visible:ring-ring @lg:flex-row @lg:items-center @lg:gap-2.5 @lg:px-2.5 @lg:text-left",
              disabled ? "cursor-not-allowed opacity-45" : "active:scale-[0.97]",
            )}
          >
            <span
              aria-hidden
              className={cn(
                "grid size-8 shrink-0 place-items-center rounded-full transition-[background-color,color,box-shadow] duration-300",
                active ? cn(tone.solid, "shadow-[0_3px_8px_-3px_rgb(0_0_0/0.35)]") : "bg-card text-foreground/70 shadow-[0_1px_2px_rgb(0_0_0/0.08)]",
              )}
            >
              <Icon className="size-4" strokeWidth={2.5} />
            </span>
            <span className="min-w-0 @lg:flex-1">
              <span className={cn("block truncate text-[13px] leading-tight transition-colors", active ? "font-bold text-foreground" : "font-semibold text-foreground/80")}>{o.title}</span>
              <span className={cn("block truncate text-[11px] leading-tight @lg:hidden", active ? "font-semibold text-foreground/75" : "text-foreground/70")}>{o.sub}</span>
              <span className={cn("hidden truncate text-[11px] leading-tight tabular-nums @lg:block", active ? cn("font-semibold", tone.text) : "text-foreground/65")}>{o.meta}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** One line of the review: what, the value, and a quiet jump back to the page that sets it. */
function ReviewRow({ label, children, onEdit, editLabel }: { label: string; children: React.ReactNode; onEdit?: () => void; editLabel?: string }) {
  return (
    <div className="grid grid-cols-[minmax(0,7.5rem)_minmax(0,1fr)_auto] items-baseline gap-x-3 py-1.5 @md:grid-cols-[9rem_minmax(0,1fr)_auto]">
      <dt className="truncate text-xs font-medium text-foreground/65">{label}</dt>
      <dd className="min-w-0 text-foreground">{children}</dd>
      {onEdit ? (
        <button
          type="button"
          onClick={onEdit}
          aria-label={editLabel}
          className="rounded-[6px] px-1.5 text-xs font-semibold text-primary-accent-text outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          Edit
        </button>
      ) : (
        <span />
      )}
    </div>
  );
}

/** A step's heading: its badge, the title, and a quiet hint. */
function StepHeading({ id, n, title, hint, right, done }: { id: string; n: number; title: string; hint?: string; right?: React.ReactNode; done?: boolean }) {
  return (
    <div className="-mx-3.5 -mt-3.5 mb-3 flex flex-wrap items-start justify-between gap-x-3 gap-y-1 rounded-t-[15px] border-b border-border bg-secondary/60 px-3.5 py-2">
      <div className="min-w-0">
        <h4 id={id} className="flex items-center gap-2 text-sm font-bold text-foreground">
          <StepBadge n={n} done={done} />
          {title}
        </h4>
        {hint && <p className="mt-0.5 pl-7 text-xs text-foreground/70">{hint}</p>}
      </div>
      {right}
    </div>
  );
}

/** General payment (the default) vs. naming the items it pays — two plain radio options. */
function ApplyModeSwitch({ mode, onChange, locked, itemCount }: { mode: ApplyMode; onChange: (m: ApplyMode) => void; locked: boolean; itemCount: number }) {
  const option = (value: ApplyMode, title: string, sub: string) => {
    const active = mode === value;
    return (
      <button
        type="button"
        role="radio"
        aria-checked={active}
        disabled={locked && !active}
        onClick={() => onChange(value)}
        data-testid={`rp-mode-${value}`}
        className={cn(
          "flex min-w-0 items-start gap-2 rounded-[8px] px-3 py-1.5 text-left transition-[background-color,box-shadow,color] duration-200 outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
          active ? "bg-card shadow-sm ring-1 ring-border-strong" : "hover:bg-card/60",
        )}
      >
        <span aria-hidden className={cn("mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border-[1.5px] transition-colors duration-200", active ? "border-primary-accent-text" : "border-border-strong")}>
          {active && <span className="size-2 rounded-full bg-primary-accent-text duration-200 animate-in zoom-in-50" />}
        </span>
        <span className="min-w-0">
          <span className={cn("block text-[13px] text-foreground", active ? "font-bold" : "font-semibold text-foreground/85")}>{title}</span>
          <span className="sr-only @md:not-sr-only @md:block @md:text-[11px] @md:text-foreground/65">{sub}</span>
        </span>
      </button>
    );
  };
  return (
    <div role="radiogroup" aria-label="How to apply this payment" className={cn("mb-2.5 grid gap-1 rounded-[10px] bg-secondary/70 p-1 ring-1 ring-border ring-inset", itemCount > 0 && "@md:grid-cols-2")}>
      {option("general", "Reduce the overall balance", "Not tied to any item")}
      {itemCount > 0 && option("items", "Choose specific items", "Say which items this pays")}
    </div>
  );
}

function GeneralFigure({ label, value, testId, tone }: { label: string; value: string; testId: string; tone?: string }) {
  return (
    <div className="min-w-0 px-3 py-2">
      <dt className="truncate text-[11px] font-semibold text-foreground/70">{label}</dt>
      <dd className={cn("font-heading text-[15px] font-bold tabular-nums", tone ?? "text-foreground")} data-testid={testId}>
        {value}
      </dd>
    </div>
  );
}

function Notice({ tone, role, children }: { tone: "warning"; role?: "alert" | "status"; children: React.ReactNode }) {
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
  sheet = false,
  formId,
}: {
  sheet?: boolean;
  formId?: string;
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
  const formProps = {
    noValidate: true,
    onSubmit: (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      if (!busy && draft.ready) onRetry();
    },
    "aria-label": `Payment recorded — ${personName}`,
  };
  const body = (
      <div className="flex-1 space-y-4 px-4 pt-4 pb-6 sm:px-5">
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
  );
  const footer = (
      <div className={cn("flex items-center gap-2 bg-card px-4 py-3 sm:px-5", !sheet && "sticky bottom-0 z-10 mt-auto border-t border-border-strong pb-[max(0.75rem,env(safe-area-inset-bottom))]")}>
        <button type="button" onClick={onDone} disabled={busy} className={cn(SHEET_BUTTON.ghost, "shrink-0")}>
          Close
        </button>
        <button type="submit" form={formId} disabled={busy || !draft.ready} aria-busy={busy} className={cn(SHEET_BUTTON.primary, "min-w-0 flex-1 truncate whitespace-nowrap")}>
          {busy && <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />}
          <span className="truncate">{busy ? "Postponing…" : `Retry postponing ${money(draft.pendingRemaining)}`}</span>
        </button>
      </div>
  );
  if (sheet) {
    return (
      <TransactionSheet open compact onRequestClose={onDone} closeDisabled={busy} testId="payment-sheet" header={<SheetHero title="Payment recorded" personName={personName} tone={theyPaid ? "in" : "out"} />} footer={footer}>
        <form id={formId} {...formProps} className="flex flex-col">
          {body}
        </form>
      </TransactionSheet>
    );
  }
  return (
    <form id={formId} {...formProps} className="mt-4 flex min-h-full flex-col bg-secondary/55">
      <PanelHeader title="Payment recorded" personName={personName} tone={theyPaid ? "in" : "out"} onClose={onDone} />
      {body}
      {footer}
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
    // Tied to no obligation: a general payment's line.
    else if (e.obligationRef == null && e.parentEntryId == null) lines[GENERAL_PAYMENT_KEY] = round2((lines[GENERAL_PAYMENT_KEY] ?? 0) + e.amount);
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
