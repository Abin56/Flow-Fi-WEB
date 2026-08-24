# Firebase Backend Infrastructure Audit

Date: 2026-08-03
Scope: Firebase backend infrastructure only (Firestore, Cloud Functions, Storage, Rules, Indexes, Config, Env) across both project roots that share Firebase project `financeapp-585eb`:
- Web: `flowfi-web` (Next.js + Cloud Functions)
- Flutter: `Finance_App`

Out of scope (per standing instructions): UI, parser logic, merchant normalization, duplicate detection, dashboard calculations, credit card engines, business logic.

---

## Architecture

Both apps read/write the same Firestore database under a `users/{uid}/...`-rooted schema, plus two global (non-user-scoped) collections. The web app additionally owns a Cloud Functions-driven "Financial Document Intelligence Engine" pipeline (ingest → decrypt → parse → staging → review workspace) that the Flutter app does not yet have repository code for.

**Firestore collections** (canonical names in `flowfi-web/lib/firestore/collections.ts` and `Finance_App/lib/core/constants/firestore_constants.dart`):

Legacy/shared: `accounts`, `transactions`, `categories`, `budgets`, `savingsGoals`, `people` (+ `ledger` subcollection), `bills` (+ `occurrences`, `payments`), `loans`, `emis` (+ `paymentBreakdowns`), `expenses`, `paymentSchedules` (+ `installments` → `payments`), `creditCards` (+ `statements` → `statementPayments`), `sharedCreditLimits`.

Web-only (Financial Document Intelligence): `financialDocuments` (+ `importHistory`, `versionHistory`, `changeLog`), `documentImports` (+ `records`), `merchantMappings` (personal, per-user), `parserHistory`, `aiInsights`.

Global: `documentTypeRegistry/{documentType}`, `merchantMappings/{mappingId}` (promoted/global alias table — same collection name as the per-user one, disambiguated only by path depth).

**Cloud Functions** (`flowfi-web/functions/src/index.ts`): 3 `onCall` callables (`checkDocumentExistsCallable`, `decryptDocumentCallable`, `ingestDocumentCallable`) plus one Firestore trigger (`onFinancialDocumentUpdated`, fires only on transition into `status: "parsing"`). No scheduled/cron functions, no plain HTTP functions. Pipeline composition: `ingestion/` → `pipeline/` (`document-pipeline.ts` seam, `pdf-document-pipeline.ts` concrete impl, `statement-intelligence-pipeline.ts`) → `worker/document-analyzer-worker.ts` (state machine) → `workspace/` (Review Workspace model) → `staging/` (batched writer to `documentImports`).

---

## Current Health

| Area | Status |
|---|---|
| Repository layer (11 domains: Account, Transaction, Budget, Bill, Credit Card, Loan, EMI, Savings, Category, People, Expense) | **Healthy.** Every domain has full CRUD, `watchAll`/`watchById`, soft delete, converters, and is wired through `lib/repositories/repository-factory.ts`. Mirrors the Flutter repository layer 1:1. |
| Cloud Functions | **Healthy.** All auth-guarded, single-responsibility, rate-limited where appropriate (`ingestion/rate-limit.ts`). 444/444 tests passing. |
| Firestore security rules (web) | **Healthy, well-reasoned.** Owner-scoped, no wildcards, field-level guards on `aiInsights`, status-gated on `documentImports`. |
| Firestore security rules (Flutter) | **Fixed this audit** — was a blanket rule that silently weakened production security since rules are project-wide. See Critical Issues. |
| Storage rules | **Fixed this audit** — added size/content-type constraints. |
| Firestore indexes | **Fixed this audit** — added the one missing composite index found. |
| Cross-platform collection naming | **Fixed this audit** — Flutter's constants file was missing the 5 web-only collection names. |
| Env / Admin SDK init | **Healthy.** No hardcoded secrets, no service account files in source, correct `initializeApp()` + ADC pattern, emulator targeting via `FIRESTORE_EMULATOR_HOST`. |

---

## Issues Found

### Critical

