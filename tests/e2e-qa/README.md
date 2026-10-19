# Browser QA suite (local, emulator-only)

Real-browser tests of FlowFi's financial workflows — Loan/EMI payments, Transactions, People, Credit Cards,
Bills, Accounts, Dashboard, plus responsive/theme/keyboard checks. Every scenario drives the real UI in Chrome and
then **reads the persisted documents back from the Firestore emulator**, so it asserts on stored money, not only on
what the screen says.

## Run it

```
npm run test:e2e-qa                    # everything
npm run test:e2e-qa -- loan-           # only scenarios whose id starts with "loan-"
npm run test:e2e-qa -- --copy          # run the app from a temporary copy (use when you already have `next dev` running here)
npm run test:qa-bundle                 # prove the QA code/credentials don't ship in a production build
```

Requirements: Node, Java (for the Firestore emulator), `npm install` done, and Google Chrome (or set
`QA_BROWSER_CHANNEL=chromium` after `npx playwright install chromium`). A full run takes roughly 30–40 minutes
(each scenario starts a fresh browser and re-seeds the fixtures).

The command starts throw-away Auth + Firestore emulators and a dev server, runs the scenarios, and stops
everything it started. Results and screenshots land in `tests/e2e-qa/.results/` (git-ignored).

## It cannot touch live Firebase (fail closed)

| Layer | What it enforces |
|---|---|
| Launcher | Refuses to start unless the project id is `demo-*`, no `NODE_ENV=production`, no real credentials (`GOOGLE_APPLICATION_CREDENTIALS`, `FIREBASE_TOKEN`) and no non-local `*_EMULATOR_HOST`. Refuses if the repo's `.env*` define a `NEXT_PUBLIC_FIREBASE_*` key it doesn't override (`--copy` runs without any `.env*`). Refuses if a port it needs is already in use — it never shares an emulator with anything else. |
| App | `lib/firebase/qa-emulator.ts` connects to emulators only in a dev build with the explicit flag, a `demo-*` project and a localhost origin. The `/dev/qa` portal then re-verifies that Auth **and** Firestore are really connected to 127.0.0.1 and reachable; otherwise it shows only the failed checks. |
| Browser | Every request to a non-localhost host is aborted and recorded; any such attempt fails the run (`safety-egress-blocked` proves the block works). |
| Data | Only synthetic fixtures for `qa.tester@flowfi-qa.test`. "Reset" calls the emulator's own clear endpoint for the demo project. |

No secrets are stored: the QA user's password is generated randomly per run by the launcher and exists only in that
run's environment. No machine-specific paths: everything is derived from the repo location and `os.tmpdir()`.

Ports (override with env if needed): app `QA_APP_PORT=3210`, Firestore `QA_FIRESTORE_PORT=8380`, Auth
`QA_AUTH_PORT=9399`, hub `QA_HUB_PORT=4410`, logging `QA_LOGGING_PORT=4510`, Firestore websocket
`QA_FIRESTORE_WS_PORT=9350`. Don't use `npm run dev` alongside: its `predev` step kills whatever owns port 3000.

## Layout

```
run.mjs                  launcher (emulators → dev server → scenarios → teardown)
check-prod-bundle.mjs    production-bundle leak check
lib/env.mjs              ports + the fail-closed environment checks
lib/harness.mjs          Chrome launch (egress blocked), portal helpers, emulator REST reads, timing hooks
lib/core.mjs             scenario registry / runner / results.json
suites/*.mjs             the scenarios (one `scenario(id, name, body)` each)
```

Scenario ids: `loan-*`, `emi-*`, `txn-*`, `people-*`, `card-*`, `bill-*`, `acct-*`, `dash-*`, `resp-*`, `ux-d0*` (D-02…D-05),
`ux-b-*` (People split), `ux-c-*` (historical label), `rev-people-*`, `rev-emi-*`, `rev-acct-*` (reversal / editing / statement reconciliation), `act-*` (Activity & Undo), `safety-*`.

A check can be recorded as a documented **finding** (`check.finding(id, …)`): it never fails the run but prints a `FINDING` line, so known defects stay visible. Opt-in fixtures: `h.addFixture(page, "shared-emi" | "history")` (portal buttons).

## Fault injection (test-only)

Slow/failed *derived-data refresh* is injected from the portal (it wraps that tab's query client; the Firestore write
is untouched); slow *writes* are a Playwright route delay on the emulator's `:commit` call. Neither exists in
application code paths. Injected delays prove behaviour under delay — they are **not** production latency numbers.

## Writing a scenario

```js
import { scenario } from "../lib/core.mjs";
import * as h from "../lib/harness.mjs";

scenario("my-id", "What it checks", async ({ page }, check) => {
  await h.go(page, "/loans-installments");               // client-side navigation (keeps fault hooks)
  // …drive the UI…
  check("bank debited once", Math.abs(before - (await h.accountBalance("QA Bank")).currentBalance - 100) < 0.01);
  return await h.timeline(page);                          // optional event timings
});
```

Fixtures are created by `features/dev-qa/lib/seed.ts` through the app's own repositories (accounts, loans, EMI,
card, bill, people, shared expense, a historical payment). Dates are relative to "today".

## Known limits

Chrome only, mouse + keyboard (390×844 is viewport emulation, not a device); emulator latency, not production;
People edit/reverse, EMI mark-unpaid/edit and paginated account balances are not yet automated (see the QA report).
