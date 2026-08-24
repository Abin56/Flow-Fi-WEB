"use client";

import { Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The Action column is a single "open transaction controls" affordance —
 * everything a row can be managed for (amount, person, split, ledger,
 * exclude from totals, transfer/EMI/loan detail, ...) lives in the existing
 * Inspector (`RightSidebar`); this button's only job is to open it for this
 * row, keeping the grid itself a clean scan of No/Date/Merchant/Amount/Status.
 */
export function ActionCell({
  isFocused,
  onFocus,
  onOpenInspector,
}: {
  isFocused: boolean;
  onFocus: () => void;
  onOpenInspector: () => void;
}) {
  return (
    <div className="flex h-full w-full items-center justify-center">
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        aria-label="Open transaction controls"
        className={cn("size-7", isFocused && "ring-2 ring-inset ring-primary")}
        onClick={() => {
          onFocus();
          onOpenInspector();
        }}
      >
        <Settings2 className="size-3.5" />
      </Button>
    </div>
  );
}
