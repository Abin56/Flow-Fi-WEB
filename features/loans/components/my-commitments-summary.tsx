"use client";

import { AlertTriangle, CalendarClock, CheckCircle2, ChevronDown, ChevronRight, HandCoins, Info, ListChecks, Users, Wallet, type LucideIcon } from "lucide-react";
import { useMemo, useState } from "react";
import type { EmiRow } from "@/features/emi/hooks/use-emi-data";
import { EmiBreakdown } from "@/features/loans/components/emi-breakdown";
import { EmiListSheet, type EmiSheetTab } from "@/features/loans/components/emi-list-sheet";
import { ChoiceChips, LE_RADIUS, Money } from "@/features/loans/components/loan-emi-ui";
import type { LoanRow } from "@/features/loans/hooks/use-loans-data";
import {
  commitmentRows,
  expectedReimbursement,
  foldCommitmentRows,
  monthWindow,
  recordFromEmiRow,
  recordFromLoanRow,
  reimbursementTargets,
  OWNERSHIP_LABEL,
  type CommitmentRecord,
  type CommitmentSummary,
  type MonthWindow,
} from "@/features/loans/lib/my-commitments";
import { usePeopleCycleStatements } from "@/features/people/hooks/use-person-cycle-statement";
import { cn } from "@/lib/utils";

const ALL_TIME = { start: new Date(1970, 0, 1), end: new Date(2200, 0, 1) };
const rupees = (paise: number) => paise / 100;

const MONTH_OPTIONS: { value: "0" | "1"; label: string }[] = [
  { value: "0", label: "This month" },
  { value: "1", label: "Next month" },
];

const TONES = {
  neutral: { tile: "bg-secondary/40", icon: "bg-secondary text-foreground" },
  hero: { tile: "border-primary-accent-text/30 bg-primary/15", icon: "bg-primary text-primary-foreground" },
  good: { tile: "bg-success/10", icon: "bg-success/20 text-success" },
  warn: { tile: "bg-expense/10", icon: "bg-expense/15 text-expense" },
  others: { tile: "border-violet-500/25 bg-violet-500/10", icon: "bg-violet-500/20 text-violet-700 dark:text-violet-300" },
} as const;

function Figure({ label, children, hint, tooltip, tile, icon: Icon, tone = "neutral" }: { label: string; children: React.ReactNode; hint?: string; tooltip?: string; tile?: boolean; icon?: LucideIcon; tone?: keyof typeof TONES }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", tile && cn("rounded-[10px] border border-border p-3.5 shadow-e1 transition-shadow hover:shadow-md", TONES[tone].tile))}>
      <span title={tooltip} className={cn("flex items-center gap-1.5 text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase", tooltip && "cursor-help")}>
        {Icon && (
          <span aria-hidden className={cn("grid size-6 shrink-0 place-items-center rounded-full", TONES[tone].icon)}>
            <Icon className="size-3.5" />
          </span>
        )}
        {label}
        {tooltip && <Info aria-label={tooltip} className="size-3 shrink-0" />}
      </span>
      <div className="min-w-0 text-foreground">{children}</div>
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  );
}

function GlanceChip({ label, tone, children, onClick }: { label: string; tone: keyof typeof TONES; children: React.ReactNode; onClick?: () => void }) {
  const cls = cn("inline-flex items-baseline gap-2 rounded-full border border-border px-3 py-1", TONES[tone].tile);
  const inner = (
    <>
      <span className="text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">{label}</span>
      {children}
      {onClick && <ChevronRight aria-hidden className="size-3.5 self-center text-muted-foreground" />}
    </>
  );
  return onClick ? (
    <button type="button" onClick={onClick} aria-label={`${label} — open the EMI list`} className={cn(cls, "cursor-pointer outline-none transition-shadow hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring")}>
      {inner}
    </button>
  ) : (
    <span className={cls}>{inner}</span>
  );
}

/**
 * Others' confirmed share of this month's Shared / Others EMIs — the mirror of the My EMI row above. Informational:
 * I pay the lender, they owe me (People Ledger); it is never added to or netted against my own figures.
 */
