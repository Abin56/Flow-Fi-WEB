"use client";

import { ChevronDown, Copy, FileDown, MessageCircle } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { usePersonCycleStatement } from "@/features/people/hooks/use-person-cycle-statement";
import { usePersonPendingSplitParticipants } from "@/features/people/hooks/use-person-pending-split-participants";
import { useSettlementLookups } from "@/features/people/hooks/use-settlement-lookups";
import { loadStatementAmountFonts, renderPersonStatementPdf, type StatementOrientation } from "@/features/people/lib/person-statement-pdf";
import { useMonthCycleStartDay } from "@/features/settings/hooks/use-user-preferences";
import {
  STATEMENT_COPY,
  statementDate,
  statementSections,
  statementSummaryCells,
  statementView,
  type StatementView,
  type StatementViewOptions,
  type StatementViewRow,
} from "@/features/people/lib/person-statement-pdf-model";
import { STATEMENT_CHIP, STATEMENT_INK, type StatementChip } from "@/features/people/lib/statement-palette";
import type { PersonCycleStatement } from "@/lib/engines/person-cycle-statement";
import { money, sharedPositionLine, statementShareText, whatsAppShareUrl } from "@/lib/engines/person-cycle-statement-share";
import type { SplitAllocation } from "@/lib/split/split-allocation";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/store/auth-store";
import { toast } from "@/store/toast-store";
import { StatementCalculation } from "../cycle-statement/statement-parts";
import { ModeFooter, ModeHeader, WS_PAD, WS_PRIMARY, WS_SECONDARY, WsLabel } from "./person-workspace-ui";

/**
 * Share mode — a preview of exactly what the PDF contains, drawn as the same landscape statement (header,
 * summary, every item with original / amount / paid / remaining and its status, split shares, payment history,
 * ending balance), plus WhatsApp / Copy / PDF. The preview and the PDF read one `statementView`; the text message is
 * the engine's summary.
 */
