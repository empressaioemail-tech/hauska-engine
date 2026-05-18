/**
 * @hauska-engine/atom-contract-pin
 *
 * Pre-Sync-1 path-pin shim for `@hauska/atom-contract`. Mirrors the
 * type surface of the workspace-private `@workspace/empressa-atom`
 * (lib/empressa-atom in legacy-design-tools) so engine-side packages
 * can register atoms against a stable contract while cc-agent-AC
 * extracts M2-C and publishes `@hauska/atom-contract@1.0.0` to npm.
 *
 * On Sync 1 this file flips to:
 *   export * from "@hauska/atom-contract";
 *
 * Anything imported through this shim during the pre-Sync-1 window
 * resolves to the same shape post-Sync-1. The shim deliberately
 * omits primitives the engine does not need (React render bindings,
 * VDA envelope wrappers, inline-reference parsing, the Postgres
 * EventAnchoringService) — those live in the published contract
 * package, but engine atomization does not pull them.
 */

export type {
  AtomMode,
  AtomReference,
  AtomProps,
  ChipAction,
  AtomRegistration,
  AnyAtomRegistration,
  DefaultModeOf,
  LiteralString,
} from "./registration.js";

export type { Scope } from "./scope.js";
export { defaultScope } from "./scope.js";

export type {
  ContextSummary,
  KeyMetric,
  HistoryProvenance,
} from "./context.js";

export type {
  AtomComposition,
  ResolvedChild,
  CompositionRegistryView,
} from "./composition.js";
export { resolveComposition } from "./composition.js";

export type {
  AtomRegistry,
  ResolveResult,
  ValidateResult,
  DanglingCompositionRef,
  AtomPromptDescription,
} from "./registry.js";
export { createAtomRegistry, AtomNotRegisteredError } from "./registry.js";
