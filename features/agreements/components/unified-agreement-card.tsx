"use client";

import { CalendarClock, CreditCard, HandCoins, Landmark, ShoppingBag } from "lucide-react";
import { ClayBadge } from "@/components/clay/clay-badge";
import { FloatingCard } from "@/components/foundation/floating-card";
import { formatCurrency } from "@/lib/format";
import type { UnifiedFinanceAgreement } from "@/lib/models/unified-finance-agreement";
import { agreementCardPresentation, STATUS_LABEL } from "@/features/agreements/lib/unified-workspace-model";

const STATUS_TONE = {
  active: "primary", dueSoon: "warning", overdue: "expense", defaulted: "expense", closed: "neutral",
} as const;

export function UnifiedAgreementCard({ agreement, onOpen }: { agreement: UnifiedFinanceAgreement; onOpen: () => void }) {
  const Icon = agreement.agreementKind === "installmentPurchase" ? ShoppingBag : agreement.direction === "lent" ? HandCoins : Landmark;
  const progress = agreement.originalPrincipal > 0
    ? Math.min(Math.max(((agreement.originalPrincipal - agreement.remainingPrincipal) / agreement.originalPrincipal) * 100, 0), 100)
    : 0;
  const presentation = agreementCardPresentation(agreement);
  const scheduled = agreement.repaymentType === "scheduled";

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onOpen();
    }
  }

  return (
    <FloatingCard
      role="button"
      tabIndex={0}
      aria-label={`Open ${agreement.title}`}
      onClick={onOpen}
      onKeyDown={onKeyDown}
      className="flex h-full cursor-pointer flex-col gap-4 p-5 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-primary/12 text-primary-accent-text shadow-e1"><Icon className="size-4.5" /></span>
          <div className="min-w-0">
            <h2 className="truncate font-heading text-base font-semibold text-foreground">{agreement.title}</h2>
            <p className="truncate text-xs text-muted-foreground">{agreement.providerName ?? presentation.relationship}</p>
          </div>
        </div>
        <ClayBadge tone={STATUS_TONE[agreement.status]}>{STATUS_LABEL[agreement.status]}</ClayBadge>
      </div>

      <p className="text-xs font-medium text-muted-foreground">{presentation.relationship}</p>

      <div>
        <p className="text-xs text-muted-foreground">{presentation.remainingLabel}</p>
        <p className="font-mono text-xl font-semibold tabular-nums text-foreground">{formatCurrency(agreement.remainingPrincipal)}</p>
        {presentation.representedOnCard && (
          <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground"><CreditCard className="size-3.5" />Tracked in the linked credit card balance</p>
        )}
      </div>

      <div className="space-y-2">
        <div className="h-2 overflow-hidden rounded-full bg-muted" style={{ boxShadow: "var(--shadow-pressed-sm)" }}>
          <div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${progress}%` }} />
        </div>
        <p className="text-xs text-muted-foreground">{Math.round(progress)}% of principal repaid</p>
      </div>

      <div className="mt-auto grid grid-cols-2 gap-3 border-t border-border/60 pt-3 text-sm">
        {scheduled && agreement.installmentAmount != null ? (
          <div><p className="text-xs text-muted-foreground">Installment</p><p className="font-mono font-semibold tabular-nums text-foreground">{formatCurrency(agreement.installmentAmount)}</p></div>
        ) : (
          <div><p className="text-xs text-muted-foreground">Repayment</p><p className="font-medium text-foreground">{presentation.repaymentLabel}</p></div>
        )}
        <div className="text-right">
          <p className="text-xs text-muted-foreground">Next due</p>
          <p className="inline-flex items-center justify-end gap-1 font-medium text-foreground">
            <CalendarClock className="size-3.5 text-muted-foreground" />
            {agreement.nextDueDate ? agreement.nextDueDate.toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : "No payment due"}
          </p>
        </div>
      </div>
    </FloatingCard>
  );
}
