import type { Metadata } from "next";
import { Suspense } from "react";
import { PairLanding } from "./pair-landing";

export const metadata: Metadata = {
  title: "Pair your phone · FlowFi",
  description: "Continue FlowFi SMS Sync setup in the FlowFi Android app.",
  robots: { index: false, follow: false },
};

// `PairLanding` reads `?t=` with `useSearchParams`, which needs a Suspense boundary under static export.
export default function PairPage() {
  return (
    <Suspense fallback={<div className="min-h-dvh bg-background" />}>
      <PairLanding />
    </Suspense>
  );
}
