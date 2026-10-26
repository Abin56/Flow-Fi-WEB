"use client";

/**
 * What the Transaction Inbox shows when the unfiltered candidate queue is empty. Candidates, when there are any, are
 * rendered by the workspace instead and always take priority over this — so the moment the first one arrives, the
 * inbox replaces whatever setup state was showing here.
 *
 *  - Cloud Sync switched on by an operator,
 *    with no pairing record (legacy)         → compact "configured" state (never claims a live connection).
 *  - everything else                         → the one live SMS Sync panel, which shapes itself to the setup state
 *                                              (connect with QR, finish setup on the phone, all set, paused).
 *  - still reading                           → a quiet placeholder, so the connect panel doesn't flash for a paired user.
 */

import { useSmsSyncConfig } from "@/hooks/use-sms-sync-config";
import { useSmsSyncSetup } from "@/hooks/use-sms-sync-setup";
import { SmsCloudSyncConfigured } from "./sms-cloud-sync-configured";
import { SmsSetupJourney } from "./sms-setup-journey";

export function SmsInboxEmptyState() {
  const config = useSmsSyncConfig();
  const setup = useSmsSyncSetup();
  if (config === "loading" || (config !== "unknown" && !setup.loaded)) {
    return <div role="status" aria-label="Checking SMS sync setup" data-testid="sms-sync-config-loading" className="h-40 animate-pulse rounded-[24px] border border-border/60 bg-card" />;
  }
  if (!setup.hasPairedDevice && !setup.pairingAnother && config === "configured") return <SmsCloudSyncConfigured />;
  return <SmsSetupJourney setup={setup} />;
}
