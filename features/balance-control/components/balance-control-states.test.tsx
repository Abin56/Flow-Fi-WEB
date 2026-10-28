// @vitest-environment jsdom
/**
 * Balance Control's data states: loading, a genuinely empty account, an unreachable server and a refused read are four
 * different situations and must never share a message. Pure render tests — no Firestore, no writes.
 */
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getDocsFromServer = vi.fn();
vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {} }));
vi.mock("firebase/firestore", () => ({ collection: vi.fn(() => ({})), query: vi.fn(() => ({})), limit: vi.fn(() => ({})), getDocsFromServer: (...a: unknown[]) => getDocsFromServer(...a) }));
vi.mock("@/store/auth-store", () => ({ useAuthStore: (sel: (s: { user: { uid: string } }) => unknown) => sel({ user: { uid: "u1" } }) }));
vi.mock("@/components/layout/scroll-nav", () => ({ ScrollNav: () => null }));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));

import type { VarianceProduct } from "../lib/build-balance-control";
import { REACHABILITY_TIMEOUT_MS, useBackendReachability } from "../hooks/use-backend-reachability";
import { BalanceControlView } from "./balance-control-workspace";

const product: VarianceProduct = {
  id: "card:c1", kind: "card", name: "QA Card", subtitle: "Credit card", metrics: ["totalOutstanding"],
  flowfi: { totalOutstanding: 1000 }, notes: {}, context: { lockedEmiPrincipal: 0 }, crossEffect: null,
  limitCorrectionTarget: null, reconciliation: null,
};
const q = (id: string) => screen.queryByTestId(id);

beforeEach(() => { vi.useFakeTimers(); getDocsFromServer.mockReset(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

async function settle() { await act(async () => { await vi.advanceTimersByTimeAsync(5000); }); }

describe("Balance Control data states", () => {
  it("while loading, or before the server has answered, it never claims the account is empty", async () => {
    render(<BalanceControlView products={[]} isLoading={false} isError={false} reachability="checking" />);
    await settle();
    expect(q("balance-control-empty")).toBeNull();
    expect(q("balance-control-loading")).not.toBeNull();
  });

  it("reachable + settled + nothing returned is a genuinely empty account", async () => {
    render(<BalanceControlView products={[]} isLoading={false} isError={false} reachability="reachable" />);
    expect(q("balance-control-empty")).toBeNull();
    await settle();
    expect(q("balance-control-empty")).not.toBeNull();
    expect(q("balance-control-unreachable")).toBeNull();
    expect(q("balance-control-error")).toBeNull();
  });

  it("an unreachable server is a warning that says it does NOT mean the account is empty", async () => {
    render(<BalanceControlView products={[]} isLoading={false} isError={false} reachability="unreachable" />);
    await settle();
    expect(q("balance-control-empty")).toBeNull();
    expect(q("balance-control-loading")).toBeNull();
    expect(q("balance-control-unreachable")?.textContent).toMatch(/does not mean your account is empty/i);
  });

  it("an unreachable server with cached figures keeps them and warns they may be out of date", async () => {
    render(<BalanceControlView products={[product]} isLoading={false} isError={false} reachability="unreachable" />);
    await settle();
    expect(q("variance-table")).not.toBeNull();
    expect(q("balance-control-unreachable")?.textContent).toMatch(/out of date/i);
  });

  it("a refused read shows the error banner and never the empty message", async () => {
    render(<BalanceControlView products={[]} isLoading={false} isError reachability="reachable" />);
    await settle();
    expect(q("balance-control-error")?.textContent).toMatch(/may be incomplete/i);
    expect(q("balance-control-empty")).toBeNull();
  });
});

describe("useBackendReachability", () => {
  it("a server reply — even an empty one — is reachable", async () => {
    getDocsFromServer.mockResolvedValue({ docs: [] });
    const { result } = renderHook(() => useBackendReachability());
    expect(result.current).toBe("checking");
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(result.current).toBe("reachable");
  });

  it("a refused read (permission-denied) means the server answered: reachable, not unreachable", async () => {
    getDocsFromServer.mockRejectedValue(Object.assign(new Error("denied"), { code: "permission-denied" }));
    const { result } = renderHook(() => useBackendReachability());
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(result.current).toBe("reachable");
  });

  it("a network failure is unreachable", async () => {
    getDocsFromServer.mockRejectedValue(Object.assign(new Error("offline"), { code: "unavailable" }));
    const { result } = renderHook(() => useBackendReachability());
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(result.current).toBe("unreachable");
  });

  it("no reply within the timeout is unreachable, and a late reply recovers", async () => {
    let resolve!: (v: unknown) => void;
    getDocsFromServer.mockReturnValue(new Promise((r) => { resolve = r; }));
    const { result } = renderHook(() => useBackendReachability());
    await act(async () => { await vi.advanceTimersByTimeAsync(REACHABILITY_TIMEOUT_MS + 50); });
    expect(result.current).toBe("unreachable");
    await act(async () => { resolve({ docs: [] }); await vi.advanceTimersByTimeAsync(10); });
    expect(result.current).toBe("reachable");
  });
});
