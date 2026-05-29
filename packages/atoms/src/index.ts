/**
 * @hauska-engine/atoms
 *
 * Engine-side atom-instance registry. Per the substrate v1 dispatch
 * (`_dispatches/2026-05-18_cc-agent-E_hauska_engine.md`):
 *
 * > The contract package owns the type definitions; this engine-side
 * > package owns runtime instance generation, jurisdiction-scoped
 * > collection, and pipeline-stage handoff.
 *
 * Atom type definitions (entityType strings, schema, composition) live
 * here as `AtomRegistration<...>` literals; the registrations are
 * consumed by storage / retrieval / retrieval-api at runtime via
 * `bootstrapEngineAtomRegistry()`. The published `@hauska/atom-contract`
 * (post-Sync-1) owns the type-system contract; this package supplies
 * the engine's concrete bindings.
 *
 * Bump 1 atom types (per 27 §Stream B + 51 §Bump 1):
 *   - code-section
 *   - code-definition
 *   - code-amendment
 *   - code-cross-reference
 *   - code-edition
 *   - jurisdiction-corpus
 *
 * Adjudication-context atoms (adjudication-record, per-reviewer-pattern,
 * comparable-project-precedent) also ship in Bump 1 but are NOT
 * exposed via the public MCP server (Layer 2 paid; stay inside
 * Codex 1b per 50 §Phase 2). They're produced by smartcity-os, not by
 * this engine, so they aren't registered here. Storage / retrieval
 * code reads them through the same contract.
 */

export * from "./instances.js";
export * from "./workspace-instances.js";
export * from "./registry.js";
export * from "./atom-link.js";
export * from "./did.js";
