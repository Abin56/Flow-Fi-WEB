"use client";

import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  CalendarClock,
  Check,
  ChevronDown,
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
import { Skeleton } from "@/components/ui/skeleton";
import type { LedgerRowHandlers } from "@/features/people/components/person-activity-feed";
import { EntryEditForm, EntrySettleForm, InlineReveal, isEditable, LoanPayLink, DELETE_BLOCK_NOTE } from "@/features/people/components/workspace/ledger-ui";
import { groupByMonth, sequence, type LedgerRow, type PaymentRecord } from "@/features/people/lib/person-ledger-rows";
import {
  KIND_LABEL,
  linkedExpense,
  paidSoFar,
  relationLine,
  settlementKind,
  settlementStatus,
  settlementTitle,
  settlementTone,
  shareBreakdown,
  splitContext,
  splitContextLine,
  type SettlementKind,
  type SettlementLookups,
  type SettlementStatusTone,
  type SettlementTone,
} from "@/features/people/lib/settlement-presentation";
import { formatStatementDate, type EmiRowStatus } from "@/lib/engines/person-cycle-statement";
import { money } from "@/lib/engines/person-cycle-statement-share";
import { cn } from "@/lib/utils";

/**
 * The People settlement reconciliation table — one component for the Person workspace's Activity and the
 * expanded ledger. Desktop: a ruled table (# · Date · What · Type · Original · Paid · Remaining · Status ·
 * Action). Tablet: Paid and # fold into the row. Phone: compact financial rows, never a squeezed table.
 * Every figure is a `LedgerRow` engine value; wording and colour come from `settlement-presentation`.
 */

// ---------------------------------------------------------------------------------------------------
// Semantic styling (literal class strings so Tailwind sees them)
// ---------------------------------------------------------------------------------------------------

export type Family = "receivable" | "payable" | "emi" | "loan" | "split" | "assigned" | "advance" | "carried";

export const TONE_FAMILY: Record<SettlementTone, Family> = {
  receivable: "receivable",
  payable: "payable",
  emi: "emi",
  loan: "loan",
  split: "split",
  assigned: "assigned",
  received: "receivable",
  paid: "carried",
  advance: "advance",
  neutral: "carried",
};

export const FAMILY: Record<Family, { tint: string; edge: string; text: string; badge: string }> = {
  receivable: { tint: "bg-settle-receivable-tint", edge: "border-l-settle-receivable-edge", text: "text-settle-receivable-text", badge: "bg-settle-receivable-badge text-settle-receivable-text" },
  payable: { tint: "bg-settle-payable-tint", edge: "border-l-settle-payable-edge", text: "text-settle-payable-text", badge: "bg-settle-payable-badge text-settle-payable-text" },
  emi: { tint: "bg-settle-emi-tint", edge: "border-l-settle-emi-edge", text: "text-settle-emi-text", badge: "bg-settle-emi-badge text-settle-emi-text" },
  loan: { tint: "bg-settle-loan-tint", edge: "border-l-settle-loan-edge", text: "text-settle-loan-text", badge: "bg-settle-loan-badge text-settle-loan-text" },
  split: { tint: "bg-settle-split-tint", edge: "border-l-settle-split-edge", text: "text-settle-split-text", badge: "bg-settle-split-badge text-settle-split-text" },
  assigned: { tint: "bg-settle-assigned-tint", edge: "border-l-settle-assigned-edge", text: "text-settle-assigned-text", badge: "bg-settle-assigned-badge text-settle-assigned-text" },
  advance: { tint: "bg-settle-advance-tint", edge: "border-l-settle-advance-edge", text: "text-settle-advance-text", badge: "bg-settle-advance-badge text-settle-advance-text" },
  carried: { tint: "bg-settle-carried-tint", edge: "border-l-settle-carried-edge", text: "text-settle-carried-text", badge: "bg-settle-carried-badge text-settle-carried-text" },
};

