"use client";

import { ChevronDown, Copy, FileDown, MessageCircle } from "lucide-react";
import { useMemo, useState } from "react";
import { usePersonCycleStatement } from "@/features/people/hooks/use-person-cycle-statement";
import { usePersonPendingSplitParticipants } from "@/features/people/hooks/use-person-pending-split-participants";
import { useSettlementLookups } from "@/features/people/hooks/use-settlement-lookups";
import { renderPersonStatementPdf } from "@/features/people/lib/person-statement-pdf";
import { useMonthCycleStartDay } from "@/features/settings/hooks/use-user-preferences";
import {
  STATEMENT_COPY,
  statementSections,
  statementSummaryCells,
  statementView,
  type StatementView,
  type StatementViewOptions,
  type StatementViewRow,
} from "@/features/people/lib/person-statement-pdf-model";
import type { SettlementStatusTone } from "@/features/people/lib/settlement-presentation";
import type { PersonCycleStatement } from "@/lib/engines/person-cycle-statement";
import { money, sharedPositionLine, statementShareText, whatsAppShareUrl } from "@/lib/engines/person-cycle-statement-share";
import { splitCountLabel, type SplitAllocation } from "@/lib/split/split-allocation";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/store/auth-store";
import { toast } from "@/store/toast-store";
import { StatementCalculation } from "../cycle-statement/statement-parts";
import { ModeFooter, ModeHeader, WS_PAD, WS_PRIMARY, WS_SECONDARY, WsLabel } from "./person-workspace-ui";

/**
 * Share mode — a preview of exactly what the PDF contains, drawn as the same A4 document (header, balance,
 * summary, every item with amount / paid / remaining and its status, split details, payment history, ending
 * balance), plus WhatsApp / Copy / PDF. The preview and the PDF read one `statementView`; the text message is
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
      const bytes = await renderPersonStatementPdf(statement, options);
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

// ---------------------------------------------------------------------------------------------------
// The document — paper colours are fixed (it is a printed statement in both themes), matching the PDF.
// ---------------------------------------------------------------------------------------------------

/** Status badge: green = paid / settled, soft red = due, amber = part-paid, blue-grey = upcoming; the rest neutral. */
const STATUS_CLASS: Record<SettlementStatusTone, string> = {
  due: "border-[#E8A9A4] bg-[#FCEDEB] text-[#9E2219]",
  payable: "border-[#E8A9A4] bg-[#FCEDEB] text-[#9E2219]",
  partial: "border-[#E0B56B] bg-[#FFF2DB] text-[#734505]",
  settled: "border-[#9ECBAE] bg-[#E6F4EB] text-[#12633A]",
  overdue: "border-[#CC6B65] bg-[#FADCDA] text-[#8F120D]",
  upcoming: "border-[#AEBCCB] bg-[#ECF0F4] text-[#384F66]",
  received: "border-[#9ECBAE] bg-[#E6F4EB] text-[#12633A]",
  paid: "border-[#A9ADB2] bg-[#F1F2F3] text-[#3A3E45]",
  neutral: "border-[#A9ADB2] bg-[#F1F2F3] text-[#3A3E45]",
};
/** The same tone as plain text (the split details' "who owes what" line). */
const STATUS_TEXT: Record<SettlementStatusTone, string> = {
  due: "text-[#9E2219]",
  payable: "text-[#9E2219]",
  partial: "text-[#734505]",
  settled: "text-[#12633A]",
  overdue: "text-[#8F120D]",
  upcoming: "text-[#384F66]",
  received: "text-[#12633A]",
  paid: "text-[#16181C]",
  neutral: "text-[#16181C]",
};
/** Status details that only restate a row's direction line plus its Paid / Remaining figures. */
const REPEATS_COLUMNS = new Set<SettlementStatusTone>(["due", "payable", "partial", "settled"]);
const BADGE = "inline-flex h-[17px] shrink-0 items-center rounded-[3px] border px-1.5 text-[10px] leading-none font-semibold whitespace-nowrap";
const LABEL = "text-[10px] font-bold tracking-[0.08em] uppercase";
/** The table's columns, used by the header and every row from the container's "wide" width up. */
const TABLE_COLS = "@[40rem]:grid-cols-[1.6rem_5.4rem_minmax(0,1fr)_6.4rem_5.6rem_6.4rem_7.6rem]";

