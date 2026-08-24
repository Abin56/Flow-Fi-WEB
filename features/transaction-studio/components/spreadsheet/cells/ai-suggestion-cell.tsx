"use client";

import { Lightbulb } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import type { AiSuggestion, GridRow } from "../../../lib/grid-types";

export type { AiSuggestion };

/** Builds the list of one-click-accept suggestions for a row from fields the parser/staging pipeline already populated (§6: "only ever a suggestion, never auto-applied"). */
export function buildAiSuggestions(row: GridRow, opts: { emiLikely?: boolean; onAcceptCategory: (category: string) => void; onMarkEmiLikely: () => void; onMarkRecurring: () => void }): AiSuggestion[] {
  const suggestions: AiSuggestion[] = [];
  if (row.suggestedCategory && row.suggestedCategory.value !== row.category) {
    suggestions.push({ label: `Category: ${row.suggestedCategory.value}`, onAccept: () => opts.onAcceptCategory(row.suggestedCategory!.value) });
  }
  if (opts.emiLikely && row.flowType == null) {
    suggestions.push({ label: "Likely EMI", onAccept: opts.onMarkEmiLikely });
  }
  if (row.recurringDetected || row.subscriptionDetected) {
    suggestions.push({ label: row.subscriptionDetected ? "Likely subscription" : "Recurring", onAccept: opts.onMarkRecurring });
  }
  if (row.transferDetected) {
    suggestions.push({ label: "Likely transfer", onAccept: opts.onMarkRecurring });
  }
  return suggestions;
}

export function AiSuggestionCell({ suggestions }: { suggestions: AiSuggestion[] }) {
  if (suggestions.length === 0) {
    return <div className="flex h-full w-full items-center justify-center px-2.5 text-muted-foreground/30">·</div>;
  }
  return (
    <div className="flex h-full w-full items-center justify-center px-2.5">
      <Popover>
        <PopoverTrigger asChild>
          <button type="button" className="flex items-center justify-center rounded-full p-1 text-icon-ai hover:bg-icon-ai/10" aria-label={`${suggestions.length} AI suggestion(s)`}>
            <Lightbulb className="size-4" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-56 p-2" align="center">
          <div className="flex flex-col gap-1">
            {suggestions.map((s) => (
              <Button key={s.label} variant="ghost" size="sm" className="justify-start text-xs" onClick={s.onAccept}>
                {s.label}
              </Button>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
