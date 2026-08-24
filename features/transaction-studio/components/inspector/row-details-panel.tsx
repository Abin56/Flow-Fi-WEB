"use client";

import { Copy } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { formatCurrencyPrecise } from "@/lib/format";
import { actionBadgeClassName, actionLabel, deriveRecordAction } from "../../lib/action-metadata";
import type { GridRow } from "../../lib/grid-types";
import { InspectorShell } from "./inspector-shell";
import { cn } from "@/lib/utils";

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">{label}</span>
      <div className="text-sm text-foreground">{value}</div>
    </div>
  );
}

export function RowDetailsPanel({ row, onClose }: { row: GridRow; onClose: () => void }) {
  const dateFormat = new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric" });

  return (
    <InspectorShell title={row.counterpartyNormalized ?? row.counterpartyRaw} subtitle={dateFormat.format(row.date)} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <span className={cn("truncate text-lg font-semibold tabular-nums", row.direction === "credit" ? "text-success" : "text-expense")}>
            {row.direction === "credit" ? "+" : "−"}
            {formatCurrencyPrecise(row.amount)}
          </span>
          <Badge variant="outline" className={cn("text-[11px]", actionBadgeClassName(deriveRecordAction(row)))}>
            {actionLabel(deriveRecordAction(row))}
          </Badge>
        </div>

        <Field label="Category" value={row.category ?? "Uncategorized"} />

        {row.referenceNumber && (
          <Field
            label="Reference Number"
            value={
              <div className="flex items-center gap-1.5">
                <span className="font-mono text-xs">{row.referenceNumber}</span>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Copy reference number"
                  onClick={() => void navigator.clipboard?.writeText(row.referenceNumber ?? "")}
                >
                  <Copy className="size-3" />
                </Button>
              </div>
            }
          />
        )}

        <Field
          label="Raw extracted text"
          value={<span className="block rounded-md bg-muted px-2 py-1.5 font-mono text-[11px] text-muted-foreground">{row.rawText}</span>}
        />

        <Field label="Source" value={`Page ${row.sourcePage}, line ${row.sourceLineIndex + 1}`} />

        {row.tags.length > 0 && (
          <Field
            label="Tags"
            value={
              <div className="flex flex-wrap gap-1">
                {row.tags.map((tag) => (
                  <Badge key={tag} variant="outline" className="text-[11px]">
                    {tag}
                  </Badge>
                ))}
              </div>
            }
          />
        )}

        {row.notes && <Field label="Notes" value={<p className="text-sm whitespace-pre-wrap text-muted-foreground">{row.notes}</p>} />}

        <ConfidenceField confidenceScores={row.confidenceScores} />
      </div>
    </InspectorShell>
  );
}

function ConfidenceField({ confidenceScores }: { confidenceScores: Record<string, number> }) {
  const overall = confidenceScores.overall ?? 1;
  const percent = Math.round(overall * 100);
  const tone = percent >= 90 ? "High" : percent >= 70 ? "Medium" : "Low";
  const toneClass = percent >= 90 ? "text-success" : percent >= 70 ? "text-warning" : "text-danger";
  const perField = Object.entries(confidenceScores).filter(([field]) => field !== "overall");

  return (
    <Field
      label="Confidence"
      value={
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between text-xs">
            <span className={cn("font-semibold", toneClass)}>{tone}</span>
            <span className={cn("font-semibold tabular-nums", toneClass)}>{percent}%</span>
          </div>
          <Progress value={percent} className="h-1.5" />
          {perField.length > 0 && (
            <div className="mt-1 flex flex-col gap-1">
              {perField.map(([field, score]) => (
                <div key={field} className="flex items-center justify-between text-xs">
                  <span className="capitalize text-muted-foreground">{field}</span>
                  <span className="font-medium tabular-nums text-muted-foreground">{Math.round(score * 100)}%</span>
                </div>
              ))}
            </div>
          )}
        </div>
      }
    />
  );
}
