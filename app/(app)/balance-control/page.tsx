import { Suspense } from "react";
import { BalanceControlWorkspace } from "@/features/balance-control/components/balance-control-workspace";

export default function BalanceControlPage() {
  // `BalanceControlWorkspace` reads its deep-link query param (`?product=`) with `useSearchParams`, which needs a Suspense boundary.
  return (
    <Suspense>
      <BalanceControlWorkspace />
    </Suspense>
  );
}
