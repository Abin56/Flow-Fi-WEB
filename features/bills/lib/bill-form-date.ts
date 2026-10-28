/**
 * The Bills form's due date, as a LOCAL calendar day — same convention as the payment dialog's `toDay` / `dayToDate`.
 * `toISOString()` / `new Date("YYYY-MM-DD")` are UTC: west of UTC they move the day back, and a date stored at local
 * midnight east of UTC is shown as the day before.
 */

/** A local calendar day as `YYYY-MM-DD`. */
export const toDay = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** `YYYY-MM-DD` → local noon, so the stored day never shifts with the time zone. */
export const dayToDate = (s: string): Date => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1, 12);
};
