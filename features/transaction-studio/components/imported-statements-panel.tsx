"use client";

import { FileText } from "lucide-react";
import { cn } from "@/lib/utils";
import type { FinancialDocument } from "@/lib/models/financial-document";

const REVIEWABLE_STATUSES = new Set(["parsed", "needs_review"]);

const DATE_FORMAT = new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short" });

export function ImportedStatementsPanel({
  documents,
  activeDocumentId,
  onSelect,
}: {
  documents: FinancialDocument[];
  activeDocumentId: string | null;
  onSelect: (documentId: string) => void;
}) {
  const reviewable = documents.filter((d) => REVIEWABLE_STATUSES.has(d.status));

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl border border-border bg-surface">
      <div className="border-b border-border px-3 py-2.5">
        <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Imported Statements</h3>
      </div>
      <div className="flex-1 overflow-y-auto p-1.5">
        {reviewable.length === 0 && <p className="px-2 py-4 text-center text-xs text-muted-foreground">No statements ready for review yet.</p>}
        {reviewable.map((doc) => (
          <button
            key={doc.id}
            type="button"
            onClick={() => onSelect(doc.id)}
            className={cn(
              "flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-muted",
              doc.id === activeDocumentId && "bg-primary/10 hover:bg-primary/10",
            )}
          >
            <FileText className={cn("mt-0.5 size-4 shrink-0", doc.id === activeDocumentId ? "text-primary" : "text-muted-foreground")} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-foreground">{doc.documentNumber ?? "Statement"}</p>
              <p className="truncate text-xs text-muted-foreground">
                {doc.documentDate ? DATE_FORMAT.format(doc.documentDate) : DATE_FORMAT.format(doc.uploadedAt)}
                {doc.status === "needs_review" && " · Needs review"}
              </p>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