export function ShareStatementMode({
  statement,
  phone,
  onBack,
}: {
  statement: PersonCycleStatement;
  phone?: string | null;
  onBack: () => void;
}) {
  const [pdfBusy, setPdfBusy] = useState(false);
  const [messageOpen, setMessageOpen] = useState(false);
  // Read-only context that sharpens the wording (assigned vs split, later payments, accounts) — never a figure.
  const { allTimeStatement, ledgerEntries } = usePersonCycleStatement(statement.personId, statement.cycle);
  const { pending } = usePersonPendingSplitParticipants(statement.personId);
  const lookups = useSettlementLookups(ledgerEntries, pending);
  const cycleStartDay = useMonthCycleStartDay();
  // The statement is read by the person, so the owner is named from their profile — never "You".
  const ownerName = useAuthStore((s) => s.user?.displayName ?? null);
  const options = useMemo<StatementViewOptions>(
    () => ({ entries: ledgerEntries, history: allTimeStatement, lookups, accountForEntry: lookups.accountForEntry, cycleStartDay, ownerName }),
    [ledgerEntries, allTimeStatement, lookups, cycleStartDay, ownerName],
  );
  const view = useMemo(() => statementView(statement, options), [statement, options]);
  const text = statementShareText(statement);

  const copyText = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Statement copied");
    } catch {
      toast.error("Couldn't copy — your browser blocked clipboard access");
    }
  };

  const downloadPdf = async () => {
    setPdfBusy(true);
    try {
      // Amounts in Geist Mono with the real ₹; if the font can't load, the PDF still renders (Helvetica, "Rs.").
      const bytes = await renderPersonStatementPdf(statement, { ...options, orientation: statementOrientation(), amountFonts: await loadStatementAmountFonts() });
      const blob = new Blob([bytes as BlobPart], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `FlowFi-${statement.personName.replace(/[^\w]+/g, "-")}-${statement.cycleLabel.replace(/[^\w]+/g, "-")}.pdf`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      toast.error("Couldn't create the PDF");
    } finally {
      setPdfBusy(false);
    }
  };

  return (
    <div className="flex min-h-full flex-col">
      <ModeHeader backLabel="Close" onBack={onBack} onClose={onBack} title="Share Statement" subtitle={`${statement.personName} · ${statement.cycleLabel}`} />

      <div className={cn(WS_PAD, "mt-5 flex-1")}>
        <div className="grid gap-x-8 gap-y-6 lg:grid-cols-[minmax(0,1fr)_16rem]">
          <div className="min-w-0">
            {/* The statement as paper: a white A4-like document on a neutral desk, the same content as the PDF. */}
            <div className="rounded-[8px] bg-secondary/80 p-2 sm:p-5">
              <StatementDocument view={view} />
            </div>

            <details className="group mt-3">
              <summary className="flex cursor-pointer list-none items-center justify-between py-1 text-xs font-medium text-foreground/70 hover:text-foreground">
                Running calculation
                <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" strokeWidth={1.75} />
              </summary>
              <div className="mt-1.5 rounded-[6px] bg-secondary/60 p-3">
                <StatementCalculation statement={statement} />
              </div>
            </details>
          </div>

          {/* What gets sent */}
          <div className="min-w-0 lg:border-l lg:border-border lg:pl-6">
            <WsLabel>Sent as</WsLabel>
            <p className="mt-1.5 text-sm font-medium text-foreground">“{sharedPositionLine(statement)}”</p>
            <p className="mt-2 text-xs text-foreground/70">
              The PDF contains the full statement shown here. The WhatsApp / text message is a short summary.
            </p>
            <button
              type="button"
              aria-expanded={messageOpen}
              onClick={() => setMessageOpen((o) => !o)}
              className="mt-3 flex w-full items-center justify-between py-1 text-xs font-medium text-foreground/70 hover:text-foreground"
            >
              Message preview
              <ChevronDown className={cn("size-3.5 transition-transform", messageOpen && "rotate-180")} strokeWidth={1.75} />
            </button>
            <div
              className={cn(
                "grid transition-[grid-template-rows,opacity] duration-200 ease-out lg:grid-rows-[1fr] lg:opacity-100",
                messageOpen ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
              )}
            >
              <div className="overflow-hidden">
                <pre className="mt-1.5 max-h-72 overflow-y-auto rounded-[6px] border border-border bg-secondary/80 p-3 font-sans text-xs whitespace-pre-wrap text-foreground">
                  {text}
                </pre>
              </div>
            </div>
          </div>
        </div>
      </div>

      <ModeFooter className="justify-stretch sm:justify-end">
        <button type="button" onClick={copyText} className={cn(WS_SECONDARY, "flex-1 sm:flex-none")}>
          <Copy className="size-4" strokeWidth={1.75} />
          Copy Text
        </button>
        <button type="button" onClick={downloadPdf} disabled={pdfBusy} className={cn(WS_SECONDARY, "flex-1 sm:flex-none")}>
          <FileDown className="size-4" strokeWidth={1.75} />
          {pdfBusy ? "Creating…" : "PDF"}
        </button>
        <button
          type="button"
          onClick={() => window.open(whatsAppShareUrl(text, phone), "_blank", "noopener,noreferrer")}
          className={cn(WS_PRIMARY, "flex-1 sm:flex-none")}
        >
          <MessageCircle className="size-4" strokeWidth={1.75} />
          WhatsApp
        </button>
      </ModeFooter>
    </div>
  );
}

/**
 * Landscape everywhere, except a PDF made on a phone held upright: that one is laid out in portrait, because a
 * phone shows a landscape page as a thin strip and no file can make the device rotate.
 */
function statementOrientation(): StatementOrientation {
  if (typeof window === "undefined" || !window.matchMedia) return "landscape";
  return window.matchMedia("(pointer: coarse) and (orientation: portrait) and (max-width: 640px)").matches ? "portrait" : "landscape";
}

// ---------------------------------------------------------------------------------------------------
// The document — paper colours are fixed (it is a printed statement in both themes) and read from the same
// `statement-palette` tokens as the PDF, so the preview and the PDF carry one hierarchy and one status language.
// ---------------------------------------------------------------------------------------------------

