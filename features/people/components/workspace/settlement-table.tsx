"use client";

import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronUp,
  CircleDashed,
  Clock,
  ExternalLink,
  CornerDownRight,
  HandCoins,
  Info,
  Eye,
  Landmark,
  Layers,
  MoreHorizontal,
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
import { Fragment, useEffect, useId, useRef, useState } from "react";
import { SplitAllocationBreakdown } from "@/components/finance/split-allocation-breakdown";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { LedgerRowHandlers } from "@/features/people/components/person-activity-feed";
import { OwnPaymentRevert } from "@/features/people/components/workspace/own-payment-revert";
import { EntryEditForm, EntrySettleForm, InlineReveal, isEditable, LoanPayLink, DELETE_BLOCK_NOTE } from "@/features/people/components/workspace/ledger-ui";
import { groupByMonth, type LedgerRow, type PaymentRecord } from "@/features/people/lib/person-ledger-rows";
import { transactionHref } from "@/features/people/lib/people-return-link";
import { REVEAL_DELAY_MS, revealBlock, useRevealWhenItGrows } from "@/features/people/lib/row-reveal";
import { compareItemsNewestFirst, type PaymentLine, type StatementBalance } from "@/features/people/lib/statement-balance";
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
  type GeneralCredit,
  type SettlementKind,
  type SettlementLookups,
  type SettlementStatusTone,
  type SettlementTone,
} from "@/features/people/lib/settlement-presentation";
import { formatStatementDate, type EmiRowStatus } from "@/lib/engines/person-cycle-statement";
import { isPaidDirectlyEntry } from "@/lib/engines/historical-reimbursement";
import { money } from "@/lib/engines/person-cycle-statement-share";
import { splitAllocation } from "@/lib/split/split-allocation";
import { cn } from "@/lib/utils";
import { useAllEmiInstallments } from "@/hooks/use-emis";
import { useEmiRows } from "@/features/emi/hooks/use-emi-data";
import { useLoanRows } from "@/features/loans/hooks/use-loans-data";
import type { Installment } from "@/lib/models/payment-schedule";
import { RecordPaymentDialog, type PaymentTarget } from "@/features/loans/components/record-payment-dialog";
import { useAllLoanInstallments } from "@/hooks/use-loans";
import { FollowUpControl, FollowUpNote } from "./follow-up";
import { canPostponeRow, DeferralControl, DeferralNote, useRowDeferral } from "./payment-deferral";

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
type StatusStyle = SettlementStatusTone | "advance" | "postponed" | "balance";

const STATUS_STYLE: Record<StatusStyle, string> = {
  due: "bg-settle-emi-badge text-settle-emi-text",
  payable: "bg-settle-emi-badge text-settle-emi-text",
  partial: "bg-card text-settle-emi-text ring-1 ring-inset ring-settle-emi-edge",
  // Done: no fill — high-contrast text, a small green check is the only success mark.
  settled: "text-foreground/85 [&>svg]:text-success",
  overdue: "bg-expense/12 text-expense ring-1 ring-inset ring-expense/25",
  upcoming: "bg-settle-carried-badge text-settle-carried-text",
  received: "text-foreground/85 [&>svg]:text-success",
  // Money you sent: same restrained form, neutral check — distinct from money received.
  paid: "text-foreground/75 [&>svg]:text-foreground/55",
  neutral: "bg-settle-carried-badge text-settle-carried-text",
  // Held advance: informational teal outline, never the success green.
  advance: "bg-settle-advance-tint text-settle-advance-text ring-1 ring-inset ring-settle-advance-edge/50",
  // Still owed, only expected later: dashed outline — never the filled green of "paid".
  postponed: "border border-dashed border-primary-accent-text/70 bg-card text-primary-accent-text",
  // Open item inside an overall balance that general payments reduced: informational outline — not "due", not "paid".
  balance: "bg-card text-settle-receivable-text ring-1 ring-inset ring-settle-receivable-edge/70",
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
  balance: Layers,
};

/**
 * The table's short status, with the money in it ("₹375 to receive", "Got ₹200 · ₹175 left"). Built on
 * `settlementStatus` (whose wording the statement / PDF keep); its sentence is kept as the hover `detail`.
 */
export function tableStatus(row: LedgerRow, kind: SettlementKind, personName: string, credit?: GeneralCredit | null): SettlementRowView["status"] {
  const base = settlementStatus(row, kind, personName, money, new Date(), null, credit);
  if (row.state == null || base.tone === "upcoming") return base;
  // Paid toward the overall balance, not this item: its own "₹X to receive" would overstate what is owed.
  if (row.state === "open" && (base.label === "Part of balance" || base.label === "Balance cleared")) return base;
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
  if (isPaidDirectlyEntry(lookups.entriesById.get(row.entryId))) return { label: "Paid directly to lender", detail: "Settled by the person paying the lender — no money came into or left your accounts", tone: "received" };
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

/**
 * One plain sentence: what this row is, and what is still owed on it. Null where the breakdown already says it.
 * `withBalance: false` leaves the "still owes ₹X" tail off — the expanded row's figures strip already shows it.
 */
export function rowExplanation(v: Pick<SettlementRowView, "row" | "kind" | "typeLabel">, personName: string, opts: { withBalance?: boolean } = {}): string | null {
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
  if (opts.withBalance === false) return what;
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
  "sticky top-0 z-[2] border-b border-border bg-secondary/95 px-3 py-2.5 text-left text-xs font-semibold whitespace-nowrap text-muted-foreground backdrop-blur";
const TD = "border-b border-border px-3 py-2 align-middle";
const NUM = "text-right tabular-nums whitespace-nowrap";

const isPaymentKind = (k: SettlementKind) => k === "paymentReceived" || k === "paymentMade" || k === "advance" || k === "advanceApplied";

/**
 * Which way CASH moved for a row, from the user's side: Money In (received / borrowed) or Money Out (given / paid).
 * Only rows where money really changed hands carry a direction — claims (shares, EMIs, opening balance, an expense
 * someone else covered, advance used) stay neutral, so direction is never confused with how far a debt is settled.
 */
export interface MoneyFlow {
  dir: "in" | "out";
  /** "Money out · Given" — the Type badge's wording on screen. */
  label: string;
  /** What the original amount is called in the amount cell ("given", "borrowed"). */
  noun: string;
}

export function flowOf(v: Pick<SettlementRowView, "kind" | "row" | "typeLabel">): MoneyFlow | null {
  const { kind, row } = v;
  if (row.recordedLoanCash) return row.recordedLoanCash.dir === "out"
    ? { dir: "out", label: "Money out · Lent", noun: "lent" }
    : { dir: "in", label: "Money in · Borrowed", noun: "borrowed" };
  const repays = row.statementRow?.settles != null;
  switch (kind) {
    case "moneyGiven":
      return { dir: "out", label: "Money out · Given", noun: "given" };
    case "moneyReceived":
      // "They paid for you" backs an expense someone else covered — no cash reached me.
      return v.typeLabel === THEY_PAID ? null : { dir: "in", label: "Money in · Borrowed", noun: "borrowed" };
    case "paymentReceived":
      return { dir: "in", label: repays ? "Money in · Received back" : "Money in · Received", noun: "received" };
    case "paymentMade":
      return { dir: "out", label: repays ? "Money out · Paid back" : "Money out · Paid", noun: "paid" };
    case "advance":
      return (row.statementRow?.advanceDelta ?? 0) > 0
        ? { dir: "out", label: "Money out · Advance given", noun: "advance given" }
        : { dir: "in", label: "Money in · Advance received", noun: "advance received" };
    default:
      return null;
  }
}

const FLOW_TONE = { in: "text-success", out: "text-expense" } as const;
/** "+₹1,000" / "−₹1,000" — the sign always comes with a colour and an arrow elsewhere in the row, never alone. */
const signedMoney = (f: MoneyFlow, n: number) => `${f.dir === "in" ? "+" : "−"}${money(n)}`;

/** The row's leading icon: a soft green ↙ (money in) / red ↗ (money out) disc, or a neutral disc with the kind's own icon. */
function FlowMark({ v, className }: { v: Pick<SettlementRowView, "kind" | "row" | "typeLabel">; className?: string }) {
  const flow = flowOf(v);
  const Icon = flow ? (flow.dir === "in" ? ArrowDownLeft : ArrowUpRight) : KIND_ICON[v.kind];
  return (
    <span
      aria-hidden
      data-flow={flow?.dir ?? "none"}
      className={cn(
        "inline-flex size-6 shrink-0 items-center justify-center rounded-full",
        flow ? (flow.dir === "in" ? "bg-success/10 text-success" : "bg-expense/10 text-expense") : "bg-secondary text-foreground/55",
        className,
      )}
    >
      <Icon className="size-3.5" strokeWidth={2.5} />
    </span>
  );
}

/** A repayment names the item it repays and what is left on it — one line, no second entry. */
function RepaysLine({ v, className }: { v: SettlementRowView; className?: string }) {
  const settles = v.row.statementRow?.settles;
  if (!settles || (v.kind !== "paymentReceived" && v.kind !== "paymentMade")) return null;
  const cleared = settles.remainingAfter < 0.005;
  return (
    <p data-testid="repays-line" className={cn("flex min-w-0 items-center gap-1 text-[11.5px] leading-tight font-medium text-foreground/75", className)}>
      <CornerDownRight className="size-3 shrink-0 text-foreground/50" aria-hidden />
      <span className="min-w-0 truncate">Repays {settles.title}</span>
      <span className={cn("shrink-0 whitespace-nowrap tabular-nums", cleared ? "font-semibold text-success" : "text-foreground/65")}>
        · {cleared ? "cleared" : `${money(settles.remainingAfter)} left`}
      </span>
    </p>
  );
}

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
  /**
   * Set when the row reads "Part of balance": payments were made toward the overall balance without choosing items, so this
   * open item isn't paid on its own. `credit` = what those general payments add up to (vs. the open items), `owed` = what is
   * still owed overall on that side. Both are the existing `GeneralCredit` figures — display only, never re-allocated.
   */
  balance?: { credit: number; owed: number } | null;
}

/** "Part of balance" — the exact wording `settlementStatus` gives an open item while general payments exist. */
const PART_OF_BALANCE = "Part of balance";

export function viewOf(row: LedgerRow, personName: string, lookups: SettlementLookups, carried = false, personId?: string): SettlementRowView {
  const kind = settlementKind(row, lookups);
  const ctx = (kind === "split" || kind === "assigned") && personId != null ? splitContext(row, lookups, personId) : null;
  const tone = settlementTone(row, kind);
  const shareLabel = row.direction === "iOwe" ? "Your share" : `${personName.split(" ")[0]}'s share`;
  const share = row.direction === "iOwe" ? row.amount : (ctx?.personShare ?? row.amount);
  const status = receivedEarlierStatus(row, kind, lookups) ?? tableStatus(row, kind, personName, lookups.generalCredit);
  const creditSide = row.direction === "theyOwe" ? lookups.generalCredit?.theyOwe : row.direction === "iOwe" ? lookups.generalCredit?.iOwe : null;
  return {
    balance: row.state === "open" && status.label === PART_OF_BALANCE && creditSide ? { credit: creditSide.credit, owed: creditSide.owed } : null,
    row,
    kind,
    family: carried ? "carried" : TONE_FAMILY[tone],
    typeFamily: TONE_FAMILY[tone],
    title: settlementTitle(row, kind, personName),
    typeLabel: tableTypeLabel(kind, row, lookups),
    relation: relationLine(row, kind, personName, money),
    status,
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

/**
 * The LENDER side of a person's Loan / EMI share row (the schedule's `amountPaid` / due date): "Bank paid", "Bank part
 * paid", "Bank overdue" or "Bank due 5 Nov". Always shown, so the row's own status ("₹1,000 to receive") is never read
 * as the bank's. Display only: the person's share stays exactly as owed — paying the bank never settles them.
 */
export function lenderChipOf(inst: { amountDue: number; amountPaid: number; dueDate: Date }, today: Date = new Date()): { label: string; title: string; tone: "paid" | "part" | "overdue" | "due" } {
  const left = Math.max(0, inst.amountDue - inst.amountPaid);
  if (left <= 0.005) return { label: "Bank paid", title: "The lender installment is fully paid. Track the person's reimbursement in People.", tone: "paid" };
  if (inst.amountPaid > 0.005) return { label: "Bank part paid", title: `${money(inst.amountPaid)} of ${money(inst.amountDue)} has been paid to the lender. Track the person's reimbursement in People.`, tone: "part" };
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
        "inline-flex shrink-0 items-center gap-1 rounded-[4px] px-1.5 text-[10.5px] leading-4 font-bold whitespace-nowrap",
        chip.tone === "paid" ? "bg-success/10 text-success" : chip.tone === "overdue" ? "bg-expense/10 text-expense" : chip.tone === "part" ? "bg-settle-carried-badge text-settle-carried-text" : "bg-secondary text-foreground/70",
      )}
    >
      {/* The bank icon marks this as the LENDER side — never the person's reimbursement. */}
      <Landmark className="size-2.5 shrink-0" strokeWidth={2.5} aria-hidden />
      {chip.label}
    </span>
  );
}

