import { LoanEmiWorkspace } from "@/features/loans/components/loan-emi-workspace";

/** Kept so existing /emi links (agreement handoffs, bookmarks) land on the one Loan & EMI workspace. */
export default function EmiPage() {
  return <LoanEmiWorkspace />;
}
