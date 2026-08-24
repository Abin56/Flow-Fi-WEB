import { Sparkles, TrendingDown, TrendingUp } from "lucide-react";
import { FloatingCard } from "@/components/foundation/floating-card";
import { cn } from "@/lib/utils";

interface InsightCardProps {
  headline: string;
  detail: string;
  tone?: "success" | "warning" | "neutral";
  className?: string;
}

const TONE_ICON = { success: TrendingUp, warning: TrendingDown, neutral: Sparkles } as const;

/** Narrative callout card — reuses the AI-insight visual language (purple accent, Sparkles icon) from
 *  features/dashboard/components/ai-insight-panel.tsx, scaled down for a feed of multiple insights. */
export function InsightCard({ headline, detail, tone = "neutral", className }: InsightCardProps) {
  const Icon = TONE_ICON[tone];
  const toneColor = tone === "success" ? "var(--success)" : tone === "warning" ? "var(--warning)" : "var(--purple)";

  return (
    <FloatingCard interactive={false} elevation={1} className={cn("flex gap-3", className)}>
      <span
        className="flex size-9 shrink-0 items-center justify-center rounded-xl"
        style={{ background: `color-mix(in oklch, ${toneColor} 14%, transparent)`, color: toneColor }}
      >
        <Icon className="size-4" />
      </span>
      <div className="min-w-0">
        <p className="text-sm leading-snug font-semibold text-foreground">{headline}</p>
        <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
      </div>
    </FloatingCard>
  );
}
