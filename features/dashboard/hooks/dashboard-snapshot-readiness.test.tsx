// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, type QueryKey } from "@tanstack/react-query";
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { onSnapshot } from "firebase/firestore";
import { DashboardPanelGate } from "@/features/dashboard/components/dashboard-panel-gate";
import { dashboardSnapshotStates, useDashboardSnapshotStates } from "@/features/dashboard/hooks/use-dashboard-snapshots-pending";
import { accountsQueryKey, useAccounts } from "@/hooks/use-accounts";
import { hasCompleteFirestoreSnapshot, useFirestoreWatch } from "@/hooks/use-firestore-watch";
import { useAuthStore } from "@/store/auth-store";

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));
vi.mock("firebase/firestore", async (importOriginal) => ({
  ...await importOriginal<typeof import("firebase/firestore")>(),
  collection: vi.fn(() => ({ withConverter() { return this; } })),
  query: vi.fn((reference) => reference),
  onSnapshot: vi.fn(() => () => {}),
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("distinguishes placeholder, partial, and complete empty snapshots for the current group", async () => {
  const client = new QueryClient();
  const key = ["loanInstallments", "snapshot-test-user"] as const;
  let publish!: (data: string[], complete?: boolean) => void;
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const useWatch = ({ group }: { group: string }) => useFirestoreWatch({
    queryKey: key,
    enabled: true,
    emptyValue: [] as string[],
    deps: [key[1], group],
    hookName: "snapshot test",
    subscribe: (onData) => {
      publish = onData;
      return () => {};
    },
  });
  const { result, rerender, unmount } = renderHook(useWatch, { wrapper, initialProps: { group: "a,b" } });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(hasCompleteFirestoreSnapshot(client, key)).toBe(false);

  act(() => publish(["from-a"], false));
  expect(client.getQueryData(key)).toEqual(["from-a"]);
  expect(hasCompleteFirestoreSnapshot(client, key, [key[1], "a,b"])).toBe(false);
  act(() => publish(["from-a"], true));
  expect(hasCompleteFirestoreSnapshot(client, key, [key[1], "a,b"])).toBe(true);

  rerender({ group: "a,b,c" });
  expect(hasCompleteFirestoreSnapshot(client, key, [key[1], "a,b,c"])).toBe(false);
  act(() => publish([]));
  unmount();
  expect(hasCompleteFirestoreSnapshot(client, key, [key[1], "a,b,c"])).toBe(true);
  expect(client.getQueryData(key)).toEqual([]);
  vi.resetModules();
  const refreshedWatcher = await import("@/hooks/use-firestore-watch");
  expect(refreshedWatcher.hasCompleteFirestoreSnapshot(client, key, [key[1], "a,b,c"])).toBe(true);
  client.clear();
  expect(hasCompleteFirestoreSnapshot(client, key)).toBe(false);
});

function EmptySnapshot({ queryKey }: { queryKey: QueryKey }) {
  useFirestoreWatch({
    queryKey,
    enabled: true,
    emptyValue: [],
    deps: queryKey,
    hookName: "Dashboard test",
    subscribe: (publish) => {
      publish([], true, false);
      return () => {};
    },
  });
  return null;
}

it("waits for account balances to be confirmed before showing Net Worth", async () => {
  const client = new QueryClient();
  const uid = "cached-accounts-test-user";
  const sources = ["transactions", "creditCards", "sharedCreditLimits", "loanPersons", "loans", "loansTrash", "emis", "people"];
  const authBefore = useAuthStore.getState();
  useAuthStore.setState({ user: { uid } as NonNullable<typeof authBefore.user> });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      {sources.map((source) => <EmptySnapshot key={source} queryKey={[source, uid]} />)}
      {children}
    </QueryClientProvider>
  );
  const { result, unmount } = renderHook(() => {
    useAccounts();
    return useDashboardSnapshotStates();
  }, { wrapper });

  try {
    const [, options, onData] = vi.mocked(onSnapshot).mock.lastCall!;
    expect(options).toMatchObject({ includeMetadataChanges: true });
    const publish = (currentBalance: number, fromCache: boolean) => {
      const account = { id: "bank", currentBalance };
      const receive = onData as (snapshot: { docs: { data: () => typeof account }[]; metadata: { fromCache: boolean } }) => void;
      act(() => receive({ docs: [{ data: () => account }], metadata: { fromCache } }));
      expect(client.getQueryData(accountsQueryKey(uid))).toEqual([account]);
    };
    publish(20_000, true);
    await waitFor(() => expect(result.current).toMatchObject({ netWorth: "loading", accounts: "ready" }));
    publish(25_000, false);
    await waitFor(() => expect(result.current).toMatchObject({ netWorth: "ready", accounts: "ready" }));
    publish(25_000, true);
    expect(dashboardSnapshotStates(client, uid).netWorth).toBe("ready");
  } finally {
    unmount();
    client.clear();
    useAuthStore.setState(authBefore);
  }
});

it("loads the financial headlines while the unrelated bills and savings data are pending or unavailable", async () => {
  const client = new QueryClient();
  const uid = "separate-panel-test-user";
  const sources = ["accounts", "transactions", "creditCards", "sharedCreditLimits", "loanPersons", "loans", "loansTrash", "emis", "expenses", "people", "categories"];
  const view = render(
    <QueryClientProvider client={client}>
      {sources.map((source) => <EmptySnapshot key={source} queryKey={[source, uid]} />)}
    </QueryClientProvider>,
  );

  await waitFor(() => expect(dashboardSnapshotStates(client, uid)).toMatchObject({ netWorth: "ready", cashFlow: "ready", attention: "loading", upcoming: "loading" }));

  const bills = client.getQueryCache().build(client, { queryKey: ["bills", uid] });
  bills.setState({ status: "error", error: new Error("Bills unavailable") });
  expect(dashboardSnapshotStates(client, uid)).toMatchObject({ netWorth: "ready", cashFlow: "ready", attention: "unavailable", upcoming: "unavailable" });

  const accounts = client.getQueryCache().find({ queryKey: ["accounts", uid], exact: true })!;
  client.removeQueries({ queryKey: accounts.queryKey, exact: true });
  client.getQueryCache().build(client, { queryKey: accounts.queryKey }).setState({ status: "error", error: new Error("Accounts unavailable") });
  expect(dashboardSnapshotStates(client, uid)).toMatchObject({ netWorth: "unavailable", cashFlow: "ready" });
  view.unmount();
  client.clear();
});

it("explains a stalled card and resumes displaying the figures when its data arrives", () => {
  vi.useFakeTimers();
  const { rerender } = render(<DashboardPanelGate label="Net worth" state="loading">Loading placeholder</DashboardPanelGate>);
  expect(screen.getByText("Loading placeholder")).toBeTruthy();
  act(() => vi.advanceTimersByTime(12_000));
  expect(screen.getByRole("status").textContent).toContain("Still waiting for data");
  rerender(<DashboardPanelGate label="Net worth" state="ready">₹12,345</DashboardPanelGate>);
  expect(screen.getByText("₹12,345")).toBeTruthy();
  expect(screen.queryByRole("status")).toBeNull();
});
