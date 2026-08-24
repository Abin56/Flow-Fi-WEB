# Document-level edge fixtures

Per `docs/parser-pipeline-design.md` v3 Task 2, requirement 3. These validate
**pipeline behavior**, not transaction volume — each is intentionally small.

| Case | Fixture | Validated against |
|---|---|---|
| Encrypted PDF | `makeEncryptedPdf()` | `PdfjsDocumentProvider` (real M1-T7 infra) — expects success with the correct password |
| Wrong Password | `makeWrongPasswordTargetPdf()` (same bytes) | `PdfjsDocumentProvider` — expects `INVALID_PASSWORD` |
| Rotated PDF | `makeRotatedPdf()` | `PdfjsDocumentProvider` — real pdf-lib rotation metadata |
| Corrupted PDF | `makeCorruptedPdf()` | `PdfjsDocumentProvider` — expects `PDF_CORRUPTED` |
| Blank Page (0-page document) | `makeBlankDocumentPdf()` | `PdfjsDocumentProvider` — expects `PDF_EMPTY` |
| Scanned PDF (no text layer) | `makeNoTextLayerPdf()` | `PdfjsDocumentProvider` — opens successfully, page text is empty (this is what routes to the OCR fallback tier once that tier exists — Architecture §8) |
| Very Large Statement (page count) | `makeVeryLargePageCountPdf(n)` | `lib/statement-intelligence/ingestion-caps.ts`'s `MAX_PAGE_COUNT` boundary |
| Unsupported Layout | `makeUnsupportedLayoutPdf()` | Reserved for the Document Classifier (not yet built) — no fingerprint keywords for any of the 4 seeded issuer templates |
| Missing Last Page | `MISSING_LAST_PAGE_FIXTURE` (model-level) | `runAllBusinessValidation` — MUST report a balance-arithmetic violation; this is the point of the fixture, not a bug in it |
| No Transaction Table | `NO_TRANSACTION_TABLE_FIXTURE` (model-level) | Schema validates; `diagnostics.transactionTableFound: false` + a validation error |
| Foreign Currency Statement | `FOREIGN_CURRENCY_FIXTURE` (model-level) | Schema validates with non-trivial `currency` field usage |
| Very Old Statement | `VERY_OLD_STATEMENT_FIXTURE` (model-level) | `runAllBusinessValidation`'s date-sanity checks — a legitimately old (2018) but still-valid date, not an impossible one |

## Duplicate Upload — deliberately not a separate fixture file

"Duplicate upload" is a *behavioral* scenario (does `checkDocumentExists`, M1-T6, correctly short-circuit a repeat upload of the same file), not a distinct document shape. It's already covered by `functions/tests/check-document-exists.test.ts`'s concurrency tests, which use their own inline byte content. Creating a second, redundant fixture here would duplicate that coverage rather than add to it — noted here explicitly so its absence isn't mistaken for an oversight.
