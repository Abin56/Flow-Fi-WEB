// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CarriedForwardNote, type CarriedForward } from "./person-activity-feed";

/**
 * The "money from before this cycle" line, both directions: still unpaid, part paid, and paid since — so a
 * settled cycle never shows earlier money as still owed. Display only.
 */

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));
vi.mock("next/link", () => ({ default: ({ children }: { children: React.ReactNode }) => children }));
afterEach(cleanup);

const text = (carried: CarriedForward) => render(<CarriedForwardNote carried={carried} personName="Sojan K" />).container.textContent!.replace(/\s+/g, " ");

describe("CarriedForwardNote", () => {
  it("paid since the cycle started: says it was owed and is now fully paid — not still owed", () => {
    const s = text({ amount: 745.49, direction: "theyOwe", left: 0 });
    expect(s).toContain("From previous months");
    expect(s).toContain("₹745.49");
    expect(s).toContain("Sojan owed you this when the cycle started");
    expect(s).toContain("Now fully paid");
    expect(s).not.toMatch(/unpaid|still needs/i);
    cleanup();
    expect(text({ amount: 300, direction: "iOwe", left: 0 })).toContain("You owed Sojan this when the cycle started");
  });

  it("still unpaid, in either direction", () => {
    const s = text({ amount: 745.49, direction: "theyOwe", left: 745.49 });
    expect(s).toContain("Previous unpaid amount");
    expect(s).toContain("Sojan still needs to pay you this");
    expect(s).not.toContain("left of");
    expect(s).not.toContain("fully paid");
    cleanup();
    expect(text({ amount: 300, direction: "iOwe", left: 300 })).toContain("You still need to pay Sojan this");
  });

  it("part paid: shows what is left of the starting amount", () => {
    const s = text({ amount: 745.49, direction: "theyOwe", left: 545.49 });
    expect(s).toContain("₹545.49");
    expect(s).toContain("left of ₹745.49");
  });

  it("nothing from before this cycle: renders nothing", () => {
    expect(render(<CarriedForwardNote carried={null} personName="Sojan" />).container.textContent).toBe("");
  });
});
