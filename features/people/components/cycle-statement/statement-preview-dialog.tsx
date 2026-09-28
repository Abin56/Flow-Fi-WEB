"use client";

import { Copy, FileDown, MessageCircle } from "lucide-react";
import { useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ClayButton } from "@/components/clay/clay-button";
import type { PersonCycleStatement } from "@/lib/engines/person-cycle-statement";
import { sharedPositionLine, statementShareText, whatsAppShareUrl } from "@/lib/engines/person-cycle-statement-share";
import { renderPersonStatementPdf } from "@/features/people/lib/person-statement-pdf";
import { toast } from "@/store/toast-store";
import {
  StatementActivityRow,
  StatementBreakdown,
  StatementCalculation,
  StatementHeadline,
  StatementReconciliation,
} from "./statement-parts";

export function StatementPreviewDialog({
  statement,
  phone,
  open,
  onOpenChange,
}: {
  statement: PersonCycleStatement;
  phone?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [pdfBusy, setPdfBusy] = useState(false);
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-4 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Share Statement</DialogTitle>
          <DialogDescription>
            {statement.personName} · {statement.cycleLabel}
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-lg border border-border p-4">
          <div className="flex items-start justify-between gap-3">
            <StatementHeadline statement={statement} size="md" />
            <p className="text-right text-xs text-muted-foreground">
              FlowFi
              <br />
              Cycle Statement
            </p>
          </div>
          <div className="mt-3">
            <StatementReconciliation statement={statement} />
          </div>
          <div className="mt-3 border-t border-border pt-3">
            <StatementBreakdown statement={statement} />
          </div>
          {statement.rows.length > 0 && (
            <ul className="mt-3 max-h-56 divide-y divide-border overflow-y-auto border-t border-border px-2">
              {statement.rows.map((r) => (
                <StatementActivityRow key={r.key} statement={statement} row={r} />
              ))}
            </ul>
          )}
          <details className="mt-3 border-t border-border pt-2">
            <summary className="cursor-pointer text-xs font-semibold text-foreground">Calculation</summary>
            <div className="mt-2">
              <StatementCalculation statement={statement} />
            </div>
          </details>
        </div>

        <div>
          <p className="mb-1 text-xs font-semibold text-muted-foreground">Message preview</p>
          <pre className="max-h-40 overflow-y-auto rounded-md border border-border bg-muted/40 p-3 font-sans text-xs whitespace-pre-wrap text-foreground">
            {text}
          </pre>
          <p className="mt-1 text-[11px] text-muted-foreground">Sent as: “{sharedPositionLine(statement)}”</p>
        </div>

        <div className="grid grid-cols-3 gap-2">
          <ClayButton
            type="button"
            variant="primary"
            onClick={() => window.open(whatsAppShareUrl(text, phone), "_blank", "noopener,noreferrer")}
            className="gap-1.5 text-xs"
          >
            <MessageCircle className="size-4" />
            WhatsApp
          </ClayButton>
          <ClayButton type="button" variant="secondary" onClick={copyText} className="gap-1.5 text-xs">
            <Copy className="size-4" />
            Copy Text
          </ClayButton>
          <ClayButton type="button" variant="secondary" onClick={downloadPdf} disabled={pdfBusy} className="gap-1.5 text-xs">
            <FileDown className="size-4" />
            {pdfBusy ? "Creating…" : "PDF"}
          </ClayButton>
        </div>
      </DialogContent>
    </Dialog>
  );
}
