"use client";

import { WifiOffIcon } from "lucide-react";
import { useOnlineStatus } from "@/hooks/use-online-status";
import { cn } from "@/lib/utils";

/**
 * Persistent top-of-app strip shown only while the browser reports no
 * network connectivity — Firestore's offline persistence cache (see
 * lib/firebase/client.ts) keeps showing the last-synced data underneath,
 * but nothing else in the app told the user that's what's happening; this
 * closes that gap. Not a dismissible Banner/Toast — connectivity state
 * isn't a one-off event, it's a mode the whole app is in until it clears
 * on its own via the `online` event.
 */
export function OfflineBanner() {
  const online = useOnlineStatus();
  if (online) return null;

  return (
    <div
      role="status"
      className={cn(
        "flex shrink-0 items-center justify-center gap-2 bg-warning/18 px-4 py-2 text-xs font-medium text-warning-foreground",
      )}
    >
      <WifiOffIcon className="size-3.5 shrink-0" />
      You&apos;re offline — showing your last available data. Changes will sync once you&apos;re back online.
    </div>
  );
}