const C = STATEMENT_INK;
const LABEL = "text-[10px] font-bold tracking-[0.07em] uppercase";
/** The transaction columns from the container's "wide" width up — the PDF's columns, in the same order. */
const TABLE_COLS = "@[46rem]:grid-cols-[1.75rem_5.2rem_minmax(0,1fr)_6rem_6.4rem_5.6rem_6.2rem_7.8rem]";
const PAY_COLS = "@[46rem]:grid-cols-[5.2rem_minmax(0,1fr)_minmax(0,1.25fr)_7rem]";

function Chip({ tone, children }: { tone: StatementChip; children: ReactNode }) {
  const t = STATEMENT_CHIP[tone];
  return (
    <span
      data-chip={tone}
      className="inline-flex h-[18px] shrink-0 items-center rounded-full border px-2 text-[10.5px] leading-none font-semibold whitespace-nowrap"
      style={{ background: t.fill, color: t.text, borderColor: t.edge }}
    >
      <span aria-hidden className="mr-1.5 size-[5px] rounded-full" style={{ background: t.text }} />
      {children}
    </span>
  );
}

export function StatementDocument({ view }: { view: StatementView }) {
  const settled = view.direction === "settled";
  const cells = statementSummaryCells(view);
  const { previous, showPrevious, groupOf } = statementSections(view);
  const count = view.carried.length + view.rows.length;
  const empty = STATEMENT_COPY.empty;
  const zero = money(0);

  return (
    <article
      aria-label={`People Settlement Statement for ${view.personName}, ${view.cycleLabel}`}
      className="@container mx-auto w-full max-w-[66rem] rounded-[3px] bg-white px-4 py-5 shadow-[0_1px_2px_rgba(0,0,0,0.08),0_12px_32px_-16px_rgba(0,0,0,0.28)] sm:px-8 sm:py-7"
      style={{ color: C.ink }}
    >
      {/* The navy band across the top of the page, as on every PDF page */}
      <div aria-hidden className="-mx-4 -mt-5 mb-5 h-1.5 rounded-t-[3px] sm:-mx-8 sm:-mt-7 sm:mb-6" style={{ background: C.navy }} />
      {/* Brand */}
      <div className="relative flex items-baseline justify-between gap-4 border-b pb-2" style={{ borderColor: C.rule }}>
        <p className="flex min-w-0 items-baseline gap-2.5">
          <span className="text-[19px] leading-none font-bold tracking-tight" style={{ color: C.navy }}>
            FlowFi
          </span>
          <span className="truncate border-l pl-2.5 text-[13px]" style={{ borderColor: C.rule, color: C.body }}>
            People Settlement Statement
          </span>
        </p>
        <p className="shrink-0 text-[11px]" style={{ color: C.muted }}>
          Generated {view.asOf}
        </p>
        <span className="absolute -bottom-px left-0 h-[2px] w-12" style={{ background: C.navy }} aria-hidden />
      </div>

      {/* Who, which period, as of when */}
      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 @[46rem]:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_auto] @[46rem]:items-end">
        <div className="col-span-2 min-w-0 @[46rem]:col-span-1">
          <dt className={cn(LABEL, "text-[9.5px]")} style={{ color: C.muted }}>
            Statement for
          </dt>
          <dd className="text-[20px] leading-tight font-bold break-words">{view.personName}</dd>
        </div>
        <div className="min-w-0">
          <dt className={cn(LABEL, "text-[9.5px]")} style={{ color: C.muted }}>
            Period
          </dt>
          <dd className="text-[14px] break-words">{view.cycleLabel}</dd>
        </div>
        <div className="min-w-0">
          <dt className={cn(LABEL, "text-[9.5px]")} style={{ color: C.muted }}>
            Amounts as of
          </dt>
          <dd className="text-[14px]">{view.asOf}</dd>
        </div>
        <p className="col-span-2 text-[11.5px] break-words @[46rem]:col-span-1 @[46rem]:text-right" style={{ color: C.muted }}>
          Prepared by {view.ownerName}
        </p>
      </dl>

      {/* Summary — one panel read as a sum, ending in the balance; an advance is held apart after it */}
      <dl className="mt-3 grid grid-cols-2 overflow-hidden rounded-[5px] border @[46rem]:flex" style={{ borderColor: C.ruleStrong }}>
        {cells.map((c, i) => (
          <div
            key={`${i}-${c.label}`}
            data-current={c.current || undefined}
            className={cn(
              "relative min-w-0 px-3.5 py-2.5",
              c.current ? "order-first col-span-2 border-l-[3px] @[46rem]:order-none @[46rem]:flex-[1.5]" : "@[46rem]:flex-1",
              c.advance && "col-span-2 @[46rem]:flex-[1.1]",
              !c.current && !c.advance && i > 0 && "@[46rem]:border-l",
            )}
            style={{
              borderColor: c.current ? C.navy : C.rule,
              background: c.current ? C.navyTint : c.advance ? C.advanceTint : undefined,
            }}
          >
            {c.op && !c.current && (
              <span aria-hidden className="absolute top-[1.55rem] left-1 hidden text-[14px] leading-none @[46rem]:block" style={{ color: C.muted }}>
                {c.op}
              </span>
            )}
            <dt className={cn(LABEL, "text-[9.5px] @[46rem]:pl-1.5")} style={{ color: c.current ? C.navy : c.advance ? C.advance : C.muted }}>
              {c.label}
            </dt>
            <dd
              className={cn("mt-0.5 font-mono font-bold break-all tabular-nums @[46rem]:pl-1.5", c.current ? "text-[22px] leading-tight" : "text-[14px]", !c.current && c.value === zero && "font-normal")}
              style={{ color: c.current ? (settled ? STATEMENT_CHIP.paid.text : C.navy) : c.advance ? C.advance : c.value === zero ? C.muted : C.ink }}
            >
              {c.value}
            </dd>
            {c.note && (
              <dd className={cn("leading-snug break-words @[46rem]:pl-1.5", c.current ? "text-[12px]" : "text-[10.5px]")} style={{ color: c.current ? C.body : C.muted }}>
                {c.note}
              </dd>
            )}
          </div>
        ))}
      </dl>
      {/* Settlement progress — how much of the total due is cleared, with the cash note beside it */}
      {(view.settleProgress || view.cashNote) && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px]">
          {view.settleProgress && (
            <>
              <span className={cn(LABEL, "text-[9.5px]")} style={{ color: C.muted }}>
                Settlement
              </span>
              <span
                role="progressbar"
                aria-label="Settlement progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(view.settleProgress.ratio * 100)}
                className="relative h-[6px] w-full max-w-[22rem] min-w-[8rem] flex-1 overflow-hidden rounded-full border"
                style={{ background: C.head, borderColor: C.rule }}
              >
                <span
                  className="absolute inset-y-0 left-0 rounded-full"
                  style={{ width: `${view.settleProgress.ratio * 100}%`, background: view.settleProgress.ratio >= 1 ? STATEMENT_CHIP.paid.text : C.navy }}
                />
              </span>
              <span style={{ color: view.settleProgress.ratio >= 1 ? STATEMENT_CHIP.paid.text : C.body }}>
                {view.settleProgress.label}
              </span>
            </>
          )}
          {view.cashNote && (
            <span className="ml-auto" style={{ color: C.muted }}>
              {view.cashNote}
            </span>
          )}
        </div>
      )}

      {/* Transactions — one connected panel: column header, sections, rows */}
      <h3 className="mt-5 flex items-baseline gap-2.5 text-[15px] font-bold">
        Transactions
        <span className="text-[11.5px] font-normal" style={{ color: C.muted }}>
          {count} {count === 1 ? "item" : "items"}
        </span>
      </h3>
      <div className="mt-1.5 overflow-hidden rounded-[5px] border" style={{ borderColor: C.ruleStrong }}>
        <div
          className={cn("hidden border-b py-1.5 @[46rem]:grid", TABLE_COLS, LABEL, "text-[9.5px]")}
          style={{ background: C.head, borderColor: C.ruleStrong, color: C.body }}
          aria-hidden
        >
          <span className="pr-2 text-right">#</span>
          <span className="px-2">Date</span>
          <span className="px-2">Description</span>
          <span className="px-2 text-right">Original</span>
          <span className="px-2 text-right">{view.amountHeader}</span>
          <span className="px-2 text-right">Paid</span>
          <span className="px-2 text-right">Remaining</span>
          <span className="px-2">Status</span>
        </div>
        {showPrevious && (
          <>
            <CarryForwardRow value={previous?.value ?? null} side={previous?.side ?? null} />
            <RowGroup rows={view.carried} view={view} groupOf={groupOf} />
            <CycleBand note={view.rows.length ? view.cycleLabel : `${view.cycleLabel} · ${empty}`} />
          </>
        )}
        {!showPrevious && view.rows.length === 0 && <CycleBand note={`${view.cycleLabel} · ${empty}`} />}
        <RowGroup rows={view.rows} view={view} groupOf={groupOf} />
      </div>

      {view.payments.length > 0 && <PaymentHistory view={view} />}

      {/* Ending balance — the statement's conclusion */}
      <section
        aria-label="Ending balance"
        className="mt-4 flex flex-wrap items-end justify-between gap-x-6 gap-y-2 rounded-[5px] border border-l-[3px] px-4 py-3"
        style={{ background: C.navyTint, borderColor: C.navyRule, borderLeftColor: C.navy }}
      >
        <div className="min-w-0">
          <p className={LABEL} style={{ color: C.navy }}>
            Ending balance
          </p>
          <p className="mt-0.5 text-[15px] font-bold break-words">{settled ? "Settled — nothing left to settle" : view.headline}</p>
        </div>
        <div className="min-w-0 @[36rem]:text-right">
          <p className={LABEL} style={{ color: C.navy }}>
            {settled ? "Nothing due" : "Amount due"}
          </p>
          <p className="font-mono text-[22px] leading-tight font-bold break-all tabular-nums" style={{ color: settled ? STATEMENT_CHIP.paid.text : C.navy }}>
            {view.amount}
          </p>
        </div>
      </section>

      {/* Footer */}
      <footer className="mt-6 flex flex-wrap justify-between gap-x-4 gap-y-1 border-t pt-2 text-[10.5px]" style={{ borderColor: C.rule, color: C.muted }}>
        <span className="min-w-0 break-words">
          FlowFi · Statement for {view.personName} · {view.cycleLabel}
        </span>
        <span className="min-w-0 break-words">Prepared by {view.ownerName}</span>
      </footer>
    </article>
  );
}

