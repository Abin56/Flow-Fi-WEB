"use client";

import { SidebarNavContent } from "@/components/layout/sidebar-nav-content";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";

/** Small-screen equivalent of the desktop nav rail — a left-side drawer, triggered by Topbar's hamburger
 *  button (md:hidden). Always renders the expanded (non-collapsed) nav content and closes itself on any
 *  nav/shortcut click so navigating doesn't leave the drawer open behind the new page. */
export function MobileSidebar({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="left" className="w-72 gap-0 p-0 sm:max-w-72">
        <SheetTitle className="sr-only">Navigation</SheetTitle>
        <SidebarNavContent onNavigate={() => onOpenChange(false)} />
      </SheetContent>
    </Sheet>
  );
}
