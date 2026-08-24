"use client";

import { Bell, Menu, Moon, Search, Sparkles, Sun } from "lucide-react";
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
  onToggleAiPanel,
  onOpenMobileNav,
}: {
  onOpenCommandPalette: () => void;
  onToggleAiPanel?: () => void;
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
    <div className="surface-flat flex h-16 shrink-0 items-center gap-2 border-b border-border/60 px-4 sm:h-18 sm:gap-3 sm:px-6 lg:px-8">
      <IconButton aria-label="Open navigation" onClick={onOpenMobileNav} className="md:hidden">
        <Menu className="size-4.5" />
      </IconButton>

      <button
        type="button"
        onClick={onOpenCommandPalette}
        className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-xl bg-muted/70 px-3.5 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:max-w-sm"
      >
        <Search className="size-4 shrink-0" />
        <span className="hidden truncate sm:inline">Search for anything...</span>
        <kbd className="ml-auto hidden shrink-0 rounded-md border border-border/60 bg-card px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground sm:inline-block">
          ⌘K
        </kbd>
      </button>

      <div className="ml-auto flex items-center gap-1 sm:gap-1.5">
        {onToggleAiPanel && (
          <IconButton aria-label="Toggle AI assistant" onClick={onToggleAiPanel} className="hidden sm:flex">
            <Sparkles className="size-4.5" />
          </IconButton>
        )}

        <IconButton aria-label="Notifications" disabled title="Coming soon" className="opacity-50 disabled:cursor-not-allowed">
          <Bell className="size-4.5" />
        </IconButton>

        <IconButton aria-label="Toggle theme" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} className="hidden sm:flex">
          {mounted && theme === "dark" ? <Sun className="size-4.5" /> : <Moon className="size-4.5" />}
        </IconButton>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className="ml-1 rounded-full focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
              <ClayAvatar src={user?.photoURL} name={user?.displayName} />
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
