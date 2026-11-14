import { describe, expect, it, vi } from "vitest";
import { accountPaletteFor, colorValueForAccountColor, namedAccountColor } from "@/features/accounts/lib/account-colors";
import { colorValueForCardAccent, customCardColor, pickedCardAccent } from "@/features/credit-cards/hooks/use-credit-cards-data";
import { argbToHex, hexToArgb, isArgbColorValue, resolveColorValue } from "@/lib/account-color";

vi.mock("@/lib/firebase/client", () => ({ firebaseApp: {}, auth: {}, db: {}, storage: {} }));

// Mobile (Flutter) writes Color.toARGB32() — e.g. cardTintPalette[0] = Color(0xFF1565C0).
const MOBILE_BLUE = 0xff1565c0;

describe("ARGB colorValue shared with the mobile app", () => {
  it("round-trips hex <-> ARGB in the unsigned form Dart stores", () => {
    expect(hexToArgb("#1565c0")).toBe(MOBILE_BLUE);
    expect(argbToHex(MOBILE_BLUE)).toBe("#1565c0");
    expect(hexToArgb("#000000")).toBe(0xff000000);
  });

  it("tells ARGB from legacy web list indexes", () => {
    expect(isArgbColorValue(MOBILE_BLUE)).toBe(true);
    expect(isArgbColorValue(0)).toBe(false);
    expect(isArgbColorValue(11)).toBe(false);
  });

  it("keeps legacy web indexes looking the same (accounts v%12, cards index+1)", () => {
    expect(resolveColorValue(2, "account")).toBe(hexToArgb("#3b82f6")); // blue
    expect(resolveColorValue(1, "card")).toBe(hexToArgb("#2563eb")); // CARD_ACCENTS[0] primary
    expect(resolveColorValue(0, "card")).toBeNull(); // never picked
    expect(pickedCardAccent(2)).toBe("purple");
  });

  it("an account colour picked on web is stored as ARGB, and reads back as the same swatch", () => {
    const stored = colorValueForAccountColor("navy");
    expect(isArgbColorValue(stored)).toBe(true);
    expect(namedAccountColor(stored)).toBe("navy");
  });

  it("a card colour picked on web is stored as ARGB and reads back as the same swatch", () => {
    const stored = colorValueForCardAccent("teal");
    expect(isArgbColorValue(stored)).toBe(true);
    expect(pickedCardAccent(stored)).toBe("teal");
    expect(customCardColor(stored)).toBeNull();
  });

  it("renders a colour picked on mobile that is not a web swatch, exactly", () => {
    expect(customCardColor(MOBILE_BLUE)).toBe(MOBILE_BLUE);
    const palette = accountPaletteFor(MOBILE_BLUE);
    expect(palette.stroke).toBe("#1565c0");
    expect(palette.gradient).toContain("#1565c0");
    expect(palette.onGradient).toBe("text-white");
  });

  it("picks dark text on a pale mobile colour", () => {
    expect(accountPaletteFor(0xfffff59d).onGradient).toBe("text-slate-900"); // pale yellow
  });
});
