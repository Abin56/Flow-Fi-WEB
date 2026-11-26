"use client";

import { ChevronDown, type LucideIcon } from "lucide-react";
import { ClayButton } from "@/components/clay/clay-button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export interface MorePaymentAction {
  label: string;
  icon: LucideIcon;
  /** Full explanation, on hover. */
  title?: string;
  disabled?: boolean;
  onSelect: () => void;
}

/**
 * The Loan / EMI header's secondary money actions, folded into one "More" menu so "Pay Now" is the only action competing
 * for attention. Presentation only: every item runs the same handler its old button ran.
 */
export function MorePaymentActions({ items, className, autoFocus }: { items: readonly MorePaymentAction[]; className?: string; autoFocus?: boolean }) {
  if (items.length === 0) return null;
  return (
    // Non-modal: most items open a dialog, which must be free to take focus.
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <ClayButton variant="secondary" autoFocus={autoFocus} className={cn("shrink-0 border-border-strong font-medium text-foreground hover:bg-card", className)} data-testid="more-payment-actions">
          More
          <ChevronDown className="size-3.5" aria-hidden />
        </ClayButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={5} collisionPadding={12} className="min-w-48">
        {items.map(({ label, icon: Icon, title, disabled, onSelect }) => (
          <DropdownMenuItem key={label} disabled={disabled} title={title} onSelect={onSelect} className="min-h-8 px-2 text-xs">
            <Icon className="size-3.5" aria-hidden />
            {label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
