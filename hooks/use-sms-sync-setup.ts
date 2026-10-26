"use client";

/**
 * Live state for the SMS Sync setup journey (features/transaction-candidates/components/sms-setup-journey.tsx).
 *
 * Listens to the five records the journey is derived from — the F3 upload switch, the operator's global switch,
 * the paired device, that device's self-reported status, and the current pairing session — and folds them through
 * {@link deriveSetupProgress}. All of them are written by the pairing Cloud Functions, an operator, or (status only)
 * the paired phone under strict rules; the web only reads, plus the create/cancel/revoke callables.
 *
 * A pairing session is created automatically the first time an unpaired user sees the journey, and again only when
 * they ask (an expired code waits for "New code" rather than regenerating forever in a background tab). Leaving the
 * page cancels an open session so its QR stops working before it would have expired.
 */

import { collection, doc, onSnapshot, Timestamp, type DocumentSnapshot } from "firebase/firestore";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { db } from "@/lib/firebase/client";
import { FirestoreCollections, GlobalFirestoreCollections } from "@/lib/firestore/collections";
import { pickPresence, summarizePresence, type DevicePresenceView, type PresenceSummary } from "@/lib/sms-pairing/device-presence";
import {
  deriveSetupProgress,
  isSessionExpired,
  type PairingFailureReason,
  type PairingSessionView,
  type SetupProgress,
  type SmsDeviceStatusView,
  type SmsDeviceView,
  type UploadConfigView,
} from "@/lib/sms-pairing/setup-progress";
import {
  buildPairingUrl,
  cancelSmsPairingSession,
  createSmsPairingSession,
  revokeSmsDevice,
  SmsPairingRequestError,
} from "@/services/sms-pairing/sms-pairing-service";
import { useAuthStore } from "@/store/auth-store";

const BACKGROUND_UPLOAD_DOC_ID = "backgroundUpload";
const GLOBAL_CONTROL_DOC_ID = "global";

const ms = (value: unknown): number | null => (value instanceof Timestamp ? value.toMillis() : null);
const str = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
const int = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

function toSession(snap: DocumentSnapshot): PairingSessionView | null {
  if (!snap.exists()) return null;
  const d = snap.data();
  return {
    status: d.status,
    createdAt: ms(d.createdAt) ?? 0,
    expiresAt: ms(d.expiresAt) ?? 0,
    openedAt: ms(d.openedAt),
    approvedAt: ms(d.approvedAt),
    deviceId: str(d.deviceId),
    canceledBy: d.canceledBy === "phone" || d.canceledBy === "web" ? d.canceledBy : null,
    rejectedAttempts: int(d.rejectedAttempts),
  };
}

function toDevice(snap: DocumentSnapshot): SmsDeviceView | null {
  if (!snap.exists()) return null;
  const d = snap.data();
  return { deviceId: snap.id, label: str(d.label) ?? "Android phone", status: d.status, pairedAt: ms(d.pairedAt) };
}

function toStatus(snap: DocumentSnapshot): SmsDeviceStatusView | null {
  if (!snap.exists()) return null;
  const d = snap.data();
  return {
    smsPermission: d.smsPermission ?? "unknown",
    autoSyncEnabled: d.autoSyncEnabled === true,
    cloudSync: d.cloudSync ?? null,
    lastScanAt: ms(d.lastScanAt),
    lastScanOutcome: d.lastScanOutcome ?? null,
    lastUploadAt: ms(d.lastUploadAt),
    lastUploadOutcome: d.lastUploadOutcome ?? null,
    lastUploadedCount: int(d.lastUploadedCount),
    pendingNotOwnedCount: int(d.pendingNotOwnedCount),
    reportedAt: ms(d.reportedAt),
  };
}

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(value as T) ? (value as T) : fallback);

function toPresence(snap: DocumentSnapshot): DevicePresenceView | null {
  if (!snap.exists()) return null;
  const d = snap.data();
  return {
    deviceId: snap.id,
    label: str(d.label) ?? "Android phone",
    appVersion: str(d.appVersion),
    appState: d.appState === "foreground" ? "foreground" : "background",
    smsPermission: oneOf(d.smsPermission, ["granted", "denied", "permanentlyDenied", "unsupported", "unknown"] as const, "unknown"),
    notificationAccess: oneOf(d.notificationAccess, ["granted", "denied", "unsupported", "unknown"] as const, "unknown"),
    autoSyncEnabled: d.autoSyncEnabled === true,
    syncPhase: oneOf(d.syncPhase, ["idle", "scanning", "uploading", "done", "failed"] as const, "idle"),
    syncTotal: typeof d.syncTotal === "number" ? d.syncTotal : null,
    syncDone: int(d.syncDone),
    syncUploaded: int(d.syncUploaded),
    syncSkipped: int(d.syncSkipped),
    syncFailed: int(d.syncFailed),
    syncUpdatedAt: ms(d.syncUpdatedAt),
    lastSyncAt: ms(d.lastSyncAt),
    heartbeatAt: ms(d.heartbeatAt),
  };
}

