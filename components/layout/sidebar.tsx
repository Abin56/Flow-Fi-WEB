"use client";

import { motion } from "framer-motion";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";
import { SidebarNavContent } from "@/components/layout/sidebar-nav-content";
import { springs } from "@/lib/motion/tokens";

/** Desktop nav rail — hidden below md; see MobileSidebar for the small-screen equivalent (a Sheet drawer
 *  triggered from Topbar's hamburger button), both built on the shared SidebarNavContent. */
export function Sidebar() {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <motion.div
      animate={{ width: collapsed ? 76 : 260 }}
      transition={springs.smooth}
      className="hidden shrink-0 md:block"
    >
      <div className="surface-flat flex h-full flex-col border-r border-border/60">
        <div className="min-h-0 flex-1">
          <SidebarNavContent collapsed={collapsed} />
        </div>

        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="mx-3 mb-3 flex h-9 shrink-0 items-center justify-center gap-2 rounded-xl text-xs text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          {collapsed ? <ChevronRight className="size-4" /> : <ChevronLeft className="size-4" />}
        </button>
      </div>
    </motion.div>
  );
}