/**
 * "Bank already paid" on a Loan / EMI share row whose installment isn't fully paid to the lender: opens the existing
 * Record past payments flow for exactly that installment (the lender's own `recordedEarlier` write — no account
 * change, no new transaction, People shares untouched unless answered there). Never offered once the bank is paid.
 */
function LenderPaidMenuItem({ rowKey, onPick }: { rowKey: string; onPick: () => void }) {
  // Only Loan / EMI share rows need the schedule — no other row reads it. Mounted only while the menu is open.
  const m = /^(emi|loan)-inst:(.+)$/.exec(rowKey);
  return m ? <LenderPaidItem kind={m[1] as "emi" | "loan"} installmentId={m[2]} onPick={onPick} /> : null;
}

function LenderPaidItem({ kind, installmentId, onPick }: { kind: "emi" | "loan"; installmentId: string; onPick: () => void }) {
  const { data: emiInstallments = [] } = useAllEmiInstallments();
  const { data: loanInstallments = [] } = useAllLoanInstallments();
  const inst = (kind === "emi" ? emiInstallments : loanInstallments).find((i) => i.id === installmentId && i.deletedAt == null);
  if (!inst || inst.amountDue - inst.amountPaid <= 0.005 || inst.isSkipped) return null;
  return (
    <DropdownMenuItem
      title="You already paid this installment to the bank outside FlowFi — record it as paid (no account change)"
      onSelect={onPick}
      data-testid="row-bank-already-paid"
    >
      <Landmark strokeWidth={1.75} />
      Bank already paid
    </DropdownMenuItem>
  );
}

/** The Record past payments dialog lives outside the menu (the menu unmounts on select); mounted only once asked for. */
function LenderPaidHost({ rowKey, onClose }: { rowKey: string; onClose: () => void }) {
  const m = /^(emi|loan)-inst:(.+)$/.exec(rowKey);
  const { data: emiInstallments = [] } = useAllEmiInstallments();
  const { data: loanInstallments = [] } = useAllLoanInstallments();
  const inst = m ? (m[1] === "emi" ? emiInstallments : loanInstallments).find((i) => i.id === m[2] && i.deletedAt == null) : null;
  return m && inst ? <LenderPaidDialog kind={m[1] as "emi" | "loan"} installment={inst} onClose={onClose} /> : null;
}

/** Mounted only once asked for: finds the agreement's row and opens Record past payments on that installment. */
function LenderPaidDialog({ kind, installment, onClose }: { kind: "emi" | "loan"; installment: Installment; onClose: () => void }) {
  const { rows: emiRows } = useEmiRows();
  const { rows: loanRows } = useLoanRows();
  const emiRow = kind === "emi" ? emiRows.find((r) => r.installments.some((i) => i.id === installment.id)) : null;
  const loanRow = kind === "loan" ? loanRows.find((r) => r.installments.some((i) => i.id === installment.id)) : null;
  const target: PaymentTarget | null = emiRow ? { kind: "emi", row: emiRow, installment } : loanRow ? { kind: "loan", row: loanRow, installment } : null;
  return <RecordPaymentDialog target={target} initialView="past" preselectInstallment open={target != null} onOpenChange={(o) => !o && onClose()} />;
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
    ["Moved to Nov cycle · Postponed until 25 Nov", "Collection postponed — the amount is still owed; nothing else changes. The bank's own EMI date is separate."],
    ["Part of balance · ₹X left overall", "Payments were made toward the overall balance without choosing items. This item isn't marked paid on its own; ₹X is what is still owed overall."],
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

/** Kinds that come from an EMI / loan installment schedule. */
const isEmiKind = (k: SettlementKind) => k === "emi" || k === "loanEmi" || k === "loanInstallment";

/**
 * Split rows and money that already moved (received / paid / advance used) sit on the neutral surface — the
 * Status column carries their meaning. Open obligations, held advances and earlier-cycle rows keep their tint.
 */
function rowTint(v: SettlementRowView): string {
  return v.carried ? "bg-settle-carried-tint/45" : "bg-card";
}

/**
 * An expense assigned in full to one person whose share equals the original: "Assigned in full · Original ₹100 ·
 * DAD's share ₹100" only repeats the Amount column, so the collapsed row shows just the title.
 */
function isPlainAssignment(split: NonNullable<SettlementRowView["split"]>): boolean {
  return split.participantCount < 2 && split.original === split.share;
}

/**
 * Collapsed split context as three separate facts — "Split expense · 4 people", the purchase total and this
 * person's share — so the share is never read as the original amount. The full allocation is in the expansion.
 */
function SplitSummary({ split, className }: { split: NonNullable<SettlementRowView["split"]>; className?: string }) {
  if (isPlainAssignment(split)) return null;
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
export function TypeBadge({ kind, family, label, className, flow }: { kind: SettlementKind; family: Family; label?: string; className?: string; flow?: MoneyFlow | null }) {
  // Where cash moved, the badge says so ("Money out · Given") with a tinted outline and arrow; the text stays neutral.
  const Icon = flow ? (flow.dir === "in" ? ArrowDownLeft : ArrowUpRight) : KIND_ICON[kind];
  return (
    <span
      data-family={family}
      data-flow={flow?.dir}
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-[4px] border px-1.5 text-[10.5px] leading-none font-semibold whitespace-nowrap",
        flow
          ? cn("text-foreground/85", flow.dir === "in" ? "border-success/35 bg-success/[0.06]" : "border-expense/35 bg-expense/[0.06]")
          : isEmiKind(kind)
            ? "border-settle-emi-edge bg-settle-emi-badge text-settle-emi-text"
            : "border-border-strong/70 text-foreground/80",
        className,
      )}
    >
      <Icon className={cn("size-3", flow ? FLOW_TONE[flow.dir] : isEmiKind(kind) ? "text-settle-emi-text" : "text-foreground/55")} strokeWidth={2.25} aria-hidden />
      {flow ? flow.label : (label ?? TABLE_KIND_LABEL[kind])}
    </span>
  );
}

