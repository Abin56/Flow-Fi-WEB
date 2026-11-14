import { describe, expect, it } from "vitest";
import { contrast, hexToOklch, oklchToHex } from "./color";
import { deriveTheme, duoPrefersDark, seedFromDuo, suggestFromPrimary } from "./derive";
import { DUO_PRESETS, THEME_PRESETS } from "./presets";

describe("color math", () => {
  it("round-trips hex through OKLCH", () => {
    for (const hex of ["#b9f65a", "#2563eb", "#3f3f46", "#ffffff", "#000000"]) {
      expect(oklchToHex(hexToOklch(hex))).toBe(hex);
    }
  });
  it("computes WCAG contrast", () => {
    expect(contrast(hexToOklch("#000000"), hexToOklch("#ffffff"))).toBeCloseTo(21, 0);
  });
});

describe("deriveTheme", () => {
  for (const preset of THEME_PRESETS) {
    for (const mode of ["light", "dark"] as const) {
      it(`${preset.id}/${mode}: text and primary-label checks reach 4.5:1`, () => {
        const { tokens, checks } = deriveTheme(preset.seed, mode);
        for (const label of ["Text on page", "Text on cards", "Secondary text", "Button label on primary", "Primary as text on cards", "Text on sidebar"]) {
          const c = checks.find((x) => x.label === label)!;
          expect(c.ratio, `${preset.id} ${mode} ${label}`).toBeGreaterThanOrEqual(4.5);
        }
        expect(tokens["--primary"]).toMatch(/^oklch\(/);
      });
    }
  }
  it("suggests a valid, readable full seed from any primary", () => {
    for (const hex of ["#ff0000", "#00ff00", "#0000ff", "#ffff00", "#101010", "#fafafa"]) {
      const seed = suggestFromPrimary(hex);
      for (const v of Object.values(seed)) expect(v).toMatch(/^#[0-9a-f]{6}$/);
      for (const mode of ["light", "dark"] as const) {
        const { checks } = deriveTheme(seed, mode);
        expect(checks.filter((c) => c.target === 4.5 && !c.pass).map((c) => c.label)).toEqual([]);
      }
    }
  });
});

describe("two-colour themes", () => {
  it("every duo preset passes all text checks in both modes", () => {
    for (const d of DUO_PRESETS) {
      for (const mode of ["light", "dark"] as const) {
        const { checks } = deriveTheme(seedFromDuo(d.a, d.b), mode);
        expect(checks.filter((c) => !c.pass).map((c) => `${d.id} ${mode} ${c.label}`)).toEqual([]);
      }
    }
  });
  it("a neutral colour 2 becomes the base; a near-white colour 1 swaps with a hue", () => {
    expect(seedFromDuo("#1d4ed8", "#ffffff").primary).toBe("#1d4ed8");
    expect(seedFromDuo("#ffffff", "#1d4ed8").primary).toBe("#1d4ed8");
    expect(seedFromDuo("#1e3a8a", "#c9a227").secondary).toBe("#c9a227");
    expect(duoPrefersDark("#ffffff", "#0a0a0a")).toBe(true);
    expect(duoPrefersDark("#111111", "#ffffff")).toBe(false);
  });
});
