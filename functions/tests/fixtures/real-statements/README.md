# Real statement fixtures — provenance

These `.items.json` files are **redacted, positional text-item snapshots** of real bank statement PDFs, captured once via `pdfjs-dist` (the same extraction `PdfjsDocumentProvider` uses in production — ADR-006) and committed as the permanent regression fixture for the Statement Parsing Engine (`docs/parser-pipeline-design.md` v3 §10, Task 4).

## Why a JSON snapshot instead of the real PDF

The parser modules (`functions/src/parsing/**`) consume `PdfPageText[]` (page number + flattened text + positional items) — never a raw PDF. Snapshotting at that boundary means:
- The fixture is 100% real extracted data (real x/y positions, real column layout, real multi-line wrapping behavior, real font-encoding quirks) — nothing synthesized or approximated.
- No PDF-security-handler round-trip is needed to keep it working across encrypted-PDF library changes.
- Personal identifiers can be redacted as plain string replacements in JSON, verified with a simple text search, before the file is ever committed.

## Redaction discipline

**The original PDF is never committed.** Before any `.items.json` file is added:
1. Extract positional items from the real PDF locally (outside the repo).
2. Replace every personal identifier (cardholder name, address, email, CKYC ID, full account number, etc.) with an obviously-fake placeholder — same field, same general shape, different content.
3. Grep the resulting JSON for the original PII strings and confirm zero matches before committing.
4. Real transaction data (dates, amounts, merchant strings, table structure, pagination) is preserved exactly — that's the part these fixtures exist to test.

## Files

- `hdfc-freedom-2026-07.items.json` — HDFC Bank Freedom Credit Card, 4 pages, 19 real transactions (17 domestic + 2 international). Redacted fields: cardholder name, address, email, CKYC ID, alternate account number, and the last 4 digits of the card number (replaced with a placeholder — the real last 4 digits are not committed). Independently verified: summed debits (₹10,006.61) and credits (₹3,911.00) across all 19 transactions match the statement's own printed "Purchases/Debit" and "Payments/Credits Received" totals exactly.
