"use client";

import { motion } from "framer-motion";
import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { SidebarNavContent } from "@/components/layout/sidebar-nav-content";
import { springs } from "@/lib/motion/tokens";

/** Desktop nav rail — hidden below md; see MobileSidebar for the small-screen equivalent (a Sheet drawer
 *  triggered from Topbar's hamburger button), both built on the shared SidebarNavContent. */
export function Sidebar() {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <motion.div
      animate={{ width: collapsed ? 72 : 264 }}
      transition={springs.smooth}
      className="hidden shrink-0 md:block"
    >
      <div className="flex h-full flex-col border-r border-border bg-sidebar">
        <div className="min-h-0 flex-1 overflow-hidden">
          <SidebarNavContent collapsed={collapsed} scrollMotion onCollapse={() => setCollapsed(true)} />
        </div>

        {/* Expanded: the collapse control lives in the profile row (saves a full row for the menu).
            Collapsed: this is the only way back, so it stays down here. */}
        {collapsed && (
          <button
            type="button"
            onClick={() => setCollapsed(false)}
            aria-label="Expand sidebar"
            className="mx-3 mt-1.5 mb-2.5 flex h-8 shrink-0 items-center justify-center rounded-xl border border-dashed border-border text-foreground/60 transition-colors hover:border-border-strong hover:bg-muted/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <ChevronRight className="size-4" />
          </button>
        )}
      </div>
    </motion.div>
  );
}