/** A list of rows with a group heading (the cycle a brought-forward row came from, or the month) wherever it changes. */
function RowGroup({ rows, view, groupOf }: { rows: StatementViewRow[]; view: StatementView; groupOf: (r: StatementViewRow) => string | null }) {
  if (rows.length === 0) return null;
  return (
    <ul>
      {rows.map((r, i) => (
        <li key={`${r.carried ? "c" : "r"}${r.no}`}>
          {groupOf(r) && groupOf(r) !== (i > 0 ? groupOf(rows[i - 1]) : null) && (
            <p className={cn(LABEL, "border-b px-2.5 py-1 @[46rem]:pl-[7.45rem]")} style={{ background: C.surface, borderColor: C.rule, color: C.navy }}>
              {groupOf(r)}
            </p>
          )}
          <StatementRow row={r} view={view} />
        </li>
      ))}
    </ul>
  );
}

/** The previous balance as one carry-forward line, before the obligations it is made of. */
function CarryForwardRow({ value, side }: { value: string | null; side: string | null }) {
  return (
    <div className={cn("grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 border-b px-2.5 py-2 @[46rem]:gap-x-0 @[46rem]:px-0", TABLE_COLS)} style={{ background: C.surface, borderColor: C.rule }}>
      <div className="min-w-0 @[46rem]:col-span-4 @[46rem]:col-start-3 @[46rem]:px-2">
        <p className={cn(LABEL, "text-[10.5px]")} style={{ color: STATEMENT_CHIP.carried.text }}>
          {STATEMENT_COPY.carried.label}
        </p>
        <p className="text-[11.5px]" style={{ color: C.muted }}>
          {[STATEMENT_COPY.carried.note, side].filter(Boolean).join(" · ")}
        </p>
      </div>
      <p className="text-right font-mono text-[13px] font-bold tabular-nums @[46rem]:col-start-7 @[46rem]:px-2">{value}</p>
      <div className="col-span-2 mt-1 @[46rem]:col-span-1 @[46rem]:col-start-8 @[46rem]:mt-0 @[46rem]:px-2">
        <Chip tone="carried">Brought forward</Chip>
      </div>
    </div>
  );
}

