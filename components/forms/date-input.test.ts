import { describe, expect, it } from "vitest";
import { displayToIsoDate, isoToDisplayDate } from "./date-input";

describe("date-input conversions", () => {
  it("shows a stored yyyy-mm-dd date as dd/mm/yyyy", () => {
    expect(isoToDisplayDate("2026-10-05")).toBe("05/10/2026");
    expect(isoToDisplayDate("")).toBe("");
    expect(isoToDisplayDate("garbage")).toBe("");
  });

  it("reads dd/mm/yyyy back as yyyy-mm-dd (day first, never month first)", () => {
    expect(displayToIsoDate("05/10/2026")).toBe("2026-10-05");
    expect(displayToIsoDate("31/12/2025")).toBe("2025-12-31");
    expect(displayToIsoDate("29/02/2024")).toBe("2024-02-29");
  });

  it("returns '' for incomplete text and for dates that don't exist", () => {
    expect(displayToIsoDate("05/10/20")).toBe("");
    expect(displayToIsoDate("31/04/2026")).toBe("");
    expect(displayToIsoDate("29/02/2025")).toBe("");
    expect(displayToIsoDate("10/13/2026")).toBe("");
    expect(displayToIsoDate("00/10/2026")).toBe("");
  });
});
