// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthStore } from "@/store/auth-store";
import { useSmsSyncConfig } from "./use-sms-sync-config";

vi.mock("@/lib/firebase/client", () => ({ db: {} }));

type Next = (snapshot: { exists: () => boolean; data: () => Record<string, unknown> | undefined }) => void;
const listeners: { next: Next; error: (e: Error) => void; unsubscribe: ReturnType<typeof vi.fn> }[] = [];
const docPath: unknown[][] = [];
vi.mock("firebase/firestore", async () => {
  const actual = await vi.importActual<typeof import("firebase/firestore")>("firebase/firestore");
  return {
    ...actual,
    doc: vi.fn((...args: unknown[]) => {
      docPath.push(args.slice(1));
      return {};
    }),
    onSnapshot: vi.fn((_ref: unknown, next: Next, error: (e: Error) => void) => {
      const unsubscribe = vi.fn();
      listeners.push({ next, error, unsubscribe });
      return unsubscribe;
    }),
  };
});

const snap = (data?: Record<string, unknown>) => ({ exists: () => data !== undefined, data: () => data });

beforeEach(() => {
  listeners.length = 0;
  docPath.length = 0;
  useAuthStore.setState({ user: { uid: "u1" } as never });
});
afterEach(() => {
  cleanup();
  useAuthStore.setState({ user: null } as never);
});

describe("useSmsSyncConfig", () => {
  it("reads users/{uid}/smsSyncConfig/backgroundUpload and starts as loading", () => {
    const { result } = renderHook(() => useSmsSyncConfig());
    expect(result.current).toBe("loading");
    expect(docPath[0]).toEqual(["users", "u1", "smsSyncConfig", "backgroundUpload"]);
  });

  it("is configured only when enabled is exactly true", () => {
    const { result } = renderHook(() => useSmsSyncConfig());
    act(() => listeners[0].next(snap({ enabled: true, deviceId: "x" })));
    expect(result.current).toBe("configured");
  });

  it.each([[undefined], [{ enabled: false }], [{ enabled: "true" }], [{}]])("is not-configured for %j", (data) => {
    const { result } = renderHook(() => useSmsSyncConfig());
    act(() => listeners[0].next(snap(data as Record<string, unknown> | undefined)));
    expect(result.current).toBe("not-configured");
  });

  it("is unknown when the read fails", () => {
    const { result } = renderHook(() => useSmsSyncConfig());
    act(() => listeners[0].error(new Error("permission-denied")));
    expect(result.current).toBe("unknown");
  });

  it("unsubscribes on unmount", () => {
    const { unmount } = renderHook(() => useSmsSyncConfig());
    unmount();
    expect(listeners[0].unsubscribe).toHaveBeenCalled();
  });
});