/** THIS CYCLE: a navy-tinted divider row with the cycle — and, when nothing is new, the notice itself. */
function CycleBand({ note }: { note: string }) {
  return (
    <p className="flex flex-wrap items-baseline gap-x-3 border-b px-2.5 py-1.5 text-[11.5px] @[46rem]:pl-[7.45rem]" style={{ background: C.navyTint, borderColor: C.navyRule, color: C.body }}>
      <span className={LABEL} style={{ color: C.navy }}>
        {STATEMENT_COPY.current}
      </span>
      <span>{note}</span>
    </p>
  );
}

/**
 * One transaction — the PDF row's architecture: # and date, the title with one quiet meta line, then Original
 * (only for a split, where it differs from the amount) / Amount (captioned with whose share it is beside an
 * Original) / Paid / Remaining, and the status chip. A genuine split (2+ people) adds a connected shares line.
 * Wide: a table row. Narrow: a stacked record with the figures in a labelled line.
 */
function StatementRow({ row: r, view }: { row: StatementViewRow; view: StatementView }) {
  const a = r.allocation ?? null;
  const shares = a != null && a.participants.length >= 2 ? a : null;
  const mismatch = a && !shares && !a.reconciles && a.participants.length > 0;
  const split = r.purchase != null || shares != null;
  const date = statementDate(view, r.date);
  const zero = money(0);
  const remainingTone = !r.remaining || r.remaining === zero ? C.muted : r.chip === "overdue" ? STATEMENT_CHIP.overdue.text : C.ink;
  return (
    <div
      data-carried={r.carried || undefined}
      data-split={split || undefined}
      className="border-b"
      style={{ borderColor: C.rule, boxShadow: split ? `inset 2px 0 0 ${C.split}` : undefined }}
    >
      <div className={cn("relative isolate grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 px-2.5 py-2.5 @[46rem]:gap-x-0 @[46rem]:px-0", TABLE_COLS)}>
        {/* Wide: dividers framing the money columns, and the Remaining column's faint band. */}
        <span aria-hidden className={cn("pointer-events-none absolute inset-0 -z-10 hidden @[46rem]:grid", TABLE_COLS)}>
          <span className="col-start-4 border-l" style={{ borderColor: C.rule }} />
          <span className="col-start-7" style={{ background: C.remainTint }} />
          <span className="col-start-8 border-l" style={{ borderColor: C.rule }} />
        </span>
        <p className="col-span-2 text-[11px] tabular-nums @[46rem]:contents" style={{ color: C.muted }}>
          <span className="@[46rem]:pt-px @[46rem]:pr-2 @[46rem]:text-right">{r.no}</span>
          <span className="@[46rem]:hidden"> · </span>
          <span className="@[46rem]:px-2 @[46rem]:pt-px @[46rem]:text-[12px]" style={{ color: C.ink }}>
            {date.day}
            {date.year && (
              <span className="@[46rem]:block @[46rem]:text-[10.5px]" style={{ color: C.muted }}>
                {" "}
                {date.year}
              </span>
            )}
          </span>
        </p>

        <div className="row-start-2 min-w-0 @[46rem]:col-start-3 @[46rem]:row-start-1 @[46rem]:px-2">
          <p className="text-[13.5px] leading-snug break-words">{r.title}</p>
          <p className="text-[11px] leading-snug break-words" style={{ color: C.muted }}>
            {r.metaLine}
          </p>
          {mismatch && (
            <p className="text-[10.5px] tabular-nums" style={{ color: C.muted }}>
              Allocated {money(a.allocated)} of {money(a.original)}
            </p>
          )}
        </div>

        <div className="row-start-2 flex min-w-0 flex-col items-end @[46rem]:col-start-8 @[46rem]:row-start-1 @[46rem]:items-start @[46rem]:px-2">
          <Chip tone={r.chip}>{r.status}</Chip>
          {r.statusNote && (
            <span className="mt-0.5 text-right text-[10.5px] leading-snug @[46rem]:text-left" style={{ color: C.muted }}>
              {r.statusNote}
            </span>
          )}
        </div>

        <dl
          className={cn("col-span-2 row-start-3 mt-1 grid gap-x-3 rounded-[4px] px-2.5 py-1.5 font-mono text-[12.5px] tabular-nums @[46rem]:contents", r.purchase ? "grid-cols-4" : "grid-cols-3")}
          style={{ background: C.surface }}
        >
          {r.purchase && (
            <div className="min-w-0 @[46rem]:col-start-4 @[46rem]:row-start-1 @[46rem]:px-2 @[46rem]:text-right">
              <dt className="font-sans text-[10.5px] @[46rem]:sr-only" style={{ color: C.muted }}>
                Original
              </dt>
              <dd className="whitespace-nowrap" style={{ color: C.body }}>
                {r.purchase}
              </dd>
              <dd className="font-sans text-[10.5px] whitespace-nowrap" style={{ color: C.muted }}>
                {r.purchaseNote}
              </dd>
            </div>
          )}
          <div className="min-w-0 @[46rem]:col-start-5 @[46rem]:row-start-1 @[46rem]:px-2 @[46rem]:text-right">
            <dt className="font-sans text-[10.5px] @[46rem]:sr-only" style={{ color: C.muted }}>
              Amount
            </dt>
            <dd className="font-bold whitespace-nowrap" style={{ color: r.original ? C.ink : C.muted }}>
              {r.original || "—"}
            </dd>
            {r.shareLabel && (
              <dd className="font-sans text-[10.5px] whitespace-nowrap" style={{ color: C.muted }}>
                {r.shareLabel}
              </dd>
            )}
          </div>
          <div className="min-w-0 @[46rem]:col-start-6 @[46rem]:row-start-1 @[46rem]:px-2 @[46rem]:text-right">
            <dt className="font-sans text-[10.5px] @[46rem]:sr-only" style={{ color: C.muted }}>
              Paid
            </dt>
            <dd className="whitespace-nowrap" style={{ color: !r.paid || r.paid === zero ? C.muted : STATEMENT_CHIP.paid.text }}>
              {r.paid && r.paid !== zero ? r.paid : "—"}
            </dd>
          </div>
          <div className="min-w-0 @[46rem]:col-start-7 @[46rem]:row-start-1 @[46rem]:px-2 @[46rem]:text-right">
            <dt className="font-sans text-[10.5px] @[46rem]:sr-only" style={{ color: C.muted }}>
              Remaining
            </dt>
            <dd className={cn("whitespace-nowrap", r.remaining && r.remaining !== zero && "font-bold")} style={{ color: remainingTone }}>
              {r.remaining || "—"}
            </dd>
            {r.progress != null && (
              <dd aria-hidden className="mt-1 ml-auto h-[4px] w-full max-w-[5rem] overflow-hidden rounded-full border" style={{ background: "#fff", borderColor: C.rule }}>
                <span className="block h-full rounded-full" style={{ width: `${r.progress * 100}%`, background: STATEMENT_CHIP.partial.edge }} />
              </dd>
            )}
          </div>
        </dl>
      </div>
      {shares && <SharesLine allocation={shares} />}
    </div>
  );
}

