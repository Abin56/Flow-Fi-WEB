"use client";

/**
 * Append-only history of credit-limit corrections for one card/facility, plus reversal — the "Correction
 * history" surface Part D asks for. Loaded lazily (only while the sheet is open) since Balance Control's main
 * table must stay cheap to render with many cards.
 */

import { useEffect, useState } from "react";
import { Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { formatCurrencyPrecise } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { CreditLimitCorrection, CreditLimitCorrectionReason } from "@/lib/models/credit-limit-correction";
import type { LimitCorrectionTarget } from "@/lib/repositories/credit-limit-correction-repository";
import { useLimitCorrection } from "../hooks/use-limit-correction";
import { toast } from "@/store/toast-store";

const REASON_LABEL: Record<CreditLimitCorrectionReason, string> = {
  bankIncreased: "Bank increased the limit",
  bankDecreased: "Bank decreased the limit",
  dataEntryError: "Data entry error",
  sharedLimitRestructured: "Shared facility restructured",
  other: "Other",
};

export interface LimitCorrectionHistoryProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  productName: string;
  target: LimitCorrectionTarget;
}

export function LimitCorrectionHistory({ open, onOpenChange, productName, target }: LimitCorrectionHistoryProps) {
  const actions = useLimitCorrection();
  const [visibleEntries, setVisibleEntries] = useState<CreditLimitCorrection[] | null>(null);
  const [reversingId, setReversingId] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !actions) return;
    // Guards against a stale response (target/open changed again before this fetch resolved) overwriting a
    // newer one — read only from this closure, never during render, so it stays outside the ref-during-render
    // restriction. No synchronous "clear it first" setState either: a stale response is simply dropped, and
    // the previous list stays on screen until the current request resolves.
    let current = true;
    actions.historyFor(target).then((result) => {
      if (current) setVisibleEntries(result);
    });
    return () => {
      current = false;
    };
    // Re-fetch each time the sheet opens — intentionally not a live listener (a short, infrequently-opened list).
  }, [open, actions, target]);

  async function handleReverse(correction: CreditLimitCorrection) {
    if (!actions) return;
    setReversingId(correction.id);
    try {
      const result = await actions.reverseCorrection(target, correction);
      if (result.status === "alreadyReversed") {
        toast.error("Already reversed", "Someone already undid this correction.");
      } else {
        toast.success("Correction reversed", `Restored ₹${correction.previousLimit.toLocaleString("en-IN")}.`);
      }
      const refreshed = await actions.historyFor(target);
      setVisibleEntries(refreshed);
    } catch (e) {
      toast.error("Couldn't reverse", e instanceof Error ? e.message : "Please try again.");
    } finally {
      setReversingId(null);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="mx-auto w-full sm:max-w-lg" data-testid="limit-correction-history-sheet">
        <SheetHeader>
          <SheetTitle>Correction history — {productName}</SheetTitle>
          <SheetDescription>Every credit-limit correction applied here, newest first.</SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-2 overflow-y-auto px-4 pb-4">
          {visibleEntries == null && <p className="text-sm text-muted-foreground" data-testid="history-loading">Loading…</p>}
          {visibleEntries != null && visibleEntries.length === 0 && <p className="text-sm text-muted-foreground" data-testid="history-empty">No corrections yet.</p>}
          {visibleEntries?.map((c) => (
            <div key={c.id} className={cn("rounded-lg border border-border p-3 text-sm", c.reversedAt != null && "opacity-60")} data-testid="history-entry">
              <div className="flex items-center justify-between gap-2">
                <span className={cn("tabular-nums", c.reversedAt != null && "line-through")}>
                  {formatCurrencyPrecise(c.previousLimit)} → <span className="font-medium">{formatCurrencyPrecise(c.newLimit)}</span>
                </span>
                {c.reversedAt == null ? (
                  <Button size="xs" variant="ghost" onClick={() => handleReverse(c)} disabled={reversingId === c.id} data-testid="reverse-correction-button">
                    <Undo2 /> {reversingId === c.id ? "Reversing…" : "Reverse"}
                  </Button>
                ) : (
                  <span className="text-xs text-muted-foreground" data-testid="history-reversed-label">Reversed</span>
                )}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {REASON_LABEL[c.reason]} · Effective {c.effectiveDate.toLocaleDateString("en-IN")} · Applied {c.createdAt.toLocaleDateString("en-IN")}
              </p>
              {c.note && <p className="mt-1 text-xs text-muted-foreground">{c.note}</p>}
            </div>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}
