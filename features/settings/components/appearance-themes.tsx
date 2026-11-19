"use client";

import { Check, MonitorSmartphone, Moon, Palette, RotateCcw, ShieldCheck, Sparkles, Sun, TriangleAlert } from "lucide-react";
import { useTheme } from "next-themes";
import { type CSSProperties, useEffect, useMemo, useState } from "react";
import { Switch } from "@/components/ui/switch";
import { isHex } from "@/lib/theme/color";
import { ACCENTS, SURFACES, type ThemeMode, buildTokens } from "@/lib/theme/lime";
import { BASES, buildPaletteTokens, colourName, financialClash, suggestCombos } from "@/lib/theme/palette";
import { CUSTOM_ID, type CustomSpec, LIME_ID, type StoredTheme, THEMES, isDefaultTheme, resolveTheme } from "@/lib/theme/themes";
import { cn } from "@/lib/utils";
import { useThemeStore } from "@/store/theme-store";

const CARD = "rounded-[20px] border border-border/70 bg-card p-5 shadow-e1";
const PRIMARY_SWATCHES = ["#2563eb", "#4f46e5", "#7c3aed", "#db2777", "#dc2626", "#ea580c", "#ca8a04", "#0f766e", "#16a34a", "#18181b"];
const SECONDARY_SWATCHES = ["#64748b", "#1e3a6e", "#4f7fd1", "#0ea5e9", "#7c3aed", "#b45309"];

/**
 * A miniature FlowFi screen painted entirely from design tokens, so what you see is what you get. It is scoped to its
 * own mode (`.light` / `.dark` re-declare the stylesheet's tokens on this element) and layers the theme's tokens on top,
 * which lets every gallery card show its theme in the *current* mode regardless of how the page itself is rendered.
 */
function ThemePreview({ tokens, mode, compact = false }: { tokens: Record<string, string>; mode: ThemeMode; compact?: boolean }) {
  const bars = [38, 62, 48, 80, 56, 92, 70];
  return (
    <div
      aria-hidden
      className={cn(mode, "flex overflow-hidden rounded-xl border border-border bg-background text-foreground", compact ? "h-[7rem]" : "h-[9rem]")}
      style={tokens as CSSProperties}
    >
      <div className="flex w-[22%] shrink-0 flex-col gap-1.5 border-r border-sidebar-border bg-sidebar p-2">
        <span className="mb-1 size-3.5 rounded-[5px] bg-primary" />
        <span className="h-2 rounded-full bg-primary" />
        <span className="h-2 w-4/5 rounded-full bg-muted" />
        <span className="h-2 w-3/5 rounded-full bg-muted" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 p-2">
        <div className="flex items-center justify-between rounded-lg px-2 py-1.5 text-hero-foreground" style={{ background: "var(--gradient-hero)" }}>
          <span className="flex flex-col leading-none">
            <span className="text-[7px] uppercase tracking-wider opacity-70">Net worth</span>
            <span className="mt-0.5 text-[11px] font-semibold tabular-nums">₹4,82,300</span>
          </span>
          <span className="rounded-full bg-primary px-1.5 py-0.5 text-[7px] font-semibold text-primary-foreground">+2.4%</span>
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          <div className="rounded-lg border border-border bg-card p-1.5 shadow-e1">
            <p className="text-[7px] text-muted-foreground">Money in</p>
            <p className="text-[10px] font-semibold tabular-nums text-success">+₹52,000</p>
          </div>
          <div className="rounded-lg border border-border bg-card p-1.5 shadow-e1">
            <p className="text-[7px] text-muted-foreground">Money out</p>
            <p className="text-[10px] font-semibold tabular-nums text-expense">−₹18,450</p>
          </div>
        </div>
        <div className="flex min-h-0 flex-1 items-end gap-1 rounded-lg border border-border bg-card px-2 pb-1.5 pt-1">
          {bars.map((h, i) => (
            <span key={i} className="flex-1 rounded-t-[3px] bg-chart-1" style={{ height: `${h * 0.42}%` }} />
          ))}
        </div>
      </div>
    </div>
  );
}

