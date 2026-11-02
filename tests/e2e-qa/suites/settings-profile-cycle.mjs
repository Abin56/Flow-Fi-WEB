/**
 * Browser QA (settings-profile-cycle.mjs). Local emulator only — see tests/e2e-qa/README.md.
 * Settings → Profile: name/phone validation + persistence (Firebase Auth emulator), photo upload, live theme, reset,
 * honest inert controls. Month cycle start day 17 → Loans & EMI "My EMI — Confirmed" window starts 17 Oct, and a
 * cycle change never rewrites loans/EMIs/installments (Firestore emulator read-back).
 * Backup & Restore is deliberately not exercised.
 */
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";

const fmt = (d, year) => d.toLocaleDateString("en-IN", { day: "numeric", month: "short", ...(year ? { year: "numeric" } : {}) });

/** Expected cycle label for start day `day` containing `now`, offset 0|1 — computed independently of the app code. */
function expectedLabel(day, now, offset) {
  let start = new Date(now.getFullYear(), now.getMonth(), day);
  if (now < start) start = new Date(now.getFullYear(), now.getMonth() - 1, day);
  start = new Date(start.getFullYear(), start.getMonth() + offset, day);
  const next = new Date(start.getFullYear(), start.getMonth() + 1, day);
  const end = new Date(next.getFullYear(), next.getMonth(), next.getDate() - 1);
  return `${fmt(start, false)} – ${fmt(end, true)}`;
}

async function openSettings(page) {
  await h.go(page, "/settings");
  await page.getByRole("tab", { name: "Profile" }).waitFor({ timeout: 30000 });
}

scenario("setcycle-profile", "Settings profile: validation, save, photo, theme, inert controls, reset", async ({ page }, chk, notes) => {
  await h.openPortalSignedIn(page);
  await openSettings(page);

  const name = page.getByLabel("Full Name");
  const phone = page.getByLabel(/Phone Number/);
  const save = page.getByRole("button", { name: /Save Changes/ });

  // Validation: empty name and a bad phone are rejected, nothing is saved.
  await name.fill("   ");
  await save.click();
  chk("empty name shows an error", (await page.getByText("Enter your name.").count()) === 1);
  await name.fill("QA Renamed User");
  await phone.fill("98abc");
  await save.click();
  chk("bad phone shows an error", (await page.getByText(/Use digits only/).count()) === 1);
  chk("invalid phone is not stored", !(await page.evaluate(() => Object.keys(localStorage).some((k) => k.startsWith("flowfi:user-preferences:") && JSON.parse(localStorage.getItem(k)).phone === "98abc"))));

  // Valid save → Firebase Auth display name + phone preference; sidebar/topbar refresh without reload.
  await phone.fill("+91 98765 43210");
  await save.click();
  await page.getByText("Profile saved").first().waitFor({ timeout: 15000 });
  chk("sidebar shows the new name immediately", (await page.getByText("QA Renamed User").count()) >= 1);
  await page.reload();
  await page.getByRole("tab", { name: "Profile" }).waitFor({ timeout: 30000 });
  chk("name persisted across reload (Auth profile)", (await page.getByLabel("Full Name").inputValue()) === "QA Renamed User");
  chk("phone persisted across reload", (await page.getByLabel(/Phone Number/).inputValue()) === "+91 98765 43210");

  // Photo: non-image rejected, image accepted and shown in the avatar, removable.
  const input = page.locator('input[type="file"][aria-label="Profile photo file"]');
  await input.setInputFiles({ name: "x.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4") });
  chk("non-image photo is rejected", (await page.getByText(/Choose an image file/).count()) >= 1);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  await input.setInputFiles({ name: "p.png", mimeType: "image/png", buffer: png });
  await page.getByText("Photo updated").first().waitFor({ timeout: 15000 });
  chk("photo stored as a small data URL", await page.evaluate(() => Object.keys(localStorage).some((k) => k.startsWith("flowfi:user-preferences:") && (JSON.parse(localStorage.getItem(k)).avatarDataUrl || "").startsWith("data:image/jpeg"))));
  await page.getByRole("button", { name: /Remove photo/ }).click();
  chk("photo can be removed", await page.evaluate(() => Object.keys(localStorage).some((k) => k.startsWith("flowfi:user-preferences:") && JSON.parse(localStorage.getItem(k)).avatarDataUrl === "")));

  // Honest controls: inert ones are labelled and cannot be operated.
  const inertCount = await page.locator("[inert]").count();
  chk("unwired controls are inert and labelled", inertCount >= 6 && (await page.getByText("Not applied yet").count()) >= 6, `${inertCount} inert`);
  chk("no fabricated 'Last checked' time", (await page.getByText(/Last checked/).count()) === 0);

  // Theme (Preferences tab) drives the real app theme.
  await page.getByRole("tab", { name: "Preferences" }).click();
  await page.getByRole("radio", { name: "Dark" }).click();
  chk("Dark applies the dark class", await page.evaluate(() => document.documentElement.classList.contains("dark")));
  await page.getByRole("radio", { name: "Light" }).click();
  chk("Light removes the dark class", await page.evaluate(() => !document.documentElement.classList.contains("dark")));

  // Notifications tab: real browser permission state, honest delivery note.
  await page.getByRole("tab", { name: "Notifications" }).click();
  chk("delivery note is shown", (await page.getByText(/delivery isn.t live yet/).count()) >= 1);

  // Security tab: no fake 2FA switch.
  await page.getByRole("tab", { name: "Security" }).click();
  chk("2FA points to Google, no fake switch", (await page.getByRole("link", { name: "Manage in Google" }).count()) === 1);

  // Reset: preferences back to defaults (cycle → 1, phone cleared), financial data untouched.
  const accountsBefore = JSON.stringify(await h.list("accounts"));
  await page.getByRole("tab", { name: "Profile" }).click();
  await page.getByRole("button", { name: /Reset App/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: /Delete|Confirm|Reset/ }).last().click();
  await page.getByText("Preferences reset").first().waitFor({ timeout: 15000 });
  chk("reset cleared the stored phone", (await page.getByLabel(/Phone Number/).inputValue()) === "");
  chk("reset left accounts untouched", JSON.stringify(await h.list("accounts")) === accountsBefore);
  await h.shot(page, "setcycle-profile");
  notes.push("backup tab not exercised by design");
});

