"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuthStore } from "@/store/auth-store";

const AUTH_TIMEOUT_MS = 8000;

/**
 * Local-dev-only visual-QA bypass — `?devPreview=1` on any `(app)` route skips this guard's
 * redirect-to-login so Transaction Studio's existing mock-data fixture (the "Live/20 rows/…"
 * toggle in `TransactionStudio`) can be exercised without a real signed-in session, for automated
 * browser verification of UI changes.
 *
 * Gated on `process.env.NODE_ENV === "development"` — a build-time constant Next.js dead-code-
 * eliminates from production bundles (the same mechanism the existing dev-fixture toggle already
 * relies on), so this whole branch is provably absent from production, not merely inert there.
 *
 * Never touches `useAuthStore`/real Firebase auth — no fake user is created, no token is forged.
 * It only skips *this component's* redirect; every data hook downstream (`use-categories.ts`,
 * `use-accounts.ts`, `use-document-import-records.ts`, …) is already `enabled: !!uid`, so with no
 * real `uid` nothing here ever reads or writes Firestore — confirmed by reading each hook, not
 * assumed.
 */
function isDevPreviewRequested(): boolean {
  if (process.env.NODE_ENV !== "development") return false;
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("devPreview") === "1";
}

export function RouteGuard({ children }: { children: React.ReactNode }) {
  const status = useAuthStore((state) => state.status);
  const router = useRouter();
  const [timedOut, setTimedOut] = useState(false);
  const [devPreview, setDevPreview] = useState(false);

  // A genuine exception to "derive state during render instead of an effect": a lazy `useState`
  // initializer runs again on the client's *first* render during hydration (not just once ever),
  // so reading `window.location` there returns `true` on the client while the server-rendered HTML
  // (where `window` doesn't exist) already committed the `false` branch — a real hydration
  // mismatch, confirmed by React's own hydration-mismatch error when this was tried. Flipping the
  // state in an effect instead means the server markup and the client's first (pre-hydration-
  // effects) render agree, and `devPreview` only flips *after* hydration has already committed —
  // exactly the documented use for an effect ("subscribe to an external system"), not the
  // anti-pattern that rule normally targets.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- see comment above; this is the correct SSR/hydration pattern, not the redundant-derived-state case the rule targets
    setDevPreview(isDevPreviewRequested());
  }, []);

  useEffect(() => {
    if (status === "signed-out" && !devPreview) router.replace("/login");
  }, [status, router, devPreview]);

  useEffect(() => {
    if (status !== "loading" || devPreview) return;
    const timer = setTimeout(() => setTimedOut(true), AUTH_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [status, devPreview]);

  if (!devPreview && status !== "signed-in") {
    if (timedOut) {
      return (
        <div className="flex h-dvh items-center justify-center bg-background">
          <div className="w-full max-w-sm space-y-3 px-4 text-center">
            <p className="text-sm text-muted-foreground">
              Taking longer than expected to sign you in.
            </p>
            <button
              type="button"
              onClick={() => router.replace("/login")}
              className="text-sm font-medium text-primary underline underline-offset-2"
            >
              Go to sign in
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className="flex h-dvh items-center justify-center bg-background">
        <div className="w-full max-w-sm space-y-3 px-4">
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
        </div>
      </div>
    );
  }

  return (
    <>
      {devPreview && (
        <div
          role="status"
          className="fixed inset-x-0 top-0 z-[999] bg-warning px-3 py-1.5 text-center text-xs font-semibold tracking-wide text-warning-foreground uppercase"
        >
          Local dev preview — not real account data
        </div>
      )}
      {children}
    </>
  );
}
