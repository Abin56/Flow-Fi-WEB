import { money } from "@/lib/engines/person-cycle-statement-share";
import { splitAllocationSentence, splitCountLabel, type SplitAllocation } from "@/lib/split/split-allocation";
import { cn } from "@/lib/utils";

/**
 * Columns follow the CONTAINER width (not the viewport) and are capped by the participant count, so a
 * 2-way split never shows empty columns and 5–8+ participants wrap into readable rows instead of
 * squeezing. Below the first breakpoint every participant is a "Name ……… ₹amount" line.
 */
function columnClasses(n: number): string {
  if (n <= 1) return "";
  if (n === 2) return "@[15rem]:grid-cols-2";
  if (n === 3) return "@[15rem]:grid-cols-2 @[24rem]:grid-cols-3";
  if (n === 4) return "@[15rem]:grid-cols-2 @[34rem]:grid-cols-4";
  if (n <= 6) return "@[15rem]:grid-cols-2 @[26rem]:grid-cols-3";
  return "@[15rem]:grid-cols-2 @[26rem]:grid-cols-3 @[38rem]:grid-cols-4";
}

/**
 * The visual split breakdown — original total, how many ways, and every stored allocation as a
 * segmented strip separated by subtle dividers. Neutral by design: no per-participant colours; the
 * focus person's cell gets only a faint tint and a "Their share" caption. Allocation only — any
 * settlement figures (paid / remaining) belong to the caller, kept visually separate.
 */
export function SplitAllocationBreakdown({
  allocation,
  focusName,
  format = money,
  title = "Original total",
  variant = "full",
  focusCaption,
  className,
}: {
  allocation: SplitAllocation;
  /** The People Ledger person — for the caption under their cell. */
  focusName?: string;
  format?: (n: number) => string;
  title?: string;
  /**
   * "compact": a slim strip for statement rows — one header line ("Original purchase ₹X · Split between N people")
   * and smaller cells whose names wrap instead of truncating. Same data, same grid rules.
   */
  variant?: "full" | "compact";
  /** Caption under the focus cell (default "Their share" / "Share"), e.g. "Sojan's share". */
  focusCaption?: string;
  className?: string;
}) {
  const { participants } = allocation;
  const compact = variant === "compact";
  const caption = focusCaption ?? (focusName ? "Their share" : "Share");
  return (
    <section className={cn("@container overflow-hidden rounded-[6px] border border-border-strong/60 bg-card", className)}>
      {/* One readable sentence for assistive tech; the visual strip below is the same content. */}
      <p className="sr-only">{splitAllocationSentence(allocation, format)}</p>
      {compact ? (
        // The bill is the anchor — its own neutral surface, so it never reads as another participant.
        <p className="flex flex-wrap items-baseline gap-x-2 bg-secondary px-2.5 py-1 text-[11.5px] tabular-nums" aria-hidden>
          <span className="font-semibold text-foreground/75">Original purchase</span>
          <span className="font-bold text-foreground">{format(allocation.original)}</span>
          <span className="text-foreground/65">· {allocation.participantCount >= 2 ? `Split between ${allocation.participantCount} people` : splitCountLabel(allocation)}</span>
        </p>
      ) : (
      <div className="flex items-start justify-between gap-3 px-3 py-2" aria-hidden>
        <div className="min-w-0">
          <p className="text-[10.5px] font-bold tracking-[0.08em] text-foreground/60 uppercase">{title}</p>
          <p className="text-[11.5px] font-medium text-foreground/70">{splitCountLabel(allocation)}</p>
        </div>
        <p className="shrink-0 font-heading text-[18px] leading-tight font-bold tracking-tight tabular-nums text-foreground">{format(allocation.original)}</p>
      </div>
      )}
      {participants.length > 0 && (
        <div className="overflow-hidden border-t border-border-strong/50" aria-hidden>
          {/* Each cell draws its own top/left divider; the -1px offset hides the outer edge, so wrapped rows never leave stray lines. */}
          <dl className={cn("-mt-px -ml-px grid grid-cols-1", columnClasses(participants.length))}>
            {participants.map((p) => (
              <div
                key={p.key}
                data-focus={p.isFocus || undefined}
                className={cn(
                  "flex min-w-0 items-baseline justify-between gap-3 border-t border-l border-border-strong/40 @[15rem]:block",
                  compact ? "px-2.5 py-1 @[15rem]:py-1" : "px-3 py-1.5 @[15rem]:py-2",
                  participants.length === 1 && "@[15rem]:flex",
                  // The recipient's cell: a light FlowFi tint + edge in statements; a neutral tint elsewhere.
                  p.isFocus && (compact ? "bg-primary/12 shadow-[inset_2px_0_0_var(--color-primary-accent-text)]" : "bg-secondary/70"),
                )}
              >
                <dt title={p.label} className={cn("min-w-0 text-[11.5px] font-medium text-foreground/70", compact ? "break-words" : "truncate", (p.isMe || p.isFocus) && "font-semibold text-foreground")}>
                  {p.label}
                </dt>
                <dd className={cn("shrink-0 font-semibold", compact ? "text-[13px]" : "text-[14px]", " whitespace-nowrap tabular-nums text-foreground", p.isFocus && "font-bold")}>
                  {format(p.amount)}
                  {p.isFocus && <span className="ml-1.5 text-[10.5px] font-medium text-foreground/60 @[15rem]:block @[15rem]:ml-0">{caption}</span>}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      {!allocation.reconciles && participants.length > 0 && (
        // Stored allocations that don't add up to the stored total — shown as stored, never forced.
        <p className="border-t border-border-strong/50 px-3 py-1.5 text-[11px] font-medium text-foreground/70 tabular-nums" aria-hidden>
          Allocated {format(allocation.allocated)} of {format(allocation.original)}
        </p>
      )}
    </section>
  );
}
