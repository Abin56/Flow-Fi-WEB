"use client";

import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  CalendarClock,
  Check,
  ChevronDown,
  CircleDashed,
  Clock,
  ExternalLink,
  CornerDownRight,
  HandCoins,
  History,
  Info,
  Landmark,
  Pencil,
  PiggyBank,
  Scale,
  Split,
  Trash2,
  Undo2,
  UserCheck,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { Fragment, useEffect, useRef, useState } from "react";
import { SplitAllocationBreakdown } from "@/components/finance/split-allocation-breakdown";
import { Skeleton } from "@/components/ui/skeleton";
import type { LedgerRowHandlers } from "@/features/people/components/person-activity-feed";
import { EntryEditForm, EntrySettleForm, InlineReveal, isEditable, LoanPayLink, DELETE_BLOCK_NOTE } from "@/features/people/components/workspace/ledger-ui";
import { groupByMonth, sequence, type LedgerRow, type PaymentRecord } from "@/features/people/lib/person-ledger-rows";
import { transactionHref } from "@/features/people/lib/people-return-link";
import {
  linkedExpense,
  paidSoFar,
  relationLine,
  settlementKind,
  settlementStatus,
  settlementTitle,
  settlementTone,
  splitContext,
  splitContextLine,
  type SettlementKind,
  type SettlementLookups,
  type SettlementStatusTone,
  type SettlementTone,
} from "@/features/people/lib/settlement-presentation";
import { formatStatementDate, type EmiRowStatus } from "@/lib/engines/person-cycle-statement";
import { money } from "@/lib/engines/person-cycle-statement-share";
import { splitAllocation } from "@/lib/split/split-allocation";
import { cn } from "@/lib/utils";
import { useAllEmiInstallments } from "@/hooks/use-emis";
import { useAllLoanInstallments } from "@/hooks/use-loans";
import { FollowUpControl, FollowUpNote } from "./follow-up";
import { DeferralControl, DeferralNote, useRowDeferral } from "./payment-deferral";

/**
 * The People settlement reconciliation table — one component for the Person workspace's Activity and the
 * expanded ledger. Desktop: a ruled table (# · Date · What · Type · Original · Paid · Remaining · Status ·
 * Action). Tablet: Paid and # fold into the row. Phone: compact financial rows, never a squeezed table.
 * Every figure is a `LedgerRow` engine value; wording and colour come from `settlement-presentation`.
 */

// ---------------------------------------------------------------------------------------------------
// Semantic styling (literal class strings so Tailwind sees them)
// ---------------------------------------------------------------------------------------------------

export type Family = "receivable" | "received" | "payable" | "emi" | "loan" | "split" | "assigned" | "advance" | "carried";

export const TONE_FAMILY: Record<SettlementTone, Family> = {
  receivable: "receivable",
  payable: "payable",
  emi: "emi",
  loan: "loan",
  split: "split",
  assigned: "assigned",
  received: "received",
  paid: "carried",
  advance: "advance",
  neutral: "carried",
};

export const FAMILY: Record<Family, { tint: string; edge: string; text: string }> = {
  receivable: { tint: "bg-settle-receivable-tint", edge: "border-l-settle-receivable-edge", text: "text-settle-receivable-text" },
  // Money that actually came in — the only green family. "receivable" (still owed to you) is blue-gray.
  // Rows sit on the neutral surface (see `rowTint`); a thin muted edge is the only row-level hint.
  received: { tint: "bg-card", edge: "border-l-success/55", text: "text-success" },
  payable: { tint: "bg-settle-payable-tint", edge: "border-l-settle-payable-edge", text: "text-settle-payable-text" },
  emi: { tint: "bg-settle-emi-tint", edge: "border-l-settle-emi-edge", text: "text-settle-emi-text" },
  loan: { tint: "bg-settle-loan-tint", edge: "border-l-settle-loan-edge", text: "text-settle-loan-text" },
  split: { tint: "bg-settle-split-tint", edge: "border-l-settle-split-edge", text: "text-settle-split-text" },
  assigned: { tint: "bg-settle-assigned-tint", edge: "border-l-settle-assigned-edge", text: "text-settle-assigned-text" },
  advance: { tint: "bg-settle-advance-tint", edge: "border-l-settle-advance-edge", text: "text-settle-advance-text" },
  carried: { tint: "bg-settle-carried-tint", edge: "border-l-settle-carried-edge", text: "text-settle-carried-text" },
};

/**
 * Status colour = how far along the money is, never its direction: green only once it is paid / received,
 * amber while it is pending (either way), red when overdue, neutral for later or informational states.
 * Table-only — the statement / PDF keep their own chips. "advance" is the table's held-advance treatment.
 */
type StatusStyle = SettlementStatusTone | "advance" | "postponed";

const STATUS_STYLE: Record<StatusStyle, string> = {
  due: "bg-settle-emi-badge text-settle-emi-text",
  payable: "bg-settle-emi-badge text-settle-emi-text",
  partial: "bg-card text-settle-emi-text ring-1 ring-inset ring-settle-emi-edge",
  // Done: no fill — high-contrast text, a small green check is the only success mark.
  settled: "text-foreground/85 [&>svg]:text-success",
  overdue: "bg-expense text-expense-foreground",
  upcoming: "bg-settle-carried-badge text-settle-carried-text",
  received: "text-foreground/85 [&>svg]:text-success",
  // Money you sent: same restrained form, neutral check — distinct from money received.
  paid: "text-foreground/75 [&>svg]:text-foreground/55",
  neutral: "bg-settle-carried-badge text-settle-carried-text",
  // Held advance: informational teal outline, never the success green.
  advance: "bg-settle-advance-tint text-settle-advance-text ring-1 ring-inset ring-settle-advance-edge/50",
  // Still owed, only expected later: dashed outline — never the filled green of "paid".
  postponed: "border border-dashed border-primary-accent-text/70 bg-card text-primary-accent-text",
};

const STATUS_ICON: Partial<Record<StatusStyle, LucideIcon>> = {
  due: Clock,
  payable: Clock,
  partial: CircleDashed,
  settled: Check,
  overdue: AlertTriangle,
  received: Check,
  paid: Check,
  upcoming: CalendarClock,
  advance: PiggyBank,
  postponed: CalendarClock,
};

/**
 * The table's short status, with the money in it ("₹375 to receive", "Got ₹200 · ₹175 left"). Built on
 * `settlementStatus` (whose wording the statement / PDF keep); its sentence is kept as the hover `detail`.
 */
export function tableStatus(row: LedgerRow, kind: SettlementKind, personName: string): SettlementRowView["status"] {
  const base = settlementStatus(row, kind, personName, money);
  if (row.state == null || base.tone === "upcoming") return base;
  const mine = row.direction === "iOwe";
  const left = money(row.remaining ?? 0);
  if (row.state === "settled") return { ...base, label: `${mine ? "Paid" : "Received"} ${money(row.amount)}` };
  if (row.overdue) return { ...base, label: `Overdue · ${left} left` };
  if (row.state === "partial") return { ...base, label: `${mine ? "Paid" : "Got"} ${money(paidSoFar(row) ?? 0)} · ${left} left` };
  // Owed TO you reads as money coming in ("₹375 to receive"), never as something you still have to pay.
  return { ...base, label: mine ? `You need to pay ${left}` : `${left} to receive` };
}

/**
 * A receipt recorded as "already included in my account" (`LedgerEntry.recordedEarlier`): money that came in
 * before FlowFi tracked it — it settles the share without having moved the account here.
 */
export function receivedEarlierStatus(row: Pick<LedgerRow, "entryId">, kind: SettlementKind, lookups: SettlementLookups): SettlementRowView["status"] | null {
  if (kind !== "paymentReceived" || !row.entryId || lookups.entriesById.get(row.entryId)?.recordedEarlier !== true) return null;
  return { label: "Received earlier", detail: "Already in your account balance — no account change here", tone: "received" };
}

/**
 * The table's plain-language type names. The statement, PDF and WhatsApp text keep `KIND_LABEL` — only the
 * on-screen ledger is renamed. Identifiers and calculations are unchanged.
 */