function ColorRow({ label, hint, value, onChange }: { label: string; hint?: string; value: string; onChange: (hex: string) => void }) {
  // Only holds text while the user is mid-edit; otherwise the field mirrors the live value.
  const [editing, setEditing] = useState<string | null>(null);
  const draft = editing ?? value;
  const valid = isHex(draft);
  return (
    <div className="flex items-center gap-3">
      <label className="relative size-10 shrink-0 cursor-pointer overflow-hidden rounded-xl border border-border-strong shadow-e1">
        <span className="sr-only">{label} colour</span>
        <input type="color" value={value} onChange={(e) => onChange(e.target.value)} className="absolute -inset-2 size-14 cursor-pointer border-0 bg-transparent p-0" />
      </label>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-foreground">{label}</p>
        {hint && <p className="truncate text-xs text-muted-foreground">{hint}</p>}
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
        className={cn("h-9 w-24 rounded-lg border bg-input/30 px-2 font-mono text-xs uppercase text-foreground", valid ? "border-border-strong" : "border-expense")}
      />
    </div>
  );
}

function Swatches({ colours, value, onPick, label }: { colours: string[]; value: string | null; onPick: (hex: string) => void; label: string }) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
      {colours.map((c) => {
        const on = value?.toLowerCase() === c;
        return (
          <button
            key={c}
            type="button"
            aria-label={`${colourName(c)} ${c}`}
            aria-pressed={on}
            onClick={() => onPick(c)}
            className={cn("grid size-7 place-items-center rounded-full border border-black/15 transition-transform hover:scale-110", on && "ring-2 ring-foreground ring-offset-2 ring-offset-card")}
            style={{ background: c }}
          >
            {on && <Check className="size-3.5 text-white mix-blend-difference" />}
          </button>
        );
      })}
    </div>
  );
}

