import { describe, expect, it } from "vitest";
import { validateAvatarFile, validateDisplayName, validatePhone } from "@/features/settings/lib/profile-validation";

describe("validateDisplayName", () => {
  it("trims and collapses whitespace", () => expect(validateDisplayName("  Abin   John ")).toEqual({ value: "Abin John", error: null }));
  it("rejects empty / whitespace-only", () => {
    expect(validateDisplayName("").error).toBeTruthy();
    expect(validateDisplayName("   ").error).toBeTruthy();
  });
  it("rejects over 60 chars", () => expect(validateDisplayName("a".repeat(61)).error).toBeTruthy());
  it("accepts exactly 60", () => expect(validateDisplayName("a".repeat(60)).error).toBeNull());
});

describe("validatePhone", () => {
  it("allows empty", () => expect(validatePhone("  ").error).toBeNull());
  it("accepts common formats", () => {
    for (const p of ["+91 98765 43210", "9876543210", "(044) 2345-6789"]) expect(validatePhone(p).error).toBeNull();
  });
  it("rejects letters and bad lengths", () => {
    expect(validatePhone("98abc").error).toBeTruthy();
    expect(validatePhone("12345").error).toBeTruthy();
    expect(validatePhone("1".repeat(16)).error).toBeTruthy();
  });
});

describe("validateAvatarFile", () => {
  it("accepts a small image", () => expect(validateAvatarFile({ type: "image/png", size: 1000 })).toBeNull());
  it("rejects non-images and oversize files", () => {
    expect(validateAvatarFile({ type: "application/pdf", size: 10 })).toBeTruthy();
    expect(validateAvatarFile({ type: "image/jpeg", size: 6 * 1024 * 1024 })).toBeTruthy();
  });
});
