"use client";

/**
 * Loan & EMI detail: outstanding principal, unpaid lender charges and total lender payoff as three separate figures.
 * Rendered ONLY when the agreement has at least one live lender charge, so an agreement without charges looks exactly
 * as it did. Read-only; the principal-only "Outstanding" figures elsewhere on the page keep their meaning.
 */

import { useMemo } from "react";
import { useLenderCharges } from "@/hooks/use-lender-charges";
import { lenderPayoff } from "@/lib/engines/lender-charges";
import type { LenderChargeAgreementKind } from "@/lib/models/lender-charge";
import { formatCurrencyPrecise } from "@/lib/format";
import { DetailSectionTitle } from "@/features/loans/components/loan-emi-ui";

export function LenderPayoffBreakdown({ kind, agreementId, principal }: { kind: LenderChargeAgreementKind; agreementId: string; principal: number }) {
  const { charges } = useLenderCharges();
  const mine = useMemo(() => charges.filter((c) => c.agreementKind === kind && c.agreementId === agreementId && c.reversedAt == null), [charges, kind, agreementId]);
  const payoff = useMemo(() => lenderPayoff({ principal, charges: mine }), [principal, mine]);
  if (mine.length === 0) return null;
  const cell = (label: string, value: number, id: string, strong = false) => (
    <div className="min-w-0">
      <p className="text-[11px] font-medium text-muted-foreground uppercase">{label}</p>
      <p className={strong ? "font-semibold tabular-nums" : "font-medium tabular-nums"} data-testid={id}>{formatCurrencyPrecise(value)}</p>
    </div>
  );
  return (
    <section data-testid="lender-payoff-breakdown">
      <DetailSectionTitle>Lender payoff</DetailSectionTitle>
      <div className="grid grid-cols-3 gap-3 rounded-[8px] border border-border bg-secondary px-4 py-3">
        {cell("Outstanding principal", payoff.principal, "detail-payoff-principal")}
        {cell("Unpaid lender charges", payoff.unpaidCharges, "detail-payoff-charges")}
        {cell("Total lender payoff", payoff.totalPayoff, "detail-payoff-total", true)}
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">Charges are billed separately and never added to principal. Interest accrued but not yet billed is not included.</p>
    </section>
  );
}
