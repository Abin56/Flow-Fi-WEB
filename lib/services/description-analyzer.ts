/**
 * Shared, pure description analyzer (used by Transaction Candidates) — turns a raw narration ("UPI/DR/458921/SWIGGY/YESB/Payment") into a clean, human
 * suggestion ("Swiggy — Food Order"). Pure, local and deterministic: no network, no storage, no AI.
 *
 * Safety contract (see also `importDescriptionOf`):
 *  - It only ever proposes TEXT. It never reads or changes amount, direction, account, category or any accounting
 *    meaning; the row's raw `description` (what matching and duplicate detection compare) is never touched.
 *  - It never invents what was bought. A restaurant is a restaurant; only words the narration itself states
 *    ("for biryani") or a merchant whose business is the purpose (Swiggy → Food Order) are used.
 *  - An unknown payee is never assumed to be a shop: it becomes "Payment to <name>" (or the cleaned name), low confidence.
 *  - Payment processors and banks (PhonePe, Razorpay, YESB…) are routing, never the merchant.
 *  - History only comes from the user's own manually recorded transactions, and only when it is unanimous enough.
 */

import type { Transaction } from "@/lib/models/transaction";
import { isNoiseWord, isReferenceLike } from "@/features/reconciliation/lib/merchant-normalize";

export type DescriptionDirection = "debit" | "credit";

export type SuggestionConfidence = "high" | "medium" | "low";
export type SuggestionBasis = "history" | "known_merchant" | "stated_purpose" | "payee" | "cleaned" | "payment_type";

export interface DescriptionSuggestion {
  text: string;
  confidence: SuggestionConfidence;
  basis: SuggestionBasis;
}

interface KnownMerchant {
  id: string;
  name: string;
  /** Alternative printed spellings, each one token sequence (upper-case, letters/digits only). */
  patterns: string[][];
  /** Full suggestion when the merchant's own business is the purpose. */
  label?: string;
  /** Purpose word found in the narration → full suggestion. */
  byWord?: Record<string, string>;
  /** Too short to trust alone — needs one of its purpose words in the narration. */
  needsPurposeWord?: boolean;
  /** Category names this merchant's business implies, best first — matched against the USER's own categories, never created. */
  categories?: string[];
}

const RECHARGE = { RECHARGE: "", PREPAID: "", PLAN: "" };

function telecom(id: string, name: string, patterns: string[][], opts: { needsPurposeWord?: boolean; fiber?: string } = {}): KnownMerchant {
  const by: Record<string, string> = {};
  for (const w of Object.keys(RECHARGE)) by[w] = `${name} Mobile Recharge`;
  by.POSTPAID = `${name} Mobile Bill`;
  by.BILL = `${name} Bill`;
  if (opts.fiber) for (const w of ["FIBER", "FIBRE", "BROADBAND"]) by[w] = `${name} ${opts.fiber}`;
  return { id, name, patterns, byWord: by, needsPurposeWord: opts.needsPurposeWord };
}

