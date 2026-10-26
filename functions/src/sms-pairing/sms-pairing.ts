/**
 * SMS Sync device pairing — the trusted half of "scan a QR on FlowFi Web,
 * approve on the phone, uploads switch on".
 *
 * Why this lives server-side: `users/{uid}/smsSyncConfig/backgroundUpload`
 * (the Phase F3 switch Android reads, fail-closed, before any background
 * upload) is denied to every client by firestore.rules. Pairing is the ONLY
 * path besides an operator that may write it, and it does so only after:
 *
 *   1. the signed-in WEB user created a short-lived session (this module
 *      returns the one-time token exactly once; only its SHA-256 is stored,
 *      and that hash IS the session document id — so the token can't be
 *      recovered from Firestore by anyone, including the owner),
 *   2. an authenticated client presenting that token is signed in to the
 *      SAME uid that created it (a different account is rejected and the
 *      attempt is recorded on the session for the web to show),
 *   3. that client explicitly approves (a separate call from `preview`),
 *   4. the session is unexpired and has never been approved/canceled/
 *      superseded (single use — approval flips it inside a transaction),
 *   5. neither the operator's global kill switch (`smsSyncControl/global`)
 *      nor a per-account operator hold
 *      (`users/{uid}/smsSyncConfig/operatorHold`) is set. Pairing can never
 *      override either: they are separate documents this module only reads.
 *
 * One active uploading device per account (unchanged F3 semantics): pairing
 * a new phone points `backgroundUpload.deviceId` at it, which fails the old
 * phone's gate closed on its next scan, and marks the old device `replaced`.
 *
 * Plain, directly testable module — no `firebase-functions` imports, same
 * convention as src/ingestion/*. Never logs the token.
 */

import { createHash, randomBytes } from "node:crypto";
import { FieldValue, Timestamp, type DocumentReference, type Firestore } from "firebase-admin/firestore";
import { checkAndRecordAttempt, type RateLimitConfig } from "../ingestion/rate-limit";

export const SMS_PAIRING_TTL_MS = 10 * 60 * 1000;
/** Pairing sessions are short-lived bookkeeping; this is a hint for an optional Firestore TTL policy. */
export const SMS_PAIRING_PURGE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export const SMS_PAIRING_CREATE_RATE_LIMIT: RateLimitConfig = { maxAttempts: 20, windowMs: 60 * 60 * 1000 };
export const SMS_PAIRING_CLAIM_RATE_LIMIT: RateLimitConfig = { maxAttempts: 30, windowMs: 15 * 60 * 1000 };
export const SMS_PAIRING_CREATE_RATE_NAMESPACE = "smsPairingCreate";
export const SMS_PAIRING_CLAIM_RATE_NAMESPACE = "smsPairingClaim";

export const SMS_PAIRING_SESSIONS = "smsPairingSessions";
export const SMS_SYNC_CONTROL = "smsSyncControl";
export const SMS_SYNC_CONTROL_GLOBAL_DOC = "global";
export const SMS_BACKGROUND_UPLOAD_DOC = "backgroundUpload";
export const SMS_OPERATOR_HOLD_DOC = "operatorHold";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** Android's install id is `Uuid().v4()` (sms_background_upload_switch.dart) — never a hardware identifier. */
const DEVICE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LABEL_LENGTH = 60;
const MAX_APP_VERSION_LENGTH = 32;

export type SmsPairingSessionStatus = "pending" | "opened" | "approved" | "canceled" | "superseded";
export type SmsDeviceStatus = "active" | "revoked" | "replaced";

export type SmsPairingErrorCode =
  | "invalid"
  | "expired"
  | "used"
  | "canceled"
  | "superseded"
  | "wrong_account"
  | "sync_suspended"
  | "rate_limited"
  | "invalid_device"
  | "not_found";

/** Every refusal is one of these codes. `index.ts` turns it into an HttpsError whose `details.reason` is the code. */
export class SmsPairingError extends Error {
  constructor(readonly code: SmsPairingErrorCode) {
    super(`SMS pairing refused: ${code}`);
    this.name = "SmsPairingError";
  }
}

interface SessionDoc {
  uid: string;
  status: SmsPairingSessionStatus;
  createdAt: Timestamp;
  expiresAt: Timestamp;
  deviceId?: string;
}

interface DeviceInput {
  deviceId: unknown;
  deviceLabel?: unknown;
  appVersion?: unknown;
}

interface ValidDevice {
  deviceId: string;
  label: string;
  appVersion: string | null;
}

export function hashPairingToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function sessionIdForToken(token: unknown): string {
  if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) throw new SmsPairingError("invalid");
  return hashPairingToken(token);
}

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  // Strip control characters; a label is shown verbatim on Web.
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
  return cleaned.length > 0 ? cleaned : null;
}

