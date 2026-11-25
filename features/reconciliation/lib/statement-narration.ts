/**
 * Bank-STATEMENT narration intelligence (not SMS). A statement line is a slash chain the bank builds from fixed fields:
 *
 *   UPI/627481159639/CR/MOHAN/BKID/mohankoda/UPI          rail / reference / direction / name / bank / VPA / note
 *   UPI/627632125367/DR/Jio Pr/YESB/paytm-jio/UPI
 *   NEFT/N123456789012/MOHAN KUMAR/SBIN/salary            rail / reference / name / bank / note
 *   IMPS/P2A/627481159639/MOHAN/…
 *
 * The Transaction Inbox's SMS analyzer reads prose ("paid to SWIGGY Ref 82739 on 22Sep") — its payee phrases and
 * "to / from" rules don't apply here, so this module parses the chain by field and only REUSES the shared, pure parts:
 * the known-merchant list and wording (`suggestDescription`), the user's own history wording, and the business-word
 * rule. It never invents a purpose, a relationship or a product:
 *
 *   - a recognised merchant gets its own wording ("Jio Mobile Recharge"), and a purpose word only when the narration
 *     states it — a bank's truncated word ("Jio Pr") counts only when it is an unambiguous prefix of one of that
 *     merchant's own purpose words (PR → PREPAID, nothing else starts with PR);
 *   - anyone else is named as the narration names them: "Received from Mohan · UPI" / "Paid to Mohan · UPI";
 *   - the rail ("· UPI") is appended only when the narration is that rail.
 *
 * Pure, synchronous and cheap (one pass over a short string, the analyzer is memoised). The raw narration and its
 * reference stay on the row untouched — matching, duplicate checks and the imported transaction's notes keep them.
 */

import { analyzeCached, merchantPurposeWords, suggestDescription, type DescriptionHistory, type DescriptionSuggestion } from "@/lib/services/description-analyzer";

export type StatementRail = "UPI" | "NEFT" | "IMPS" | "RTGS" | "NACH" | "ECS" | "ATM" | "POS";

export interface StatementNarration {
  rail: StatementRail | null;
  /** The bank/UPI reference (RRN / UTR) read from the chain, digits/letters only. */
  reference: string | null;
  /** The direction marker the narration itself carries (CR / DR), if any. */
  marker: "credit" | "debit" | null;
  /** The counterparty as the narration names it, OCR word-splits repaired ("MOH AN" + VPA "mohankoda" → "MOHAN"). */
  name: string | null;
  /** The VPA's local part / handle field ("mohankoda", "paytm-jio"). */
  vpa: string | null;
  /** The IFSC bank prefix field (BKID, YESB…). Routing only — never the counterparty. */
  bank: string | null;
  /** Remaining free-text fields (a remark the payer typed). */
  note: string | null;
}

const RAILS: Record<string, StatementRail> = { UPI: "UPI", NEFT: "NEFT", IMPS: "IMPS", RTGS: "RTGS", NACH: "NACH", ACH: "NACH", ECS: "ECS", ATM: "ATM", POS: "POS" };
/** An OCR'd "UPI" ("UP1", "UPl", "UPI1", "UP|") at the start of the chain. */
const OCR_UPI = /^UP[I1lL|!]{1,2}$/i;
const MARKERS: Record<string, "credit" | "debit"> = { CR: "credit", DR: "debit", CREDIT: "credit", DEBIT: "debit" };
/** Fields that carry no counterparty: transfer kinds, filler. */
const SKIP_FIELD = new Set(["P2A", "P2M", "P2P", "MB", "IB", "INB", "MOB", "TRF", "TRANSFER", "PAYMENT", "PAY", "NA", "NIL", "UPI", "UPIINTENT", "INTENT", "COLLECT", "SENT", "RECEIVED", "OTHERS"]);
/** IFSC prefixes and wallet bank codes a chain carries — routing, never the counterparty. */
const BANK_CODES = new Set([
  "BKID", "SBIN", "HDFC", "ICIC", "UTIB", "KKBK", "PUNB", "BARB", "CNRB", "UBIN", "IDIB", "IOBA", "YESB", "INDB", "FDRL", "IDFB", "PYTM", "AIRP", "CIUB", "KVBL", "SIBL", "CSBK",
  "MAHB", "UCBA", "CBIN", "PSIB", "IBKL", "AUBL", "RATN", "ESFB", "JSFB", "USFB", "FINO", "DBSS", "SCBL", "HSBC", "CITI", "DEUT", "BDBL", "KARB", "TMBL", "DLXB", "NTBL", "LAVB", "SRCB",
]);

