/**
 * @hauska-engine/atom-contract-pin
 *
 * Re-export shim over the published `@hauska/atom-contract@^1.0.0`.
 *
 * Historically this package mirrored the workspace-private
 * `@workspace/empressa-atom` contract surface so engine packages could
 * register atoms before Sync 1. On 2026-05-19 cc-agent-AC published
 * `@hauska/atom-contract@1.0.0` to npm, and this shim flipped to a
 * single re-export. Engine consumers continue importing from
 * `@hauska-engine/atom-contract-pin` so the swap is internal; future
 * sessions can either keep the shim or delete it and rewrite imports.
 */

export * from "@hauska/atom-contract";
