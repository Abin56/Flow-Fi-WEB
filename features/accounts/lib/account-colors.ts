import type { AccountColor } from "@/lib/mock/accounts-overview-data";

/** Shared per-account color treatment — a light tinted card wash, a solid icon chip, a matching sparkline
 *  stroke, and the text color that stays readable *on top of* `gradient` — reused by both the account tiles
 *  and the right-side overview panel so a given account reads as the same color everywhere on the page.
 *  `onGradient` exists because the palette spans both bold saturated gradients (need white text) and pale
 *  pastel ones (need dark text) — hardcoding white everywhere would make the pastel icons unreadable. */
export const ACCOUNT_COLOR: Record<
  AccountColor,
  { wash: string; icon: string; stroke: string; gradient: string; onGradient: string }
> = {
  slate: {
    wash: "bg-slate-500/6",
    icon: "bg-slate-900 text-white dark:bg-slate-700",
    stroke: "#334155",
    gradient: "linear-gradient(135deg, #312e81 0%, #4338ca 100%)",
    onGradient: "text-white",
  },
  orange: {
    wash: "bg-orange-500/8",
    icon: "bg-orange-500/15 text-orange-600 dark:text-orange-400",
    stroke: "#f97316",
    gradient: "linear-gradient(135deg, #ea580c 0%, #f97316 100%)",
    onGradient: "text-white",
  },
  blue: {
    wash: "bg-blue-500/8",
    icon: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
    stroke: "#3b82f6",
    gradient: "linear-gradient(135deg, #1d4ed8 0%, #3b82f6 100%)",
    onGradient: "text-white",
  },
  green: {
    wash: "bg-success/8",
    icon: "bg-success/16 text-success",
    stroke: "var(--success)",
    gradient: "linear-gradient(135deg, oklch(0.5 0.12 152) 0%, oklch(0.62 0.12 152) 100%)",
    onGradient: "text-white",
  },
  cyan: {
    wash: "bg-cyan-500/8",
    icon: "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400",
    stroke: "#06b6d4",
    gradient: "linear-gradient(135deg, #0e7490 0%, #06b6d4 100%)",
    onGradient: "text-white",
  },
  violet: {
    wash: "bg-purple/8",
    icon: "bg-purple/15 text-purple",
    stroke: "var(--purple)",
    gradient: "linear-gradient(135deg, oklch(0.45 0.19 295) 0%, oklch(0.58 0.19 295) 100%)",
    onGradient: "text-white",
  },
  // Deep, rich additions — solid dark jewel-tone gradients in the same spirit as `slate` above
  // (a solid dark icon chip, white text) rather than the original six's mid-saturation tints.
  maroon: {
    wash: "bg-red-500/6",
    icon: "bg-red-900 text-white dark:bg-red-800",
    stroke: "#7f1d1d",
    gradient: "linear-gradient(135deg, #7f1d1d 0%, #b91c1c 100%)",
    onGradient: "text-white",
  },
  emerald: {
    wash: "bg-emerald-500/6",
    icon: "bg-emerald-900 text-white dark:bg-emerald-800",
    stroke: "#065f46",
    gradient: "linear-gradient(135deg, #065f46 0%, #10b981 100%)",
    onGradient: "text-white",
  },
  bronze: {
    wash: "bg-amber-500/6",
    icon: "bg-amber-900 text-white dark:bg-amber-800",
    stroke: "#78350f",
    gradient: "linear-gradient(135deg, #78350f 0%, #b45309 100%)",
    onGradient: "text-white",
  },
  charcoal: {
    wash: "bg-zinc-500/6",
    icon: "bg-zinc-900 text-white dark:bg-zinc-700",
    stroke: "#27272a",
    gradient: "linear-gradient(135deg, #18181b 0%, #3f3f46 100%)",
    onGradient: "text-white",
  },
  navy: {
    wash: "bg-blue-500/6",
    icon: "bg-blue-950 text-white dark:bg-blue-900",
    stroke: "#172554",
    gradient: "linear-gradient(135deg, #172554 0%, #1e3a8a 100%)",
    onGradient: "text-white",
  },
  plum: {
    wash: "bg-fuchsia-500/6",
    icon: "bg-fuchsia-900 text-white dark:bg-fuchsia-800",
    stroke: "#581c87",
    gradient: "linear-gradient(135deg, #581c87 0%, #86198f 100%)",
    onGradient: "text-white",
  },
};
