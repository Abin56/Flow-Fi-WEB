import { Suspense } from "react";
import { TransactionCandidatesWorkspace } from "@/features/transaction-candidates/components/transaction-candidates-workspace";

export default function TransactionCandidatesPage() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* `TransactionCandidatesWorkspace` keeps its filters in the query string with `useSearchParams`, which needs a Suspense boundary. */}
      <Suspense>
        <TransactionCandidatesWorkspace />
      </Suspense>
    </div>
  );
}
