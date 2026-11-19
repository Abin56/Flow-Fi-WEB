"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Scrollable region. A plain native scroller (not Radix ScrollArea, which hides the native scrollbar and draws its
 * own proportional bar), so on desktop it gets the app-wide capsule scrollbar like every other scroll area — see
 * components/layout/capsule-scrollbars.tsx.
 */
function ScrollArea({ className, children, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="scroll-area"
      className={cn("relative min-h-0 overflow-y-auto overscroll-contain rounded-[inherit] outline-none", className)}
      {...props}
    >
      {children}
    </div>
  )
}

export { ScrollArea }
