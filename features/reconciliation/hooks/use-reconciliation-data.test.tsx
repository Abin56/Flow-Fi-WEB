// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));

import { useSnapshotTracker } from "./use-reconciliation-data";

afterEach(cleanup);

const KEY = ["transactions", "u1"] as const;

/** Mirrors useFirestoreWatch: the query function resolves an empty placeholder; snapshots arrive via setQueryData. */
function setup(client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const hook = renderHook(
    () => {
      const status = useSnapshotTracker([KEY as unknown as string[]]);
      useQuery({ queryKey: KEY, queryFn: () => Promise.resolve([] as string[]), staleTime: Infinity });
      return status(KEY as unknown as string[]);
    },
    { wrapper },
  );
  return { client, hook };
}

describe("required-data load tracking", () => {
  it("the empty placeholder is NOT 'loaded' — only a real snapshot is, even an empty one", async () => {
    const { client, hook } = setup();
    await waitFor(() => expect(client.getQueryState(KEY)?.status).toBe("success"));
    expect(hook.result.current).toEqual({ synced: false, failed: false });
    act(() => client.setQueryData(KEY, [])); // the first snapshot: the user really has no transactions
    expect(hook.result.current).toEqual({ synced: true, failed: false });
  });

  it("a failed live query is reported as failed, never as loaded", async () => {
    const { client, hook } = setup();
    await waitFor(() => expect(client.getQueryState(KEY)?.status).toBe("success"));
    act(() => client.getQueryCache().find({ queryKey: KEY })!.setState({ status: "error", error: new Error("permission-denied"), fetchStatus: "idle" }));
    await waitFor(() => expect(hook.result.current).toEqual({ synced: false, failed: true }));
  });

  it("data already synced before this page mounted counts as loaded", async () => {
    const client = new QueryClient();
    client.setQueryData(KEY, ["t1"]);
    const { hook } = setup(client);
    expect(hook.result.current.synced).toBe(true);
  });
});