function StatementDocument({ view }: { view: StatementView }) {
  const settled = view.direction === "settled";
  const cells = statementSummaryCells(view);
  const { previous, showPrevious, byMonth } = statementSections(view);
  const count = view.carried.length + view.rows.length;
  const empty = STATEMENT_COPY.empty;

  return (
    <article
      aria-label={`People Settlement Statement for ${view.personName}, ${view.cycleLabel}`}
      className="@container mx-auto w-full max-w-[52rem] rounded-[3px] bg-white px-4 py-6 text-[#16181C] shadow-[0_1px_2px_rgba(0,0,0,0.08),0_12px_32px_-16px_rgba(0,0,0,0.28)] sm:px-9 sm:py-9"
    >
      {/* Brand */}
      <div className="relative flex items-end justify-between gap-4 border-b border-[#DADDE0] pb-2.5">
        <div>
          <p className="text-[22px] leading-none font-bold tracking-tight text-[#14432F]">FlowFi</p>
          <p className="mt-1 text-[11px] text-[#5C6168]">People · Expenses · Settle Up</p>
        </div>
        <div className="text-right text-[#5C6168]">
          <p className={cn(LABEL, "text-[9.5px]")}>People statement</p>
          <p className="mt-0.5 text-[11px]">Generated {view.asOf}</p>
        </div>
        <span className="absolute -bottom-px left-0 h-[2px] w-14 bg-[#14432F]" aria-hidden />
      </div>

      {/* Title + the answer */}
      <div className="mt-5 grid gap-5 @[36rem]:grid-cols-[minmax(0,1fr)_17rem] @[36rem]:items-start">
        <div className="min-w-0">
          <h2 className="text-[23px] leading-tight font-bold tracking-tight @[36rem]:text-[27px]">People Settlement Statement</h2>
          <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2">
            <div className="min-w-0">
              <dt className={cn(LABEL, "text-[9.5px] text-[#5C6168]")}>Statement for</dt>
              <dd className="mt-0.5 text-[17px] leading-tight font-semibold break-words">{view.personName}</dd>
            </div>
            <div className="min-w-0">
              <dt className={cn(LABEL, "text-[9.5px] text-[#5C6168]")}>Period</dt>
              <dd className="mt-0.5 text-[14px] leading-snug break-words">{view.cycleLabel}</dd>
            </div>
          </dl>
          <p className="mt-3 text-[11.5px] break-words text-[#5C6168]">Prepared by {view.ownerName}</p>
        </div>
        <section aria-label="Balance" className="border-l-[3px] border-l-[#14432F] bg-[#F3F7F4] px-5 py-4">
          <p className={cn(LABEL, "text-[#1A6140]")}>{settled ? "Settled" : "Balance due"}</p>
          <p className={cn("mt-1 text-[34px] leading-none font-bold tracking-tight break-all tabular-nums", settled && "text-[#12633A]")}>{view.amount}</p>
          <p className="mt-2 text-[13px] break-words text-[#3A3E45]">{settled ? "Nothing left to settle" : view.headline}</p>
        </section>
      </div>

      {/* Statement summary */}
      <dl className="mt-6 flex flex-wrap border-t border-b border-t-[#A9ADB2] border-b-[#DADDE0]">
        {cells.map((c, i) => (
          <div
            key={`${i}-${c.label}`}
            className={cn(
              "min-w-0 basis-1/2 px-3 py-2.5 @[40rem]:flex-1 @[40rem]:basis-0",
              c.current
                ? "basis-full bg-[#F3F7F4] @[40rem]:flex-[1.1]"
                : "@[40rem]:border-l @[40rem]:border-[#ECEEF0]",
              i === 0 && "@[40rem]:border-l-0 @[40rem]:pl-0",
            )}
          >
            <dt className={cn(LABEL, "text-[9.5px] tracking-[0.06em]", c.current ? "text-[#14432F]" : "text-[#5C6168]")}>{c.label}</dt>
            <dd
              className={cn(
                "mt-0.5 font-bold break-all tabular-nums",
                c.current ? (settled ? "text-[19px] text-[#12633A]" : "text-[19px] text-[#14432F]") : "text-[14px] font-semibold",
                !c.current && c.value === money(0) && "font-normal text-[#5C6168]",
                c.advance && "text-[#12633A]",
              )}
            >
              {c.value}
            </dd>
            {c.note && <dd className="text-[10px] leading-snug text-[#5C6168]">{c.note}</dd>}
          </div>
        ))}
      </dl>
      {view.cashNote && <p className="mt-1 text-right text-[11px] text-[#5C6168]">{view.cashNote}</p>}

      {/* Transactions */}
      <h3 className="mt-8 text-[16px] font-bold">Transactions</h3>
      <p className="text-[11.5px] text-[#5C6168]">
        {count} {count === 1 ? "item" : "items"} · Paid and remaining as of {view.asOf}
      </p>
      <div
        className={cn("mt-2.5 hidden border-b border-[#A9ADB2] bg-[#F2F4F6] px-0 py-1.5 @[40rem]:grid", TABLE_COLS, LABEL, "text-[9.5px] tracking-[0.06em] text-[#5C6168]")}
        aria-hidden
      >
        <span className="pr-1.5 text-right">#</span>
        <span className="px-1.5">Date</span>
        <span className="px-1.5">Description</span>
        <span className="px-1.5 text-right">Amount</span>
        <span className="px-1.5 text-right">Paid</span>
        <span className="px-1.5 text-right">Remaining</span>
        <span className="px-1.5">Status</span>
      </div>
      <div className="mt-2 border-t border-[#A9ADB2] @[40rem]:mt-0 @[40rem]:border-t-0">
        {showPrevious && (
          <>
            <CarryForwardRow value={previous?.value ?? null} side={previous?.side ?? null} />
            <RowGroup rows={view.carried} byMonth={byMonth} />
            <CycleBand note={view.rows.length ? view.cycleLabel : `${view.cycleLabel} · ${empty}`} />
          </>
        )}
        {!showPrevious && view.rows.length === 0 && <CycleBand note={`${view.cycleLabel} · ${empty}`} />}
        <RowGroup rows={view.rows} byMonth={byMonth} />
      </div>

      {view.payments.length > 0 && <PaymentHistory view={view} />}

      {/* Ending balance — the statement's conclusion */}
      <section aria-label="Ending balance" className="mt-8 flex flex-wrap items-end justify-between gap-x-6 gap-y-3 rounded-[4px] bg-[#14432F] px-5 py-4 text-white">
        <div className="min-w-0">
          <p className={cn(LABEL, "text-[#B9F65A]")}>Ending balance</p>
          <p className="mt-1 text-[16px] font-bold break-words">{settled ? "Settled — nothing left to settle" : view.headline}</p>
        </div>
        <div className="min-w-0 @[36rem]:text-right">
          <p className={cn(LABEL, "text-[#CCDAD1]")}>{settled ? "Nothing due" : "Amount due"}</p>
          <p className="text-[30px] leading-tight font-bold tracking-tight break-all tabular-nums">{view.amount}</p>
        </div>
      </section>

      {/* Footer */}
      <footer className="mt-8 flex flex-wrap justify-between gap-x-4 gap-y-1 border-t border-[#DADDE0] pt-2 text-[10.5px] text-[#5C6168]">
        <span className="min-w-0 break-words">
          FlowFi · Statement for {view.personName} · {view.cycleLabel}
        </span>
        <span className="min-w-0 break-words">Prepared by {view.ownerName}</span>
      </footer>
    </article>
  );
}

