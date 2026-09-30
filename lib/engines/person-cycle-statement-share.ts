/**
 * Output formats for a `PersonCycleStatement` — the WhatsApp/text message. (The PDF is rendered from
 * `features/people/lib/person-statement-pdf-model.ts`, over the same engine result.)
 * Pure formatting over the engine result: no arithmetic beyond reading its values, so the UI, text and
 * PDF can never disagree for the same person and cycle.
 */

import { formatCurrency } from "@/lib/format";
import { reconciliationLines, type PersonCycleStatement } from "@/lib/engines/person-cycle-statement";

/** "₹4,750", keeping paise when present. */
export function money(value: number): string {
  const abs = Math.abs(value);
  const text = Number.isInteger(Math.round(abs * 100) / 100)
    ? formatCurrency(abs)
    : new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(abs);
  return value < 0 ? `−${text}` : text;
}

/** The first-person line for sharing WITH the person ("You owe me ₹X" / "I owe you ₹X"). */
export function sharedPositionLine(s: PersonCycleStatement): string {
  if (s.direction === "settled") return "Settled — ₹0";
  return s.direction === "theyOwe" ? `You owe me ${money(s.amount)}` : `I owe you ${money(s.amount)}`;
}

/** Concise WhatsApp/text message — summary only, never every transaction. */
export function statementShareText(s: PersonCycleStatement): string {
  const lines = ["*FlowFi — Cycle Statement*", `*${s.cycleLabel}*`, ""];
  for (const l of reconciliationLines(s)) {
    if (l.emphasis) lines.push("", `*${l.label}: ${money(l.value)}*`);
    else lines.push(`${l.label}: ${money(Math.abs(l.value))}${l.value < 0 && l.label === "Previous pending" ? " (other way)" : ""}`);
  }
  // Advance is held apart from pending (engine `advanceBalance`: − = they paid me ahead).
  const advance = s.advanceBalance ?? 0;
  if (Math.abs(advance) >= 0.005) lines.push(advance < 0 ? `Your advance with me: ${money(Math.abs(advance))}` : `My advance with you: ${money(advance)}`);
  lines.push("", `*${sharedPositionLine(s)}*`);
  return lines.join("\n");
}

export function whatsAppShareUrl(text: string, phone?: string | null): string {
  const digits = (phone ?? "").replace(/\D/g, "");
  const target = digits.length === 10 ? `91${digits}` : digits;
  return `https://wa.me/${target}?text=${encodeURIComponent(text)}`;
}
