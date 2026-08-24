import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";

/**
 * Proves the mechanism `WatcherErrorBanner`/`useWatcherErrors` actually
 * depends on: `useFirestoreWatch`'s `queryFn` is a permanent no-op resolve
 * (the real data always arrives via the snapshot listener calling
 * `setQueryData`), so nothing about a failed listener would ever make
 * React Query's own cache entry report `status: "error"` unless the error
 * handler explicitly forces it via `Query.setState` — which is exactly what
 * the production-hardening fix added. `useWatcherErrors` finds erroring
 * queries by scanning `queryCache.findAll({ predicate: status === "error" })`,
 * so this is a direct, no-React-rendering-required test of that same
 * boundary (this repo has no jsdom/@testing-library/react installed, so a
 * hook that calls useState/useEffect can't be rendered here — same
 * constraint `firestore-watch-registry.test.ts` documents).
 */
describe("Firestore watcher errors reach the query cache (WatcherErrorBanner's data source)", () => {
  it("Query.setState({status:'error'}) makes a watcher's query discoverable via findAll(status === 'error')", async () => {
    const queryClient = new QueryClient();
    const queryKey = ["accounts", "uid-1"];

    // Mirrors useFirestoreWatch's useQuery call: registers the query with its permanent no-op queryFn.
    await queryClient.prefetchQuery({ queryKey, queryFn: () => Promise.resolve([]) });
    expect(queryClient.getQueryCache().findAll({ predicate: (q) => q.state.status === "error" })).toHaveLength(0);

    // Mirrors the watcher's onError callback after the production-hardening fix.
    const err = new Error("Missing or insufficient permissions.");
    queryClient.getQueryCache().find({ queryKey })?.setState({ status: "error", error: err, fetchStatus: "idle" });

    const erroring = queryClient.getQueryCache().findAll({ predicate: (q) => q.state.status === "error" });
    expect(erroring).toHaveLength(1);
    expect(erroring[0]!.queryKey).toEqual(queryKey);
    expect(erroring[0]!.state.error).toBe(err);
  });

  it("a second, healthy watcher's query is never mistaken for the erroring one", async () => {
    const queryClient = new QueryClient();
    await queryClient.prefetchQuery({ queryKey: ["accounts", "uid-1"], queryFn: () => Promise.resolve([]) });
    await queryClient.prefetchQuery({ queryKey: ["budgets", "uid-1"], queryFn: () => Promise.resolve([]) });

    queryClient
      .getQueryCache()
      .find({ queryKey: ["accounts", "uid-1"] })
      ?.setState({ status: "error", error: new Error("boom"), fetchStatus: "idle" });

    const erroring = queryClient.getQueryCache().findAll({ predicate: (q) => q.state.status === "error" });
    expect(erroring).toHaveLength(1);
    expect(erroring[0]!.queryKey).toEqual(["accounts", "uid-1"]);
  });

  it("recovering via setQueryData (a successful reconnect) clears the error status again", async () => {
    const queryClient = new QueryClient();
    const queryKey = ["transactions", "uid-2"];
    await queryClient.prefetchQuery({ queryKey, queryFn: () => Promise.resolve([]) });

    queryClient.getQueryCache().find({ queryKey })?.setState({ status: "error", error: new Error("boom"), fetchStatus: "idle" });
    expect(queryClient.getQueryCache().find({ queryKey })?.state.status).toBe("error");

    // Mirrors the watcher's onData callback, which always calls setQueryData on every successful snapshot.
    queryClient.setQueryData(queryKey, [{ id: "t1" }]);

    expect(queryClient.getQueryCache().find({ queryKey })?.state.status).toBe("success");
    expect(queryClient.getQueryCache().findAll({ predicate: (q) => q.state.status === "error" })).toHaveLength(0);
  });
});
