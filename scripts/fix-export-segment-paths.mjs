#!/usr/bin/env node
/**
 * Post-build fix for a Next.js static-export bug that made EVERY page navigation wait on the network.
 *
 *   node scripts/fix-export-segment-paths.mjs [outDir]      (runs automatically after `next build`, see package.json)
 *
 * What goes wrong: with `output: "export"`, Next's client router prefetches each page's data as flat files named
 *   <route>/__next.!KGFwcCk.people.__PAGE__.txt          (segment path with "/" replaced by ".")
 * `next build` writes them using the OS path separator, so on Windows they land as nested folders instead:
 *   <route>/__next.!KGFwcCk/people/__PAGE__.txt
 * The client's requests for the flat names then 404, the prefetch is rejected, and every sidebar click falls back to a
 * blocking full-route request (`<route>/index.txt`) — a server round trip (plus a retry of every failed prefetch) per
 * click, on revisits too. Measured: with 100 ms network latency each navigation spent its time waiting for that file.
 *
 * What this does: for every `__next.*` folder under `out/`, copies each file to the flat name the client asks for. It only
 * ADDS files (the nested copies are left alone), so it is a no-op on Linux/macOS builds, where the flat files already
 * exist, and it is safe to run more than once.
 */

import { copyFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Every file below `dir`, as a path relative to it, always with "/" separators. */
function listFiles(dir, prefix = "") {
  const found = [];
  for (const name of readdirSync(dir)) {
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(join(dir, name)).isDirectory()) found.push(...listFiles(join(dir, name), rel));
    else found.push(rel);
  }
  return found;
}

/**
 * The flat file the client router requests for a nested segment file.
 * `("__next.!KGFwcCk", "people/__PAGE__.txt")` → `"__next.!KGFwcCk.people.__PAGE__.txt"`
 * (mirrors Next's `convertSegmentPathToStaticExportFilename`: "/" in the segment path becomes ".").
 */
export function flatSegmentFilename(folderName, relativeFile) {
  return `${folderName}.${relativeFile.split("/").join(".")}`;
}

/** Walks `outDir`; returns how many flat files were created. */
export function flattenSegmentFolders(outDir) {
  let created = 0;
  const visit = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (!statSync(full).isDirectory()) continue;
      if (name.startsWith("__next.")) {
        for (const rel of listFiles(full)) {
          const target = join(dir, flatSegmentFilename(name, rel));
          if (existsSync(target)) continue;
          copyFileSync(join(full, ...rel.split("/")), target);
          created += 1;
        }
      } else if (name !== "_next") {
        visit(full);
      }
    }
  };
  visit(outDir);
  return created;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const outDir = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "out"));
  if (!existsSync(outDir)) {
    console.error(`fix-export-segment-paths: ${outDir} does not exist — run \`next build\` first.`);
    process.exit(1);
  }
  const created = flattenSegmentFolders(outDir);
  console.log(
    created > 0
      ? `fix-export-segment-paths: added ${created} flat segment file(s) the client router requests (this build wrote them nested; separator "${sep}").`
      : "fix-export-segment-paths: segment files already in the layout the client requests — nothing to do.",
  );
}
