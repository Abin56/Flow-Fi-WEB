/**
 * Appearance / theme QA (theme-lime.mjs) — behaviour + page evidence shots, light and dark. Synthetic emulator data only.
 *   npm run test:e2e-qa -- theme- --copy
 *
 * theme-shots-*      Dashboard + People in every gallery theme → .results/shots/theme-<tag>-<theme>-<page>-<mode>.png
 * theme-appearance   gallery, mode control, FlowFi Lime options, flat themes, custom builder, persistence, reset, and the
 *                    safe mapping of preferences saved by earlier versions.
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";

const TAG = process.env.THEME_TAG ?? "after";
const THEME_IDS = ["lime", "arctic", "graphite", "executive", "slate", "midnight", "ivory"];
const KEY = "flowfi:appearance-theme";

const inline = (page, prop) => page.evaluate((p) => document.documentElement.style.getPropertyValue(p), prop);
const stored = (page, key) => page.evaluate((k) => window.localStorage.getItem(k), key);
const flat = (page) => page.evaluate(() => document.documentElement.hasAttribute("data-theme-flat"));
const isDark = (page) => page.evaluate(() => document.documentElement.classList.contains("dark"));
const setStored = (page, value) => page.evaluate(([k, v]) => window.localStorage.setItem(k, v), [KEY, JSON.stringify(value)]);

async function openAppearance(page) {
  await h.go(page, "/settings");
  await page.getByRole("tab", { name: /Appearance/ }).first().click();
  await page.waitForSelector('[data-testid="appearance-themes"]');
  await page.waitForTimeout(400);
}
async function visit(page, path, ms = 6000) {
  await page.goto(new URL(path, page.url()).toString(), { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(ms);
}

for (const scheme of ["light", "dark"]) {
  scenario(
    `theme-shots-${scheme}`,
    `Themes in ${scheme} mode: dashboard + people for every gallery theme`,
    async ({ page }, chk) => {
      await h.addFixture(page, "shared-emi");
      for (const id of THEME_IDS) {
        await setStored(page, { id, accent: "signature", surface: "warm", custom: { base: "white", primary: "#2563eb", secondary: null } });
        for (const [name, path] of [["dashboard", "/dashboard/"], ["people", "/people/"]]) {
          await visit(page, path);
          if (name === "dashboard") {
            const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
            if (id === "arctic" && scheme === "light") chk("Arctic Blue (light): the page background is pure white", /^(rgb\(255, 255, 255\)|oklch\(1 0 260\))$/.test(bg), bg);
            const washes = await page.evaluate(() =>
              [...document.querySelectorAll('[class*="from-primary/"]')]
                .filter((el) => !el.closest(".nav-root"))
                .filter((el) => getComputedStyle(el).getPropertyValue("--tw-gradient-from").trim().replace(/\s/g, "") !== "rgba(0,0,0,0)" && getComputedStyle(el).getPropertyValue("--tw-gradient-from").trim() !== "transparent").length,
            );
            if (id !== "lime") chk(`${id} (${scheme}): no decorative primary-tinted gradient washes outside the sidebar`, washes === 0, `${washes} left`);
          }
          await page.screenshot({ path: `${h.SHOTS_DIR}/theme-${TAG}-${id}-${name}-${scheme}.png` });
        }
      }
      chk(`page renders in ${scheme} mode`, (await isDark(page)) === (scheme === "dark"));
    },
    { viewport: { width: 1440, height: 900 }, scheme },
  );
}

scenario(
  "theme-appearance",
  "Appearance: gallery, modes, Lime options, flat themes, custom builder, persistence, reset, migration",
  async ({ page }, chk) => {
    await openAppearance(page);

    chk("gallery shows FlowFi Lime, six themes and 'My theme'", (await page.locator('[data-testid^="theme-card-"]').count()) === 8);
    chk("default = FlowFi Lime with no inline overrides and not flat", (await inline(page, "--primary")) === "" && !(await flat(page)));
    chk("Lime options are shown for FlowFi Lime", await page.getByTestId("lime-options").isVisible());
    chk("old lime-shade-only UI is gone (no generic preset/duo cards)", (await page.locator('[data-testid^="theme-preset-"], [data-testid^="theme-duo-"]').count()) === 0);

    // Mode control
    await page.getByTestId("theme-mode-dark").click();
    await page.waitForFunction(() => document.documentElement.classList.contains("dark"));
    await page.getByTestId("theme-mode-light").click();
    await page.waitForFunction(() => !document.documentElement.classList.contains("dark"));
    await page.getByTestId("theme-mode-system").click();
    await page.waitForTimeout(300);
    chk("Match device stores 'system'", (await stored(page, "theme")) === "system", await stored(page, "theme"));
    await page.getByTestId("theme-mode-light").click();
    await page.waitForTimeout(300);

    // Lime options stay with Lime
    await page.getByTestId("theme-accent-citron").click();
    await page.waitForTimeout(300);
    chk("Citron accent applies (still FlowFi Lime, not flat)", (await inline(page, "--primary")) !== "" && !(await flat(page)), await inline(page, "--primary"));

    // Pure white + blue
    await page.getByTestId("theme-card-arctic").click();
    await page.waitForTimeout(400);
    chk("Arctic Blue: page background is exactly white", (await inline(page, "--background")) === "oklch(1.000 0.000 260)", await inline(page, "--background"));
    chk("Arctic Blue: card is exactly white", (await inline(page, "--card")) === "oklch(1.000 0.000 260)");
    chk("Arctic Blue is a flat theme", await flat(page));
    chk("Lime options are hidden for other themes", (await page.getByTestId("lime-options").count()) === 0);
    chk("body renders white", /^(rgb\(255, 255, 255\)|oklch\(1 0 260\))$/.test(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)));
    chk("Money In / Money Out colours are not themed", (await inline(page, "--success")) === "" && (await inline(page, "--expense")) === "");

    // Theme and mode are independent
    for (const id of ["graphite", "midnight", "arctic"]) {
      await page.getByTestId("theme-mode-light").click();
      await page.waitForFunction(() => !document.documentElement.classList.contains("dark"));
      await page.getByTestId(`theme-card-${id}`).click();
      await page.waitForTimeout(400);
      chk(`Light mode stays Light after choosing ${id}`, !(await isDark(page)) && (await stored(page, "theme")) === "light", await stored(page, "theme"));
    }
    await page.getByTestId("theme-mode-dark").click();
    await page.waitForFunction(() => document.documentElement.classList.contains("dark"));
    await page.getByTestId("theme-card-arctic").click();
    await page.getByTestId("theme-card-ivory").click();
    await page.waitForTimeout(300);
    chk("Dark mode stays Dark across theme changes", (await isDark(page)) && (await stored(page, "theme")) === "dark");
    await page.getByTestId("theme-mode-system").click();
    await page.getByTestId("theme-card-midnight").click();
    await page.waitForTimeout(300);
    chk("Match device stays on 'system' after choosing a theme", (await stored(page, "theme")) === "system");
    await page.getByTestId("theme-mode-light").click();
    await page.waitForFunction(() => !document.documentElement.classList.contains("dark"));

    // Preset → custom
    await page.getByTestId("theme-card-executive").click();
    await page.getByTestId("theme-customize-preset").click();
    await page.waitForTimeout(300);
    chk("'Start a custom theme from it' activates the custom theme", JSON.parse(await stored(page, KEY)).id === "custom");

    // Custom builder
    await page.getByTestId("theme-custom-base-black").click();
    await page.waitForTimeout(200);
    chk("a black custom base does not switch the mode", !(await isDark(page)) && (await stored(page, "theme")) === "light");
    await page.getByTestId("theme-custom-base-ivory").click();
    await page.waitForTimeout(200);
    chk("custom base is stored", JSON.parse(await stored(page, KEY)).custom.base === "ivory");
    await page.getByLabel("Primary hex value").fill("#16a34a");
    await page.waitForTimeout(300);
    chk("a green primary shows the Money-In clash note", await page.getByRole("status").filter({ hasText: /Money In green/ }).isVisible());
    await page.getByLabel("Primary hex value").fill("#7c3aed");
    await page.waitForTimeout(300);
    chk("a violet primary clears the note", (await page.getByRole("status").filter({ hasText: /Money (In|Out)/ }).count()) === 0);
    chk("primary applies app-wide (inline --primary changed)", (await inline(page, "--primary")) !== "");
    await page.getByTestId("theme-suggest-white-slate").click();
    await page.waitForTimeout(300);
    const cust = JSON.parse(await stored(page, KEY)).custom;
    chk("the white + violet + slate pairing sets base and secondary", cust.base === "white" && /^#[0-9a-f]{6}$/.test(cust.secondary ?? ""), JSON.stringify(cust));
    chk("a secondary colour sets the information family", (await inline(page, "--royal")) !== "", await inline(page, "--royal"));
    await page.getByTestId("theme-custom-secondary-toggle").click();
    await page.waitForTimeout(300);
    chk("turning the secondary off removes it", JSON.parse(await stored(page, KEY)).custom.secondary === null && (await inline(page, "--royal")) === "");
    await page.screenshot({ path: `${h.SHOTS_DIR}/theme-${TAG}-appearance-builder.png`, fullPage: true });

    // Persistence: painted before React runs
    await page.reload({ waitUntil: "domcontentloaded" });
    chk("custom theme is painted from the pre-paint cache on reload", (await inline(page, "--background")) !== "" && (await flat(page)), await inline(page, "--background"));
    await page.waitForTimeout(5000);
    chk("Light mode survives a reload with a custom theme", !(await isDark(page)) && (await stored(page, "theme")) === "light");

    // Reset
    await openAppearance(page);
    await page.getByTestId("theme-reset").click();
    await page.waitForTimeout(400);
    chk("Reset returns to FlowFi Lime: no overrides, not flat", (await inline(page, "--primary")) === "" && (await inline(page, "--background")) === "" && !(await flat(page)));
    chk("Reset stores the default", JSON.parse(await stored(page, KEY)).id === "lime");

    // Migration from earlier versions
    await setStored(page, { accent: "citron", surface: "sage" }); // last release's shape
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(6000);
    const migrated = JSON.parse(await stored(page, KEY));
    chk("last release's {accent, surface} becomes FlowFi Lime with the same options", migrated.id === "lime" && migrated.accent === "citron" && migrated.surface === "sage", JSON.stringify(migrated));
    chk("…and still looks like it (Citron applied, not flat)", (await inline(page, "--primary")) !== "" && !(await flat(page)));
    await page.evaluate(() => {
      localStorage.setItem("flowfi:appearance-theme", JSON.stringify({ presetId: "ocean", seed: { primary: "#2563EB", secondary: "#0891B2", accent: "#7DB2F8", background: "#F4F7FB", sidebar: "#EAF0F9" } }));
      localStorage.setItem("flowfi:appearance-theme-css", JSON.stringify({ light: { "--primary": "oklch(0.55 0.2 262)" }, dark: { "--primary": "oklch(0.75 0.15 262)" } }));
      localStorage.setItem("flowfi:appearance-theme-css:v2", JSON.stringify({ light: { "--primary": "oklch(0.55 0.2 262)" }, dark: { "--primary": "oklch(0.75 0.15 262)" } }));
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(6000);
    chk("an old multi-theme preference is NOT applied", (await inline(page, "--primary")) === "" && !(await flat(page)), await inline(page, "--primary"));
    chk("…it is rewritten as FlowFi Lime", JSON.parse(await stored(page, KEY)).id === "lime");
    chk("…and both obsolete colour caches are removed", (await stored(page, "flowfi:appearance-theme-css")) === null && (await stored(page, "flowfi:appearance-theme-css:v2")) === null);
  },
  { viewport: { width: 1440, height: 900 }, scheme: "light" },
);