/** A list of rows with a month heading wherever the month changes (only when the statement spans months). */
function RowGroup({ rows, byMonth }: { rows: StatementViewRow[]; byMonth: boolean }) {
  if (rows.length === 0) return null;
  return (
    <ul>
      {rows.map((r, i) => (
        <li key={`${r.carried ? "c" : "r"}${r.no}`}>
          {byMonth && r.month !== rows[i - 1]?.month && (
            <p className={cn(LABEL, "flex items-center gap-3 pt-5 pb-1 text-[#1A6140]")}>
              {r.month}
              <span className="h-px flex-1 bg-[#D6E1D9]" aria-hidden />
            </p>
          )}
          <StatementRow row={r} />
        </li>
      ))}
    </ul>
  );
}

/** The previous balance as one carry-forward line, before the obligations it is made of. */
function CarryForwardRow({ value, side }: { value: string | null; side: string | null }) {
  return (
    <div className={cn("grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 border-b border-l-[3px] border-[#DADDE0] border-l-[#ADBCCB] bg-[#F4F6F9] py-2.5 pr-1.5 pl-2.5", TABLE_COLS, "@[40rem]:pl-0")}>
      <div className="col-start-1 row-span-2 row-start-1 min-w-0 @[40rem]:col-span-5 @[40rem]:row-span-1 @[40rem]:pl-2">
        <p className={cn(LABEL, "text-[10.5px] text-[#384F66]")}>{STATEMENT_COPY.carried.label}</p>
        <p className="text-[11.5px] text-[#5C6168]">{[STATEMENT_COPY.carried.note, side].filter(Boolean).join(" · ")}</p>
      </div>
      <p className="col-start-2 row-start-1 text-right text-[13px] font-bold tabular-nums @[40rem]:col-start-6 @[40rem]:px-1.5">{value}</p>
      <div className="col-start-2 row-start-2 justify-self-end @[40rem]:col-start-7 @[40rem]:row-start-1 @[40rem]:justify-self-start @[40rem]:px-1.5">
        <span className={cn(BADGE, "border-[#AEBCCB] bg-[#ECF0F4] text-[#384F66]")}>Carry forward</span>
      </div>
    </div>
  );
}