const MERCHANTS: KnownMerchant[] = [
  { id: "swiggy-instamart", name: "Swiggy Instamart", patterns: [["SWIGGY", "INSTAMART"], ["SWIGGYINSTAMART"], ["INSTAMART"]], label: "Swiggy Instamart — Groceries" },
  { id: "swiggy", name: "Swiggy", patterns: [["SWIGGY"], ["BUNDL"]], label: "Swiggy — Food Order" },
  { id: "zomato", name: "Zomato", patterns: [["ZOMATO"]], label: "Zomato — Food Order" },
  { id: "blinkit", name: "Blinkit", patterns: [["BLINKIT"], ["GROFERS"]], label: "Blinkit — Groceries" },
  { id: "zepto", name: "Zepto", patterns: [["ZEPTO"]], label: "Zepto — Groceries" },
  { id: "bigbasket", name: "BigBasket", patterns: [["BIGBASKET"], ["BIG", "BASKET"]], label: "BigBasket — Groceries" },
  telecom("jio", "Jio", [["JIO"], ["RELIANCE", "JIO"]], { fiber: "Fiber Bill" }),
  telecom("airtel", "Airtel", [["AIRTEL"], ["BHARTI", "AIRTEL"]], { fiber: "Broadband Bill" }),
  telecom("vi", "Vi", [["VI"], ["VODAFONE", "IDEA"], ["VODAFONE"]], { needsPurposeWord: true }),
  telecom("bsnl", "BSNL", [["BSNL"]], { fiber: "Broadband Bill" }),
  { id: "amazon", name: "Amazon", patterns: [["AMAZON"], ["AMZN"]] },
  { id: "flipkart", name: "Flipkart", patterns: [["FLIPKART"], ["FKRT"]] },
  { id: "myntra", name: "Myntra", patterns: [["MYNTRA"]] },
  { id: "ajio", name: "Ajio", patterns: [["AJIO"]] },
  { id: "meesho", name: "Meesho", patterns: [["MEESHO"]] },
  { id: "dominos", name: "Domino's", patterns: [["DOMINOS"], ["DOMINO", "S"]] },
  { id: "mcdonalds", name: "McDonald's", patterns: [["MCDONALDS"], ["MCDONALD", "S"]] },
  { id: "kfc", name: "KFC", patterns: [["KFC"]] },
  { id: "starbucks", name: "Starbucks", patterns: [["STARBUCKS"]] },
  { id: "uber", name: "Uber", patterns: [["UBER"]], label: "Uber — Ride" },
  { id: "ola", name: "Ola", patterns: [["OLA"], ["OLACABS"]], label: "Ola — Ride" },
  { id: "rapido", name: "Rapido", patterns: [["RAPIDO"]], label: "Rapido — Ride" },
  { id: "indian-railways", name: "Indian Railways", patterns: [["INDIAN", "RAILWAYS"], ["INDIAN", "RAILWAY"], ["INDIANRAILWAYS"]] },
  { id: "irctc", name: "IRCTC", patterns: [["IRCTC"]], label: "IRCTC — Train Ticket" },
  { id: "redbus", name: "redBus", patterns: [["REDBUS"]], label: "redBus — Bus Ticket" },
  { id: "bookmyshow", name: "BookMyShow", patterns: [["BOOKMYSHOW"], ["BOOK", "MY", "SHOW"]], label: "BookMyShow — Tickets" },
  { id: "netflix", name: "Netflix", patterns: [["NETFLIX"]], label: "Netflix — Subscription" },
  { id: "spotify", name: "Spotify", patterns: [["SPOTIFY"]], label: "Spotify — Subscription" },
  { id: "hotstar", name: "Disney+ Hotstar", patterns: [["HOTSTAR"], ["DISNEY", "HOTSTAR"]], label: "Disney+ Hotstar — Subscription" },
  { id: "kseb", name: "KSEB", patterns: [["KSEB"], ["KSEBL"]], label: "KSEB — Electricity Bill" },
  { id: "bescom", name: "BESCOM", patterns: [["BESCOM"]], label: "BESCOM — Electricity Bill" },
];

const FOOD = ["Food & Dining", "Food and Dining", "Food", "Dining"];
const GROCERY = ["Groceries", "Grocery", ...FOOD];
const TELECOM = ["Mobile & Internet", "Mobile and Internet", "Bills & Utilities", "Bills and Utilities", "Utilities", "Bills"];
const TRAVEL = ["Travel", "Transport", "Transportation"];
const UTILITY = ["Utilities", "Bills & Utilities", "Bills and Utilities", "Bills"];
const FUN = ["Entertainment", "Subscriptions"];
const CATEGORY_HINTS: Record<string, string[]> = {
  swiggy: FOOD, zomato: FOOD, dominos: FOOD, mcdonalds: FOOD, kfc: FOOD, starbucks: FOOD,
  "swiggy-instamart": GROCERY, blinkit: GROCERY, zepto: GROCERY, bigbasket: GROCERY,
  jio: TELECOM, airtel: TELECOM, vi: TELECOM, bsnl: TELECOM,
  "indian-railways": TRAVEL, irctc: TRAVEL, redbus: TRAVEL, uber: TRAVEL, ola: TRAVEL, rapido: TRAVEL,
  kseb: UTILITY, bescom: UTILITY,
  netflix: FUN, spotify: FUN, hotstar: FUN, bookmyshow: ["Entertainment"],
};
for (const m of MERCHANTS) if (CATEGORY_HINTS[m.id]) m.categories = CATEGORY_HINTS[m.id];

