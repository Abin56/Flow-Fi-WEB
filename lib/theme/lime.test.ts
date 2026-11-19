import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { type Oklch, contrast, css, hexToOklch, oklchToHex } from "./color";
import {
  ACCENTS,
  DEFAULT_ACCENT_ID,
  DEFAULT_SURFACE_ID,
  FINANCIAL,
  MANAGED_TOKEN_NAMES,
  SURFACES,
  type ThemeMode,
  buildTokens,
  isDefaultSelection,
} from "./lime";

const MODES: ThemeMode[] = ["light", "dark"];
const defaultAccent = ACCENTS.find((a) => a.id === DEFAULT_ACCENT_ID)!;
const defaultSurface = SURFACES.find((s) => s.id === DEFAULT_SURFACE_ID)!;

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

describe("every curated accent × surface × mode is readable", () => {
  for (const accent of ACCENTS) {
    for (const surface of SURFACES) {
      for (const mode of MODES) {
        it(`${accent.id} + ${surface.id} (${mode})`, () => {
          const { checks } = buildTokens(accent, surface, mode);
          expect(checks.filter((c) => !c.pass).map((c) => `${c.label} ${c.ratio}<${c.target}`)).toEqual([]);
        });
      }
    }
  }
});

describe("financial colour semantics", () => {
  const lab = ({ l, c, h }: Oklch) => [l, c * Math.cos((h * Math.PI) / 180), c * Math.sin((h * Math.PI) / 180)];
  const dE = (x: Oklch, y: Oklch) => {
    const [p, q] = [lab(x), lab(y)];
    return 100 * Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
  };
  const parse = (v: string): Oklch => {
    const m = /oklch\(([\d.]+) ([\d.]+) ([\d.]+)/.exec(v)!;
    return { l: +m[1], c: +m[2], h: +m[3] };
  };

  for (const mode of MODES) {
    it(`${mode}: Money In and Money Out are clearly different colours`, () => {
      expect(dE(FINANCIAL[mode].success, FINANCIAL[mode].expense)).toBeGreaterThan(25);
    });
    for (const accent of ACCENTS) {
      it(`${mode}: ${accent.id} lime never reads as Money In (fill and chart ink)`, () => {
        const { tokens } = buildTokens(accent, defaultSurface, mode);
        // Light surfaces: lime ink is far darker than the emerald; dark surfaces: both are bright, so the floor is lower.
        const floor = mode === "light" ? 14 : 11;
        expect(dE(parse(tokens["--primary"]), FINANCIAL[mode].success)).toBeGreaterThan(floor);
        expect(dE(parse(tokens["--chart-1"]), FINANCIAL[mode].success)).toBeGreaterThan(floor);
      });
    }
  }
  it("keeps every lime accent inside the lime hue family, away from the Money-In emerald", () => {
    for (const a of ACCENTS) {
      expect(a.hue).toBeGreaterThanOrEqual(105);
      expect(a.hue).toBeLessThanOrEqual(130);
    }
  });
});

describe("token set", () => {
  it("every combination sets exactly the same custom properties, so clearing them is complete", () => {
    const names = new Set(MANAGED_TOKEN_NAMES);
    for (const a of ACCENTS) {
      for (const s of SURFACES) {
        for (const m of MODES) {
          expect(Object.keys(buildTokens(a, s, m).tokens).sort()).toEqual([...names].sort());
        }
      }
    }
  });
  it("only ever emits oklch colours, gradients and shadows (no stray hex)", () => {
    for (const m of MODES) {
      for (const [name, value] of Object.entries(buildTokens(defaultAccent, defaultSurface, m).tokens)) {
        expect(value, name).not.toMatch(/#[0-9a-f]{3,8}\b/i);
      }
    }
  });
  it("the default selection means 'no overrides'", () => {
    expect(isDefaultSelection(DEFAULT_ACCENT_ID, DEFAULT_SURFACE_ID)).toBe(true);
    expect(isDefaultSelection("citron", DEFAULT_SURFACE_ID)).toBe(false);
    expect(isDefaultSelection(DEFAULT_ACCENT_ID, "sage")).toBe(false);
  });
});

/**
 * The stock stylesheet IS the default theme (it paints with no JavaScript), and the generator in lime.ts produces
 * the same tokens for users who pick a different accent/surface. If they ever disagree, switching between the
 * default and a customised look would shift more than the chosen colour — so this fails loudly on any drift.
 */
describe("app/globals.css matches the generator for the default selection", () => {
  const sheetText = readFileSync(path.join(__dirname, "..", "..", "app", "globals.css"), "utf8").replace(/\r\n/g, "\n").replace(/\/\*[\s\S]*?\*\//g, "");

  /** Custom properties declared in rule blocks whose selector is exactly one of `selectors`. */
  function declared(selectors: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    const rule = /(^|\n)([^{}\n][^{}]*)\{([^{}]*)\}/g;
    for (let m = rule.exec(sheetText); m; m = rule.exec(sheetText)) {
      const selector = m[2].replace(/\s+/g, " ").trim();
      if (!selectors.includes(selector)) continue;
      for (const d of m[3].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[d[1]] = d[2].replace(/\s+/g, " ").trim();
    }
    return out;
  }
  /** Compares values as tokens with numbers normalised, so `0.890` and `0.89` are equal. */
  const norm = (v: string) => v.replace(/-?\d*\.?\d+/g, (n) => String(Number(n))).replace(/\s+/g, " ");

  for (const mode of MODES) {
    it(`${mode} tokens`, () => {
      const sheet = declared(mode === "light" ? [":root, .light", ":root"] : [".dark"]);
      const generated = buildTokens(defaultAccent, defaultSurface, mode).tokens;
      const mismatches = Object.entries(generated)
        .filter(([name, value]) => norm(sheet[name] ?? "<missing>") !== norm(value))
        .map(([name, value]) => `${name}: stylesheet=${sheet[name] ?? "<missing>"} generator=${value}`);
      expect(mismatches).toEqual([]);
    });
    it(`${mode} Money In / Money Out in the stylesheet match the colours the readability checks measure`, () => {
      const sheet = declared(mode === "light" ? [":root, .light", ":root"] : [".dark"]);
      expect(norm(sheet["--success"])).toBe(norm(css(FINANCIAL[mode].success)));
      expect(norm(sheet["--expense"])).toBe(norm(css(FINANCIAL[mode].expense)));
    });
  }
});
