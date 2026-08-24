"use client";

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { RecordOwnership } from "@/lib/models/document-import";
import type { GridRow } from "../../../lib/grid-types";

/**
 * Compact "Mine / Shared / Other" segmented control — the redesign brief's
 * fast alternative to burying ownership inside the Action dropdown. Writes
 * through the same `ownershipToAction` → `actionToAxesPatch` path the Action
 * column and the Inspector's `FlowOwnershipHeader` use, so this can never
 * produce an Action/Ownership disagreement. Disabled outside expense-shaped
 * rows, mirroring `FlowOwnershipHeader`'s existing `flowType !== "expense"`
 * gate rather than expanding what the model actually supports today.
 */
export function OwnershipCell({
  row,
  isFocused,
  onFocus,
  onCommit,
}: {
  row: GridRow;
  isFocused: boolean;
  onFocus: () => void;
  onCommit: (value: RecordOwnership) => void;
}) {
  const disabled = row.flowType !== "expense";

  const control = (
    <ToggleGroup
      type="single"
      value={row.ownership ?? undefined}
      disabled={disabled}
      onValueChange={(value) => {
        if (value) onCommit(value as RecordOwnership);
      }}
      className="w-full"
    >
      <ToggleGroupItem value="mine" className="flex-1">
        Mine
      </ToggleGroupItem>
      <ToggleGroupItem value="shared" className="flex-1">
        Shared
      </ToggleGroupItem>
      <ToggleGroupItem value="someone_else" className="flex-1">
        Other
      </ToggleGroupItem>
    </ToggleGroup>
  );

  return (
    <div
      className={cn("flex h-full w-full items-center px-1.5", isFocused && "rounded-[5px] ring-2 ring-inset ring-primary/60")}
      onClick={onFocus}
    >
      {disabled ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="w-full">{control}</span>
          </TooltipTrigger>
          <TooltipContent>Ownership only applies to expenses</TooltipContent>
        </Tooltip>
      ) : (
        control
      )}
    </div>
  );
}
