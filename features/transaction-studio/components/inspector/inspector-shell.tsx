"use client";

import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ReactNode } from "react";

export function InspectorShell({
  title,
  subtitle,
  onClose,
  hideClose = false,
  embedded = false,
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  /** Suppresses the close button — for contexts (e.g. `TransactionManageModal`'s People/Split section) that already have their own enclosing close affordance, where a second X here would be redundant/confusing. */
  hideClose?: boolean;
  /**
   * Drops the outer rounded/border/bg box and its own content padding — for contexts that already
   * render their own bordered card around this (`TransactionManageModal`'s People & Split section),
   * where the default chrome would otherwise nest a second border/box inside the first. Implies
   * `hideClose` (an embedded panel never owns its own close affordance). The docked Inspector
   * (`RightSidebar`) is the one context where this *is* the outermost box, so it keeps the default.
   */
  embedded?: boolean;
  children: ReactNode;
}) {
  if (embedded) {
    return (
      <div className="flex flex-col gap-3">
        <div className="border-b border-border/70 pb-2">
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
        </div>
        {children}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl border border-border bg-surface">
      <div className="flex items-start justify-between gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-foreground">{title}</h3>
          {subtitle && <p className="truncate text-xs text-muted-foreground">{subtitle}</p>}
        </div>
        {!hideClose && (
          <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose}>
            <X className="size-4" />
          </Button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-4">{children}</div>
    </div>
  );
}
