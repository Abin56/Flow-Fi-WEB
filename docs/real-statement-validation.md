# Validating the PDF parser on real statements (local, read-only)

Purpose: check the parser against 2–3 real statements from different banks **without importing anything**. The tool
runs entirely on your machine: it reads the PDF, runs the same text extraction and extractor registry the Cloud
Function uses, and prints a summary. It has no Firebase code in it (a test enforces that), so it cannot write to
Firestore or Storage.

## Steps (per statement)

1. Build once: `npm --prefix functions run build`
2. If the PDF is password-protected, set the password in the environment (not on the command line):
   PowerShell `$env:FLOWFI_PDF_PASSWORD = "..."`
3. Read the statement yourself and write down, in a scratch file **outside the repo**, what it really contains:
   ```json
   {
     "rowCount": 42,
     "totalDebits": 12345.67,
     "totalCredits": 5000.00,
     "rows": [{ "date": "2026-07-12", "amount": 1499.00, "direction": "debit" }]
   }
   ```
   `totalDebits` / `totalCredits` can come straight from the statement's own printed summary
   ("Purchases/Debit", "Payments/Credits received"). `rows` is optional but gives exact per-row diffs.
4. Run: `npm --prefix functions run validate:statement -- "C:\path\statement.pdf" --expect "C:\path\expected.json"`
   - Default output is counts and totals only. `--show-rows` adds date / amount / direction / confidence / flags per
     row. Merchant text is never printed.
5. Read the result:
   - `PASS` — counts, totals and rows match.
   - `FAIL` lists missing rows, extra rows (marked `NOT flagged` if the parser did not warn about them) and direction
     mismatches with the basis the parser used (`column` and `marker` are explicit; `sign`, `keyword`, `none`,
     `conflict` are guesses and must show up as flags).
   - A row that is wrong **and** unflagged is the important failure — report it as a new fixture.
6. For a regression fixture, add `--redact-out functions/tests/fixtures/real-statements/<bank>-<yyyy-mm>.items.json`.
   The tool keeps layout and dates/amounts, replaces names, addresses, card/account numbers and merchants with
   `MERCHANT n`, proves the redacted copy parses to identical rows, and refuses to overwrite an existing file.
   Open the file and check it by eye before committing. Never commit the PDF or the expected-figures file.

## What this does not tell you

- Scanned (image-only) PDFs report "no usable text layer" and yield no rows — there is no OCR.
- A pass on 2–3 statements shows those layouts work, not that every bank does.