/** THIS CYCLE: a section divider with the cycle — and, when nothing is new, the notice itself. */
function CycleBand({ note }: { note: string }) {
  return (
    <p className="mt-5 flex flex-wrap items-baseline gap-x-3 border-b-[1.5px] border-[#14432F] px-0.5 pb-1.5 text-[11.5px] text-[#3A3E45]">
      <span className={cn(LABEL, "text-[#14432F]")}>{STATEMENT_COPY.current}</span>
      <span>{note}</span>
    </p>
  );
}

/**
 * One transaction — the same architecture as a PDF row: # and date, the description with its type · cycle line
 * and direction note, Amount (named for whose share it is) / Paid / Remaining, the status — and, for a genuine
 * split (2+ people) only, the split details. An expense assigned to one person is a plain transaction: its Amount
 * is already that person's amount. Wide: a table row. Narrow: a stacked record with the amounts in a line.
 */
function StatementRow({ row: r }: { row: StatementViewRow }) {
  const a = r.allocation ?? null;
  const fullSplit = a != null && a.participants.length >= 2;
  const assignedOnly = a != null && a.participants.length === 1;
  const relation = a && r.kind === "split" ? null : r.relation;
  // The status detail would only repeat the direction line and the Paid / Remaining figures — or the split panel states it.
  const showDetail = !!r.statusDetail && !fullSplit && !(relation && REPEATS_COLUMNS.has(r.statusTone));
  const amountLabel = assignedOnly ? "Amount" : r.amountLabel;
  const from = r.carried && r.fromCycle ? `From ${r.fromCycle}` : null;
  const zero = money(0);
  return (
    <div data-carried={r.carried || undefined} className={cn("grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1.5 border-b border-[#ECEEF0] py-3.5", TABLE_COLS, "@[40rem]:gap-x-0")}>
      {/* # and date: one muted line when narrow, two columns when wide */}
      <p className="col-span-2 text-[11px] text-[#5C6168] tabular-nums @[40rem]:contents">
        <span className="@[40rem]:pt-px @[40rem]:pr-1.5 @[40rem]:text-right">{r.no}</span>
        <span className="@[40rem]:hidden"> · </span>
        <span className="@[40rem]:px-1.5 @[40rem]:pt-px @[40rem]:text-[11.5px] @[40rem]:text-[#3A3E45]">{r.date}</span>
      </p>

      <div className="row-start-2 min-w-0 @[40rem]:row-start-1 @[40rem]:col-start-3 @[40rem]:px-1.5">
        <p className="text-[13.5px] leading-snug font-semibold break-words">{r.title}</p>
        <p className="mt-0.5 text-[11px] break-words text-[#5C6168]">
          <span className="text-[#1A6140]">{r.typeLabel}</span>
          {from && <> · {from}</>}
        </p>
        {relation && <p className="text-[11.5px] break-words text-[#5C6168]">{relation}</p>}
        {/* One-line split context — only when the full allocation isn't available (legacy data). */}
        {r.splitNote && !a && <p className="mt-0.5 text-[11px] leading-snug text-[#5C6168] tabular-nums">{r.splitNote}</p>}
        {a && !fullSplit && <BillLine allocation={a} />}
      </div>

      <dl className="col-span-2 row-start-3 grid grid-cols-3 gap-x-3 rounded-[4px] bg-[#F7F8F8] px-2.5 py-1.5 text-[12.5px] tabular-nums @[40rem]:contents">
        <div className="min-w-0 @[40rem]:col-start-4 @[40rem]:row-start-1 @[40rem]:px-1.5 @[40rem]:text-right">
          <dt className="text-[10.5px] text-[#5C6168] @[40rem]:sr-only">{amountLabel}</dt>
          <dd className="font-bold whitespace-nowrap">{r.original || "—"}</dd>
          {amountLabel !== "Amount" && <dd className="hidden text-[10.5px] text-[#5C6168] @[40rem]:block">{amountLabel}</dd>}
        </div>
        <div className="min-w-0 @[40rem]:col-start-5 @[40rem]:row-start-1 @[40rem]:px-1.5 @[40rem]:text-right">
          <dt className="text-[10.5px] text-[#5C6168] @[40rem]:sr-only">Paid</dt>
          <dd className={cn("whitespace-nowrap", !r.paid || r.paid === zero ? "text-[#5C6168]" : "text-[#3A3E45]")}>{r.paid || "—"}</dd>
        </div>
        <div className="min-w-0 @[40rem]:col-start-6 @[40rem]:row-start-1 @[40rem]:px-1.5 @[40rem]:text-right">
          <dt className="text-[10.5px] text-[#5C6168] @[40rem]:sr-only">Remaining</dt>
          <dd
            className={cn(
              "whitespace-nowrap",
              !r.remaining || r.remaining === zero ? "text-[#5C6168]" : "font-bold",
              r.statusTone === "overdue" && r.remaining && r.remaining !== zero && "text-[#9E2219]",
            )}
          >
            {r.remaining || "—"}
          </dd>
        </div>
      </dl>

      <div className="row-start-2 flex min-w-0 flex-col items-end @[40rem]:col-start-7 @[40rem]:row-start-1 @[40rem]:items-start @[40rem]:px-1.5">
        <span className={cn(BADGE, STATUS_CLASS[r.statusTone])}>{r.status}</span>
        {showDetail && <span className="mt-0.5 max-w-[11rem] text-right text-[10.5px] leading-snug text-[#5C6168] @[40rem]:text-left">{r.statusDetail}</span>}
      </div>

      {a && fullSplit && (
        <SplitDetails allocation={a} detail={r.statusDetail} tone={r.statusTone} className="col-span-2 row-start-4 @[40rem]:col-span-5 @[40rem]:col-start-3 @[40rem]:row-start-2 @[40rem]:mx-1.5 @[40rem]:mt-1" />
      )}
    </div>
  );
}

