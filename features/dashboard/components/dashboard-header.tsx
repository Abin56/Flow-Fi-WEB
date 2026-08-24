"use client";

import { SlidersHorizontal } from "lucide-react";
import { useAuthStore } from "@/store/auth-store";

function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

export function DashboardHeader() {
  const user = useAuthStore((state) => state.user);
  const firstName = user?.displayName?.split(" ")[0] ?? "there";

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <h1 className="font-heading text-xl font-bold tracking-tight text-foreground sm:text-2xl">
          {greeting()}, {firstName}! 👋
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">Here&apos;s what&apos;s happening with your finances today.</p>
      </div>
      <button
        type="button"
        disabled
        aria-disabled="true"
        title="Coming soon"
        className="surface-flat flex shrink-0 cursor-not-allowed items-center gap-2 rounded-xl border border-border/50 px-4 py-2 text-sm font-medium text-foreground opacity-50 transition-colors"
      >
        <SlidersHorizontal className="size-4" />
        Customize
      </button>
    </div>
  );
}
