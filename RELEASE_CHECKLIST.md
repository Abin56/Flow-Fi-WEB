# Release Checklist

Use before any deploy to a shared or production Firebase project. See `DEPLOYMENT.md` for the exact commands referenced below and `KNOWN_LIMITATIONS.md` for what this release does not cover.

## 1. Code state

- [ ] Working tree matches the intended release scope — `git status` reviewed, no unrelated in-progress changes bundled in accidentally.
- [ ] All target commits are on the branch being deployed; no uncommitted local-only changes.
- [ ] No `TODO`/`FIXME`/`HACK` markers left in changed files unless intentionally tracked.

## 2. Tests and typechecking

- [ ] `npm run lint` — zero errors, zero warnings.
- [ ] `npx tsc --noEmit` (root) — clean.
- [ ] `npm run test` — all passing.
- [ ] `npm run test:rules` — all passing (Firestore/Storage rules against the emulator).
- [ ] `npm run test:functions` — all passing (Cloud Functions against the emulator).
- [ ] `cd functions && npm run typecheck` — clean.
- [ ] `cd functions && npm test` — all passing.
- [ ] If any suite showed flakiness, re-run it at least 3 times consecutively to confirm it's stable before proceeding (see `docs/milestone-1-exit-report.md` §8 for why this matters in this repo).

## 3. Firestore / Storage

- [ ] `firestore.rules` changes (if any) reviewed against the "OR across matches, not most-specific-wins" semantics documented in the rules file itself.
- [ ] `firestore.indexes.json` includes any new composite/`collectionGroup` indexes required by queries in this release.
- [ ] `storage.rules` changes (if any) reviewed for correct per-path scoping.

## 4. Environment and secrets

- [ ] Target Firebase project confirmed (`firebase use`) — matches the intended environment, not accidentally production.
- [ ] Any new Cloud Functions secrets/config are set in the target project before Functions deploy.
- [ ] `.env.local` / client Firebase config verified for the environment being built.

## 5. Build

- [ ] `npm run build` (Next.js) succeeds with no errors.
- [ ] `cd functions && npm run build` succeeds with no errors.

## 6. Deploy

- [ ] Deploy rules/indexes first if this release changes access control or adds required indexes: `firebase deploy --only firestore:rules,firestore:indexes,storage`.
- [ ] Deploy functions: `firebase deploy --only functions`.
- [ ] Deploy remaining targets per `firebase.json` if applicable.

## 7. Post-deploy verification

- [ ] `firebase functions:list` matches expected exports from `functions/src/index.ts`.
- [ ] `firebase functions:log` checked for cold-start/permission errors in the first few minutes.
- [ ] Manual smoke test: document upload → dedupe check → password-protected decrypt flow (no automated integration coverage on the `onCall` layer yet — see `KNOWN_LIMITATIONS.md`).
- [ ] Manual spot-check of at least one page per finance module against real (not emulator) data: Dashboard, Accounts, Credit Cards, Transactions, Bills, Budget, EMI, Loans, People, Savings.

## 8. Sign-off

- [ ] Known limitations for this release reviewed and, if new ones were introduced, added to `KNOWN_LIMITATIONS.md`.
- [ ] `CHANGELOG.md` updated with this release's changes.
- [ ] Rollback plan understood (see `DEPLOYMENT.md` § Rollback) in case post-deploy verification fails.
