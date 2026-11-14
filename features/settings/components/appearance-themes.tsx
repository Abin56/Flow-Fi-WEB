"use client";

import { ArrowLeftRight, Check, RotateCcw, Sparkles } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useMemo, useState } from "react";
import { isHex } from "@/lib/theme/color";
import { type ThemeSeed, deriveTheme, duoPrefersDark, suggestFromPrimary } from "@/lib/theme/derive";
import { DEFAULT_PRESET_ID, DUO_PRESETS, THEME_PRESETS } from "@/lib/theme/presets";
import { cn } from "@/lib/utils";
import { useThemeStore } from "@/store/theme-store";

const CARD = "rounded-[20px] border border-border/60 bg-card p-5 shadow-e1";

const COLOR_FIELDS: { key: keyof ThemeSeed; label: string; hint: string }[] = [
  { key: "primary", label: "Primary", hint: "Buttons, active navigation, highlights" },
  { key: "secondary", label: "Secondary", hint: "Charts, transfers, information accents" },
  { key: "accent", label: "Accent", hint: "Hover and selected washes" },
  { key: "background", label: "Background", hint: "Page canvas and neutral surface tint" },
  { key: "sidebar", label: "Sidebar & drawer", hint: "Navigation rail and mobile drawer" },
];

function ColorRow({ label, hint, value, onChange }: { label: string; hint: string; value: string; onChange: (hex: string) => void }) {
  // Only holds text while the user is mid-edit; otherwise the field mirrors the live value.
  const [editing, setEditing] = useState<string | null>(null);
  const draft = editing ?? value;
  const valid = isHex(draft);
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-border/60 bg-background/40 p-3">
      <label className="relative size-10 shrink-0 cursor-pointer overflow-hidden rounded-xl border border-border-strong shadow-e1">
        <span className="sr-only">{label} colour</span>
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="absolute -inset-2 size-14 cursor-pointer border-0 bg-transparent p-0"
        />
      </label>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-foreground">{label}</p>
        <p className="truncate text-xs text-muted-foreground">{hint}</p>
      </div>
      <input
        aria-label={`${label} hex value`}
        aria-invalid={!valid}
        value={draft}
        maxLength={7}
        spellCheck={false}
        onChange={(e) => {
          const v = e.target.value.startsWith("#") ? e.target.value : `#${e.target.value}`;
          if (isHex(v)) {
            setEditing(null);
            onChange(v.toLowerCase());
          } else {
            setEditing(v);
          }
        }}
        onBlur={() => setEditing(null)}
        className={cn(
          "h-9 w-24 rounded-lg border bg-input/30 px-2 font-mono text-xs uppercase text-foreground",
          valid ? "border-border-strong" : "border-expense",
        )}
      />
    </div>
  );
}

