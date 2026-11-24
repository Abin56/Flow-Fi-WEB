// @vitest-environment jsdom
/**
 * Premium UI V2: Focus Mode (shell chrome hidden via the workspace-focus store), browser fullscreen (explicit click,
 * graceful fallback, exit leaves the Focus Mode it started), Escape that never fights dialogs or the sheets, focus
 * returned to the toggle, the collapsible comparison dock (actions survive collapse) — and that none of it writes.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));

import type { TransactionRepository } from "@/lib/repositories/transaction-repository";
import { useWorkspaceFocusStore } from "@/store/workspace-focus-store";
import type { RecordsSync } from "../hooks/use-reconciliation-data";
import { commitRepositoriesFor, type ApprovalDeps } from "../lib/approval-commit";
import type { ReconciliationData } from "../lib/analyze";
import { buildReconciliationDraft, saveReconciliationDraft } from "../lib/reconciliation-draft";
import { APPROVAL_NOW, reconData, reconRow, reconSession, txn } from "../lib/test-fixtures";
import type { ReconRow } from "../lib/types";
import { ReconciliationWorkspace } from "./reconciliation-workspace";

function setViewport(width: number) {
  window.matchMedia = ((query: string) => {
    const min = /min-width:\s*(\d+)px/.exec(query);
    return { matches: min ? width >= Number(min[1]) : false, media: query, onchange: null, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false };
  }) as unknown as typeof window.matchMedia;
}

/** A controllable Fullscreen API (jsdom has none). */
function installFullscreen({ enabled = true, reject = false } = {}) {
  let element: Element | null = null;
  Object.defineProperty(document, "fullscreenEnabled", { configurable: true, get: () => enabled });
  Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => element });
  const request = vi.fn(async () => {
    if (reject) throw new Error("denied");
    element = document.documentElement;
    document.dispatchEvent(new Event("fullscreenchange"));
  });
  const exit = vi.fn(async () => {
    element = null;
    document.dispatchEvent(new Event("fullscreenchange"));
  });
  document.documentElement.requestFullscreen = request as unknown as typeof document.documentElement.requestFullscreen;
  document.exitFullscreen = exit as unknown as typeof document.exitFullscreen;
  /** The browser leaving fullscreen on its own (Esc, F11). */
  const browserExit = () => {
    element = null;
    document.dispatchEvent(new Event("fullscreenchange"));
  };
  return { request, exit, browserExit };
}

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(APPROVAL_NOW);
  sessionStorage.clear();
  localStorage.clear();
  localStorage.setItem("flowfi.recon.autoNext", "0"); // these tests decide a row and then keep inspecting it
  setViewport(1600);
  useWorkspaceFocusStore.setState({ active: false });
  installFullscreen();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const OCT_24: [number, number, number] = [2026, 10, 24];
const ROWS: ReconRow[] = [
  reconRow({ id: "r1", day: OCT_24, description: "SWIGGY BANGALORE", amount: 452 }),
  reconRow({ id: "r2", day: OCT_24, description: "CAFE ONE", amount: 90 }),
];
const DATA: ReconciliationData = reconData({ transactions: [txn({ id: "t-sw", amount: 452, description: "Swiggy", dateTime: new Date(2026, 9, 24, 13) })] });
const LOADED: RecordsSync = { loading: [], failed: [], retry: vi.fn() };

function renderStudio() {
  saveReconciliationDraft(buildReconciliationDraft("u1", reconSession(ROWS, {}, "acc-card")));
  const creates = vi.fn();
  const readData = vi.fn(async () => DATA);
  const fakeRepo = { getByKey: vi.fn(async () => null), createTransaction: creates } as unknown as TransactionRepository;
  const deps: ApprovalDeps = { readData, repositories: commitRepositoriesFor(fakeRepo), now: () => APPROVAL_NOW };
  const view = render(<ReconciliationWorkspace uid="u1" data={DATA} sync={LOADED} approvalDeps={deps} />);
  return { ...view, creates, readData };
}

