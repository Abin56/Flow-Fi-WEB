import { describe, expect, it } from "vitest";
import {
  BYTES_PER_GB,
  BYTES_PER_MB,
  dedupeByPath,
  describeStorageLimitBlock,
  formatBytes,
  parseLimitMb,
  parseOwnedStoragePath,
  sectionForDocumentType,
  storageLevelMessage,
  summarizeStorage,
  wouldExceedLimit,
  type StorageFileRecord,
} from "./storage-usage";

function file(path: string, sizeBytes: number, over: Partial<StorageFileRecord> = {}): StorageFileRecord {
  return {
    path,
    fileName: path.split("/").pop()!,
    sectionId: "credit_card_statement",
    sectionLabel: "Imported card statements",
    contentType: "application/pdf",
    sizeBytes,
    uploadedAt: null,
    displayName: "Statement PDF",
    documentIds: ["d1"],
    accountIds: ["a1"],
    documentStatuses: ["parsed"],
    ...over,
  };
}

describe("summarizeStorage", () => {
  it("sums real sizes, counts files and computes remaining/percent", () => {
    const s = summarizeStorage([file("p/a", 100 * BYTES_PER_MB), file("p/b", 50 * BYTES_PER_MB)], 500 * BYTES_PER_MB);
    expect(s.usedBytes).toBe(150 * BYTES_PER_MB);
    expect(s.remainingBytes).toBe(350 * BYTES_PER_MB);
    expect(s.percentUsed).toBeCloseTo(30);
    expect(s.fileCount).toBe(2);
    expect(s.level).toBe("ok");
  });

  it("counts an object once even when several records reference it (no double counting)", () => {
    const s = summarizeStorage(
      [file("p/a", 10 * BYTES_PER_MB, { documentIds: ["d1"] }), file("p/a", 10 * BYTES_PER_MB, { documentIds: ["d2"], accountIds: ["a2"] })],
      100 * BYTES_PER_MB,
    );
    expect(s.usedBytes).toBe(10 * BYTES_PER_MB);
    expect(s.fileCount).toBe(1);
    expect(dedupeByPath([file("p/a", 1, { documentIds: ["d1"] }), file("p/a", 1, { documentIds: ["d2"] })])[0]!.documentIds).toEqual(["d1", "d2"]);
  });

  it("groups by section, largest first, with shares that add to 100", () => {
    const s = summarizeStorage(
      [file("p/a", 30), file("p/b", 10, { sectionId: "bank_statement", sectionLabel: "Other documents (bank statement)" })],
      1000,
    );
    expect(s.sections.map((x) => x.id)).toEqual(["credit_card_statement", "bank_statement"]);
    expect(s.sections.reduce((n, x) => n + x.sharePercent, 0)).toBeCloseTo(100);
    expect(s.sections[0]!.fileCount).toBe(1);
  });

  it("is empty-safe", () => {
    const s = summarizeStorage([], 500 * BYTES_PER_MB);
    expect(s).toMatchObject({ usedBytes: 0, fileCount: 0, percentUsed: 0, level: "ok", sections: [] });
    expect(storageLevelMessage(s)).toBeNull();
  });

  it("flags warning at 80%, full at exactly the limit and over when the limit is below usage", () => {
    expect(summarizeStorage([file("p/a", 80)], 100).level).toBe("warning");
    expect(summarizeStorage([file("p/a", 79)], 100).level).toBe("ok");
    expect(summarizeStorage([file("p/a", 100)], 100).level).toBe("full");
    const over = summarizeStorage([file("p/a", 150)], 100);
    expect(over.level).toBe("over");
    expect(over.remainingBytes).toBe(0);
    expect(storageLevelMessage(over)).toMatch(/over your/);
  });
});

describe("limits", () => {
  it("blocks only when the upload would go past the limit (reaching it exactly is allowed)", () => {
    expect(wouldExceedLimit(90, 10, 100)).toBe(false);
    expect(wouldExceedLimit(90, 11, 100)).toBe(true);
    expect(wouldExceedLimit(100, 0, 100)).toBe(false);
    expect(wouldExceedLimit(120, 0, 100)).toBe(true);
  });

  it("explains the block with real numbers", () => {
    const msg = describeStorageLimitBlock(490 * BYTES_PER_MB, 20 * BYTES_PER_MB, 500 * BYTES_PER_MB);
    expect(msg).toContain("20 MB");
    expect(msg).toContain("10 MB is left");
    expect(msg).toContain("490 MB");
    expect(msg).toContain("500 MB");
  });

  it("parses and validates the custom limit field", () => {
    expect(parseLimitMb("700")).toEqual({ ok: true, bytes: 700 * BYTES_PER_MB });
    expect(parseLimitMb(" 1,024 ")).toEqual({ ok: true, bytes: 1024 * BYTES_PER_MB });
    expect(parseLimitMb("0.5")).toMatchObject({ ok: false });
    expect(parseLimitMb("")).toMatchObject({ ok: false });
    expect(parseLimitMb("abc")).toMatchObject({ ok: false });
    expect(parseLimitMb("-5")).toMatchObject({ ok: false });
    expect(parseLimitMb("200000")).toMatchObject({ ok: false });
  });
});

describe("helpers", () => {
  it("formats bytes", () => {
    expect(formatBytes(0)).toBe("0 MB");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(1.5 * BYTES_PER_MB)).toBe("1.5 MB");
    expect(formatBytes(500 * BYTES_PER_MB)).toBe("500 MB");
    expect(formatBytes(1.5 * BYTES_PER_GB)).toBe("1.5 GB");
    expect(formatBytes(BYTES_PER_GB)).toBe("1 GB");
  });

  it("only accepts paths inside the signed-in user's documents folder", () => {
    expect(parseOwnedStoragePath("users/u1/documents/credit_card_statement/h.pdf", "u1")).toEqual({ documentType: "credit_card_statement", fileName: "h.pdf" });
    expect(parseOwnedStoragePath("users/u2/documents/credit_card_statement/h.pdf", "u1")).toBeNull();
    expect(parseOwnedStoragePath("users/u1/avatars/x.png", "u1")).toBeNull();
    expect(parseOwnedStoragePath("users/u1/documents/a/b/c.pdf", "u1")).toBeNull();
  });

  it("labels known and unknown document types", () => {
    expect(sectionForDocumentType("credit_card_statement").label).toBe("Imported card statements");
    expect(sectionForDocumentType("bank_statement").label).toBe("Other documents (bank statement)");
  });
});
