import Link from "next/link";
import { ArrowRight, WalletCards } from "lucide-react";

/** Temporary discovery link while the old Loan and EMI routes remain available for regression comparison. */
export function UnifiedWorkspaceLink() {
  return (
    <Link
      href="/loans-installments"
      className="group mb-4 flex items-center justify-between gap-3 rounded-2xl border border-primary/50 bg-primary/12 px-4 py-3 text-sm shadow-e1 outline-none transition-colors hover:border-primary hover:bg-primary/20 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <span className="flex items-center gap-3 font-semibold text-foreground">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground">
          <WalletCards className="size-4" />
        </span>
        Open Loans &amp; Installments
      </span>
      <ArrowRight className="size-4 text-foreground/70 transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
    </Link>
  );
}
