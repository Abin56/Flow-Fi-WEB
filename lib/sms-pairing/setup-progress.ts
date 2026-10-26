/**
 * SMS Sync setup journey — pure derivation from live evidence to the seven
 * steps the Transaction Inbox shows while a user pairs their Android phone.
 *
 * Every step is backed by a specific, trustworthy record, never by a guess:
 *
 *   1. QR ready             — a pairing session the pairing Cloud Function created.
 *   2. App opened on phone  — that session's `openedAt`, set by the function when an
 *                             authenticated client presented the token. A camera scan
 *                             alone proves nothing and is never counted.
 *   3. Account paired       — session approved AND an `active` device in smsDevices AND
 *                             the F3 switch (`backgroundUpload`) naming that device.
 *   4. SMS permission       — the phone's own report (smsDeviceStatus), server-timestamped.
 *   5. Auto Sync on         — the phone reports Auto Sync on and its gate saw Cloud Sync
 *                             enabled, in a report made after pairing.
 *   6. First scan           — a successful scan reported after pairing.
 *   7. Candidates           — candidate documents actually present.
 *
 * Steps 4–6 are self-reported by the phone, so the UI says "your phone reported…",
 * shows when, and flags a stale report. Nothing here ever claims the phone is
 * "online", "connected" or "syncing" right now.
 */

export type PairingSessionStatus = "pending" | "opened" | "approved" | "canceled" | "superseded";

export interface PairingSessionView {
  status: PairingSessionStatus;
  createdAt: number;
  expiresAt: number;
  openedAt: number | null;
  approvedAt: number | null;
  deviceId: string | null;
  canceledBy: "phone" | "web" | null;
  rejectedAttempts: number;
}

export interface SmsDeviceView {
  deviceId: string;
  label: string;
  status: "active" | "revoked" | "replaced";
  pairedAt: number | null;
}

export type SmsPermissionReport = "granted" | "denied" | "permanentlyDenied" | "unsupported" | "unknown";

export interface SmsDeviceStatusView {
  smsPermission: SmsPermissionReport;
  autoSyncEnabled: boolean;
  cloudSync: "enabled" | "disabled" | "unverified" | null;
  lastScanAt: number | null;
  lastScanOutcome: "ok" | "permission" | "failed" | null;
  lastUploadAt: number | null;
  lastUploadOutcome: "ok" | "failed" | null;
  lastUploadedCount: number;
  pendingNotOwnedCount: number;
  reportedAt: number | null;
}

export interface UploadConfigView {
  enabled: boolean;
  deviceId: string | null;
}

/** Stable reason codes from the pairing Cloud Functions (`details.reason`), plus client-side failures. */
export type PairingFailureReason =
  | "sync_suspended"
  | "rate_limited"
  | "offline"
  | "unauthenticated"
  | "unknown"
  | (string & {});

export type StepId = "qr" | "app" | "paired" | "permission" | "autoSync" | "firstScan" | "candidates";
export type StepState = "upcoming" | "active" | "done" | "failed" | "expired";

export interface SetupStep {
  id: StepId;
  title: string;
  state: StepState;
  detail: string;
  /** When the evidence for this step was recorded, if known. */
  at: number | null;
}

export interface SetupInput {
  creating: boolean;
  createError: PairingFailureReason | null;
  session: PairingSessionView | null;
  /** The device `backgroundUpload.deviceId` names, if its smsDevices record exists. */
  device: SmsDeviceView | null;
  status: SmsDeviceStatusView | null;
  config: UploadConfigView | null;
  candidateCount: number;
  /** The operator's global switch is on (smsSyncControl/global.uploadsDisabled). */
  suspended: boolean;
  now: number;
}

export type SetupPhase = "pairing" | "setup" | "complete" | "suspended";

export interface SetupProgress {
  phase: SetupPhase;
  steps: SetupStep[];
  /** Index of the first step that isn't done (steps.length when all are). */
  currentIndex: number;
  /** True once an active device is paired and named by the upload switch. */
  paired: boolean;
  /** The phone's last report is older than {@link STALE_REPORT_MS}. */
  staleReport: boolean;
  /** Earlier SMS on the phone that aren't linked to this account (they need the phone's explicit "Link earlier messages"). */
  pendingNotOwnedCount: number;
}

export const STALE_REPORT_MS = 30 * 60 * 1000;

/** Mirrors the pairing function's session lifetime; only used before a session's own times are known. */
export const SMS_PAIRING_TTL_MS_HINT = 10 * 60 * 1000;

export const STEP_TITLES: Record<StepId, string> = {
  qr: "QR code ready",
  app: "FlowFi opened on your phone",
  paired: "Account verified and paired",
  permission: "SMS permission granted",
  autoSync: "SMS Auto Sync on",
  firstScan: "First scan completed",
  candidates: "Candidates ready for review",
};

