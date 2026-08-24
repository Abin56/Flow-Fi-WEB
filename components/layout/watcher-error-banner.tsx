"use client";

import { AlertCircleIcon, RotateCcwIcon } from "lucide-react";
import { useWatcherErrors } from "@/hooks/use-watcher-errors";
import { retryFirestoreWatch } from "@/hooks/use-firestore-watch";
import { cn } from "@/lib/utils";

/**
 * Persistent top-of-app strip shown whenever one or more live Firestore
 * listeners are currently failing (permission-denied, a rules change, a
 * genuine backend error — not an ordinary network blip, which Firestore's
 * own reconnect logic and the offline cache already absorb silently).
 *
 * Before this existed, a listener failure was only ever `console.error`'d —
 * the screen it fed just sat on stale/empty/loading state forever with
 * nothing telling the user why, or how to try again. This closes that gap
 * app-wide: `useWatcherErrors` reactively scans the query cache for any
 * query in an error state (every such query in this app is a
 * `useFirestoreWatch` listener), so a newly-added watcher hook is covered
 * automatically with no extra wiring here.
 */
export function WatcherErrorBanner() {
  const errors = useWatcherErrors();
  if (errors.length === 0) return null;

  return (
    <div
      role="alert"
      className={cn(
        "flex shrink-0 items-center justify-center gap-2 bg-danger/12 px-4 py-2 text-xs font-medium text-danger-foreground",
      )}
    >
      <AlertCircleIcon className="size-3.5 shrink-0" />
      <span>
        {errors.length === 1
          ? "Couldn't load some of your data."
          : `Couldn't load some of your data (${errors.length} sources affected).`}
      </span>
      <button
        type="button"
        onClick={() => {
          for (const e of errors) retryFirestoreWatch(e.queryKey);
        }}
        className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-semibold underline underline-offset-2 hover:opacity-80"
      >
        <RotateCcwIcon className="size-3" />
        Retry
      </button>
    </div>
  );
}