const lettersOnly = (s: string) => s.toUpperCase().replace(/[^A-Z]/g, "");
const titleCase = (s: string) =>
  s
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (w.length <= 1 ? w.toUpperCase() : w[0]!.toUpperCase() + w.slice(1)))
    .join(" ");

/** "62748115 9639" (an OCR space inside the reference) → "627481159639"; leaves words alone. */
function joinSplitDigits(field: string): string {
  return /^\d[\d ]{6,}\d$/.test(field.trim()) ? field.replace(/\s+/g, "") : field;
}

function isReferenceField(field: string): boolean {
  const f = field.replace(/\s+/g, "");
  return /^\d{9,22}$/.test(f) || (/^[A-Z]{1,6}\d{8,22}$/i.test(f) && /\d{8,}/.test(f));
}

/**
 * The chain's fields, or null when the text isn't a recognisable rail chain. Tolerates OCR's "UP1", stray spaces around
 * the slashes, and HDFC-style "UPI-NAME-VPA-IFSC-REF-NOTE" dashes.
 */
export function parseStatementNarration(raw: string): StatementNarration | null {
  const text = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  let parts = text.split("/").map((p) => p.trim());
  if (parts.length < 3 && /^UP[I1lL|]{1,2}-/i.test(text)) parts = text.split("-").map((p) => p.trim());
  if (parts.length < 3) return null;
  const head = parts[0]!.toUpperCase();
  const rail = RAILS[head] ?? (OCR_UPI.test(head) ? "UPI" : null);
  if (!rail) return null;

  let reference: string | null = null;
  let marker: StatementNarration["marker"] = null;
  let bank: string | null = null;
  const words: string[] = [];
  for (const rawField of parts.slice(1)) {
    const field = joinSplitDigits(rawField);
    if (!field) continue;
    const upper = field.toUpperCase();
    if (!reference && isReferenceField(field)) {
      reference = field.replace(/\s+/g, "").toUpperCase();
      continue;
    }
    if (MARKERS[upper] && !marker) {
      marker = MARKERS[upper]!;
      continue;
    }
    if (!bank && BANK_CODES.has(upper)) {
      bank = upper;
      continue;
    }
    if (SKIP_FIELD.has(upper.replace(/\s+/g, "")) || RAILS[upper] || OCR_UPI.test(upper)) continue;
    if (/^\d+$/.test(field.replace(/\s+/g, ""))) continue; // another number (a mobile, a short ref) — never a name
    words.push(field);
  }

  // Fields in order after the routing ones: the first is the name, a VPA-looking one is the VPA, the rest a note.
  let name: string | null = null;
  let vpa: string | null = null;
  const rest: string[] = [];
  for (const w of words) {
    const looksVpa = w.includes("@") || (/^[a-z0-9._-]+$/.test(w) && /[a-z]/.test(w) && !/\s/.test(w));
    if (name == null && !looksVpa) name = w;
    else if (vpa == null && looksVpa) vpa = w.split("@")[0]!;
    else rest.push(w);
  }

  if (name) name = repairSplitName(name, vpa);
  return { rail, reference, marker, name, vpa, bank, note: rest.length ? rest.join(" ") : null };
}

/**
 * OCR sometimes splits a short name ("MOH AN"). When the letters joined are the start of the VPA's own letters
 * ("mohankoda"), the split is an OCR artefact and the joined word is the name the bank printed.
 */
function repairSplitName(name: string, vpa: string | null): string {
  const clean = name.replace(/\s+/g, " ").trim();
  if (!vpa || !clean.includes(" ")) return clean;
  // Only an obvious fragment ("AN" in "MOH AN") — never a real two-word name ("SURESH KUMAR", "RAHUL K") whose VPA
  // happens to be the words run together.
  const fragments = clean.split(" ").map(lettersOnly);
  if (fragments.some((f) => f.length <= 1) || !fragments.some((f) => f.length === 2)) return clean;
  const joined = fragments.join("");
  return joined.length >= 4 && lettersOnly(vpa).startsWith(joined) ? joined : clean;
}


/** A truncated purpose word ("PR") → the merchant's full word (PREPAID), only when exactly one of its words starts with it. */
function expandPurpose(text: string): string {
  const purposes = merchantPurposeWords(text);
  if (purposes.length === 0) return text;
  const tokens = text.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  if (tokens.some((t) => purposes.includes(t))) return text;
  for (const t of tokens) {
    if (t.length < 2 || !/^[A-Z]+$/.test(t)) continue;
    const hits = purposes.filter((p) => p.startsWith(t) && p !== t);
    if (hits.length === 1) return `${text} ${hits[0]}`;
  }
  return text;
}