export function validateDevice(input: DeviceInput): ValidDevice {
  if (typeof input.deviceId !== "string" || !DEVICE_ID_PATTERN.test(input.deviceId)) throw new SmsPairingError("invalid_device");
  return {
    deviceId: input.deviceId.toLowerCase(),
    label: cleanText(input.deviceLabel, MAX_LABEL_LENGTH) ?? "Android phone",
    appVersion: cleanText(input.appVersion, MAX_APP_VERSION_LENGTH),
  };
}

const sessionRef = (db: Firestore, sessionId: string) => db.collection(SMS_PAIRING_SESSIONS).doc(sessionId);
const configRef = (db: Firestore, uid: string, docId: string) => db.collection("users").doc(uid).collection("smsSyncConfig").doc(docId);
const deviceRef = (db: Firestore, uid: string, deviceId: string) => db.collection("users").doc(uid).collection("smsDevices").doc(deviceId);
const globalControlRef = (db: Firestore) => db.collection(SMS_SYNC_CONTROL).doc(SMS_SYNC_CONTROL_GLOBAL_DOC);

/** Either operator switch set means no pairing and no upload. Read failures propagate (fail closed). */
async function isSuspended(read: (ref: DocumentReference) => Promise<FirebaseFirestore.DocumentSnapshot>, db: Firestore, uid: string) {
  const [global, hold] = await Promise.all([read(globalControlRef(db)), read(configRef(db, uid, SMS_OPERATOR_HOLD_DOC))]);
  return global.get("uploadsDisabled") === true || hold.get("disabled") === true;
}

async function enforceRateLimit(db: Firestore, namespace: string, uid: string, config: RateLimitConfig) {
  const check = await checkAndRecordAttempt(db, namespace, uid, config);
  if (!check.allowed) throw new SmsPairingError("rate_limited");
}

// ── Create (Web) ──

export interface CreatedPairingSession {
  sessionId: string;
  /** Returned exactly once. Never stored, never logged. */
  token: string;
  expiresAt: number;
}

/**
 * Starts a new pairing session for the signed-in web user. Any of their
 * still-open sessions are marked `superseded`, so at most one QR code per
 * account can ever be claimed.
 */
export async function createPairingSession(db: Firestore, input: { uid: string; now?: Date }): Promise<CreatedPairingSession> {
  const now = input.now ?? new Date();
  await enforceRateLimit(db, SMS_PAIRING_CREATE_RATE_NAMESPACE, input.uid, SMS_PAIRING_CREATE_RATE_LIMIT);
  if (await isSuspended((ref) => ref.get(), db, input.uid)) throw new SmsPairingError("sync_suspended");

  const token = randomBytes(32).toString("base64url");
  const sessionId = hashPairingToken(token);
  const expiresAt = new Date(now.getTime() + SMS_PAIRING_TTL_MS);

  const open = await db.collection(SMS_PAIRING_SESSIONS).where("uid", "==", input.uid).where("status", "in", ["pending", "opened"]).get();
  const batch = db.batch();
  for (const doc of open.docs) {
    batch.update(doc.ref, { status: "superseded", supersededAt: Timestamp.fromDate(now) });
  }
  batch.create(sessionRef(db, sessionId), {
    uid: input.uid,
    status: "pending" satisfies SmsPairingSessionStatus,
    createdAt: Timestamp.fromDate(now),
    expiresAt: Timestamp.fromDate(expiresAt),
    purgeAt: Timestamp.fromDate(new Date(now.getTime() + SMS_PAIRING_PURGE_AFTER_MS)),
    rejectedAttempts: 0,
  });
  await batch.commit();

  return { sessionId, token, expiresAt: expiresAt.getTime() };
}

// ── Shared claim validation (Android) ──

type ClaimCheck = { ok: true; session: SessionDoc } | { ok: false; code: SmsPairingErrorCode; recordRejection?: boolean };

function checkClaim(snapshot: FirebaseFirestore.DocumentSnapshot, uid: string, now: Date): ClaimCheck {
  if (!snapshot.exists) return { ok: false, code: "invalid" };
  const session = snapshot.data() as SessionDoc;
  if (session.uid !== uid) return { ok: false, code: "wrong_account", recordRejection: true };
  if (session.status === "approved") return { ok: false, code: "used" };
  if (session.status === "canceled") return { ok: false, code: "canceled" };
  if (session.status === "superseded") return { ok: false, code: "superseded" };
  if (session.expiresAt.toMillis() <= now.getTime()) return { ok: false, code: "expired" };
  return { ok: true, session };
}

/**
 * A different account presented this account's QR. The attempt is recorded
 * (count + time + reason only — nothing about the other account) so the web
 * page can tell its owner, but the session stays claimable by the right
 * account until it expires.
 */