export function AppearanceThemes() {
  const { theme: mode, setTheme: setMode, resolvedTheme } = useTheme();
  const { theme, hydrate, selectTheme, setAccent, setSurface, setCustom, customizeFrom, reset } = useThemeStore();
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    hydrate();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- hydration-safe mount flag
    setMounted(true);
  }, [hydrate]);

  const activeMode: ThemeMode = mounted && resolvedTheme === "dark" ? "dark" : "light";
  const followingDevice = mounted && mode === "system";
  const isDefault = isDefaultTheme(theme);
  const active = useMemo(() => resolveTheme(theme, activeMode), [theme, activeMode]);
  const failing = active.checks.filter((c) => !c.pass);
  const activeName = theme.id === CUSTOM_ID ? "My theme" : (THEMES.find((t) => t.id === theme.id)?.name ?? "FlowFi Lime");

  /** Previews of any theme id, in the current mode. */
  const tokensFor = (id: string, over?: Partial<StoredTheme>) => resolveTheme({ ...theme, id, ...over }, activeMode).tokens;

  // Theme and mode are independent: choosing a theme or editing custom colours never touches Light / Dark / Match device.
  const choose = selectTheme;
  const editCustom = (patch: Partial<CustomSpec>) => setCustom(patch);

  const c = theme.custom;
  const primaryName = colourName(c.primary);
  const clash = financialClash(c.primary);
  const suggestions = useMemo(() => suggestCombos(c.primary), [c.primary]);
  const customActive = theme.id === CUSTOM_ID;
  const presetActive = THEMES.find((t) => t.id === theme.id && t.spec);

  return (
    <div className="flex flex-col gap-4" data-testid="appearance-themes">
      <section className={CARD}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-foreground">Appearance</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Pick a look, then Light or Dark. Currently <span className="font-medium text-foreground">{activeName}</span> · saved on this device.
            </p>
          </div>
          <button
            type="button"
            onClick={reset}
            disabled={isDefault}
            data-testid="theme-reset"
            className="inline-flex h-9 items-center gap-1.5 rounded-full border border-border-strong px-3.5 text-sm font-medium text-foreground transition-colors hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RotateCcw className="size-4" /> Reset to FlowFi Lime
          </button>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <div role="radiogroup" aria-label="Appearance mode" className="inline-flex rounded-full border border-border bg-secondary p-1">
            {(
              [
                ["light", "Light", Sun],
                ["dark", "Dark", Moon],
                ["system", "Match device", MonitorSmartphone],
              ] as const
            ).map(([m, label, Icon]) => {
              const on = mounted && (m === "system" ? followingDevice : !followingDevice && activeMode === m);
              return (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  data-testid={`theme-mode-${m}`}
                  onClick={() => setMode(m)}
                  className={cn(
                    "inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-sm font-medium transition-colors",
                    on ? "bg-primary text-primary-foreground shadow-e1" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Icon className="size-3.5" /> {label}
                </button>
              );
            })}
          </div>
          {followingDevice && <p className="text-xs text-muted-foreground">Following your device — currently {activeMode === "dark" ? "Dark" : "Light"}.</p>}
        </div>
      </section>

      <section className={CARD} data-testid="theme-gallery">
        <h2 className="text-base font-semibold text-foreground">Theme gallery</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">Seven distinct looks, each shown here in {activeMode} mode. Every one keeps Money In green and Money Out red.</p>
        <div role="radiogroup" aria-label="Theme" className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {[...THEMES, { id: CUSTOM_ID, name: "My theme", tagline: "Your own colours, built below", spec: undefined }].map((t) => {
            const selected = theme.id === t.id;
            return (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={selected}
                data-testid={`theme-card-${t.id}`}
                onClick={() => choose(t.id)}
                className={cn(
                  "flex flex-col gap-3 rounded-2xl border bg-card p-3 text-left transition-[border-color,box-shadow]",
                  selected ? "border-primary-accent-text shadow-e2 ring-1 ring-primary-accent-text" : "border-border hover:border-border-strong hover:shadow-e1",
                )}
              >
                <ThemePreview tokens={tokensFor(t.id)} mode={activeMode} compact />
                <span className="flex items-center justify-between gap-2 px-0.5">
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold text-foreground">{t.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">{t.tagline}</span>
                  </span>
                  {selected && (
                    <span className="grid size-6 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground">
                      <Check className="size-3.5" />
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
        {presetActive && (
          <p className="mt-3 text-sm text-muted-foreground">
            Like {presetActive.name} but want to adjust it?{" "}
            <button type="button" data-testid="theme-customize-preset" onClick={() => customizeFrom(presetActive.id)} className="font-medium text-primary-accent-text underline-offset-4 hover:underline">
              Start a custom theme from it
            </button>
          </p>
        )}
      </section>

      {theme.id === LIME_ID && (
        <section className={CARD} data-testid="lime-options">
          <h2 className="text-base font-semibold text-foreground">FlowFi Lime options</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">Only FlowFi Lime has these — every combination is checked for readability in both modes.</p>
          <h3 className="mt-4 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Lime accent</h3>
          <div role="radiogroup" aria-label="Lime accent" className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {ACCENTS.map((a) => {
              const t = buildTokens(a, SURFACES.find((s) => s.id === theme.surface) ?? SURFACES[0], activeMode).tokens;
              const selected = theme.accent === a.id;
              return (
                <button
                  key={a.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  data-testid={`theme-accent-${a.id}`}
                  onClick={() => setAccent(a.id)}
                  className={cn("flex items-center gap-3 rounded-2xl border bg-card p-2.5 text-left transition-[border-color,box-shadow]", selected ? "border-primary-accent-text shadow-e2 ring-1 ring-primary-accent-text" : "border-border hover:border-border-strong hover:shadow-e1")}
                >
                  <span className="relative size-9 shrink-0 overflow-hidden rounded-full border border-border-strong" aria-hidden>
                    <span className="absolute inset-0" style={{ background: t["--primary"] }} />
                    <span className="absolute inset-x-0 bottom-0 h-1/3" style={{ background: t["--chart-1"] }} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-foreground">{a.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">{a.tagline}</span>
                  </span>
                  {selected && <Check className="size-4 shrink-0 text-primary-accent-text" />}
                </button>
              );
            })}
          </div>
          <h3 className="mt-5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Surface tone</h3>
          <div role="radiogroup" aria-label="Surface tone" className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
            {SURFACES.map((s) => {
              const t = buildTokens(ACCENTS.find((a) => a.id === theme.accent) ?? ACCENTS[0], s, activeMode).tokens;
              const selected = theme.surface === s.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  data-testid={`theme-surface-${s.id}`}
                  onClick={() => setSurface(s.id)}
                  className={cn("flex items-center gap-3 rounded-2xl border bg-card p-2.5 text-left transition-[border-color,box-shadow]", selected ? "border-primary-accent-text shadow-e2 ring-1 ring-primary-accent-text" : "border-border hover:border-border-strong hover:shadow-e1")}
                >
                  <span className="relative size-9 shrink-0 overflow-hidden rounded-xl border border-border-strong" aria-hidden style={{ background: t["--background"] }}>
                    <span className="absolute right-1 bottom-1 left-2.5 top-2.5 rounded-md border border-black/10" style={{ background: t["--card"] }} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-foreground">{s.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">{s.tagline}</span>
                  </span>
                  {selected && <Check className="size-4 shrink-0 text-primary-accent-text" />}
                </button>
              );
            })}
          </div>
        </section>
      )}

      <section className={CARD} data-testid="custom-builder">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
              <Palette className="size-4.5 text-primary-accent-text" /> Build your own
            </h2>
            <p className="mt-0.5 max-w-xl text-sm text-muted-foreground">
              Choose a base and one or two colours. Surfaces, borders, text, buttons and charts are generated to match — the colours you pick are used for buttons, highlights and links, never mixed into the background.
            </p>
          </div>
          {!customActive && (
            <button type="button" data-testid="theme-use-custom" onClick={() => choose(CUSTOM_ID)} className="inline-flex h-9 items-center rounded-full border border-border-strong px-3.5 text-sm font-medium text-foreground hover:bg-secondary">
              Use my theme
            </button>
          )}
        </div>

        <div className="mt-4 grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_17rem]">
          <div className="flex flex-col gap-5">
            <div>
              <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">1 · Base</h3>
              <div role="radiogroup" aria-label="Base" className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
                {BASES.map((b) => {
                  const t = buildPaletteTokens({ base: b.id, primary: c.primary }, activeMode).tokens;
                  const selected = c.base === b.id;
                  return (
                    <button
                      key={b.id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      data-testid={`theme-custom-base-${b.id}`}
                      onClick={() => editCustom({ base: b.id })}
                      title={b.tagline}
                      className={cn("flex flex-col items-center gap-1.5 rounded-xl border bg-card p-2 text-center transition-[border-color,box-shadow]", selected && customActive ? "border-primary-accent-text ring-1 ring-primary-accent-text" : "border-border hover:border-border-strong")}
                    >
                      <span className="relative h-9 w-full overflow-hidden rounded-lg border border-border-strong" aria-hidden style={{ background: t["--background"] }}>
                        <span className="absolute right-1.5 bottom-1.5 left-4 top-1.5 rounded border border-black/10" style={{ background: t["--card"] }} />
                      </span>
                      <span className="text-xs font-semibold text-foreground">{b.name}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">2 · Primary colour</h3>
              <div className="mt-2 flex flex-col gap-3">
                <ColorRow label="Primary" hint="Buttons, active navigation, links, highlights" value={c.primary} onChange={(hex) => editCustom({ primary: hex })} />
                <Swatches colours={PRIMARY_SWATCHES} value={c.primary} onPick={(hex) => editCustom({ primary: hex })} label="Quick primary colours" />
                {clash && (
                  <p role="status" className="flex items-start gap-2 rounded-xl bg-warning/20 px-3 py-2 text-xs text-warning-foreground">
                    <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                    This {primaryName.toLowerCase()} sits close to the {clash === "in" ? "Money In green" : "Money Out red"}. Amounts keep their own colours and stay readable, but buttons in this hue can look like money at a glance.
                  </p>
                )}
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">3 · Secondary colour (optional)</h3>
                <Switch
                  aria-label="Use a secondary colour"
                  data-testid="theme-custom-secondary-toggle"
                  checked={c.secondary !== null}
                  onCheckedChange={(on) => editCustom({ secondary: on ? (suggestions[3].secondary ?? "#64748b") : null })}
                />
              </div>
              {c.secondary !== null ? (
                <div className="mt-2 flex flex-col gap-3">
                  <ColorRow label="Secondary" hint="Information accents, transfers, header panels" value={c.secondary} onChange={(hex) => editCustom({ secondary: hex })} />
                  <Swatches colours={SECONDARY_SWATCHES} value={c.secondary} onPick={(hex) => editCustom({ secondary: hex })} label="Quick secondary colours" />
                </div>
              ) : (
                <p className="mt-1.5 text-xs text-muted-foreground">Off — information accents are derived from your primary.</p>
              )}
            </div>

            <div>
              <h3 className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                <Sparkles className="size-3.5" /> Suggested pairings for {primaryName}
              </h3>
              <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                {suggestions.map((s) => {
                  const t = buildPaletteTokens({ base: s.base, primary: c.primary, secondary: s.secondary }, activeMode).tokens;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      data-testid={`theme-suggest-${s.id}`}
                      onClick={() => editCustom({ base: s.base, secondary: s.secondary })}
                      className="flex items-center gap-2.5 rounded-xl border border-border bg-card p-2 text-left transition-colors hover:border-border-strong hover:bg-secondary/50"
                    >
                      <span className="flex h-7 w-12 shrink-0 overflow-hidden rounded-md border border-border-strong" aria-hidden>
                        <span className="w-1/2" style={{ background: t["--background"] }} />
                        <span className="w-1/4" style={{ background: t["--primary"] }} />
                        <span className="w-1/4" style={{ background: s.secondary ? t["--royal"] : t["--surface-hero"] }} />
                      </span>
                      <span className="min-w-0 truncate text-sm font-medium text-foreground">{s.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-2 lg:sticky lg:top-2 lg:self-start">
            <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Live preview · {activeMode}</h3>
            <ThemePreview tokens={tokensFor(CUSTOM_ID)} mode={activeMode} />
            <p className="text-xs text-muted-foreground">{customActive ? "Applied across FlowFi right now." : "Not active yet — change anything to try it live."}</p>
          </div>
        </div>
      </section>

      <section className={CARD} aria-live="polite">
        <details data-testid="theme-readability" className="group">
          <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-2 [&::-webkit-details-marker]:hidden">
            <span className="flex items-center gap-2 text-base font-semibold text-foreground">
              <ShieldCheck className="size-4.5 text-primary-accent-text" />
              Readability check · {activeMode} mode
            </span>
            <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-semibold", failing.length ? "bg-warning/25 text-warning-foreground" : "bg-success/15 text-success")}>
              {failing.length ? `${failing.length} below target` : `All ${active.checks.length} checks pass`}
            </span>
          </summary>
          <p className="mt-2 text-sm text-muted-foreground">Text, buttons, links, charts and Money In / Money Out colours are measured against the current theme&apos;s surfaces.</p>
          <ul className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
            {active.checks.map((ck) => (
              <li key={ck.label} className="flex items-center justify-between gap-3 border-b border-border-subtle py-1.5 text-sm">
                <span className="text-foreground">{ck.label}</span>
                <span className={cn("font-mono text-xs", ck.pass ? "text-success" : "text-warning-foreground")}>
                  {ck.ratio.toFixed(1)}:1 {ck.pass ? "✓" : `(aim ${ck.target}:1)`}
                </span>
              </li>
            ))}
          </ul>
        </details>
      </section>
    </div>
  );
}
