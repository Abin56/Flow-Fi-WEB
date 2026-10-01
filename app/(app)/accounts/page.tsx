import { Suspense } from "react";
import { AccountsWorkspace } from "@/features/accounts/components/accounts-workspace";

export default function AccountsPage() {
  // `AccountsWorkspace` reads its query params with `useSearchParams`, which needs a Suspense boundary.
  return (
    <Suspense>
      <AccountsWorkspace />
    </Suspense>
  );
}
