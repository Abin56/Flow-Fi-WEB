/**
 * Direct port of `lib/core/constants/firestore_constants.dart`
 * (`FirestoreCollections`). Collection names under `users/{userId}/...` in
 * Firestore — must stay byte-identical to the Flutter app's constants,
 * since both apps read/write the same database.
 */
export const FirestoreCollections = {
  users: "users",
  accounts: "accounts",
  transactions: "transactions",
  categories: "categories",
  budgets: "budgets",
  savingsGoals: "savingsGoals",
  people: "people", // creditors & debtors
  ledger: "ledger", // subcollection under people/{personId}
  advanceApplications: "advanceApplications", // subcollection under people/{personId}
  purposeFunds: "purposeFunds", // subcollection under people/{personId} — web-only, see lib/models/purpose-fund.ts
  followUps: "followUps", // subcollection under people/{personId} — web-only reminder metadata, see lib/models/person-follow-up.ts
  paymentDeferrals: "paymentDeferrals", // subcollection under people/{personId} — web-only expected-collection timing, see lib/models/person-payment-deferral.ts
  bills: "bills",
  billOccurrences: "occurrences", // subcollection under bills/{billId}
  payments: "payments", // subcollection under bills/{billId} and installments/{installmentId}
  loans: "loans",
  emis: "emis",
  reamortizationEvents: "reamortizationEvents", // subcollection under loans/{loanId} and emis/{emiId}
  additionalDisbursements: "additionalDisbursements", // subcollection under loans/{loanId}
  expenses: "expenses",
  paymentSchedules: "paymentSchedules",
  installments: "installments", // subcollection under paymentSchedules/{scheduleId}
  creditCards: "creditCards",
  sharedCreditLimits: "sharedCreditLimits", // bank-issued facility shared by multiple creditCards
  statements: "statements", // subcollection under creditCards/{cardId}
  statementPayments: "statementPayments", // subcollection under statements/{statementId}
  limitCorrections: "limitCorrections", // subcollection under creditCards/{cardId} or sharedCreditLimits/{sharedLimitId} — web-only, see lib/models/credit-limit-correction.ts
  paymentBreakdowns: "paymentBreakdowns", // subcollection under emis/{emiId}, doc id == paymentId

  // --- Financial Document Intelligence Engine (Architecture v1.0) ---
  // New for both apps — no Dart source exists yet to port these names from.
  // Chosen to fit this file's users/{uid}/... convention per docs/adr/ADR-002.
  // Flutter-side naming has NOT been confirmed; treat as provisional until
  // cross-checked with whoever owns the Flutter codebase (ADR-002's open
  // Flutter-compatibility caveat).
  financialDocuments: "financialDocuments",
  importHistory: "importHistory", // subcollection under financialDocuments/{documentId}
  versionHistory: "versionHistory", // subcollection under financialDocuments/{documentId}
  changeLog: "changeLog", // subcollection under financialDocuments/{documentId}
  documentImports: "documentImports",
  documentImportRecords: "records", // subcollection under documentImports/{importId}
  merchantMappings: "merchantMappings", // top-level (global) AND users/{uid}/merchantMappings (personal)
  parserHistory: "parserHistory",
  aiInsights: "aiInsights",

  // --- PDF Analyzer (statement password rules) — new, web-only for now ---
  // One doc per card, keyed by cardId. No Dart source to port from yet.
  pdfAnalyzerConfig: "pdfAnalyzerConfig",

  // --- SMS Transaction Intelligence (Phase 3) ---
  // Direct port of `Finance_App/lib/core/constants/firestore_constants.dart`'s
  // `smsTransactionCandidates` — flat per-user collection, no parent
  // "document." Written entirely by Android (`SmsCandidateCloudSync`) as the
  // authenticated owner; the web app only reads and deletes (see
  // docs/sms-candidate-contract.md and lib/models/sms-transaction-candidate.ts).
  smsTransactionCandidates: "smsTransactionCandidates",

  // Durable "handled" marker for an imported/dismissed SMS candidate — see
  // lib/models/sms-candidate-tombstone.ts and
  // Finance_App/docs/sms-background-cloud-sync-architecture.md (§1). Same
  // document id as the candidate it replaces. Web-written only; immutable
  // once created (firestore.rules denies update outright).
  smsCandidateTombstones: "smsCandidateTombstones",

  // Operator-written runtime switch for Android background SMS upload (the
  // `backgroundUpload` document). Clients may only READ it (firestore.rules);
  // the web uses it solely to word the empty Transaction Inbox.
  smsSyncConfig: "smsSyncConfig",

  // SMS Sync pairing (functions/src/sms-pairing): phones paired to this
  // account (Cloud Functions-written only) and each phone's own reported
  // health (permission/Auto Sync/last scan), keyed by the install's device id.
  smsDevices: "smsDevices",
  smsDeviceStatus: "smsDeviceStatus",
  // Each signed-in install's live heartbeat (online, permission, Auto Sync, sync progress) — owner-written by the phone,
  // before or after pairing. Grants nothing; pairing authority stays in smsDevices/backgroundUpload.
  smsDevicePresence: "smsDevicePresence",
} as const;

/** Top-level (not user-scoped) collections — config/global data only. */
export const GlobalFirestoreCollections = {
  documentTypeRegistry: "documentTypeRegistry",
  merchantMappings: "merchantMappings",
  // QR pairing sessions (doc id = SHA-256 of the one-time token) and the
  // operator's SMS Sync emergency switch — both Cloud Functions/operator-written.
  smsPairingSessions: "smsPairingSessions",
  smsSyncControl: "smsSyncControl",
} as const;
