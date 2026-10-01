import { Suspense } from "react";
import { CreditCardsWorkspace } from "@/features/credit-cards/components/credit-cards-workspace";

export default function CreditCardsPage() {
  // `CreditCardsWorkspace` reads its query params with `useSearchParams`, which needs a Suspense boundary.
  return (
    <Suspense>
      <CreditCardsWorkspace />
    </Suspense>
  );
}