/** A genuine split's stored allocation as one connected line: every participant's share, the recipient's in bold. */
function SharesLine({ allocation: a }: { allocation: SplitAllocation }) {
  return (
    <section
      aria-label="Shares"
      className="flex flex-wrap items-baseline gap-x-4 gap-y-0.5 border-t px-2.5 py-1 text-[12px] tabular-nums @[46rem]:ml-[7.45rem] @[46rem]:px-2"
      style={{ background: C.splitTint, borderColor: C.navyRule }}
    >
      <span className={cn(LABEL, "text-[9.5px]")} style={{ color: C.split }}>
        Shares
      </span>
      <dl className="contents">
        {a.participants.map((p) => (
          <div key={p.key} data-focus={p.isFocus || undefined} className="flex min-w-0 items-baseline gap-1.5">
            <dt className={cn("min-w-0 break-words", p.isFocus && "font-semibold")} style={{ color: p.isFocus ? C.ink : C.body }}>
              {p.label}
            </dt>
            <dd className="font-mono font-semibold whitespace-nowrap" style={{ color: p.amount === 0 ? C.muted : C.ink }}>
              {money(p.amount)}
            </dd>
          </div>
        ))}
      </dl>
      {!a.reconciles && (
        <span className="text-[10.5px]" style={{ color: C.muted }}>
          Allocated {money(a.allocated)} of {money(a.original)}
        </span>
      )}
    </section>
  );
}

