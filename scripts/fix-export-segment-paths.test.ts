import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { flatSegmentFilename, flattenSegmentFolders } from "./fix-export-segment-paths.mjs";

let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function exportWithNestedSegments() {
  dir = mkdtempSync(join(tmpdir(), "flowfi-export-"));
  mkdirSync(join(dir, "people", "__next.!KGFwcCk", "people"), { recursive: true });
  writeFileSync(join(dir, "people", "__next.!KGFwcCk", "people", "__PAGE__.txt"), "segment");
  writeFileSync(join(dir, "people", "__next._tree.txt"), "tree");
  mkdirSync(join(dir, "_next", "static", "__next.fake"), { recursive: true }); // build assets are never touched
  writeFileSync(join(dir, "_next", "static", "__next.fake", "x.js"), "js");
  return dir;
}

describe("static export segment paths", () => {
  it("names the flat file the way Next's client router requests it", () => {
    expect(flatSegmentFilename("__next.!KGFwcCk", "people/__PAGE__.txt")).toBe("__next.!KGFwcCk.people.__PAGE__.txt");
    expect(flatSegmentFilename("__next.!KGFwcCk", "a/b/__PAGE__.txt")).toBe("__next.!KGFwcCk.a.b.__PAGE__.txt");
  });

  it("adds the flat copy next to a nested one (a Windows build) and leaves everything else alone", () => {
    const out = exportWithNestedSegments();
    expect(flattenSegmentFolders(out)).toBe(1);
    expect(readFileSync(join(out, "people", "__next.!KGFwcCk.people.__PAGE__.txt"), "utf8")).toBe("segment");
    expect(existsSync(join(out, "people", "__next.!KGFwcCk", "people", "__PAGE__.txt"))).toBe(true);
    expect(readFileSync(join(out, "people", "__next._tree.txt"), "utf8")).toBe("tree");
    expect(existsSync(join(out, "_next", "static", "__next.fake.x.js"))).toBe(false);
  });

  it("is a no-op when run twice, and when the build already wrote flat files (Linux/macOS)", () => {
    const out = exportWithNestedSegments();
    flattenSegmentFolders(out);
    expect(flattenSegmentFolders(out)).toBe(0);
    rmSync(join(out, "people", "__next.!KGFwcCk"), { recursive: true });
    expect(flattenSegmentFolders(out)).toBe(0);
    expect(existsSync(join(out, "people", "__next.!KGFwcCk.people.__PAGE__.txt"))).toBe(true);
  });
});
