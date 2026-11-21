import { Suspense } from "react";
import { SavingsWorkspace } from "@/features/savings/components/savings-workspace";

export default function SavingsPage() {
  // `SavingsWorkspace` keeps the current screen in the URL (`?tab=`, `?goal=`, `?new=`) via `useSearchParams`, which needs a Suspense boundary.
  return (
    <Suspense>
      <SavingsWorkspace />
    </Suspense>
  );
}
