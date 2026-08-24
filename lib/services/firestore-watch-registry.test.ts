import { describe, expect, it, vi } from "vitest";
import { _debugRegistrySize, registerRetry, retryFirestoreWatch } from "./firestore-watch-registry";

/**
 * Regression coverage for the watcher-error retry mechanism: a global
 * `WatcherErrorBanner` needs to be able to re-open a specific broken
 * Firestore listener without holding a direct reference to whichever
 * component originally mounted it. This registry is the pure (no React)
 * core of that mechanism, extracted from `useFirestoreWatch` so it's
 * testable in this project's Node-only test environment.
 */
describe("firestore-watch-registry", () => {
  it("retryFirestoreWatch invokes the registered callback for that exact queryKey", () => {
    const retry = vi.fn();
    registerRetry(["accounts", "uid-1"], retry);

    retryFirestoreWatch(["accounts", "uid-1"]);

    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("is a no-op for a queryKey with nothing registered", () => {
    expect(() => retryFirestoreWatch(["nothing-registered-for-this", "x"])).not.toThrow();
  });

  it("does not cross-trigger a differently-keyed listener", () => {
    const retryA = vi.fn();
    const retryB = vi.fn();
    registerRetry(["budgets", "uid-2"], retryA);
    registerRetry(["loans", "uid-2"], retryB);

    retryFirestoreWatch(["budgets", "uid-2"]);

    expect(retryA).toHaveBeenCalledTimes(1);
    expect(retryB).not.toHaveBeenCalled();
  });

  it("invokes every listener registered for the same key (multiple mounted instances of the same watcher)", () => {
    const first = vi.fn();
    const second = vi.fn();
    registerRetry(["people", "uid-3"], first);
    registerRetry(["people", "uid-3"], second);

    retryFirestoreWatch(["people", "uid-3"]);

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("unregister (the returned cleanup) stops that specific callback from being invoked, without affecting siblings sharing the same key", () => {
    const first = vi.fn();
    const second = vi.fn();
    const unregisterFirst = registerRetry(["savings-goals", "uid-4"], first);
    registerRetry(["savings-goals", "uid-4"], second);

    unregisterFirst();
    retryFirestoreWatch(["savings-goals", "uid-4"]);

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("a stale retry can never be invoked after its owner unregisters (unmount safety)", () => {
    const retry = vi.fn();
    const unregister = registerRetry(["emis", "uid-5"], retry);
    unregister();

    retryFirestoreWatch(["emis", "uid-5"]);

    expect(retry).not.toHaveBeenCalled();
    expect(_debugRegistrySize(["emis", "uid-5"])).toBe(0);
  });

  it("cleans up the key entirely once its last listener unregisters, rather than leaking an empty Set forever", () => {
    const retry = vi.fn();
    const unregister = registerRetry(["credit-card-statements", "uid-6"], retry);
    expect(_debugRegistrySize(["credit-card-statements", "uid-6"])).toBe(1);

    unregister();

    expect(_debugRegistrySize(["credit-card-statements", "uid-6"])).toBe(0);
  });

  it("distinguishes queryKeys that differ only in a later element (e.g. per-document keys)", () => {
    const forDocA = vi.fn();
    const forDocB = vi.fn();
    registerRetry(["documentImportRecords", "uid-7", "doc-a"], forDocA);
    registerRetry(["documentImportRecords", "uid-7", "doc-b"], forDocB);

    retryFirestoreWatch(["documentImportRecords", "uid-7", "doc-a"]);

    expect(forDocA).toHaveBeenCalledTimes(1);
    expect(forDocB).not.toHaveBeenCalled();
  });
});
