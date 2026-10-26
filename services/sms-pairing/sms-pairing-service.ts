/**
 * Web client for the SMS Sync pairing Cloud Functions (functions/src/sms-pairing).
 * The one-time token returned by `createSmsPairingSession` only ever lives in
 * memory and in the QR code — it is never persisted, logged or sent anywhere else.
 */

import { httpsCallable } from "firebase/functions";
import { functions } from "@/lib/firebase/client";
import type { PairingFailureReason } from "@/lib/sms-pairing/setup-progress";

export interface CreatedPairingSession {
  sessionId: string;
  token: string;
  expiresAt: number;
}

/** A refusal or failure from a pairing callable, reduced to a stable reason code. */
export class SmsPairingRequestError extends Error {
  constructor(readonly reason: PairingFailureReason) {
    super(`SMS pairing request failed: ${reason}`);
    this.name = "SmsPairingRequestError";
  }
}

export function pairingFailureReason(error: unknown): PairingFailureReason {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return "offline";
  const e = error as { code?: unknown; details?: { reason?: unknown } } | null;
  if (e && typeof e.details?.reason === "string") return e.details.reason;
  if (e?.code === "functions/unauthenticated") return "unauthenticated";
  if (e?.code === "functions/unavailable" || e?.code === "functions/deadline-exceeded") return "offline";
  return "unknown";
}

async function call<Req, Res>(name: string, data: Req): Promise<Res> {
  try {
    const result = await httpsCallable<Req, Res>(functions, name)(data);
    return result.data;
  } catch (error) {
    throw new SmsPairingRequestError(pairingFailureReason(error));
  }
}

export function createSmsPairingSession(): Promise<CreatedPairingSession> {
  return call<Record<string, never>, CreatedPairingSession>("createSmsPairingSessionCallable", {});
}

/** Best-effort: closing the QR makes it unclaimable before it would expire on its own. */
export function cancelSmsPairingSession(sessionId: string): Promise<{ status: string }> {
  return call<{ sessionId: string }, { status: string }>("cancelSmsPairingCallable", { sessionId });
}

export function revokeSmsDevice(deviceId: string): Promise<{ status: "revoked"; uploadsStopped: boolean }> {
  return call<{ deviceId: string }, { status: "revoked"; uploadsStopped: boolean }>("revokeSmsDeviceCallable", { deviceId });
}

/**
 * The link the QR encodes. It opens the `/pair` landing page on the phone, which hands the token to the FlowFi app.
 * `NEXT_PUBLIC_SMS_PAIRING_BASE_URL` overrides the origin (e.g. a LAN address when testing from `next dev`).
 */
export function buildPairingUrl(token: string, origin: string): string {
  const base = (process.env.NEXT_PUBLIC_SMS_PAIRING_BASE_URL || origin).replace(/\/+$/, "");
  return `${base}/pair/?t=${encodeURIComponent(token)}`;
}
