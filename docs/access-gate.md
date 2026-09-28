# Private-access gate

FlowFi Web asks for an access password before Google Sign-In is offered. It is
**Layer 1** of four and is not what protects financial data:

1. Access gate (this doc) — keeps casual visitors and bots away from the sign-in flow
2. Google / Firebase Authentication
3. Firestore & Storage security rules (`firestore.rules`, `storage.rules`) — every
   user collection is `isOwner(uid)`; this is what actually protects the data
4. The user's data

## How it works

| Piece | Where |
| --- | --- |
| Password representation | Salted **scrypt** hash in Secret Manager, secret `FLOWFI_ACCESS_PASSWORD_HASH`. The plain password is stored nowhere, including Firestore. |
| Verification | `verifyAccessPasswordCallable` (Cloud Function): rate-limit check → constant-time scrypt compare → HMAC-signed token valid for 8 h |
| Token check | `checkAccessTokenCallable`, called on page reload to re-validate a stored token |
| Token signing key | Derived from the secret, so **changing the password invalidates every outstanding token** |
| Brute force | 5 attempts / 15 min per client IP (IP stored only as a SHA-256 hash in `rateLimits/accessGate/keys`, which clients can't read under the rules). Locked-out requests are refused before any comparison. `maxInstances: 5` limits cost. |
| Browser | Holds only the opaque token in `sessionStorage` (per tab; gone when the tab closes, and cleared on sign-out). `signInWithGoogle()` refuses to run unless the gate is `granted`, and `granted` is only ever set from a server response. |

Code: `functions/src/access/access-gate.ts`, `functions/src/index.ts`,
`services/access/access-gate.ts`, `app/login/page.tsx`.

## Set or change the production password

Run from the repo root. The first time, this also creates the secret.

```sh
# 1. Hash the password. Prompts twice, input hidden; only the hash is written.
node functions/scripts/hash-access-password.mjs > access-hash.tmp

# 2. Store the hash in Secret Manager as a new version
firebase use financeapp-585eb
firebase functions:secrets:set FLOWFI_ACCESS_PASSWORD_HASH --data-file access-hash.tmp

# 3. Delete the temp file
rm access-hash.tmp            # PowerShell: Remove-Item access-hash.tmp

# 4. Redeploy the two gate functions so they pick up the new version
firebase deploy --only functions:verifyAccessPasswordCallable,functions:checkAccessTokenCallable

# 5. (optional) remove old versions
firebase functions:secrets:prune
```

Use at least 12 characters (the script enforces this); a long random passphrase
is best. Never put the password on the command line, in `.env*`, or in Firestore.
Every existing gate session ends as soon as the new version is live; people who
are already signed in with Google stay signed in.

## Local development / emulator

The web app's `getFunctions()` is not connected to the emulator, so `next dev`
calls the deployed gate functions. To use the Functions emulator instead, put a
**dev-only** hash in `functions/.secret.local`, which is gitignored:

```
FLOWFI_ACCESS_PASSWORD_HASH=<output of the hash script for a throwaway dev password>
```

## Limits (by design)

- The browser downloads the Firebase web config, which is public by design, not
  a secret. Anyone who writes their own client can call Firebase Auth directly
  and skip this UI. They get only an empty account of their own, because the
  Firestore/Storage rules restrict every user path to its owner. To block
  unknown accounts at the Auth layer too, upgrade to Identity Platform and add a
  `beforeUserCreated` blocking function (or an email allowlist). That is
  project-wide and would also affect the Flutter app, so it is not enabled here.
- Signed-in Firebase sessions persist as before. The gate controls starting a
  sign-in, not an existing session. Sign-out clears the gate token.
