"use client";

import { QuickActionsBar } from "@/features/dashboard/components/quick-actions-grid";
import { useAuthStore } from "@/store/auth-store";

function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

/** Greeting on the left, the shortcuts toolbar (incl. the primary "Add transaction") on the right. */
export function DashboardHeader() {
  const user = useAuthStore((state) => state.user);
  useAuthStore((state) => state.profileVersion); // re-render after a saved name change
  const firstName = user?.displayName?.split(" ")[0] ?? "there";
  const today = new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" });

  return (
    <header className="flex flex-col gap-2.5 2xl:flex-row 2xl:items-end 2xl:justify-between">
      <div className="min-w-0 shrink-0">
        <h1 className="font-heading text-[22px] leading-tight font-bold tracking-tight text-foreground">
          {greeting()}, {firstName}
        </h1>
        <p className="mt-0.5 text-[13px] text-muted-foreground">{today} — here&apos;s where your money stands.</p>
      </div>
      <QuickActionsBar />
    </header>
  );
}
