// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CandidatesLoadError } from "@/features/transaction-candidates/components/candidates-load-error";
import { deriveCandidatesViewState } from "@/features/transaction-candidates/lib/candidates-load-state";
import { useAuthStore } from "@/store/auth-store";
import { useSmsTransactionCandidates } from "./use-sms-transaction-candidates";

vi.mock("@/lib/firebase/client", () => ({ db: {} }));

type Listener = { onNext: (snapshot: { docs: unknown[] }) => void; onError: (error: Error) => void; unsubscribe: ReturnType<typeof vi.fn> };
const listeners: Listener[] = [];
vi.mock("firebase/firestore", async () => {
  const actual = await vi.importActual<typeof import("firebase/firestore")>("firebase/firestore");
  return {
    ...actual,
    collection: vi.fn(() => ({})),
    orderBy: vi.fn(() => ({})),
    query: vi.fn(() => ({})),
    onSnapshot: vi.fn((_q: unknown, onNext: Listener["onNext"], onError: Listener["onError"]) => {
      const unsubscribe = vi.fn();
      listeners.push({ onNext, onError, unsubscribe });
      return unsubscribe;
    }),
  };
});

function candidateDoc(id: string) {
  return {
    id,
    data: () => ({
      amount: 100,
      direction: "debit",
      eventType: "upiPayment",
      transactionDate: { toDate: () => new Date("2026-08-01T00:00:00Z") },
      createdAt: { toDate: () => new Date("2026-08-01T00:00:00Z") },
    }),
  };
}

let queryClient: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;

/** What the workspace renders for the current hook state. */
function phaseOf(hook: { hasSnapshot: boolean; isError: boolean }) {
  return deriveCandidatesViewState({ hasSnapshot: hook.hasSnapshot, isError: hook.isError }).phase;
}

beforeEach(() => {
  listeners.length = 0;
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  useAuthStore.setState({ user: { uid: "u1" } as never, status: "signed-in" });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useSmsTransactionCandidates — initial loading and errors", () => {
  it("stays 'loading' (never empty) until the first Firestore snapshot arrives", async () => {
    const { result } = renderHook(() => useSmsTransactionCandidates(), { wrapper });
    await act(async () => {});
    expect(listeners).toHaveLength(1);
    expect(result.current.data ?? []).toEqual([]); // the shared watcher placeholder...
    expect(result.current.hasSnapshot).toBe(false); // ...which must not read as "no candidates"
    await waitFor(() => expect(phaseOf(result.current)).toBe("loading"));
  });

  it("becomes ready on the first snapshot — including a genuinely empty one", async () => {
    const { result } = renderHook(() => useSmsTransactionCandidates(), { wrapper });
    await act(async () => {});
    await act(async () => listeners[0].onNext({ docs: [] }));
    await waitFor(() => expect(result.current.hasSnapshot).toBe(true));
    expect(result.current.data).toEqual([]);
    await waitFor(() => expect(phaseOf(result.current)).toBe("ready"));
  });

  it("delivers a new candidate in real time after the first snapshot", async () => {
    const { result } = renderHook(() => useSmsTransactionCandidates(), { wrapper });
    await act(async () => {});
    await act(async () => listeners[0].onNext({ docs: [] }));
    await act(async () => listeners[0].onNext({ docs: [candidateDoc("sms-live-1")] }));
    await waitFor(() => expect(result.current.data?.map((c) => c.id)).toEqual(["sms-live-1"]));
    await waitFor(() => expect(phaseOf(result.current)).toBe("ready"));
  });

  it("shows an error — not the empty state — when the listener fails before any snapshot", async () => {
    const { result } = renderHook(() => useSmsTransactionCandidates(), { wrapper });
    await act(async () => {});
    await act(async () => listeners[0].onError(new Error("permission-denied")));
    await waitFor(() => expect(result.current.isError).toBe(true));
    await waitFor(() => expect(result.current.hasSnapshot).toBe(false));
    await waitFor(() => expect(phaseOf(result.current)).toBe("error"));
  });

  it("Retry clears the error, resubscribes, and reaches ready on the next snapshot", async () => {
    const { result } = renderHook(() => useSmsTransactionCandidates(), { wrapper });
    await act(async () => {});
    await act(async () => listeners[0].onError(new Error("unavailable")));
    await waitFor(() => expect(phaseOf(result.current)).toBe("error"));

    await act(async () => result.current.retry());
    expect(listeners.length).toBeGreaterThanOrEqual(2); // a fresh listener was opened
    await waitFor(() => expect(result.current.isError).toBe(false));
    await waitFor(() => expect(phaseOf(result.current)).toBe("loading")); // back to loading, not the empty state

    await act(async () => listeners[listeners.length - 1].onNext({ docs: [candidateDoc("sms-after-retry")] }));
    await waitFor(() => expect(phaseOf(result.current)).toBe("ready"));
    await waitFor(() => expect(result.current.data?.map((c) => c.id)).toEqual(["sms-after-retry"]));
  });

  it("a failed retry shows the error again", async () => {
    const { result } = renderHook(() => useSmsTransactionCandidates(), { wrapper });
    await act(async () => {});
    await act(async () => listeners[0].onError(new Error("unavailable")));
    await act(async () => result.current.retry());
    await act(async () => listeners[listeners.length - 1].onError(new Error("still unavailable")));
    await waitFor(() => expect(phaseOf(result.current)).toBe("error"));
  });

  it("keeps the list but flags it when the listener fails after data was shown", async () => {
    const { result } = renderHook(() => useSmsTransactionCandidates(), { wrapper });
    await act(async () => {});
    await act(async () => listeners[0].onNext({ docs: [candidateDoc("sms-1")] }));
    await act(async () => listeners[0].onError(new Error("network")));
    await waitFor(() => expect(result.current.isError).toBe(true));
    const state = deriveCandidatesViewState({ hasSnapshot: result.current.hasSnapshot, isError: result.current.isError });
    expect(state).toEqual({ phase: "ready", showErrorNotice: true });
    await waitFor(() => expect(result.current.data?.map((c) => c.id)).toEqual(["sms-1"]));
  });
});