scenario("setcycle-loans", "Cycle start day 17: Loans & EMI window starts 17 Oct, no data rewritten", async ({ page }, chk, notes) => {
  await h.openPortalSignedIn(page);
  await h.addFixture(page, "shared-emi");
  const snapshot = async () => JSON.stringify([await h.list("loans"), await h.list("emis"), await h.list("transactions")]);
  const before = await snapshot();

  await openSettings(page);
  await page.getByRole("tab", { name: "Preferences" }).click().catch(() => {});
  await page.getByRole("tab", { name: "Profile" }).click();
  const trigger = page.getByRole("combobox", { name: /Cycle starts on/ });
  await trigger.click();
  await page.getByRole("option", { name: "17th", exact: true }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText("Month cycle saved").first().waitFor({ timeout: 15000 });

  await h.go(page, "/loans");
  const panel = page.locator('section[aria-label="My EMI commitments"]');
  await panel.waitFor({ timeout: 60000 });
  const now = new Date();
  const wantThis = expectedLabel(17, now, 0);
  const wantNext = expectedLabel(17, now, 1);
  const text = (await panel.innerText()).replace(/\s+/g, " ");
  chk("chips say This cycle / Next cycle", /This cycle/.test(text) && /Next cycle/.test(text), text.slice(0, 200));
  chk(`current window label is ${wantThis} (not the calendar month)`, text.includes(wantThis), text.slice(0, 200));
  await panel.getByRole("radio", { name: "Next cycle" }).click().catch(async () => panel.getByText("Next cycle").click());
  const nextText = (await panel.innerText()).replace(/\s+/g, " ");
  chk(`next window label is ${wantNext}`, nextText.includes(wantNext), nextText.slice(0, 200));
  await h.shot(page, "setcycle-loans-17");

  // The Month Cycle page agrees with the same configured cycle.
  await h.go(page, "/month-cycle");
  await page.waitForTimeout(1500);
  const dd = (d) => d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
  const cs = new Date(now.getFullYear(), now.getMonth() - (now.getDate() < 17 ? 1 : 0), 17);
  const ce = new Date(cs.getFullYear(), cs.getMonth() + 1, 16);
  const want = `${dd(cs)} – ${dd(ce)}`;
  const shown = await page.waitForFunction((w) => document.body.innerText.includes(w), want, { timeout: 20000 }).then(() => true).catch(() => false);
  chk("Month Cycle page shows the same cycle", shown, shown ? want : (await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 300));

  // Back to day 1 → calendar month wording returns.
  await openSettings(page);
  await page.getByRole("combobox", { name: /Cycle starts on/ }).click();
  await page.getByRole("option", { name: "1st (calendar month)", exact: true }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await h.go(page, "/loans");
  await panel.waitFor({ timeout: 60000 });
  chk("day 1 restores This month / Next month", /This month/.test(await panel.innerText()) && /Next month/.test(await panel.innerText()));

  chk("cycle changes did not modify loans, EMIs or transactions", (await snapshot()) === before);
  notes.push(`expected this=${wantThis} next=${wantNext}`);
});
