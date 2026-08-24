"use client";

import { CheckCircle2, ChevronDown, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { FinancialDocument, FinancialDocumentStatus } from "@/lib/models/financial-document";
import { applyTabFilter, deriveActiveTab, type StudioFilters, type StudioTabKey } from "../lib/filters";
import { computeStudioHeaderMetrics } from "../lib/studio-metrics";
import type { GridRow } from "../lib/grid-types";

const STATUS_META: Record<FinancialDocumentStatus, { label: string; tone: "muted" | "warning" | "success" }> = {
  uploaded: { label: "Uploaded", tone: "muted" },
  decrypting: { label: "Decrypting", tone: "muted" },
  parsing: { label: "Parsing", tone: "muted" },
  awaiting_password: { label: "Awaiting password", tone: "warning" },
  parsed: { label: "Parsed", tone: "success" },
  needs_review: { label: "Needs review", tone: "warning" },
  imported: { label: "Imported", tone: "success" },
  failed: { label: "Failed", tone: "warning" },
};

const STATUS_TONE_CLASS: Record<"muted" | "warning" | "success", string> = {
  muted: "border-border bg-muted text-muted-foreground",
  warning: "border-warning/30 bg-warning/10 text-warning",
  success: "border-success/30 bg-success/10 text-success",
};

interface MetricDef {
  key: StudioTabKey;
  label: string;
  value: number;
}

/** A compact stat, not a card — a number + a label with hairline separators between them, matching Excel/Linear/Stripe-density workspace chrome rather than a dashboard of pill widgets. */
function StatItem({ metric, active, onClick }: { metric: MetricDef; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex flex-col items-center gap-0.5 px-2.5 py-0.5 leading-none transition-colors",
        active ? "text-primary" : "text-foreground hover:text-primary",
      )}
    >
      <span className="text-sm font-semibold tabular-nums">{metric.value}</span>
      <span className="text-[10px] whitespace-nowrap text-muted-foreground">{metric.label}</span>
    </button>
  );
}

export function StudioHeader({
  document,
  sourceAccountName,
  rows,
  selectedCount,
  filters,
  onFiltersChange,
  showSelectedOnly,
  onShowSelectedOnlyChange,
  onApprove,
  approveDisabled,
  approveLabel,
}: {
  document: FinancialDocument | undefined;
  sourceAccountName: string;
  /** Full, unfiltered document rows — metrics reflect the whole document's review progress, not the current view (matches the toolbar's existing convention). */
  rows: GridRow[];
  selectedCount: number;
  filters: StudioFilters;
  onFiltersChange: (next: StudioFilters) => void;
  showSelectedOnly: boolean;
  onShowSelectedOnlyChange: (value: boolean) => void;
  onApprove: () => void;
  approveDisabled: boolean;
  approveLabel: string;
}) {
  const metrics = computeStudioHeaderMetrics(rows, selectedCount);
  const statusMeta = document ? STATUS_META[document.status] : STATUS_META.uploaded;
  const activeTab = deriveActiveTab(filters, showSelectedOnly);

  function selectTab(tab: StudioTabKey) {
    onShowSelectedOnlyChange(tab === "selected");
    onFiltersChange(applyTabFilter(filters, tab));
  }

  // Only the four numbers a reviewer needs at a glance stay in the primary strip (brief §1); the
  // rest (Selected/Transfer Candidates/Low Confidence) are still real filter tabs — same
  // `applyTabFilter`/`deriveActiveTab` contract — just tucked behind "More" so they don't compete
  // for attention.
  const primaryMetrics: MetricDef[] = [
    { key: "all", label: "Total Rows", value: metrics.totalRows },
    { key: "needsReview", label: "Needs Review", value: metrics.needsReview },
    { key: "duplicates", label: "Duplicates", value: metrics.duplicates },
    { key: "readyToImport", label: "Ready to Import", value: metrics.readyToImport },
  ];
  const moreMetrics: MetricDef[] = [
    { key: "selected", label: "Selected", value: metrics.selectedCount },
    { key: "transfers", label: "Transfer Candidates", value: metrics.transferCandidates },
    { key: "lowConfidence", label: "Low Confidence", value: metrics.lowConfidence },
  ];
  const moreActive = moreMetrics.some((m) => m.key === activeTab);

  return (
    <div className="surface-primary flex flex-wrap items-center gap-3 rounded-2xl px-4 py-2.5">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <FileText className="size-4" />
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-sm font-semibold text-foreground">{document?.documentNumber ?? "Statement"}</h1>
            <span className={cn("rounded-full border px-1.5 py-0.5 text-[10px] font-medium", STATUS_TONE_CLASS[statusMeta.tone])}>{statusMeta.label}</span>
          </div>
          <p className="truncate text-xs text-muted-foreground">{sourceAccountName}</p>
        </div>
      </div>

      <div className="hidden h-8 w-px shrink-0 bg-border md:block" />

      <div className="flex min-w-0 flex-1 items-center justify-center gap-0.5 overflow-x-auto">
        {primaryMetrics.map((metric, i) => (
          <div key={metric.key} className="flex items-center">
            {i > 0 && <span className="mx-1 h-6 w-px shrink-0 bg-border" />}
            <StatItem metric={metric} active={activeTab === metric.key} onClick={() => selectTab(metric.key)} />
          </div>
        ))}

        <span className="mx-1 h-6 w-px shrink-0 bg-border" />
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={cn(
                "flex shrink-0 items-center gap-0.5 rounded-md px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground",
                moreActive && "font-medium text-primary",
              )}
            >
              More <ChevronDown className="size-3" />
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-56" align="center">
            <div className="flex flex-col gap-0.5">
              {moreMetrics.map((metric) => (
                <button
                  key={metric.key}
                  type="button"
                  onClick={() => selectTab(metric.key)}
                  className={cn(
                    "flex items-center justify-between rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted",
                    activeTab === metric.key && "bg-primary/10 text-primary",
                  )}
                >
                  <span>{metric.label}</span>
                  <span className="font-medium tabular-nums">{metric.value}</span>
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      </div>

      <Button onClick={onApprove} disabled={approveDisabled} className="shrink-0">
        <CheckCircle2 /> {approveLabel}
      </Button>
    </div>
  );
}
