/**
 * Possible-bank-name guesser — Phase 2 of the multi-bank coverage plan.
 * Runs only when NEITHER a bank-specific extractor NOR the generic
 * fallback extractor recognized a statement at all (the true
 * `unrecognized_statement_template` dead end). A plain keyword scan over
 * the raw page text, nothing more — this is deliberately not a real
 * detector (no confidence score, no attempt at extraction), just a cheap
 * breadcrumb so a document that genuinely can't be parsed yet still tells
 * you which bank it's *probably* from, instead of a bare "unrecognized."
 * Written to `FinancialDocument.detectedBankGuess` (see
 * `applyPipelineResultToDocument`) purely for product prioritization: once
 * this is live, querying real uploads for their most common guess is how
 * the next dedicated bank-specific extractor should actually get picked,
 * not guesswork.
 */

import type { PdfPageText } from "../../pdf/pdf-document-provider";

/** Every major Indian credit-card-issuing bank/entity worth recognizing by name alone — not exhaustive, and deliberately NOT the same list as `BankIssuer` (`lib/models/credit-card.ts`, a distinct, narrower list scoped to statement-password rules only). Ordered so a more specific match (e.g. "HDFC Bank") is tried before a shorter substring that could coincidentally appear elsewhere. */
const KNOWN_ISSUERS: { pattern: RegExp; label: string }[] = [
  { pattern: /\bHDFC\s*Bank\b/i, label: "HDFC Bank" },
  { pattern: /\bState\s*Bank\s*of\s*India\b|\bSBI\s*Card\b/i, label: "SBI Card" },
  { pattern: /\bICICI\s*Bank\b/i, label: "ICICI Bank" },
  { pattern: /\bAxis\s*Bank\b/i, label: "Axis Bank" },
  { pattern: /\bKotak\s*Mahindra\s*Bank\b|\bKotak\s*Bank\b/i, label: "Kotak Mahindra Bank" },
  { pattern: /\bYes\s*Bank\b/i, label: "Yes Bank" },
  { pattern: /\bIDFC\s*FIRST\s*Bank\b/i, label: "IDFC FIRST Bank" },
  { pattern: /\bIndusInd\s*Bank\b/i, label: "IndusInd Bank" },
  { pattern: /\bRBL\s*Bank\b/i, label: "RBL Bank" },
  { pattern: /\bStandard\s*Chartered\b/i, label: "Standard Chartered" },
  { pattern: /\bHSBC\b/i, label: "HSBC" },
  { pattern: /\bCitibank\b|\bCiti\s*Bank\b/i, label: "Citibank" },
  { pattern: /\bAmerican\s*Express\b|\bAmex\b/i, label: "American Express" },
  { pattern: /\bIDBI\s*Bank\b/i, label: "IDBI Bank" },
  { pattern: /\bPunjab\s*National\s*Bank\b|\bPNB\b/i, label: "Punjab National Bank" },
  { pattern: /\bBank\s*of\s*Baroda\b/i, label: "Bank of Baroda" },
  { pattern: /\bCanara\s*Bank\b/i, label: "Canara Bank" },
  { pattern: /\bUnion\s*Bank\s*of\s*India\b/i, label: "Union Bank of India" },
  { pattern: /\bFederal\s*Bank\b/i, label: "Federal Bank" },
  { pattern: /\bAU\s*Small\s*Finance\s*Bank\b/i, label: "AU Small Finance Bank" },
  { pattern: /\bBajaj\s*Finserv\b/i, label: "Bajaj Finserv" },
  { pattern: /\bOneCard\b/i, label: "OneCard" },
  { pattern: /\bSlice\b/i, label: "Slice" },
  { pattern: /\bJupiter\b/i, label: "Jupiter" },
];

/**
 * Best-effort "which bank does this probably belong to" guess from raw page
 * text alone, for a statement no real extractor (bank-specific or generic
 * fallback) recognized. Returns the first match's canonical label, or
 * `null` if nothing in the known-issuer list appears anywhere on the page.
 */
export function detectPossibleBankName(pages: PdfPageText[]): string | null {
  const fullText = pages.map((page) => page.items.map((item) => item.str).join(" ")).join(" ");
  for (const { pattern, label } of KNOWN_ISSUERS) {
    if (pattern.test(fullText)) return label;
  }
  return null;
}
