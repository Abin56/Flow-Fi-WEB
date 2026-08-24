"use client";

import { cva, type VariantProps } from "class-variance-authority";
import { motion } from "framer-motion";
import { springs } from "@/lib/motion/tokens";
import { cn } from "@/lib/utils";

const clayButtonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-2xl border font-medium transition-colors outline-none select-none disabled:pointer-events-none disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
  {
    variants: {
      variant: {
        primary: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-border/60 bg-card text-foreground",
        ghost: "border-transparent bg-transparent text-muted-foreground hover:text-foreground",
      },
      size: {
        default: "h-10 min-w-10 px-4 text-sm",
        sm: "h-8 min-w-8 px-3 text-xs",
        icon: "size-10",
      },
    },
    defaultVariants: { variant: "primary", size: "default" },
  },
);

interface ClayButtonProps
  extends Omit<React.ComponentProps<"button">, "onDrag" | "onDragEnd" | "onDragStart" | "onAnimationStart">,
    VariantProps<typeof clayButtonVariants> {}

/** Raised clay button — presses into the inset shadow on tap so activating it feels physical, not just a color change. */
export function ClayButton({ className, variant, size, style, ...props }: ClayButtonProps) {
  const ghost = variant === "ghost";
  return (
    <motion.button
      whileHover={!ghost ? { y: -1 } : undefined}
      whileTap={{ y: 0, scale: 0.97, boxShadow: "var(--shadow-pressed-sm)" }}
      transition={springs.snappy}
      className={cn(clayButtonVariants({ variant, size }), className)}
      style={{ boxShadow: ghost ? undefined : "var(--shadow-e1)", ...style }}
      {...props}
    />
  );
}
