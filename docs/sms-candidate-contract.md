# Web ↔ Android SMS Transaction Candidate Contract

**This document was corrected on 2026-08-11 after auditing the actual
Android source** (`Finance_App/lib/features/sms_inbox/`, specifically
`domain/sms_transaction_candidate_cloud.dart`,
`presentation/sms_candidate_cloud_sync.dart`, and
`data/sms_transaction_candidate_repository.dart`). An earlier version of
this document and the web-side model it described (`transactionCandidates`,
`bankHint`/`accountLast4`/`matchedAccountId`/a `status` state machine) was
**never real** — it was written before the Android side existed and was
never reconciled against it once Android's Phase 3 implementation landed.
Everything below reflects what is actually deployed and tested on the
Android side today. See ADR-010 for the full account of the correction.

## Firestore location

```
users/{userId}/smsTransactionCandidates/{smsItemId}
```

Flat, per-user collection — no parent "document." Doc id is the stable
local `SmsInboxItem.id` (`TransactionCandidate.smsItemId` on the Android
side), so re-syncing the same SMS is always an idempotent overwrite, never a
duplicate.

## Who writes what

This collection is **entirely Android-owned**. The web app never writes a
partial update to a candidate document — see "Lifecycle" below for why.

| Field | Written by |
|---|---|
| `amount`, `direction`, `eventType`, `transactionDate`, `merchant`, `bankName`, `referenceNumber` | Android (parsed from the SMS) |
| `rawLastFour` | Android — the last-4 digits the SMS itself exposed, independent of whether `accountId`/`cardId` resolved |
| `accountId`, `cardId` | Android — resolved on-device by `AccountCardMatcher` against the same `accounts`/`creditCards` Firestore collections the web app reads. **Already resolved by the time the web app sees it** — the web app only looks these ids up for display, it does not run its own matching. |
| `confidenceLevel`, `confidenceScore` | Android (`SmsConfidenceScorer`) — consumed as-given, never recomputed |
| `needsReview`, `needsReviewReasons` | Android — human-readable reasons, shown verbatim |
| `source` | Android — always the literal `"sms"` |
| `createdAt` | Android |
| `deletedAt` | Android — always `null` in practice (this collection is hard-deleted, never soft-deleted), but always present because `toFirestore()` always writes it |

The web app's only write to this collection is a **full document delete**
(`SmsTransactionCandidateRepository.deleteById`), performed only after
`TransactionRepository.createTransaction` has succeeded for that candidate.
It never calls `updateDoc`/partial-`set` on a candidate.

## Field contract (TypeScript)

See `lib/models/sms-transaction-candidate.ts` for the authoritative,
always-up-to-date interface — a direct, field-for-field port of the Dart
`SmsTransactionCandidateCloud` class. Reproduced here for reference:

```ts
export type SmsCandidateDirection = "debit" | "credit";
export type SmsCandidateConfidenceLevel = "high" | "medium" | "low";
export type SmsCandidateEventType =
  | "upiPayment" | "upiReceive" | "bankDebit" | "bankCredit" | "atmWithdrawal"
  | "cardPurchase" | "creditCardPurchase" | "impsNeftRtgs" | "walletPayment"
  | "salaryCredit" | "refund" | "cashDeposit" | "loanEmiDebit" | "billPayment"
  | "autoDebit" | "unknown";

export interface SmsTransactionCandidate {
  id: string; // == the Firestore document id == smsItemId, not a written field
  amount: number;
  direction: SmsCandidateDirection;
  eventType: SmsCandidateEventType;
  transactionDate: Date;
  merchant: string | null;
  bankName: string | null;
  rawLastFour: string | null;
  accountId: string | null;
  cardId: string | null;
  referenceNumber: string | null;
  confidenceLevel: SmsCandidateConfidenceLevel;
  confidenceScore: number;
  needsReview: boolean;
  needsReviewReasons: string[];
  source: "sms";
  createdAt: Date;
  deletedAt: Date | null;
}
```

`Date` fields are Firestore `Timestamp`s on the wire.

