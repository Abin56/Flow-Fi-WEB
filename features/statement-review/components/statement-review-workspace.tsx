"use client";

import { FileStack, Plus } from "lucide-react";
import { useState } from "react";
import { ClayButton } from "@/components/clay/clay-button";
import { EmptyState, SmartToolbar } from "@/components/finance";
import { Skeleton } from "@/components/ui/skeleton";
import { Stagger } from "@/components/foundation/animated-container";
import { useCreditCards } from "@/hooks/use-credit-cards";
import { useFinancialDocuments } from "@/hooks/use-financial-documents";
import { useAuthStore } from "@/store/auth-store";
import { DocumentStatusCard } from "@/features/statement-review/components/document-status-card";
import { UploadStatementDialog } from "@/features/statement-review/components/upload-statement-dialog";
import { UploadFlowPanel } from "@/features/statement-review/components/upload-flow-panel";

/**
 * Statement Intelligence Workspace — upload + status-tracking pass only.
 *
 * Real, working: PDF selection -> client-side cap validation -> hash ->
 * dedupe check -> Storage upload -> `financialDocuments` doc creation ->
 * live status tracking through the real state machine
 * (docs/state-machine.md).
 *
 * Deliberately NOT built here: the spreadsheet-grade transaction review
 * table docs/statement-workspace-vision.md describes. Building it against
 * real uploaded documents would mean either fabricating rows (this
 * project's single most important rule against inventing data) or reading
 * a `StatementWorkspaceModel` that nothing currently writes for a real
 * upload — verified by tracing functions/src/worker/document-analyzer-worker.ts
 * and functions/src/pipeline/pdf-document-pipeline.ts, which only open and
 * validate the PDF today. `DocumentStatusCard` surfaces that gap honestly
 * instead of hiding it.
 */
export function StatementReviewWorkspace() {
  const uid = useAuthStore((s) => s.user?.uid);
  const { data: documents = [], isLoading: documentsLoading } = useFinancialDocuments();
  const { data: creditCards = [], isLoading: cardsLoading } = useCreditCards();
  const [uploadOpen, setUploadOpen] = useState(false);
  const [activeFlow, setActiveFlow] = useState<{ documentId: string; fileName: string } | null>(null);

  if (documentsLoading || cardsLoading) {
    return (
      <div className="flex flex-col gap-6 px-1">
        <h1 className="font-heading text-xl font-semibold tracking-tight text-foreground">Statement Review</h1>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-28 rounded-3xl" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 px-1">
      <SmartToolbar
        left={
          <div className="flex items-baseline gap-2">
            <h1 className="font-heading text-xl font-semibold tracking-tight text-foreground">Statement Review</h1>
            <span className="text-sm text-muted-foreground">{documents.length} uploaded</span>
          </div>
        }
        actions={
          <ClayButton size="sm" onClick={() => setUploadOpen(true)} className="gap-1.5">
            <Plus className="size-3.5" />
            Upload Statement
          </ClayButton>
        }
      />

      {activeFlow && (
        <UploadFlowPanel
          documentId={activeFlow.documentId}
          fileName={activeFlow.fileName}
          onDismiss={() => setActiveFlow(null)}
        />
      )}

      {documents.length === 0 ? (
        <EmptyState
          icon={FileStack}
          title="No statements uploaded yet"
          description="Upload a credit card statement PDF to start tracking its processing status."
          actionLabel="Upload Statement"
          onAction={() => setUploadOpen(true)}
        />
      ) : (
        <Stagger className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {documents.map((document) => (
            <DocumentStatusCard key={document.id} document={document} />
          ))}
        </Stagger>
      )}

      {uid && (
        <UploadStatementDialog
          open={uploadOpen}
          onOpenChange={setUploadOpen}
          uid={uid}
          creditCards={creditCards}
          onUploaded={(documentId, fileName) => setActiveFlow({ documentId, fileName })}
        />
      )}
    </div>
  );
}
