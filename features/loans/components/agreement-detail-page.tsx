"use client";

import { ArrowLeft, SearchX } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { InlineHostProvider, StackProvider } from "@/components/finance/stack-layer";
import { Skeleton } from "@/components/ui/skeleton";
import { EmiWorkspace } from "@/features/emi/components/emi-workspace";
import { useEmiRows } from "@/features/emi/hooks/use-emi-data";
import { AgreementNavList } from "@/features/loans/components/agreement-nav-list";
import { LE_RADIUS } from "@/features/loans/components/loan-emi-ui";
import { PaymentAwarenessProvider } from "@/features/loans/components/payment-awareness";
import { LoansWorkspace } from "@/features/loans/components/loans-workspace";
import { useLoanRows } from "@/features/loans/hooks/use-loans-data";
import { cn } from "@/lib/utils";

/** `/loans/<id>/` → `<id>`. The static export only ships the "_" placeholder page, so the real id comes from the URL. */
export function agreementIdFromPath(pathname: string | null): string | null {
  const segments = (pathname ?? "").split("/").filter(Boolean);
  const i = segments.indexOf("loans");
  const raw = i >= 0 ? segments[i + 1] : undefined;
  if (!raw || raw === "_") return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/** The workspace fits one desktop screen: the viewport below the top bar and the page padding, never shorter than this. */
const WORKSPACE_HEIGHT = "h-[calc(100dvh-7.5rem)] min-h-[29rem]";

/**
 * The Loan & EMI workspace (`/loans/<id>/`): every record in a narrow list on the left, the selected one on the right.
 * Picking a record swaps the right panel in place — the route follows with a replace, so Back still leaves the workspace —
 * and payments open as a compact popup over the workspace. The right panel is the very controller (`LoansWorkspace` /
 * `EmiWorkspace`) the list used to open as a window, so every payment, edit, close and delete handler and every People
 * link is the existing one. A record's kind is latched once found: a permanent deletion removes the row while its own
 * progress dialog is still on screen, and must not unmount it.
 */
export function AgreementDetailPage() {
  const id = agreementIdFromPath(usePathname());
  const { rows: loanRows, isLoading: loansLoading } = useLoanRows();
  const { rows: emiRows, isLoading: emisLoading } = useEmiRows();
  const [latched, setLatched] = useState<{ id: string; kind: "loan" | "emi" } | null>(null);
  const found = id == null ? null : loanRows.some((r) => r.loan.id === id) ? "loan" : emiRows.some((r) => r.emi.id === id) ? "emi" : null;
  if (id != null && found && (latched?.id !== id || latched.kind !== found)) setLatched({ id, kind: found });
  const kind = id != null && latched?.id === id ? latched.kind : null;

  if (id != null && kind != null) {
    return (
      <InlineHostProvider>
        <div className={cn("flex min-w-0 flex-col gap-2 xl:flex-row xl:gap-3 xl:px-1", WORKSPACE_HEIGHT)} data-testid="loan-emi-workspace">
          <Link href="/loans/" className="inline-flex min-h-7 w-fit shrink-0 items-center gap-1.5 text-xs font-semibold text-foreground hover:underline xl:hidden">
            <ArrowLeft className="size-4" aria-hidden /> Loan &amp; EMI
          </Link>
          <div className="hidden shrink-0 xl:block">
            <AgreementNavList selectedId={id} />
          </div>
          <div key={id} className="min-h-0 min-w-0 flex-1">
            <PaymentAwarenessProvider>
              <StackProvider>{kind === "loan" ? <LoansWorkspace pageAgreementId={id} /> : <EmiWorkspace pageAgreementId={id} />}</StackProvider>
            </PaymentAwarenessProvider>
          </div>
        </div>
      </InlineHostProvider>
    );
  }
  if (id != null && (loansLoading || emisLoading)) {
    return (
      <div className={cn("flex min-w-0 gap-3 px-1", WORKSPACE_HEIGHT)} aria-busy="true">
        <Skeleton className={cn(LE_RADIUS.panel, "hidden h-full w-[17.5rem] shrink-0 xl:block")} />
        <Skeleton className={cn(LE_RADIUS.panel, "h-full flex-1")} />
      </div>
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-3 px-1">
      <Link href="/loans/" className="inline-flex h-8 w-fit items-center gap-1.5 text-[13px] font-semibold text-foreground hover:underline">
        <ArrowLeft className="size-4" aria-hidden /> Back to Loan &amp; EMI
      </Link>
      <div className={cn(LE_RADIUS.panel, "flex flex-col items-center gap-2 border border-dashed border-border bg-card px-4 py-10 text-center")} data-testid="agreement-not-found">
        <SearchX className="size-6 text-muted-foreground" aria-hidden />
        <p className="font-heading text-base font-semibold text-foreground">We couldn&apos;t find this loan or EMI</p>
        <p className="text-sm text-muted-foreground">It may have been deleted or moved to Trash.</p>
      </div>
    </div>
  );
}
