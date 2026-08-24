"use client";

import { useState } from "react";
import { Lock } from "lucide-react";
import { ClayButton } from "@/components/clay/clay-button";
import { EnterPasswordDialog } from "@/features/statement-review/components/enter-password-dialog";
import type { FinancialDocument } from "@/lib/models/financial-document";

/** `document.status === "awaiting_password"` — the recoverable, user-actionable state (docs/state-machine.md T3a). */
export function PasswordRequiredCard({ document }: { document: FinancialDocument }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="flex items-start gap-2 rounded-xl bg-warning/10 px-3 py-2.5 text-xs text-warning-foreground">
      <Lock className="mt-0.5 size-3.5 shrink-0" />
      <div className="flex flex-col gap-2">
        <span>This statement is password protected.</span>
        <ClayButton size="sm" variant="secondary" onClick={() => setOpen(true)} className="self-start">
          Enter Password
        </ClayButton>
      </div>
      <EnterPasswordDialog open={open} onOpenChange={setOpen} document={document} />
    </div>
  );
}
