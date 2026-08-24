"use client";

import { AnimatePresence, motion } from "framer-motion";
import { usePathname } from "next/navigation";

export function PageTransition({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    // mode="popLayout" (not "wait") — the incoming page mounts and starts fetching immediately
    // instead of waiting out the exiting page's exit animation first; the exiting page is pulled
    // out of layout flow via position:absolute so there's no height jump during the brief overlap.
    <AnimatePresence mode="popLayout">
      <motion.div
        key={pathname}
        className="flex min-h-0 min-w-0 flex-1 flex-col"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -8 }}
        transition={{ duration: 0.18, ease: "easeOut" }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}