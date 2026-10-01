import { Suspense } from "react";
import { TransactionsWorkspace } from "@/features/transactions/components/transactions-workspace";

export default function TransactionsPage() {
  // `TransactionsWorkspace` reads its query params with `useSearchParams`, which needs a Suspense boundary.
  return (
    <Suspense>
      <TransactionsWorkspace />
    </Suspense>
  );
}
