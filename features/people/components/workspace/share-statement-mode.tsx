"use client";

import { ChevronDown, Copy, FileDown, MessageCircle } from "lucide-react";
import { useState } from "react";
import { directionHeadline, type PersonCycleStatement } from "@/lib/engines/person-cycle-statement";
import { money, sharedPositionLine, statementShareText, whatsAppShareUrl } from "@/lib/engines/person-cycle-statement-share";
import { renderPersonStatementPdf } from "@/features/people/lib/person-statement-pdf";
import { toast } from "@/store/toast-store";
import { cn } from "@/lib/utils";
import { StatementActivityRow, StatementBreakdown, StatementCalculation, StatementReconciliation } from "../cycle-statement/statement-parts";
import { ModeFooter, ModeHeader, WS_PAD, WS_PRIMARY, WS_SECONDARY, WsLabel } from "./person-workspace-ui";

/**
 * Share mode — the cycle statement preview plus WhatsApp / Copy / PDF, inside the Person workspace.
 * The shared text, WhatsApp link and PDF are the same engine outputs the old preview dialog used.
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
  const text = statementShareText(statement);
  const tone =
    statement.direction === "theyOwe" ? "text-success" : statement.direction === "iOwe" ? "text-expense" : "text-foreground";

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
      const bytes = await renderPersonStatementPdf(statement);
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
      <ModeHeader
        backLabel="Close"
        onBack={onBack}
        onClose={onBack}
        title="Share Statement"
        subtitle={`${statement.personName} · ${statement.cycleLabel}`}
      />

      <div className={cn(WS_PAD, "mt-6 flex-1")}>
        <div className="grid gap-x-10 gap-y-6 md:grid-cols-[minmax(0,1fr)_17rem]">
          {/* The statement */}
          <div className="min-w-0">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className={cn("text-[11px] font-semibold tracking-[0.08em] uppercase", tone)}>{directionHeadline(statement.direction)}</p>
                <p className="font-heading text-[32px] leading-tight font-bold tracking-tight text-foreground tabular-nums">{money(statement.amount)}</p>
              </div>
              <p className="pt-1 text-right text-[11px] leading-tight text-muted-foreground">
                FlowFi
                <br />
                Cycle Statement
              </p>
            </div>

            <div className="mt-4 max-w-sm">
              <StatementReconciliation statement={statement} />
            </div>

            {statement.activityBreakdown.length > 0 && (
              <div className="mt-5 max-w-sm">
                <StatementBreakdown statement={statement} />
              </div>
            )}

            {statement.rows.length > 0 && (
              <>
                <WsLabel className="mt-6">Activity</WsLabel>
                <ul className="mt-1 max-h-64 divide-y divide-border overflow-y-auto border-y border-border px-2">
                  {statement.rows.map((r) => (
                    <StatementActivityRow key={r.key} statement={statement} row={r} />
                  ))}
                </ul>
              </>
            )}

            <details className="group mt-3">
              <summary className="flex cursor-pointer list-none items-center justify-between py-1 text-xs font-medium text-muted-foreground hover:text-foreground">
                Calculation
                <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" strokeWidth={1.75} />
              </summary>
              <div className="mt-1.5 rounded-[6px] bg-secondary/60 p-3">
                <StatementCalculation statement={statement} />
              </div>
            </details>
          </div>

          {/* What gets sent */}
          <div className="min-w-0 md:border-l md:border-border md:pl-6">
            <WsLabel>Sent as</WsLabel>
            <p className="mt-1.5 text-sm font-medium text-foreground">“{sharedPositionLine(statement)}”</p>
            <button
              type="button"
              aria-expanded={messageOpen}
              onClick={() => setMessageOpen((o) => !o)}
              className="mt-3 flex w-full items-center justify-between py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              Message preview
              <ChevronDown className={cn("size-3.5 transition-transform", messageOpen && "rotate-180")} strokeWidth={1.75} />
            </button>
            <div
              className={cn(
                "grid transition-[grid-template-rows,opacity] duration-200 ease-out md:grid-rows-[1fr] md:opacity-100",
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