function PaymentHistory({ view }: { view: StatementView }) {
  const first = view.personName.split(" ")[0];
  const totals = [view.totalReceived && { label: `Total paid by ${first}`, value: view.totalReceived }, view.totalPaid && { label: `Total paid by ${view.ownerShort}`, value: view.totalPaid }].filter(
    Boolean,
  ) as { label: string; value: string }[];
  return (
    <section aria-label="Payment history" className="mt-5">
      <h3 className="flex items-baseline gap-2.5 text-[15px] font-bold">
        Payment history
        <span className="text-[11.5px] font-normal" style={{ color: C.muted }}>
          Payments this cycle and where each one went
        </span>
      </h3>
      <div className="mt-1.5 overflow-hidden rounded-[5px] border" style={{ borderColor: C.ruleStrong }}>
        <div className={cn("hidden border-b px-2.5 py-1.5 @[46rem]:grid", PAY_COLS, LABEL, "text-[9.5px]")} style={{ background: C.head, borderColor: C.ruleStrong, color: C.body }} aria-hidden>
          <span>Date</span>
          <span>Payment</span>
          <span>Applied to</span>
          <span className="text-right">Amount</span>
        </div>
        <ul>
          {view.payments.map((p, i) => (
            <li key={i} className={cn("grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 border-b px-2.5 py-2 text-[12px]", PAY_COLS)} style={{ borderColor: C.rule }}>
              <span className="col-span-2 tabular-nums @[46rem]:col-span-1" style={{ color: C.body }}>
                {p.date}
              </span>
              <p className="min-w-0 text-[13px] break-words">
                {p.label}
                {p.account && <span style={{ color: C.muted }}> · {p.account}</span>}
              </p>
              <span className="text-right font-mono font-bold whitespace-nowrap tabular-nums @[46rem]:order-last" style={{ color: p.inbound ? STATEMENT_CHIP.paid.text : C.ink }}>
                {p.amount}
              </span>
              <div className="col-span-2 min-w-0 text-[11.5px] @[46rem]:col-span-1 @[46rem]:pr-6">
                {p.single != null ? (
                  <p className="break-words" style={{ color: C.body }}>
                    {p.single}
                  </p>
                ) : (
                  <>
                    {p.applied.map((a, j) => (
                      <p key={j} className="flex justify-between gap-3 tabular-nums" style={{ color: C.body }}>
                        <span className="min-w-0 break-words">{a.label}</span>
                        <span className="font-mono whitespace-nowrap" style={{ color: C.ink }}>
                          {a.amount}
                        </span>
                      </p>
                    ))}
                    {p.applied.length > 1 && (
                      <p className="mt-0.5 flex justify-between gap-3 border-t pt-0.5 font-semibold tabular-nums" style={{ borderColor: C.rule }}>
                        <span>Applied to obligations</span>
                        <span>{p.appliedTotal}</span>
                      </p>
                    )}
                    {p.held && (
                      <p className="flex justify-between gap-3 font-semibold tabular-nums" style={{ color: C.advance }}>
                        <span>Held as advance</span>
                        <span>{p.held}</span>
                      </p>
                    )}
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
        {totals.map((t) => (
          <p key={t.label} className="flex justify-end gap-6 px-2.5 py-1.5 text-[12px] font-semibold tabular-nums" style={{ background: C.surface }}>
            <span>{t.label}</span>
            <span className="min-w-[7rem] text-right font-mono">{t.value}</span>
          </p>
        ))}
      </div>
    </section>
  );
}
