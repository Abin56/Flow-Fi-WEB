"use client";

import { MoreVertical } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { StaggerItem } from "@/components/foundation/animated-container";
import { formatCurrency } from "@/lib/format";
import type { CreditCardViewItem } from "@/features/credit-cards/hooks/use-credit-cards-data";
import { cn } from "@/lib/utils";

/** Rich dark card-face gradients — deliberately outside the app's pastel token palette, since these stand in
 *  for real bank card artwork rather than app chrome. Keyed by the card's existing `accent` so each mock card
 *  keeps a stable, distinct look. */
export const CARD_GRADIENT: Record<CreditCardViewItem["accent"], string> = {
  expense: "linear-gradient(135deg, #6d1530 0%, #a81f56 55%, #c2185b 100%)",
  warning: "linear-gradient(135deg, #141414 0%, #2b2b2b 100%)",
  success: "linear-gradient(135deg, #0e3d2e 0%, #146b4d 100%)",
  purple: "linear-gradient(135deg, #1c2a5e 0%, #2d4a9e 100%)",
  primary: "linear-gradient(135deg, #1e3a5f 0%, #2563eb 100%)",
  teal: "linear-gradient(135deg, #0b3b40 0%, #0f766e 100%)",
  orange: "linear-gradient(135deg, #7a2e0b 0%, #ea580c 100%)",
  gold: "linear-gradient(135deg, #5c4410 0%, #b8862b 100%)",
  rose: "linear-gradient(135deg, #7f1d3a 0%, #e11d48 100%)",
  sky: "linear-gradient(135deg, #0c4a6e 0%, #0ea5e9 100%)",
  emerald: "linear-gradient(135deg, #064e3b 0%, #10b981 100%)",
  violet: "linear-gradient(135deg, #3b0764 0%, #7c3aed 100%)",
  slate: "linear-gradient(135deg, #1e293b 0%, #64748b 100%)",
  bronze: "linear-gradient(135deg, #3f2a14 0%, #8b5a2b 100%)",
  magenta: "linear-gradient(135deg, #701a75 0%, #c026d3 100%)",
  navy: "linear-gradient(135deg, #0a0f2c 0%, #1e2a78 100%)",
};

function daysUntil(date: Date): number {
  const now = new Date();
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((startOfDay(date) - startOfDay(now)) / 86_400_000);
}

function formatDueDate(date: Date): string {
  return date.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

interface CreditCardTileProps {
  card: CreditCardViewItem;
  active?: boolean;
  onClick: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
}

/** Card-stack-style tile styled after real bank card art — a solid gradient face (not a clay surface) so it
 *  reads as "a card" sitting on the page, with the utilization bar flipping to red once usage crosses 80%. */
export function CreditCardTile({ card, active, onClick, onEdit, onDelete }: CreditCardTileProps) {
  // The engine's exposure ratio (outstanding + locked card-EMI principal) — recomputing from the account
  // balance alone hid a card-linked EMI's lock, so the tile disagreed with Available.
  const utilization = Math.min(100, Math.round(card.utilizationPercent));
  const dueInDays = card.dueDate ? daysUntil(card.dueDate) : null;
  const urgent = dueInDays != null && dueInDays <= 5;
  const highUtilization = utilization >= 80;

  return (
    <StaggerItem>
      <div
        role="button"
        tabIndex={0}
        onClick={onClick}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onClick();
          }
        }}
        style={{ background: CARD_GRADIENT[card.accent] }}
        className={cn(
          "relative flex h-full cursor-pointer flex-col gap-3.5 overflow-hidden rounded-[12px] p-4 text-white shadow-e2 transition-[transform,box-shadow] duration-150 outline-none hover:-translate-y-px focus-visible:ring-2 focus-visible:ring-ring",
          active && "ring-2 ring-primary-accent-text ring-offset-2 ring-offset-background",
        )}
      >
        {/* soft sheen, like card stock */}
        <span className="pointer-events-none absolute -top-16 -right-10 size-40 rounded-full bg-white/10 blur-2xl" aria-hidden />

        <div className="relative flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="truncate font-heading text-base font-semibold">{card.name}</h3>
            <p className="mt-0.5 text-[13px] tracking-[0.18em] text-white/75 tabular-nums">•••• {card.last4}</p>
            {card.sharedLimit && (
              <p className="mt-1 inline-flex items-center rounded-[4px] bg-white/15 px-1.5 py-0.5 text-[10.5px] font-semibold text-white/90">
                ↳ Shared limit{card.sharedLimit.siblings.length > 0 ? ` · with •••• ${card.sharedLimit.siblings.map((s) => s.last4).join(", ")}` : ""}
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <span className="text-[11px] font-bold tracking-wide text-white/75 italic uppercase">{card.network}</span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  onClick={(e) => e.stopPropagation()}
                  className="flex size-7 shrink-0 items-center justify-center rounded-[6px] text-white/75 transition-colors hover:bg-white/15 hover:text-white"
                  aria-label="Card options"
                >
                  <MoreVertical className="size-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="rounded-[8px]">
                <DropdownMenuItem onSelect={() => onEdit?.()}>Edit</DropdownMenuItem>
                <DropdownMenuItem className="text-expense" onSelect={() => onDelete?.()}>
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <div className="relative flex items-end justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10.5px] font-semibold tracking-[0.08em] text-white/65 uppercase">Credit used</p>
            <p className="text-[24px] leading-tight font-bold tracking-tight tabular-nums">{formatCurrency(card.usedCredit)}</p>
            {card.lockedEmiPrincipal > 0 && (
              <p className="text-[11px] text-white/75 tabular-nums">incl. {formatCurrency(card.lockedEmiPrincipal)} EMI locked</p>
            )}
          </div>
          <div className="text-right">
            <p className="text-[10.5px] font-semibold tracking-[0.08em] text-white/65 uppercase">{card.sharedLimit ? "Shared limit" : "Limit"}</p>
            <p className="text-sm font-semibold text-white/90 tabular-nums">{formatCurrency(card.creditLimit)}</p>
          </div>
        </div>

        <div className="relative">
          <div className="flex items-center justify-between text-xs text-white/75">
            <span>Utilization</span>
            <span className="font-semibold text-white">{utilization}%</span>
          </div>
          <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-white/20">
            <div
              className={cn("h-full rounded-full transition-all", highUtilization ? "bg-red-400" : "bg-white")}
              style={{ width: `${utilization}%` }}
            />
          </div>
        </div>

        <div className="relative mt-auto flex items-center justify-between border-t border-white/15 pt-3 text-xs">
          <span className="text-white/70">
            {card.dueDate ? `Due on ${formatDueDate(card.dueDate)}` : "No statement due"}
          </span>
          {dueInDays != null && (
            <span className={cn("font-semibold", urgent ? "text-red-300" : "text-white/70")}>
              {dueInDays <= 0 ? "Due today" : `${dueInDays} days left`}
            </span>
          )}
        </div>
      </div>
    </StaggerItem>
  );
}
