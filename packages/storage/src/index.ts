/**
 * @hauska-engine/storage
 *
 * Atom storage substrate per ADR-010: Postgres index, IPFS storage,
 * in-process hot cache. The published surface is the `StoragePort`
 * interface plus the schema (drizzle); concrete back-ends (Postgres,
 * in-memory test) implement the port.
 */

export * from "./schema.js";
export * from "./port.js";
export * from "./ipfs-port.js";
export * from "./content-hash.js";
export * from "./in-process-cache.js";
export * from "./in-memory-storage.js";

// Re-export AccessPolicy so consumers of the storage port (retrieval,
// retrieval-api, MCP server type-mirrors) don't need a transitive
// import from @hauska-engine/atoms just to type the filter parameter
// on listJurisdictionStatus.
export type { AccessPolicy } from "@hauska-engine/atoms";