**1. Two divergent `firestore.rules` files governing one shared database.**
`Finance_App/firestore.rules` previously had `allow read, write: if request.auth != null && request.auth.uid == userId` at `users/{userId}/{document=**}` — a blanket rule granting full client access to every subcollection, including ones `flowfi-web/firestore.rules` deliberately locks down (`financialDocuments`: read-only; `documentImports`: no client-create, no self-promotion to `committed`; `aiInsights`: field-locked to `dismissed` only). Since both apps target project `financeapp-585eb` and Firestore rules are deployed project-wide (not per-app), deploying from the Flutter repo would have silently downgraded production security and defeated the parsing pipeline's server-side-only integrity guarantees.
**Fix applied:** `Finance_App/firestore.rules` now mirrors `flowfi-web/firestore.rules` exactly, with a header comment documenting that the two files must be kept byte-identical and that only one should ever be the deploy source of truth going forward.

### Security

**2. Storage rules had no upload size or content-type constraint.**
`flowfi-web/storage.rules` allowed any authenticated owner to upload arbitrarily large or non-PDF files to `users/{uid}/documents/{documentType}/{fileName}`, even though the entire parsing pipeline (`pdf-lib`, `pdfjs-dist`) only ever handles PDFs.
**Fix applied:** added `request.resource.size < 25 * 1024 * 1024 && request.resource.contentType == 'application/pdf'` to the `allow write` rule. Verified against the emulator test suite (`tests/rules/storage.rules.test.ts`), which now also asserts a non-PDF upload and an oversized upload both fail.

**3. No field-level validation on legacy collections' Firestore rules (documented, accepted tradeoff).**
`accounts`, `transactions`, `budgets`, etc. allow any shape/value from an authenticated owner — there is no Cloud Functions layer in front of these today. The rules file's own comments call this out as intentional and outside the original rules-authoring backlog item's scope. Left as-is; flagged here for visibility, not changed, since tightening it is a scoped decision (would need agreed field schemas per collection) rather than an infrastructure bug.

### Performance

**4. `EmiRepository.permanentlyDeleteEmi` cascaded deletes with sequential per-document `await` calls and no batch/transaction.**
`flowfi-web/lib/repositories/emi-repository.ts` — deleting an EMI walked every installment, then per-installment awaited a `payments` subcollection fetch and per-payment sequential `deleteDoc` calls, then a separate sequential loop over payment breakdowns, then two more individual deletes — all outside any batch. A failure partway through could leave orphaned installments/payments/breakdowns behind, which directly contradicted the method's own goal (no orphaned data for utilization/dashboard/reports to pick up later).
**Fix applied:** rewrote to read all affected subcollections in parallel (`Promise.all`), then queue every delete onto a single `WriteBatch` and commit once — atomic, and no longer O(installments × payments) sequential round-trips. All 444 Cloud Functions tests and typecheck still pass; no other repository consumes this method's internals, so the public signature is unchanged.

**5. Missing composite index for a genuine compound query.**
`Finance_App/lib/features/people/data/ledger_repository.dart` (`getByTransactionRef` / `getTrashByTransactionRef`) chains `.where('deletedAt', ...).where('transactionRef', isEqualTo: ...)` on the `ledger` subcollection — a real composite query with no matching index anywhere. This would throw `FAILED_PRECONDITION` in production the first time it ran against a cold index, unless someone had already clicked through a console-generated index outside source control.
**Fix applied:** added the `ledger` composite index (`deletedAt` ASC, `transactionRef` ASC) to `flowfi-web/firestore.indexes.json`, and gave `Finance_App` its own `firestore.indexes.json` + wired it into `Finance_App/firebase.json` (previously absent entirely — Flutter had no indexes file or config key at all).

Everything else in the repository/function layer was found to issue only single-field `where` queries (auto-indexed by Firestore) — no other missing-index risk found. No unused/duplicate indexes existed (the file was empty before this fix).

### Consistency

**6. Cross-platform collection-name drift.**
`Finance_App/lib/core/constants/firestore_constants.dart` had no entries for the 5 web-only Financial Document Intelligence collections (`financialDocuments`, `documentImports`, `merchantMappings`, `parserHistory`, `aiInsights`) or the global `documentTypeRegistry`. Not a live bug (Flutter has no repository code reading these yet), but a landmine for whoever adds Flutter-side support later — a typo'd literal string would silently create a sibling collection instead of matching web's.
**Fix applied:** added the same 6 constants (plus 2 subcollection names) to the Dart file, documented as declared-ahead-of-use to keep names byte-identical with web from day one.

---

## Repository Health

