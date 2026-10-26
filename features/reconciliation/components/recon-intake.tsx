"use client";

/**
 * Phase 2 entry: paste statement rows to reconcile. (The Smart Capture → Reconciliation handoff comes later; Smart
 * Capture's own navigation is unchanged.) The text is parsed on this device by Smart Capture's parser and is never
 * saved — only the rows' working values survive a refresh.
 */

import { useState } from "react";
import { ClipboardPaste, Lock } from "lucide-react";
import { ClayButton } from "@/components/clay/clay-button";
import { Textarea } from "@/components/ui/textarea";

export function ReconIntake({ onStart }: { onStart: (text: string) => { error: string | null } }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  return (
    <section className="surface-primary flex flex-col gap-4 rounded-3xl p-5 sm:p-6" aria-labelledby="recon-intake-title">
      <div className="flex items-start gap-3">
        <div className="grid size-10 shrink-0 place-items-center rounded-2xl bg-primary/15 text-primary-accent-text">
          <ClipboardPaste className="size-5" />
        </div>
        <div className="min-w-0">
          <h2 id="recon-intake-title" className="font-heading text-base font-semibold text-foreground">
            Paste statement rows to reconcile
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">Copy the transaction table from a statement. FlowFi compares each row with what&apos;s already recorded — nothing is imported or changed.</p>
        </div>
      </div>
      <Textarea
        aria-label="Statement rows"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setError(null);
        }}
        rows={8}
        placeholder={"05/09/2026  SWIGGY BANGALORE        452.00\n06/09/2026  AMAZON PAY INDIA     1,299.00\n08/09/2026  REFUND MYNTRA          999.00 Cr"}
        className="min-h-40 rounded-2xl font-mono text-xs"
      />
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <ClayButton
          onClick={() => {
            const result = onStart(text);
            setError(result.error);
          }}
        >
          Compare rows
        </ClayButton>
        <p className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-muted-foreground">
          <Lock className="size-3.5 shrink-0" />
          Read on this device. The pasted text and any screenshot are never saved.
        </p>
      </div>
    </section>
  );
}