const TABLE_KIND_LABEL: Record<SettlementKind, string> = {
  emi: "EMI share",
  loanEmi: "Loan EMI share",
  loanInstallment: "Loan installment",
  loan: "Loan",
  moneyGiven: "Money given",
  moneyReceived: "Money borrowed",
  assigned: "You paid for them",
  split: "Shared expense",
  paymentReceived: "Payment received",
  paymentMade: "Payment sent",
  opening: "Previous balance",
  adjustment: "Adjustment",
  advance: "Advance held",
  advanceApplied: "Advance used",
};

const THEY_PAID = "They paid for you";

/** The Type label for one row — direction / source decide who covered an expense. */
export function tableTypeLabel(kind: SettlementKind, row: Pick<LedgerRow, "direction" | "entryId">, lookups: SettlementLookups): string {
  if (kind === "assigned") return row.direction === "iOwe" ? THEY_PAID : TABLE_KIND_LABEL.assigned;
  // A "borrowed" entry backing an expense the person paid for me — not a loan of cash.
  if (kind === "moneyReceived" && row.entryId && lookups.entriesById.get(row.entryId)?.sourceKind === "personFundedExpense") return THEY_PAID;
  return TABLE_KIND_LABEL[kind];
}

/** One plain sentence: what this row is, and what is still owed on it. Null where the breakdown already says it. */
export function rowExplanation(v: Pick<SettlementRowView, "row" | "kind" | "typeLabel">, personName: string): string | null {
  const { row, kind } = v;
  const first = personName.split(" ")[0];
  const theirs = row.direction !== "iOwe";
  const amount = money(row.amount);
  const what = (() => {
    switch (kind) {
      case "moneyGiven":
        return `You gave ${amount} to ${first}.`;
      case "moneyReceived":
        return v.typeLabel === THEY_PAID ? `${first} paid this expense for you.` : `${first} gave you ${amount}.`;
      case "assigned":
        return theirs ? `You paid this expense for ${first}.` : `${first} paid this expense for you.`;
      case "split":
        return theirs ? `${first}'s share of an expense you paid.` : `Your share of an expense ${first} paid.`;
      case "emi":
      case "loanEmi":
        return theirs ? `${first}'s share of this installment.` : "Your share of this installment.";
      case "loanInstallment":
        return `An installment of the loan with ${first}.`;
      case "opening":
        return theirs ? `What ${first} owed before tracking started here.` : `What you owed ${first} before tracking started here.`;
      default:
        return null;
    }
  })();
  if (!what) return null;
  if (row.state === "settled") return `${what} Fully paid.`;
  if (row.state === "open" || row.state === "partial") {
    const left = money(row.remaining ?? 0);
    return `${what} ${theirs ? `${first} still owes ${left}` : `You still owe ${left}`}.`;
  }
  return what;
}

const KIND_ICON: Record<SettlementKind, LucideIcon> = {
  emi: CalendarClock,
  loanEmi: CalendarClock,
  loanInstallment: Landmark,
  loan: Landmark,
  moneyGiven: ArrowUpRight,
  moneyReceived: ArrowDownLeft,
  assigned: UserCheck,
  split: Split,
  paymentReceived: HandCoins,
  paymentMade: HandCoins,
  opening: Scale,
  adjustment: Scale,
  advance: PiggyBank,
  advanceApplied: PiggyBank,
};

const BANK_STATUS: Record<EmiRowStatus, string> = {
  upcoming: "Upcoming",
  partial: "Partly paid",
  paid: "Paid to bank",
  overdue: "Overdue at bank",
};

const TH =
  "sticky top-0 z-[2] border-r border-b border-r-border-strong/50 border-b-border-strong bg-secondary px-2.5 py-1.5 text-left text-[10.5px] font-bold tracking-[0.07em] whitespace-nowrap text-foreground/75 uppercase last:border-r-0";
const TD = "border-r border-b border-r-border-strong/40 border-b-border-strong/55 px-2.5 py-1 align-middle last:border-r-0";
const NUM = "text-right tabular-nums whitespace-nowrap";

const isPaymentKind = (k: SettlementKind) => k === "paymentReceived" || k === "paymentMade" || k === "advance" || k === "advanceApplied";

export interface SettlementRowView {
  row: LedgerRow;
  kind: SettlementKind;
  family: Family;
  /** The source family — kept on the Type badge even when the row is shown as brought forward. */
  typeFamily: Family;
  title: string;
  /** Plain-language Type for the on-screen table (see `tableTypeLabel`). */
  typeLabel: string;
  relation: string;
  status: ReturnType<typeof settlementStatus>;
  paid: number | null;
  /** Row belongs to an earlier cycle and is shown as brought forward. */
  carried: boolean;
  /** "Original ₹3,000 · 3-way split" for a split/assigned share whose Expense is available; else null. */
  splitNote: string | null;
  /** The same split context as separate figures — the collapsed row shows original total and share apart, never as one sentence. */
  split: { original: number; participantCount: number; shareLabel: string; share: number } | null;
  /** Entry ids (this row's and its payments') whose received date isn't known — their stored date is a placeholder. */
  unknownDates: ReadonlySet<string>;
}

export function viewOf(row: LedgerRow, personName: string, lookups: SettlementLookups, carried = false, personId?: string): SettlementRowView {
  const kind = settlementKind(row, lookups);
  const ctx = (kind === "split" || kind === "assigned") && personId != null ? splitContext(row, lookups, personId) : null;
  const tone = settlementTone(row, kind);
  const shareLabel = row.direction === "iOwe" ? "Your share" : `${personName.split(" ")[0]}'s share`;
  const share = row.direction === "iOwe" ? row.amount : (ctx?.personShare ?? row.amount);
  return {
    row,
    kind,
    family: carried ? "carried" : TONE_FAMILY[tone],
    typeFamily: TONE_FAMILY[tone],
    title: settlementTitle(row, kind, personName),
    typeLabel: tableTypeLabel(kind, row, lookups),
    relation: relationLine(row, kind, personName, money),
    status: receivedEarlierStatus(row, kind, lookups) ?? tableStatus(row, kind, personName),
    paid: isPaymentKind(kind) ? row.amount : paidSoFar(row),
    carried,
    // The row amount is one share of a bigger bill — say whose, next to the original total.
    splitNote: ctx ? `${splitContextLine(ctx, money)} · ${shareLabel} ${money(share)}` : null,
    split: ctx ? { original: ctx.original, participantCount: ctx.participantCount, shareLabel, share } : null,
    unknownDates: new Set(
      [row.entryId, ...row.payments.map((p) => p.entryId)].filter((id): id is string => id != null && lookups.entriesById.get(id)?.receivedDateKnown === false),
    ),
  };
}

// ---------------------------------------------------------------------------------------------------
// Small parts
// ---------------------------------------------------------------------------------------------------

/**
 * A fully paid obligation's completion mark: a thin muted line through the free space of the row's main line
 * with a small centred "Received ₹375". It fills only the space after the text — never strikes or covers it —
 * and sits on an existing line, so the row is no taller. Only for `state === "settled"` rows.
 */
/**
 * The completion stamp's label, or null. Completed = a fully paid obligation, or a payment that cleared the
 * item it was for (often an earlier cycle's). A part payment, a general payment and a held advance are not.
 */
export function completionLabel(v: SettlementRowView): string | null {
  if (v.row.state === "settled") return v.status.label;
  if (v.kind === "paymentReceived" || v.kind === "paymentMade") {
    const settles = v.row.statementRow?.settles;
    if (settles && settles.remainingAfter < 0.005) return `${v.kind === "paymentReceived" ? "Received" : "Paid"} ${money(v.row.amount)}`;
  }
  return null;
}

function CompletionStamp({ label, className }: { label: string; className?: string }) {
  return (
    <span data-testid="completion-stamp" className={cn("flex min-w-[8.5rem] flex-1 items-center gap-1.5", className)}>
      <span aria-hidden className="h-px min-w-2 flex-1 bg-success/35" />
      <span className="inline-flex shrink-0 items-center gap-1 text-[10.5px] leading-none font-semibold whitespace-nowrap text-foreground/80 tabular-nums">
        <Check className="size-3 text-success" strokeWidth={2.75} aria-hidden />
        {label}
      </span>
      <span aria-hidden className="h-px min-w-2 flex-1 bg-success/35" />
    </span>
  );
}

