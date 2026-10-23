"use client";

import Link from "next/link";
import { AlertTriangle, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { describePartialImport, type PartialImportNotice } from "../lib/import-messages";
import { FOCUS_RING } from "./candidate-row-parts";

/**
 * Persistent, accessible warning for an import that created the transaction but not everything after it. Unlike a toast it
 * stays until the reviewer closes it, is announced when it appears (`role="alert"`), and never shows raw error text. It offers
 * only safe next steps: open Transactions to finish the person/split by hand, remove the leftover queue entry (a plain
 * dismissal with Undo — the transaction already exists), or acknowledge. Nothing here retries or recreates a transaction.
 */
export function PartialImportNotices({
  notices,
  stillQueued,
  onRemoveFromQueue,
  onClose,
}: {
  notices: PartialImportNotice[];
  /** Candidate ids that are still in the queue right now (the "remove" button only makes sense for those). */
  stillQueued: ReadonlySet<string>;
  onRemoveFromQueue: (candidateId: string) => void;
  onClose: (candidateId: string) => void;
}) {
  if (notices.length === 0) return null;
  const btn = cn("inline-flex min-h-10 items-center justify-center rounded-[8px] border border-border-strong bg-card px-3.5 text-sm font-semibold text-foreground hover:bg-secondary", FOCUS_RING);
  return (
    <div className="flex flex-col gap-2" data-testid="partial-import-notices">
      {notices.map((notice) => {
        const d = describePartialImport(notice);
        return (
          <section key={notice.id} role="alert" aria-labelledby={`partial-${notice.id}`} className="rounded-2xl border border-warning/70 bg-warning/12 p-4 text-sm text-foreground">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden />
              <div className="min-w-0 flex-1">
                <h2 id={`partial-${notice.id}`} className="text-sm font-bold">
                  {d.title}
                </h2>
                <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-[13px] text-foreground/90">
                  {d.facts.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
                <p className="mt-2 text-[13px] font-semibold">What to do</p>
                <ol className="list-decimal space-y-0.5 pl-4 text-[13px] text-foreground/90">
                  {d.steps.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ol>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Link href="/transactions" className={btn}>
                    Open Transactions
                  </Link>
                  {stillQueued.has(notice.id) && (
                    <button type="button" className={btn} onClick={() => onRemoveFromQueue(notice.id)}>
                      Remove from queue
                    </button>
                  )}
                </div>
              </div>
              <button type="button" aria-label={`Close notice for ${notice.merchant}`} onClick={() => onClose(notice.id)} className={cn("flex size-10 shrink-0 items-center justify-center rounded-[8px] text-muted-foreground hover:bg-secondary", FOCUS_RING)}>
                <X className="size-4" aria-hidden />
              </button>
            </div>
          </section>
        );
      })}
    </div>
  );
}