/** Every install's live heartbeat for this account (usually one). */
function usePresenceList(uid: string | undefined) {
  const [state, setState] = useState<{ uid: string | null; list: DevicePresenceView[] }>({ uid: null, list: [] });
  useEffect(() => {
    if (!uid) return;
    return onSnapshot(
      collection(db, FirestoreCollections.users, uid, FirestoreCollections.smsDevicePresence),
      (snap) => setState({ uid, list: snap.docs.map(toPresence).filter((p): p is DevicePresenceView => p !== null) }),
      () => setState({ uid, list: [] }),
    );
  }, [uid]);
  return uid && state.uid === uid ? state.list : [];
}

function toUploadConfig(snap: DocumentSnapshot): UploadConfigView | null {
  return snap.exists() ? { enabled: snap.data().enabled === true, deviceId: str(snap.data().deviceId) } : null;
}

function toSuspended(snap: DocumentSnapshot): boolean {
  return snap.exists() && snap.data().uploadsDisabled === true;
}

/** One document listener keyed by path. `map` must be a stable (module-level) function. `value` is null when missing or unreadable. */
function useDocument<T>(path: string[] | null, map: (snap: DocumentSnapshot) => T | null) {
  const key = path?.join("/") ?? null;
  const [state, setState] = useState<{ key: string | null; value: T | null; fromCache: boolean; error: boolean }>({ key: null, value: null, fromCache: false, error: false });

  useEffect(() => {
    if (!key) return;
    const [first, ...rest] = key.split("/");
    return onSnapshot(
      doc(db, first!, ...rest),
      { includeMetadataChanges: true },
      (snap) => setState({ key, value: map(snap), fromCache: snap.metadata.fromCache, error: false }),
      () => setState({ key, value: null, fromCache: false, error: true }),
    );
  }, [key, map]);

  const current = key !== null && state.key === key;
  return { loaded: current, value: current ? state.value : null, fromCache: current && state.fromCache, error: current && state.error };
}

function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return online;
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export interface SmsSyncSetup {
  /** The upload switch and global switch have both answered (or failed). */
  loaded: boolean;
  progress: SetupProgress;
  /** `backgroundUpload` is on but names a device with no pairing record — an operator activation from before pairing existed. */
  legacyConfigured: boolean;
  /** An active paired device is the one the upload switch names. */
  hasPairedDevice: boolean;
  /** The user asked to pair a different phone while one is already paired. */
  pairingAnother: boolean;
  session: PairingSessionView | null;
  device: SmsDeviceView | null;
  status: SmsDeviceStatusView | null;
  /** The phone's live heartbeat (before or after pairing), or null when no install has reported. */
  presence: DevicePresenceView | null;
  presenceSummary: PresenceSummary | null;
  pairingUrl: string | null;
  creating: boolean;
  createError: PairingFailureReason | null;
  online: boolean;
  /** Showing data from the local cache because the server can't be reached. */
  fromCache: boolean;
  now: number;
  newCode: () => void;
  pairAnother: () => void;
  stopPairingAnother: () => void;
  disconnect: () => Promise<{ ok: true } | { ok: false; reason: PairingFailureReason }>;
}

