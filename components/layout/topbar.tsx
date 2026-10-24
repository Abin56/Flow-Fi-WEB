"use client";

import { Bell, Menu, Moon, Search, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { ClayAvatar } from "@/components/clay/clay-avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { signOut } from "@/services/auth/auth-service";
import { useAuthStore } from "@/store/auth-store";
import { cn } from "@/lib/utils";

function IconButton({
  children,
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cn(
        "relative flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

export function Topbar({
  onOpenCommandPalette,
  onOpenMobileNav,
}: {
  onOpenCommandPalette: () => void;
  onOpenMobileNav: () => void;
}) {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const user = useAuthStore((state) => state.user);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- standard next-themes hydration-safe mount flag
    setMounted(true);
  }, []);

  return (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-background px-3 sm:h-14 sm:gap-2.5 sm:px-5 lg:px-6">
      <IconButton aria-label="Open navigation" onClick={onOpenMobileNav} className="size-8 md:hidden">
        <Menu className="size-4" />
      </IconButton>

      <button
        type="button"
        onClick={onOpenCommandPalette}
        className="flex h-8.5 min-w-0 flex-1 items-center gap-2 rounded-lg bg-muted/70 px-3 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:max-w-xs"
      >
        <Search className="size-3.5 shrink-0" />
        <span className="hidden truncate sm:inline">Search for anything...</span>
        <kbd className="ml-auto hidden shrink-0 rounded-md border border-border/60 bg-card px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground sm:inline-block">
          ⌘K
        </kbd>
      </button>

      <div className="ml-auto flex items-center gap-0.5 sm:gap-1">
        <IconButton aria-label="Notifications" disabled title="Coming soon" className="size-8 opacity-50 disabled:cursor-not-allowed">
          <Bell className="size-4" />
        </IconButton>

        <IconButton aria-label="Toggle theme" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} className="hidden size-8 sm:flex">
          {mounted && theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
        </IconButton>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className="ml-0.5 rounded-full focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
              <ClayAvatar src={user?.photoURL} name={user?.displayName} size={30} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel className="truncate">{user?.email ?? "Signed in"}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => signOut()}>Sign out</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
