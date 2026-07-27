/**
 * @hauska-engine/atom-contract-pin
 *
 * Re-export shim over the published `@empressaio/atom-contract` (branding
 * canon 2026-07-06: Hauska = SDK only; atom contract is Empressa).
 *
 * Historically this package mirrored `@workspace/empressa-atom`, then
 * re-exported `@hauska/atom-contract` after Sync 1. Live deps must not
 * carry both brand names — that produces WidthedConfidence brand clashes
 * (COMPLETE-BASTROP C1). Engine consumers keep importing from this shim;
 * the underlying package is `@empressaio/atom-contract` only.
 */

export * from "@empressaio/atom-contract";
