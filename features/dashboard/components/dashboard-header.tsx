"use client";

import Link from "next/link";
import { Plus } from "lucide-react";
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
  const today = new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" });

  return (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="font-heading text-2xl font-bold tracking-tight text-foreground">
          {greeting()}, {firstName}
        </h1>
        <p className="mt-0.5 text-sm text-muted-foreground">{today} — here&apos;s where your money stands.</p>
      </div>
      <Link
        href="/transactions"
        className="flex h-9 items-center gap-1.5 rounded-[6px] border border-primary-accent-text bg-primary px-3.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
      >
        <Plus className="size-4" strokeWidth={2.25} />
        Add transaction
      </Link>
    </header>
  );
}
