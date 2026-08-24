"use client";

import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { ClayButton } from "@/components/clay/clay-button";
import { springs } from "@/lib/motion/tokens";
import { cn } from "@/lib/utils";

interface BulkActionsBarProps {
  selectionCount: number;
  onClear: () => void;
  children?: React.ReactNode;
  className?: string;
}

/** Floating clay bar (elevation 3) that slides/fades in once rows are selected — sticks to the bottom of its
 *  positioned container. Mirrors FloatingCard's spring language for enter/exit. */
export function BulkActionsBar({ selectionCount, onClear, children, className }: BulkActionsBarProps) {
  return (
    <AnimatePresence>
      {selectionCount > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 16 }}
          transition={springs.snappy}
          className={cn(
            "sticky bottom-4 z-20 flex items-center gap-3 rounded-2xl border border-border/60 bg-card px-4 py-3 shadow-e3",
            className,
          )}
        >
          <span className="text-sm font-medium text-foreground">{selectionCount} selected</span>
          <div className="flex items-center gap-2">{children}</div>
          <ClayButton variant="ghost" size="icon" className="ml-1" onClick={onClear} aria-label="Clear selection">
            <X className="size-4" />
          </ClayButton>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