/** Payment apps / gateways / bank names: they carry the payment, they are never the merchant. */
const ROUTING = new Set([
  "PHONEPE", "GPAY", "GOOGLEPAY", "PAYTM", "BHARATPE", "RAZORPAY", "PAYU", "BILLDESK", "CCAVENUE", "CASHFREE", "JUSPAY", "PINELABS", "MOBIKWIK", "FREECHARGE", "CRED",
  "AXIS", "KOTAK", "SBI", "BOI", "PNB", "BOB", "FEDERAL", "CANARA", "INDUSIND", "IDFC", "AU", "BANK", "NPCI", "BHIM",
  "OKAXIS", "OKSBI", "OKICICI", "OKHDFCBANK", "YBL", "IBL", "AXL", "APL", "PAYTMBANK", "UPI",
]);

/** Free text that carries no purpose. */
const FILLER = new Set([
  "PAID", "PAY", "PAYING", "SENT", "SEND", "TRANSFER", "TO", "FROM", "FOR", "MONEY", "P2A", "P2M", "P2P", "MERCHANT", "COLLECT", "MANDATE", "AUTOPAY",
  "BY", "VIA", "THRU", "THROUGH", "UPIID", "ATM", "WDL", "SELF", "A", "AN", "ON", "AT", "MY", "ORDER", "ORDERS",
  "ONLINE", "PURCHASE", "POS", "ECOM", "ECOMM", "PUR", "CARD", "DEBIT", "CREDIT", "DR", "CR", "REFUND", "REVERSAL", "ID", "NO", "REF", "TXN", "ACCOUNT", "AC",
]);

/** Words that mark a payee as a business, not a person — such a payee keeps its own name ("Kerala Biryani House"). */
const BUSINESS_WORDS = new Set([
  "HOUSE", "RESTAURANT", "HOTEL", "CAFE", "BAKERY", "STORE", "STORES", "SHOP", "MART", "SUPERMARKET", "FOODS", "FOOD", "TRADERS", "TRADING", "ENTERPRISES", "ENTERPRISE",
  "TECHNOLOGIES", "SERVICES", "SOLUTIONS", "PHARMACY", "MEDICALS", "MEDICAL", "HOSPITAL", "CLINIC", "AGENCY", "AGENCIES", "STUDIO", "SALON", "BAZAAR", "MOBILES", "ELECTRONICS",
  "TEXTILES", "FUELS", "PETROL", "PUMP", "TRAVELS", "CABS", "KITCHEN", "BIRYANI", "TEA", "COFFEE", "JUICE", "SWEETS", "DAIRY", "GROCERY", "PROVISIONS", "WORKS", "CENTRE", "CENTER", "CLUB",
  "STALL", "STALLS", "BOOKS", "FRUITS", "VEGETABLES", "STATIONERY", "HARDWARE", "GARAGE", "WORKSHOP", "OPTICALS", "BOUTIQUE", "RESTO", "CANTEEN", "MESS",
]);

const GENERIC_NOTE = new Set(["PAYMENT", "UPI", "PAID", "SENT", "MONEY", "TRANSFER", "THANKS", "THANKYOU", "OK", "DONE", "NA", "NIL", "OTHERS", "OTHER"]);

/** Raw narration → upper-case word tokens; a VPA ("name@ybl") contributes its local part, never its handle. */
function rawTokens(raw: string): { tokens: string[]; hasVpa: boolean } {
  let hasVpa = false;
  const text = raw
    .toUpperCase()
    .replace(/([A-Z0-9._-]+)@[A-Z0-9]+/g, (_m, local: string) => {
      hasVpa = true;
      return ` ${local.replace(/[._-]+/g, " ")} `;
    });
  return { tokens: text.split(/[^A-Z0-9]+/).filter(Boolean), hasVpa };
}

/** Letter lookalikes an OCR read swaps for digits — used only for the conservative fuzzy merchant match. */
function deOcr(token: string): string {
  return token.replace(/0/g, "O").replace(/1/g, "I").replace(/5/g, "S").replace(/8/g, "B");
}

export function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  return s.slice(i) === l.slice(i + 1);
}

