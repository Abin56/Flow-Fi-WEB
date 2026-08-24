/**
 * TypeScript/Zod shape of a `documentTypeRegistry/{documentType}` entry —
 * Architecture v1.0 §3 (Document Type Registry — the Plugin Model).
 *
 * This is genuinely new for both apps (no Flutter/Dart source exists yet to
 * port from — see docs/adr/ADR-002 for why this file, unlike lib/models/
 * account.ts or transaction.ts, is authored fresh rather than ported).
 * Registry entries are deployed via CI (docs/adr/ADR-001), never written by
 * a client — see firestore.rules.
 */

import { z } from "zod";

export const DocumentTypeSchema = z.enum([
  "credit_card_statement",
  "bank_statement",
  "upi_statement",
  "loan_statement",
  "investment_statement",
  "salary_slip",
  "gst_invoice",
  "receipt",
  "tax_document",
]);
export type DocumentType = z.infer<typeof DocumentTypeSchema>;

export const IngestionMethodSchema = z.enum(["upload", "email_import", "auto_monthly"]);
export type IngestionMethod = z.infer<typeof IngestionMethodSchema>;

export const RegistryStatusSchema = z.enum(["active", "beta", "reserved"]);
export type RegistryStatus = z.infer<typeof RegistryStatusSchema>;

/** One known issuer/vendor/source format within a document type — Architecture §16 Stage 2. */
export const SourceTemplateSchema = z.object({
  sourceId: z.string().min(1),
  displayName: z.string().min(1),
  /** Weighted keyword set used for Document Detection Stage 2 fingerprint matching (§16). */
  fingerprintKeywords: z.array(z.string().min(1)).min(1),
  columnHints: z.record(z.string(), z.string()).optional(),
  dateFormats: z.array(z.string().min(1)).min(1),
  amountConventions: z.enum(["signed", "dr_cr_column", "cr_suffix"]),
});
export type SourceTemplate = z.infer<typeof SourceTemplateSchema>;

/** Per-field-class confidence thresholds (§7.3) — auto-accept / review floor. */
export const ConfidenceThresholdSchema = z.object({
  autoAccept: z.number().min(0).max(1),
  forcesReviewBelow: z.number().min(0).max(1),
});
export type ConfidenceThreshold = z.infer<typeof ConfidenceThresholdSchema>;

export const CanonicalSchemaFieldSchema = z.object({
  field: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(["string", "number", "date", "boolean", "currency"]),
  required: z.boolean(),
});

export const DocumentTypeRegistryEntrySchema = z.object({
  documentType: DocumentTypeSchema,
  displayName: z.string().min(1),
  icon: z.string().min(1),
  ingestionMethods: z.array(IngestionMethodSchema).min(1),
  canonicalSchema: z.object({
    metadataFields: z.array(CanonicalSchemaFieldSchema).min(1),
    recordSchema: z.array(CanonicalSchemaFieldSchema).min(1),
  }),
  /** Canonical field name -> list of section-header/label synonyms seen across sources (§10). */
  sectionKeywordDictionary: z.record(z.string(), z.array(z.string().min(1)).min(1)),
  sourceTemplates: z.array(SourceTemplateSchema),
  categoryEnum: z.array(z.string().min(1)).min(1),
  merchantIntelligenceEnabled: z.boolean(),
  /** Fields combined into the duplicate-detection fingerprint hash (§13.2). */
  duplicateFingerprintFields: z.array(z.string().min(1)).min(1),
  /** Names dispatched by the Import Engine's Business Logic Router (§6, §18). */
  businessLogicHooks: z.array(z.string().min(1)),
  confidenceThresholds: z.record(z.string(), ConfidenceThresholdSchema),
  status: RegistryStatusSchema,
  /**
   * Registry entries are versioned so a parsed document can pin the exact
   * version it was evaluated against (Architecture §30 item 1 / RFC §28.1
   * finding A4, §28.11) — bump on any change to thresholds, schema, or
   * templates.
   */
  version: z.number().int().min(1),
});
export type DocumentTypeRegistryEntry = z.infer<typeof DocumentTypeRegistryEntrySchema>;
