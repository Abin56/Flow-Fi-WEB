"use client";

import { useEffect } from "react";
import { ClayButton } from "@/components/clay/clay-button";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-4 text-center">
      <h1 className="text-lg font-semibold">Something went wrong</h1>
      <p className="max-w-sm text-sm text-muted-foreground">
        This page hit an unexpected error. You can try again, or head back to the dashboard.
      </p>
      <div className="flex gap-3">
        <ClayButton type="button" onClick={reset}>
          Try again
        </ClayButton>
        <a
          href="/dashboard"
          className="inline-flex h-10 items-center justify-center rounded-2xl border border-border bg-card px-4 text-sm font-medium text-foreground shadow-e1 transition-colors hover:bg-muted"
        >
          Go to dashboard
        </a>
      </div>
    </div>
  );
}
