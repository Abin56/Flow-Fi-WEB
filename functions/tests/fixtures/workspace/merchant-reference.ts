/**
 * Re-exports the production Merchant Registry (functions/src/merchant/merchant-registry.ts)
 * under this fixture module's original names, so the Normal/Large fixture
 * generators and Complex fixture's merchant-alias edge cases don't need to
 * change. The data itself now lives in production code — it was always
 * intended as Milestone 5's seed data (per this file's original header
 * comment) and now has a real consumer (the Merchant Normalizer), so it is
 * promoted there rather than duplicated in two places. GOLDEN/immutable
 * discipline (docs/parser-pipeline-design.md v3 Task 2, requirement 5)
 * still applies to the underlying data — see the production file.
 */

export type { MerchantReferenceEntry, MerchantType } from "../../../src/merchant/merchant-registry";
export { merchantsByType, MERCHANT_REGISTRY as MERCHANT_REFERENCE } from "../../../src/merchant/merchant-registry";
