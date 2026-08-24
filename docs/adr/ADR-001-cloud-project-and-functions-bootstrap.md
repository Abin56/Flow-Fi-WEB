# ADR-001: Cloud Functions/Firebase project bootstrap location

**Status:** Accepted
**Date:** 2026-08-02
**Backlog task:** M1-T1 (Firestore schema + rules), anticipates M2-T1 (callable ingestion function)
**Architecture section(s) affected:** §5 (System Architecture — "all parsing/intelligence lives in Cloud Functions"), §24 (Security — Firestore/Storage rules)

## Context

Architecture v1.0 assumes a Firebase project with Firestore, Storage, and a Cloud Functions layer already exists and is shared between the Flutter app and FlowFi Web ("One brain, many surfaces," §1). In practice, this repository (`flowfi-web`) currently contains only a client-side Firebase SDK wire-up (`lib/firebase/client.ts`) reading `NEXT_PUBLIC_FIREBASE_*` env vars. There is no `firebase.json`, no `.firebaserc`, no `firestore.rules`/`storage.rules`, no `firestore.indexes.json`, and no `functions/` directory anywhere in this repo. The Flutter app (per the original project brief) is a separate codebase not visible here. It is therefore not yet decided, at the tooling level, *where* the Cloud Functions that the architecture requires actually get authored, tested, and deployed from.

This is not a gap in the architecture — §5's requirement ("parsing remains server-side only," validated in §29) is unambiguous about *what* must be true. It is a gap in project bootstrap that had to be resolved before Milestone 1's Firestore/Storage rules could be deployed or tested against anything real.

## Decision

1. Firebase project tooling (`firebase.json`, `.firebaserc`, `firestore.rules`, `firestore.indexes.json`, `storage.rules`) is bootstrapped at the **root of the `flowfi-web` repository**, targeting the existing Firebase project (`financeapp-585eb`, already referenced by this repo's client env vars).
2. A `functions/` directory will be added to this same repo (as a sibling to `app/`, `lib/`, etc.) starting at backlog task **M2-T1**, using Firebase Functions (2nd gen, TypeScript). It is not created in this ADR/task — only the decision that it lives here is recorded now, so M2-T1 doesn't have to re-litigate it.
3. This satisfies the "no duplicated business logic" / "one brain, many surfaces" principle (§1, §29) because the deployed Cloud Functions are callable by *any* client — including the separate Flutter repository — regardless of which repository authors them. The Flutter app does not need access to this repo; it only needs the deployed function endpoints and the shared Firestore/Storage project.
4. Local development/testing uses the Firebase Emulator Suite (Firestore + Storage emulators specifically for rules testing; Functions emulator added when `functions/` exists in M2). Java 21 and Node 24 are confirmed available in the current dev environment, so emulator-backed tests are used for rules validation rather than mocked/simulated rule checks.

## Consequences

- Rules and schema work (Firestore, Storage) can proceed and be genuinely tested now, without waiting on the Flutter team or a separate backend repo to exist.
- Deployment (`firebase deploy`) from this repo becomes the mechanism that makes Cloud Functions available to the Flutter client too — this is a deploy-pipeline detail, not an architecture change, and does not alter §5's diagram or §29's validation.
- If the team later decides Cloud Functions should live in a dedicated backend repo instead (e.g., for release-cycle independence from the web frontend), that is a **tooling relocation**, not an architecture change, and would be its own future ADR — nothing in §0–§27 needs to change either way, since the architecture never specified a repository layout.
- Nothing about the canonical schema, the registry model, or the pipeline stages changes. This ADR is purely "where does the code live and how is it tested locally," not "what does the code do."

## Alternatives considered

- **Wait for a dedicated backend repo before starting Milestone 1.** Rejected — would block all schema/rules work indefinitely with no such repo currently existing, and the architecture doesn't require one.
- **Mock Firestore/Storage rules checks instead of using real emulators.** Rejected — the backlog's explicit test requirements (Firestore Emulator Tests, per Architecture §33) call for real emulator validation, and both Java and Node are available in this environment, so there's no technical reason to settle for a weaker check.