/**
 * The LENDER side of a person's Loan / EMI share row (the schedule's `amountPaid` / due date): "Bank paid", "Bank part
 * paid", "Bank overdue" or "Bank due 5 Nov". Always shown, so the row's own status ("₹1,000 to receive") is never read
 * as the bank's. Display only: the person's share stays exactly as owed — paying the bank never settles them.
 */
export function lenderChipOf(inst: { amountDue: number; amountPaid: number; dueDate: Date }, today: Date = new Date()): { label: string; title: string; tone: "paid" | "part" | "overdue" | "due" } {
  const left = Math.max(0, inst.amountDue - inst.amountPaid);
  if (left <= 0.005) return { label: "Bank paid", title: "You already paid this installment to the bank. Their share to you is separate.", tone: "paid" };
  if (inst.amountPaid > 0.005) return { label: "Bank part paid", title: `You paid ${money(inst.amountPaid)} of ${money(inst.amountDue)} to the bank. Their share to you is separate.`, tone: "part" };
  const endOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59, 999);
  const due = inst.dueDate.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
  if (inst.dueDate.getTime() < new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime())
    return { label: "Bank overdue", title: `The bank installment was due ${due} and isn't paid yet. Their share to you is separate.`, tone: "overdue" };
  return { label: `Bank due ${due}`, title: `The bank installment is due ${due}${inst.dueDate.getTime() <= endOfToday.getTime() ? " (today)" : ""}. Their share to you is separate.`, tone: "due" };
}

function BankPaidChip({ rowKey }: { rowKey: string }) {
  const { data: emiInstallments = [] } = useAllEmiInstallments();
  const { data: loanInstallments = [] } = useAllLoanInstallments();
  const m = /^(emi|loan)-inst:(.+)$/.exec(rowKey);
  if (!m) return null;
  const inst = (m[1] === "emi" ? emiInstallments : loanInstallments).find((i) => i.id === m[2] && i.deletedAt == null);
  if (!inst) return null;
  const chip = lenderChipOf(inst);
  return (
    <span
      title={chip.title}
      data-testid="lender-chip"
      className={cn(
        "shrink-0 rounded-[4px] px-1.5 text-[10.5px] leading-4 font-bold whitespace-nowrap",
        chip.tone === "paid" ? "bg-success/10 text-success" : chip.tone === "overdue" ? "bg-expense/10 text-expense" : chip.tone === "part" ? "bg-settle-carried-badge text-settle-carried-text" : "bg-secondary text-foreground/70",
      )}
    >
      {chip.label}
    </span>
  );
}

/**
 * "What do these statuses mean?" — a short key to the table's own words (on screen only; statement / PDF wording
 * is unchanged). The People side and the bank side of a shared EMI are two separate things, and this says so.
 */
