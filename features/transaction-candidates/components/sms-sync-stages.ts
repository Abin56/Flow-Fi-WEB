/**
 * The five user-facing stages of the SMS Sync tracker, derived purely from state the hook already reads (phone presence,
 * pairing records, the phone's post-pairing report and the seven-step progress). No reads, no writes, no timers.
 *
 * A stage is only ever done on evidence:
 *  - device      — the phone's heartbeat was seen, or a phone opened/approved a code, or one is paired.
 *  - permissions — the phone reported SMS access allowed (live heartbeat, else its post-pairing report).
 *  - autoSync    — the phone reported Auto Sync on (heartbeat), or its report confirmed it after pairing.
 *  - pairing     — an active device is named by the server's upload switch.
 *  - syncing     — paired, and the phone finished a scan after pairing.
 *
 * Exactly one stage is "current": an explicit active/failed/expired one, otherwise the first that isn't done.
 */

import type { SmsSyncSetup } from "@/hooks/use-sms-sync-setup";
import { formatRelative, type SetupStep, type StepId } from "@/lib/sms-pairing/setup-progress";

export type StageId = "device" | "permissions" | "autoSync" | "pairing" | "syncing";
export type StageState = "done" | "active" | "upcoming" | "failed" | "expired";

export interface SyncStage {
  id: StageId;
  label: string;
  /** One-word label for narrow containers. */
  short: string;
  /** Short supporting text, only when it says something the label doesn't. */
  caption: string | null;
  state: StageState;
}

type StageInput = Pick<SmsSyncSetup, "presence" | "presenceSummary" | "hasPairedDevice" | "device" | "session" | "progress" | "now">;

const SMS_FAILED: Record<string, string> = {
  denied: "Not allowed on the phone",
  permanentlyDenied: "Blocked in phone Settings",
  unsupported: "Not in this app build",
};

export function deriveSyncStages(setup: StageInput): SyncStage[] {
  const { presence: p, presenceSummary: s, hasPairedDevice: paired, device, session, progress, now } = setup;
  const step = (id: StepId): SetupStep | undefined => progress.steps.find((x) => x.id === id);
  const opened = session?.status === "opened" || session?.status === "approved";

  // 1. Device
  const deviceSeen = p !== null || paired || opened;
  const device1: SyncStage = {
    id: "device",
    label: "Device detected",
    short: "Device",
    caption: p?.label ?? (paired ? (device?.label ?? null) : opened ? "Opened the code" : "Open FlowFi on Android"),
    state: deviceSeen ? "done" : "upcoming",
  };

  // 2. Permissions — the live heartbeat is the freshest report; otherwise the post-pairing one.
  let permissions: SyncStage = { id: "permissions", label: "Permissions ready", short: "Permissions", caption: null, state: "upcoming" };
  if (p) {
    if (p.smsPermission === "granted") {
      permissions = { ...permissions, state: "done", caption: p.notificationAccess === "granted" ? "SMS + notifications" : "SMS allowed" };
    } else if (SMS_FAILED[p.smsPermission]) {
      permissions = { ...permissions, state: "failed", caption: SMS_FAILED[p.smsPermission]! };
    } else {
      permissions = { ...permissions, caption: "Allow SMS on the phone" };
    }
  } else if (paired) {
    const st = step("permission");
    if (st?.state === "done") permissions = { ...permissions, state: "done", caption: "SMS allowed" };
    else if (st?.state === "failed") permissions = { ...permissions, state: "failed", caption: "Needs attention on the phone" };
    else permissions = { ...permissions, caption: "Waiting for the phone" };
  }

  // 3. Auto Sync
  let autoSync: SyncStage = { id: "autoSync", label: "Auto Sync enabled", short: "Auto Sync", caption: null, state: "upcoming" };
  const autoStep = paired ? step("autoSync") : undefined;
  if (autoStep?.state === "done" || p?.autoSyncEnabled) autoSync = { ...autoSync, state: "done", caption: "On" };
  else if (autoStep?.state === "failed") autoSync = { ...autoSync, state: "failed", caption: "Cloud Sync unconfirmed" };
  else if (p || paired) autoSync = { ...autoSync, caption: "Turn on in FlowFi" };

  // 4. Pairing
  let pairing: SyncStage;
  const qr = step("qr");
  if (paired) pairing = { id: "pairing", label: "Paired", short: "Paired", caption: device?.label ?? null, state: "done" };
  else if (session?.status === "opened") pairing = { id: "pairing", label: "Pairing pending", short: "Pairing", caption: "Approve on the phone", state: "active" };
  else if (qr?.state === "expired") pairing = { id: "pairing", label: "Pairing pending", short: "Pairing", caption: "Needs a new code", state: "expired" };
  else if (qr?.state === "failed") pairing = { id: "pairing", label: "Pairing pending", short: "Pairing", caption: "Couldn't create a code", state: "failed" };
  else pairing = { id: "pairing", label: "Pairing pending", short: "Pairing", caption: qr?.state === "done" ? "Scan the QR" : null, state: "upcoming" };

  // 5. Connected and syncing — never before pairing, so an unpaired or revoked phone shows no stale "connected".
  let syncing: SyncStage = { id: "syncing", label: "Connected and syncing", short: "Syncing", caption: null, state: "upcoming" };
  if (paired) {
    const firstScan = step("firstScan");
    const candidates = step("candidates");
    if (s?.syncRunning && p) {
      syncing = { ...syncing, state: "active", caption: s.syncPhase === "scanning" ? "Scanning…" : p.syncTotal ? `Uploading ${p.syncDone}/${p.syncTotal}` : "Uploading…" };
    } else if (firstScan?.state === "failed" || candidates?.state === "failed" || s?.syncPhase === "failed") {
      syncing = { ...syncing, state: "failed", caption: "Last sync didn't finish" };
    } else if (firstScan?.state === "done") {
      const last = p?.lastSyncAt ?? firstScan.at;
      syncing = { ...syncing, state: "done", caption: last ? `Last sync ${formatRelative(last, now)}` : null };
    } else {
      syncing = { ...syncing, caption: "Waiting for the first scan" };
    }
  }

  const stages = [device1, permissions, autoSync, pairing, syncing];
  if (!stages.some((st) => st.state === "active" || st.state === "failed" || st.state === "expired")) {
    const next = stages.find((st) => st.state !== "done");
    if (next) next.state = "active";
  }
  return stages;
}

/** The stage the user should look at: the explicit current one, or the last when all are done. */
export function currentStage(stages: SyncStage[]): SyncStage {
  return stages.find((s) => s.state === "failed" || s.state === "expired") ?? stages.find((s) => s.state === "active") ?? stages[stages.length - 1]!;
}
