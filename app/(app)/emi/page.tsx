import { LoanEmiWorkspace } from "@/features/loans/components/loan-emi-workspace";
import { UnifiedWorkspaceLink } from "@/features/agreements/components/unified-workspace-link";

/** Kept so existing /emi links (agreement handoffs, bookmarks) land on the EMI tab of Loan & EMI. */
export default function EmiPage() {
  return <><UnifiedWorkspaceLink /><LoanEmiWorkspace initialTab="emi" /></>;
}