function rejectionUpdate(now: Date) {
  return { rejectedAttempts: FieldValue.increment(1), lastRejection: { reason: "wrong_account", at: Timestamp.fromDate(now) } };
}

export interface ActiveDeviceSummary {
  deviceId: string;
  label: string;
  pairedAt: number | null;
  isThisDevice: boolean;
}

async function readActiveDevice(db: Firestore, uid: string, thisDeviceId: string | null): Promise<ActiveDeviceSummary | null> {
  const config = await configRef(db, uid, SMS_BACKGROUND_UPLOAD_DOC).get();
  const activeId = config.get("enabled") === true ? config.get("deviceId") : null;
  if (typeof activeId !== "string" || !activeId) return null;
  const device = await deviceRef(db, uid, activeId).get();
  const pairedAt = device.get("pairedAt");
  return {
    deviceId: activeId,
    label: typeof device.get("label") === "string" ? device.get("label") : "Another phone",
    pairedAt: pairedAt instanceof Timestamp ? pairedAt.toMillis() : null,
    isThisDevice: thisDeviceId !== null && activeId === thisDeviceId,
  };
}

// ── Preview (Android, before the approval screen) ──

export interface PairingPreview {
  expiresAt: number;
  createdAt: number;
  /** The phone currently allowed to upload for this account, if any — so the approval screen can say "this replaces …". */
  activeDevice: ActiveDeviceSummary | null;
}

/**
 * Validates a scanned token for the signed-in phone user WITHOUT pairing.
 * The first successful preview marks the session `opened` — the web's
 * evidence that the FlowFi app (an authenticated client holding the token)
 * actually reached this step, rather than inferring it from the QR scan.
 */
export async function previewPairing(db: Firestore, input: { uid: string; token: unknown; deviceId?: unknown; now?: Date }): Promise<PairingPreview> {
  const now = input.now ?? new Date();
  const sessionId = sessionIdForToken(input.token);
  const thisDeviceId = input.deviceId === undefined ? null : validateDevice({ deviceId: input.deviceId }).deviceId;
  await enforceRateLimit(db, SMS_PAIRING_CLAIM_RATE_NAMESPACE, input.uid, SMS_PAIRING_CLAIM_RATE_LIMIT);

  const ref = sessionRef(db, sessionId);
  const outcome = await db.runTransaction(async (tx) => {
    const check = checkClaim(await tx.get(ref), input.uid, now);
    if (!check.ok) {
      if (check.recordRejection) tx.update(ref, rejectionUpdate(now));
      return check;
    }
    if (check.session.status === "pending") tx.update(ref, { status: "opened", openedAt: Timestamp.fromDate(now) });
    return check;
  });
  if (!outcome.ok) throw new SmsPairingError(outcome.code);
  if (await isSuspended((r) => r.get(), db, input.uid)) throw new SmsPairingError("sync_suspended");

  return {
    expiresAt: outcome.session.expiresAt.toMillis(),
    createdAt: outcome.session.createdAt.toMillis(),
    activeDevice: await readActiveDevice(db, input.uid, thisDeviceId),
  };
}

// ── Approve (Android, explicit user action) ──

export interface PairingApproval {
  status: "paired";
  deviceId: string;
  /** True when this exact device already approved this exact session (a retried request). Nothing was written. */
  alreadyPaired: boolean;
  /** Label of the device that stopped being the uploader because this one replaced it. */
  replacedDeviceLabel: string | null;
}

