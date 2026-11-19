import { describe, expect, it } from "vitest";
import { readSelectedRow, selectionKey, writeSelectedRow } from "./selected-row";

function memory(): Storage {
  const data = new Map<string, string>();
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) } as Storage;
}

describe("remembered review row", () => {
  it("returns the row saved for the same capture and account", () => {
    const store = memory();
    const key = selectionKey("fp1", "acc1");
    writeSelectedRow(key, "r3", store);
    expect(readSelectedRow(key, store)).toBe("r3");
  });

  it("never lends a row to a different capture or account", () => {
    const store = memory();
    writeSelectedRow(selectionKey("fp1", "acc1"), "r3", store);
    expect(readSelectedRow(selectionKey("fp2", "acc1"), store)).toBeNull();
    expect(readSelectedRow(selectionKey("fp1", "acc2"), store)).toBeNull();
  });

  it("treats unreadable or blocked storage as nothing remembered", () => {
    const broken = { getItem: () => "{not json", setItem: () => { throw new Error("blocked"); } } as unknown as Storage;
    expect(readSelectedRow("k", broken)).toBeNull();
    expect(() => writeSelectedRow("k", "r1", broken)).not.toThrow();
    expect(readSelectedRow("k", null)).toBeNull();
  });
});
