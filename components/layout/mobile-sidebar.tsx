"use client";

import { SidebarNavContent } from "@/components/layout/sidebar-nav-content";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";

/** Small-screen equivalent of the desktop nav rail — a left-side drawer, triggered by Topbar's hamburger
 *  button (md:hidden). Always renders the expanded (non-collapsed) nav content and closes itself on any
 *  nav/shortcut click so navigating doesn't leave the drawer open behind the new page. */
export function MobileSidebar({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="left"
        // Radix skips links when choosing what to focus, so it landed on the "Jump to…" field — which pops the phone's
        // keyboard over the menu the moment it opens. Focus the drawer itself instead (keyboard users still Tab in).
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement | null)?.focus({ preventScroll: true });
        }}
        className="h-dvh w-[min(20rem,86vw)] gap-0 overflow-hidden rounded-r-[22px] border-r border-border/70 bg-sidebar p-0 pb-[env(safe-area-inset-bottom)] shadow-[18px_0_48px_-16px_rgba(0,0,0,0.35)] sm:max-w-[20rem]"
      >
        <SheetTitle className="sr-only">Navigation</SheetTitle>
        <SidebarNavContent scrollMotion onNavigate={() => onOpenChange(false)} />
      </SheetContent>
    </Sheet>
  );
}