export async function approvePairing(
  db: Firestore,
  input: { uid: string; token: unknown; now?: Date } & DeviceInput,
): Promise<PairingApproval> {
  const now = input.now ?? new Date();
  const sessionId = sessionIdForToken(input.token);
  const device = validateDevice(input);
  await enforceRateLimit(db, SMS_PAIRING_CLAIM_RATE_NAMESPACE, input.uid, SMS_PAIRING_CLAIM_RATE_LIMIT);

  const ref = sessionRef(db, sessionId);
  type Outcome = { ok: false; code: SmsPairingErrorCode } | { ok: true; result: PairingApproval };

  const outcome = await db.runTransaction<Outcome>(async (tx) => {
    // Every read precedes every write (Firestore transaction rule).
    const sessionSnap = await tx.get(ref);
    const check = checkClaim(sessionSnap, input.uid, now);
    if (!check.ok) {
      const existing = sessionSnap.exists ? (sessionSnap.data() as SessionDoc) : null;
      // A retried approval from the same device for the same account is success, not "used".
      if (check.code === "used" && existing?.deviceId === device.deviceId) {
        return { ok: true, result: { status: "paired", deviceId: device.deviceId, alreadyPaired: true, replacedDeviceLabel: null } };
      }
      if (check.recordRejection) tx.update(ref, rejectionUpdate(now));
      return { ok: false, code: check.code };
    }

    if (await isSuspended((r) => tx.get(r), db, input.uid)) return { ok: false, code: "sync_suspended" };

    const uploadRef = configRef(db, input.uid, SMS_BACKGROUND_UPLOAD_DOC);
    const uploadSnap = await tx.get(uploadRef);
    const previousId = uploadSnap.get("deviceId");
    const replacing = typeof previousId === "string" && previousId !== "" && previousId !== device.deviceId ? previousId : null;
    const previousDeviceSnap = replacing ? await tx.get(deviceRef(db, input.uid, replacing)) : null;

    const at = Timestamp.fromDate(now);
    tx.update(ref, { status: "approved", approvedAt: at, deviceId: device.deviceId, deviceLabel: device.label });

    if (previousDeviceSnap?.exists) {
      tx.update(previousDeviceSnap.ref, { status: "replaced" satisfies SmsDeviceStatus, replacedAt: at, replacedBy: device.deviceId, updatedAt: at });
    }

    tx.set(deviceRef(db, input.uid, device.deviceId), {
      deviceId: device.deviceId,
      platform: "android",
      label: device.label,
      appVersion: device.appVersion,
      status: "active" satisfies SmsDeviceStatus,
      pairedAt: at,
      pairedSessionId: sessionId,
      updatedAt: at,
    });

    tx.set(uploadRef, {
      enabled: true,
      deviceId: device.deviceId,
      source: "pairing",
      pairedSessionId: sessionId,
      updatedAt: at,
    });

    const replacedLabel = previousDeviceSnap?.exists ? (previousDeviceSnap.get("label") as string | undefined) ?? "Another phone" : replacing ? "Another phone" : null;
    return { ok: true, result: { status: "paired", deviceId: device.deviceId, alreadyPaired: false, replacedDeviceLabel: replacedLabel } };
  });

  if (!outcome.ok) throw new SmsPairingError(outcome.code);
  return outcome.result;
}

// ── Cancel (Android "Not now", or Web closing the QR) ──

/**
 * Cancels an open session the caller owns. Accepts the token (phone) or the
 * session id (web). A session the caller doesn't own reads as `invalid`, so
 * this can't be used to probe other accounts' sessions. Idempotent.
 */
export async function cancelPairing(
  db: Firestore,
  input: { uid: string; token?: unknown; sessionId?: unknown; by: "phone" | "web"; now?: Date },
): Promise<{ status: "canceled" | SmsPairingSessionStatus }> {
  const now = input.now ?? new Date();
  let sessionId: string;
  if (input.token !== undefined) {
    sessionId = sessionIdForToken(input.token);
  } else if (typeof input.sessionId === "string" && /^[0-9a-f]{64}$/.test(input.sessionId)) {
    sessionId = input.sessionId;
  } else {
    throw new SmsPairingError("invalid");
  }

  const ref = sessionRef(db, sessionId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.get("uid") !== input.uid) throw new SmsPairingError("invalid");
    const status = snap.get("status") as SmsPairingSessionStatus;
    if (status !== "pending" && status !== "opened") return { status };
    tx.update(ref, { status: "canceled", canceledAt: Timestamp.fromDate(now), canceledBy: input.by });
    return { status: "canceled" as const };
  });
}

// ── Revoke (user-initiated disconnect, from Web or the phone itself) ──

/**
 * Disconnects one of the caller's own devices. If it is the active uploader,
 * `backgroundUpload.enabled` becomes false — the phone's F3 gate then fails
 * closed on its next scan. Candidates already uploaded are untouched.
 */
export async function revokeDevice(db: Firestore, input: { uid: string; deviceId: unknown; now?: Date }): Promise<{ status: "revoked"; uploadsStopped: boolean }> {
  const now = input.now ?? new Date();
  const { deviceId } = validateDevice({ deviceId: input.deviceId });
  const devRef = deviceRef(db, input.uid, deviceId);
  const uploadRef = configRef(db, input.uid, SMS_BACKGROUND_UPLOAD_DOC);

  return db.runTransaction(async (tx) => {
    const [devSnap, uploadSnap] = await Promise.all([tx.get(devRef), tx.get(uploadRef)]);
    if (!devSnap.exists) throw new SmsPairingError("not_found");
    const at = Timestamp.fromDate(now);
    tx.update(devRef, { status: "revoked" satisfies SmsDeviceStatus, revokedAt: at, revokedBy: "user", updatedAt: at });
    const isUploader = uploadSnap.get("deviceId") === deviceId;
    if (isUploader) {
      tx.update(uploadRef, { enabled: false, disabledReason: "device_revoked", updatedAt: at });
    }
    return { status: "revoked" as const, uploadsStopped: isUploader };
  });
}
