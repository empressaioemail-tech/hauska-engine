/**
 * @hauska-engine/corpus
 *
 * Code-ingestion pipeline modules — adapter framework (Stream 1A),
 * structural extraction + atomization (Stream 1B), eval harness +
 * version-tracking + curated queries (Stream 1D).
 */

export * as adapters from "./adapters/index.js";
export * as extraction from "./extraction/index.js";
export * as atomization from "./atomization/index.js";
export * as modelCode from "./model-code/index.js";
export * as evalHarness from "./eval/index.js";
export * as versionTracking from "./version-tracking/index.js";
export * as curatedQueries from "./curated-queries/index.js";
export * as costTracking from "./cost-tracking/index.js";
