"use client";

import { FileText, TableProperties, Trash2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/finance/confirm-dialog";
import { deleteStatementDocument } from "@/features/statement-review/lib/delete-statement-document";
import { toast } from "@/store/toast-store";
import { ClayBadge } from "@/components/clay/clay-badge";
import { STATUS_LABEL, STATUS_TONE, FAILURE_REASON_LABEL } from "@/features/statement-review/lib/status-labels";
import { PasswordRequiredCard } from "@/features/statement-review/components/password-required-card";
import { DocumentImportRecordsList } from "@/features/statement-review/components/document-import-records-list";
import type { FinancialDocument } from "@/lib/models/financial-document";

const DATE_FORMAT = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" });

/** Friendlier phrasing for the one needs_review reason common enough to deserve it — every other reason still shows as the raw code, same as before. */
function needsReviewMessage(document: FinancialDocument): string {
  if (document.needsReviewReason === "unrecognized_statement_template") {
    return document.detectedBankGuess
      ? `Looks like it might be from ${document.detectedBankGuess} — support for this bank's statement format isn't built yet.`
      : "This statement's bank/format isn't recognized yet.";
  }
  if (document.needsReviewReason === "scanned_pdf_no_text_layer") {
    return "This PDF looks scanned (no readable text), so transactions can't be extracted automatically. Download a text-based statement PDF from your bank instead.";
  }
  return document.needsReviewReason!;
}

/**
 * One `FinancialDocument`'s real, current status. For `"parsed"` /
 * `"needs_review"` documents, renders the real extracted transactions from
 * `users/{uid}/documentImports/{documentId}/records` (written by
 * `functions/src/staging/staging-writer.ts`) via `DocumentImportRecordsList`
 * — read-only, no edit/split/merge/commit (that's the separate Review
 * Workspace, backlog Milestone 8/9).
 */
export function DocumentStatusCard({ document }: { document: FinancialDocument }) {
  const showRecords = document.status === "parsed" || document.status === "needs_review";
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function handleDelete() {
    setDeleting(true);
    try {
      const { outcome } = await deleteStatementDocument(document.id);
      if (outcome === "has_imported_transactions") {
        toast.error(
          "Can't delete this statement",
          "Some of its transactions were already imported, so the statement is kept for reference.",
        );
      } else if (outcome === "still_processing") {
        toast.error("Still processing", "Wait for this statement to finish processing, then delete it.");
      } else {
        // "deleted" and "not_found" both mean it's gone; the live listener removes the card.
        toast.success("Statement deleted");
      }
      setConfirmOpen(false);
    } catch (e) {
      toast.error("Couldn't delete statement", e instanceof Error ? e.message : undefined);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-3xl border border-border/50 bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-2xl bg-primary/10 text-primary-accent-text">
            <FileText className="size-4" />
          </div>
          <div>
            <p className="text-sm font-semibold text-foreground">Statement — {document.id.slice(0, 8)}</p>
            <p className="text-xs text-muted-foreground">Uploaded {DATE_FORMAT.format(document.uploadedAt)}</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <ClayBadge tone={STATUS_TONE[document.status]}>{STATUS_LABEL[document.status]}</ClayBadge>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Delete statement"
            data-testid="delete-statement"
            onClick={() => setConfirmOpen(true)}
            className="text-muted-foreground hover:text-expense"
          >
            <Trash2 />
          </Button>
        </div>
      </div>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Delete this statement?"
        description="The uploaded PDF and its extracted rows will be permanently deleted. This can't be undone. You can upload the PDF again later."
        variant="destructive"
        confirmLabel="Delete permanently"
        onConfirm={handleDelete}
        loading={deleting}
      />

      {document.status === "awaiting_password" && <PasswordRequiredCard document={document} />}

      {document.status === "failed" && document.failureReason && (
        <p className="rounded-xl bg-expense/8 px-3 py-2 text-xs text-expense">
          {FAILURE_REASON_LABEL[document.failureReason]}
          {document.failureMessage ? ` ${document.failureMessage}` : ""}
        </p>
      )}

      {document.status === "needs_review" && document.needsReviewReason && (
        <p className="rounded-xl bg-warning/10 px-3 py-2 text-xs text-warning-foreground">
          {needsReviewMessage(document)}
        </p>
      )}

      {showRecords && (
        <>
          <Button asChild size="sm" className="self-start">
            <Link href={`/statement-review/${document.id}`}>
              <TableProperties /> Open Transaction Studio
            </Link>
          </Button>
          <DocumentImportRecordsList documentId={document.id} />
        </>
      )}
    </div>
  );
}
