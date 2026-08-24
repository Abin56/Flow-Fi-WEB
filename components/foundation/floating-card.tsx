"use client";

import { motion } from "framer-motion";
import { springs } from "@/lib/motion/tokens";
import { cn } from "@/lib/utils";

const elevationClass = {
  1: "shadow-e1",
  2: "shadow-e2",
  3: "shadow-e3",
} as const;

interface FloatingCardProps extends React.ComponentProps<typeof motion.div> {
  elevation?: 1 | 2 | 3;
  interactive?: boolean;
}

/** The base clay widget surface — every dashboard card sits on this. Hover lifts the shadow further out; a tap
 *  briefly flips to the inset/pressed shadow before releasing, so pressing a card feels physical. */
export function FloatingCard({
  elevation = 2,
  interactive = true,
  className,
  children,
  ...props
}: FloatingCardProps) {
  return (
    <motion.div
      whileHover={interactive ? { y: -2, boxShadow: "var(--shadow-e3)" } : undefined}
      whileTap={interactive ? { y: 0, scale: 0.995, boxShadow: "var(--shadow-pressed)" } : undefined}
      transition={springs.snappy}
      className={cn("rounded-2xl border border-border/60 bg-card p-5", elevationClass[elevation], className)}
      {...props}
    >
      {children}
    </motion.div>
  );
}
