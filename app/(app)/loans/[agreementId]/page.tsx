import { Suspense } from "react";
import { AgreementDetailPage } from "@/features/loans/components/agreement-detail-page";

// Static export: one placeholder page; firebase.json rewrites every Loan / EMI id to it (the id is read from the URL).
export const dynamicParams = false;
export function generateStaticParams() {
  return [{ agreementId: "_" }];
}

export default function LoanEmiDetailRoute() {
  return (
    <Suspense fallback={null}>
      <AgreementDetailPage />
    </Suspense>
  );
}
