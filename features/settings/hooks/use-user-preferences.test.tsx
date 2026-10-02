// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import type { User } from "firebase/auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSelectedCycle } from "@/features/people/hooks/use-selected-cycle";
import { DEFAULT_PREFERENCES, useMonthCycleStartDay, useUserPreferences } from "@/features/settings/hooks/use-user-preferences";
import { cycleRangeFor } from "@/lib/engines/month-cycle-range";
import { formatCycleLabel } from "@/lib/engines/person-cycle-statement";
import { useAuthStore } from "@/store/auth-store";

/**
 * The ONE global accounting-cycle preference: default, persistence across reload, live propagation from
 * Settings to every mounted consumer, and People's selected cycle following it.
 */

const UID = "user-1";
const KEY = `flowfi:user-preferences:${UID}`;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 1, 12)); // 1 Oct 2026
  window.localStorage.clear();
  useAuthStore.setState({ user: { uid: UID } as User, status: "signed-in" });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useAuthStore.setState({ user: null, status: "loading" });
});

describe("monthCycleStartDay preference", () => {
  it("defaults to 1 (calendar month) when nothing is stored", () => {
    expect(DEFAULT_PREFERENCES.monthCycleStartDay).toBe(1);
    const { result } = renderHook(() => useMonthCycleStartDay());
    expect(result.current).toBe(1);
  });

  it("persists across a reload (unmount + fresh mount) for the signed-in user", () => {
    const first = renderHook(() => useUserPreferences());
    act(() => first.result.current.update("monthCycleStartDay", 18));
    expect(JSON.parse(window.localStorage.getItem(KEY)!).monthCycleStartDay).toBe(18);
    first.unmount();
    const reloaded = renderHook(() => useMonthCycleStartDay());
    expect(reloaded.result.current).toBe(18);
  });

  it("a change in Settings reaches every other mounted consumer immediately (no reload)", () => {
    const settings = renderHook(() => useUserPreferences());
    const monthCycle = renderHook(() => useMonthCycleStartDay());
    const people = renderHook(() => useMonthCycleStartDay());
    act(() => settings.result.current.update("monthCycleStartDay", 18));
    expect(monthCycle.result.current).toBe(18);
    expect(people.result.current).toBe(18);
    act(() => settings.result.current.update("monthCycleStartDay", 10));
    expect(monthCycle.result.current).toBe(10);
    expect(people.result.current).toBe(10);
    // Other preferences survive untouched.
    expect(settings.result.current.preferences.currency).toBe(DEFAULT_PREFERENCES.currency);
  });

  it("an invalid stored value falls back to a supported start day", () => {
    window.localStorage.setItem(KEY, JSON.stringify({ monthCycleStartDay: "garbage" }));
    expect(renderHook(() => useMonthCycleStartDay()).result.current).toBe(1);
    window.localStorage.setItem(KEY, JSON.stringify({ monthCycleStartDay: 45 }));
    expect(renderHook(() => useMonthCycleStartDay()).result.current).toBe(31);
  });
});

describe("People selected cycle follows the global setting", () => {
  it("opens on the current global cycle and re-resolves when the setting changes 18 → 10", () => {
    window.localStorage.setItem(KEY, JSON.stringify({ monthCycleStartDay: 18 }));
    const settings = renderHook(() => useUserPreferences());
    const people = renderHook(() => useSelectedCycle());
    expect(formatCycleLabel(people.result.current[0])).toBe("18 Sep – 17 Oct 2026");

    act(() => settings.result.current.update("monthCycleStartDay", 10));
    expect(formatCycleLabel(people.result.current[0])).toBe("10 Sep – 09 Oct 2026");
    // The same window Month Cycle shows for the same setting.
    const canon = cycleRangeFor(10, new Date());
    expect(people.result.current[0].start.getTime()).toBe(canon.start.getTime());
    expect(people.result.current[2]).toBe(10);
  });
});