function StatusLegend({ hasLenderRows }: { hasLenderRows: boolean }) {
  const [open, setOpen] = useState(false);
  const items: [string, string][] = [
    ["₹X to receive", "They still owe you this."],
    ["Received ₹X · Got ₹X · ₹Y left", "Money they paid you — in full, or part of it."],
    ["You need to pay ₹X · Paid ₹X", "What you owe them, and what you have paid them."],
    ["Moved to Nov cycle", "Collection postponed — the amount is still owed; nothing else changes."],
    ["Received earlier", "Paid before FlowFi — already in your account balance, so no account changed."],
    ["Advance available · Advance used", "Money they gave ahead — it settles something only when you apply it."],
    ...(hasLenderRows
      ? ([["Bank paid · Bank due · Bank overdue", "EMI / loan shares only: whether YOU paid the lender that installment. It never changes what they owe you."]] as [string, string][])
      : []),
  ];
  return (
    <div className="mt-2 px-2 text-[12px] md:px-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1 rounded-[4px] font-semibold text-foreground/75 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Info className="size-3.5" aria-hidden />
        What do these statuses mean?
      </button>
      {open && (
        <dl className="mt-1.5 grid max-w-3xl gap-x-4 gap-y-1 rounded-[8px] bg-secondary/50 px-3 py-2 sm:grid-cols-[auto_minmax(0,1fr)]" data-testid="status-legend">
          {items.map(([term, meaning]) => (
            <div key={term} className="contents">
              <dt className="font-semibold text-foreground">{term}</dt>
              <dd className="text-foreground/75">{meaning}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

/** An earlier cycle's obligation that is still open. */
function CarriedChip() {
  return <span className="shrink-0 rounded-[4px] bg-settle-carried-badge px-1.5 text-[10.5px] leading-4 font-bold whitespace-nowrap text-settle-carried-text">Previous unpaid</span>;
}

/**
 * Split rows and money that already moved (received / paid / advance used) sit on the neutral surface — the
 * Status column carries their meaning. Open obligations, held advances and earlier-cycle rows keep their tint.
 */
function rowTint(v: SettlementRowView): string {
  const moved = !v.carried && (v.kind === "paymentReceived" || v.kind === "paymentMade" || v.kind === "advanceApplied");
  return v.family === "split" || moved ? "bg-card" : FAMILY[v.family].tint;
}

/**
 * Collapsed split context as three separate facts — "Split expense · 4 people", the purchase total and this
 * person's share — so the share is never read as the original amount. The full allocation is in the expansion.
 */
function SplitSummary({ split, className }: { split: NonNullable<SettlementRowView["split"]>; className?: string }) {
  return (
    <p className={cn("flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[11.5px] leading-tight tabular-nums", className)}>
      <span className="font-medium text-foreground/65">{split.participantCount >= 2 ? `Split expense · ${split.participantCount} people` : "Assigned in full"}</span>
      <span className="whitespace-nowrap">
        <span className="text-foreground/60">Original </span>
        <span className="font-bold text-foreground">{money(split.original)}</span>
      </span>
      <span className="whitespace-nowrap">
        <span className="text-foreground/60">{split.shareLabel} </span>
        <span className="font-semibold text-foreground">{money(split.share)}</span>
      </span>
    </p>
  );
}

/** Neutral outlined chip — Type says what the row is; only the Status column carries semantic colour. */
export function TypeBadge({ kind, family, label, className }: { kind: SettlementKind; family: Family; label?: string; className?: string }) {
  const Icon = KIND_ICON[kind];
  return (
    <span
      data-family={family}
      className={cn("inline-flex h-5 shrink-0 items-center gap-1 rounded-[4px] border border-border-strong/70 px-1.5 text-[10.5px] leading-none font-semibold whitespace-nowrap text-foreground/80", className)}
    >
      <Icon className="size-3 text-foreground/55" strokeWidth={2.25} aria-hidden />
      {label ?? TABLE_KIND_LABEL[kind]}
    </span>
  );
}

/** One line: icon + short label. The longer sentence is the hover title; the expansion spells it out. */
export function StatusPill({ status, kind, postponed = false }: { status: SettlementRowView["status"]; kind?: SettlementKind; postponed?: boolean }) {
  const style: StatusStyle = postponed ? "postponed" : kind === "advance" ? "advance" : status.tone;
  const Icon = STATUS_ICON[style];
  return (
    <span
      title={status.detail ?? undefined}
      className={cn("inline-flex h-5 max-w-full items-center gap-1 overflow-hidden rounded-[4px] px-1.5 text-[11px] leading-none font-bold whitespace-nowrap tabular-nums", STATUS_STYLE[style])}
    >
      {Icon && <Icon className="size-3 shrink-0" strokeWidth={2.5} aria-hidden />}
      {status.label}
    </span>
  );
}

/** The row's status — a live postponement reads "Moved to Nov cycle" (still owed: the remaining stays shown). */
function RowStatus({ v }: { v: SettlementRowView }) {
  const deferral = useRowDeferral(v.row.key, v.row.date);
  if (deferral?.status === "postponed" && v.row.state !== "settled") {
    const detail = `${v.status.label} · first due in the ${deferral.from} cycle`;
    // Part received before it was moved: what came in stays visible — the move covers only what is left.
    const label = v.row.state === "partial" ? `Got ${money(v.paid ?? 0)} · rest in ${deferral.name} cycle` : `Moved to ${deferral.name} cycle`;
    return <StatusPill status={{ ...v.status, label, detail }} postponed />;
  }
  // The row's completion stamp already says "Received ₹375" — Status stays short.
  if (completionLabel(v) != null) return <StatusPill status={{ ...v.status, label: "Fully paid" }} kind={v.kind} />;
  return <StatusPill status={v.status} kind={v.kind} />;
}

/** Row date on one line. A postponed row's date is struck with a dashed line: its first due period has passed. */
function RowDate({ v, className }: { v: SettlementRowView; className?: string }) {
  const { row } = v;
  const deferral = useRowDeferral(row.key, row.date);
  const moved = deferral?.status === "postponed" && row.state !== "settled";
  // The month heading carries the year; brought-forward rows sit outside it, so they keep theirs.
  return (
    <span
      title={moved ? `First due ${formatStatementDate(row.date, true)} · moved to ${deferral.name} cycle` : undefined}
      className={cn("whitespace-nowrap tabular-nums", moved && "line-through decoration-primary-accent-text/80 decoration-dashed decoration-[1.5px]", className)}
    >
      {row.entryId != null && v.unknownDates.has(row.entryId) ? "Date not known" : formatStatementDate(row.date)}
      {v.carried && <span className="ml-1 text-[0.85em] font-medium text-foreground/65">{row.date.getFullYear()}</span>}
    </span>
  );
}

function Amount({ value, strong, tone }: { value: number | null; strong?: boolean; tone?: string }) {
  if (value == null) return <span className="text-foreground/45">—</span>;
  return <span className={cn("tabular-nums", strong ? "font-heading text-[14.5px] font-bold" : "text-[13px] font-semibold", tone ?? "text-foreground")}>{money(value)}</span>;
}

/** Remaining is the second-strongest figure; zero on a settled row reads as done, not as a number to act on. */
function RemainingAmount({ v }: { v: SettlementRowView }) {
  if (v.row.state == null) return <span className="text-foreground/45">—</span>;
  if (v.row.state === "settled") return <span className="inline-flex items-center gap-1 text-[13px] font-semibold text-foreground/65 tabular-nums"><Check className="size-3.5 text-success" strokeWidth={2.5} />{money(0)}</span>;
  // Still owed: pending amber (overdue red, yours to pay in its own tone) — never success green.
  const tone = v.row.overdue ? "text-expense" : v.row.direction === "iOwe" ? "text-settle-payable-text" : "text-settle-emi-text";
  return <Amount value={v.row.remaining ?? 0} strong tone={tone} />;
}

/**
 * Desktop amount cell: what is still remaining, prominent; the original amount (a split row's share,
 * labelled as such) and what has been paid sit underneath as one secondary line. Rows with no
 * remaining state (payments) show their own figure instead.
 */
function AmountFigures({ v, muted }: { v: SettlementRowView; muted: boolean }) {
  const { row } = v;
  const original = isPaymentKind(v.kind) ? null : row.amount;
  if (row.state == null) return <Amount value={v.paid ?? original} tone={muted ? "text-foreground/75" : undefined} />;
  const paid = v.paid ?? 0;
  return (
    <>
      <RemainingAmount v={v} />
      <p className="text-[10.5px] leading-tight font-medium whitespace-nowrap text-foreground/60 tabular-nums">
        {original != null && (v.split ? v.split.shareLabel : <>of {money(original)}</>)}
        {original != null && paid > 0 && " · "}
        {paid > 0 && <>paid {money(paid)}</>}
      </p>
    </>
  );
}

/** Phone row figure: what is still left on an open row (with its original when part paid), else the amount. */
function MobileFigure({ v }: { v: SettlementRowView }) {
  const { row } = v;
  if (row.state === "open" || row.state === "partial") {
    return (
      <span className="shrink-0 text-right whitespace-nowrap">
        <RemainingAmount v={v} />
        {row.state === "partial" && <span className="ml-1 text-[11px] font-medium text-foreground/60 tabular-nums">of {money(row.amount)}</span>}
      </span>
    );
  }
  return (
    <span className="shrink-0">
      <Amount value={row.state == null ? (v.paid ?? row.amount) : row.amount} strong tone={row.state === "settled" ? "text-foreground/75" : undefined} />
    </span>
  );
}

// ---------------------------------------------------------------------------------------------------
// Expansion — the row's own reconciliation: breakdown, progress, history, source, actions
// ---------------------------------------------------------------------------------------------------

function Line({ label, value, strong, tone, indent }: { label: React.ReactNode; value: React.ReactNode; strong?: boolean; tone?: string; indent?: boolean }) {
  return (
    <div className={cn("flex items-baseline justify-between gap-4 py-[3px]", strong && "mt-0.5 border-t border-border-strong/60 pt-1.5")}>
      <dt className={cn("min-w-0 truncate", strong ? "font-semibold text-foreground" : "text-foreground/75", indent && "pl-3")}>{label}</dt>
      <dd className={cn("shrink-0 text-right tabular-nums", strong ? "font-bold" : "font-semibold", tone ?? "text-foreground")}>{value}</dd>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="mb-1 text-[10.5px] font-bold tracking-[0.08em] text-foreground/65 uppercase">{children}</p>;
}

function Breakdown({ v, personName }: { v: SettlementRowView; personId: string; personName: string; lookups: SettlementLookups }) {
  const { row, kind } = v;
  const s = row.statementRow;
  const first = personName.split(" ")[0];
  const responsible = row.direction === "iOwe" ? "You have to pay" : `${first} has to pay`;
  const settleLines =
    row.state != null ? (
      <>
        <Line label={responsible} value={money(row.amount)} />
        <Line label={row.direction === "iOwe" ? "You paid" : `${first} paid`} value={money(v.paid ?? 0)} tone={(v.paid ?? 0) > 0 ? "text-success" : undefined} />
        <Line label="Remaining" value={row.state === "settled" ? "Fully paid" : money(row.remaining ?? 0)} strong tone={row.state === "settled" ? "text-success" : undefined} />
      </>
    ) : null;

  if (kind === "emi" || kind === "loanEmi") {
    return (
      <dl className="text-[13px]">
        {s?.emi && <Line label={kind === "loanEmi" ? "Loan" : "EMI"} value={s.emi.sourceName} />}
        {s?.emi && <Line label="Installment" value={`#${s.emi.installmentNumber}`} />}
        <Line label="Due" value={formatStatementDate(row.date, true)} />
        {settleLines}
        {s?.emi && (
          <div className="mt-1.5 flex flex-wrap gap-1.5 text-[11.5px]">
            <span className="inline-flex items-center gap-1 rounded-full border border-border-strong/70 px-2 py-0.5">
              <span className="text-foreground/65">Bank EMI</span>
              <span className={cn("font-semibold", s.emi.status === "overdue" ? "text-expense" : "text-foreground")}>{BANK_STATUS[s.emi.status]}</span>
            </span>
            <span className="inline-flex items-center gap-1 rounded-full border border-border-strong/70 px-2 py-0.5">
              <span className="text-foreground/65">{first}&apos;s reimbursement</span>
              <span className="font-semibold text-foreground">{v.status.label}</span>
            </span>
          </div>
        )}
      </dl>
    );
  }
  if (kind === "split" || kind === "assigned") {
    // The allocation (whole bill, every stored share) is shown full width above by `Expansion`; this
    // column is only this person's settlement — never mixed into the allocation.
    return (
      <div className="text-[13px]">
        {settleLines && (
          <>
            <SectionLabel>{row.direction === "iOwe" ? "Your settlement" : `${first}'s settlement`}</SectionLabel>
            <dl>{settleLines}</dl>
          </>
        )}
      </div>
    );
  }
  if (kind === "loanInstallment") {
    return (
      <dl className="text-[13px]">
        {s?.loan && <Line label="Installment" value={`${s.loan.installmentNumber} of ${s.loan.installmentCount}`} />}
        <Line label="Due" value={formatStatementDate(row.date, true)} />
        {settleLines}
      </dl>
    );
  }
  if (kind === "advance") {
    const theirs = (s?.advanceDelta ?? 0) < 0;
    return (
      <dl className="text-[13px]">
        <Line label={theirs ? `${first} paid you ahead` : `You paid ${first} ahead`} value={money(row.amount)} strong />
        <p className="mt-1 text-[12px] text-foreground/75">
          Held as advance — not part of what is pending. It is used when applied to {theirs ? `${first}'s` : "your"} next obligations.
        </p>
      </dl>
    );
  }
  if (kind === "paymentReceived" || kind === "paymentMade" || kind === "advanceApplied") {
    return (
      <dl className="text-[13px]">
        <Line
          label={kind === "advanceApplied" ? "Advance used" : kind === "paymentReceived" ? `${first} paid you` : `You paid ${first}`}
          value={money(row.amount)}
          strong
        />
        {s?.settles ? (
          <>
            <Line label={<span className="inline-flex items-center gap-1"><CornerDownRight className="size-3.5" />Applied to {s.settles.title}</span>} value={money(row.amount)} tone="text-success" />
            <Line label={`${s.settles.title} · original`} value={money(s.settles.originalAmount)} />
            <Line label="Left on it after this" value={s.settles.remainingAfter > 0 ? money(s.settles.remainingAfter) : "Cleared"} strong />
          </>
        ) : (
          <p className="mt-1 text-[12px] text-foreground/75">Not applied to one item — it reduces the overall balance with {first}.</p>
        )}
      </dl>
    );
  }
  return (
    <dl className="text-[13px]">
      <Line label="Amount" value={money(row.amount)} />
      {settleLines}
    </dl>
  );
}

function Progress({ v }: { v: SettlementRowView }) {
  const { row } = v;
  if (row.state == null || row.amount <= 0) return null;
  const paid = v.paid ?? 0;
  const pct = Math.min(100, Math.max(0, (paid / row.amount) * 100));
  const bar = row.state === "settled" ? "bg-success" : row.overdue ? "bg-expense" : row.state === "partial" ? "bg-settle-emi-edge" : "bg-foreground/30";
  return (
    <div aria-label="Payment progress">
      <div className="mt-1.5 flex items-center gap-2">
        <div className="h-2 flex-1 overflow-hidden rounded-full bg-border-strong/45" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
          <div className={cn("h-full rounded-full transition-[width]", bar)} style={{ width: `${pct}%` }} />
        </div>
        <span className="w-9 text-right text-[12px] font-bold text-foreground tabular-nums">{Math.round(pct)}%</span>
      </div>
    </div>
  );
}

function Payments({
  v,
  personName,
  accountForEntry,
  onUndo,
  onEdit,
}: {
  v: SettlementRowView;
  personName: string;
  accountForEntry: (id: string | null) => string | null;
  onUndo?: (p: PaymentRecord) => void;
  /** Set only for payments that can be edited — a recorded payment, changed in place. */
  onEdit?: (p: PaymentRecord) => (() => void) | null;
}) {
  const { row } = v;
  if (row.payments.length === 0) return null;
  const first = personName.split(" ")[0];
  const total = row.payments.reduce((s, p) => s + p.amount, 0);
  return (
    <div>
      <SectionLabel>Payment history</SectionLabel>
      <ul className="divide-y divide-border-strong/45 border-y border-border-strong/60 text-[12.5px]">
        {row.payments.map((p) => {
          const account = accountForEntry(p.entryId);
          return (
            <li key={p.key} className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 py-1">
              <span className="shrink-0 font-semibold text-foreground tabular-nums sm:w-[5.5rem]">{p.entryId != null && v.unknownDates.has(p.entryId) ? "Date not known" : formatStatementDate(p.date, true)}</span>
              <span className="order-last min-w-0 basis-full text-foreground/80 sm:order-none sm:basis-auto sm:flex-1">
                {p.direction === "youPaid" ? `Paid to ${first}` : `Received from ${first}`}
                {account && <span className="text-foreground/70"> → {account}</span>}
              </span>
              <span className="ml-auto font-bold text-foreground tabular-nums sm:ml-0">{money(p.amount)}</span>
              {(() => {
                const edit = onEdit?.(p);
                return edit ? (
                  <button type="button" onClick={edit} title="Edit this payment" className="flex h-6 items-center gap-1 rounded-[5px] px-1 text-[11.5px] font-semibold text-foreground/70 outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
                    <Pencil className="size-3.5" strokeWidth={1.75} />
                    Edit
                  </button>
                ) : null;
              })()}
              {p.undo && onUndo ? (
                <button type="button" onClick={() => onUndo(p)} title={p.undo.kind === "payment" ? "Revert this payment" : "Undo this payment"} className="flex h-6 items-center gap-1 rounded-[5px] px-1 text-[11.5px] font-semibold text-foreground/70 outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
                  <Undo2 className="size-3.5" strokeWidth={1.75} />
                  {p.undo.kind === "payment" ? "Revert" : "Undo"}
                </button>
              ) : p.undoBlock ? (
                <span title={p.undoBlock} className="text-foreground/55"><Info className="size-3.5" /></span>
              ) : null}
            </li>
          );
        })}
      </ul>
      {row.payments.length > 1 && (
        <p className="mt-1 flex justify-between text-[12.5px] font-semibold text-foreground">
          <span>Total {row.direction === "iOwe" ? "paid" : "received"}</span>
          <span className="tabular-nums">{money(total)}</span>
        </p>
      )}
    </div>
  );
}

function Source({ v, cycleLabelOf }: { v: SettlementRowView; cycleLabelOf?: (d: Date) => string }) {
  const { row } = v;
  const ref = row.entryId ?? row.key.split(":").pop() ?? row.key;
  return (
    <details className="group min-w-0 text-[12px]" onClick={(e) => e.stopPropagation()}>
      <summary className="flex h-7 w-fit cursor-pointer list-none items-center gap-1 rounded-[5px] font-semibold text-foreground/70 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" aria-hidden />
        More details
      </summary>
      <dl className="mt-1 text-foreground/75">
        <div className="flex gap-1.5"><dt>Date</dt><dd className="font-semibold text-foreground">{formatStatementDate(row.date, true)}</dd></div>
        {v.carried && cycleLabelOf && <div className="flex gap-1.5"><dt>From cycle</dt><dd className="font-semibold text-foreground">{cycleLabelOf(row.date)}</dd></div>}
        {row.entryId && formatStatementDate(row.createdAt, true) !== formatStatementDate(row.date, true) && (
          <div className="flex gap-1.5"><dt>Recorded</dt><dd className="font-semibold text-foreground">{formatStatementDate(row.createdAt, true)}</dd></div>
        )}
        <div className="flex gap-1.5"><dt>Ref</dt><dd className="truncate font-mono text-[11px]">#{ref.slice(0, 8)}</dd></div>
        {!row.deletable && row.deleteBlock && (
          <p className="mt-1 text-[11.5px]">
            {row.deleteBlock === "expense" && v.kind === "assigned" ? "Part of an assigned expense — change it from the expense" : DELETE_BLOCK_NOTE[row.deleteBlock]}
          </p>
        )}
      </dl>
    </details>
  );
}

const ACTION_BTN =
  "flex h-6 items-center gap-1.5 rounded-[5px] border px-2 text-[12px] font-semibold whitespace-nowrap outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring";

/**
 * Where a row that is NOT owned by the People Ledger is edited or deleted — its authoritative source (the
 * EMI / Loan, or the expense transaction for a split/assigned/linked share). Null for ledger-owned rows.
 */
export function sourceLink(row: LedgerRow, lookups: SettlementLookups): { href: string; label: string } | null {
  const emi = row.statementRow?.emi;
  if (row.category === "emi" && emi?.sourceId) {
    return emi.sourceKind === "loan"
      ? { href: `/loans?agreement=${encodeURIComponent(emi.sourceId)}`, label: "Open Loan" }
      : { href: `/emi?agreement=${encodeURIComponent(emi.sourceId)}`, label: "Open EMI" };
  }
  if (row.category === "loan" && row.loanId) return { href: `/loans?agreement=${encodeURIComponent(row.loanId)}`, label: "Open Loan" };
  if (row.entryId && !row.deletable && row.deleteBlock === "expense" && row.statementRow?.kind === "obligation") {
    const ref = lookups.entriesById.get(row.entryId)?.transactionRef;
    // Never a dead link: a row whose source transaction is gone has nowhere to navigate to.
    // Carries the People return context so Transactions can bring the user back to this exact ledger.
    if (ref && !sourceUnavailable(row, lookups)) return { href: transactionHref(ref, lookups.sourceReturn), label: "Open expense" };
  }
  return null;
}

/**
 * A transaction-owned row whose source transaction no longer exists (deleted by an older path that left
 * the People effect behind). Shown as "Original transaction is no longer available" — never an Edit /
 * Delete that navigates to a missing transaction. Ghosts that are safe to remove are reconciled
 * automatically (`useOrphanLedgerReconciliation`); what remains here has a payment recorded against it.
 */
export function sourceUnavailable(row: LedgerRow, lookups: SettlementLookups): boolean {
  if (!row.entryId || row.deletable || !lookups.transactionStatus) return false;
  const entry = lookups.entriesById.get(row.entryId);
  if (!entry?.transactionRef) return false;
  return lookups.transactionStatus(entry.transactionRef, entry) === "deleted";
}

/** Only the actions this row really supports — Edit/Delete here for ledger-owned rows, the source otherwise. */
function RowActionButtons({ v, handlers, lookups, compact = false }: { v: SettlementRowView; handlers: LedgerRowHandlers; lookups: SettlementLookups; compact?: boolean }) {
  const { row } = v;
  const source = sourceLink(row, lookups);
  const settling = handlers.settlingKey === row.key;
  const editing = handlers.editingKey === row.key;
  const loanPay = row.category === "loan" && row.loanId != null && row.state != null && row.state !== "settled";
  return (
    <div className="flex flex-wrap items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
      {loanPay ? (
        <LoanPayLink loanId={row.loanId!} />
      ) : row.settle && !sourceUnavailable(row, lookups) ? (
        <button
          type="button"
          aria-pressed={settling}
          onClick={() => (settling ? handlers.onSettleCancel() : handlers.onSettleStart(row))}
          className={cn(ACTION_BTN, settling ? "border-primary-accent-text bg-primary/20 text-foreground" : "border-primary-accent-text/60 bg-primary/10 text-foreground hover:bg-primary/25")}
        >
          <HandCoins className="size-3.5 text-primary-accent-text" strokeWidth={2} />
          {compact ? "Record" : row.state === "partial" ? "Record rest" : "Record payment"}
        </button>
      ) : null}
      {isEditable(row) && handlers.onEditStart && (
        <button
          type="button"
          aria-pressed={editing}
          aria-label={`Edit ${v.title}`}
          title="Edit"
          onClick={() => (editing ? handlers.onEditCancel?.() : handlers.onEditStart!(row))}
          className={cn(ACTION_BTN, compact && "px-1.5", "border-border-strong bg-card text-foreground hover:bg-secondary")}
        >
          <Pencil className="size-3.5" strokeWidth={1.75} />
          {!compact && "Edit"}
        </button>
      )}
      {row.deletable && handlers.onDelete && (
        <button
          type="button"
          aria-label={`Delete ${v.title}`}
          title="Delete"
          onClick={() => handlers.onDelete!(row)}
          className={cn(ACTION_BTN, compact && "px-1.5", "border-border-strong bg-card text-foreground hover:border-expense hover:text-expense")}
        >
          <Trash2 className="size-3.5" strokeWidth={1.75} />
          {!compact && "Delete"}
        </button>
      )}
      {sourceUnavailable(row, lookups) && (
        <span className="text-[12px] text-muted-foreground" title="Its source transaction was deleted. Reverse the payment recorded against it to clear this entry.">
          Original transaction is no longer available
          {(row.payments.length > 0 || row.state === "partial" || row.state === "settled") && " · repair blocked — payment history exists"}
        </span>
      )}
      {source && !(row.category === "loan" && loanPay) && (
        <Link
          href={source.href}
          title={`Edit or delete it where it comes from — ${source.label.replace("Open ", "the ")}`}
          className={cn(ACTION_BTN, compact && "px-1.5", "border-border-strong bg-card text-foreground hover:bg-secondary")}
        >
          <ExternalLink className="size-3.5" strokeWidth={1.75} />
          {compact ? <span className="sr-only">{source.label}</span> : source.label}
        </Link>
      )}
    </div>
  );
}

function Expansion({
  v,
  personId,
  personName,
  lookups,
  accountForEntry,
  handlers,
  cycleLabelOf,
}: {
  v: SettlementRowView;
  personId: string;
  personName: string;
  lookups: SettlementLookups;
  accountForEntry: (id: string | null) => string | null;
  handlers: LedgerRowHandlers;
  cycleLabelOf?: (d: Date) => string;
}) {
  const { row } = v;
  if (handlers.editingKey === row.key && handlers.onEditSubmit) {
    return <EntryEditForm row={row} onCancel={() => handlers.onEditCancel?.()} onSubmit={(values) => handlers.onEditSubmit!(row, values)} />;
  }
  if (handlers.settlingKey === row.key) {
    return (
      <div className="max-w-2xl">
        <EntrySettleForm row={row} personName={personName} onCancel={handlers.onSettleCancel} onSubmit={(values) => handlers.onSettleSubmit(row, values)} />
      </div>
    );
  }
  const onUndo = handlers.onUndoPayment ? (p: PaymentRecord) => handlers.onUndoPayment!(row, p) : undefined;
  const onEditPayment = handlers.onEditPayment
    ? (p: PaymentRecord) => (handlers.editablePayment?.(p) ? () => handlers.onEditPayment!(p) : null)
    : undefined;
  const allocation = v.kind === "split" || v.kind === "assigned" ? splitAllocation(linkedExpense(row, lookups), personId) : null;
  const explanation = rowExplanation(v, personName);
  return (
    <div className={cn("rounded-[8px] border border-l-[3px] border-border-strong/70 bg-card px-3 py-2", FAMILY[v.family].edge)}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          {/* The full description wraps here — the collapsed row only truncates it. */}
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
            <p className="min-w-0 text-[14px] leading-snug font-semibold break-words text-foreground">{v.title}</p>
            <TypeBadge kind={v.kind} family={v.typeFamily} label={v.typeLabel} />
          </div>
          <p className="mt-0.5 text-[12.5px] leading-snug text-foreground/80" data-testid="row-explanation">
            <span className="whitespace-nowrap tabular-nums">{formatStatementDate(row.date, true)}</span>
            {explanation && <> · {explanation}</>}
          </p>
        </div>
        <RowActionButtons v={v} handlers={handlers} lookups={lookups} />
      </div>
      {allocation && (
        // The whole purchase and every stored share, across the row's full width; settlement follows separately.
        <div className="mt-2">
          <p className="mb-1 text-[10.5px] font-bold tracking-[0.08em] text-foreground/65 uppercase">Split details</p>
          <SplitAllocationBreakdown allocation={allocation} focusName={personName} className="max-w-4xl" />
        </div>
      )}
      {/* Fixed-width columns: label/value pairs stay close together instead of stretching across the row. */}
      <div className="mt-2 grid gap-x-8 gap-y-2.5 md:grid-cols-2 xl:grid-cols-[minmax(0,19rem)_minmax(0,24rem)]">
        <div>
          <Breakdown v={v} personId={personId} personName={personName} lookups={lookups} />
          <Progress v={v} />
        </div>
        <Payments v={v} personName={personName} accountForEntry={accountForEntry} onUndo={onUndo} onEdit={onEditPayment} />
      </div>
      {/* Timing + follow-up share one footer line (an opened editor takes the full width); details stay folded. */}
      <div className="mt-2 flex flex-wrap items-start gap-x-6 gap-y-1.5 border-t border-border-strong/60 pt-1.5">
        <DeferralControl row={row} title={v.title} />
        <FollowUpControl rowKey={row.key} title={v.title} open={(row.state === "open" || row.state === "partial")} />
        <div className="ml-auto">
          <Source v={v} cycleLabelOf={cycleLabelOf} />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------------------------------

export interface SettlementTableProps {
  personId: string;
  personName: string;
  /** Rows to show (already filtered), newest first. */
  rows: LedgerRow[];
  /** Open obligations from earlier cycles — shown first as "Previous unpaid amount". */
  carriedRows?: LedgerRow[];
  isLoading: boolean;
  lookups: SettlementLookups;
  accountForEntry: (entryId: string | null) => string | null;
  handlers: LedgerRowHandlers;
  /** Shown when there are no rows at all. */
  empty: React.ReactNode;
  /** Earlier-cycle source label, e.g. "Sep cycle". */
  cycleLabelOf?: (d: Date) => string;
  /** Onward-payment trail for an obligation settled with money received (card bill / EMI still to pay, or paid). */
  linkedTrail?: (rowKey: string) => React.ReactNode;
  /** Sticky header offset container: the table's header sticks to the top of its scrolling parent. */
  className?: string;
}

/** A lump payment applied to many installments reads as one folded line, not a wall of identical rows. */
const FOLD_MIN = 3;
type FoldItem = { kind: "row"; row: LedgerRow } | { kind: "fold"; id: string; rows: LedgerRow[] };
export function foldPaymentRows(rows: readonly LedgerRow[]): FoldItem[] {
  const out: FoldItem[] = [];
  let i = 0;
  while (i < rows.length) {
    const id = rows[i].paymentId;
    let j = i + 1;
    while (id != null && j < rows.length && rows[j].paymentId === id) j++;
    if (id != null && j - i >= FOLD_MIN) out.push({ kind: "fold", id: `${id}:${rows[i].key}`, rows: rows.slice(i, j) as LedgerRow[] });
    else for (let k = i; k < j; k++) out.push({ kind: "row", row: rows[k] });
    i = j;
  }
  return out;
}

export function SettlementTable({ personId, personName, rows, carriedRows = [], isLoading, lookups, accountForEntry, handlers, empty, cycleLabelOf, className, linkedTrail }: SettlementTableProps) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [openFolds, setOpenFolds] = useState<ReadonlySet<string>>(new Set());
  // Deep link from a lender-payment screen (`?obligation=<row key>`): open and scroll to that row once.
  const deepLinkedRef = useRef(false);
  useEffect(() => {
    if (deepLinkedRef.current || isLoading || typeof window === "undefined") return;
    const key = new URLSearchParams(window.location.search).get("obligation");
    if (!key || ![...rows, ...carriedRows].some((r) => r.key === key)) return;
    deepLinkedRef.current = true;
    requestAnimationFrame(() => {
      setOpenKey(key);
      [...document.querySelectorAll<HTMLElement>(`[data-obligation-key="${CSS.escape(key)}"]`)].find((el) => el.offsetParent != null)?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  }, [isLoading, rows, carriedRows]);

  if (isLoading) {
    return (
      <div className="space-y-2.5 px-3 py-3">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="flex items-center gap-3">
            <Skeleton className="h-4 w-12" />
            <Skeleton className="h-4 flex-1" />
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 w-20" />
          </div>
        ))}
      </div>
    );
  }
  if (rows.length === 0 && carriedRows.length === 0) return <>{empty}</>;

  const toggle = (row: LedgerRow) => {
    if (handlers.settlingKey === row.key) handlers.onSettleCancel();
    if (handlers.editingKey === row.key) handlers.onEditCancel?.();
    setOpenKey((k) => (k === row.key ? null : row.key));
  };
  const isOpen = (row: LedgerRow) => openKey === row.key || handlers.settlingKey === row.key || handlers.editingKey === row.key;

  const carriedViews = carriedRows.map((r) => viewOf(r, personName, lookups, true, personId));
  const groups = groupByMonth(rows, (r) => r.date);
  const total = rows.length + carriedRows.length;
  const expansionProps = { personId, personName, lookups, accountForEntry, handlers, cycleLabelOf };

  const toggleFold = (id: string) =>
    setOpenFolds((cur) => {
      const next = new Set(cur);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const foldIsOpen = (f: Extract<FoldItem, { kind: "fold" }>) =>
    openFolds.has(f.id) || f.rows.some((r) => r.key === openKey || r.key === handlers.settlingKey || r.key === handlers.editingKey);
  const foldTitle = (f: Extract<FoldItem, { kind: "fold" }>) => settlementTitle(f.rows[0], "paymentReceived", personName);
  const foldMeta = (f: Extract<FoldItem, { kind: "fold" }>) => `${f.rows.length} installments · ${money(f.rows.reduce((sum, r) => sum + r.amount, 0))} in total`;

  const desktopRow = (v: SettlementRowView, n: number) => {
    const { row } = v;
    const open = isOpen(row);
    const fam = FAMILY[v.family];
    const muted = row.state === "settled";
    const stamp = completionLabel(v);
    return (
      <Fragment key={row.key}>
        <tr
          data-obligation-key={row.key}
          onClick={() => toggle(row)}
          aria-expanded={open}
          // Keyboard: the row is one tab stop; Enter/Space expands it (only when the row itself is focused,
          // so Enter on an action button inside still runs just that button).
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
              e.preventDefault();
              toggle(row);
            }
          }}
          className={cn("group cursor-pointer transition-colors", rowTint(v), "hover:brightness-[0.97] dark:hover:brightness-110", open && "outline-2 -outline-offset-2 outline-primary-accent-text/60")}
        >
          <td className={cn(TD, "hidden w-10 border-l-[4px] text-right text-[11px] font-semibold text-foreground/60 tabular-nums lg:table-cell", fam.edge)}>{sequence(n, total)}</td>
          <td className={cn(TD, "w-[4.75rem] border-l-[4px] lg:border-l-0", fam.edge)}>
            <RowDate v={v} className="text-[13px] leading-tight font-semibold text-foreground" />
          </td>
          <td className={cn(TD, "w-full max-w-0")}>
            <div className="flex min-w-0 items-center gap-1.5">
              <ChevronDown className={cn("size-3.5 shrink-0 text-foreground/50 transition-transform", open && "rotate-180")} strokeWidth={2} aria-hidden />
              <span className={cn("truncate text-[13.5px] leading-tight font-semibold", muted ? "text-foreground/80" : "text-foreground")}>{v.title}</span>
              <TypeBadge kind={v.kind} family={v.typeFamily} label={v.typeLabel} className="h-[18px] xl:hidden" />
              {v.carried && <CarriedChip />}
              {(v.kind === "emi" || v.kind === "loanEmi") && <BankPaidChip rowKey={v.row.key} />}
              {stamp && <CompletionStamp label={stamp} className="ml-1" />}
            </div>
            {/* One secondary line: split figures (they already say whose share) or the plain relation. */}
            <div className="flex min-w-0 items-baseline gap-x-3 pl-5">
              {v.split ? (
                <SplitSummary split={v.split} className="min-w-0 flex-nowrap overflow-hidden" />
              ) : (
                <p className="min-w-0 truncate text-[11.5px] leading-tight font-medium text-foreground/75">
                  {v.carried && cycleLabelOf ? `From ${cycleLabelOf(row.date)} · ` : ""}
                  {v.relation}
                </p>
              )}
              {row.state !== "settled" && <DeferralNote rowKey={row.key} rowDate={row.date} hidePostponed className="shrink-0 whitespace-nowrap" />}
            </div>
            {linkedTrail?.(row.key) && <div className="pl-5">{linkedTrail(row.key)}</div>}
          </td>
          <td className={cn(TD, "hidden w-[9.5rem] xl:table-cell")}><TypeBadge kind={v.kind} family={v.typeFamily} label={v.typeLabel} /></td>
          <td className={cn(TD, NUM, "w-[9.5rem]")}>
            <AmountFigures v={v} muted={muted} />
            <FollowUpNote rowKey={row.key} className="flex justify-end" />
          </td>
          <td className={cn(TD, "w-[11.5rem] max-w-[11.5rem]")}><RowStatus v={v} /></td>
          <td className={cn(TD, "w-[10rem] py-0.5")}><RowActionButtons v={v} handlers={handlers} lookups={lookups} compact /></td>
        </tr>
        <tr aria-hidden={!open}>
          <td colSpan={7} className={cn("p-0", open && "border-b border-border-strong/60 bg-secondary/60")}>
            <InlineReveal open={open}>
              <div className="px-3 py-2 lg:pl-12">
                <Expansion v={v} {...expansionProps} />
              </div>
            </InlineReveal>
          </td>
        </tr>
      </Fragment>
    );
  };

  const mobileRow = (v: SettlementRowView) => {
    const { row } = v;
    const open = isOpen(row);
    const fam = FAMILY[v.family];
    const stamp = completionLabel(v);
    return (
      <li key={row.key} data-obligation-key={row.key} className={cn("border-b border-l-[4px] border-b-border-strong/55", rowTint(v), fam.edge)}>
        <button type="button" onClick={() => toggle(row)} aria-expanded={open} className="block w-full px-3 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
          {/* Line 1: what it is · the figure that matters (what is left, or the amount once paid). */}
          <div className="flex items-baseline justify-between gap-3">
            <p className={cn("min-w-0 truncate text-[13.5px] leading-snug font-semibold", row.state === "settled" ? "text-foreground/80" : "text-foreground")}>{v.title}</p>
            <MobileFigure v={v} />
          </div>
          {/* Line 2: type · date · status. Paid / left / moved are in the status, so no separate grid. A completed
              row shows its completion stamp in the status's place, filling the line's free space. */}
          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
            <TypeBadge kind={v.kind} family={v.typeFamily} label={v.typeLabel} className="h-[18px]" />
            <RowDate v={v} className="text-[11.5px] font-medium text-foreground/70" />
            {v.carried && <CarriedChip />}
              {(v.kind === "emi" || v.kind === "loanEmi") && <BankPaidChip rowKey={v.row.key} />}
            <span className={cn("ml-auto flex max-w-full min-w-0 items-center gap-1", stamp && "flex-1")}>
              {stamp ? <CompletionStamp label={stamp} className="min-w-[7.5rem]" /> : <RowStatus v={v} />}
              <ChevronDown className={cn("size-4 shrink-0 text-foreground/55 transition-transform", open && "rotate-180")} aria-hidden />
            </span>
          </div>
          {v.split && <SplitSummary split={v.split} className="mt-0.5" />}
          {row.state !== "settled" && <DeferralNote rowKey={row.key} rowDate={row.date} hidePostponed className="mt-0.5 flex" />}
          <FollowUpNote rowKey={row.key} className="mt-0.5 flex" />
          {linkedTrail?.(row.key) && <span className="mt-0.5 block">{linkedTrail(row.key)}</span>}
        </button>
        <InlineReveal open={open}>
          <div className="px-2 pb-2.5">
            <Expansion v={v} {...expansionProps} />
          </div>
        </InlineReveal>
      </li>
    );
  };

  let n = 0;
  return (
    <div className={className}>
      {/* md+: the reconciliation table */}
      <table className="hidden w-full border-separate border-spacing-0 text-sm md:table">
        <thead>
          <tr>
            <th className={cn(TH, "hidden w-10 text-right lg:table-cell")}>#</th>
            <th className={cn(TH, "w-[4.75rem]")}>Date</th>
            <th className={cn(TH, "w-full")}>What</th>
            <th className={cn(TH, "hidden w-[9.5rem] xl:table-cell")}>Type</th>
            <th className={cn(TH, "w-[9.5rem] text-right")} title="Still remaining, with this person's original amount (for a split, their share) and what has been paid underneath">Amount</th>
            <th className={cn(TH, "w-[11.5rem]")}>Status</th>
            <th className={cn(TH, "w-[10rem]")}>Action</th>
          </tr>
        </thead>
        <tbody>
          {carriedViews.length > 0 && (
            <>
              <tr>
                <td colSpan={7} className="border-b border-border-strong/60 bg-settle-carried-badge px-3 py-1 text-[10.5px] font-bold tracking-[0.08em] text-settle-carried-text uppercase">
                  <span className="inline-flex items-center gap-1.5"><History className="size-3.5" />Previous unpaid amount · not paid in previous months</span>
                </td>
              </tr>
              {carriedViews.map((v) => desktopRow(v, ++n))}
            </>
          )}
          {groups.map((g) => (
            <Fragment key={g.key}>
              <tr>
                <td colSpan={7} className="border-t-2 border-b border-t-border-strong border-b-border-strong/70 bg-secondary px-3 pt-2 pb-1">
                  <span className="text-[12px] font-bold tracking-[0.08em] whitespace-nowrap text-foreground uppercase">{g.label}</span>
                  <span className="ml-2 text-[11.5px] font-medium whitespace-nowrap text-foreground/70">
                    {g.rows.length} {g.rows.length === 1 ? "transaction" : "transactions"}
                  </span>
                </td>
              </tr>
              {foldPaymentRows(g.rows.map((x) => x.row)).map((item) => {
                if (item.kind === "row") return desktopRow(viewOf(item.row, personName, lookups, false, personId), ++n);
                const open = foldIsOpen(item);
                return (
                  <Fragment key={item.id}>
                    <tr onClick={() => toggleFold(item.id)} className="cursor-pointer bg-muted/40 hover:bg-muted/60" data-testid="payment-fold">
                      <td colSpan={7} className="border-b border-border px-3 py-2">
                        <button type="button" aria-expanded={open} className="flex w-full items-center gap-2 text-left text-sm font-semibold text-foreground">
                          <ChevronDown className={cn("size-4 transition-transform", !open && "-rotate-90")} aria-hidden />
                          {foldTitle(item)}
                          <span className="text-xs font-normal text-muted-foreground">{foldMeta(item)} · {open ? "hide" : "show"}</span>
                        </button>
                      </td>
                    </tr>
                    {open && item.rows.map((row) => desktopRow(viewOf(row, personName, lookups, false, personId), ++n))}
                  </Fragment>
                );
              })}
            </Fragment>
          ))}
        </tbody>
      </table>

      {/* Phone: compact financial rows */}
      <ul className="flex flex-col md:hidden">
        {carriedViews.length > 0 && (
          <li className="border-b border-border-strong/60 bg-settle-carried-badge px-3 py-1 text-[10.5px] font-bold tracking-[0.08em] text-settle-carried-text uppercase">Previous unpaid amount</li>
        )}
        {carriedViews.map(mobileRow)}
        {groups.map((g) => (
          <Fragment key={g.key}>
            <li className="sticky top-0 z-[1] flex items-baseline justify-between border-t-2 border-b border-t-border-strong border-b-border-strong/70 bg-secondary px-3 py-1">
              <span className="text-[12px] font-bold tracking-[0.08em] whitespace-nowrap text-foreground uppercase">{g.label}</span>
              <span className="text-[11px] font-medium whitespace-nowrap text-foreground/70">{g.rows.length} {g.rows.length === 1 ? "transaction" : "transactions"}</span>
            </li>
            {foldPaymentRows(g.rows.map((x) => x.row)).map((item) => {
              if (item.kind === "row") return mobileRow(viewOf(item.row, personName, lookups, false, personId));
              const open = foldIsOpen(item);
              return (
                <Fragment key={item.id}>
                  <li className="border-b border-border bg-muted/40">
                    <button type="button" aria-expanded={open} onClick={() => toggleFold(item.id)} className="flex w-full flex-col gap-0.5 px-3 py-2 text-left">
                      <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
                        <ChevronDown className={cn("size-4 transition-transform", !open && "-rotate-90")} aria-hidden />
                        {foldTitle(item)}
                      </span>
                      <span className="pl-6 text-xs text-muted-foreground">{foldMeta(item)} · {open ? "hide" : "show"}</span>
                    </button>
                  </li>
                  {open && item.rows.map((row) => mobileRow(viewOf(row, personName, lookups, false, personId)))}
                </Fragment>
              );
            })}
          </Fragment>
        ))}
      </ul>
      {/* The key to the status words — a footnote under the rows, so the rows stay first in reading order. */}
      {rows.length + carriedRows.length > 0 && <StatusLegend hasLenderRows={[...rows, ...carriedRows].some((r) => /^(emi|loan)-inst:/.test(r.key))} />}
    </div>
  );
}

