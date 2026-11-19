import { afterEach, describe, expect, it, vi } from "vitest";

// The store is module-level state: load a fresh copy per test so one case can never leak a pending link into the next.
async function fresh() {
  vi.resetModules();
  // useLinkStatus / React hooks are not exercised here — only the store the hooks write to.
  vi.doMock("next/link", () => ({ useLinkStatus: () => ({ pending: false }) }));
  return import("./nav-pending");
}

afterEach(() => vi.resetModules());

function track(mod: Awaited<ReturnType<typeof fresh>>) {
  return { current: () => mod.getNavPending() };
}

describe("nav pending store", () => {
  it("is idle until a link reports pending", async () => {
    const mod = await fresh();
    expect(track(mod).current()).toBeNull();
  });

  it("shows the link that started, and clears when it ends", async () => {
    const mod = await fresh();
    const t = track(mod);
    mod.beginNav("/accounts");
    expect(t.current()).toBe("/accounts");
    mod.endNav("/accounts");
    expect(t.current()).toBeNull();
  });

  it("rapid A → B: B wins while both are pending, and nothing is left behind once both end", async () => {
    const mod = await fresh();
    const t = track(mod);
    mod.beginNav("/bills");
    mod.beginNav("/savings");
    expect(t.current()).toBe("/savings");
    mod.endNav("/bills"); // Next resets the superseded link first
    expect(t.current()).toBe("/savings");
    mod.endNav("/savings");
    expect(t.current()).toBeNull();
  });

  it("A superseded after B finished still ends at idle", async () => {
    const mod = await fresh();
    const t = track(mod);
    mod.beginNav("/a");
    mod.beginNav("/b");
    mod.endNav("/b");
    expect(t.current()).toBe("/a"); // A is still reported pending by its own link…
    mod.endNav("/a"); // …until it unmounts / resets: never stuck.
    expect(t.current()).toBeNull();
  });

  it("two links to the same page (quick tile + list row) stay balanced", async () => {
    const mod = await fresh();
    const t = track(mod);
    mod.beginNav("/people");
    mod.beginNav("/people");
    mod.endNav("/people");
    expect(t.current()).toBe("/people");
    mod.endNav("/people");
    expect(t.current()).toBeNull();
  });

  it("ending a link that never began is harmless", async () => {
    const mod = await fresh();
    const t = track(mod);
    mod.endNav("/nope");
    expect(t.current()).toBeNull();
  });
});