const PANEL_COLS: Record<number, string> = {
  1: "",
  2: "@[26rem]:grid-cols-2",
  3: "@[26rem]:grid-cols-2 @[40rem]:grid-cols-3",
  4: "@[26rem]:grid-cols-2 @[40rem]:grid-cols-4",
};

/**
 * The only split facts a plain row can't show: a legacy split's purchase total (no participant list to break
 * down), and stored allocations that don't add up. An expense assigned to one person shows nothing here.
 */
function BillLine({ allocation: a }: { allocation: SplitAllocation }) {
  return (
    <>
      {a.participants.length === 0 && (
        <p className="mt-1 text-[11px] break-words text-[#5C6168] tabular-nums">
          Original purchase <span className="font-semibold text-[#16181C]">{money(a.original)}</span> · <span className="text-[#3A3E45]">{splitCountLabel(a)}</span>
        </p>
      )}
      {!a.reconciles && a.participants.length > 0 && (
        <p className="mt-0.5 text-[10.5px] text-[#5C6168] tabular-nums">
          Allocated {money(a.allocated)} of {money(a.original)}
        </p>
      )}
    </>
  );
}

/** The stored allocation of a genuine split: the bill, how it was shared, who owes what, then every participant's share. */
function SplitDetails({ allocation: a, detail, tone, className }: { allocation: SplitAllocation; detail: string; tone: SettlementStatusTone; className?: string }) {
  return (
    <section aria-label="Split details" className={cn("overflow-hidden border-l-2 border-[#CCDAD1] bg-[#F6F9F7]", className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 px-2.5 py-1.5">
        <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-[11.5px]">
          <span className={cn(LABEL, "text-[9.5px] text-[#1A6140]")}>Split details</span>
          <span className="text-[#5C6168]">Original purchase</span>
          <span className="font-bold tabular-nums">{money(a.original)}</span>
          <span className="text-[#5C6168]">· {splitCountLabel(a)}</span>
        </p>
        {detail && <p className={cn("text-[11px] font-semibold tabular-nums", STATUS_TEXT[tone])}>{detail}</p>}
      </div>
      {a.participants.length > 0 && (
        <dl className={cn("grid grid-cols-1 border-t border-[#D6E1D9]", PANEL_COLS[Math.min(4, a.participants.length)])}>
          {a.participants.map((p) => (
            <div
              key={p.key}
              data-focus={p.isFocus || undefined}
              className={cn("flex min-w-0 items-baseline justify-between gap-3 border-b border-[#E1E9E3] px-2.5 py-1 text-[12px]", p.isFocus && "bg-[#ECF6E3]")}
            >
              <dt className={cn("min-w-0 break-words", p.isFocus ? "font-semibold text-[#16181C]" : "text-[#3A3E45]")}>{p.label}</dt>
              <dd className={cn("font-semibold whitespace-nowrap tabular-nums", p.amount === 0 && "text-[#5C6168]")}>{money(p.amount)}</dd>
            </div>
          ))}
        </dl>
      )}
      {!a.reconciles && a.participants.length > 0 && (
        <p className="px-2.5 py-1 text-[10.5px] text-[#5C6168] tabular-nums">
          Allocated {money(a.allocated)} of {money(a.original)}
        </p>
      )}
    </section>
  );
}

function PaymentHistory({ view }: { view: StatementView }) {
  const first = view.personName.split(" ")[0];
  return (
    <section aria-label="Payment history" className="mt-8">
      <h3 className="flex items-baseline gap-2 text-[16px] font-bold">
        Payment history <span className="text-[11.5px] font-normal text-[#5C6168]">This cycle</span>
      </h3>
      <div className={cn("mt-2 grid grid-cols-[5.4rem_minmax(0,1fr)_auto] border-y border-t-[#CCDAD1] border-b-[#A9ADB2] bg-[#F3F7F4] px-1.5 py-1.5 text-[#3A3E45]", LABEL, "tracking-[0.06em]")} aria-hidden>
        <span>Date</span>
        <span>Payment</span>
        <span className="text-right">Amount</span>
      </div>
      <ul>
        {view.payments.map((p, i) => (
          <li key={i} className="grid grid-cols-[5.4rem_minmax(0,1fr)_auto] gap-y-0.5 border-b border-[#E3E5E7] px-1.5 py-2 text-[12px]">
            <span className="text-[#3A3E45] tabular-nums">{p.date}</span>
            <div className="min-w-0 pr-3">
              <p className="font-semibold break-words">
                {p.label}
                {p.account && <span className="font-normal text-[#5C6168]"> · {p.account}</span>}
              </p>
              {p.single != null ? (
                <p className="text-[11px] break-words text-[#5C6168]">{p.single}</p>
              ) : (
                <div className="mt-1 max-w-[24rem] text-[11px]">
                  <p className={cn(LABEL, "text-[9.5px] text-[#5C6168]")}>Applied to</p>
                  {p.applied.map((a, j) => (
                    <p key={j} className="flex justify-between gap-3 tabular-nums">
                      <span className="min-w-0 break-words">+ {a.label}</span>
                      <span className="whitespace-nowrap">{a.amount}</span>
                    </p>
                  ))}
                  <p className="mt-0.5 flex justify-between gap-3 border-t border-[#DADDE0] pt-0.5 font-semibold tabular-nums">
                    <span>Applied</span>
                    <span>{p.appliedTotal}</span>
                  </p>
                  {p.held && (
                    <p className="flex justify-between gap-3 font-semibold text-[#12633A] tabular-nums">
                      <span>Held as advance</span>
                      <span>{p.held}</span>
                    </p>
                  )}
                </div>
              )}
            </div>
            <span className={cn("text-right font-bold whitespace-nowrap tabular-nums", p.inbound && "text-[#12633A]")}>{p.amount}</span>
          </li>
        ))}
      </ul>
      <div className="mt-1.5 space-y-0.5 text-right text-[12px] font-semibold tabular-nums">
        {view.totalReceived && (
          <p>
            Total paid by {first} {view.totalReceived}
          </p>
        )}
        {view.totalPaid && (
          <p>
            Total paid by {view.ownerShort} {view.totalPaid}
          </p>
        )}
      </div>
    </section>
  );
}