export function AppearanceThemes() {
  const { theme: mode, setTheme: setMode, resolvedTheme } = useTheme();
  const { theme, hydrate, selectPreset, setColor, setSeed, setDuo, reset } = useThemeStore();
  const [autoCoordinate, setAutoCoordinate] = useState(true);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    hydrate();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- hydration-safe mount flag
    setMounted(true);
  }, [hydrate]);

  const activeMode = mounted && resolvedTheme === "dark" ? "dark" : "light";
  const checks = useMemo(() => deriveTheme(theme.seed, activeMode).checks, [theme.seed, activeMode]);
  const failing = checks.filter((c) => !c.pass);
  const isDefault = theme.presetId === DEFAULT_PRESET_ID;

  const [duoA, duoB] = theme.duo ?? [theme.seed.primary, theme.seed.background];

  /** Custom pair edit — a dark base (e.g. black) switches FlowFi to dark mode so the base actually shows. */
  function onDuo(a: string, b: string) {
    setDuo(a, b);
    if (duoPrefersDark(a, b)) setMode("dark");
  }

  function onColor(key: keyof ThemeSeed, hex: string) {
    if (key === "primary" && autoCoordinate) setSeed(suggestFromPrimary(hex));
    else setColor(key, hex);
  }

  return (
    <div className="flex flex-col gap-4" data-testid="appearance-themes">
      <section className={CARD}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-foreground">Colour theme</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">Pick a curated palette or tune your own. Changes preview instantly across FlowFi and are saved on this device.</p>
          </div>
          <button
            type="button"
            onClick={reset}
            disabled={isDefault}
            className="inline-flex h-9 items-center gap-1.5 rounded-full border border-border-strong px-3.5 text-sm font-medium text-foreground transition-colors hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RotateCcw className="size-4" /> Reset to default
          </button>
        </div>

        <div role="radiogroup" aria-label="Appearance mode" className="mt-4 inline-flex rounded-full border border-border bg-secondary p-1">
          {(["light", "dark", "system"] as const).map((m) => {
            const active = (mounted ? mode : "system") === m;
            return (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setMode(m)}
                className={cn(
                  "h-8 rounded-full px-4 text-sm font-medium capitalize transition-colors",
                  active ? "bg-primary text-primary-foreground shadow-e1" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {m}
              </button>
            );
          })}
        </div>

        <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {THEME_PRESETS.map((p) => {
            const selected = theme.presetId === p.id;
            return (
              <button
                key={p.id}
                type="button"
                aria-pressed={selected}
                data-testid={`theme-preset-${p.id}`}
                onClick={() => selectPreset(p.id)}
                className={cn(
                  "group relative flex flex-col gap-3 rounded-2xl border p-3 text-left transition-[border-color,box-shadow]",
                  selected ? "border-primary-accent-text shadow-e2 ring-1 ring-primary-accent-text" : "border-border hover:border-border-strong hover:shadow-e1",
                )}
              >
                {/* Mini window: sidebar + canvas + primary bar + accent chip, from the preset's own seed colours. */}
                <span className="flex h-16 overflow-hidden rounded-xl border border-black/10" style={{ background: p.seed.background }} aria-hidden>
                  <span className="w-1/4" style={{ background: p.seed.sidebar }} />
                  <span className="flex flex-1 flex-col justify-center gap-1.5 px-3">
                    <span className="h-2 w-3/4 rounded-full" style={{ background: p.seed.primary }} />
                    <span className="h-2 w-1/2 rounded-full" style={{ background: p.seed.secondary }} />
                    <span className="h-2 w-1/3 rounded-full" style={{ background: p.seed.accent }} />
                  </span>
                </span>
                <span className="flex items-center justify-between gap-2">
                  <span>
                    <span className="block text-sm font-semibold text-foreground">{p.name}</span>
                    <span className="block text-xs text-muted-foreground">{p.tagline}</span>
                  </span>
                  {selected && (
                    <span className="grid size-6 place-items-center rounded-full bg-primary text-primary-foreground">
                      <Check className="size-3.5" />
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <section className={CARD} data-testid="duo-themes">
        <div>
          <h2 className="text-base font-semibold text-foreground">Two-colour themes</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Pick two colours and FlowFi builds the rest. A white, cream or black second colour becomes the base; any other colour becomes the secondary.
          </p>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
          {DUO_PRESETS.map((d) => {
            const selected = theme.presetId === d.id;
            return (
              <button
                key={d.id}
                type="button"
                aria-pressed={selected}
                data-testid={`theme-duo-${d.id}`}
                onClick={() => {
                  setDuo(d.a, d.b, d.id);
                  setMode(duoPrefersDark(d.a, d.b) ? "dark" : "light");
                }}
                className={cn(
                  "flex items-center gap-2.5 rounded-2xl border p-2.5 text-left transition-[border-color,box-shadow]",
                  selected ? "border-primary-accent-text shadow-e2 ring-1 ring-primary-accent-text" : "border-border hover:border-border-strong hover:shadow-e1",
                )}
              >
                {/* Split swatch: colour 1 | colour 2. */}
                <span className="relative size-9 shrink-0 overflow-hidden rounded-full border border-black/15" aria-hidden>
                  <span className="absolute inset-y-0 left-0 w-1/2" style={{ background: d.a }} />
                  <span className="absolute inset-y-0 right-0 w-1/2" style={{ background: d.b }} />
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">{d.name}</span>
                {selected && <Check className="size-4 shrink-0 text-primary-accent-text" />}
              </button>
            );
          })}
        </div>
        <div className="mt-4 grid grid-cols-1 items-center gap-3 lg:grid-cols-[1fr_auto_1fr]">
          <ColorRow label="Colour 1 · Primary" hint="Buttons, active navigation, highlights" value={duoA} onChange={(hex) => onDuo(hex, duoB)} />
          <button
            type="button"
            onClick={() => onDuo(duoB, duoA)}
            aria-label="Swap colour 1 and colour 2"
            className="mx-auto grid size-9 place-items-center rounded-full border border-border-strong text-foreground transition-colors hover:bg-secondary"
          >
            <ArrowLeftRight className="size-4" />
          </button>
          <ColorRow label="Colour 2 · Base or secondary" hint="White/cream/black = base, otherwise secondary" value={duoB} onChange={(hex) => onDuo(duoA, hex)} />
        </div>
      </section>

      <section className={CARD}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-foreground">Customise colours</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {theme.presetId === "custom" ? "Custom theme — fine-tune every colour." : "Fine-tune every colour. Editing one turns the current theme into a custom one."}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
              <input type="checkbox" checked={autoCoordinate} onChange={(e) => setAutoCoordinate(e.target.checked)} className="size-4 accent-[var(--primary-accent-text)]" />
              Match other colours to Primary
            </label>
            <button
              type="button"
              onClick={() => setSeed(suggestFromPrimary(theme.seed.primary))}
              className="inline-flex h-9 items-center gap-1.5 rounded-full bg-primary px-3.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary-hover"
            >
              <Sparkles className="size-4" /> Suggest matching colours
            </button>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
          {COLOR_FIELDS.map((f) => (
            <ColorRow key={f.key} label={f.label} hint={f.hint} value={theme.seed[f.key]} onChange={(hex) => onColor(f.key, hex)} />
          ))}
        </div>
      </section>

      <section className={CARD} aria-live="polite">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-foreground">Readability check ({activeMode} mode)</h2>
          <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-semibold", failing.length ? "bg-warning/25 text-warning-foreground" : "bg-success/15 text-success")}>
            {failing.length ? `${failing.length} below target` : "All checks pass"}
          </span>
        </div>
        <p className="mt-0.5 text-sm text-muted-foreground">Text, icon and border colours are adjusted automatically to stay readable with your palette.</p>
        <ul className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
          {checks.map((c) => (
            <li key={c.label} className="flex items-center justify-between gap-3 border-b border-border-subtle py-1.5 text-sm">
              <span className="text-foreground">{c.label}</span>
              <span className={cn("font-mono text-xs", c.pass ? "text-success" : "text-warning-foreground")}>
                {c.ratio.toFixed(1)}:1 {c.pass ? "✓" : `(aim ${c.target}:1)`}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
