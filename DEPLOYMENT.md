# Deployment

FlowFi Web deploys to Firebase: Next.js app (hosting/build target), Cloud Functions (`functions/`), Firestore rules/indexes, and Storage rules. Firebase project: `financeapp-585eb` (see `.firebaserc`).

## Prerequisites

- Node.js 20 (matches `functions/package.json` `engines.node`)
- Firebase CLI (`npm install -g firebase-tools`), authenticated against the target project (`firebase login`)
- Access to the `financeapp-585eb` Firebase project (or the correct target project for the environment being deployed)

## Environment configuration

- Web app: local development uses `.env.local` (not committed). Confirm required Firebase client config keys (`NEXT_PUBLIC_FIREBASE_*` or equivalent) are present before building.
- Cloud Functions: configuration is read via `firebase-functions` params/env at deploy time. Confirm any required secrets are set in the target project (`firebase functions:secrets:set <NAME>`) before deploying — do not commit secrets to the repo.

## Pre-deploy checks (run from repo root unless noted)

```
npm run lint
npm run test
npm run test:rules
npm run test:functions
npx tsc --noEmit
```

```
cd functions
npm run typecheck
npm test
```

All of the above must be clean before deploying. `test:rules` and `test:functions` spin up the Firestore/Storage emulators automatically via `firebase emulators:exec` — no manual emulator step needed for these.

## Build

```
npm run build
```

```
cd functions
npm run build
```

## Deploy

Deploy is split by target so a partial deploy (e.g. rules-only) is possible without touching the others.

**Firestore rules and indexes:**
```
firebase deploy --only firestore:rules,firestore:indexes
```

**Storage rules:**
```
firebase deploy --only storage
```

**Cloud Functions:**
```
firebase deploy --only functions
```

**Everything configured in `firebase.json`:**
```
firebase deploy
```

Confirm the active project before any deploy:
```
firebase use
```
Switch project if needed with `firebase use <alias-or-project-id>` — never deploy to production without explicitly confirming the target project first.

## Post-deploy verification

- Confirm the deployed Functions list matches `functions/src/index.ts`'s exports (`firebase functions:list`).
- Smoke-test the document upload → dedupe-check → decrypt flow against the deployed environment (not just the emulator) at least once per release, since the `onCall` wrapper layer has no automated integration test yet (see `KNOWN_LIMITATIONS.md`).
- Spot-check one page per finance module (Dashboard, Accounts, Credit Cards, Transactions, Bills, Budget, EMI, Loans, People, Savings) against real data.
- Watch Cloud Functions logs for the first few minutes after deploy for cold-start errors or permission issues (`firebase functions:log`).

## Rollback

- **Functions:** redeploy the previous known-good commit's `functions/` build (`firebase deploy --only functions` after checking out that commit, or use the Firebase Console's function version history if available for the runtime).
- **Firestore/Storage rules:** rules deploys are versioned in the Firebase Console (Firestore/Storage → Rules → history) — roll back to a prior version there, or redeploy from a prior commit.
- There is no automated rollback tooling in this repo; rollback is manual and should be verified against the specific incident before acting.

## Notes specific to this codebase

- `firestore.indexes.json` is currently a minimal baseline plus the two `collectionGroup` indexes added for `statements` and `paymentBreakdowns` — confirm new composite-index requirements are added here before a page that needs them is deployed, or the query will fail in production with a missing-index error (with a console link to auto-create it, but that should not be relied on for production).
- No CI/CD pipeline is currently defined in this repository (no `.github/workflows` observed) — deploys are manual. If that changes, update this document accordingly.
