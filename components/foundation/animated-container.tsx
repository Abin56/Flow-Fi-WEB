"use client";

import { motion } from "framer-motion";
import { stagger } from "@/lib/motion/tokens";

/** Staggered entrance wrapper — wrap a grid/list of widgets in Stagger, each direct motion child in Item. */
export function Stagger({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <motion.div initial="hidden" animate="show" variants={stagger.container} className={className}>
      {children}
    </motion.div>
  );
}

export function StaggerItem({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <motion.div variants={stagger.item} className={className}>
      {children}
    </motion.div>
  );
}