function tokenEquals(token: string, pattern: string): boolean {
  if (token === pattern) return true;
  // A run-on ("SWIGGYLTD", "JIORECHARGE"): a long pattern at the start of a token.
  return pattern.length >= 5 && token.startsWith(pattern) && token.length <= pattern.length + 6;
}

function matchPattern(tokens: string[], pattern: string[]): boolean {
  for (let i = 0; i + pattern.length <= tokens.length; i++) {
    if (pattern.every((p, j) => tokenEquals(tokens[i + j]!, p))) return true;
  }
  return false;
}

const SINGLE_FUZZY: { pattern: string; merchant: KnownMerchant }[] = MERCHANTS.flatMap((m) =>
  m.patterns.filter((p) => p.length === 1 && p[0]!.length >= 6).map((p) => ({ pattern: p[0]!, merchant: m })),
);

function findMerchant(tokens: string[]): KnownMerchant | null {
  let best: { merchant: KnownMerchant; weight: number } | null = null;
  for (const m of MERCHANTS) {
    for (const p of m.patterns) {
      if (!matchPattern(tokens, p)) continue;
      const weight = p.reduce((n, w) => n + w.length, 0) + p.length * 10;
      if (!best || weight > best.weight) best = { merchant: m, weight };
    }
  }
  if (best) return best.merchant;
  // Conservative fuzzy: a long token one character off exactly one known merchant (SW1GGY, ZOMATTO).
  const hits = new Set<KnownMerchant>();
  for (const token of tokens) {
    if (token.length < 6) continue;
    const candidates = [token, deOcr(token)];
    for (const { pattern, merchant } of SINGLE_FUZZY) if (candidates.some((c) => withinOneEdit(c, pattern))) hits.add(merchant);
  }
  return hits.size === 1 ? [...hits][0]! : null;
}

const titleCase = (word: string) => (word.length <= 1 ? word : word[0]!.toUpperCase() + word.slice(1).toLowerCase());

/** Words that name the payee: no rails, banks, processors, filler, references or lone digits. */
function payeeWords(tokens: string[]): string[] {
  const out: string[] = [];
  for (const t of tokens) {
    if (t.length < 2 || /\d/.test(t) || isNoiseWord(t) || isReferenceLike(t) || ROUTING.has(t) || FILLER.has(t)) continue;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

/** Words the narration itself states after "FOR" ("…/For Biryani") — never anything inferred. */
function statedNote(tokens: string[]): string | null {
  const at = tokens.indexOf("FOR");
  if (at < 1) return null;
  const words: string[] = [];
  for (const t of tokens.slice(at + 1)) {
    if (words.length === 3 || t.length < 3 || /\d/.test(t) || isNoiseWord(t) || ROUTING.has(t) || GENERIC_NOTE.has(t) || FILLER.has(t)) break;
    words.push(t);
  }
  return words.length ? words.map(titleCase).join(" ") : null;
}

export interface Analysis {
  merchant: KnownMerchant | null;
  /** The merchant's purpose word found in the narration (RECHARGE…), or null. */
  purposeWord: string | null;
  payee: string[];
  note: string | null;
  hasVpa: boolean;
  /** A key two descriptions share when they are about the same payee (and purpose) — for history lookup only. */
  identity: string | null;
}

export function analyze(raw: string): Analysis {
  const { tokens, hasVpa } = rawTokens(raw);
  let merchant = findMerchant(tokens);
  let purposeWord: string | null = null;
  if (merchant?.byWord) purposeWord = Object.keys(merchant.byWord).find((w) => tokens.includes(w)) ?? null;
  if (merchant?.needsPurposeWord && !purposeWord) merchant = null;
  const payee = payeeWords(tokens);
  const identity = merchant ? `m:${merchant.id}|${purposeWord ?? ""}` : payee.length ? `p:${payee.join(" ")}` : null;
  return { merchant, purposeWord, payee, note: statedNote(tokens), hasVpa, identity };
}

const same = (a: string, b: string) => a.replace(/\s+/g, " ").trim().toLowerCase() === b.replace(/\s+/g, " ").trim().toLowerCase();

// ─── History: the user's own manually recorded descriptions ──────────────────────────────────────────────

interface HistoryEntry {
  text: string;
  count: number;
}
export type DescriptionHistory = Map<string, HistoryEntry[]>;

/** A past description that looks like raw bank text is not "confirmed" wording. */
function looksRaw(text: string): boolean {
  return /[\/@|]/.test(text) || /\d{5,}/.test(text) || text.length > 60 || text.length < 2;
}

/**
 * Index of the user's own wording per payee identity. Only manually recorded, live, non-transfer, non-loan
 * transactions count — SMS/statement/Smart Capture imports are unconfirmed (OCR slips, bank text) and never teach.
 */
export function buildDescriptionHistory(transactions: readonly Transaction[]): DescriptionHistory {
  const index: DescriptionHistory = new Map();
  for (const t of transactions) {
    if (t.source !== "manual" || t.deletedAt != null || t.transferId || t.loanId || t.emiId) continue;
    const text = (t.description ?? "").replace(/\s+/g, " ").trim();
    if (!text || looksRaw(text)) continue;
    const id = analyze(text).identity;
    if (!id) continue;
    const key = `${t.type}|${id}`;
    const list = index.get(key) ?? [];
    const hit = list.find((e) => e.text.toLowerCase() === text.toLowerCase());
    if (hit) hit.count++;
    else list.push({ text, count: 1 });
    index.set(key, list);
  }
  return index;
}

/** The user's own wording, only when unanimous enough: one wording, or one that clearly dominates (≥2 uses, ≥70%). */
function fromHistory(history: DescriptionHistory, type: "income" | "expense", identity: string): { text: string; count: number } | null {
  const list = history.get(`${type}|${identity}`);
  if (!list?.length) return null;
  const total = list.reduce((n, e) => n + e.count, 0);
  const top = list.reduce((a, b) => (b.count > a.count ? b : a));
  if (list.length === 1 || (top.count >= 2 && top.count / total >= 0.7)) return top;
  return null; // conflicting wording — don't pick one for the user
}

// ─── Suggestion ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * The suggested description for one raw narration, or null when there is nothing worth suggesting (blank, nothing
 * recognisable, or the cleaned text is what the row already says). `direction` only chooses the wording
 * ("Payment to" / "Payment from") — it is never an output.
 */
export function suggestDescription(raw: string, direction: DescriptionDirection | null, history?: DescriptionHistory | null, keepSame = false): DescriptionSuggestion | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  const a = analyze(text);
  const out = build(a, direction, history ?? null);
  if (!out || out.text.length < 2 || (!keepSame && same(out.text, text))) return null;
  return out;
}

