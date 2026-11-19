"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { toast } from "@/store/toast-store";

const undo = { label: "Undo", onClick: () => toast.info("Restored", "Bank of India is back in review.") };

const samples = {
  success: () => toast.success("Candidate dismissed", "Bank of India removed from review.", undo),
  successShort: () => toast.success("Changes saved"),
  info: () => toast.info("Syncing balances", "This can take a few seconds."),
  warning: () => toast.warning("Date is in the future", "Check it against the statement."),
  error: () => toast.error("Unable to save changes", "You're offline. Try again when connected."),
};

/** Fires every toast tone so the design can be reviewed. `?demo=1` fires the full set on load (with long timers). */
export function ToastShowcase() {
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("demo") !== "1") return;
    toast.success("Candidate dismissed", "Bank of India removed from review.", undo, { duration: 15_000 });
    toast.success("Changes saved", undefined, undefined, { duration: 2_600 });
    toast.warning("Date is in the future", "Check it against the statement.", undefined, { duration: 4_000 });
    toast.error("Unable to save changes", "You're offline. Try again when connected.");
  }, []);

  return (
    <main className="min-h-dvh bg-background">
      <div className="flex h-14 items-center border-b border-border px-6 text-sm font-semibold">Top bar (stand-in)</div>
      <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-10">
        <h1 className="font-heading text-xl font-semibold">Toast notifications</h1>
        <p className="text-sm text-muted-foreground">Fire each type. Hover a toast to pause its countdown.</p>
        <div className="flex flex-wrap gap-2">
          {Object.entries(samples).map(([k, fire]) => (
            <Button key={k} variant="outline" onClick={fire} data-testid={`fire-${k}`}>
              {k}
            </Button>
          ))}
        </div>
      </div>
    </main>
  );
}
