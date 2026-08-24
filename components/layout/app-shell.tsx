"use client";

import { useEffect, useState } from "react";
import { AiPanel } from "@/components/ai-panel/ai-panel";
import { CommandPalette } from "@/components/command-palette/command-palette";
import { MobileSidebar } from "@/components/layout/mobile-sidebar";
import { OfflineBanner } from "@/components/layout/offline-banner";
import { Sidebar } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";
import { WatcherErrorBanner } from "@/components/layout/watcher-error-banner";
import { PageTransition } from "@/components/motion/page-transition";

export function AppShell({ children }: { children: React.ReactNode }) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setPaletteOpen((v) => !v);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <div className="relative flex h-dvh min-w-0 overflow-hidden bg-background">
      <Sidebar />
      <MobileSidebar open={mobileNavOpen} onOpenChange={setMobileNavOpen} />

      <div className="flex min-w-0 flex-1 flex-col">
        <OfflineBanner />
        <WatcherErrorBanner />
        <Topbar
          onOpenCommandPalette={() => setPaletteOpen(true)}
          onToggleAiPanel={() => setAiPanelOpen((v) => !v)}
          onOpenMobileNav={() => setMobileNavOpen(true)}
        />
        <main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto px-4 py-4 sm:px-6 sm:py-6 lg:px-8">
          <PageTransition>{children}</PageTransition>
        </main>
      </div>

      <AiPanel open={aiPanelOpen} onOpenChange={setAiPanelOpen} />
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}