function build(a: Analysis, direction: DescriptionDirection | null, history: DescriptionHistory | null): DescriptionSuggestion | null {
  const type = direction === "credit" ? "income" : "expense";
  if (history && a.identity && direction) {
    const own = fromHistory(history, type, a.identity);
    if (own) return { text: own.text, confidence: own.count >= 2 ? "high" : "medium", basis: "history" };
    // The narration may state a purpose the user never used — then no purpose-less history applies (checked above by identity).
  }
  const m = a.merchant;
  if (m) {
    if (a.purposeWord && m.byWord?.[a.purposeWord]) return { text: m.byWord[a.purposeWord]!, confidence: "high", basis: "known_merchant" };
    if (a.note) return { text: `${m.name} — ${a.note}`, confidence: "high", basis: "stated_purpose" };
    if (m.label) return { text: m.label, confidence: "high", basis: "known_merchant" };
    return { text: m.name, confidence: "medium", basis: "known_merchant" };
  }
  if (a.payee.length === 0) return null;
  const name = a.payee.map(titleCase).join(" ");
  const withNote = (base: string) => (a.note ? `${base} — ${a.note}` : base);
  return { text: withNote(name), confidence: a.note ? "medium" : "low", basis: a.note ? "stated_purpose" : "cleaned" };
}

/** Wording for an unknown UPI payee: "Payment to Mohan". Used by the row-level entry point when the narration is UPI. */
export function suggestForRow(row: { description: string; direction: DescriptionDirection | null }, history?: DescriptionHistory | null, opts: { upi?: boolean; keepSame?: boolean } = {}): DescriptionSuggestion | null {
  const base = suggestDescription(row.description, row.direction, history, opts.keepSame === true);
  if (!base || base.basis !== "cleaned" || !(opts.upi || /\bUPI\b|@/i.test(row.description)) || !row.direction) return base;
  // A business keeps its own name; only a payee that looks like a person becomes "Payment to …".
  if (base.text.toUpperCase().split(" ").some((w) => BUSINESS_WORDS.has(w))) return base;
  const text = `${row.direction === "credit" ? "Payment from" : "Payment to"} ${base.text}`;
  return !opts.keepSame && same(text, row.description) ? null : { ...base, text, basis: "payee" };
}

