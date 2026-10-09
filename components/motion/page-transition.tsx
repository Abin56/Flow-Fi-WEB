"use client";

import { motion, useReducedMotion } from "framer-motion";
import { usePathname } from "next/navigation";

/**
 * A quick fade-in of the new page — nothing else. No exit animation (the old page unmounts at once instead of
 * rendering alongside the new one), and opacity only: a transform here would make this wrapper the containing
 * block for every `position: fixed`/sticky element in the page.
 */
export function PageTransition({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const reduceMotion = useReducedMotion();

  return (
    <motion.div
      key={pathname}
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      initial={reduceMotion ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.14, ease: "easeOut" }}
    >
      {children}
    </motion.div>
  );
}