describe("useSmsTransactionCandidates — unreadable documents", () => {
  it("counts documents it had to skip, so the page can say so instead of silently dropping them", async () => {
    const { result } = renderHook(() => useSmsTransactionCandidates(), { wrapper });
    await act(async () => {});
    const malformed = { id: "sms-bad", data: () => ({ amount: 5, transactionDate: { toDate: () => new Date() }, createdAt: { toDate: () => new Date() } }) }; // no direction
    await act(async () => listeners[0].onNext({ docs: [candidateDoc("sms-good"), malformed, { ...malformed, id: "sms-bad-2" }] }));
    await waitFor(() => expect(result.current.hasSnapshot).toBe(true));
    expect(result.current.data?.map((c) => c.id)).toEqual(["sms-good"]);
    expect(result.current.unreadableCount).toBe(2);
  });

  it("is zero when every document is readable, and resets when a later snapshot is clean", async () => {
    const { result } = renderHook(() => useSmsTransactionCandidates(), { wrapper });
    await act(async () => {});
    expect(result.current.unreadableCount).toBe(0);
    const malformed = { id: "sms-bad", data: () => ({ amount: 5, transactionDate: { toDate: () => new Date() }, createdAt: { toDate: () => new Date() } }) };
    await act(async () => listeners[0].onNext({ docs: [malformed] }));
    await waitFor(() => expect(result.current.unreadableCount).toBe(1));
    await act(async () => listeners[0].onNext({ docs: [candidateDoc("sms-good")] }));
    await waitFor(() => expect(result.current.unreadableCount).toBe(0));
  });
});

describe("CandidatesLoadError", () => {
  it("shows the message and a working Retry button", () => {
    const onRetry = vi.fn();
    render(<CandidatesLoadError message="Couldn't load your SMS candidates." error={new Error("permission-denied")} onRetry={onRetry} />);
    expect(screen.getByRole("alert").textContent).toContain("Couldn't load your SMS candidates.");
    expect(screen.getByRole("alert").textContent).toContain("permission-denied");
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
