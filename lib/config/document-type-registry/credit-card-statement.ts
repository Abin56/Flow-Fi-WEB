/**
 * documentTypeRegistry/{"credit_card_statement"} seed entry — Architecture
 * v1.0 §3, §9. Version-controlled and deployed via CI (docs/adr/ADR-001),
 * never edited ad-hoc in the Firestore console (RFC §28.13's registry-
 * sprawl finding). Backlog task M1-T2.
 *
 * `sourceTemplates` starts with the four Phase-1 issuers (backlog
 * Milestone 3 exit criteria: HDFC, ICICI, Axis, SBI). The remaining nine
 * issuers from Architecture §9's layout table are added in backlog
 * Milestone 4 — do not backfill them here ahead of that milestone's
 * fixture-driven validation (Architecture §33's Bank Template Tests).
 */

import type { DocumentTypeRegistryEntry } from "@/lib/models/document-type-registry";

export const creditCardStatementRegistryEntry: DocumentTypeRegistryEntry = {
  documentType: "credit_card_statement",
  displayName: "Credit Card Statement",
  icon: "credit-card",
  ingestionMethods: ["upload"],
  canonicalSchema: {
    metadataFields: [
      { field: "statementPeriodStart", label: "Statement Period Start", type: "date", required: true },
      { field: "statementPeriodEnd", label: "Statement Period End", type: "date", required: true },
      { field: "statementDate", label: "Statement Date", type: "date", required: true },
      { field: "paymentDueDate", label: "Payment Due Date", type: "date", required: true },
      { field: "openingBalance", label: "Opening Balance", type: "currency", required: false },
      { field: "closingBalance", label: "Closing Balance", type: "currency", required: false },
      { field: "minimumDue", label: "Minimum Amount Due", type: "currency", required: true },
      { field: "totalDue", label: "Total Amount Due", type: "currency", required: true },
      { field: "creditLimit", label: "Credit Limit", type: "currency", required: false },
      { field: "availableLimit", label: "Available Limit", type: "currency", required: false },
      { field: "rewardPointsEarned", label: "Reward Points Earned", type: "number", required: false },
      { field: "cashback", label: "Cashback", type: "currency", required: false },
      { field: "interestCharged", label: "Interest Charged", type: "currency", required: false },
      { field: "gst", label: "GST", type: "currency", required: false },
      { field: "lateFee", label: "Late Fee", type: "currency", required: false },
    ],
    recordSchema: [
      { field: "date", label: "Date", type: "date", required: true },
      { field: "counterpartyRaw", label: "Merchant (raw)", type: "string", required: true },
      { field: "amount", label: "Amount", type: "currency", required: true },
      { field: "direction", label: "Debit/Credit", type: "string", required: true },
      { field: "referenceNumber", label: "Reference Number", type: "string", required: false },
      { field: "category", label: "Category", type: "string", required: false },
    ],
  },
  sectionKeywordDictionary: {
    summary: ["statement summary", "account summary", "card summary", "summary of charges", "bill summary"],
    totalDue: ["total dues", "total amount due", "total payment due", "new balance", "total due amount"],
    minimumDue: ["minimum amount due", "min amount due", "minimum payment due", "min due", "minimum payment"],
    transactionTable: [
      "domestic/international transactions",
      "transaction details",
      "transaction summary",
      "purchase/cash details",
      "transactions",
      "activity",
    ],
    emi: ["easy emi details", "flexipay", "emi details", "emi"],
    rewards: [
      "reward points",
      "payback points",
      "edge rewards",
      "rewardz",
      "membership rewards",
      "onecard points",
      "au rewards",
      "indusmoments",
      "360° rewards",
    ],
    charges: ["fees & charges", "charges", "fees", "other charges"],
  },
  sourceTemplates: [
    {
      sourceId: "hdfc",
      displayName: "HDFC Bank",
      fingerprintKeywords: ["hdfc bank", "hdfc regalia", "statement summary", "total dues"],
      dateFormats: ["DD/MM/YYYY"],
      amountConventions: "dr_cr_column",
    },
    {
      sourceId: "icici",
      displayName: "ICICI Bank",
      fingerprintKeywords: ["icici bank", "account summary", "total amount due", "payback points"],
      dateFormats: ["DD/MM/YYYY"],
      amountConventions: "dr_cr_column",
    },
    {
      sourceId: "axis",
      displayName: "Axis Bank",
      fingerprintKeywords: ["axis bank", "statement summary", "total payment due", "edge rewards"],
      dateFormats: ["DD/MM/YYYY"],
      amountConventions: "dr_cr_column",
    },
    {
      sourceId: "sbi",
      displayName: "State Bank of India",
      fingerprintKeywords: ["sbi card", "state bank of india", "summary of charges", "rewardz"],
      dateFormats: ["DD/MM/YYYY"],
      amountConventions: "dr_cr_column",
    },
  ],
  categoryEnum: [
    "Food",
    "Shopping",
    "Fuel",
    "Travel",
    "Medical",
    "Bills",
    "Entertainment",
    "Cash Withdrawal",
    "Refund",
    "EMI",
    "Fee",
    "Interest",
    "Tax",
    "Subscription",
    "Salary",
    "Transfer",
    "Groceries",
    "Other",
  ],
  merchantIntelligenceEnabled: true,
  duplicateFingerprintFields: ["accountId", "date", "amount", "counterpartyNormalized", "referenceNumber"],
  businessLogicHooks: ["updateCreditCardStatement"],
  confidenceThresholds: {
    amount: { autoAccept: 0.97, forcesReviewBelow: 0.97 },
    date: { autoAccept: 0.97, forcesReviewBelow: 0.97 },
    direction: { autoAccept: 0.97, forcesReviewBelow: 0.97 },
    merchant: { autoAccept: 0.9, forcesReviewBelow: 0.75 },
    category: { autoAccept: 0.85, forcesReviewBelow: 0.6 },
    referenceNumber: { autoAccept: 0.7, forcesReviewBelow: 0 },
    location: { autoAccept: 0.7, forcesReviewBelow: 0 },
  },
  status: "active",
  version: 1,
};