/** One line: icon + short label. The longer sentence is the hover title; the expansion spells it out. */
export function StatusPill({ status, kind, postponed = false, balance = false }: { status: SettlementRowView["status"]; kind?: SettlementKind; postponed?: boolean; balance?: boolean }) {
  const style: StatusStyle = postponed ? "postponed" : balance ? "balance" : kind === "advance" ? "advance" : status.tone;
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
function RowStatus({ v, showResult = false }: { v: SettlementRowView; showResult?: boolean }) {
  const deferral = useRowDeferral(v.row.key, v.row.date);
  if (showResult && v.kind === "loan") {
    return <StatusPill status={{ ...v.status, label: v.row.recordedLoanCash ? "Funding posted" : "Agreement recorded" }} kind={v.kind} />;
  }
  if (deferral?.status === "postponed" && v.row.state !== "settled") {
    const until = deferral.date ? formatStatementDate(deferral.date, true) : null;
    const detail = until ? `${v.status.label} · was due ${formatStatementDate(v.row.date, true)}` : `${v.status.label} · first due in the ${deferral.from} cycle`;
    // Part received before it was moved: what came in stays visible — the move covers only what is left.
    const full =
      v.row.state === "partial"
        ? until ? `Got ${money(v.paid ?? 0)} · rest until ${until}` : `Got ${money(v.paid ?? 0)} · rest in ${deferral.name} cycle`
        : until ? `Postponed until ${until}` : `Moved to ${deferral.name} cycle`;
    return <StatusPill status={{ ...v.status, label: "Postponed", detail: `${full}. ${detail}` }} postponed />;
  }
  // The row's completion stamp already says "Received ₹375" — Status stays short.
  if (completionLabel(v) != null) return <StatusPill status={{ ...v.status, label: showResult ? "Cleared" : "Fully paid" }} kind={v.kind} />;
  // Inside an overall balance that general payments reduced: the item isn't paid on its own — say what is owed overall.
  if (v.balance) {
    return (
      <span data-testid="balance-status">
        <StatusPill status={{ ...v.status, label: showResult ? "Overall payment" : "Partial", detail: balanceExplanation(v) }} kind={v.kind} balance />
      </span>
    );
  }
  // A part-paid item reads "Partial"; the got / left figures sit in the supporting line and the tooltip.
  if (v.row.state === "partial") return <StatusPill status={{ ...v.status, label: "Partial", detail: v.status.label }} kind={v.kind} />;
  // Untouched and not overdue: "Pending" — what is owed is in the supporting line and the tooltip.
  if (v.row.state === "open" && (v.status.tone === "due" || v.status.tone === "payable")) return <StatusPill status={{ ...v.status, label: "Pending", detail: v.status.label }} kind={v.kind} />;
  return <StatusPill status={v.status} kind={v.kind} />;
}

/** Keep an item's own remaining amount beside its status, using the statement's existing open balance. */
function HistoryResult({ v }: { v: SettlementRowView }) {
  const { row } = v;
  const outstanding = v.balance
    ? `${money(v.balance.owed)} left overall`
    : (row.state === "open" || row.state === "partial") && v.status.label !== "Balance cleared"
      ? `${money(row.remaining ?? 0)} ${row.direction === "iOwe" ? "to pay" : "to receive"}`
      : null;
  return (
    <div className="flex flex-col items-start gap-0.5">
      <RowStatus v={v} showResult />
      {outstanding && <span className="text-[11px] font-medium text-muted-foreground tabular-nums">{outstanding}</span>}
    </div>
  );
}

/**
 * Why a row reads "Part of balance", in one sentence built from the existing figures: general payments (not tied to
 * items) reduced the overall balance, this item isn't marked paid on its own, and what is still owed overall.
 */
export function balanceExplanation(v: Pick<SettlementRowView, "row" | "balance">, personName?: string): string {
  if (!v.balance) return "";
  const who = v.row.direction === "iOwe" ? "You" : personName ? personName.split(" ")[0] : "They";
  return `${who} paid ${money(v.balance.credit)} toward the overall balance without choosing items, so this item isn't marked paid on its own. ${
    v.balance.owed < 0.005 ? "Nothing is owed overall." : `${money(v.balance.owed)} is still owed overall.`
  }`;
}

/**
 * A postponed row's timeline in one line: the original due date → the revised collection cycle (or exact day) → what is
 * still owed. Display only — the live deferral and the row's own remaining.
 */
function PostponedTrail({ v, className }: { v: SettlementRowView; className?: string }) {
  const deferral = useRowDeferral(v.row.key, v.row.date);
  if (deferral?.status !== "postponed" || v.row.state === "settled") return null;
  const target = deferral.date ? formatStatementDate(deferral.date) : `${deferral.name} cycle`;
  return (
    <span data-testid="postponed-trail" title={`Collection postponed to ${deferral.range}. Still owed until it is paid — the totals don't change.`} className={cn("inline-flex min-w-0 items-center gap-1 text-[11px] leading-tight font-semibold whitespace-nowrap text-primary-accent-text tabular-nums", className)}>
      <CalendarClock className="size-3 shrink-0" aria-hidden />
      <span className="text-foreground/60 line-through decoration-dashed">Due {formatStatementDate(v.row.date)}</span>
      <ArrowRight className="size-3 shrink-0" aria-hidden />
      <span>Collect {deferral.date ? "on" : "in"} {target}</span>
      <span className="font-medium text-foreground/65">· {money(v.row.remaining ?? 0)} still owed</span>
    </span>
  );
}

/** Row date on one line. A postponed row's date is struck with a dashed line: its first due period has passed. */
function RowDate({ v, className }: { v: SettlementRowView; className?: string }) {
  const { row } = v;
  const deferral = useRowDeferral(row.key, row.date);
  const moved = deferral?.status === "postponed" && row.state !== "settled";
  // The month heading carries the year; brought-forward rows sit outside it, so they keep theirs.
  return (
    <span
      title={moved ? `First due ${formatStatementDate(row.date, true)} · ${deferral.date ? `postponed until ${formatStatementDate(deferral.date, true)}` : `moved to ${deferral.name} cycle`}` : undefined}
      className={cn("whitespace-nowrap tabular-nums", moved && "line-through decoration-primary-accent-text/80 decoration-dashed decoration-[1.5px]", className)}
    >
      {row.entryId != null && v.unknownDates.has(row.entryId) ? "Date not known" : formatStatementDate(row.date)}
      {v.carried && <span className="ml-1 text-[0.85em] font-medium text-foreground/65">{row.date.getFullYear()}</span>}
    </span>
  );
}

function Amount({ value, strong, tone, flow }: { value: number | null; strong?: boolean; tone?: string; flow?: MoneyFlow | null }) {
  if (value == null) return <span className="text-foreground/45">—</span>;
  return (
    <span
      data-flow={flow?.dir}
      className={cn("tabular-nums", strong ? "font-heading text-[14.5px] font-bold" : "text-[13px] font-semibold", flow ? FLOW_TONE[flow.dir] : (tone ?? "text-foreground"))}
    >
      {flow ? signedMoney(flow, value) : money(value)}
    </span>
  );
}

/** Remaining is the second-strongest figure; zero on a settled row reads as done, not as a number to act on. */
function RemainingAmount({ v }: { v: SettlementRowView }) {
  if (v.row.state == null) return <span className="text-foreground/45">—</span>;
  if (v.row.state === "settled") return <span className="inline-flex items-center gap-1 text-[13px] font-semibold text-foreground/65 tabular-nums"><Check className="size-3.5 text-success" strokeWidth={2.5} />{money(0)}</span>;
  // Part of an overall balance: the item's own figure is not what is owed overall — shown quietly, never as amber "due".
  if (v.balance) {
    return (
      <span title={`This item's own amount. ${balanceExplanation(v)}`}>
        <Amount value={v.row.remaining ?? 0} strong tone="text-foreground/70" />
      </span>
    );
  }
  // Still owed: pending amber (overdue red, yours to pay in its own tone) — never success green.
  const tone = v.row.overdue ? "text-expense" : v.row.direction === "iOwe" ? "text-settle-payable-text" : "text-settle-emi-text";
  return <Amount value={v.row.remaining ?? 0} strong tone={tone} />;
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
      <Amount value={row.state == null ? (v.paid ?? row.amount) : row.amount} strong flow={flowOf(v)} tone={row.state === "settled" ? "text-foreground/75" : undefined} />
    </span>
  );
}

// ---------------------------------------------------------------------------------------------------
// Expansion — the row's own reconciliation: breakdown, progress, history, source, actions
// ---------------------------------------------------------------------------------------------------

/** The cash a row moved, for the Money in / Money out columns — only where money really changed hands. */
export function cashOf(v: Pick<SettlementRowView, "kind" | "row" | "typeLabel">): { dir: "in" | "out"; amount: number } | null {
  const flow = flowOf(v);
  if (!flow) return null;
  return { dir: flow.dir, amount: v.row.amount };
}

/**
 * The row's OWN amount for the Amount column — the transaction / installment share itself, never a running balance.
 * Only where no cash moved (cash rows already read in Money in / Money out); tone follows who owes whom.
 */
function ItemAmount({ v }: { v: SettlementRowView }) {
  if (cashOf(v)) return <span className="text-foreground/25">—</span>;
  const { row } = v;
  const tone =
    row.state === "settled"
      ? "text-foreground/60"
      : row.direction === "theyOwe"
        ? "text-settle-receivable-text"
        : row.direction === "iOwe"
          ? "text-settle-payable-text"
          : "text-foreground";
  const who = row.direction === "theyOwe" ? "to receive" : row.direction === "iOwe" ? "to pay" : null;
  return (
    <span className={cn("text-[13.5px] font-semibold", tone)} title={`${v.typeLabel} · ${money(row.amount)}${who ? ` ${who}` : ""} (this item only — not a running balance)`}>
      {money(row.amount)}
    </span>
  );
}

/** Outstanding with the person after this line — one side only, never netted; "settled" once it reaches zero. */
function BalanceFigure({ b, align = "right" }: { b: StatementBalance | undefined; align?: "right" | "left" }) {
  if (!b) return <span className="text-foreground/30">—</span>;
  const settled = Math.abs(b.amount) < 0.005;
  const ahead = b.amount < -0.005;
  const tone = settled ? "text-success" : ahead ? "text-settle-advance-text" : b.side === "receivable" ? "text-settle-receivable-text" : "text-settle-payable-text";
  const word = settled ? "settled" : ahead ? "paid ahead" : b.side === "receivable" ? "owes you" : "you owe";
  return (
    <span className={cn("block", align === "right" ? "text-right" : "text-left")} data-testid="row-balance">
      <span className={cn("block font-heading text-[13.5px] leading-tight font-bold tabular-nums", tone)}>{money(Math.abs(b.amount))}</span>
      <span className="block text-[10px] leading-tight font-medium text-foreground/55">{word}</span>
    </span>
  );
}

