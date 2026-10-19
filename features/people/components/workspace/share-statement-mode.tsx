"use client";

import { ChevronDown, Copy, FileDown, MessageCircle } from "lucide-react";
import { useContext, useMemo, useState, type ReactNode } from "react";
import { usePersonCycleStatement } from "@/features/people/hooks/use-person-cycle-statement";
import { usePersonPendingSplitParticipants } from "@/features/people/hooks/use-person-pending-split-participants";
import { useSettlementLookups } from "@/features/people/hooks/use-settlement-lookups";
import { renderMonthlySettlementPdf } from "@/features/people/lib/monthly-settlement-pdf";
import { loadStatementAmountFonts, loadStatementTextFonts, renderPersonStatementPdf, type StatementOrientation } from "@/features/people/lib/person-statement-pdf";
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
import { cycleContaining, type PersonCycleStatement } from "@/lib/engines/person-cycle-statement";
import { cycleName } from "@/lib/engines/person-payment-deferral";
import { money, sharedPositionLine, statementShareText, whatsAppShareUrl } from "@/lib/engines/person-cycle-statement-share";
import type { SplitAllocation } from "@/lib/split/split-allocation";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/store/auth-store";
import { toast } from "@/store/toast-store";
import { StatementCalculation } from "../cycle-statement/statement-parts";
import { DeferralContext } from "./payment-deferral";
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
  // A postponed obligation says so on the statement ("Moved to Nov cycle") — the same live deferral the ledger rows read.
  const deferrals = useContext(DeferralContext);
  const options = useMemo<StatementViewOptions>(
    () => ({
      entries: ledgerEntries,
      history: allTimeStatement,
      lookups,
      accountForEntry: lookups.accountForEntry,
      cycleStartDay,
      ownerName,
      deferralFor: (key, date) => {
        const v = deferrals?.byKey.get(key);
        if (!v || v.status === "resolved") return null;
        return { status: v.status, name: cycleName(v.cycle), from: cycleName(cycleContaining(date, deferrals?.cycleStartDay ?? cycleStartDay)) };
      },
    }),
    [ledgerEntries, allTimeStatement, lookups, cycleStartDay, ownerName, deferrals],
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

  /** "monthly": the short settlement for this cycle (what gets shared). "full": the complete statement shown in the preview. */
  const downloadPdf = async (mode: "monthly" | "full" = "monthly") => {
    setPdfBusy(true);
    try {
      // Words in Plus Jakarta Sans, amounts in Geist Mono with the real ₹; if a font can't load, the PDF still
      // renders (Helvetica, "Rs.").
      const [amountFonts, textFonts] = await Promise.all([loadStatementAmountFonts(), loadStatementTextFonts()]);
      const bytes =
        mode === "monthly"
          ? await renderMonthlySettlementPdf(statement, { ...options, amountFonts, textFonts })
          : await renderPersonStatementPdf(statement, { ...options, orientation: statementOrientation(), amountFonts, textFonts });
      const blob = new Blob([bytes as BlobPart], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `FlowFi-${statement.personName.replace(/[^\w]+/g, "-")}-${statement.cycleLabel.replace(/[^\w]+/g, "-")}${mode === "full" ? "-Full" : ""}.pdf`;
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
              Monthly PDF is the short settlement for this cycle — the one to share. Full PDF is the complete statement shown here. The WhatsApp / text message is a short summary.
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
        <button type="button" onClick={() => downloadPdf("full")} disabled={pdfBusy} className={cn(WS_SECONDARY, "flex-1 sm:flex-none")}>
          <FileDown className="size-4" strokeWidth={1.75} />
          Full PDF
        </button>
        <button type="button" onClick={() => downloadPdf("monthly")} disabled={pdfBusy} className={cn(WS_SECONDARY, "flex-1 sm:flex-none")}>
          <FileDown className="size-4" strokeWidth={1.75} />
          {pdfBusy ? "Creating…" : "Monthly PDF"}
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
/** Small-caps signpost labels — tracked, as in the PDF. */
const LABEL = "text-[9.5px] font-semibold tracking-[0.12em] uppercase";
/** The transaction columns from the container's "wide" width up — the PDF's columns, in the same order. */
const TABLE_COLS = "@[46rem]:grid-cols-[1.75rem_5.2rem_minmax(0,1fr)_6rem_6.4rem_5.6rem_6.2rem_9rem]";
const PAY_COLS = "@[46rem]:grid-cols-[5.2rem_minmax(0,1fr)_minmax(0,1.25fr)_7rem]";
/** Fine concentric rings on midnight — the header band's guilloché, as in the PDF. */
const RINGS = `repeating-radial-gradient(circle at 100% 70%, transparent 0 21px, ${C.midnightLine} 21px 22px)`;

/** The status icon per chip family — the same strokes the PDF draws (10×10 box). */
function StatusIcon({ tone }: { tone: StatementChip }) {
  const ring = <circle cx="5" cy="5" r="4" />;
  const paths: Partial<Record<StatementChip, ReactNode>> = {
    due: (
      <>
        {ring}
        <path d="M5 2.8V5.2L6.6 6.2" />
      </>
    ),
    paid: <path d="M1.8 5.4 4.1 7.6 8.4 2.8" />,
    partial: (
      <>
        {ring}
        <path d="M5 1A4 4 0 0 1 5 9Z" fill="currentColor" stroke="none" />
      </>
    ),
    overdue: (
      <>
        {ring}
        <path d="M5 2.7V5.6" />
        <circle cx="5" cy="7.3" r="0.6" fill="currentColor" stroke="none" />
      </>
    ),
    upcoming: <path d="M1.8 5H8.2M5.6 2.4 8.2 5 5.6 7.6" />,
    carried: <path d="M8 2.2V4.9Q8 7 5.9 7H2.2M4.3 4.9 2.2 7 4.3 9.1" />,
    advance: (
      <>
        {ring}
        <path d="M5 3V7M3 5H7" />
      </>
    ),
  };
  return (
    <svg aria-hidden viewBox="0 0 10 10" className="size-[11px] shrink-0" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      {paths[tone] ?? <circle cx="5" cy="5" r="1.8" fill="currentColor" stroke="none" />}
    </svg>
  );
}

/** A status tag: a soft tinted fill with a hairline edge, its icon, and the status in semibold — as in the PDF. */
function Chip({ tone, children }: { tone: StatementChip; children: ReactNode }) {
  const t = STATEMENT_CHIP[tone];
  return (
    <span
      data-chip={tone}
      className="inline-flex h-[21px] shrink-0 items-center gap-1.5 rounded-[6px] border pr-2 pl-1.5 text-[10.5px] leading-none font-semibold whitespace-nowrap"
      style={{ background: t.fill, color: t.text, borderColor: t.edge }}
    >
      <StatusIcon tone={tone} />
      {children}
    </span>
  );
}

/** "+ / − / =" in a small ring on a boundary — the reconciliation read as one sum. */
function Operator({ op, className }: { op: "+" | "−" | "="; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("absolute top-1/2 left-0 z-10 hidden size-[18px] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border bg-white text-[12px] leading-none @[46rem]:flex", className)}
      style={{ borderColor: C.ruleStrong, color: C.muted }}
    >
      {op}
    </span>
  );
}

/** A section's title: a short champagne marker, the title, a quiet caption. */
function SectionTitle({ title, caption }: { title: string; caption: ReactNode }) {
  return (
    <h3 className="flex items-baseline gap-2.5 text-[16px] font-bold tracking-tight">
      <span aria-hidden className="h-[14px] w-[3px] self-center rounded-full" style={{ background: C.gold }} />
      {title}
      <span className="text-[11.5px] font-normal tracking-normal" style={{ color: C.muted }}>
        {caption}
      </span>
    </h3>
  );
}

export function StatementDocument({ view }: { view: StatementView }) {
  const settled = view.direction === "settled";
  const cells = statementSummaryCells(view);
  const { previous, showPrevious, groupOf } = statementSections(view);
  const count = view.carried.length + view.rows.length;
  const empty = STATEMENT_COPY.empty;
  const zero = money(0);
  const totals = view.totals;

  return (
    <article
      aria-label={`People Settlement Statement for ${view.personName}, ${view.cycleLabel}`}
      className="@container mx-auto w-full max-w-[66rem] overflow-hidden rounded-[6px] bg-white shadow-[0_1px_2px_rgba(15,23,38,0.08),0_18px_40px_-20px_rgba(15,23,38,0.35)]"
      style={{ color: C.ink }}
    >
      {/* Header band — midnight, as on the PDF's first page: brand, who it is for, the period, and the answer */}
      <header className="relative overflow-hidden px-4 pt-4 pb-5 sm:px-8 sm:pt-5" style={{ background: C.midnight, borderBottom: `2px solid ${C.gold}` }}>
        <span aria-hidden className="pointer-events-none absolute inset-y-0 right-0 hidden w-[55%] opacity-90 @[46rem]:block" style={{ backgroundImage: RINGS, maskImage: "linear-gradient(to right, transparent, #000 35%, #000 55%, transparent 80%)" }} />
        <div className="relative flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <p className="flex min-w-0 items-center gap-2.5">
            <span className="text-[19px] leading-none font-extrabold tracking-tight text-white">FlowFi</span>
            <span aria-hidden className="h-3.5 w-px" style={{ background: C.gold }} />
            <span className={cn(LABEL, "truncate tracking-[0.18em]")} style={{ color: C.goldLight }}>
              People Settlement Statement
            </span>
          </p>
          <p className={LABEL} style={{ color: C.onMidnightMuted }}>
            Generated {view.asOf}
          </p>
        </div>
        <div className="relative mt-4 flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
          <div className="min-w-0">
            <p className={LABEL} style={{ color: C.onMidnightMuted }}>
              Statement for
            </p>
            <p className="mt-0.5 text-[26px] leading-tight font-bold tracking-tight break-words text-white">{view.personName}</p>
            <dl className="mt-1.5 flex flex-wrap gap-x-5 gap-y-1 text-[12.5px]">
              {(
                [
                  ["Period", view.cycleLabel],
                  ["Amounts as of", view.asOf],
                ] as const
              ).map(([label, value]) => (
                <div key={label} className="flex items-baseline gap-2">
                  <dt className={LABEL} style={{ color: C.onMidnightMuted }}>
                    {label}
                  </dt>
                  <dd className="font-medium" style={{ color: C.onMidnight }}>
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
          <div className="min-w-0 @[36rem]:text-right">
            <p className={cn(LABEL, "tracking-[0.16em]")} style={{ color: C.goldLight }}>
              {view.current.label}
            </p>
            <p className="font-mono text-[32px] leading-none font-bold tracking-tight break-all tabular-nums" style={{ color: settled ? C.settledOnMidnight : "#fff" }}>
              {view.amount}
            </p>
            <p className="mt-1.5 text-[12.5px] font-medium" style={{ color: C.onMidnight }}>
              {settled ? "Nothing left to settle" : view.headline}
            </p>
          </div>
        </div>
      </header>

      <div className="px-4 pt-5 pb-5 sm:px-8 sm:pb-7">
        {/* Reconciliation — one card read as a sum, ending in the balance; an advance is held apart after it */}
        <dl className="grid grid-cols-2 rounded-[8px] border @[46rem]:flex" style={{ borderColor: C.ruleStrong }}>
          {cells.map((c, i) => (
            <div
              key={`${i}-${c.label}`}
              data-current={c.current || undefined}
              className={cn(
                "relative min-w-0 px-4 py-3",
                // Narrow: the header band right above already states the balance, so the card keeps only the sum.
                c.current ? "hidden border-l-[3px] @[46rem]:block @[46rem]:flex-[1.4] @[46rem]:rounded-r-[7px]" : "@[46rem]:flex-1",
                c.advance && "col-span-2 @[46rem]:flex-[1.1] @[46rem]:rounded-r-[7px]",
                !c.current && !c.advance && i > 0 && "@[46rem]:border-l",
              )}
              style={{
                borderColor: c.current ? C.navy : C.rule,
                background: c.current ? C.navyTint : c.advance ? C.advanceTint : undefined,
              }}
            >
              {c.op && i > 0 && <Operator op={c.op} />}
              <dt className={LABEL} style={{ color: c.current ? C.navy : c.advance ? C.advance : C.muted }}>
                {c.label}
              </dt>
              <dd
                className={cn("mt-1 font-mono font-bold break-all tabular-nums", c.current ? "text-[20px] leading-tight" : "text-[15px]", !c.current && c.value === zero && "font-normal")}
                style={{ color: c.current ? (settled ? STATEMENT_CHIP.paid.text : C.navy) : c.advance ? C.advance : c.value === zero ? C.faint : C.ink }}
              >
                {c.value}
              </dd>
              {/* The header band states who owes whom; the card's answer says when it was read. */}
              {(c.current || c.note) && (
                <dd className="text-[10.5px] leading-snug break-words" style={{ color: c.current ? C.body : C.muted }}>
                  {c.current ? `As of ${view.asOf}` : c.note}
                </dd>
              )}
            </div>
          ))}
        </dl>
        {/* Settlement progress — how much of the total due is cleared, with the cash note beside it */}
        {(view.settleProgress || view.cashNote) && (
          <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px]">
            {view.settleProgress && (
              <>
                <span className={LABEL} style={{ color: C.muted }}>
                  Settlement
                </span>
                <span
                  role="progressbar"
                  aria-label="Settlement progress"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(view.settleProgress.ratio * 100)}
                  className="relative h-[6px] w-full max-w-[22rem] min-w-[8rem] flex-1 overflow-hidden rounded-full"
                  style={{ background: C.head }}
                >
                  <span
                    className="absolute inset-y-0 left-0 rounded-full"
                    style={{ width: `${view.settleProgress.ratio * 100}%`, background: view.settleProgress.ratio >= 1 ? STATEMENT_CHIP.paid.text : C.navy }}
                  />
                </span>
                <span className="font-medium" style={{ color: view.settleProgress.ratio >= 1 ? STATEMENT_CHIP.paid.text : C.body }}>
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
        <div className="mt-6">
          <SectionTitle
            title="Transactions"
            caption={
              <>
                {count} {count === 1 ? "item" : "items"}
                {count > 0 && ` · ${view.openCount === 0 ? "all paid" : `${view.openCount} still open`}`}
              </>
            }
          />
        </div>
        <div className="mt-2 overflow-hidden rounded-[8px] border" style={{ borderColor: C.ruleStrong }}>
          <div
            className={cn("hidden border-b py-2 whitespace-nowrap @[46rem]:grid", TABLE_COLS, LABEL, "text-[9px] tracking-[0.07em]")}
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
              <CarryForwardRow value={previous?.value ?? null} note={[view.previousNote, previous?.side].filter(Boolean).join(" · ")} />
              <RowGroup rows={view.carried} view={view} groupOf={groupOf} />
              {totals?.carried && <SumRow label="Still open from earlier cycles" value={totals.carried} />}
              <CycleBand note={view.rows.length ? `${view.cycleLabel} · ${view.rows.length} new ${view.rows.length === 1 ? "item" : "items"}` : `${view.cycleLabel} · ${empty}`} />
            </>
          )}
          {!showPrevious && view.rows.length === 0 && <CycleBand note={`${view.cycleLabel} · ${empty}`} />}
          <RowGroup rows={view.rows} view={view} groupOf={groupOf} />
          {totals && (
            <>
              {totals.current && <SumRow label="Still open from this cycle" value={totals.current} op={totals.carried ? "+" : null} />}
              {totals.other && <SumRow label={totals.other.label} value={totals.other.value} op={totals.other.op} />}
              <SumRow label={totals.total.label} value={totals.total.value} op={totals.carried || totals.current || totals.other ? "=" : null} strong settled={settled} />
            </>
          )}
        </div>

        {view.payments.length > 0 && <PaymentHistory view={view} />}

        {/* Ending balance — the statement's conclusion, on midnight like the header */}
        <section
          aria-label="Ending balance"
          className="mt-5 flex flex-wrap items-end justify-between gap-x-6 gap-y-2 rounded-[8px] px-5 py-4"
          style={{ background: C.midnight, boxShadow: `inset 0 -2px 0 ${C.gold}` }}
        >
          <div className="min-w-0">
            <p className={cn(LABEL, "tracking-[0.16em]")} style={{ color: C.goldLight }}>
              Ending balance
            </p>
            <p className="mt-1 text-[17px] font-bold break-words text-white">{settled ? "Settled — nothing left to settle" : view.headline}</p>
          </div>
          <div className="min-w-0 @[36rem]:text-right">
            <p className={cn(LABEL, "tracking-[0.16em]")} style={{ color: C.goldLight }}>
              {settled ? "Nothing due" : "Amount due"}
            </p>
            <p className="font-mono text-[26px] leading-tight font-bold break-all tabular-nums" style={{ color: settled ? C.settledOnMidnight : "#fff" }}>
              {view.amount}
            </p>
          </div>
        </section>
        <p className="mt-2 text-[10.5px] leading-snug" style={{ color: C.muted }}>
          Covers every item open at the start of this period or added during it, with each split share exactly as recorded. All amounts in Indian Rupees (INR). Questions about an item? Contact{" "}
          {view.ownerName}.
        </p>

        {/* Footer */}
        <footer className="mt-6 flex flex-wrap justify-between gap-x-4 gap-y-1 border-t pt-2 text-[10.5px]" style={{ borderColor: C.rule, color: C.muted }}>
          <span className="min-w-0 break-words">
            <span className="font-bold" style={{ color: C.navy }}>
              FlowFi
            </span>{" "}
            · Statement for {view.personName} · {view.cycleLabel}
          </span>
          <span className="min-w-0 break-words">Prepared by {view.ownerName}</span>
        </footer>
      </div>
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
            <p className="flex items-center gap-2 border-b px-2.5 py-1.5 @[46rem]:pl-[2.2rem]" style={{ background: C.surface, borderColor: C.rule }}>
              <span aria-hidden className="size-[5px] rounded-full" style={{ background: C.gold }} />
              <span className={LABEL} style={{ color: C.navy }}>
                {groupOf(r)}
              </span>
              <span className="text-[10.5px]" style={{ color: C.muted }}>
                {(() => {
                  const n = rows.filter((x) => groupOf(x) === groupOf(r)).length;
                  return `${n} ${n === 1 ? "item" : "items"}`;
                })()}
              </span>
            </p>
          )}
          <StatementRow row={r} view={view} />
        </li>
      ))}
    </ul>
  );
}

/**
 * The previous balance as one carry-forward band, before the obligations it is made of — its amount beside the
 * label, never in the Remaining column (which holds only what each item still has open, so it adds up).
 */
function CarryForwardRow({ value, note }: { value: string | null; note: string }) {
  return (
    <div
      className={cn("grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 border-b border-l-[3px] px-2.5 py-2 @[46rem]:gap-x-0 @[46rem]:px-0", TABLE_COLS)}
      style={{ background: C.surface, borderBottomColor: C.rule, borderLeftColor: C.gold }}
    >
      <div className="min-w-0 @[46rem]:col-span-5 @[46rem]:col-start-3 @[46rem]:px-2">
        <p className="flex flex-wrap items-baseline gap-x-2.5">
          <span className={cn(LABEL, "text-[10px]")} style={{ color: STATEMENT_CHIP.carried.text }}>
            {STATEMENT_COPY.carried.label}
          </span>
          {value && <span className="font-mono text-[14px] font-bold tabular-nums">{value}</span>}
        </p>
        <p className="text-[11.5px]" style={{ color: C.muted }}>
          {note}
        </p>
      </div>
      <div className="@[46rem]:col-start-8 @[46rem]:px-2">
        <Chip tone="carried">Brought forward</Chip>
      </div>
    </div>
  );
}

/**
 * A sum line under a section, the figure in the Remaining column under a short rule — the paper statement's way of
 * totalling a column. `strong`: the closing line, equal to the balance due — a midnight bar that closes the panel.
 */
function SumRow({ label, value, op = null, strong = false, settled = false }: { label: string; value: string; op?: "+" | "−" | "=" | null; strong?: boolean; settled?: boolean }) {
  return (
    <div
      data-sum={strong ? "total" : "subtotal"}
      className={cn("grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 px-2.5 @[46rem]:gap-x-0 @[46rem]:px-0", strong ? "py-3" : "border-b py-1.5", TABLE_COLS)}
      style={{ background: strong ? C.midnight : C.surface, borderColor: C.rule }}
    >
      <p
        className={cn("min-w-0 @[46rem]:col-span-4 @[46rem]:col-start-2 @[46rem]:px-2 @[46rem]:text-right", strong ? cn(LABEL, "text-[10.5px] tracking-[0.16em]") : "text-[12px] font-semibold")}
        style={{ color: strong ? C.goldLight : C.body }}
      >
        {label}
      </p>
      <p className="flex items-baseline justify-end gap-2 @[46rem]:col-start-7 @[46rem]:px-2">
        {op && (
          <span aria-hidden className="text-[12px]" style={{ color: strong ? C.onMidnightMuted : C.muted }}>
            {op}
          </span>
        )}
        <span
          className={cn("border-t pt-0.5 font-mono font-bold whitespace-nowrap tabular-nums", strong ? "text-[16px]" : "text-[13px]")}
          style={{ borderColor: strong ? C.gold : C.ruleStrong, color: strong ? (settled ? C.settledOnMidnight : "#fff") : C.ink }}
        >
          {value}
        </span>
      </p>
    </div>
  );
}

/** THIS CYCLE: a navy-tinted divider row with the cycle — and, when nothing is new, the notice itself. */
function CycleBand({ note }: { note: string }) {
  return (
    <p
      className="flex flex-wrap items-baseline gap-x-3 border-b border-l-[3px] px-2.5 py-1.5 text-[11.5px] @[46rem]:pl-[7.3rem]"
      style={{ background: C.navyTint, borderBottomColor: C.navyRule, borderLeftColor: C.navy, color: C.body }}
    >
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
  const remainingTone = !r.remaining || r.remaining === zero ? C.faint : r.chip === "overdue" ? STATEMENT_CHIP.overdue.text : C.ink;
  return (
    <div data-carried={r.carried || undefined} data-split={split || undefined} className="relative isolate border-b" style={{ borderColor: C.rule }}>
      {/* Wide: the Remaining column's faint band runs the whole item, shares included. */}
      <span aria-hidden className={cn("pointer-events-none absolute inset-0 -z-10 hidden @[46rem]:grid", TABLE_COLS)}>
        <span className="col-start-7" style={{ background: C.remainTint }} />
      </span>
      <div className={cn("grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 px-2.5 pt-3 pb-2.5 @[46rem]:gap-x-0 @[46rem]:px-0", TABLE_COLS)}>
        <p className="col-span-2 text-[11px] tabular-nums @[46rem]:contents" style={{ color: C.muted }}>
          <span className="@[46rem]:pt-0.5 @[46rem]:pr-2 @[46rem]:text-right" style={{ color: C.faint }}>
            {r.no}
          </span>
          <span className="@[46rem]:hidden">
            {" · "}
            <span style={{ color: C.ink }}>
              {date.day}
              {date.year && ` ${date.year}`}
            </span>
          </span>
          <span className="hidden @[46rem]:block @[46rem]:px-2">
            <DateTile label={r.date} view={view} />
          </span>
        </p>

        <div className="row-start-2 min-w-0 @[46rem]:col-start-3 @[46rem]:row-start-1 @[46rem]:px-2">
          <p className="text-[13.5px] leading-snug font-medium break-words">{r.title}</p>
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
          {r.age && (
            <span
              data-age={r.age.tone}
              title={`Open since ${r.date} — counted to ${view.asOf}`}
              className={cn("mt-1 inline-flex items-center gap-1.5 text-[10.5px] leading-none", r.age.tone !== "fresh" && "font-medium")}
              style={{ color: r.age.tone === "old" ? STATEMENT_CHIP.overdue.text : r.age.tone === "aging" ? STATEMENT_CHIP.due.text : C.muted }}
            >
              <span aria-hidden className="size-[5px] rounded-full" style={{ background: r.age.tone === "fresh" ? C.faint : "currentColor" }} />
              {r.age.label}
            </span>
          )}
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
            <dd className="font-bold whitespace-nowrap" style={{ color: r.original ? C.ink : C.faint }}>
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
            <dd className="whitespace-nowrap" style={{ color: !r.paid || r.paid === zero ? C.faint : STATEMENT_CHIP.paid.text }}>
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
              <dd aria-hidden className="mt-1 ml-auto h-[4px] w-full max-w-[5rem] overflow-hidden rounded-full" style={{ background: C.head }}>
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

/**
 * A genuine split's stored allocation as quiet pills under its row — "Name ₹amount" — the recipient's pill solid
 * midnight, so their share is found at a glance (as in the PDF).
 */
function SharesLine({ allocation: a }: { allocation: SplitAllocation }) {
  return (
    <section aria-label="Shares" className="flex flex-wrap items-center gap-1.5 px-2.5 pb-3 text-[11.5px] tabular-nums @[46rem]:-mt-1 @[46rem]:ml-[7.45rem] @[46rem]:px-2">
      <span className={cn(LABEL, "mr-1 text-[8.5px]")} style={{ color: C.split }}>
        Shares
      </span>
      <dl className="contents">
        {a.participants.map((p) => (
          <div
            key={p.key}
            data-focus={p.isFocus || undefined}
            className="flex min-w-0 items-baseline gap-1.5 rounded-full border px-2 py-[2px]"
            style={p.isFocus ? { background: C.navy, borderColor: C.navy, color: "#fff" } : { background: C.surface, borderColor: C.rule }}
          >
            <dt className={cn("min-w-0 break-words", p.isFocus && "font-semibold")} style={{ color: p.isFocus ? "#fff" : p.amount === 0 ? C.muted : C.body }}>
              {p.label}
            </dt>
            <dd className="font-mono font-semibold whitespace-nowrap" style={{ color: p.isFocus ? "#fff" : p.amount === 0 ? C.faint : C.ink }}>
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

/** A date as a tile — the day large, the month small beneath — as in the PDF; anything else as quiet text. */
function DateTile({ label, view }: { label: string; view: StatementView }) {
  const m = label.match(/^(\d{1,2}) ([A-Za-z]{3})(?: (\d{4}))?$/);
  if (!m) {
    return (
      <span className="text-[11px] leading-snug" style={{ color: C.muted }}>
        {label}
      </span>
    );
  }
  const year = m[3] && !view.cycleLabel.endsWith(m[3]) ? m[3] : null;
  return (
    <span className="inline-flex flex-col leading-none" title={label}>
      <span className="text-[18px] font-semibold tabular-nums" style={{ color: C.ink }}>
        {m[1]}
      </span>
      <span className={cn(LABEL, "mt-1 text-[8px]")} style={{ color: C.muted }}>
        {m[2]}
        {year && ` ${year}`}
      </span>
    </span>
  );
}

/** A payment's direction: money in from the person green ↙, money out to them navy ↗, an advance teal. */
function DirectionBadge({ inbound, advance }: { inbound: boolean; advance: boolean }) {
  const tone = advance ? { fill: C.advanceTint, edge: STATEMENT_CHIP.advance.edge, ink: C.advance } : inbound ? { fill: STATEMENT_CHIP.paid.fill, edge: STATEMENT_CHIP.paid.edge, ink: STATEMENT_CHIP.paid.text } : { fill: C.navyTint, edge: C.navyRule, ink: C.navy };
  return (
    <span aria-hidden className="inline-flex size-[22px] shrink-0 items-center justify-center rounded-full border" style={{ background: tone.fill, borderColor: tone.edge }}>
      <svg viewBox="0 0 12 12" className="size-[11px]" fill="none" stroke={tone.ink} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        {inbound ? <path d="M9 3 3 9M3 4.5V9h4.5" /> : <path d="M3 9 9 3M4.5 3H9v4.5" />}
      </svg>
    </span>
  );
}

function PaymentHistory({ view }: { view: StatementView }) {
  const first = view.personName.split(" ")[0];
  const totals = [view.totalReceived && { label: `Total paid by ${first}`, value: view.totalReceived }, view.totalPaid && { label: `Total paid by ${view.ownerShort}`, value: view.totalPaid }].filter(
    Boolean,
  ) as { label: string; value: string }[];
  return (
    <section aria-label="Payment history" className="mt-6">
      <SectionTitle title="Payment history" caption="Payments this cycle and the items (#) each one paid" />
      <div className="mt-2 overflow-hidden rounded-[8px] border" style={{ borderColor: C.ruleStrong }}>
        <div className={cn("hidden border-b px-2.5 py-2 @[46rem]:grid", PAY_COLS, LABEL, "text-[9px]")} style={{ background: C.head, borderColor: C.ruleStrong, color: C.body }} aria-hidden>
          <span>Date</span>
          <span>Payment</span>
          <span>Applied to</span>
          <span className="text-right">Amount</span>
        </div>
        <ul>
          {view.payments.map((p, i) => (
            <li key={i} className={cn("grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 border-b px-2.5 py-3 text-[12px]", PAY_COLS)} style={{ borderColor: C.rule }}>
              <span className="col-span-2 tabular-nums @[46rem]:col-span-1">
                <span className="@[46rem]:hidden" style={{ color: p.date === "Date not known" ? C.muted : C.body }}>
                  {p.date}
                </span>
                <span className="hidden @[46rem]:inline-flex">
                  <DateTile label={p.date} view={view} />
                </span>
              </span>
              <div className="flex min-w-0 items-start gap-2">
                <DirectionBadge inbound={p.inbound} advance={p.advance} />
                <p className="min-w-0 pt-0.5 text-[13px] font-medium break-words">
                  {p.label}
                  {(p.account || p.note) && (
                    <span className="block text-[10.5px] font-normal" style={{ color: C.muted }}>
                      {[p.account, p.note].filter(Boolean).join(" · ")}
                    </span>
                  )}
                </p>
              </div>
              <span className="text-right font-mono text-[14px] font-bold whitespace-nowrap tabular-nums @[46rem]:order-last" style={{ color: p.inbound ? STATEMENT_CHIP.paid.text : C.ink }}>
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
                      <p key={j} className="flex justify-between gap-3 py-[1px] tabular-nums" style={{ color: C.body }}>
                        <span className="min-w-0 break-words">
                          {a.ref && (
                            <span
                              className="mr-2 inline-flex min-w-[20px] justify-center rounded-[4px] border px-1 text-[9.5px] leading-[14px] font-semibold"
                              style={{ background: C.surface, borderColor: C.rule, color: C.muted }}
                            >
                              {a.ref}
                            </span>
                          )}
                          {a.label}
                          {(a.date || a.note) && (
                            <span className="ml-1.5 text-[10.5px]" style={{ color: C.muted }}>
                              {a.date}
                              {a.date && a.note && " · "}
                              {a.note && <span style={{ color: a.note === "cleared" ? STATEMENT_CHIP.paid.text : C.muted }}>{a.note}</span>}
                            </span>
                          )}
                        </span>
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
