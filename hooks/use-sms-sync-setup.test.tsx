// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { Timestamp } from "firebase/firestore";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthStore } from "@/store/auth-store";
import { useSmsSyncSetup } from "./use-sms-sync-setup";

vi.mock("@/lib/firebase/client", () => ({ db: {}, functions: {} }));

type Listener = { next: (snap: unknown) => void; error: (e: Error) => void };
const listeners = new Map<string, Listener>();
vi.mock("firebase/firestore", async () => {
  const actual = await vi.importActual<typeof import("firebase/firestore")>("firebase/firestore");
  return {
    ...actual,
    doc: vi.fn((_db: unknown, ...segments: string[]) => ({ path: segments.join("/") })),
    collection: vi.fn((_db: unknown, ...segments: string[]) => ({ path: segments.join("/") })),
    onSnapshot: vi.fn((ref: { path: string }, ...args: unknown[]) => {
      // Document listeners pass options first; the presence collection listener doesn't.
      const [next, error] = (typeof args[0] === "function" ? args : args.slice(1)) as [Listener["next"], Listener["error"]];
      listeners.set(ref.path, { next, error });
      return () => listeners.delete(ref.path);
    }),
  };
});

const service = vi.hoisted(() => ({
  createSmsPairingSession: vi.fn(),
  cancelSmsPairingSession: vi.fn(),
  revokeSmsDevice: vi.fn(),
}));
vi.mock("@/services/sms-pairing/sms-pairing-service", async () => {
  const actual = await vi.importActual<typeof import("@/services/sms-pairing/sms-pairing-service")>("@/services/sms-pairing/sms-pairing-service");
  return { ...actual, ...service };
});

const UID = "user-1";
const DEVICE = "0b5a3f4e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
const SESSION_ID = "a".repeat(64);
const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde";
const CONFIG = `users/${UID}/smsSyncConfig/backgroundUpload`;
const CONTROL = "smsSyncControl/global";

function emit(path: string, data?: Record<string, unknown>) {
  const listener = listeners.get(path);
  if (!listener) throw new Error(`no listener for ${path} (have: ${[...listeners.keys()].join(", ")})`);
  const id = path.split("/").pop();
  act(() => listener.next({ id, exists: () => data !== undefined, data: () => data, metadata: { fromCache: false } }));
}

const ts = (ms: number) => Timestamp.fromMillis(ms);

beforeEach(() => {
  listeners.clear();
  vi.clearAllMocks();
  service.createSmsPairingSession.mockResolvedValue({ sessionId: SESSION_ID, token: TOKEN, expiresAt: Date.now() + 600_000 });
  service.cancelSmsPairingSession.mockResolvedValue({ status: "canceled" });
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  act(() => useAuthStore.setState({ user: { uid: UID } as never, status: "signed-in" }));
});

afterEach(cleanup);