/** `autoPair: false` only watches (status bar above a non-empty inbox) — it never creates a pairing session by itself. */
export function useSmsSyncSetup({ candidateCount = 0, autoPair = true }: { candidateCount?: number; autoPair?: boolean } = {}): SmsSyncSetup {
  const uid = useAuthStore((s) => s.user?.uid);
  const online = useOnline();

  const config = useDocument<UploadConfigView>(
    uid ? [FirestoreCollections.users, uid, FirestoreCollections.smsSyncConfig, BACKGROUND_UPLOAD_DOC_ID] : null,
    toUploadConfig,
  );
  const control = useDocument<boolean>(uid ? [GlobalFirestoreCollections.smsSyncControl, GLOBAL_CONTROL_DOC_ID] : null, toSuspended);

  const deviceId = config.value?.deviceId ?? null;
  const device = useDocument<SmsDeviceView>(uid && deviceId ? [FirestoreCollections.users, uid, FirestoreCollections.smsDevices, deviceId] : null, toDevice);
  const status = useDocument<SmsDeviceStatusView>(
    uid && deviceId ? [FirestoreCollections.users, uid, FirestoreCollections.smsDeviceStatus, deviceId] : null,
    toStatus,
  );

  const presenceList = usePresenceList(uid);

  // The live session. The token exists only here (and in the QR); a reload simply starts a new session.
  const [pairing, setPairing] = useState<{ uid: string; sessionId: string; token: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<PairingFailureReason | null>(null);
  const [pairingAnother, setPairingAnother] = useState(false);
  const autoStarted = useRef<string | null>(null);
  const activePairing = pairing && pairing.uid === uid ? pairing : null;
  const session = useDocument<PairingSessionView>(activePairing ? [GlobalFirestoreCollections.smsPairingSessions, activePairing.sessionId] : null, toSession);

  const sessionOpen = session.value !== null && (session.value.status === "pending" || session.value.status === "opened");
  const now = useNow(sessionOpen ? 1000 : 15_000);

  const create = useCallback(async () => {
    setCreating(true);
    setCreateError(null);
    try {
      const created = await createSmsPairingSession();
      if (uid) setPairing({ uid, sessionId: created.sessionId, token: created.token });
    } catch (error) {
      setCreateError(error instanceof SmsPairingRequestError ? error.reason : "unknown");
    } finally {
      setCreating(false);
    }
  }, [uid]);

  const loaded = config.loaded && control.loaded && (!deviceId || device.loaded);
  const legacyConfigured = loaded && config.value?.enabled === true && deviceId !== null && device.value === null;
  const suspended = control.value === true;
  const devicePaired = device.value?.status === "active" && config.value?.enabled === true && config.value.deviceId === device.value.deviceId;

  // A new phone approved the "pair another" session: the switch now names it, so that mode is over.
  const approvedNewDevice = pairingAnother && session.value?.status === "approved" && session.value.deviceId === deviceId && devicePaired;
  if (approvedNewDevice) setPairingAnother(false);

  // The phone was unpaired (Auto Sync OFF / Disconnect): offer one fresh code instead of a dead "No active code".
  const wasPaired = useRef(false);
  useEffect(() => {
    if (wasPaired.current && !devicePaired && loaded) {
      autoStarted.current = null;
      setPairing(null);
      setCreateError(null);
    }
    if (loaded) wasPaired.current = devicePaired;
  }, [devicePaired, loaded]);

  // Auto-start one session per signed-in user when they need to pair.
  const needsPairing = autoPair && loaded && !suspended && !legacyConfigured && (!devicePaired || pairingAnother);
  useEffect(() => {
    if (!uid || !needsPairing || activePairing || creating || createError || !online) return;
    if (autoStarted.current === uid && !pairingAnother) return;
    autoStarted.current = uid;
    void create();
  }, [uid, needsPairing, activePairing, creating, createError, online, pairingAnother, create]);

  // Leaving the page (or switching user) cancels a still-open code — best effort.
  const openSessionRef = useRef<string | null>(null);
  const openSessionId = sessionOpen && activePairing ? activePairing.sessionId : null;
  useEffect(() => {
    openSessionRef.current = openSessionId;
  }, [openSessionId]);
  useEffect(
    () => () => {
      if (openSessionRef.current) void cancelSmsPairingSession(openSessionRef.current).catch(() => undefined);
    },
    [uid],
  );

  const newCode = useCallback(() => {
    if (openSessionRef.current) void cancelSmsPairingSession(openSessionRef.current).catch(() => undefined);
    setPairing(null);
    void create();
  }, [create]);

  const pairAnother = useCallback(() => {
    setPairingAnother(true);
    setPairing(null);
    setCreateError(null);
  }, []);

  const stopPairingAnother = useCallback(() => {
    if (openSessionRef.current) void cancelSmsPairingSession(openSessionRef.current).catch(() => undefined);
    setPairingAnother(false);
    setPairing(null);
  }, []);

  const disconnect = useCallback(async () => {
    if (!deviceId) return { ok: false as const, reason: "unknown" as PairingFailureReason };
    try {
      await revokeSmsDevice(deviceId);
      return { ok: true as const };
    } catch (error) {
      return { ok: false as const, reason: error instanceof SmsPairingRequestError ? error.reason : ("unknown" as PairingFailureReason) };
    }
  }, [deviceId]);

  // "Pair another phone" shows the pairing steps for the new session, not the current phone's progress.
  const showPairing = pairingAnother && !approvedNewDevice;
  const progress = useMemo(
    () =>
      deriveSetupProgress({
        creating,
        createError,
        session: session.value,
        device: showPairing ? null : device.value,
        status: showPairing ? null : status.value,
        config: showPairing ? null : config.value,
        candidateCount,
        suspended,
        now,
      }),
    [creating, createError, session.value, showPairing, device.value, status.value, config.value, candidateCount, suspended, now],
  );

  const presence = useMemo(() => pickPresence(presenceList, deviceId), [presenceList, deviceId]);
  const presenceSummary = presence ? summarizePresence(presence, now) : null;

  const sessionUsable = session.value !== null && sessionOpen && !isSessionExpired(session.value, now);
  const pairingUrl = activePairing && sessionUsable && typeof window !== "undefined" ? buildPairingUrl(activePairing.token, window.location.origin) : null;

  return {
    loaded,
    progress,
    legacyConfigured,
    hasPairedDevice: devicePaired,
    pairingAnother: showPairing,
    session: session.value,
    device: device.value,
    status: status.value,
    presence,
    presenceSummary,
    pairingUrl,
    creating,
    createError,
    online,
    fromCache: config.fromCache || status.fromCache,
    now,
    newCode,
    pairAnother,
    stopPairingAnother,
    disconnect,
  };
}
