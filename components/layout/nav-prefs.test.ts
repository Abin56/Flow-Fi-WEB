import { describe, expect, it } from "vitest";
import { DEFAULT_PINS, NAV_BY_HREF, NAV_ITEMS, navItemForPath } from "@/components/layout/nav-items";
import { MAX_PINS, MAX_RECENTS, previousPage, pushRecent, sanitizeHrefs, togglePinned } from "@/components/layout/nav-prefs";

describe("navigation model", () => {
  it("every page has a unique single-letter g-chord, and none is the reserved 'g'", () => {
    const chords = NAV_ITEMS.map((i) => i.chord);
    expect(chords.every((c) => /^[a-z]$/.test(c))).toBe(true);
    expect(new Set(chords).size).toBe(chords.length);
    expect(chords).not.toContain("g");
  });

  it("default pins are real pages and fit the tile row", () => {
    expect(DEFAULT_PINS.length).toBeLessThanOrEqual(MAX_PINS);
    expect(DEFAULT_PINS.every((h) => NAV_BY_HREF.has(h))).toBe(true);
  });

  it("maps a pathname to its menu entry, including folded legacy routes and sub-pages", () => {
    expect(navItemForPath("/accounts")?.href).toBe("/accounts");
    expect(navItemForPath("/accounts/abc123")?.href).toBe("/accounts");
    expect(navItemForPath("/emi")?.href).toBe("/loans");
    expect(navItemForPath("/nowhere")).toBeUndefined();
  });
});

describe("pins", () => {
  it("adds, removes, and refuses to exceed the tile row", () => {
    expect(togglePinned(["/accounts"], "/loans")).toEqual(["/accounts", "/loans"]);
    expect(togglePinned(["/accounts", "/loans"], "/loans")).toEqual(["/accounts"]);
    const full = DEFAULT_PINS.slice(0, MAX_PINS);
    expect(togglePinned(full, "/reports")).toBe(full); // same reference → no write
  });
});

describe("recents", () => {
  it("moves a revisited page to the front without duplicates", () => {
    expect(pushRecent(["/a", "/b", "/c"], "/c")).toEqual(["/c", "/a", "/b"]);
  });

  it("returns the same array when the page is already first (no needless write)", () => {
    const r = ["/accounts", "/loans"];
    expect(pushRecent(r, "/accounts")).toBe(r);
  });

  it("is capped", () => {
    let r: string[] = [];
    for (let i = 0; i < MAX_RECENTS + 4; i++) r = pushRecent(r, `/p${i}`);
    expect(r).toHaveLength(MAX_RECENTS);
    expect(r[0]).toBe(`/p${MAX_RECENTS + 3}`);
  });

  it("previous page = most recent one that is not the current page", () => {
    expect(previousPage(["/loans", "/accounts", "/dashboard"], "/loans")).toBe("/accounts");
    expect(previousPage(["/loans"], "/loans")).toBeUndefined();
    expect(previousPage(["/accounts", "/loans"], undefined)).toBe("/accounts");
  });
});

describe("stored data is never trusted", () => {
  it("drops unknown/duplicate/non-string entries (a removed page must not leave a dead tile)", () => {
    expect(sanitizeHrefs(["/accounts", "/budgets", "/accounts", 7, null, "/loans"], 4)).toEqual(["/accounts", "/loans"]);
    expect(sanitizeHrefs("nope", 4)).toEqual([]);
    expect(sanitizeHrefs(DEFAULT_PINS.concat(["/reports"]), 2)).toHaveLength(2);
  });
});