const focusOn = () => useWorkspaceFocusStore.getState().active;
const toggle = () => screen.getByTestId("focus-mode-toggle");
const flushFrames = () => act(() => new Promise<void>((r) => requestAnimationFrame(() => r())));

describe("Focus Mode", () => {
  it("the header toggle turns it on and off; the workspace grows to the viewport; leaving the page turns it off", async () => {
    const { unmount } = renderStudio();
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
    expect(toggle().getAttribute("aria-label")).toBe("Enter Focus Mode");
    fireEvent.click(toggle());
    expect(focusOn()).toBe(true);
    expect(toggle().getAttribute("aria-label")).toBe("Exit Focus Mode");
    expect(screen.getByTestId("recon-workspace").dataset.focus).toBe("true");
    expect(screen.getByTestId("recon-workspace").className).toMatch(/100dvh-1\.5rem/);
    // The single review sheet and the approval bar are all still there.
    for (const id of ["statement-sheet", "review-sheet", "status-bar"]) expect(screen.getByTestId(id)).toBeTruthy();
    fireEvent.click(toggle());
    expect(focusOn()).toBe(false);
    await flushFrames();
    expect(document.activeElement).toBe(toggle());
    fireEvent.click(toggle());
    unmount();
    expect(focusOn()).toBe(false);
  });

  it("F toggles it from the sheets; Escape leaves it outside the sheets, and focus returns to the toggle", async () => {
    renderStudio();
    const grid = screen.getByRole("grid", { name: "Statement rows" });
    fireEvent.keyDown(grid, { key: "f" });
    expect(focusOn()).toBe(true);
    // Escape inside a sheet keeps its own meaning there.
    fireEvent.keyDown(grid, { key: "Escape" });
    expect(focusOn()).toBe(true);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(focusOn()).toBe(false);
    await flushFrames();
    expect(document.activeElement).toBe(toggle());
  });

  it("Escape with a dialog or popover open closes that, not Focus Mode", () => {
    renderStudio();
    fireEvent.click(toggle());
    fireEvent.click(within(screen.getAllByTestId("recon-row")[0]).getByTestId("quick-decide"));
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(focusOn()).toBe(true);
  });
});

describe("browser fullscreen", () => {
  it("asks the browser only on click, turns Focus Mode on with it, and leaving fullscreen leaves that Focus Mode too", async () => {
    const fs = installFullscreen();
    renderStudio();
    expect(fs.request).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(screen.getByTestId("fullscreen-toggle")));
    expect(fs.request).toHaveBeenCalledTimes(1);
    expect(focusOn()).toBe(true);
    expect(screen.getByTestId("fullscreen-toggle").getAttribute("aria-label")).toBe("Exit full screen");
    await act(async () => fs.browserExit());
    expect(focusOn()).toBe(false);
  });

  it("Focus Mode that was on before fullscreen stays on after it", async () => {
    const fs = installFullscreen();
    renderStudio();
    fireEvent.click(toggle());
    await act(async () => fireEvent.click(screen.getByTestId("fullscreen-toggle")));
    await act(async () => fs.browserExit());
    expect(focusOn()).toBe(true);
  });

  it("refused: Focus Mode alone, with a notice — never an error screen", async () => {
    installFullscreen({ reject: true });
    renderStudio();
    await act(async () => fireEvent.click(screen.getByTestId("fullscreen-toggle")));
    expect(focusOn()).toBe(true);
    expect(screen.getByTestId("fullscreen-notice").textContent).toMatch(/didn't allow full screen/);
  });

  it("unsupported (e.g. iPhone Safari): no fullscreen button; Focus Mode still works", () => {
    installFullscreen({ enabled: false });
    renderStudio();
    expect(screen.queryByTestId("fullscreen-toggle")).toBeNull();
    fireEvent.click(toggle());
    expect(focusOn()).toBe(true);
  });

  it("phones: Focus Mode works with the two-tab layout", () => {
    setViewport(390);
    renderStudio();
    fireEvent.click(toggle());
    expect(focusOn()).toBe(true);
    expect(screen.getByTestId("mobile-sheet-switch")).toBeTruthy();
    expect(screen.getByTestId("status-bar")).toBeTruthy();
  });
});
