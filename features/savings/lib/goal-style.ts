import { createElement } from "react";
import {
  Briefcase,
  Car,
  Gift,
  GraduationCap,
  HeartPulse,
  Home,
  Laptop,
  PiggyBank,
  Plane,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Target,
  type LucideIcon,
} from "lucide-react";
import type { GoalView } from "@/lib/engines/savings-goals";

/** Cosmetic only — the icon + accent a goal card wears. Stored as plain keys on the goal. */
export const GOAL_ICONS: { key: string; label: string; icon: LucideIcon }[] = [
  { key: "target", label: "Goal", icon: Target },
  { key: "shield", label: "Emergency fund", icon: ShieldCheck },
  { key: "laptop", label: "Gadget", icon: Laptop },
  { key: "phone", label: "Phone", icon: Smartphone },
  { key: "travel", label: "Travel", icon: Plane },
  { key: "home", label: "Home", icon: Home },
  { key: "car", label: "Vehicle", icon: Car },
  { key: "education", label: "Education", icon: GraduationCap },
  { key: "health", label: "Health", icon: HeartPulse },
  { key: "gift", label: "Gift", icon: Gift },
  { key: "business", label: "Business", icon: Briefcase },
  { key: "piggy", label: "Savings", icon: PiggyBank },
  { key: "sparkles", label: "Treat", icon: Sparkles },
];

export function goalIcon(key: string | null): LucideIcon {
  return GOAL_ICONS.find((i) => i.key === key)?.icon ?? Target;
}

/** Renders a goal's icon (a lookup, so callers never create a component during render). */
export function renderGoalIcon(key: string | null, className?: string) {
  return createElement(goalIcon(key), { className });
}

/** Theme-driven accents: they follow the active Light / Dark / custom palette. */
export const GOAL_ACCENTS: { key: string; label: string; color: string }[] = [
  { key: "lime", label: "Lime", color: "var(--chart-1)" },
  { key: "blue", label: "Blue", color: "var(--chart-2)" },
  { key: "green", label: "Green", color: "var(--chart-3)" },
  { key: "amber", label: "Amber", color: "var(--chart-4)" },
  { key: "coral", label: "Coral", color: "var(--chart-5)" },
  { key: "violet", label: "Violet", color: "var(--purple)" },
];

export function accentColor(key: string | null, fallbackIndex = 0): string {
  return (GOAL_ACCENTS.find((a) => a.key === key) ?? GOAL_ACCENTS[fallbackIndex % GOAL_ACCENTS.length]).color;
}

/** A stable default accent for goals created before accents existed (hash of the id). */
export function defaultAccentIndex(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % GOAL_ACCENTS.length;
}

export function goalAccent(view: Pick<GoalView, "goal">): string {
  return accentColor(view.goal.accent, defaultAccentIndex(view.goal.id));
}

export function dueLabel(view: Pick<GoalView, "daysLeft" | "status" | "goal">): { text: string; tone: "neutral" | "warn" | "bad" | "good" } {
  if (view.status === "completed") return { text: view.goal.completedAt ? `Completed ${view.goal.completedAt.toLocaleDateString("en-IN", { day: "numeric", month: "short" })}` : "Completed", tone: "good" };
  const d = view.daysLeft;
  if (d == null) return { text: "No deadline", tone: "neutral" };
  if (d < 0) return { text: `${-d} day${d === -1 ? "" : "s"} overdue`, tone: "bad" };
  if (d === 0) return { text: "Due today", tone: "warn" };
  if (d <= 30) return { text: `${d} day${d === 1 ? "" : "s"} left`, tone: d <= 7 ? "warn" : "neutral" };
  const months = Math.round(d / 30.4375);
  return { text: months >= 12 ? `${(months / 12).toFixed(months % 12 === 0 ? 0 : 1)} yr left` : `${months} mo left`, tone: "neutral" };
}

export function formatShortDate(d: Date): string {
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}
