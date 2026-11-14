import { EMI_PAYMENT_HISTORY_KEY } from "@/features/loans/hooks/use-payment-history";

/** Queries derived from payment sub-collections — keyed on live installment state already; invalidated
 *  too so history / extra-principal / card-credit figures re-read at once after a write.
 *  Lives here (not in the Record Payment dialog) so a screen that only needs the keys — Activity's Undo —
 *  doesn't pull that whole dialog into its bundle. */
export const DERIVED_QUERY_PREFIXES = ["loan-financial-history", "loanPrincipalPrepaid", "loanScheduledPayments", "cardLinkedEmiPayments", EMI_PAYMENT_HISTORY_KEY];