function OthersSection({ others, onOpen }: { others: CommitmentSummary["others"]; onOpen: () => void }) {
  const pct = others.scheduledPaise > 0 ? Math.min(100, Math.round((others.attributedPaidPaise / others.scheduledPaise) * 100)) : 0;
  return (
    <div aria-label="Others' EMI" className="flex flex-col gap-3 rounded-[12px] border border-violet-500/25 bg-gradient-to-br from-violet-500/[0.07] to-transparent p-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 font-heading text-base font-semibold text-foreground">
          <span aria-hidden className="grid size-7 place-items-center rounded-full bg-violet-500/20 text-violet-700 dark:text-violet-300">
            <Users className="size-4" />
          </span>
          Others’ EMI
          <span className="rounded-full bg-violet-500/15 px-2 py-0.5 text-[11px] font-medium text-violet-700 dark:text-violet-300">
            {others.records} {others.records === 1 ? "EMI" : "EMIs"} · {others.installments} {others.installments === 1 ? "installment" : "installments"}
          </span>
        </h3>
        <button
          type="button"
          onClick={onOpen}
          className={cn(LE_RADIUS.input, "inline-flex h-8 items-center gap-1 border border-violet-500/40 bg-violet-500/10 px-3 text-xs font-semibold text-violet-700 outline-none hover:bg-violet-500/20 focus-visible:ring-2 focus-visible:ring-ring dark:text-violet-300")}
        >
          Who pays what <ChevronRight aria-hidden className="size-3.5" />
        </button>
      </div>
      <p className="-mt-1 text-xs text-muted-foreground">Their shares of this month — I pay the lender, they owe me.</p>
      <div className="grid grid-cols-1 gap-3 @md:grid-cols-3">
        <Figure tile tone="others" icon={HandCoins} label="Others’ share" hint="Confirmed shares of others">
          <Money amount={rupees(others.scheduledPaise)} className="text-[26px] leading-none" />
        </Figure>
        <Figure tile tone="good" icon={CheckCircle2} label="Lender paid for them" hint="Pro-rata share of lender payments">
          <Money amount={rupees(others.attributedPaidPaise)} className="text-[26px] leading-none text-success" />
        </Figure>
        <Figure tile tone={others.remainingPaise > 0 ? "warn" : "good"} icon={CalendarClock} label="Not yet paid to lender" hint="Their share of the unpaid lender amount">
          <Money amount={rupees(others.remainingPaise)} className={cn("text-[26px] leading-none", others.remainingPaise > 0 && "text-expense")} />
        </Figure>
      </div>
      <div role="progressbar" aria-label="Share of others' EMI already paid to the lender" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="h-2 w-full overflow-hidden rounded-full bg-secondary">
        <div className="h-full rounded-full bg-gradient-to-r from-violet-400/70 to-violet-500 transition-all duration-500" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/**
 * Loaded only when the user opens the disclosure — the People statements behind it are a whole-history
 * subscription, so the summary above never pays for them.
 */
function ReimbursementFigure({ records, window }: { records: readonly CommitmentRecord[]; window: MonthWindow }) {
  const { statementsByPersonId, isLoading } = usePeopleCycleStatements(ALL_TIME);
  const result = useMemo(
    () => expectedReimbursement(reimbursementTargets(records, window), Object.values(statementsByPersonId)),
    [records, window, statementsByPersonId],
  );
  if (isLoading) return <span className="text-sm text-muted-foreground">Loading People rows…</span>;
  return (
    <div className="flex flex-col gap-0.5">
      <Money amount={rupees(result.paise)} className="text-lg" />
      <span className="text-xs text-muted-foreground">
        {result.paise > 0 ? `Still open from ${result.people} ${result.people === 1 ? "person" : "people"} on this month's shared installments.` : "Nothing open on this month's shared installments."}{" "}
        Tracked in the People Ledger, separate from the lender payment.
      </span>
    </div>
  );
}

/**
 * My EMI commitments — a compact, read-only summary over the same rows the cards show. Personal figures come
 * only from CONFIRMED ownership (`classifyOwnership`); unconfirmed records are listed apart, at full lender
 * amounts, and never enter a personal total. See `features/loans/lib/my-commitments.ts`.
 */
export function MyCommitmentsSummary({ loanRows, emiRows, defaultExpanded = true }: { loanRows: readonly LoanRow[]; emiRows: readonly EmiRow[]; defaultExpanded?: boolean }) {
  const [offset, setOffset] = useState<"0" | "1">("0");
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [sheet, setSheet] = useState<{ open: boolean; tab: EmiSheetTab }>({ open: false, tab: "mine" });
  const openSheet = (tab: EmiSheetTab) => setSheet({ open: true, tab });
  const [showReimbursement, setShowReimbursement] = useState(false);

  const records = useMemo(
    () => [...loanRows.map(recordFromLoanRow), ...emiRows.map(recordFromEmiRow)].filter((r): r is CommitmentRecord => r != null),
    [loanRows, emiRows],
  );
  const window = useMemo(() => monthWindow(new Date(), offset === "1" ? 1 : 0), [offset]);
  // One evaluation: the summary is folded from the very rows the breakdown lists, so the two cannot disagree.
  const rows = useMemo(() => commitmentRows(records, window, new Date()), [records, window]);
  const s = useMemo(() => foldCommitmentRows(rows), [rows]);
  const hasShared = useMemo(() => reimbursementTargets(records, window).length > 0, [records, window]);

  const m = s.mine;
  const fundingUnavailable = s.funding.installments === 0 && s.funding.undeterminedRecords > 0;
  const monthEmpty = m.installments === 0 && s.others.installments === 0 && s.review.installments === 0 && s.funding.installments === 0 && s.funding.undeterminedRecords === 0;
  const incomplete = s.review.installments > 0 || s.overdue.reviewInstallments > 0;

  return (
    <section aria-label="My EMI commitments" className={cn(LE_RADIUS.panel, "@container flex flex-col gap-4 border border-border bg-card p-4 shadow-e1 sm:px-6")}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-border pb-3">
        <h2 className="font-heading text-lg font-semibold text-foreground">
          My EMI — Confirmed{" "}
          <span className="ml-1 rounded-full bg-secondary px-2.5 py-0.5 align-middle text-xs font-medium text-muted-foreground">{window.label}</span>
        </h2>
        <div className="flex items-center gap-2">
          <ChoiceChips ariaLabel="Month" options={MONTH_OPTIONS} value={offset} onChange={setOffset} />
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
            className={cn(LE_RADIUS.input, "inline-flex h-8 items-center gap-1 border border-border-strong px-2.5 text-xs font-medium text-foreground outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring")}
          >
            {expanded ? "Hide details" : "Show details"} <ChevronDown aria-hidden className={cn("size-3.5 transition-transform", expanded && "rotate-180")} />
          </button>
        </div>
      </div>

      {!expanded && (
        <div className="flex flex-wrap items-center gap-2" aria-label="Summary at a glance">
          {monthEmpty ? (
            <span className="text-sm text-muted-foreground">No installments fall due in {window.label}.</span>
          ) : (
            <>
              <GlanceChip label="My EMI" tone="hero" onClick={() => openSheet("mine")}><Money amount={rupees(m.scheduledPaise)} className="text-base" /></GlanceChip>
              <GlanceChip label="Paid" tone="good" onClick={() => openSheet("mine")}><Money amount={rupees(m.attributedPaidPaise)} className="text-base text-success" /></GlanceChip>
              <GlanceChip label="Still to pay" tone={m.remainingPaise > 0 ? "warn" : "good"} onClick={() => openSheet("mine")}>
                <Money amount={rupees(m.remainingPaise)} className={cn("text-base", m.remainingPaise > 0 && "text-expense")} />
              </GlanceChip>
              {s.others.installments > 0 && (
                <GlanceChip label="Others’ share" tone="others" onClick={() => openSheet("others")}><Money amount={rupees(s.others.scheduledPaise)} className="text-base" /></GlanceChip>
              )}
              {incomplete && <span className="rounded-full bg-warning/15 px-2.5 py-1 text-xs font-semibold text-warning-foreground dark:text-warning">Not your full EMI — unconfirmed owners</span>}
            </>
          )}
        </div>
      )}

      {expanded && (
        <>

      {/* The confirmed figures below are a floor, not the whole picture, whenever any record's ownership is unconfirmed. */}
      {incomplete && (
        <div role="alert" className={cn(LE_RADIUS.control, "flex items-start gap-2 border border-warning-foreground/50 bg-warning/15 px-3 py-2 text-sm text-foreground dark:border-warning/60")}>
          <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-warning-foreground dark:text-warning" />
          <span>
            <span className="font-semibold">Not your full EMI yet.</span>{" "}
            {s.review.installments > 0 && (
              <>
                {s.review.installments} {s.review.installments === 1 ? "installment" : "installments"} in {s.review.records} {s.review.records === 1 ? "EMI" : "EMIs"} with unconfirmed owner, full amount{" "}
                <span className="font-semibold tabular-nums">₹{rupees(s.review.scheduledPaise).toLocaleString("en-IN")}</span>.{" "}
              </>
            )}
            {s.overdue.reviewInstallments > 0 && (
              <>
                Overdue with unconfirmed owner: <span className="font-semibold tabular-nums">₹{rupees(s.overdue.reviewPaise).toLocaleString("en-IN")}</span>.{" "}
              </>
            )}
            None of it is in My EMI — Confirmed. Open an EMI marked “{OWNERSHIP_LABEL.review}” to sort it out.
          </span>
        </div>
      )}

      {monthEmpty ? (
        <p className="text-sm text-muted-foreground">No installments fall due in {window.label}.</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 @xl:grid-cols-4">
            <Figure tile tone="hero" icon={Wallet} label="My EMI — Confirmed" hint={incomplete ? "Confirmed EMIs only — unconfirmed ones are not included" : "Confirmed EMIs only"}>
              <Money amount={rupees(m.scheduledPaise)} className="text-[26px] leading-none" />
            </Figure>
            <Figure tile tone="good" icon={CheckCircle2} label="Already paid" hint="Pro-rata share of lender payments" tooltip="Lender payments split in proportion to each EMI’s confirmed shares. It does not prove you paid this amount from your own money.">
              <Money amount={rupees(m.attributedPaidPaise)} className="text-[26px] leading-none text-success" />
            </Figure>
            <Figure tile tone={m.remainingPaise > 0 ? "warn" : "good"} icon={CalendarClock} label="Still to pay">
              <Money amount={rupees(m.remainingPaise)} className={cn("text-[26px] leading-none", m.remainingPaise > 0 && "text-expense")} />
            </Figure>
            <Figure tile icon={ListChecks} label="My installments" hint={m.installments > 0 ? `${m.paid} paid${m.partial > 0 ? ` · ${m.partial} partial` : ""} · ${m.unpaid} unpaid` : undefined}>
              <span className="font-heading text-[26px] leading-none font-bold tabular-nums">{m.installments}</span>
            </Figure>
          </div>

          {m.scheduledPaise > 0 && (
            <div
              role="progressbar"
              aria-label="Share of my confirmed EMI already paid"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.min(100, Math.round((m.attributedPaidPaise / m.scheduledPaise) * 100))}
              className="h-2.5 w-full overflow-hidden rounded-full bg-secondary"
            >
              <div className="h-full rounded-full bg-gradient-to-r from-success/70 to-success transition-all duration-500" style={{ width: `${Math.min(100, (m.attributedPaidPaise / m.scheduledPaise) * 100)}%` }} />
            </div>
          )}

          {m.installments > 0 && (
            <button
              type="button"
              onClick={() => openSheet("mine")}
              className={cn(LE_RADIUS.input, "inline-flex h-8 w-fit items-center gap-1 border border-border-strong px-3 text-xs font-semibold text-foreground outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring")}
            >
              See my EMIs — how much to pay <ChevronRight aria-hidden className="size-3.5" />
            </button>
          )}

          {s.others.installments > 0 && <OthersSection others={s.others} onOpen={() => openSheet("others")} />}

          <div className="grid gap-3 @xl:grid-cols-2">
            <Figure
              tile
              label="Still to pay the lender"
              hint="Unpaid lender amount — not past account outflow. Card-linked and payer-person EMIs may be left out."
              tooltip="The lender amount still unpaid on installments due this month, including shares you pay for others. It is not what has already left your accounts, and card-linked or payer-person EMIs may be excluded, so it may not cover every lender payment."
            >
              {fundingUnavailable ? (
                <span className="text-sm font-semibold">Not determined</span>
              ) : (
                <Money amount={rupees(s.funding.paise)} className="text-lg" />
              )}
              {s.funding.undeterminedRecords > 0 && (
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  Not determined for {s.funding.undeterminedRecords} card-linked or other-payer {s.funding.undeterminedRecords === 1 ? "record" : "records"} — excluded.
                </span>
              )}
            </Figure>
            <div className="flex min-w-0 flex-col gap-1 rounded-[8px] border border-border bg-secondary/40 p-3">
              <span className="text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">Still owed to me this month</span>
              <span className="text-xs text-muted-foreground">Open shares of installments due this month — not your whole People Ledger balance.</span>
              {!hasShared ? (
                <span className="text-sm text-muted-foreground">No shared installments this month.</span>
              ) : showReimbursement ? (
                <ReimbursementFigure records={records} window={window} />
              ) : (
                <button
                  type="button"
                  onClick={() => setShowReimbursement(true)}
                  className={cn(LE_RADIUS.input, "inline-flex h-8 w-fit items-center gap-1 border border-border-strong px-2.5 text-xs font-medium text-foreground outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring")}
                >
                  Load from People Ledger <ChevronDown className="size-3.5" />
                </button>
              )}
            </div>
          </div>

        </>
      )}

      {/* Overdue is reported whether or not the month itself has anything due. */}
      {s.overdue.mineInstallments > 0 && (
        <p className="border-t border-border pt-3 text-xs text-muted-foreground">
          <span className="font-semibold text-expense">Overdue carried:</span> my confirmed share{" "}
          <span className="font-semibold text-foreground tabular-nums">₹{rupees(s.overdue.minePaise).toLocaleString("en-IN")}</span> across {s.overdue.mineInstallments}{" "}
          {s.overdue.mineInstallments === 1 ? "installment" : "installments"} from earlier months — not included in the month above.
        </p>
      )}

      <EmiBreakdown rows={rows} summary={s} windowLabel={window.label} />
        </>
      )}

      <EmiListSheet open={sheet.open} onOpenChange={(open) => setSheet((s) => ({ ...s, open }))} tab={sheet.tab} onTabChange={(tab) => setSheet({ open: true, tab })} records={records} rows={rows} window={window} />
    </section>
  );
}
