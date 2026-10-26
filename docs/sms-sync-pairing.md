# SMS Sync — QR pairing and live setup

Status (2026-10-25): implemented and tested locally (unit, Firestore-emulator, rules, Flutter, browser QA). **Nothing is
deployed.** Production deployment needs explicit approval — see [Deployment](#deployment).

## The customer flow

1. FlowFi Web → Transaction Inbox (empty) shows a single-use pairing QR inside the SMS Sync hero.
2. The phone's camera opens `https://<web host>/pair/?t=<token>`. That page only hands the token to the app
   (`intent://app/pair?t=…` on Android Chrome, falling back to the same page with `missing=1` and the APK link when
   FlowFi isn't installed). It reads and writes nothing, and opening it counts for nothing.
3. FlowFi for Android opens `/pair`. The router keeps the token in memory through onboarding, sign-in, lock and the
   setup wizard, then shows the pairing screen.
4. The app calls `previewSmsPairingCallable`: the token must be valid, unexpired and unused, and created by **the same
   signed-in account**. The session becomes `opened`, which is the web's first real evidence.
5. The user taps **Approve pairing** → `approveSmsPairingCallable` registers the device and writes the F3
   `backgroundUpload` switch for that install, in one transaction.
6. On the phone: **Allow SMS access** → **Turn on Auto Sync** (which starts the first scan). Each outcome is reported to
   `smsDeviceStatus`, and the web journey follows along live.
7. The background worker scans and uploads (through the unchanged F3 gate and tombstone-aware upload). Candidates
   replace the setup view in the Transaction Inbox automatically. Import/Dismiss stay manual.

Earlier SMS (received before sign-in) stay unlinked. Both the phone and the web point to the existing explicit
**Link earlier messages** confirmation; nothing claims them silently.

## Components

| Area | Files |
| --- | --- |
| Pairing backend (Admin SDK) | `functions/src/sms-pairing/sms-pairing.ts`, callables at the end of `functions/src/index.ts` |
| Rules / indexes (both repos, byte-identical) | `firestore.rules`, `firestore.indexes.json` |
| Web live journey | `lib/sms-pairing/setup-progress.ts` (pure evidence → steps), `hooks/use-sms-sync-setup.ts`, `features/transaction-candidates/components/sms-setup-journey.tsx`, `sms-inbox-empty-state.tsx`, `sms-sync-onboarding.tsx` (`setupPanel` slot) |
| Web landing page | `app/pair/page.tsx`, `app/pair/pair-landing.tsx`, `lib/sms-pairing/pairing-links.ts` |
| Web service | `services/sms-pairing/sms-pairing-service.ts` |
| Android pairing | `Finance_App/lib/features/sms_inbox/pairing/*` (link parsing, service, controller, screen, status reporter, card row) |
| Android wiring | router `/pair` + pending-token capture (`core/router/app_router.dart`), manifest `flowfi://app/pair` filter, `getDeviceLabel` on the auto-sync channel, background report in `sms_background_entry.dart`, kill switches in `sms_background_upload_switch.dart` |
| Operator tool | `functions/scripts/sms-sync-kill-switch.mjs` |

## Data

| Document | Written by | Clients |
| --- | --- | --- |
| `smsPairingSessions/{sha256(token)}` — `uid, status (pending/opened/approved/canceled/superseded), createdAt, expiresAt (+10 min), openedAt, approvedAt, deviceId, rejectedAttempts, lastRejection, purgeAt` | pairing functions | owner reads own; no writes |
| `users/{uid}/smsDevices/{deviceId}` — `label, platform, appVersion, status (active/replaced/revoked), pairedAt, pairedSessionId` | pairing functions | owner reads; no writes |
| `users/{uid}/smsSyncConfig/backgroundUpload` — `enabled, deviceId, source: "pairing"` | pairing functions, operator | owner reads; no writes |
| `users/{uid}/smsSyncConfig/operatorHold` — `disabled` | operator only | owner reads; no writes |
| `smsSyncControl/global` — `uploadsDisabled` | operator only | signed-in reads; no writes |
| `users/{uid}/smsDeviceStatus/{deviceId}` — permission, Auto Sync, cloud gate, last scan/upload + outcomes, counts, `reportedAt` | the paired phone | owner writes only for an **active** device, exact schema, `reportedAt == request.time` |

`deviceId` is the existing per-install random UUID (never a hardware id). The plaintext token is never stored. It is
returned once to the creating browser and lives only in memory, the QR, and the phone's memory.

## Security and consent controls

- **Token**: 32 random bytes. The session id is its SHA-256. It is single use (approval flips the status inside a
  transaction; a concurrent second approval loses), expires after 10 minutes, and creating a new code supersedes the
  account's previous open one. Leaving the web page cancels an open code.
- **Account binding**: only the uid that created the session can preview or approve it. A different account gets
  `wrong_account`; the attempt is counted on the session (nothing about the other account is stored) and the web says
  so. The phone offers *Switch account*, which keeps the scanned code through sign-out and sign-in.
- **Explicit approval**: preview and approve are separate calls. Approval states what will happen, who it applies to,
  and which phone it replaces.
- **One uploading phone per account** (unchanged F3 semantics): pairing another phone repoints `backgroundUpload` and
  marks the old device `replaced`. Its gate fails closed on the next scan and its status writes are refused.
- **Revocation**: *Disconnect* on the web or the phone → `revokeSmsDeviceCallable` → device `revoked`,
  `backgroundUpload.enabled=false`. Uploaded candidates are untouched.
- **Fail closed**: Android uploads only when `backgroundUpload` names this install, is enabled, and neither operator
  switch is set — all read from the server. Any read failure means no upload.
- **Kill switches**: enforced in three places — Android's gate, the pairing functions (no create/preview/approve
  while stopped), and firestore.rules on candidate create/update (the backstop against a modified client). Pairing
  can't write either switch. Web import/dismiss keep working during an incident.
- **Rate limits**: 20 code creations per hour and 30 preview/approve calls per 15 minutes, per account (existing
  `rateLimits` helper).
- **Never automatic**: no financial transaction is created by any of this; tombstones still block resurrection.
- **Honest wording**: the web never says the phone is connected, online, installed or syncing. Steps 4–6 are labelled
  as the phone's own reports with times; a report older than 30 minutes is flagged.

## Live web states

| Step | Done when | Failure / waiting states |
| --- | --- | --- |
| 1 QR code ready | session created and unexpired | creating; failed (paused, rate limited, offline, other) → *New code*; expired; superseded; canceled on the phone |
| 2 FlowFi opened on your phone | session `openedAt` (set by the function) | waiting; wrong-account attempt |
| 3 Account verified and paired | session approved **and** device `active` **and** `backgroundUpload` names it | approved, finishing |
| 4 SMS permission granted | phone report after pairing: `granted` | denied / permanently denied (with fix) / unsupported build |
| 5 SMS Auto Sync on | phone reports Auto Sync on **and** its gate saw Cloud Sync `enabled` | waiting; `unverified` (phone offline) |
| 6 First scan completed | successful scan reported after pairing | permission lost; scan failed |
| 7 Candidates ready | candidate documents exist (the inbox replaces the journey) | no eligible alerts yet; upload failed (retries on next scan) |

Also shown: an offline banner, a cached-data banner, a stale-report warning, the operator pause, and the
earlier-messages notice.

## Operator controls

```sh
# read-only
node functions/scripts/sms-sync-kill-switch.mjs --project financeapp-585eb status --uid <uid>
# stop everyone (dry run unless --confirm)
node functions/scripts/sms-sync-kill-switch.mjs --project financeapp-585eb global on --reason "<why>" --confirm
# stop one account / release
node functions/scripts/sms-sync-kill-switch.mjs --project financeapp-585eb hold <uid> on --confirm
node functions/scripts/sms-sync-kill-switch.mjs --project financeapp-585eb hold <uid> off --confirm
```

Credentials come from Application Default Credentials. The same documents can be edited in the Firebase console.

## Deployment

Everything below writes to production and needs explicit approval. Project `financeapp-585eb`, **(default)**
database only (not `portfolio`).

1. **Rules + index** (from this repo; the Finance_App copy is byte-identical):
   `npx firebase deploy --only firestore:rules,firestore:indexes --project financeapp-585eb`
   The new rules are additive, except that candidate create/update now also checks the two switch documents (absent
   = allowed).
2. **Pairing functions — deploy by name.** Both repos declare a functions codebase called `default` for the same
   project. A plain `--only functions` from either repo would offer to **delete the other repo's functions**
   (`classifyFinancialSms` here, or the PDF/access-gate functions from Finance_App). Use:
   ```sh
   npm --prefix functions run build
   npx firebase deploy --project financeapp-585eb --only "functions:createSmsPairingSessionCallable,functions:previewSmsPairingCallable,functions:approveSmsPairingCallable,functions:cancelSmsPairingCallable,functions:revokeSmsDeviceCallable"
   ```
   Long-term fix: give the Finance_App codebase its own name (e.g. `"codebase": "mobile"`), with a coordinated
   redeploy.
3. **Web**: build and deploy hosting (`npm run build`, then `npx firebase deploy --only hosting --project
   financeapp-585eb`). Set `NEXT_PUBLIC_ANDROID_APK_URL` once a real download exists. Until then the web says the
   download isn't published and never invents a link.
4. **Android**: build the sideload release APK containing the deep-link filter and pairing screen, then publish it at
   the URL from step 3. **No distribution URL exists yet — this is the one external input still needed.**
5. Optional:
   - A Firestore TTL policy on `smsPairingSessions.purgeAt` (session bookkeeping, 7 days).
   - Android App Links (`/.well-known/assetlinks.json` with the release signing SHA-256, plus an `autoVerify` https
     filter) so the QR opens the app without the landing page. This needs the final domain and the release
     certificate.
   - App Check on the callables.

## End-to-end test plan (real phone, after deployment)

1. Fresh account on web → Transaction Inbox: the hero shows a QR with a countdown; step 1 done, step 2 waiting.
2. Wait 10 minutes → *Code expired*; *New code* works. Reload → a new code; the old one now says *superseded* if
   scanned.
3. Phone signed in to a **different** account scans → phone: *Different account* + *Switch account*; web step 2:
   wrong-account warning. Switch to the right account → the pairing screen returns with the same code.
4. Right account scans → web step 2 done within seconds. Tap *Not now* → web: canceled on the phone. New code →
   scan → *Approve* → web step 3 done, device card named.
5. Scan the same (approved) code again → *already used*.
6. *Allow SMS access* → deny → web step 4: declined. Allow → step 4 done.
7. *Turn on Auto Sync* → web step 5 done after the first scan report; step 6 done. If earlier messages exist, both
   sides show the *Link earlier messages* notice; linking needs the phone's own confirmation.
8. Receive a real bank SMS → the candidate appears in the inbox (the journey disappears). Import one, dismiss one;
   rescan on the phone → neither comes back (tombstones).
9. Turn airplane mode on for the browser → offline banner; *New code* disabled. Back online → it resumes.
10. Second phone: pair it → it replaces the first; the first phone's card says *Not paired* after its next report
    attempt, and it uploads nothing.
11. *Disconnect* on web → the inbox returns to first-time pairing; the phone stops uploading on its next scan.
12. Operator: `global on` → web shows *paused*; the phone uploads nothing; a direct candidate write is denied by
    rules. `global off` → normal.

## Tests

- `functions/tests/sms-pairing.test.ts` — 26 emulator tests (token secrecy, expiry, single use and concurrent
  approve, wrong account, supersede, rate limit, kill switch and hold, multi-device replace, revoke, cancel).
- `tests/rules/sms-pairing.rules.test.ts` — 14 rules tests (sessions, devices, status schema/forgery, switches,
  candidate backstop with tombstones).
- Web unit: `lib/sms-pairing/*.test.ts`, `hooks/use-sms-sync-setup.test.tsx`, `sms-setup-journey.test.tsx`,
  `sms-inbox-empty-state.test.tsx`.
- Browser QA: `npm run test:e2e-qa -- --copy smsp-` (390/1366, light/dark: layout, honesty, live transitions,
  revoke).
- Flutter: `test/features/sms_inbox/pairing/*` and the kill-switch group in `sms_background_upload_switch_test.dart`.

## Known limitations

- **No App Check.** Step 2's evidence is "an authenticated client presented the token", not cryptographic proof it was
  the FlowFi APK. It still can't cross accounts.
- Steps 4–6 are self-reported by the phone (the server stamps the time); the web words them that way.
- One uploading phone per account, by design (F3).
- The pending token lives in memory only: if Android kills the app during sign-in, rescan.
- Headless Firebase Auth rehydration in the background worker is still unverified on real hardware (see
  Finance_App `docs/sms-background-cloud-sync-architecture.md`). Pairing doesn't change that, and the phone's
  report would show the resulting `unverified` gate.

## Android APK distribution (first-time install from the QR)

The QR opens `/pair`. For a phone without FlowFi, that page offers **Download FlowFi for Android** next to **Open
FlowFi**, explains Android's own install confirmation, and tells the user to come back to the same page and tap Open
FlowFi — the one-time code is still in the page's address, so the same pairing continues after sign-in. It never claims
FlowFi is installed (or missing) from a timeout or a download tap; after 10 minutes it says the code has *probably*
expired and points to **New code** on the Web.

**Where the APK lives:** Firebase Hosting site `flowfi`, under `/downloads/` — `flowfi-android.json` (version,
versionCode, SHA-256, size, file), `flowfi-android-<version>.apk` and the stable alias `flowfi-android.apk`. The page
reads the JSON at run time, so publishing a new APK needs no code change; no Firestore/Storage rules are involved.

**Hosting deploys replace the whole site.** `npm run build` therefore runs `scripts/android-release.mjs stage`
(`postbuild`), copying `release/android/*` (gitignored) into `out/downloads/`. Never deploy hosting from a checkout
that lacks `release/android/` unless you intend to unpublish the APK.

### Publishing a release (needs the release keystore — see below)

```sh
# in Finance_App (needs android/key.properties; bump version: in pubspec.yaml first)
flutter build apk --release --flavor sideload
# in Flow-Fi-WEB
npm run android:release:prepare -- "C:UsersanjelFinance_Appuildappoutputslutter-apkapp-sideload-release.apk"
npm run build
npx firebase deploy --project financeapp-585eb --only hosting
npm run android:release:verify -- https://flowfi.web.app
```

`prepare` refuses: unsigned/v1-only APKs, the Android debug certificate, any package other than
`com.flowfi.app`, a build without `READ_SMS` (play flavor), a signing certificate different from earlier
releases, and a versionCode that is not higher than the published one. `verify-remote` downloads the live files and
compares their SHA-256 and size with the manifest.

### Release keystore (one-time, by you)

Create it where only you can read it, never inside a repo:

```sh
keytool -genkeypair -v -keystore "%USERPROFILE%lowfi-keyslowfi-release.jks" -alias flowfi -keyalg RSA -keysize 2048 -validity 10000
```

`keytool` prompts for the passwords — type them there; do not put them on a command line, in chat or in a commit. Then
create `Finance_App/android/key.properties` (already gitignored) with `storeFile`, `storePassword`, `keyAlias=flowfi`,
`keyPassword`. **Back up the .jks and both passwords in at least two separate places** (a password manager plus an
encrypted offline copy). Losing the key means every installed phone must uninstall FlowFi before it can take an
update; a leaked key lets someone ship a "FlowFi update". Phones that have the debug build installed must also
uninstall it once before the first release install (different signing key).