/**
 * Suggestions for a whole statement — one pass, each distinct narration analysed once, a failure on one row only
 * costs that row its suggestion. Never throws.
 */
export function suggestionsForRows(rows: readonly { id: string; description: string; direction: DescriptionDirection | null }[], history?: DescriptionHistory | null): Map<string, DescriptionSuggestion> {
  const out = new Map<string, DescriptionSuggestion>();
  const seen = new Map<string, DescriptionSuggestion | null>();
  for (const row of rows) {
    const key = `${row.direction ?? ""}|${row.description}`;
    let s = seen.get(key);
    if (s === undefined) {
      try {
        s = suggestForRow(row, history);
      } catch {
        s = null;
      }
      seen.set(key, s);
    }
    if (s) out.set(row.id, s);
  }
  return out;
}

// ─── Shared helpers for the category / autocomplete layers ───────────────────────────────────────────────

const analysisCache = new Map<string, Analysis>();
/** `analyze` with a bounded memo — the same narration is analysed once however often it is typed, listed or indexed. */
export function analyzeCached(raw: string): Analysis {
  const key = raw ?? "";
  let hit = analysisCache.get(key);
  if (!hit) {
    hit = analyze(key);
    if (analysisCache.size > 5000) analysisCache.clear();
    analysisCache.set(key, hit);
  }
  return hit;
}

/** Category names implied by the recognised merchant (e.g. Jio → Mobile & Internet), best first; null when none is recognised. */
export function merchantCategoryNames(raw: string): string[] | null {
  return analyzeCached(raw).merchant?.categories ?? null;
}

/**
 * The purpose words the recognised merchant understands (Jio → RECHARGE, PREPAID, PLAN, POSTPAID, BILL…), upper-case;
 * empty when no merchant is recognised or it has none. Read-only — lets a caller expand a bank's truncated word
 * ("Jio Pr" → PREPAID) only when it is an unambiguous prefix of one of THESE words, never a guess.
 */
export function merchantPurposeWords(raw: string): string[] {
  return Object.keys(analyzeCached(raw).merchant?.byWord ?? {});
}

export interface MerchantCompletion {
  text: string;
  /** Category names the merchant implies (see `merchantCategoryNames`). */
  categories: string[] | null;
}

/**
 * Known-merchant completions for what is being typed ("swi" → "Swiggy — Food Order", "Swiggy Instamart — Groceries";
 * "jio" → "Jio Mobile Recharge", …). Prefix on the merchant's name or any printed alias, plus a conservative one-edit
 * tolerance for typos ("swigy"). Only merchants FlowFi knows — never the user's history, never invented items.
 */
export function merchantCompletions(query: string, limit = 4): MerchantCompletion[] {
  const q = query.toUpperCase().replace(/[^A-Z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  if (q.length < 2) return [];
  const exactHits: MerchantCompletion[] = [];
  const fuzzyHits: MerchantCompletion[] = [];
  for (const m of MERCHANTS) {
    const names = [m.name.toUpperCase(), ...m.patterns.map((p) => p.join(" "))];
    const starts = names.some((n) => n.startsWith(q));
    const first = q.split(" ")[0]!;
    const typo = !starts && first.length >= 4 && names.some((n) => withinOneEdit(first, n.split(" ")[0]!.slice(0, first.length)) || withinOneEdit(first, n.split(" ")[0]!));
    if (!starts && !typo) continue;
    const variants = new Set<string>();
    if (m.label) variants.add(m.label);
    if (m.byWord) for (const v of Object.values(m.byWord)) if (!/ Bill$/.test(v) || !m.byWord.RECHARGE) variants.add(v);
    if (variants.size === 0) variants.add(m.name);
    for (const text of variants) (starts ? exactHits : fuzzyHits).push({ text, categories: m.categories ?? null });
  }
  return [...exactHits, ...fuzzyHits].slice(0, limit);
}