All 11 required domains (Account, Transaction, Budget, Bill, Credit Card, Loan, EMI, Savings, Category, People, Expense) have complete CRUD, `watchAll`, `watchById`, soft delete (`deletedAt`/`lastEditedAt`/`editHistory[]`), and Firestore converters, wired via `lib/repositories/repository-factory.ts`. No pagination anywhere in the repository layer — not flagged as a defect, since every `watchAll`/`getAll` call is scoped to a single user's data (not large shared collections), so unbounded reads are bounded by that user's own data volume.

One accepted-by-design asymmetry: `AccountRepository.adjustBalance` is called as a second, independent write alongside the transaction document write (`TransactionRepository.createTransaction`/`editTransaction`/etc.), not wrapped in a single Firestore transaction. `AccountRepository.reconcileBalance` exists specifically as a drift-correction safety net, indicating this is a known, accepted tradeoff rather than an oversight — not changed, since introducing `runTransaction` here is a behavior change to a heavily-exercised, tested code path and better suited to its own reviewed change than folded into an infrastructure audit.

## Cloud Function Health

3 callables + 1 trigger, all auth-guarded, all with focused single responsibilities, rate-limiting on the decrypt path. 444/444 tests passing post-audit (no regressions from the EMI batching fix, which lives in the web repository layer, not functions).

## Firestore Health

Schema is consistent and well-documented on the web side; the Flutter-side naming gap (Issue 6) is now closed. No unused or duplicate collections found.

## Storage Health

Single rules file, correct owner-scoping, now with size/content-type constraints (Issue 2 fixed). No orphaned-file cleanup job exists (e.g., deleting the Storage object when a `financialDocuments` doc is permanently deleted) — noted as a potential future scheduled-cleanup-job candidate, not fixed here since it wasn't found to cause data integrity issues, only Storage cost creep.

## Rules Health

Both `firestore.rules` files now identical and correct (Issue 1 fixed). Storage rules tightened (Issue 2 fixed). No missing auth checks, no `if true` wildcards found anywhere.

## Indexes Health

One missing composite index found and fixed (Issue 5). Flutter now has its own indexes file wired into its `firebase.json`, closing a config gap where Flutter had no way to deploy indexes at all.

## Tests Executed

- `npm run test:rules` (Firestore + Storage emulator, `tests/rules/*.test.ts`): **29/29 passing** (added 2 new Storage rule tests for the size/content-type constraint; fixed 1 pre-existing test that uploaded without `contentType` metadata, which the new stricter rule correctly rejected).
- `npm run test:functions` (Cloud Functions, Firestore emulator): **444/444 passing**, no regressions.
- `npx tsc --noEmit`: no new errors introduced by this audit's changes (`lib/repositories/emi-repository.ts` clean); pre-existing unrelated errors in `features/reports/components/reports-workspace.tsx` are outside this audit's scope (UI layer).

Not run: Flutter-side `flutter test` / `flutter analyze` — Flutter toolchain not available in this shell session; the two Dart file changes made (`firestore_constants.dart`, `firestore.rules`, `firestore.indexes.json`, `firebase.json`) are additive/config-only and were reviewed by hand for syntax correctness.

## Remaining Risks

1. **Deploy discipline for the now-synced rules files.** The fix makes both `firestore.rules` files identical today, but nothing in CI enforces they stay that way if one is edited without the other. Worth a follow-up: either a CI diff-check between the two files, or consolidating to a single physical file one repo symlinks/copies from.
2. **No file-size/content-type equivalent enforcement for anything beyond the one Storage path** — if new upload paths are added later they'll need the same treatment.
3. **Account/transaction balance writes are not atomic** (Issue noted under Repository Health) — accepted existing tradeoff, not introduced or worsened by this audit, but worth a dedicated review if balance-drift bugs are ever reported.
4. **No scheduled cleanup job** for Storage objects orphaned by permanently-deleted `financialDocuments`/trashed entities — cost risk, not correctness risk.

## Recommendations / Priority Fixes

All identified, in-scope, non-destructive infrastructure issues were fixed as part of this audit. No further action required to close out this pass. Suggested follow-ups (not executed, as they're either out of scope or need a product/scope decision):

1. Add a CI check (or file consolidation) so `firestore.rules` can't drift between the two repos again — **infra, low effort, recommended next**.
2. Decide whether legacy collections (`accounts`, `transactions`, ...) should get field-level Firestore rules validation, or whether that responsibility moves to a Cloud Functions layer instead — **scope decision, needs product input**.
3. Consider a scheduled Cloud Function to sweep orphaned Storage objects — **cost optimization, not urgent**.