describe("useSmsSyncSetup", () => {
  it("creates exactly one pairing session for an unpaired user and exposes its QR link once the session is live", async () => {
    const { result } = renderHook(() => useSmsSyncSetup());
    emit(CONFIG);
    emit(CONTROL);
    await waitFor(() => expect(service.createSmsPairingSession).toHaveBeenCalledOnce());
    await waitFor(() => expect(listeners.has(`smsPairingSessions/${SESSION_ID}`)).toBe(true));
    expect(result.current.pairingUrl).toBeNull();

    emit(`smsPairingSessions/${SESSION_ID}`, { uid: UID, status: "pending", createdAt: ts(Date.now()), expiresAt: ts(Date.now() + 600_000), rejectedAttempts: 0 });
    expect(result.current.pairingUrl).toBe(`${window.location.origin}/pair/?t=${TOKEN}`);
    expect(result.current.progress.steps[0]!.state).toBe("done");
    expect(service.createSmsPairingSession).toHaveBeenCalledOnce();
  });

  it("never creates a session for an already-paired account, and follows the phone's own reports", async () => {
    const { result } = renderHook(() => useSmsSyncSetup());
    emit(CONFIG, { enabled: true, deviceId: DEVICE });
    emit(CONTROL);
    emit(`users/${UID}/smsDevices/${DEVICE}`, { status: "active", label: "Pixel 8", pairedAt: ts(Date.now() - 60_000) });
    emit(`users/${UID}/smsDeviceStatus/${DEVICE}`, {
      smsPermission: "granted",
      autoSyncEnabled: true,
      cloudSync: "enabled",
      lastScanAt: ts(Date.now() - 1000),
      lastScanOutcome: "ok",
      lastUploadAt: null,
      lastUploadOutcome: null,
      lastUploadedCount: 0,
      pendingNotOwnedCount: 2,
      reportedAt: ts(Date.now() - 500),
    });
    expect(result.current.hasPairedDevice).toBe(true);
    expect(result.current.progress.phase).toBe("complete");
    expect(result.current.progress.pendingNotOwnedCount).toBe(2);
    await new Promise((r) => setTimeout(r, 20));
    expect(service.createSmsPairingSession).not.toHaveBeenCalled();
  });

  it("treats an operator-activated switch with no pairing record as legacy, without creating a session", async () => {
    const { result } = renderHook(() => useSmsSyncSetup());
    emit(CONFIG, { enabled: true, deviceId: DEVICE });
    emit(CONTROL);
    emit(`users/${UID}/smsDevices/${DEVICE}`);
    expect(result.current.legacyConfigured).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(service.createSmsPairingSession).not.toHaveBeenCalled();
  });

  it("doesn't create a session while SMS Sync is suspended", async () => {
    const { result } = renderHook(() => useSmsSyncSetup());
    emit(CONFIG);
    emit(CONTROL, { uploadsDisabled: true });
    expect(result.current.progress.phase).toBe("suspended");
    await new Promise((r) => setTimeout(r, 20));
    expect(service.createSmsPairingSession).not.toHaveBeenCalled();
  });

  it("waits for the browser to come back online before creating a session", async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    const { result } = renderHook(() => useSmsSyncSetup());
    emit(CONFIG);
    emit(CONTROL);
    expect(result.current.online).toBe(false);
    await new Promise((r) => setTimeout(r, 20));
    expect(service.createSmsPairingSession).not.toHaveBeenCalled();

    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    act(() => window.dispatchEvent(new Event("online")));
    await waitFor(() => expect(service.createSmsPairingSession).toHaveBeenCalledOnce());
  });

  it("reports a creation failure without retrying on its own; New code tries again", async () => {
    const { SmsPairingRequestError } = await import("@/services/sms-pairing/sms-pairing-service");
    service.createSmsPairingSession.mockRejectedValueOnce(new SmsPairingRequestError("rate_limited"));
    const { result } = renderHook(() => useSmsSyncSetup());
    emit(CONFIG);
    emit(CONTROL);
    await waitFor(() => expect(result.current.createError).toBe("rate_limited"));
    expect(result.current.progress.steps[0]!.state).toBe("failed");
    await new Promise((r) => setTimeout(r, 20));
    expect(service.createSmsPairingSession).toHaveBeenCalledOnce();

    act(() => result.current.newCode());
    await waitFor(() => expect(service.createSmsPairingSession).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.createError).toBeNull());
  });

  it("cancels a still-open code when the page goes away", async () => {
    const { unmount } = renderHook(() => useSmsSyncSetup());
    emit(CONFIG);
    emit(CONTROL);
    await waitFor(() => expect(listeners.has(`smsPairingSessions/${SESSION_ID}`)).toBe(true));
    emit(`smsPairingSessions/${SESSION_ID}`, { uid: UID, status: "opened", createdAt: ts(Date.now()), expiresAt: ts(Date.now() + 600_000), openedAt: ts(Date.now()) });
    unmount();
    expect(service.cancelSmsPairingSession).toHaveBeenCalledWith(SESSION_ID);
  });

  it("doesn't cancel an approved session on the way out", async () => {
    const { unmount } = renderHook(() => useSmsSyncSetup());
    emit(CONFIG);
    emit(CONTROL);
    await waitFor(() => expect(listeners.has(`smsPairingSessions/${SESSION_ID}`)).toBe(true));
    emit(`smsPairingSessions/${SESSION_ID}`, { uid: UID, status: "approved", createdAt: ts(Date.now()), expiresAt: ts(Date.now() + 600_000), deviceId: DEVICE });
    unmount();
    expect(service.cancelSmsPairingSession).not.toHaveBeenCalled();
  });

  it("disconnect revokes the paired device", async () => {
    service.revokeSmsDevice.mockResolvedValue({ status: "revoked", uploadsStopped: true });
    const { result } = renderHook(() => useSmsSyncSetup());
    emit(CONFIG, { enabled: true, deviceId: DEVICE });
    emit(CONTROL);
    emit(`users/${UID}/smsDevices/${DEVICE}`, { status: "active", label: "Pixel 8", pairedAt: ts(Date.now()) });
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.disconnect();
    });
    expect(service.revokeSmsDevice).toHaveBeenCalledWith(DEVICE);
    expect(outcome).toEqual({ ok: true });
  });
});
