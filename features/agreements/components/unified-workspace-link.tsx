import Link from "next/link";
import { ArrowRight, WalletCards } from "lucide-react";

/** Temporary discovery link while the old Loan and EMI routes remain available for regression comparison. */
export function UnifiedWorkspaceLink() {
  return (
    <Link
      href="/loans-installments"
      className="mb-4 flex items-center justify-between gap-3 rounded-2xl border border-primary/20 bg-primary/5 px-4 py-3 text-sm outline-none transition-colors hover:bg-primary/10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <span className="flex items-center gap-2 font-medium text-foreground"><WalletCards className="size-4 text-primary-accent-text" />Open Loans &amp; Installments</span>
      <ArrowRight className="size-4 text-muted-foreground" />
    </Link>
  );
}
