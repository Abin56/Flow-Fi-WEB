import { describe, expect, it } from "vitest";
import { applyTokens, sanitizeStoredTheme } from "./apply";
import { hexToOklch } from "./color";
import { ACCENTS, SURFACES, type ThemeMode } from "./lime";
import { BASES, buildPaletteTokens, colourName, financialClash, slateFor, suggestCombos } from "./palette";
import { CUSTOM_ID, DEFAULT_CUSTOM, DEFAULT_THEME, MANAGED_TOKEN_NAMES, THEMES, type StoredTheme, isDefaultTheme, resolveTheme } from "./themes";

const MODES: ThemeMode[] = ["light", "dark"];
const parse = (v: string) => {
  const m = /oklch\(([\d.]+) ([\d.]+) ([\d.]+)/.exec(v)!;
  return { l: +m[1], c: +m[2], h: +m[3] };
};
const palettePresets = THEMES.filter((t) => t.spec);

describe("catalogue", () => {
  it("offers FlowFi Lime plus six genuinely different palette themes", () => {
    expect(THEMES[0].id).toBe("lime");
    expect(palettePresets.map((t) => t.id)).toEqual(["arctic", "graphite", "executive", "slate", "midnight", "ivory"]);
  });
  it("no two palette themes share the same base AND primary (no near-duplicates)", () => {
    const keys = palettePresets.map((t) => `${t.spec!.base}|${t.spec!.primary}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("every preset is readable in both modes", () => {
  for (const t of palettePresets) {
    for (const mode of MODES) {
      it(`${t.id} (${mode})`, () => {
        const { checks } = buildPaletteTokens(t.spec!, mode);
        expect(checks.filter((c) => !c.pass).map((c) => `${c.label} ${c.ratio}<${c.target}`)).toEqual([]);
      });
    }
  }
});

describe("backgrounds stay clean — colours are used with restraint", () => {
  for (const t of palettePresets) {
    for (const mode of MODES) {
      it(`${t.id} (${mode}): surfaces carry no colour from the primary or secondary`, () => {
        const { tokens } = buildPaletteTokens(t.spec!, mode);
        const base = BASES.find((b) => b.id === t.spec!.base)!;
        const baseHue = (mode === "dark" ? base.dark : base.light).h;
        for (const name of ["--background", "--card", "--popover", "--secondary", "--muted", "--sidebar", "--surface-elevated"]) {
          const o = parse(tokens[name]);
          expect(o.c, `${t.id} ${mode} ${name} chroma`).toBeLessThanOrEqual(0.045);
          if (o.c > 0.004) expect(Math.abs(o.h - baseHue), `${t.id} ${mode} ${name} hue`).toBeLessThan(1.5);
        }
      });
    }
  }
  it("Pure white is actually white: page, cards and popovers are exactly #fff", () => {
    const { tokens } = buildPaletteTokens({ base: "white", primary: "#1d62d8" }, "light");
    for (const name of ["--background", "--card", "--popover"]) expect(tokens[name]).toBe("oklch(1.000 0.000 260)");
  });
  it("the same primary produces identical surfaces regardless of hue (surfaces belong to the base)", () => {
    for (const mode of MODES) {
      const a = buildPaletteTokens({ base: "white", primary: "#dc2626" }, mode).tokens;
      const b = buildPaletteTokens({ base: "white", primary: "#16a34a", secondary: "#7c3aed" }, mode).tokens;
      for (const name of ["--background", "--card", "--border", "--sidebar", "--secondary", "--foreground"]) expect(a[name]).toBe(b[name]);
    }
  });
  it("hero panels are a single flat tone (no gradient between two colours)", () => {
    for (const t of palettePresets) {
      for (const mode of MODES) {
        const g = buildPaletteTokens(t.spec!, mode).tokens["--gradient-hero"];
        const stops = [...g.matchAll(/oklch\([^)]*\)/g)].map((m) => m[0]);
        expect(stops.length).toBe(2);
        expect(stops[0]).toBe(stops[1]);
      }
    }
  });
});

describe("financial meaning is never themed", () => {
  it("no palette theme overrides Money In, Money Out, warning or danger colours", () => {
    for (const t of palettePresets) {
      for (const mode of MODES) {
        const keys = Object.keys(buildPaletteTokens({ ...t.spec! }, mode).tokens);
        for (const forbidden of ["--success", "--expense", "--warning", "--danger", "--destructive", "--chart-3", "--chart-4", "--chart-5"]) {
          expect(keys).not.toContain(forbidden);
        }
      }
    }
  });
  it("every preset's primary stays visibly apart from the Money In / Money Out hues", () => {
    for (const t of palettePresets) expect(financialClash(t.spec!.primary), t.id).toBeNull();
  });
  it("flags a green or red primary", () => {
    expect(financialClash("#10b981")).toBe("in");
    expect(financialClash("#e11d48")).toBe("out");
    expect(financialClash("#2563eb")).toBeNull();
    expect(financialClash("#18181b")).toBeNull();
  });
});

describe("custom themes stay readable for any colour a user can pick", () => {
  const primaries = ["#ff0000", "#00ff00", "#0000ff", "#ffff00", "#ff00ff", "#00ffff", "#000000", "#ffffff", "#808080", "#f97316", "#7c3aed", "#0f766e", "#fde047", "#1e3a8a"];
  for (const primary of primaries) {
    for (const base of BASES) {
      for (const mode of MODES) {
        it(`${primary} on ${base.id} (${mode}), with and without a secondary`, () => {
          for (const secondary of [null, "#475569", "#ffe600", "#ffffff"]) {
            const { checks } = buildPaletteTokens({ base: base.id, primary, secondary }, mode);
            expect(checks.filter((c) => !c.pass).map((c) => `${c.label} ${c.ratio}`), `sec ${secondary}`).toEqual([]);
          }
        });
      }
    }
  }
});

describe("suggestions", () => {
  it("offers white, navy, graphite and white + slate pairings for a blue", () => {
    const s = suggestCombos("#2563eb");
    expect(s.map((x) => x.label)).toEqual(["White + Blue", "Navy + Blue", "Graphite + Blue", "White + Blue + Slate"]);
    expect(s.map((x) => x.base)).toEqual(["white", "navy", "black", "white"]);
    expect(s[3].secondary).toMatch(/^#[0-9a-f]{6}$/);
    expect(s[0].secondary).toBeNull();
  });
  it("the slate stays in the primary's family and is quiet", () => {
    const o = hexToOklch(slateFor("#2563eb"));
    expect(o.c).toBeLessThan(0.06);
    expect(Math.abs(o.h - hexToOklch("#2563eb").h)).toBeLessThan(12);
  });
  it("names colours sensibly", () => {
    expect(colourName("#2563eb")).toBe("Blue");
    expect(colourName("#dc2626")).toBe("Red");
    expect(colourName("#18181b")).toBe("Black");
    expect(colourName("#0f766e")).toBe("Teal");
  });
});

describe("token bookkeeping", () => {
  it("every theme only sets properties that are in the managed list (so reset clears everything)", () => {
    const managed = new Set(MANAGED_TOKEN_NAMES);
    const specs = [...palettePresets.map((t) => t.spec!), { base: "navy", primary: "#2563eb", secondary: "#64748b" }];
    for (const spec of specs) for (const mode of MODES) for (const k of Object.keys(buildPaletteTokens(spec, mode).tokens)) expect(managed.has(k), k).toBe(true);
  });
  it("resolveTheme: Lime is not flat, every other theme is", () => {
    expect(resolveTheme(DEFAULT_THEME, "light").flat).toBe(false);
    for (const t of palettePresets) expect(resolveTheme({ ...DEFAULT_THEME, id: t.id }, "dark").flat).toBe(true);
    expect(resolveTheme({ ...DEFAULT_THEME, id: CUSTOM_ID }, "light").flat).toBe(true);
  });
  it("themes carry no opinion about Light/Dark: the resolved theme has no mode hint, and every theme renders in both", () => {
    for (const t of THEMES) for (const mode of MODES) expect(Object.keys(resolveTheme({ ...DEFAULT_THEME, id: t.id }, mode))).toEqual(["tokens", "checks", "flat"]);
  });
  it("only untouched FlowFi Lime means 'no overrides'", () => {
    expect(isDefaultTheme(DEFAULT_THEME)).toBe(true);
    expect(isDefaultTheme({ ...DEFAULT_THEME, accent: ACCENTS[1].id })).toBe(false);
    expect(isDefaultTheme({ ...DEFAULT_THEME, surface: SURFACES[2].id })).toBe(false);
    expect(isDefaultTheme({ ...DEFAULT_THEME, id: "arctic" })).toBe(false);
  });
  it("applyTokens(null) clears every managed property, including ones painted before it ran", () => {
    const props = new Map<string, string>();
    const root = { style: { setProperty: (k: string, v: string) => void props.set(k, v), removeProperty: (k: string) => void props.delete(k) } } as unknown as HTMLElement;
    for (const [k, v] of Object.entries(buildPaletteTokens({ base: "navy", primary: "#2563eb", secondary: "#64748b" }, "dark").tokens)) props.set(k, v);
    expect(props.size).toBeGreaterThan(40);
    applyTokens(null, root);
    expect(props.size).toBe(0);
  });
});

describe("saved preferences", () => {
  it("keeps a valid current-shape theme untouched", () => {
    const stored: StoredTheme = { id: "executive", accent: "citron", surface: "sage", custom: { base: "soft", primary: "#112233", secondary: "#445566" } };
    expect(sanitizeStoredTheme(stored)).toEqual({ theme: stored, migrated: false });
  });
  it("starts from FlowFi Lime when nothing was saved", () => {
    expect(sanitizeStoredTheme(null)).toEqual({ theme: DEFAULT_THEME, migrated: false });
  });
  it("last release's {accent, surface} becomes FlowFi Lime with those options, and is rewritten", () => {
    const r = sanitizeStoredTheme({ accent: "citron", surface: "sage" });
    expect(r.migrated).toBe(true);
    expect(r.theme).toEqual({ ...DEFAULT_THEME, accent: "citron", surface: "sage" });
  });
  it("themes from the retired multi-theme picker map to FlowFi Lime", () => {
    for (const raw of [{ presetId: "ocean", seed: {} }, { presetId: "duo-black-white", seed: {}, duo: ["#111111", "#ffffff"] }, { presetId: "custom", seed: {} }, "garbage", 42]) {
      expect(sanitizeStoredTheme(raw)).toEqual({ theme: DEFAULT_THEME, migrated: true });
    }
  });
  it("repairs unknown ids and bad custom colours field by field", () => {
    const r = sanitizeStoredTheme({ id: "neon", accent: "pink", surface: "sage", custom: { base: "plaid", primary: "red", secondary: "#zzzzzz" } });
    expect(r.migrated).toBe(true);
    expect(r.theme).toEqual({ id: "lime", accent: "signature", surface: "sage", custom: DEFAULT_CUSTOM });
  });
});