const CREATE_ERROR_DETAIL: Record<string, string> = {
  sync_suspended: "SMS Sync is paused by FlowFi right now. No new phones can be paired until it's back.",
  rate_limited: "Too many codes were created recently. Wait a few minutes, then try again.",
  offline: "You're offline. Reconnect to create a pairing code.",
  unauthenticated: "Your session ended. Sign in again to pair a phone.",
};

export function isSessionExpired(session: PairingSessionView, now: number): boolean {
  return (session.status === "pending" || session.status === "opened") && now >= session.expiresAt;
}

export function isActivelyPaired(device: SmsDeviceView | null, config: UploadConfigView | null): boolean {
  return device !== null && device.status === "active" && config !== null && config.enabled && config.deviceId === device.deviceId;
}

/** A report counts only if made after this pairing — an older one may describe a previous setup. */
function reportAfterPairing(status: SmsDeviceStatusView | null, pairedAt: number | null): SmsDeviceStatusView | null {
  if (!status || status.reportedAt === null) return null;
  if (pairedAt !== null && status.reportedAt < pairedAt) return null;
  return status;
}

function step(id: StepId, state: StepState, detail: string, at: number | null = null): SetupStep {
  return { id, title: STEP_TITLES[id], state, detail, at };
}

function upcoming(id: StepId, detail = "") {
  return step(id, "upcoming", detail);
}

function pairingSteps(input: SetupInput): SetupStep[] {
  const { session, now } = input;

  let qr: SetupStep;
  if (input.createError) {
    qr = step("qr", "failed", CREATE_ERROR_DETAIL[input.createError] ?? "We couldn't create a pairing code. Try again.");
  } else if (!session || input.creating) {
    qr = step("qr", "active", "Creating a secure, single-use code…");
  } else if (session.status === "canceled") {
    qr = step("qr", "failed", session.canceledBy === "phone" ? "Pairing was canceled on your phone. Create a new code to try again." : "This code was canceled.");
  } else if (session.status === "superseded") {
    qr = step("qr", "expired", "A newer code replaced this one (perhaps in another tab).");
  } else if (isSessionExpired(session, now)) {
    qr = step("qr", "expired", "This code expired before it was approved. Create a new one.");
  } else {
    qr = step("qr", "done", "Scan it with your Android phone's camera. It works once and expires in 10 minutes.", session.createdAt);
  }

  if (qr.state !== "done" || !session) {
    return [qr, upcoming("app"), upcoming("paired"), upcoming("permission"), upcoming("autoSync"), upcoming("firstScan"), upcoming("candidates")];
  }

  const opened = session.status === "opened" || session.status === "approved";
  const app = opened
    ? step("app", "done", "The FlowFi app opened this code while signed in to your account.", session.openedAt)
    : session.rejectedAttempts > 0
      ? step("app", "failed", "A phone signed in to a different FlowFi account tried this code. Sign in on the phone with the account you use here, then scan again.")
      : step("app", "active", "Waiting for the FlowFi app to open the code. Scanning alone doesn't count — the app has to open it.");

  const paired = !opened
    ? upcoming("paired")
    : session.status === "approved"
      ? step("paired", "active", "Approved on your phone — finishing registration…", session.approvedAt)
      : step("paired", "active", "Waiting for you to tap Approve on your phone.");

  return [qr, app, paired, upcoming("permission"), upcoming("autoSync"), upcoming("firstScan"), upcoming("candidates")];
}

