"use client";

import { useEffect, useState, type ReactNode } from "react";
import { DashEmpty, DashPanel } from "@/features/dashboard/components/dash-ui";
import type { DashboardPanelState } from "@/features/dashboard/hooks/use-dashboard-snapshots-pending";
import { cn } from "@/lib/utils";

const SLOW_LOAD_MS = 12_000;

export function DashboardPanelGate({ label, state, compact = false, children }: { label: string; state: DashboardPanelState; compact?: boolean; children: ReactNode }) {
  if (state === "ready") return children;
  return <PendingPanel key={state} label={label} failed={state === "unavailable"} compact={compact}>{children}</PendingPanel>;
}

function PendingPanel({ label, failed, compact, children }: { label: string; failed: boolean; compact: boolean; children: ReactNode }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (failed) return;
    const timer = window.setTimeout(() => setSlow(true), SLOW_LOAD_MS);
    return () => window.clearTimeout(timer);
  }, [failed]);

  if (!failed && !slow) return children;
  return (
    <DashPanel label={label} className={compact ? "h-auto" : undefined}>
      <h2 className={cn("border-b border-border font-heading text-sm font-semibold", compact ? "flex h-9 items-center px-3" : "px-4 py-3")}>{label}</h2>
      <div role="status">
        <DashEmpty title={failed ? "Data unavailable" : "Still waiting for data"} description={failed ? "This card will update when its data is available." : "This card will update automatically when its data arrives."} compact={compact} />
      </div>
    </DashPanel>
  );
}
