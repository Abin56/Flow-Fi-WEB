"use client";

import * as React from "react";
import { ToggleGroup as ToggleGroupPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

/**
 * Single-select segmented control (Ocean-styled) — the "compact, extremely
 * quick to change" pattern the redesign brief asks for in place of a
 * dropdown. First consumer is Transaction Studio's Ownership cell, but this
 * lives in `components/ui/` because a segmented toggle is a reusable
 * primitive at the same tier as `Badge`/`Progress`, not something specific
 * to one feature.
 */
function ToggleGroup({
  className,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Root>) {
  return (
    <ToggleGroupPrimitive.Root
      data-slot="toggle-group"
      className={cn("inline-flex items-center gap-0.5 rounded-full bg-muted p-0.5", className)}
      {...props}
    />
  );
}

function ToggleGroupItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Item>) {
  return (
    <ToggleGroupPrimitive.Item
      data-slot="toggle-group-item"
      className={cn(
        "inline-flex h-6 items-center justify-center rounded-full px-2.5 text-[11px] font-medium whitespace-nowrap text-muted-foreground transition-all outline-none",
        "hover:text-foreground",
        "data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=on]:shadow-sm",
        "focus-visible:ring-2 focus-visible:ring-ring/50",
        "disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
      {...props}
    >
      {children}
    </ToggleGroupPrimitive.Item>
  );
}

export { ToggleGroup, ToggleGroupItem };