export interface StatementDescription extends DescriptionSuggestion {
  /** The parsed chain the wording came from (null = fell back to the general analyzer). */
  narration: StatementNarration | null;
}

/**
 * A clean, human description for a statement row, or null when nothing reliable can be said (then the row keeps the
 * bank's narration). `direction` only picks "Received from" vs "Paid to" — it is never inferred from the text.
 */
export function statementDescription(row: { description: string; direction: "debit" | "credit" | null }, history?: DescriptionHistory | null): StatementDescription | null {
  try {
    const raw = (row.description ?? "").trim();
    if (!raw) return null;
    const parsed = parseStatementNarration(raw);
    const direction = row.direction;
    if (!parsed) {
      // Not a rail chain (POS / card purchase / plain text): the shared analyzer's merchant wording only — never a guess.
      const s = suggestDescription(raw, direction, history, false);
      return s && (s.basis === "known_merchant" || s.basis === "history" || s.basis === "stated_purpose") ? { ...s, narration: null } : null;
    }
    const suffix = parsed.rail ? ` · ${parsed.rail}` : "";
    // Everything the chain says about the counterparty, for the shared merchant list.
    const evidence = [parsed.name, parsed.vpa?.replace(/[._-]+/g, " "), parsed.note].filter(Boolean).join(" ");
    if (evidence) {
      const known = analyzeCached(evidence).merchant;
      if (known) {
        const own = suggestDescription(expandPurpose(evidence), direction, history, true);
        if (own?.basis === "history") return { ...own, narration: parsed };
        if (direction === "credit") return { text: `Received from ${known.name}${suffix}`, confidence: "medium", basis: "known_merchant", narration: parsed };
        if (own) return { text: `${own.text}${suffix}`, confidence: own.confidence, basis: own.basis, narration: parsed };
      }
    }
    const name = parsed.name && lettersOnly(parsed.name).length >= 3 ? parsed.name : null;
    if (!name || !direction) return null;
    // The user's own wording for this payee, when unanimous (shared history rule).
    const own = suggestDescription(name, direction, history, true);
    if (own?.basis === "history") return { ...own, narration: parsed };
    // A business keeps its own name; a person is named exactly as printed. Either way nothing is added.
    const display = titleCase(name);
    return {
      text: `${direction === "credit" ? "Received from" : "Paid to"} ${display}${suffix}`,
      confidence: lettersOnly(name).length >= 4 ? "medium" : "low",
      basis: "payee",
      narration: parsed,
    };
  } catch {
    return null;
  }
}

// ─── References ────────────────────────────────────────────────────────────────────────────────────────────

/** A 12-digit UPI / IMPS RRN — the only reference shape compared across records (10-digit phone numbers never are). */
const RRN = /^\d{12}$/;

/** The row's own RRN: the parsed chain's reference, else the capture's reference number — only when it is 12 digits. */
export function rowRrn(row: { description: string; referenceNumber?: string | null }): string | null {
  const fromChain = parseStatementNarration(row.description)?.reference ?? null;
  for (const r of [fromChain, row.referenceNumber ?? null]) {
    const d = (r ?? "").replace(/\D/g, "");
    if (RRN.test(d)) return d;
  }
  return null;
}

/** 12-digit RRNs a text carries in a reference position: a chain field, or after ref / rrn / utr / upi / txn. */
export function rrnsIn(text: string | null | undefined): string[] {
  const t = text ?? "";
  if (!t) return [];
  const out = new Set<string>();
  const chain = parseStatementNarration(t)?.reference?.replace(/\D/g, "");
  if (chain && RRN.test(chain)) out.add(chain);
  for (const m of t.matchAll(/(?:\/|\b(?:ref(?:erence)?|rrn|utr|upi|txn|imps)\b[^0-9]{0,12})(\d{12})(?!\d)/gi)) out.add(m[1]!);
  return [...out];
}

/**
 * True when BOTH sides state a 12-digit RRN and they differ — positive evidence of two different transactions, however
 * alike the amount, day and payee. Any missing reference → false (nothing is proven either way).
 */
export function differentReferences(rrn: string | null, ...texts: (string | null | undefined)[]): boolean {
  if (!rrn) return false;
  const theirs = texts.flatMap((t) => rrnsIn(t));
  return theirs.length > 0 && !theirs.includes(rrn);
}
