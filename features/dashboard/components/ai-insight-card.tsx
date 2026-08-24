"use client";

import { ArrowRight, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { aiInsight } from "@/lib/mock/dashboard-data";

/** Dark indigo/purple gradient card — deliberately a different gradient from the coral hero, so it reads as
 *  a distinct "AI" surface rather than a third repetition of the brand gradient. */
export function AiInsightCard() {
  return (
    <section
      className="relative flex h-full flex-col justify-between gap-4 overflow-hidden rounded-3xl p-5 text-white"
      style={{ background: "var(--gradient-insight)", boxShadow: "var(--shadow-card)" }}
    >
      <div className="pointer-events-none absolute -top-10 -right-10 size-36 rounded-full bg-white/10 blur-3xl" />

      <div className="relative flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="flex size-7 items-center justify-center rounded-xl bg-white/15">
            <Sparkles className="size-3.5" />
          </span>
          <span className="text-xs font-semibold text-white/85">AI Insight</span>
        </div>
        <Badge className="border-0 bg-white/20 text-[10px] text-white">New</Badge>
      </div>

      <div className="relative">
        <p className="text-sm leading-snug font-semibold">
          You&apos;re spending {aiInsight.percent}% more on <span className="text-white">{aiInsight.category}</span> than
          last month.
        </p>
        <p className="mt-1.5 text-xs text-white/75">{aiInsight.detail}</p>
      </div>

      <div className="relative flex items-center justify-between">
        <button
          type="button"
          className="inline-flex w-fit items-center gap-1.5 rounded-full bg-white/20 px-3.5 py-1.5 text-xs font-semibold backdrop-blur-sm transition-colors hover:bg-white/30 focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-none"
        >
          {aiInsight.cta}
          <ArrowRight className="size-3.5" />
        </button>
        <div className="flex items-center gap-1">
          {[0, 1, 2].map((i) => (
            <span key={i} className={i === 1 ? "size-1.5 rounded-full bg-white" : "size-1.5 rounded-full bg-white/35"} />
          ))}
        </div>
      </div>
    </section>
  );
}