const STATUS_STYLE: Record<SettlementStatusTone, string> = {
  due: "bg-settle-receivable-badge text-settle-receivable-text",
  payable: "bg-settle-payable-badge text-settle-payable-text",
  partial: "bg-settle-emi-badge text-settle-emi-text",
  settled: "bg-success text-success-foreground",
  overdue: "bg-expense text-expense-foreground",
  upcoming: "bg-settle-carried-badge text-settle-carried-text",
  received: "bg-settle-receivable-badge text-settle-receivable-text",
  paid: "bg-settle-carried-badge text-settle-carried-text",
  neutral: "bg-settle-carried-badge text-settle-carried-text",
};

const STATUS_ICON: Partial<Record<SettlementStatusTone, LucideIcon>> = {
  settled: Check,
  overdue: AlertTriangle,
  received: Check,
  paid: Check,
  upcoming: CalendarClock,
};

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
  relation: string;
  status: ReturnType<typeof settlementStatus>;
  paid: number | null;
  /** Row belongs to an earlier cycle and is shown as brought forward. */
  carried: boolean;
  /** "Original ₹3,000 · 3-way split" for a split/assigned share whose Expense is available; else null. */
  splitNote: string | null;
}

export function viewOf(row: LedgerRow, personName: string, lookups: SettlementLookups, carried = false, personId?: string): SettlementRowView {
  const kind = settlementKind(row, lookups);
  const ctx = (kind === "split" || kind === "assigned") && personId != null ? splitContext(row, lookups, personId) : null;
  const tone = settlementTone(row, kind);
  return {
    row,
    kind,
    family: carried ? "carried" : TONE_FAMILY[tone],
    typeFamily: TONE_FAMILY[tone],
    title: settlementTitle(row, kind, personName),
    relation: relationLine(row, kind, personName, money),
    status: settlementStatus(row, kind, personName, money),
    paid: isPaymentKind(kind) ? row.amount : paidSoFar(row),
    carried,
    splitNote: ctx ? splitContextLine(ctx, money) : null,
  };
}

// ---------------------------------------------------------------------------------------------------
// Small parts
// ---------------------------------------------------------------------------------------------------

export function TypeBadge({ kind, family, className }: { kind: SettlementKind; family: Family; className?: string }) {
  const Icon = KIND_ICON[kind];
  return (
    <span className={cn("inline-flex h-5 shrink-0 items-center gap-1 rounded-[4px] px-1.5 text-[10.5px] leading-none font-bold whitespace-nowrap", FAMILY[family].badge, className)}>
      <Icon className="size-3" strokeWidth={2.25} aria-hidden />
      {KIND_LABEL[kind]}
    </span>
  );
}

export function StatusPill({ status, compact = false }: { status: SettlementRowView["status"]; compact?: boolean }) {
  const Icon = STATUS_ICON[status.tone];
  return (
    <div className="min-w-0">
      <span className={cn("inline-flex h-[18px] items-center gap-1 rounded-[4px] px-1.5 text-[10px] leading-none font-bold tracking-[0.04em] whitespace-nowrap uppercase", STATUS_STYLE[status.tone])}>
        {Icon && <Icon className="size-3" strokeWidth={2.5} aria-hidden />}
        {status.label}
      </span>
      {!compact && status.detail && <p className="truncate text-[11px] leading-tight font-medium text-foreground/75">{status.detail}</p>}
    </div>
  );
}

function Amount({ value, strong, tone }: { value: number | null; strong?: boolean; tone?: string }) {
  if (value == null) return <span className="text-foreground/45">—</span>;
  return <span className={cn("tabular-nums", strong ? "font-heading text-[14.5px] font-bold" : "text-[13px] font-semibold", tone ?? "text-foreground")}>{money(value)}</span>;
}

