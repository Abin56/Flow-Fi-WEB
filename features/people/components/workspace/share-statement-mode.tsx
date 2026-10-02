"use client";

import { ArrowDownLeft, ArrowUpRight, Check, ChevronDown, Copy, FileDown, MessageCircle } from "lucide-react";
import { useMemo, useState } from "react";
import { usePersonCycleStatement } from "@/features/people/hooks/use-person-cycle-statement";
import { usePersonPendingSplitParticipants } from "@/features/people/hooks/use-person-pending-split-participants";
import { useSettlementLookups } from "@/features/people/hooks/use-settlement-lookups";
import { renderPersonStatementPdf } from "@/features/people/lib/person-statement-pdf";
import { useMonthCycleStartDay } from "@/features/settings/hooks/use-user-preferences";
import { statementView, type StatementViewOptions } from "@/features/people/lib/person-statement-pdf-model";
import type { PersonCycleStatement } from "@/lib/engines/person-cycle-statement";
import { sharedPositionLine, statementShareText, whatsAppShareUrl } from "@/lib/engines/person-cycle-statement-share";
import { cn } from "@/lib/utils";
import { toast } from "@/store/toast-store";
import { StatementCalculation } from "../cycle-statement/statement-parts";
import { ModeFooter, ModeHeader, WS_PAD, WS_PRIMARY, WS_SECONDARY, WsLabel } from "./person-workspace-ui";
import { CyclePaymentHistory, CycleReconciliation } from "./settlement-summary";
import { FAMILY, StatusPill, TONE_FAMILY, TypeBadge } from "./settlement-table";

/**
 * Share mode — a preview of exactly what the PDF contains (position, the cycle's reconciliation, every
 * item with original / paid / remaining and its status, and the payment history), plus WhatsApp / Copy /
 * PDF. The preview and the PDF read one `statementView`; the text message is the engine's summary.
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
  const options = useMemo<StatementViewOptions>(
    () => ({ entries: ledgerEntries, history: allTimeStatement, lookups, accountForEntry: lookups.accountForEntry, cycleStartDay }),
    [ledgerEntries, allTimeStatement, lookups, cycleStartDay],
  );
  const view = useMemo(() => statementView(statement, options), [statement, options]);
  const text = statementShareText(statement);
  const first = statement.personName.split(" ")[0];
  const tone =
    statement.direction === "theyOwe" ? "text-settle-receivable-text" : statement.direction === "iOwe" ? "text-settle-payable-text" : "text-success";
  const edge =
    statement.direction === "theyOwe" ? "border-l-settle-receivable-edge" : statement.direction === "iOwe" ? "border-l-settle-payable-edge" : "border-l-success";
  const DirectionIcon = statement.direction === "theyOwe" ? ArrowDownLeft : statement.direction === "iOwe" ? ArrowUpRight : Check;

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
          {/* The statement — the same content as the PDF */}
          <div className="min-w-0">
            <div className="grid gap-x-6 gap-y-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,19rem)]">
              <div className="min-w-0">
                <p className="text-[11.5px] font-semibold text-foreground/70">Settlement · {statement.cycleLabel}</p>
                <div className={cn("mt-1.5 border-l-[4px] pl-3", edge)}>
                  <p className={cn("inline-flex items-center gap-1.5 text-[13px] font-bold tracking-[0.08em] uppercase", tone)}>
                    <DirectionIcon className="size-4" strokeWidth={2.5} aria-hidden />
                    {view.headline}
                  </p>
                  <p className={cn("font-heading text-[32px] leading-tight font-bold tracking-tight tabular-nums", statement.direction === "settled" ? "text-foreground" : tone)}>
                    {view.amount}
                  </p>
                </div>
              </div>
              <CycleReconciliation statement={statement} personName={statement.personName} />
            </div>

            <div className="mt-5 flex items-baseline justify-between gap-3">
              <WsLabel>Items · {view.rows.length}</WsLabel>
              <span className="text-[11px] font-medium text-foreground/60">Paid and remaining as of {view.asOf}</span>
            </div>
            {view.rows.length === 0 ? (
              <p className="mt-1 border-y border-border-strong/70 py-3 text-sm font-medium text-foreground/75">No activity with {first} in this cycle.</p>
            ) : (
              <ul className="mt-1 max-h-[22rem] overflow-y-auto rounded-[6px] border border-border-strong/80">
                {view.rows.map((r) => {
                  const fam = TONE_FAMILY[r.tone];
                  return (
                    <li key={r.no} className={cn("grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 border-b border-l-[4px] border-b-border-strong/50 px-2.5 py-2 last:border-b-0", FAMILY[fam].tint, FAMILY[fam].edge)}>
                      <div className="min-w-0">
                        <p className="flex min-w-0 items-center gap-1.5">
                          <span className="text-[11px] font-semibold text-foreground/55 tabular-nums">{r.no}</span>
                          <span className="truncate text-[13px] font-semibold text-foreground">{r.title}</span>
                        </p>
                        <p className="truncate text-[11.5px] font-medium text-foreground/70">
                          {r.date} · {r.relation}
                        </p>
                        {r.splitNote && <p className="truncate text-[11px] text-foreground/60 tabular-nums">{r.splitNote.split(" · ").map((part, i) => (i === 0 ? <span key={i} className="font-bold text-foreground">{part}</span> : <span key={i}> · {part}</span>))}</p>}
                      </div>
                      <div className="flex items-start justify-end">
                        <TypeBadge kind={r.kind} family={fam} />
                      </div>
                      <dl className="flex flex-wrap gap-x-4 text-[11.5px]">
                        {r.original && (
                          <div className="flex gap-1"><dt className="text-foreground/60">{r.splitNote ? "Share" : "Original"}</dt><dd className="font-semibold text-foreground tabular-nums">{r.original}</dd></div>
                        )}
                        {r.paid && (
                          <div className="flex gap-1"><dt className="text-foreground/60">Paid</dt><dd className="font-semibold text-success tabular-nums">{r.paid}</dd></div>
                        )}
                        {r.remaining && (
                          <div className="flex gap-1"><dt className="text-foreground/60">Remaining</dt><dd className="font-bold text-foreground tabular-nums">{r.remaining}</dd></div>
                        )}
                      </dl>
                      <div className="flex justify-end">
                        <StatusPill status={{ label: r.status, detail: null, tone: r.statusTone }} compact />
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}

            <CyclePaymentHistory statement={statement} personName={statement.personName} accountForEntry={lookups.accountForEntry} incomeForEntry={lookups.incomeForEntry} className="mt-4" />

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
              The PDF contains everything on the left. The WhatsApp / text message is a short summary.
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
