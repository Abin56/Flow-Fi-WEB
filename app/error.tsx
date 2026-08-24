"use client";

import { useEffect } from "react";

export default function GlobalError({
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
    <html lang="en">
      <body>
        <div className="flex h-dvh flex-col items-center justify-center gap-4 px-4 text-center">
          <h1 className="text-lg font-semibold">Something went wrong</h1>
          <p className="max-w-sm text-sm text-muted-foreground">
            An unexpected error occurred. You can try again, or reload the page.
          </p>
          <button
            type="button"
            onClick={reset}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