/** Remaining is the second-strongest figure; zero on a settled row reads as done, not as a number to act on. */
function RemainingAmount({ v }: { v: SettlementRowView }) {
  if (v.row.state == null) return <span className="text-foreground/45">—</span>;
  if (v.row.state === "settled") return <span className="inline-flex items-center gap-1 text-[13px] font-semibold text-success tabular-nums"><Check className="size-3.5" strokeWidth={2.5} />{money(0)}</span>;
  const tone = v.row.overdue ? "text-expense" : v.row.direction === "iOwe" ? "text-settle-payable-text" : "text-settle-receivable-text";
  return <Amount value={v.row.remaining ?? 0} strong tone={tone} />;
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

function Breakdown({ v, personId, personName, lookups }: { v: SettlementRowView; personId: string; personName: string; lookups: SettlementLookups }) {
  const { row, kind } = v;
  const s = row.statementRow;
  const first = personName.split(" ")[0];
  const responsible = row.direction === "iOwe" ? "Your responsibility" : `${first}'s responsibility`;
  const settleLines =
    row.state != null ? (
      <>
        <Line label={responsible} value={money(row.amount)} />
        <Line label={row.direction === "iOwe" ? "You paid" : `${first} paid`} value={money(v.paid ?? 0)} tone={(v.paid ?? 0) > 0 ? "text-success" : undefined} />
        <Line label="Remaining" value={row.state === "settled" ? "Settled" : money(row.remaining ?? 0)} strong tone={row.state === "settled" ? "text-success" : undefined} />
      </>
    ) : null;

  if (kind === "emi" || kind === "loanEmi") {
    return (
      <dl className="text-[13px]">
        {s?.emi && <Line label={kind === "loanEmi" ? "Loan" : "EMI"} value={s.emi.sourceName} />}
        {s?.emi && <Line label="Installment" value={`#${s.emi.installmentNumber}`} />}
        <Line label="Due" value={formatStatementDate(row.date, true)} />
        <div className="my-1" />
        {settleLines}
        {s?.emi && (
          <div className="mt-2 grid grid-cols-2 gap-2 text-[12px]">
            <div className="rounded-[6px] border border-border-strong/70 px-2 py-1.5">
              <p className="text-[10.5px] font-bold tracking-[0.06em] text-foreground/65 uppercase">Bank EMI</p>
              <p className={cn("font-semibold", s.emi.status === "overdue" ? "text-expense" : "text-foreground")}>{BANK_STATUS[s.emi.status]}</p>
            </div>
            <div className="rounded-[6px] border border-border-strong/70 px-2 py-1.5">
              <p className="text-[10.5px] font-bold tracking-[0.06em] text-foreground/65 uppercase">{first}&apos;s reimbursement</p>
              <p className="font-semibold text-foreground">{v.status.label}</p>
            </div>
          </div>
        )}
      </dl>
    );
  }
  if (kind === "split" || kind === "assigned") {
    const shares = shareBreakdown(linkedExpense(row, lookups), personId, personName);
    return (
      <dl className="text-[13px]">
        {shares && (
          <>
            <SectionLabel>Split details</SectionLabel>
            <Line label={<span className="font-bold text-foreground">Total price</span>} value={money(shares.total)} strong />
            {shares.lines.map((l, i) => (
              <Line key={i} indent label={l.highlight ? <span className="font-semibold text-foreground">{l.label}</span> : l.label} value={l.highlight ? <span className="font-semibold">{money(l.amount)}</span> : money(l.amount)} />
            ))}
            {/* Sum of the stored allocations, as stored — never forced to equal the total. */}
            <div className="border-t border-border-strong/50">
              <Line label="Allocated" value={money(Math.round(shares.lines.reduce((s, l) => s + l.amount, 0) * 100) / 100)} />
            </div>
            <div className="my-1" />
          </>
        )}
        {settleLines}
      </dl>
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
    <div>
      <SectionLabel>Payment progress</SectionLabel>
      <p className="text-[13px] text-foreground">
        <span className="font-bold tabular-nums">{money(paid)}</span> <span className="text-foreground/70">{row.direction === "iOwe" ? "paid" : "received"} of</span>{" "}
        <span className="font-semibold tabular-nums">{money(row.amount)}</span>
      </p>
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
              <span className="shrink-0 font-semibold text-foreground tabular-nums sm:w-[5.5rem]">{formatStatementDate(p.date, true)}</span>
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
    <div>
      <SectionLabel>Source</SectionLabel>
      <dl className="text-[12px] text-foreground/75">
        <div className="flex gap-1.5"><dt>Type</dt><dd className="font-semibold text-foreground">{KIND_LABEL[v.kind]}</dd></div>
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
    if (ref && !sourceUnavailable(row, lookups)) return { href: `/transactions?transaction=${encodeURIComponent(ref)}`, label: "Open expense" };
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
  return (
    <div className={cn("rounded-[8px] border border-l-[3px] border-border-strong/70 bg-card px-3 py-2.5", FAMILY[v.family].edge)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <p className="truncate text-[13px] font-bold tracking-[0.03em] text-foreground uppercase">{v.title}</p>
          <TypeBadge kind={v.kind} family={v.typeFamily} />
        </div>
        <RowActionButtons v={v} handlers={handlers} lookups={lookups} />
      </div>
      <div className="mt-2 grid gap-x-7 gap-y-2.5 md:grid-cols-2 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,0.7fr)]">
        <Breakdown v={v} personId={personId} personName={personName} lookups={lookups} />
        <div className="flex flex-col gap-3">
          <Progress v={v} />
          <Payments v={v} personName={personName} accountForEntry={accountForEntry} onUndo={onUndo} onEdit={onEditPayment} />
        </div>
        <Source v={v} cycleLabelOf={cycleLabelOf} />
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
  /** Open obligations from earlier cycles — shown first as "Brought forward". */
  carriedRows?: LedgerRow[];
  isLoading: boolean;
  lookups: SettlementLookups;
  accountForEntry: (entryId: string | null) => string | null;
  handlers: LedgerRowHandlers;
  /** Shown when there are no rows at all. */
  empty: React.ReactNode;
  /** "Brought forward" source label, e.g. "Sep cycle". */
  cycleLabelOf?: (d: Date) => string;
  /** Onward-payment trail for an obligation settled with money received (card bill / EMI still to pay, or paid). */
  linkedTrail?: (rowKey: string) => React.ReactNode;
  /** Sticky header offset container: the table's header sticks to the top of its scrolling parent. */
  className?: string;
}

export function SettlementTable({ personId, personName, rows, carriedRows = [], isLoading, lookups, accountForEntry, handlers, empty, cycleLabelOf, className, linkedTrail }: SettlementTableProps) {
  const [openKey, setOpenKey] = useState<string | null>(null);
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

  const desktopRow = (v: SettlementRowView, n: number) => {
    const { row } = v;
    const open = isOpen(row);
    const fam = FAMILY[v.family];
    const muted = row.state === "settled";
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
          className={cn("group cursor-pointer transition-colors", fam.tint, "hover:brightness-[0.97] dark:hover:brightness-110", open && "outline-2 -outline-offset-2 outline-primary-accent-text/60")}
        >
          <td className={cn(TD, "hidden w-10 border-l-[4px] text-right text-[11px] font-semibold text-foreground/60 tabular-nums lg:table-cell", fam.edge)}>{sequence(n, total)}</td>
          <td className={cn(TD, "w-[4.75rem] border-l-[4px] whitespace-nowrap lg:border-l-0", fam.edge)}>
            <p className="text-[13px] leading-tight font-semibold text-foreground tabular-nums">{formatStatementDate(row.date)}</p>
            {/* The month heading carries the year; brought-forward rows sit outside it, so they keep theirs. */}
            {v.carried && <p className="text-[10.5px] leading-tight font-medium text-foreground/65 tabular-nums">{row.date.getFullYear()}</p>}
          </td>
          <td className={cn(TD, "w-full max-w-0")}>
            <div className="flex min-w-0 items-center gap-1.5">
              <ChevronDown className={cn("size-3.5 shrink-0 text-foreground/50 transition-transform", open && "rotate-180")} strokeWidth={2} aria-hidden />
              <span className={cn("truncate text-[13.5px] leading-tight font-semibold", muted ? "text-foreground/80" : "text-foreground")}>{v.title}</span>
              <TypeBadge kind={v.kind} family={v.typeFamily} className="h-[18px] xl:hidden" />
              {v.carried && <span className="shrink-0 rounded-[4px] bg-settle-carried-badge px-1.5 text-[10px] leading-4 font-bold tracking-wide text-settle-carried-text uppercase">Brought forward</span>}
            </div>
            <p className="truncate pl-5 text-[11.5px] leading-tight font-medium text-foreground/75">
              {v.carried && cycleLabelOf ? `From ${cycleLabelOf(row.date)} · ` : ""}
              {v.relation}
            </p>
            {v.splitNote && <p className="truncate pl-5 text-[11px] leading-tight text-foreground/60 tabular-nums">{v.splitNote.split(" · ").map((part, i) => (i === 0 ? <span key={i} className="font-bold text-foreground">{part}</span> : <span key={i}> · {part}</span>))}</p>}
            {linkedTrail?.(row.key) && <div className="pl-5">{linkedTrail(row.key)}</div>}
          </td>
          <td className={cn(TD, "hidden w-[9.5rem] xl:table-cell")}><TypeBadge kind={v.kind} family={v.typeFamily} /></td>
          <td className={cn(TD, NUM, "w-[6.5rem]")}><Amount value={isPaymentKind(v.kind) ? null : row.amount} tone={muted ? "text-foreground/75" : undefined} /></td>
          <td className={cn(TD, NUM, "hidden w-[6.5rem] lg:table-cell")}><Amount value={v.paid} tone={v.paid ? "text-success" : "text-foreground/60"} /></td>
          <td className={cn(TD, NUM, "w-[7rem]")}><RemainingAmount v={v} /></td>
          <td className={cn(TD, "w-[11.5rem] max-w-[11.5rem]")}><StatusPill status={v.status} /></td>
          <td className={cn(TD, "w-[10rem] py-0.5")}><RowActionButtons v={v} handlers={handlers} lookups={lookups} compact /></td>
        </tr>
        <tr aria-hidden={!open}>
          <td colSpan={9} className={cn("p-0", open && "border-b border-border-strong/60 bg-secondary/60")}>
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
    return (
      <li key={row.key} data-obligation-key={row.key} className={cn("border-b border-l-[4px] border-b-border-strong/55", fam.tint, fam.edge)}>
        <button type="button" onClick={() => toggle(row)} aria-expanded={open} className="block w-full px-3 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-[14px] font-semibold text-foreground">{v.title}</p>
              <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                <TypeBadge kind={v.kind} family={v.typeFamily} />
                <span className="text-[11.5px] font-medium text-foreground/70 tabular-nums">{formatStatementDate(row.date, true)}</span>
                {v.carried && <span className="rounded-[4px] bg-settle-carried-badge px-1.5 text-[10px] leading-4 font-bold text-settle-carried-text uppercase">Brought forward</span>}
              </div>
            </div>
            <div className="shrink-0 text-right">
              <RemainingAmount v={v} />
              <p className="text-[10.5px] font-semibold text-foreground/60 uppercase">{row.state == null ? (v.paid != null ? "amount" : "") : "remaining"}</p>
            </div>
          </div>
          <p className="mt-1 truncate text-[12px] font-medium text-foreground/75">{v.relation}</p>
          {v.splitNote && <p className="truncate text-[11px] text-foreground/60 tabular-nums">{v.splitNote.split(" · ").map((part, i) => (i === 0 ? <span key={i} className="font-bold text-foreground">{part}</span> : <span key={i}> · {part}</span>))}</p>}
          {linkedTrail?.(row.key) && <span className="mt-0.5 block">{linkedTrail(row.key)}</span>}
          {row.state != null ? (
            <dl className="mt-1 grid grid-cols-3 gap-2 text-[11.5px]">
              <div><dt className="text-foreground/60">{v.splitNote ? "Share" : "Original"}</dt><dd className="font-semibold text-foreground tabular-nums">{money(row.amount)}</dd></div>
              <div><dt className="text-foreground/60">Paid</dt><dd className="font-semibold text-success tabular-nums">{money(v.paid ?? 0)}</dd></div>
              <div><dt className="text-foreground/60">Remaining</dt><dd className="font-semibold text-foreground tabular-nums">{money(row.remaining ?? 0)}</dd></div>
            </dl>
          ) : (
            <p className="mt-1 text-[13px] font-bold text-foreground tabular-nums">{money(row.amount)}</p>
          )}
          <div className="mt-1 flex items-center justify-between gap-2">
            <StatusPill status={v.status} />
            <ChevronDown className={cn("size-4 shrink-0 text-foreground/55 transition-transform", open && "rotate-180")} />
          </div>
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
            <th className={cn(TH, "w-[6.5rem] text-right")}>Original</th>
            <th className={cn(TH, "hidden w-[6.5rem] text-right lg:table-cell")}>Paid</th>
            <th className={cn(TH, "w-[7rem] text-right")}>Remaining</th>
            <th className={cn(TH, "w-[11.5rem]")}>Status</th>
            <th className={cn(TH, "w-[10rem]")}>Action</th>
          </tr>
        </thead>
        <tbody>
          {carriedViews.length > 0 && (
            <>
              <tr>
                <td colSpan={9} className="border-b border-border-strong/60 bg-settle-carried-badge px-3 py-1 text-[10.5px] font-bold tracking-[0.08em] text-settle-carried-text uppercase">
                  <span className="inline-flex items-center gap-1.5"><History className="size-3.5" />Brought forward · still open from earlier cycles</span>
                </td>
              </tr>
              {carriedViews.map((v) => desktopRow(v, ++n))}
            </>
          )}
          {groups.map((g) => (
            <Fragment key={g.key}>
              <tr>
                <td colSpan={9} className="border-t-2 border-b border-t-border-strong border-b-border-strong/70 bg-secondary px-3 pt-2 pb-1">
                  <span className="text-[12px] font-bold tracking-[0.08em] text-foreground uppercase">{g.label}</span>
                  <span className="ml-2 text-[11.5px] font-medium text-foreground/70">
                    {g.rows.length} {g.rows.length === 1 ? "transaction" : "transactions"}
                  </span>
                </td>
              </tr>
              {g.rows.map(({ row }) => desktopRow(viewOf(row, personName, lookups, false, personId), ++n))}
            </Fragment>
          ))}
        </tbody>
      </table>

      {/* Phone: compact financial rows */}
      <ul className="flex flex-col md:hidden">
        {carriedViews.length > 0 && (
          <li className="border-b border-border-strong/60 bg-settle-carried-badge px-3 py-1 text-[10.5px] font-bold tracking-[0.08em] text-settle-carried-text uppercase">Brought forward</li>
        )}
        {carriedViews.map(mobileRow)}
        {groups.map((g) => (
          <Fragment key={g.key}>
            <li className="sticky top-0 z-[1] flex items-baseline justify-between border-t-2 border-b border-t-border-strong border-b-border-strong/70 bg-secondary px-3 py-1">
              <span className="text-[12px] font-bold tracking-[0.08em] text-foreground uppercase">{g.label}</span>
              <span className="text-[11px] font-medium text-foreground/70">{g.rows.length} {g.rows.length === 1 ? "transaction" : "transactions"}</span>
            </li>
            {g.rows.map(({ row }) => mobileRow(viewOf(row, personName, lookups, false, personId)))}
          </Fragment>
        ))}
      </ul>
    </div>
  );
}

