/**
 * Live phone presence for SMS Sync (`users/{uid}/smsDevicePresence/{deviceId}`), folded into the separate facts the
 * web shows — never one "Connected" flag:
 *
 *  - reachability  online (foreground heartbeat is fresh) / background (app left recently) / offline (stale)
 *  - permissions   SMS permission + notification access, as the phone verified them with Android
 *  - Auto Sync     the phone's own switch
 *  - paired        from smsDevices + backgroundUpload (server-written), NOT from presence
 *  - syncing       the phone's current sync phase and counts
 *
 * The phone heartbeats every {@link HEARTBEAT_INTERVAL_MS} while FlowFi is open; `heartbeatAt` is the server's time,
 * so an old "foreground" document turns into "offline" here instead of claiming the phone is online forever.
 */

export const HEARTBEAT_INTERVAL_MS = 60_000;
/** Two missed heartbeats plus slack. */
export const ONLINE_STALE_MS = 150_000;
/** A background report counts as "recently active" for this long. */
export const BACKGROUND_STALE_MS = 30 * 60_000;
/** A sync phase that stopped updating this long ago is no longer shown as running. */
export const SYNC_STALE_MS = 5 * 60_000;

export type PresenceSmsPermission = "granted" | "denied" | "permanentlyDenied" | "unsupported" | "unknown";
export type PresenceNotificationAccess = "granted" | "denied" | "unsupported" | "unknown";
export type PresenceSyncPhase = "idle" | "scanning" | "uploading" | "done" | "failed";

export interface DevicePresenceView {
  deviceId: string;
  label: string;
  appVersion: string | null;
  appState: "foreground" | "background";
  smsPermission: PresenceSmsPermission;
  notificationAccess: PresenceNotificationAccess;
  autoSyncEnabled: boolean;
  syncPhase: PresenceSyncPhase;
  syncTotal: number | null;
  syncDone: number;
  syncUploaded: number;
  syncSkipped: number;
  syncFailed: number;
  syncUpdatedAt: number | null;
  lastSyncAt: number | null;
  heartbeatAt: number | null;
}

export type Reachability = "online" | "background" | "offline";

export interface PresenceSummary {
  reachability: Reachability;
  /** When the phone was last heard from. */
  lastSeenAt: number | null;
  /** Sync phase as it stands now (a running phase with no recent update is shown as `idle`). */
  syncPhase: PresenceSyncPhase;
  syncRunning: boolean;
  /** 0..1 only when the phone reported a real total; otherwise null (indeterminate — never a fake percentage). */
  syncFraction: number | null;
}

export function summarizePresence(p: DevicePresenceView, now: number): PresenceSummary {
  const age = p.heartbeatAt === null ? Infinity : Math.max(0, now - p.heartbeatAt);
  const reachability: Reachability =
    p.appState === "foreground" && age <= ONLINE_STALE_MS ? "online" : age <= (p.appState === "background" ? BACKGROUND_STALE_MS : ONLINE_STALE_MS) ? "background" : "offline";

  const running = p.syncPhase === "scanning" || p.syncPhase === "uploading";
  const syncAge = p.syncUpdatedAt === null ? Infinity : Math.max(0, now - p.syncUpdatedAt);
  const syncRunning = running && syncAge <= SYNC_STALE_MS;
  const syncPhase: PresenceSyncPhase = running && !syncRunning ? "idle" : p.syncPhase;
  const syncFraction = syncRunning && p.syncTotal !== null && p.syncTotal > 0 ? Math.min(1, p.syncDone / p.syncTotal) : null;

  return { reachability, lastSeenAt: p.heartbeatAt, syncPhase, syncRunning, syncFraction };
}

/** The install to show: the paired device when it has reported, else the most recently heard-from install. */
export function pickPresence(all: DevicePresenceView[], pairedDeviceId: string | null): DevicePresenceView | null {
  if (pairedDeviceId) {
    const paired = all.find((p) => p.deviceId === pairedDeviceId);
    if (paired) return paired;
  }
  return all.reduce<DevicePresenceView | null>((best, p) => ((p.heartbeatAt ?? 0) > (best?.heartbeatAt ?? -1) ? p : best), null);
}
