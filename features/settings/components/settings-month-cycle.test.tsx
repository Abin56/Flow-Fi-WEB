// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, within } from "@testing-library/react";
import type { User } from "firebase/auth";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useSelectedCycle } from "@/features/people/hooks/use-selected-cycle";
import { SettingsWorkspace } from "@/features/settings/components/settings-workspace";
import { useMonthCycleStartDay } from "@/features/settings/hooks/use-user-preferences";
import { adjacentCycleRange, cycleRangeFor } from "@/lib/engines/month-cycle-range";
import { formatCycleLabel, formatStatementDate } from "@/lib/engines/person-cycle-statement";
import { useAuthStore } from "@/store/auth-store";

/**
 * The Settings → Month cycle UI itself, rendered inside the real Settings page. Expected preview ranges
 * come from the canonical engine (`cycleRangeFor` / `adjacentCycleRange`) and are also pinned to the
 * literal product examples, so the UI can never drift from the one month-cycle contract.
 */

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));
vi.mock("@/hooks/use-accounts", () => ({ useAccounts: () => ({ data: [] }) }));
vi.mock("@/hooks/use-credit-cards", () => ({ useCreditCards: () => ({ data: [] }) }));
vi.mock("@/hooks/use-loans", () => ({ useLoans: () => ({ data: [] }) }));
vi.mock("@/hooks/use-people", () => ({ usePeople: () => ({ data: [] }) }));
vi.mock("@/features/settings/components/pdf-analyzer-setup-card", () => ({ PdfAnalyzerSetupCard: () => null }));

const UID = "user-1";
const KEY = `flowfi:user-preferences:${UID}`;
const NOW = new Date(2026, 9, 1, 12); // 1 Oct 2026 — the reference date for the 18 Sep → 17 Oct example

beforeAll(() => {
  // Radix Select needs these in jsdom.
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
  window.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  window.localStorage.clear();
  useAuthStore.setState({ user: { uid: UID, displayName: "Test", email: "t@example.com" } as User, status: "signed-in" });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useAuthStore.setState({ user: null, status: "loading" });
});

/** "18 Sep 2026 → 17 Oct 2026" for a canonical range — the same formatter the preview uses. */
const rangeText = (r: { start: Date; end: Date }) => `${formatStatementDate(r.start, true)} → ${formatStatementDate(r.end, true)}`;
const expectedPreview = (startDay: number) => {
  const current = cycleRangeFor(startDay, new Date());
  return { current: rangeText(current), previous: rangeText(adjacentCycleRange(startDay, current, -1)) };
};

function openSettings() {
  // The Month cycle row lives in the default (Profile) tab's preferences card.
  const view = render(<SettingsWorkspace />);
  return view;
}

function monthCycleSection() {
  const heading = screen.getByText("Month cycle", { selector: "p" });
  // The setting's root: the block holding the heading, select, preview and Save.
  return heading.closest("div.flex.flex-col") as HTMLElement;
}

const trigger = () => within(monthCycleSection()).getByRole("combobox");
const preview = (label: "Current cycle" | "Previous cycle") =>
  within(monthCycleSection()).getByText(label).nextElementSibling!.textContent!.replace(/\s+/g, " ").trim();
const saveButton = () => within(monthCycleSection()).getByRole("button", { name: "Save" });

function choose(label: string) {
  fireEvent.keyDown(trigger(), { key: "Enter" });
  fireEvent.click(screen.getByRole("option", { name: label }));
}

describe("Settings → Month cycle UI", () => {
  it("1–2. the setting is visible and defaults to the 1st (calendar month) when nothing is stored", () => {
    openSettings();
    expect(screen.getByText("Month cycle", { selector: "p" })).toBeTruthy();
    expect(screen.getByText(/FlowFi uses this cycle across Month Cycle, People Ledger, Dashboard/)).toBeTruthy();
    expect(trigger().textContent).toBe("1st (calendar month)");
    expect(preview("Current cycle")).toBe(expectedPreview(1).current);
    expect(preview("Current cycle")).toBe("01 Oct 2026 → 31 Oct 2026");
    expect(saveButton().hasAttribute("disabled")).toBe(true);
  });

  it("3–5. selecting 18th immediately previews 18 Sep → 17 Oct and previous 18 Aug → 17 Sep (before saving)", () => {
    openSettings();
    choose("18th");
    expect(trigger().textContent).toBe("18th");
    expect(preview("Current cycle")).toBe(expectedPreview(18).current);
    expect(preview("Current cycle")).toBe("18 Sep 2026 → 17 Oct 2026");
    expect(preview("Previous cycle")).toBe(expectedPreview(18).previous);
    expect(preview("Previous cycle")).toBe("18 Aug 2026 → 17 Sep 2026");
    // Preview only — nothing persisted until Save.
    expect(window.localStorage.getItem(KEY) ?? "").not.toContain('"monthCycleStartDay":18');
    expect(saveButton().hasAttribute("disabled")).toBe(false);
  });

  it("6. changing 18th → 10th previews 10 Sep → 9 Oct", () => {
    openSettings();
    choose("18th");
    choose("10th");
    expect(preview("Current cycle")).toBe(expectedPreview(10).current);
    expect(preview("Current cycle")).toBe("10 Sep 2026 → 09 Oct 2026");
    expect(preview("Previous cycle")).toBe("10 Aug 2026 → 09 Sep 2026");
  });

  it("7–8. Save persists the selection and reloading Settings restores it", () => {
    const first = openSettings();
    choose("18th");
    fireEvent.click(saveButton());
    expect(JSON.parse(window.localStorage.getItem(KEY)!).monthCycleStartDay).toBe(18);
    expect(saveButton().hasAttribute("disabled")).toBe(true);
    first.unmount();

    openSettings(); // reload
    expect(trigger().textContent).toBe("18th");
    expect(preview("Current cycle")).toBe("18 Sep 2026 → 17 Oct 2026");
  });

  it("9. 29th / 30th / 31st show the short-month note; earlier days do not", () => {
    openSettings();
    for (const [label, day] of [["29th", 29], ["30th", 30], ["31st", 31]] as const) {
      choose(label);
      expect(within(monthCycleSection()).getByText(`In months shorter than ${day} days the cycle starts on the month's last day.`)).toBeTruthy();
      expect(preview("Current cycle")).toBe(expectedPreview(day).current);
    }
    choose("28th");
    expect(within(monthCycleSection()).queryByText(/In months shorter than/)).toBeNull();
  });

  it("10. saving pushes the new start day to mounted cycle consumers without a reload", () => {
    window.localStorage.setItem(KEY, JSON.stringify({ monthCycleStartDay: 18 }));
    const monthCycle = renderHook(() => useMonthCycleStartDay()); // Month Cycle / Debt Planner read this
    const people = renderHook(() => useSelectedCycle()); // People Ledger's selected cycle
    expect(monthCycle.result.current).toBe(18);
    expect(formatCycleLabel(people.result.current[0])).toBe("18 Sep – 17 Oct 2026");

    openSettings();
    choose("10th");
    expect(monthCycle.result.current).toBe(18); // a draft does not leak to consumers
    act(() => {
      fireEvent.click(saveButton());
    });
    expect(monthCycle.result.current).toBe(10);
    expect(people.result.current[2]).toBe(10);
    const canon = cycleRangeFor(10, new Date());
    expect(people.result.current[0].start.getTime()).toBe(canon.start.getTime());
    expect(formatCycleLabel(people.result.current[0])).toBe("10 Sep – 09 Oct 2026");
  });
});
