/**
 * Output formats for a `PersonCycleStatement` — the WhatsApp/text message and the PDF table model.
 * Pure formatting over the engine result: no arithmetic beyond reading its values, so the UI, text and
 * PDF can never disagree for the same person and cycle.
 */

import { formatCurrency } from "@/lib/format";
import {
  directionHeadline,
  formatStatementDate,
  perspectiveAmount,
  reconciliationLines,
  type PersonCycleStatement,
  type StatementCategory,
} from "@/lib/engines/person-cycle-statement";

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
  lines.push("", `*${sharedPositionLine(s)}*`);
  return lines.join("\n");
}

export function whatsAppShareUrl(text: string, phone?: string | null): string {
  const digits = (phone ?? "").replace(/\D/g, "");
  const target = digits.length === 10 ? `91${digits}` : digits;
  return `https://wa.me/${target}?text=${encodeURIComponent(text)}`;
}

// ---------------------------------------------------------------------------------------------------
// PDF model
// ---------------------------------------------------------------------------------------------------

export interface StatementPdfRow {
  date: string;
  description: string;
  type: string;
  isEmi: boolean;
  /** Display-only metadata from the authoritative statement row; never used for arithmetic. */
  category?: StatementCategory;
  status?: string;
  detail?: string;
  /** Amount that increased the reading-perspective balance, or "". */
  added: string;
  /** Amount that reduced it, or "". */
  settled: string;
  balance: string;
}

export interface StatementPdfModel {
  title: string;
  subtitle: string;
  personName: string;
  cycleLabel: string;
  summary: { label: string; value: string }[];
  positionHeadline: string;
  positionAmount: string;
  columns: string[];
  openingRow: StatementPdfRow;
  rows: StatementPdfRow[];
  closingRow: StatementPdfRow;
  /** The engine's closing value, for verification. */
  currentPending: number;
}

const shortDate = (d: Date) => formatStatementDate(d, true);

export function statementPdfModel(s: PersonCycleStatement): StatementPdfModel {
  const rec = reconciliationLines(s);
  const summaryLabels: Record<string, string> = { "This cycle": "This Cycle", "Previous pending": "Previous Pending", "Current pending": "Current Pending" };
  return {
    title: "FlowFi",
    subtitle: "Cycle Settlement Statement",
    personName: s.personName,
    cycleLabel: s.cycleLabel,
    summary: rec.map((l) => ({ label: summaryLabels[l.label] ?? l.label, value: money(l.value) })),
    positionHeadline: directionHeadline(s.direction),
    positionAmount: money(s.amount),
    columns: ["No.", "Date", "Description", "Type", "Added", "Settled", "Balance", "Status"],
    openingRow: {
      date: shortDate(s.cycle.start),
      description: "Previous pending (brought forward)",
      type: "",
      isEmi: false,
      added: "",
      settled: "",
      balance: money(perspectiveAmount(s, s.previousPending)),
    },
    rows: s.rows.map((r) => {
      const v = perspectiveAmount(s, r.signedAmount);
      const detail = r.emi ? ` · Installment #${r.emi.installmentNumber}` : r.settles ? ` · against ${r.settles.title}` : "";
      return {
        date: shortDate(r.date),
        description: r.title,
        detail: detail.trim().replace(/^·\s*/, ""),
        type: r.typeLabel,
        isEmi: r.category === "emi",
        category: r.category,
        status: r.emi ? `Bank: ${r.emi.status}` : r.kind === "settlement" ? "Settled" : "Open",
        added: v > 0 ? money(v) : "",
        settled: v < 0 ? money(-v) : "",
        balance: money(perspectiveAmount(s, r.runningBalance)),
      };
    }),
    closingRow: {
      date: shortDate(s.cycle.end),
      description: "Current pending",
      type: "",
      isEmi: false,
      added: "",
      settled: "",
      balance: money(perspectiveAmount(s, s.currentPending)),
    },
    currentPending: s.currentPending,
  };
}