**There is no `status` field.** Existence of a document means "still
pending" — see "Lifecycle" below. There is no `matchedAccountId`/
`matchedCardId` distinct from `accountId`/`cardId` (those *are* the resolved
ids, already computed by Android), no `smsDuplicateOfCandidateId` synced to
the cloud (it's on-device-only on `SmsInboxItem`), and no
`suggestedCategoryId` (Android's Phase 1 deliberately never resolves a
FlowFi category at candidate-build time — see the Dart model's module doc).

## PRIVACY — hard requirement, not a suggestion

Verified directly against `sms_transaction_candidate_cloud_test.dart`'s own
privacy test, which asserts the stored document never contains `body`,
`rawBody`, `sender`, `smsBody`, `message`, or `userId`, and that
`rawLastFour` is never longer than 4 characters. This collection must
**never** contain:

- The full SMS body / raw text
- OTP codes or any OTP-adjacent content
- A full phone number
- Any sender information at all (there is no `senderHint` field, unlike the
  earlier incorrect version of this contract — Android does not sync a
  sender identifier of any kind, masked or otherwise)

## Lifecycle — and the cross-platform gap this creates

There is no persisted status field. `SmsCandidateCloudSync.sync()`
(Android) keeps this collection mirroring exactly the local SMS items that
are still `pending` and not a flagged duplicate **on-device**:

1. Every time the user opens the Android app's SMS Inbox screen, `sync()`
   runs.
2. It deletes any cloud document whose corresponding local SMS is no longer
   pending (converted, ignored, or flagged as a duplicate locally).
3. It re-uploads (full-document `.set()` overwrite, not a merge) every
   local candidate that's still pending.

**This is idempotent from Android's perspective, but it creates a real gap
with the web app's own import flow.** When the web app imports a candidate,
it creates a real `Transaction` and then deletes the cloud document. That
delete has no way to inform Android's on-device `SmsInboxItem.status` —
there is no reverse sync. If the user later opens the Android SMS Inbox
screen before separately resolving that same SMS there too, Android's
`sync()` will re-upload the *same* document (same id), because its local
record still reads `pending`.

**Mitigation (web-side only, since Android cannot be changed to close this
gap without a deliberate, separate decision):**
`evaluateCandidateDuplicate` (`features/transaction-candidates/lib/candidate-duplicate.ts`)
checks every visible candidate against the user's already-committed
Transactions (`source: "sms"` and matching merchant/amount/date/reference).
A resurrected candidate is flagged "Possible Duplicate" and blocked from
one-click import — the user must explicitly re-confirm past the warning.
This turns a silent double-import into a visible, deliberate decision. It
does not, and cannot, prevent the candidate from reappearing in the list —
only from silently becoming a second Transaction.

The same gap applies, harmlessly, to the web app's own "Dismiss" action
(deletes the cloud doc without creating a Transaction): the SMS can
reappear for review after Android's next sync, but no duplicate Transaction
risk exists there since dismissal never creates one.

## Event types / confidence vocabulary

- `confidenceLevel`: exactly `"high" | "medium" | "low"` — `ConfidenceLevel`
  in `sms_confidence_scorer.dart`.
- `eventType`: Android's own `SmsTransactionCategory` taxonomy (see the enum
  list above) — the web app must not invent a second one.
- `direction`: `"debit" | "credit"`.
- Presentation status (what the user actually sees — "Ready to Import,"
  "Needs Review," "Possible Duplicate," "Unmatched Account/Card") is
  **derived**, never stored — see `deriveCandidateStatus` in
  `features/transaction-candidates/lib/candidate-status.ts`.

## Status as of this writing

The Android Phase 3 implementation is real, merged, and tested
(`Finance_App/test/features/sms_inbox/sms_transaction_candidate_cloud_test.dart`,
`sms_candidate_cloud_sync_test.dart`,
`sms_transaction_candidate_repository_test.dart`). The web side now consumes
this exact contract. A development-only fixture generator
(`features/transaction-candidates/dev/generate-mock-sms-candidates.ts`)
remains available for local development without a signed-in Android device
producing real data, gated behind `NODE_ENV === "development"` and never
used as a production data source.

**Not yet independently verified in this session:** an actual live
Android → Firestore → web read, since doing so requires a signed-in mobile
device with SMS permission granted and a real bank SMS to parse, which is
outside what this session's tooling can drive. The model/contract
reconciliation above is verified against Android's committed source and its
own test suite, not against a live end-to-end run. See the implementation
report for the precise verification boundary.