function IconAction({ label, onClick, children, href, testId, tone }: { label: string; onClick?: () => void; children: React.ReactNode; href?: string; testId?: string; tone?: "danger" }) {
  const cls = cn(
    "flex size-7 shrink-0 items-center justify-center rounded-[8px] text-foreground/65 outline-none transition-colors hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
    tone === "danger" && "hover:bg-expense/10 hover:text-expense",
  );
  if (href) {
    return (
      <Link href={href} title={label} aria-label={label} data-testid={testId} className={cls}>
        {children}
      </Link>
    );
  }
  return (
    <button type="button" title={label} aria-label={label} data-testid={testId} onClick={onClick} className={cls}>
      {children}
    </button>
  );
}

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

/** One figure of the summary strip — label above value, so each pair reads as one unit. */
function Stat({ label, value, tone, strong }: { label: string; value: React.ReactNode; tone?: string; strong?: boolean }) {
  return (
    <div className="min-w-0 px-3 first:pl-0 last:pr-0">
      <dt title={label} className="truncate text-[11px] leading-tight font-medium text-foreground/65">
        {label}
      </dt>
      <dd className={cn("leading-snug tabular-nums", strong ? "font-heading text-[15px] font-bold" : "text-[13.5px] font-semibold", tone ?? "text-foreground")}>{value}</dd>
    </div>
  );
}

/**
 * The expanded row's money at a glance, on one line: who has to pay, what is paid, what is left — and the progress bar
 * beside them. Every figure is the row's own engine value (`row.amount`, `paidSoFar`, `row.remaining`); nothing is
 * recomputed here. A shared / assigned expense names the person's settlement, so it is never read as the whole bill.
 */
function SettlementSummary({ v, personName }: { v: SettlementRowView; personName: string }) {
  const { row, kind } = v;
  const first = personName.split(" ")[0];
  const mine = row.direction === "iOwe";
  const settled = row.state === "settled";
  const paid = v.paid ?? 0;
  const caption = kind === "split" || kind === "assigned" ? (mine ? "Your settlement" : `${first}'s settlement`) : null;
  // Still owed reads in the same pending tone as the row's Amount column (overdue red) — never success green.
  const owedTone = row.overdue ? "text-expense" : mine ? "text-settle-payable-text" : "text-settle-emi-text";
  return (
    <div data-testid="row-summary">
      {caption && <SectionLabel>{caption}</SectionLabel>}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <dl className="flex max-w-full divide-x divide-border-strong/50">
          <Stat label={mine ? "You have to pay" : `${first} has to pay`} value={money(row.amount)} />
          <Stat label={mine ? "You paid" : `${first} paid`} value={money(paid)} tone={paid > 0 ? "text-success" : undefined} />
          <Stat label="Remaining" value={settled ? "Fully paid" : money(row.remaining ?? 0)} strong tone={settled ? "text-success" : owedTone} />
        </dl>
        <Progress v={v} className="min-w-[7rem] max-w-[15rem] flex-1" />
      </div>
    </div>
  );
}

/** An EMI share's two separate statuses — the bank's installment and the person's reimbursement — as two small chips. */
function EmiStatusChips({ v, personName }: { v: SettlementRowView; personName: string }) {
  const s = v.row.statementRow;
  const deferral = useRowDeferral(v.row.key, v.row.date);
  if ((v.kind !== "emi" && v.kind !== "loanEmi") || !s?.emi) return null;
  const first = personName.split(" ")[0];
  const postponed = deferral?.status === "postponed" && v.row.state !== "settled";
  // The person's side in plain words — a postponed share is "not paid yet", never mistaken for "Part of balance" or "paid".
  const reimbursement = postponed
    ? `Not paid yet · moved to ${deferral.date ? formatStatementDate(deferral.date) : `${deferral.name} cycle`}`
    : v.balance
      ? `Not paid on its own · ${money(v.balance.owed)} left overall`
      : v.status.label;
  return (
    <div className="flex flex-wrap gap-1.5 text-[11.5px]" data-testid="emi-status-chips">
      <span className="inline-flex items-center gap-1 rounded-full border border-border-strong/70 px-2 py-0.5">
        <Landmark className="size-3 text-foreground/55" strokeWidth={2} aria-hidden />
        <span className="text-foreground/65">Bank EMI</span>
        <span className={cn("font-semibold", s.emi.status === "overdue" ? "text-expense" : "text-foreground")}>{BANK_STATUS[s.emi.status]}</span>
      </span>
      <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5", postponed ? "border-dashed border-primary-accent-text/60" : "border-border-strong/70")}>
        <HandCoins className="size-3 text-foreground/55" strokeWidth={2} aria-hidden />
        <span className="text-foreground/65">{first}&apos;s reimbursement</span>
        <span className="font-semibold text-foreground">{reimbursement}</span>
      </span>
    </div>
  );
}

/**
 * One short context line in the expanded row, only where the status needs it: why an item reads "Part of balance", or a
 * postponed share's original date → revised collection → still owed. Paying the bank is never treated as their payment.
 */
function RowContextNote({ v, personName }: { v: SettlementRowView; personName: string }) {
  const deferral = useRowDeferral(v.row.key, v.row.date);
  const first = personName.split(" ")[0];
  const postponed = deferral?.status === "postponed" && v.row.state !== "settled";
  if (!postponed && !v.balance) return null;
  const isEmi = v.kind === "emi" || v.kind === "loanEmi";
  return (
    <p data-testid="row-context-note" className="flex items-start gap-1.5 rounded-[6px] bg-secondary/70 px-2 py-1 text-[11.5px] leading-snug text-foreground/80">
      <Info className="mt-px size-3.5 shrink-0 text-foreground/55" aria-hidden />
      <span>
        {postponed ? (
          <>
            Was due <b className="font-semibold text-foreground">{formatStatementDate(v.row.date, true)}</b> · now expected{" "}
            <b className="font-semibold text-foreground">{deferral.date ? `on ${formatStatementDate(deferral.date, true)}` : `in the ${deferral.name} cycle (${deferral.range})`}</b> ·{" "}
            <b className="font-semibold text-foreground">{money(v.row.remaining ?? 0)}</b> stays owed until {v.row.direction === "iOwe" ? "you pay" : `${first} pays`}.
          </>
        ) : (
          balanceExplanation(v, personName)
        )}
        {isEmi && " Paying the bank is separate — it never counts as their payment to you."}
      </span>
    </p>
  );
}

/**
 * Rows with no remaining balance of their own — a payment, an advance. (Obligations use `SettlementSummary`; an EMI's
 * installment facts live under "More details".)
 */
