# Showing the original bank SMS in the Transaction Inbox — audit and proposal

Status: **PROPOSAL ONLY — nothing here is implemented.** It needs separate approval (Android upload, Firestore schema and
rules, privacy copy). The web UI currently shows an honest "Original message unavailable" state.

## 1. Audit: what exists today

| Hop | Finding |
|---|---|
| Android on-device DB (`sms_inbox` table, `sms_inbox_database.dart`) | Stores `sender`, `body`, `received_at` locally. The body exists **only on the phone**. |
| Android → Firestore (`SmsTransactionCandidateCloud`) | Uploads parsed fields only: amount, direction, eventType, transactionDate, merchant, bankName, rawLastFour, accountId/cardId, referenceNumber, confidence, needsReview(+reasons), createdAt. |
| Contract (`docs/sms-candidate-contract.md`, "PRIVACY") | Hard rule, enforced by `sms_transaction_candidate_cloud_test.dart`: the document must never contain `body`, `rawBody`, `sender`, `smsBody`, `message`, `userId`, or OTP-adjacent content. |
| Web model (`lib/models/sms-transaction-candidate.ts`) | Has no body, sender, or SMS-received timestamp (`createdAt` is the *sync* time). |
| Firestore rules | The collection is owner-scoped; no field-level restrictions exist for a body. |

**Conclusion:** the web app cannot show the original SMS today, and any reconstruction would be fabricated. The UI therefore
shows "Original message unavailable" and, separately, the parsed evidence. Showing the real text requires a deliberate
Android + schema change.

## 2. Options

| | Option | Privacy | Effort | Verdict |
|---|---|---|---|---|
| A | Keep as is (parsed evidence only) | Best | none | Current state |
| B | **Opt-in, per-candidate, redacted snippet** stored in a separate subcollection | Good, if redacted + consent | Medium | **Recommended** |
| C | Upload every body in the candidate doc | Poor — breaks the contract and widens the blast radius | Low | Reject |
| D | Fetch on demand from the phone (device-to-device) | Best | High (needs a live channel) | Possible later |

## 3. Recommended design (Option B)

1. **Explicit opt-in.** A Settings toggle "Include the original bank message with candidates", default **off**, with plain
   copy: what is sent, who can read it, how long it is kept, how to delete it. Stored as a user-doc preference; consent
   timestamp + copy version recorded. Turning it off stops uploads and deletes existing snippets.
2. **What is eligible.** Only messages that already became a *candidate* via a bank-specific parser (confidence high/medium)
   from a recognised bank sender. Never uploaded: OTP/verification messages, anything the OTP detector flags, personal
   conversations, promotional or unrelated notifications, messages with no financial parse.
3. **Redaction on the phone, before upload.** Mask every digit run ≥ 5 except the last four of an account/card, remove
   OTP/CVV/PIN/URL-token patterns, trim to 480 characters. If redaction is uncertain the snippet is **not** uploaded.
4. **Where it lives.** `users/{uid}/smsTransactionCandidates/{id}/source/original` (one doc, fields: `text`, `receivedAt`,
   `redactionVersion`, `consentVersion`). The candidate document itself stays unchanged and keeps passing its privacy test.
5. **Access control (rules).** Owner-only read; create/update only by the owner with a valid shape (`text` ≤ 480 chars, no
   unexpected keys); `delete` allowed. Deleted together with the candidate (the existing hard-delete path must also delete
   the subdoc) and by a TTL of 30 days.
6. **Web UI.** The drawer's "Original message" block shows the snippet read-only, with "Redacted copy — digits masked"; if
   the doc is absent: "Original message unavailable" (today's state). Parsed evidence stays separate, always.
7. **Safety invariants.** The web never parses the snippet to change amount/merchant/direction/account; it is display-only.
   Idempotency, duplicate detection and import are untouched.

## 4. Needs approval before any work

- Android: new upload path + redaction + consent gate (no background upload is enabled by this proposal).
- Firestore: new subcollection, rules, TTL policy, delete-with-candidate.
- Product/legal: consent copy, retention period, user-visible deletion.
- Test plan: redaction unit tests on real-world bank SMS fixtures (including OTP-in-body cases), rules tests for owner/non-owner,
  privacy test extended so the candidate doc still never contains a body.

## 5. Not doing

No body upload, no schema change, no background sync, no reconstructed/"approximate" message text in the UI.
