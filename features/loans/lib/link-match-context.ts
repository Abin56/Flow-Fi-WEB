import type { Emi } from "@/lib/models/emi";
import type { Loan } from "@/lib/models/loan";
import type { MatchContext } from "@/lib/engines/link-earlier-payment";

/**
 * What ties an expense to THIS agreement beyond amount and date: its name, its lender, its own category; and what can never
 * be its payment (an EMI's own purchase). Read from the agreement record only.
 */
export function agreementMatchContext(source: { kind: "emi"; emi: Pick<Emi, "name" | "lenderName" | "categoryId" | "purchaseTransactionId"> } | { kind: "loan"; loan: Pick<Loan, "name" | "institutionName"> }): MatchContext {
  if (source.kind === "emi") {
    const { emi } = source;
    return { names: [emi.name, emi.lenderName], categoryIds: [emi.categoryId], excludeIds: emi.purchaseTransactionId ? new Set([emi.purchaseTransactionId]) : undefined };
  }
  return { names: [source.loan.name, source.loan.institutionName] };
}