function Breakdown({ v, personName }: { v: SettlementRowView; personName: string }) {
  const { row, kind } = v;
  const s = row.statementRow;
  const first = personName.split(" ")[0];
  if (kind === "advance") {
    const theirs = (s?.advanceDelta ?? 0) < 0;
    return (
      <dl className="max-w-md text-[13px]">
        <Line label={theirs ? `${first} paid you ahead` : `You paid ${first} ahead`} value={money(row.amount)} strong />
        <p className="mt-1 text-[12px] text-foreground/75">
          Held as advance — not part of what is pending. It is used when applied to {theirs ? `${first}'s` : "your"} next obligations.
        </p>
      </dl>
    );
  }
  if (kind === "paymentReceived" || kind === "paymentMade" || kind === "advanceApplied") {
    return (
      <dl className="max-w-md text-[13px]">
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
    <dl className="max-w-md text-[13px]">
      <Line label="Amount" value={money(row.amount)} />
    </dl>
  );
}

function Progress({ v, className }: { v: SettlementRowView; className?: string }) {
  const { row } = v;
  if (row.state == null || row.amount <= 0) return null;
  const paid = v.paid ?? 0;
  const pct = Math.min(100, Math.max(0, (paid / row.amount) * 100));
  const bar = row.state === "settled" ? "bg-success" : row.overdue ? "bg-expense" : row.state === "partial" ? "bg-settle-emi-edge" : "bg-foreground/30";
  return (
    <div aria-label="Payment progress" className={cn("flex items-center gap-2", className)}>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-border-strong/45" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
        <div className={cn("h-full rounded-full transition-[width]", bar)} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-9 text-right text-[12px] font-bold text-foreground tabular-nums">{Math.round(pct)}%</span>
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

/**
 * "Original transaction information" for the details section: what this row is made of (EMI / installment, date, source
 * cycle, when it was recorded, its reference) as aligned label–value pairs. Nothing here is an action.
 */
function DetailFacts({ v, cycleLabelOf }: { v: SettlementRowView; cycleLabelOf?: (d: Date) => string }) {
  const { row, kind } = v;
  const s = row.statementRow;
  const ref = row.entryId ?? row.key.split(":").pop() ?? row.key;
  const facts: [string, React.ReactNode][] = [];
  if ((kind === "emi" || kind === "loanEmi") && s?.emi) {
    facts.push([kind === "loanEmi" ? "Loan" : "EMI", s.emi.sourceName], ["Installment", `#${s.emi.installmentNumber}`]);
  } else if (kind === "loanInstallment" && s?.loan) {
    facts.push(["Installment", `${s.loan.installmentNumber} of ${s.loan.installmentCount}`]);
  }
  facts.push([isEmiKind(kind) ? "Due" : "Date", formatStatementDate(row.date, true)]);
  if (v.carried && cycleLabelOf) facts.push(["From cycle", cycleLabelOf(row.date)]);
  if (row.entryId && formatStatementDate(row.createdAt, true) !== formatStatementDate(row.date, true)) facts.push(["Recorded", formatStatementDate(row.createdAt, true)]);
  facts.push(["Ref", <span key="ref" className="font-mono text-[11px]">#{ref.slice(0, 8)}</span>]);
  return (
    <div className="min-w-0 text-[12.5px]" data-testid="row-facts">
      <SectionLabel>Transaction</SectionLabel>
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-0.5">
        {facts.map(([label, value]) => (
          <Fragment key={label}>
            <dt className="text-foreground/65">{label}</dt>
            <dd className="min-w-0 truncate font-semibold text-foreground">{value}</dd>
          </Fragment>
        ))}
      </dl>
      {!row.deletable && row.deleteBlock && (
        <p className="mt-1.5 text-[11.5px] text-foreground/70">
          {row.deleteBlock === "expense" && v.kind === "assigned" ? "Part of an assigned expense — change it from the expense" : DELETE_BLOCK_NOTE[row.deleteBlock]}
        </p>
      )}
    </div>
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

/** A Loan installment row is paid from its Loan ("Pay" link), never through Record payment. */
const isLoanPay = (row: LedgerRow) => row.category === "loan" && row.loanId != null && row.state != null && row.state !== "settled";

/**
 * True when the row's own "Record payment" button is on screen. It opens the very flow a postponed row's "Received"
 * shortcut opens (`openPayment({ preselectKey })`), so the expansion shows only one of them.
 */
function recordActionShown(row: LedgerRow, lookups: SettlementLookups): boolean {
  return !isLoanPay(row) && row.settle != null && !sourceUnavailable(row, lookups);
}

/**
 * A row's actions, kept compact: the one primary action (Record / Pay) stays visible; everything else lives in a
 * "⋯" menu — View details, Edit, Already received, Bank already paid, Open source, Delete (last, in red). Only the
 * actions this row really supports are offered. Delete only asks: the workspace's confirmation dialog does the rest.
 */
function RowActionButtons({
  v,
  handlers,
  lookups,
  compact = false,
  detailsOpen,
  onToggleDetails,
}: {
  v: SettlementRowView;
  handlers: LedgerRowHandlers;
  lookups: SettlementLookups;
  compact?: boolean;
  /** Table rows only: the menu's "View details" toggles the row's expansion (the expansion itself has no such item). */
  detailsOpen?: boolean;
  onToggleDetails?: () => void;
}) {
  const { row } = v;
  const [lenderOpen, setLenderOpen] = useState(false);
  const source = sourceLink(row, lookups);
  const unavailable = sourceUnavailable(row, lookups);
  const settling = handlers.settlingKey === row.key;
  const editing = handlers.editingKey === row.key;
  const loanPay = isLoanPay(row);
  const canReceivedEarlier = row.settle != null && !loanPay && row.direction !== "iOwe" && !unavailable && row.state !== "settled";
  const canEdit = isEditable(row) && handlers.onEditStart != null;
  const canDelete = row.deletable && handlers.onDelete != null;
  const hasLender = /^(emi|loan)-inst:/.test(row.key);
  const menuSource = source != null && !loanPay;
  const hasMenu = onToggleDetails != null || canReceivedEarlier || canEdit || canDelete || hasLender || menuSource;

  return (
    <div className={cn("flex items-center", compact ? "flex-nowrap justify-end gap-1" : "flex-wrap gap-1.5")} onClick={(e) => e.stopPropagation()}>
      {loanPay ? (
        <LoanPayLink loanId={row.loanId!} />
      ) : row.settle && !unavailable ? (
        <button
          type="button"
          aria-pressed={settling}
          title={row.state === "partial" ? "Record a payment for the rest of this item" : "Record a payment against this item"}
          onClick={() => (settling ? handlers.onSettleCancel() : handlers.onSettleStart(row))}
          className={cn(ACTION_BTN, "h-7 rounded-full px-2.5", settling ? "border-primary-accent-text bg-primary/20 text-foreground" : "border-primary-accent-text/60 bg-primary/10 text-foreground hover:bg-primary/25")}
        >
          <HandCoins className="size-3.5 text-primary-accent-text" strokeWidth={2} />
          {compact ? "Record" : row.state === "partial" ? "Record rest" : "Record payment"}
        </button>
      ) : null}
      {compact && (
        <span className="hidden items-center gap-0.5 2xl:flex">
          {onToggleDetails && (
            <IconAction label={detailsOpen ? "Hide details" : "View details"} onClick={onToggleDetails} testId="row-action-details">
              <Eye className="size-4" strokeWidth={1.75} />
            </IconAction>
          )}
          {canEdit && (
            <IconAction label={`Edit ${v.title}`} onClick={() => (editing ? handlers.onEditCancel?.() : handlers.onEditStart!(row))} testId="row-action-edit">
              <Pencil className="size-4" strokeWidth={1.75} />
            </IconAction>
          )}
          {canPostponeRow(row) && handlers.onPostpone && !unavailable && (
            <IconAction label="Postpone the due date" onClick={() => handlers.onPostpone!(row)} testId="row-action-postpone">
              <CalendarClock className="size-4" strokeWidth={1.75} />
            </IconAction>
          )}
          {row.ownPayment?.undo != null && handlers.onUndoPayment && (
            <IconAction label="Revert this payment" onClick={() => handlers.onUndoPayment!(row, row.ownPayment!)} testId="row-action-revert" tone="danger">
              <Undo2 className="size-4" strokeWidth={1.75} />
            </IconAction>
          )}
          {menuSource && source && (
            <IconAction label={source.label} href={source.href} testId="row-action-open">
              <ExternalLink className="size-4" strokeWidth={1.75} />
            </IconAction>
          )}
        </span>
      )}
      {unavailable && (
        <span className="text-[12px] text-muted-foreground" title="Its source transaction was deleted. Reverse the payment recorded against it to clear this entry.">
          Original transaction is no longer available
          {(row.payments.length > 0 || row.state === "partial" || row.state === "settled") && " · repair blocked — payment history exists"}
        </span>
      )}
      {hasMenu && (
        // Non-modal: Delete opens a confirmation dialog right after the menu closes — a modal menu would fight it for focus.
        <DropdownMenu modal={false}>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={`More actions for ${v.title}`}
                  data-testid="row-more-actions"
                  className="flex size-7 shrink-0 items-center justify-center rounded-full text-foreground/60 outline-none transition-colors hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-secondary data-[state=open]:text-foreground"
                >
                  <MoreHorizontal className="size-4" strokeWidth={2} />
                </button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="top">More actions</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end" className="min-w-48 text-[13px]">
            {onToggleDetails && (
              <DropdownMenuItem onSelect={onToggleDetails} data-testid="row-view-details">
                <Eye strokeWidth={1.75} />
                {detailsOpen ? "Hide details" : "View details"}
              </DropdownMenuItem>
            )}
            {canEdit && (
              <DropdownMenuItem
                aria-label={`Edit ${v.title}`}
                onSelect={() => (editing ? handlers.onEditCancel?.() : handlers.onEditStart!(row))}
                data-testid="row-edit"
              >
                <Pencil strokeWidth={1.75} />
                Edit
              </DropdownMenuItem>
            )}
            {canReceivedEarlier && (
              <DropdownMenuItem
                title="They already paid you outside FlowFi and it is already in your balance — lowers what they owe, no account change"
                onSelect={() => handlers.onSettleStart(row, { alreadyReceived: true })}
                data-testid="row-already-received"
              >
                <Check strokeWidth={1.75} />
                Already received
              </DropdownMenuItem>
            )}
            {hasLender && <LenderPaidMenuItem rowKey={row.key} onPick={() => setLenderOpen(true)} />}
            {menuSource && source && (
              <DropdownMenuItem asChild>
                <Link href={source.href} title={`Edit or delete it where it comes from — ${source.label.replace("Open ", "the ")}`}>
                  <ExternalLink strokeWidth={1.75} />
                  {source.label}
                </Link>
              </DropdownMenuItem>
            )}
            {canDelete && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" aria-label={`Delete ${v.title}`} onSelect={() => handlers.onDelete!(row)} data-testid="row-delete">
                  <Trash2 strokeWidth={1.75} />
                  Delete
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {lenderOpen && <LenderPaidHost rowKey={row.key} onClose={() => setLenderOpen(false)} />}
    </div>
  );
}

/** Wraps whatever the expansion shows (card, edit form, payment form) so a panel the user just made taller stays in view. */
function RevealFrame({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useRevealWhenItGrows(ref);
  return <div ref={ref}>{children}</div>;
}

const FOOTER_BTN =
  "inline-flex h-6 items-center gap-1 rounded-[5px] px-1.5 text-[12px] font-semibold whitespace-nowrap text-foreground/70 outline-none transition-colors hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring";

interface ExpansionProps {
  v: SettlementRowView;
  personId: string;
  personName: string;
  lookups: SettlementLookups;
  accountForEntry: (id: string | null) => string | null;
  handlers: LedgerRowHandlers;
  cycleLabelOf?: (d: Date) => string;
  /** Collapses this row from inside the panel — so a tall panel never needs a scroll back up to its row. */
  onCollapse?: () => void;
}

/**
 * The expanded row — a natural extension of the row above it. By default: what it is (title, type, date, who it is
 * with), the money at a glance, the one primary action, and the payment timing. Everything else — the split of the
 * bill's split (who took part, each share) stays visible; payment history, the transaction's own facts and the
 * reminder sit behind one "More details" toggle.
 * Every figure and handler is the row's existing one; this component only arranges them.
 */
function Expansion(props: ExpansionProps) {
  const { v, handlers } = props;
  const { row } = v;
  let body: React.ReactNode;
  if (handlers.editingKey === row.key && handlers.onEditSubmit) {
    body = <EntryEditForm row={row} onCancel={() => handlers.onEditCancel?.()} onSubmit={(values) => handlers.onEditSubmit!(row, values)} />;
  } else if (handlers.settlingKey === row.key) {
    body = (
      <div className="max-w-2xl">
        <EntrySettleForm row={row} personName={props.personName} onCancel={handlers.onSettleCancel} onSubmit={(values) => handlers.onSettleSubmit(row, values)} />
      </div>
    );
  } else {
    body = <ExpansionCard {...props} />;
  }
  return <RevealFrame>{body}</RevealFrame>;
}

function ExpansionCard({ v, personId, personName, lookups, accountForEntry, handlers, cycleLabelOf, onCollapse }: ExpansionProps) {
  const { row } = v;
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsId = useId();
  const onUndo = handlers.onUndoPayment ? (p: PaymentRecord) => handlers.onUndoPayment!(row, p) : undefined;
  const onEditPayment = handlers.onEditPayment
    ? (p: PaymentRecord) => (handlers.editablePayment?.(p) ? () => handlers.onEditPayment!(p) : null)
    : undefined;
  const allocation = v.kind === "split" || v.kind === "assigned" ? splitAllocation(linkedExpense(row, lookups), personId) : null;
  const explanation = rowExplanation(v, personName, { withBalance: false });
  const paymentCount = row.payments.length;
  const hint = paymentCount > 0 ? `${paymentCount} ${paymentCount === 1 ? "payment" : "payments"}` : null;
  return (
    <div data-testid="row-expansion" className={cn("rounded-xl border border-l-[3px] border-border bg-card shadow-e1", FAMILY[v.family].edge)}>
      {/* What it is + the one primary action. The full description wraps here — the collapsed row only truncates it. */}
      <div className="flex flex-wrap items-start justify-between gap-3 px-3 pt-3 sm:px-4">
        {/* basis-48: on a narrow screen the action drops below the title instead of squeezing it into a column. */}
        <div className="min-w-0 flex-1 basis-48">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
            <h3 className="min-w-0 font-heading text-base leading-snug font-semibold break-words text-foreground">{v.title}</h3>
            <TypeBadge kind={v.kind} family={v.typeFamily} label={v.typeLabel} flow={flowOf(v)} />
          </div>
          <p className="mt-0.5 text-[12px] leading-snug text-foreground/75" data-testid="row-explanation">
            <span className="whitespace-nowrap tabular-nums">{formatStatementDate(row.date, true)}</span>
            {explanation && <> · {explanation}</>}
          </p>
        </div>
        <RowActionButtons v={v} handlers={handlers} lookups={lookups} />
      </div>

      {/* The money at a glance. */}
      <div className="space-y-2 px-3 py-3 sm:px-4">
        {row.state != null && !isPaymentKind(v.kind) ? <SettlementSummary v={v} personName={personName} /> : <Breakdown v={v} personName={personName} />}
        <EmiStatusChips v={v} personName={personName} />
        <RowContextNote v={v} personName={personName} />
        <OwnPaymentRevert row={row} onUndo={onUndo} onEdit={onEditPayment} />
        {allocation && (
          // Who took part and each stored share — visible as soon as the row opens, separate from the settlement above.
          <div data-testid="row-split-details">
            <SectionLabel>Split details</SectionLabel>
            <SplitAllocationBreakdown allocation={allocation} focusName={personName} className="max-w-4xl" />
          </div>
        )}
      </div>

      {/* Payment timing (only where it applies) and the two disclosure controls share one quiet line. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-b-xl border-t border-border bg-secondary/30 px-3 py-1.5 sm:px-4">
        <DeferralControl row={row} title={v.title} compact hideReceived={recordActionShown(row, lookups)} />
        <div className="ml-auto flex items-center gap-0.5">
          <button type="button" aria-expanded={detailsOpen} aria-controls={detailsId} onClick={() => setDetailsOpen((o) => !o)} className={FOOTER_BTN} data-testid="row-more-details">
            <ChevronDown className={cn("size-3.5 transition-transform", detailsOpen && "rotate-180")} aria-hidden />
            {detailsOpen ? "Fewer details" : "More details"}
            {!detailsOpen && hint && <span className="font-medium text-foreground/55">· {hint}</span>}
          </button>
          {onCollapse && (
            <button type="button" onClick={onCollapse} aria-label={`Collapse ${v.title}`} title="Collapse this row" className={FOOTER_BTN} data-testid="row-collapse">
              <ChevronUp className="size-3.5" aria-hidden />
              <span className="hidden sm:inline">Collapse</span>
            </button>
          )}
        </div>
      </div>

      {detailsOpen && (
        <div id={detailsId} data-testid="row-details" className="space-y-3 border-t border-border px-3 py-3 duration-150 animate-in fade-in-0 motion-reduce:animate-none sm:px-4">
          <div className="grid gap-x-8 gap-y-3 md:grid-cols-2">
            <DetailFacts v={v} cycleLabelOf={cycleLabelOf} />
            <div className="min-w-0 space-y-3">
              <Payments v={v} personName={personName} accountForEntry={accountForEntry} onUndo={onUndo} onEdit={onEditPayment} />
              <FollowUpControl rowKey={row.key} title={v.title} open={row.state === "open" || row.state === "partial"} />
            </div>
          </div>
        </div>
      )}
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
  /** Payments recorded against an obligation, listed as their own statement lines. */
  paymentLines?: readonly PaymentLine[];
  /** Running outstanding balance after every line, by line key. */
  balances?: ReadonlyMap<string, StatementBalance>;
  compactDesktop?: boolean;
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

export function SettlementTable({ personId, personName, rows, carriedRows = [], isLoading, lookups, accountForEntry, handlers, empty, cycleLabelOf, className, linkedTrail, paymentLines = [], balances, compactDesktop = false }: SettlementTableProps) {
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

  // After a row opens or closes: once its height animation has settled, bring the row (and its panel) into comfortable
  // view — only if it is not already — across the table's own scroll area and the page. Closing scrolls the row back
  // into view when a tall panel had pushed it off the top. Display-only; never touches data.
  const revealTimers = useRef<number[]>([]);
  useEffect(() => {
    const timers = revealTimers.current;
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, []);
  const scheduleReveal = (key: string) => {
    if (typeof window === "undefined") return;
    revealTimers.current.push(
      window.setTimeout(() => {
        const el = [...document.querySelectorAll<HTMLElement>("[data-obligation-key]")].find((n) => n.getAttribute("data-obligation-key") === key && n.offsetParent != null);
        if (!el) return;
        // Desktop: the row's panel is the next table row; phone: the list item already contains it.
        revealBlock(el, el.tagName === "TR" ? ((el.nextElementSibling as HTMLElement | null) ?? el) : el);
      }, REVEAL_DELAY_MS),
    );
  };

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
  if (rows.length === 0 && carriedRows.length === 0 && paymentLines.length === 0) return <>{empty}</>;

  const toggle = (row: LedgerRow) => {
    if (handlers.settlingKey === row.key) handlers.onSettleCancel();
    if (handlers.editingKey === row.key) handlers.onEditCancel?.();
    setOpenKey((k) => (k === row.key ? null : row.key));
    scheduleReveal(row.key);
  };
  const isOpen = (row: LedgerRow) => openKey === row.key || handlers.settlingKey === row.key || handlers.editingKey === row.key;

  // One chronological, newest-first list: an earlier cycle's unpaid item sits under its own month between the
  // current months (never in a separate block on top, which read Oct → Sep → Nov). It keeps its "Previous unpaid"
  // chip, "From <cycle>" line and tint, so it is still told apart at a glance.
  type Entry = { kind: "row"; row: LedgerRow; carried: boolean } | { kind: "pay"; line: PaymentLine };
  const merged: Entry[] = [
    ...carriedRows.map((row): Entry => ({ kind: "row", row, carried: true })),
    ...rows.map((row): Entry => ({ kind: "row", row, carried: false })),
    ...paymentLines.map((line): Entry => ({ kind: "pay", line })),
  ].sort((a, b) =>
    compareItemsNewestFirst(
      a.kind === "row" ? { kind: "row", row: a.row } : { kind: "pay", line: a.line },
      b.kind === "row" ? { kind: "row", row: b.row } : { kind: "pay", line: b.line },
    ),
  );
  const groups = groupByMonth(merged, (t) => (t.kind === "row" ? t.row.date : t.line.payment.date));
  type GroupItem = FoldItem | { kind: "carried"; row: LedgerRow } | { kind: "pay"; line: PaymentLine };
  /** A month's items in order: brought-forward rows stand alone; consecutive current rows may fold into one payment line. */
  const itemsOf = (g: { rows: { row: Entry }[] }): GroupItem[] => {
    const out: GroupItem[] = [];
    let batch: LedgerRow[] = [];
    const flush = () => {
      out.push(...foldPaymentRows(batch));
      batch = [];
    };
    for (const { row: t } of g.rows) {
      if (t.kind === "pay") {
        flush();
        out.push({ kind: "pay", line: t.line });
      } else if (t.carried) {
        flush();
        out.push({ kind: "carried", row: t.row });
      } else batch.push(t.row);
    }
    flush();
    return out;
  };
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

  const first = personName.split(" ")[0];
  const payTitle = (p: PaymentRecord) => p.source === "advance" ? "Advance applied" : p.direction === "youPaid"
    ? (compactDesktop ? `Paid back to ${first}` : `Payment to ${first}`)
    : (compactDesktop ? `Received back from ${first}` : `Payment from ${first}`);
  const payLeft = (l: PaymentLine) => (l.payment.remainingAfter < 0.005 ? "Cleared this item" : `${money(l.payment.remainingAfter)} left on this item`);
  const columnCount = compactDesktop ? 6 : 7;
  const cell = cn(TD, compactDesktop && "py-1.5");
  const cashCells = (cash: ReturnType<typeof cashOf>) => compactDesktop ? (
    <td className={cn(cell, NUM, "w-[7rem]")}>
      {cash ? (
        <span title={cash.dir === "in" ? "Money in" : "Money out"} className={cn("text-[13px] font-semibold", cash.dir === "in" ? "text-success" : "text-expense")}>
          {cash.dir === "in" ? "+" : "−"}{money(cash.amount)}
        </span>
      ) : <span className="text-muted-foreground/45">—</span>}
    </td>
  ) : (
    <>
      <td className={cn(cell, NUM, "w-[6rem]")}>{cash?.dir === "in" ? <span className="text-[13.5px] font-semibold text-success">{money(cash.amount)}</span> : <span className="text-foreground/25">—</span>}</td>
      <td className={cn(cell, NUM, "w-[6rem]")}>{cash?.dir === "out" ? <span className="text-[13.5px] font-semibold text-expense">{money(cash.amount)}</span> : <span className="text-foreground/25">—</span>}</td>
    </>
  );
  const payActions = (l: PaymentLine) => {
    const p = l.payment;
    const edit = handlers.editablePayment?.(p) && handlers.onEditPayment ? () => handlers.onEditPayment!(p) : null;
    return (
      <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
        {edit && (
          <button type="button" onClick={edit} title="Edit this payment" className="flex h-6 items-center gap-1 rounded-[6px] px-1.5 text-[11.5px] font-semibold text-foreground/70 outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
            <Pencil className="size-3.5" strokeWidth={1.75} />
            Edit
          </button>
        )}
        {p.undo && handlers.onUndoPayment ? (
          <button type="button" onClick={() => handlers.onUndoPayment!(l.parent, p)} title={p.undo.kind === "payment" ? "Revert this payment" : "Undo this payment"} className="flex h-6 items-center gap-1 rounded-[6px] px-1.5 text-[11.5px] font-semibold text-foreground/70 outline-none hover:bg-expense/10 hover:text-expense focus-visible:ring-2 focus-visible:ring-ring">
            <Undo2 className="size-3.5" strokeWidth={1.75} />
            {p.undo.kind === "payment" ? "Revert" : "Undo"}
          </button>
        ) : p.undoBlock ? (
          <span title={p.undoBlock} className="text-foreground/50">
            <Info className="size-3.5" aria-hidden />
          </span>
        ) : null}
      </div>
    );
  };
  const payRow = (l: PaymentLine) => {
    const p = l.payment;
    const inbound = p.direction === "theyPaid";
    const cash = p.source === "cash";
    const Icon = inbound ? ArrowDownLeft : ArrowUpRight;
    const entry = p.entryId ? lookups.entriesById.get(p.entryId) : null;
    const date = entry?.receivedDateKnown === false ? "Date not known" : formatStatementDate(p.date);
    const account = cash ? accountForEntry(p.entryId) : null;
    const direct = isPaidDirectlyEntry(entry);
    const paymentSource = direct ? "Paid directly to lender · no account change" : entry?.recordedEarlier ? "Recorded earlier · no account change" : account ? `${inbound ? "To" : "From"} ${account}` : l.parent.category === "loan" ? "Recorded in Loan & EMI" : null;
    return (
      <tr key={`pay:${l.key}`} data-payment-line={l.key} className="transition-colors duration-150 hover:bg-secondary/45">
        <td className={cn(cell, "w-[5rem]")}>
          <span className="text-[13px] leading-tight font-medium text-foreground/80 tabular-nums">{date}</span>
        </td>
        <td className={cn(cell, "w-full max-w-0")}>
          <div className="flex min-w-0 items-center gap-2">
            <span aria-hidden className={cn("inline-flex size-6 shrink-0 items-center justify-center rounded-full", cash ? (inbound ? "bg-success/10 text-success" : "bg-expense/10 text-expense") : "bg-settle-advance-tint text-settle-advance-text")}>
              <Icon className="size-3.5" strokeWidth={2.25} />
            </span>
            <div className={cn("min-w-0", !compactDesktop && "flex items-baseline gap-2")}>
              <p className="truncate text-[13.5px] leading-tight font-semibold text-foreground">{direct ? "Paid directly to lender" : compactDesktop && entry?.recordedEarlier ? "Earlier repayment" : payTitle(p)}</p>
              <p className="min-w-0 truncate text-[11.5px] leading-tight text-muted-foreground" title={`Applied to ${l.parent.title}${paymentSource ? ` · ${paymentSource}` : ""}`}>
                Applied to {l.parent.title}{compactDesktop ? (paymentSource ? ` · ${paymentSource}` : "") : ` · ${payLeft(l)}`}
              </p>
            </div>
          </div>
        </td>
        {cashCells(cash ? { dir: inbound ? "in" : "out", amount: p.amount } : null)}
        <td className={cn(cell, NUM, "w-[6.5rem]")}>{cash ? <span className="text-foreground/25">—</span> : <span className="text-[13.5px] font-semibold text-settle-advance-text" title="Advance applied — no cash moved">{money(p.amount)}</span>}</td>
        <td className={cn(cell, compactDesktop ? "w-[9.5rem]" : "w-[8rem]")}>
          <span className="inline-flex h-5 items-center gap-1 rounded-full bg-success/10 px-2 text-[11px] leading-none font-semibold whitespace-nowrap text-success">
            {cash ? (direct ? "Settled directly" : compactDesktop && entry?.recordedEarlier ? "Recorded earlier" : inbound ? "Received" : "Paid") : "Advance used"}
          </span>
          {compactDesktop && <span className={cn("mt-0.5 block text-[11px] font-medium tabular-nums", p.remainingAfter < 0.005 ? "text-success" : "text-muted-foreground")}>{payLeft(l)}</span>}
        </td>
        <td className={cn(cell, "w-[9rem] py-0.5 2xl:w-[15rem]")}>{payActions(l)}</td>
      </tr>
    );
  };
  const mobilePayRow = (l: PaymentLine) => {
    const p = l.payment;
    const inbound = p.direction === "theyPaid";
    const cash = p.source === "cash";
    return (
      <li key={`pay:${l.key}`} data-payment-line={l.key} className={cn("border-b border-l-[4px] border-b-border-strong/55 bg-secondary/15 px-3 py-1.5", cash ? (inbound ? "border-l-success/55" : "border-l-expense/55") : "border-l-settle-advance-edge/60")}>
        <div className="flex items-baseline justify-between gap-3">
          <p className="flex min-w-0 items-center gap-1.5 text-[13.5px] leading-snug font-semibold text-foreground">
            <CornerDownRight className="size-3.5 shrink-0 text-foreground/35" aria-hidden />
            <span className="truncate">{payTitle(p)}</span>
          </p>
          <span className={cn("shrink-0 text-[13.5px] font-semibold tabular-nums", cash ? (inbound ? "text-success" : "text-expense") : "text-settle-advance-text")}>
            {cash ? (inbound ? "+" : "−") : ""}
            {money(p.amount)}
          </span>
        </div>
        <p className="mt-0.5 truncate text-[11.5px] font-medium text-foreground/70">
          {formatStatementDate(p.date)} · Applied to {l.parent.title} · {payLeft(l)}
        </p>
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <span className="flex items-baseline gap-1 text-[11px] text-foreground/60">
            <span>Balance</span>
            <BalanceFigure b={balances?.get(l.key)} align="left" />
          </span>
          {payActions(l)}
        </div>
      </li>
    );
  };

  /** The row's one supporting line: type · amount · relation, plus what is paid / left — kept short, details live in the row's panel. */
  const supportingText = (v: SettlementRowView) => {
    const { row } = v;
    const obligation = row.state != null;
    // The item's amount has its own column and a running balance is not shown here — only what this line IS, and, for a
    // part-paid item, its own paid / left split.
    const typeAlreadyInTitle = compactDesktop && v.title.toLowerCase().endsWith(v.typeLabel.toLowerCase());
    const head = [v.carried && cycleLabelOf ? `From ${cycleLabelOf(row.date)}` : null, typeAlreadyInTitle ? null : v.typeLabel].filter(Boolean).join(" · ");
    const progress = obligation && !v.balance && row.state === "partial" ? `${money(v.paid ?? 0)} paid · ${money(row.remaining ?? 0)} left` : null;
    return [head, v.relation, progress].filter(Boolean).join(" · ");
  };
  /** Only the figure that matters stays on the row (part paid · left); the descriptive sentence is a hover tooltip. */
  const progressText = (v: SettlementRowView) =>
    v.row.state != null && !v.balance && v.row.state === "partial" ? `${money(v.paid ?? 0)} paid · ${money(v.row.remaining ?? 0)} left` : "";

  const desktopRow = (v: SettlementRowView) => {
    const { row } = v;
    const open = isOpen(row);
    const fam = FAMILY[v.family];
    const muted = row.state === "settled";
    const cash = cashOf(v);
    const hasRepaymentNote = v.row.statementRow?.settles && (v.kind === "paymentReceived" || v.kind === "paymentMade");
    const account = row.recordedLoanCash?.account ?? accountForEntry(row.entryId);
    const earlier = row.entryId ? lookups.entriesById.get(row.entryId)?.recordedEarlier : false;
    const source = earlier ? "Recorded earlier · no account change" : cash && account ? `${cash.dir === "in" ? "To" : "From"} ${account}` : null;
    const cashLabel = cash && flowOf(v)?.noun;
    const installment = row.statementRow?.emi?.installmentNumber ?? row.statementRow?.loan?.installmentNumber;
    const supporting = compactDesktop ? [
      v.carried && cycleLabelOf ? `From ${cycleLabelOf(row.date)}` : null,
      installment != null ? `Installment #${installment}` : null,
      cashLabel ? cashLabel.charAt(0).toUpperCase() + cashLabel.slice(1) : v.title.toLowerCase().endsWith(v.typeLabel.toLowerCase()) ? null : v.typeLabel,
      source,
      row.key.startsWith("loan:") && !row.recordedLoanCash ? "Agreement amount" : null,
      v.kind === "paymentReceived" || v.kind === "paymentMade" ? (hasRepaymentNote ? null : "Toward overall balance") : null,
      row.state === "partial" && !v.balance ? `${money(v.paid ?? 0)} ${row.direction === "iOwe" ? "paid" : "received"} so far` : null,
    ].filter(Boolean).join(" · ") : supportingText(v);
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
          className={cn("group cursor-pointer transition-colors duration-150", rowTint(v), "hover:bg-secondary/55 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring", open && "bg-secondary/45")}
        >
          <td className={cn(cell, "w-[5rem] border-l-[3px]", fam.edge)}>
            <RowDate v={v} className="text-[13px] leading-tight font-medium text-foreground/85" />
          </td>
          <td className={cn(cell, "w-full max-w-0")}>
            <div className="flex min-w-0 items-center gap-2">
              <FlowMark v={v} className="size-6" />
              <div className="min-w-0 flex-1">
                {/* One line: title · chips · what it is. Postponement / follow-up notes drop to a second line only when they exist. */}
                <div className="flex min-w-0 items-center gap-1.5">
                  <span title={[v.title, supporting].filter(Boolean).join(" · ")} className={cn("truncate text-[13.5px] leading-tight font-semibold", !compactDesktop && "max-w-[60%] shrink-0", muted ? "text-foreground/80" : "text-foreground")}>{v.title}</span>
                  {(v.kind === "emi" || v.kind === "loanEmi") && <BankPaidChip rowKey={v.row.key} />}
                  <ChevronDown className={cn("size-3.5 shrink-0 text-foreground/40 transition-transform", open && "rotate-180")} strokeWidth={2} aria-hidden />
                  {!compactDesktop && (v.split ? (
                    <SplitSummary split={v.split} className="min-w-0 flex-nowrap overflow-hidden" />
                  ) : hasRepaymentNote ? (
                    <RepaysLine v={v} />
                  ) : (
                    progressText(v) && <p className="min-w-0 truncate text-[11.5px] leading-tight text-foreground/60">{progressText(v)}</p>
                  ))}
                </div>
                {compactDesktop && (v.split ? <SplitSummary split={v.split} className="min-w-0 flex-wrap" /> : (
                  <>
                    {supporting && <p className="truncate text-[11px] leading-snug text-muted-foreground">{supporting}</p>}
                    {hasRepaymentNote && <RepaysLine v={v} />}
                  </>
                ))}
                <div className="flex min-w-0 items-baseline gap-x-3 empty:hidden">
                  {row.state !== "settled" && <DeferralNote rowKey={row.key} rowDate={row.date} hidePostponed className="shrink-0 whitespace-nowrap" />}
                  <PostponedTrail v={v} className="shrink-0" />
                  <FollowUpNote rowKey={row.key} className="flex" />
                </div>
                {linkedTrail?.(row.key) && <div>{linkedTrail(row.key)}</div>}
              </div>
            </div>
          </td>
          {cashCells(cash)}
          <td className={cn(cell, NUM, "w-[6.5rem]")}>
            <ItemAmount v={v} />
          </td>
          <td className={cn(cell, compactDesktop ? "w-[9.5rem]" : "w-[8rem] max-w-[8rem]")}>{compactDesktop ? <HistoryResult v={v} /> : <RowStatus v={v} />}</td>
          <td className={cn(cell, "w-[9rem] py-0.5", !compactDesktop && "2xl:w-[15rem]")}><RowActionButtons v={v} handlers={handlers} lookups={lookups} compact detailsOpen={open} onToggleDetails={() => toggle(row)} /></td>
        </tr>
        <tr aria-hidden={!open}>
          <td colSpan={columnCount} className={cn("p-0", open && "border-b border-border-strong/45 bg-secondary/45")}>
            <InlineReveal open={open}>
              <div className="px-3 pt-0.5 pb-2.5 lg:pl-[5.75rem]">
                <Expansion v={v} {...expansionProps} onCollapse={() => toggle(row)} />
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
    return (
      <li key={row.key} data-obligation-key={row.key} className={cn("border-b border-l-[4px] border-b-border-strong/55", rowTint(v), fam.edge)}>
        <button type="button" onClick={() => toggle(row)} aria-expanded={open} className="block w-full px-3 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
          {/* Line 1: what it is · the figure that matters (what is left, or the amount once paid). */}
          <div className="flex items-baseline justify-between gap-3">
            <p className={cn("flex min-w-0 items-center gap-2 text-[13.5px] leading-snug font-semibold", row.state === "settled" ? "text-foreground/80" : "text-foreground")}>
              <FlowMark v={v} className="size-6 self-center" />
              <span className="truncate">{v.title}</span>
            </p>
            <MobileFigure v={v} />
          </div>
          {/* Line 2: type · date · status. Paid / left / moved are in the status, so no separate grid. A completed
              row shows its completion stamp in the status's place, filling the line's free space. */}
          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
            <RowDate v={v} className="text-[11.5px] font-medium text-foreground/70" />
            <span className="text-[11.5px] text-foreground/55">· {v.carried && cycleLabelOf ? `From ${cycleLabelOf(row.date)} · ` : ""}{v.typeLabel}</span>
            {(v.kind === "emi" || v.kind === "loanEmi") && <BankPaidChip rowKey={v.row.key} />}
            <span className="ml-auto flex max-w-full min-w-0 items-center gap-1">
              <RowStatus v={v} />
              <ChevronDown className={cn("size-4 shrink-0 text-foreground/55 transition-transform", open && "rotate-180")} aria-hidden />
            </span>
          </div>
          {v.split && <SplitSummary split={v.split} className="mt-0.5" />}
          {balances?.get(row.key) && (
            <p className="mt-0.5 flex items-baseline justify-end gap-1 text-[11px] text-foreground/60">
              <span>Balance</span>
              <BalanceFigure b={balances.get(row.key)} />
            </p>
          )}
          <RepaysLine v={v} className="mt-0.5" />
          {row.state !== "settled" && <DeferralNote rowKey={row.key} rowDate={row.date} hidePostponed className="mt-0.5 flex" />}
          <FollowUpNote rowKey={row.key} className="mt-0.5 flex" />
          {linkedTrail?.(row.key) && <span className="mt-0.5 block">{linkedTrail(row.key)}</span>}
        </button>
        <InlineReveal open={open}>
          <div className="px-2 pb-2.5">
            <Expansion v={v} {...expansionProps} onCollapse={() => toggle(row)} />
          </div>
        </InlineReveal>
      </li>
    );
  };

  type MonthGroup = { key: string; label: string | null; rows: unknown[] };
  const countLabel = (g: MonthGroup) => `${g.rows.length} ${g.rows.length === 1 ? "transaction" : "transactions"}`;
  const monthHeadingRow = (g: MonthGroup) => (
    <tr>
      <td colSpan={columnCount} className={cn("border-b border-border bg-secondary/45 px-3 py-2", compactDesktop && "py-1.5")}>
        <span className="text-xs font-semibold whitespace-nowrap text-foreground">{g.label}</span>
        <span className="ml-2 text-[11px] font-medium whitespace-nowrap text-muted-foreground">{countLabel(g)}</span>
      </td>
    </tr>
  );
  const monthHeadingItem = (g: MonthGroup) => (
    <li className="sticky top-0 z-[1] flex items-baseline justify-between gap-2 border-b border-border bg-secondary px-3 py-2">
      <span className="text-xs font-semibold whitespace-nowrap text-foreground">{g.label}</span>
      <span className="text-[11px] font-medium whitespace-nowrap text-muted-foreground">{countLabel(g)}</span>
    </li>
  );

  return (
    <TooltipProvider>
    <div className={className}>
      {/* md+: the reconciliation table */}
      <table className={cn("hidden w-full border-separate border-spacing-0 text-sm", compactDesktop ? "@min-[46rem]:table" : "xl:table")}>
        <thead>
          <tr>
            <th className={cn(TH, "w-[5rem]")}>Date</th>
            <th className={cn(TH, "w-full")}>Transaction</th>
            {compactDesktop ? <th className={cn(TH, "w-[7rem] text-right")} title="Positive amounts are money in. Negative amounts are money out.">Cash flow</th> : <>
              <th className={cn(TH, "w-[6rem] text-right")} title="Cash that came in on this line">Money in</th>
              <th className={cn(TH, "w-[6rem] text-right")} title="Cash that went out on this line">Money out</th>
            </>}
            <th className={cn(TH, "w-[6.5rem] text-right")} title="This line's own amount — the transaction or installment share where no cash moved. Not a running balance.">{compactDesktop ? "Item amount" : "Amount"}</th>
            <th className={cn(TH, compactDesktop ? "w-[9.5rem]" : "w-[8rem]")}>{compactDesktop ? "Status / balance" : "Status"}</th>
            <th className={cn(TH, "w-[9rem] text-right", !compactDesktop && "2xl:w-[15rem]")}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <Fragment key={g.key}>
              {monthHeadingRow(g)}
              {itemsOf(g).map((item) => {
                if (item.kind === "pay") return payRow(item.line);
                if (item.kind === "carried") return desktopRow(viewOf(item.row, personName, lookups, true, personId));
                if (item.kind === "row") return desktopRow(viewOf(item.row, personName, lookups, false, personId));
                const open = foldIsOpen(item);
                return (
                  <Fragment key={item.id}>
                    <tr onClick={() => toggleFold(item.id)} className="cursor-pointer bg-muted/40 hover:bg-muted/60" data-testid="payment-fold">
                      <td colSpan={columnCount} className="border-b border-border px-3 py-2">
                        <button type="button" aria-expanded={open} className="flex w-full items-center gap-2 text-left text-sm font-semibold text-foreground">
                          <ChevronDown className={cn("size-4 transition-transform", !open && "-rotate-90")} aria-hidden />
                          {foldTitle(item)}
                          <span className="text-xs font-normal text-muted-foreground">{foldMeta(item)} · {open ? "hide" : "show"}</span>
                        </button>
                      </td>
                    </tr>
                    {open && item.rows.map((row) => desktopRow(viewOf(row, personName, lookups, false, personId)))}
                  </Fragment>
                );
              })}
            </Fragment>
          ))}
        </tbody>
      </table>

      {/* Phone: compact financial rows */}
      <ul className={cn("flex flex-col", compactDesktop ? "@min-[46rem]:hidden" : "xl:hidden")}>
        {groups.map((g) => (
          <Fragment key={g.key}>
            {monthHeadingItem(g)}
            {itemsOf(g).map((item) => {
              if (item.kind === "pay") return mobilePayRow(item.line);
              if (item.kind === "carried") return mobileRow(viewOf(item.row, personName, lookups, true, personId));
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
    </TooltipProvider>
  );
}