function pairedSteps(input: SetupInput, device: SmsDeviceView): SetupStep[] {
  const pairedAt = device.pairedAt;
  const report = reportAfterPairing(input.status, pairedAt);
  const sessionForDevice = input.session && input.session.deviceId === device.deviceId ? input.session : null;

  const steps: SetupStep[] = [
    step("qr", "done", "Pairing code used.", sessionForDevice?.createdAt ?? null),
    step("app", "done", `Opened in FlowFi on ${device.label}.`, sessionForDevice?.openedAt ?? pairedAt),
    step("paired", "done", `${device.label} is the phone that sends SMS candidates to this account.`, pairedAt),
  ];

  // 4. Permission
  if (!report) {
    steps.push(step("permission", "active", "Waiting for your phone to report SMS permission."));
  } else if (report.smsPermission === "granted") {
    steps.push(step("permission", "done", "Your phone reported SMS access is allowed.", report.reportedAt));
  } else if (report.smsPermission === "permanentlyDenied") {
    steps.push(step("permission", "failed", "SMS access is blocked. On the phone, open Settings › Apps › FlowFi › Permissions › SMS and allow it."));
  } else if (report.smsPermission === "denied") {
    steps.push(step("permission", "failed", "SMS access was declined on the phone. Open FlowFi and tap Allow SMS access to continue."));
  } else if (report.smsPermission === "unsupported") {
    steps.push(step("permission", "failed", "This FlowFi build can't read SMS. Install the FlowFi Android app from this page instead of the store version."));
  } else {
    steps.push(step("permission", "active", "Waiting for you to allow SMS access on the phone."));
  }
  if (steps[3]!.state !== "done") {
    return [...steps, upcoming("autoSync"), upcoming("firstScan"), upcoming("candidates")];
  }

  // 5. Auto Sync — the phone must report it on, and its own gate must have seen the server switch enabled.
  const r = report!;
  if (!r.autoSyncEnabled) {
    steps.push(step("autoSync", "active", "Waiting for you to turn on SMS Auto Sync on the phone."));
  } else if (r.cloudSync === "enabled") {
    steps.push(step("autoSync", "done", "Your phone reported Auto Sync on and Cloud Sync allowed for this account.", r.reportedAt));
  } else if (r.cloudSync === "unverified") {
    steps.push(step("autoSync", "failed", "Your phone couldn't confirm Cloud Sync (it may be offline). It retries on the next scan — or open FlowFi and tap Scan now."));
  } else {
    steps.push(step("autoSync", "active", "Auto Sync is on. Waiting for your phone to confirm Cloud Sync on its next scan."));
  }
  if (steps[4]!.state !== "done") {
    return [...steps, upcoming("firstScan"), upcoming("candidates")];
  }

  // 6. First scan after pairing
  const scannedAfterPairing = r.lastScanAt !== null && (pairedAt === null || r.lastScanAt >= pairedAt);
  if (scannedAfterPairing && r.lastScanOutcome === "ok") {
    steps.push(step("firstScan", "done", "Your phone finished scanning for eligible bank alerts.", r.lastScanAt));
  } else if (scannedAfterPairing && r.lastScanOutcome === "permission") {
    steps.push(step("firstScan", "failed", "The scan stopped because SMS access was turned off. Allow it again in FlowFi on the phone."));
  } else if (scannedAfterPairing && r.lastScanOutcome === "failed") {
    steps.push(step("firstScan", "failed", "The last scan on your phone failed. Open FlowFi and tap Scan now to retry."));
  } else {
    steps.push(step("firstScan", "active", "Waiting for the first scan on your phone."));
  }
  if (steps[5]!.state !== "done") {
    return [...steps, upcoming("candidates")];
  }

  // 7. Candidates — only real documents count.
  if (input.candidateCount > 0) {
    steps.push(step("candidates", "done", `${input.candidateCount} candidate${input.candidateCount === 1 ? "" : "s"} waiting for your review.`));
  } else if (r.lastUploadOutcome === "failed" && r.lastUploadAt !== null && (pairedAt === null || r.lastUploadAt >= pairedAt)) {
    steps.push(step("candidates", "failed", "Your phone couldn't upload its latest candidates. It retries on the next scan; nothing was lost on the phone."));
  } else {
    steps.push(step("candidates", "active", "Scan finished with no new eligible bank alerts yet. New ones appear here automatically for review."));
  }
  return steps;
}

export function deriveSetupProgress(input: SetupInput): SetupProgress {
  const device = input.device;
  const paired = isActivelyPaired(device, input.config);
  const steps = paired && device ? pairedSteps(input, device) : pairingSteps(input);
  const firstOpen = steps.findIndex((s) => s.state !== "done");
  const currentIndex = firstOpen === -1 ? steps.length : firstOpen;

  const report = paired && device ? reportAfterPairing(input.status, device.pairedAt) : null;
  const staleReport = report?.reportedAt != null && input.now - report.reportedAt > STALE_REPORT_MS;

  let phase: SetupPhase;
  if (input.suspended) phase = "suspended";
  else if (!paired) phase = "pairing";
  else if (currentIndex >= steps.length || (steps[5]?.state === "done" && steps[6]?.state === "active")) phase = "complete";
  else phase = "setup";

  return {
    phase,
    steps,
    currentIndex,
    paired,
    staleReport,
    pendingNotOwnedCount: report?.pendingNotOwnedCount ?? 0,
  };
}

/** "just now", "4 min ago", "2 h ago", "3 days ago". */
export function formatRelative(at: number, now: number): string {
  const diff = Math.max(0, now - at);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/** "9:42" countdown to a deadline, floored at 0:00. */
export function formatCountdown(deadline: number, now: number): string {
  const total = Math.max(0, Math.ceil((deadline - now) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
