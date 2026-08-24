"use client";

import { AnimatePresence, motion } from "framer-motion";
import { Sparkles, X } from "lucide-react";
import { ClayButton } from "@/components/clay/clay-button";
import { springs } from "@/lib/motion/tokens";

const PROMPT_CHIPS = [
  "How much did I spend this month?",
  "Which loans are pending?",
  "Can I afford this purchase?",
  "Show spending trends",
];

interface AiPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Collapsed rail by default; expands into a clay drawer. Placeholder empty state — no model wired yet. */
export function AiPanel({ open, onOpenChange }: AiPanelProps) {
  return (
    <motion.div
      animate={{ width: open ? 340 : 64 }}
      transition={springs.smooth}
      className="hidden shrink-0 lg:block"
    >
      <div className="surface-flat flex h-full flex-col overflow-hidden border-l border-border/60">
        {!open ? (
          <button
            type="button"
            onClick={() => onOpenChange(true)}
            className="flex h-full w-full flex-col items-center justify-start gap-3 pt-5 text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            aria-label="Open AI assistant"
          >
            <span className="flex size-9 items-center justify-center rounded-2xl bg-primary/12 text-primary">
              <Sparkles className="size-4.5" />
            </span>
          </button>
        ) : (
          <div className="flex h-full flex-col p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="flex size-8 items-center justify-center rounded-xl bg-primary/12 text-primary">
                  <Sparkles className="size-4" />
                </span>
                <h3 className="font-heading text-sm font-semibold">FlowFi Assistant</h3>
              </div>
              <ClayButton variant="ghost" size="icon" aria-label="Collapse AI assistant" onClick={() => onOpenChange(false)}>
                <X className="size-4" />
              </ClayButton>
            </div>

            <AnimatePresence>
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.08, duration: 0.25 }}
                className="mt-8 flex flex-1 flex-col items-center justify-center text-center"
              >
                <div
                  className="flex size-12 items-center justify-center rounded-2xl bg-primary/12 text-primary"
                  style={{ boxShadow: "var(--shadow-e1)" }}
                >
                  <Sparkles className="size-5" />
                </div>
                <p className="mt-4 text-sm font-medium text-foreground">Ask FlowFi anything</p>
                <p className="mt-1 max-w-[220px] text-xs text-muted-foreground">
                  Your assistant will read the same data as your dashboard — connected once this feature ships.
                </p>

                <div className="mt-6 flex flex-col gap-2 self-stretch">
                  {PROMPT_CHIPS.map((chip) => (
                    <div key={chip} className="clay-pressed cursor-not-allowed rounded-2xl px-3 py-2.5 text-left text-xs text-muted-foreground">
                      {chip}
                    </div>
                  ))}
                </div>
              </motion.div>
            </AnimatePresence>
          </div>
        )}
      </div>
    </motion.div>
  );
}
