/**
 * Ambient ground: the page colour with two very low-contrast, static color washes (switched off by flat themes via --wash) (primary top-left, purple
 * bottom-right) rather than the design-lab's animated multi-blob mesh — restrained enough to sit behind every
 * page's content without competing with it, per the "color draws attention, not decoration" rule.
 */
export function AmbientBackground() {
  return (
    <div
      className="pointer-events-none fixed inset-0 bg-background"
      style={{
        zIndex: "var(--z-background)",
        backgroundImage: [
          "radial-gradient(90% 70% at 8% 0%, color-mix(in oklch, var(--primary) calc(10% * var(--wash, 1)), transparent) 0%, transparent 55%)",
          "radial-gradient(80% 60% at 100% 100%, color-mix(in oklch, var(--purple) calc(8% * var(--wash, 1)), transparent) 0%, transparent 55%)",
          "radial-gradient(120% 100% at 50% 0%, color-mix(in oklch, var(--card) 55%, transparent) 0%, transparent 60%)",
        ].join(", "),
      }}
    />
  );
}
