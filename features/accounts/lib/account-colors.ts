import type { AccountColor } from "@/lib/mock/accounts-overview-data";

/** Shared per-account color treatment — a light tinted card wash, a solid icon chip, and a matching sparkline
 *  stroke — reused by both the account tiles and the right-side overview panel so a given account reads as
 *  the same color everywhere on the page. */
export const ACCOUNT_COLOR: Record<
  AccountColor,
  { wash: string; icon: string; stroke: string; gradient: string }
> = {
  slate: {
    wash: "bg-slate-500/6",
    icon: "bg-slate-900 text-white dark:bg-slate-700",
    stroke: "#334155",
    gradient: "linear-gradient(135deg, #312e81 0%, #4338ca 100%)",
  },
  orange: {
    wash: "bg-orange-500/8",
    icon: "bg-orange-500/15 text-orange-600 dark:text-orange-400",
    stroke: "#f97316",
    gradient: "linear-gradient(135deg, #ea580c 0%, #f97316 100%)",
  },
  blue: {
    wash: "bg-blue-500/8",
    icon: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
    stroke: "#3b82f6",
    gradient: "linear-gradient(135deg, #1d4ed8 0%, #3b82f6 100%)",
  },
  green: {
    wash: "bg-success/8",
    icon: "bg-success/16 text-success",
    stroke: "var(--success)",
    gradient: "linear-gradient(135deg, oklch(0.5 0.12 152) 0%, oklch(0.62 0.12 152) 100%)",
  },
  cyan: {
    wash: "bg-cyan-500/8",
    icon: "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400",
    stroke: "#06b6d4",
    gradient: "linear-gradient(135deg, #0e7490 0%, #06b6d4 100%)",
  },
  violet: {
    wash: "bg-purple/8",
    icon: "bg-purple/15 text-purple",
    stroke: "var(--purple)",
    gradient: "linear-gradient(135deg, oklch(0.45 0.19 295) 0%, oklch(0.58 0.19 295) 100%)",
  },
};
