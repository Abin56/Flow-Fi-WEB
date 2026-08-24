"use client";

import { FileText, TableProperties } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
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

  return (
    <div className="flex flex-col gap-3 rounded-3xl border border-border/50 bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <FileText className="size-4" />
          </div>
          <div>
            <p className="text-sm font-semibold text-foreground">Statement — {document.id.slice(0, 8)}</p>
            <p className="text-xs text-muted-foreground">Uploaded {DATE_FORMAT.format(document.uploadedAt)}</p>
          </div>
        </div>
        <ClayBadge tone={STATUS_TONE[document.status]}>{STATUS_LABEL[document.status]}</ClayBadge>
      </div>

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
