"use client";

import { useTheme } from "next-themes";
import { useEffect } from "react";
import { applyTheme } from "@/lib/theme/apply";
import { useThemeStore } from "@/store/theme-store";

/**
 * Renders nothing; keeps the saved colour theme applied to <html> and re-derives it whenever the theme
 * changes or light/dark flips — which is what makes every Settings edit preview live, app-wide.
 */
export function ThemeCustomizer() {
  const { resolvedTheme } = useTheme();
  const theme = useThemeStore((s) => s.theme);
  const hydrated = useThemeStore((s) => s.hydrated);
  const hydrate = useThemeStore((s) => s.hydrate);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (!hydrated || !resolvedTheme) return;
    applyTheme(theme, resolvedTheme === "dark" ? "dark" : "light");
  }, [theme, hydrated, resolvedTheme]);

  return null;
}
