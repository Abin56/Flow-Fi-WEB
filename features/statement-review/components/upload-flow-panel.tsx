"use client";

import { useMemo } from "react";
import { CheckCircle2, FileText, X } from "lucide-react";
import { useFinancialDocuments } from "@/hooks/use-financial-documents";
import { useDocumentImportRecords } from "@/hooks/use-document-import-records";
import { computeDocumentAnalysisStats } from "@/features/statement-review/lib/summary";
import { ProcessingChecklist } from "@/features/statement-review/components/processing-checklist";
import { AnalysisCompletePanel } from "@/features/statement-review/components/analysis-complete-panel";
import { StatusConfidenceLegend } from "@/features/statement-review/components/status-confidence-legend";

interface UploadFlowPanelProps {
  documentId: string;
  fileName: string;
  onDismiss: () => void;
}

const IN_FLIGHT_STATUSES = new Set(["uploaded", "decrypting", "parsing"]);

/**
 * The live 3-step upload → processing → analysis-complete view for one just-uploaded statement,
 * plus a static confidence/status legend. Card 1 ("Upload Statement") already happened in
 * `UploadStatementDialog` — this panel picks up from there and tracks the real document as it
 * moves through `docs/state-machine.md`'s status union, via the same live listeners the rest of
 * this feature uses (`useFinancialDocuments`, `useDocumentImportRecords`).
 */
export function UploadFlowPanel({ documentId, fileName, onDismiss }: UploadFlowPanelProps) {
  const { data: documents = [] } = useFinancialDocuments();
  const document = documents.find((d) => d.id === documentId);
  const status = document?.status;

  const isProcessing = status === undefined || IN_FLIGHT_STATUSES.has(status);
  const isDone = status !== undefined && !IN_FLIGHT_STATUSES.has(status);

  const { data: records = [] } = useDocumentImportRecords(isDone ? documentId : "");
  const stats = useMemo(() => computeDocumentAnalysisStats(records), [records]);

  return (
    <div className="surface-primary relative flex flex-col gap-4 rounded-3xl p-4">
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="absolute top-3 right-3 flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
      >
        <X className="size-4" />
      </button>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[repeat(3,minmax(0,1fr))_16rem]">
        <div className="flex flex-col gap-3 rounded-3xl border border-border/50 bg-card p-4">
          <div className="flex items-center gap-2">
            <span className="flex size-6 items-center justify-center rounded-full bg-success text-success-foreground">
              <CheckCircle2 className="size-4" />
            </span>
            <h3 className="text-sm font-semibold text-foreground">Upload Statement</h3>
          </div>
          <div className="flex items-center gap-2 rounded-xl bg-muted/50 px-3 py-2 text-xs text-foreground">
            <FileText className="size-4 shrink-0 text-primary" />
            <span className="truncate">{fileName}</span>
          </div>
        </div>

        <ProcessingChecklist isProcessing={isProcessing} isDone={isDone} />

        <AnalysisCompletePanel documentId={documentId} status={status} stats={stats} isDone={isDone} onDismiss={onDismiss} />

        <StatusConfidenceLegend />
      </div>
    </div>
  );
}
